#!/usr/bin/env python3
"""Turn raw FDC detections into the small JSON file the web page loads.

Inputs
  <detections>.csv        from extract_fdc.py
  <detections>_scans.csv  from extract_fdc.py
  <perimeters>.geojson    NIFC WFIGS final perimeters (see README)

Output
  data/fires.json

Processing, in order
  1. Persistence   drop a pixel unless it fires again within two hours. One-off
                   hits are mostly false alarms, and a single one would
                   permanently inflate a running-max distance.
  2. Solar time    UTC + longitude/15, so "15:00" means the same sun position at
                   every longitude in the West.
  3. Gap fill      cloud-flagged pixels have no FRP in the product. Each one gets
                   the mean FRP of valid pixels from the same half-degree cell
                   and hour. Low-probability pixels stay at zero, because they
                   are faint and filling them would overstate power.
  4. Hourly rates  every total is "per scan". FRP is already a rate (MW), so
                   adding scans within an hour would depend on how many scans
                   arrived. Each detection is weighted by 1 / (scans that hour).
  5. Attribution   a pixel belongs to a fire if it lies within BUFFER_KM of that
                   fire's final perimeter (nearest perimeter wins).
  6. Spread        great-circle distance from the official point of origin, as a
                   running maximum of the footprint connected to that origin.
"""
import argparse
import json

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union

BUFFER_KM = 5.0          # about one GOES pixel at this viewing angle
PERSIST_WINDOW = "2h"
LINK_KM = 6.0            # about two pixels. Results are stable from 5 to 8 km; 10 km lets neighbouring starts in
MERGE_LAG_H = 6          # a pixel burning this long before linking came from another start
KM_PER_DEG = 111.32
EARTH_RADIUS_KM = 6371.0
CLOUD_CODES = (12, 32)   # cloud-contaminated, no FRP, eligible for gap fill
LOW_CODES = (15, 35)     # low probability, no FRP, left at zero

# Largest western fires of the window with one identifiable start. name must
# match poly_IncidentName. Multi-ignition complexes are excluded on purpose:
# "distance from the origin" has no meaning when fires merge from several starts.
# Biscar is also excluded: its recorded origin falls outside its own perimeter.
FIRES = [
    ("big-grass", "Big Grass", "OR–ID", "Big Grass"),
    ("coleman-creek", "Coleman Creek", "OR", "Coleman Creek"),
    ("little-giant", "Little Giant", "WA", "Little Giant"),
    ("sinlahekin", "Sinlahekin", "WA", "Sinlahekin"),
    ("tartar", "Tartar", "ID", "Tartar"),
    ("widemouth-2", "Widemouth 2", "UT", "Widemouth 2"),
    ("second-flat", "Second Flat", "OR", "Second Flat"),
    ("grasshopper", "Grasshopper", "OR", "Grasshopper"),
    ("bug", "Bug", "CA–NV", "Bug"),
]


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dlat, dlon = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2, dl = np.radians(lat1), np.radians(lat2), np.radians(lon2 - lon1)
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(y, x)) + 360) % 360


def load_perimeters(path):
    """Merge polygon pieces by fire name."""
    by_name = {}
    for f in json.load(open(path))["features"]:
        by_name.setdefault(f["properties"]["poly_IncidentName"], []).append(f)
    out = {}
    for name, feats in by_name.items():
        p = max(feats, key=lambda f: f["properties"]["poly_GISAcres"] or 0)["properties"]
        out[name] = dict(
            geom=unary_union([shape(f["geometry"]).buffer(0) for f in feats]),
            acres=p["poly_GISAcres"], lat=p["attr_InitialLatitude"], lon=p["attr_InitialLongitude"],
            discovered=pd.to_datetime(p["attr_FireDiscoveryDateTime"], unit="ms", utc=True),
            cause=p.get("attr_FireCause"))
    return out


def drop_one_off_pixels(d):
    """Keep a pixel only if the same pixel fired again within PERSIST_WINDOW."""
    window = pd.Timedelta(PERSIST_WINDOW)
    t = d.sort_values("time").groupby(["lat", "lon"]).time
    near = (t.diff() <= window) | (t.diff(-1).abs() <= window)
    return d[near.reindex(d.index).values].copy()


def fill_frp(d):
    """frp_filled = reported FRP, or the local mean for cloud-flagged pixels."""
    d["cell"] = (d.lat * 2).round().astype(int) * 10000 + (d.lon * 2).round().astype(int)
    local = d.groupby(["cell", "utc_hour"]).frp_mw.transform("mean")
    regional = d.groupby("utc_hour").frp_mw.transform("mean")
    estimate = local.fillna(regional).fillna(d.frp_mw.mean())
    d["frp_filled"] = d.frp_mw.where(d.frp_mw.notna(), estimate.where(d["mask"].isin(CLOUD_CODES), 0.0))
    return d.drop(columns="cell")


def attribute(d, perims):
    """Fire id per detection, or None. Nearest buffered perimeter wins."""
    lat0 = float(d.lat.mean())
    squeeze = np.array([np.cos(np.radians(lat0)), 1.0])
    pts = shapely.points(d[["lon", "lat"]].values * squeeze)
    best = np.full(len(d), np.inf)
    owner = np.full(len(d), None, dtype=object)
    for fid, _, _, name in FIRES:
        flat = shapely.transform(perims[name]["geom"], lambda c: c * squeeze)
        dist = shapely.distance(flat, pts)
        hit = (dist * KM_PER_DEG <= BUFFER_KM) & (dist < best)
        best[hit], owner[hit] = dist[hit], fid
    return owner


def hourly_rows(d):
    """[[solar hour index, pixels with FRP, pixels without, raw GW, filled GW], ...]"""
    g = d.groupby("solar_idx")
    r = pd.DataFrame(dict(
        with_frp=g.apply(lambda x: x.w[x.frp_mw.notna()].sum(), include_groups=False),
        without=g.apply(lambda x: x.w[x.frp_mw.isna()].sum(), include_groups=False),
        raw=g.apply(lambda x: (x.w * x.frp_mw.fillna(0)).sum() / 1000, include_groups=False),
        filled=g.apply(lambda x: (x.w * x.frp_filled).sum() / 1000, include_groups=False)))
    return [[int(i), round(a, 2), round(b, 2), round(c, 3), round(e, 3)]
            for i, a, b, c, e in zip(r.index, r.with_frp, r.without, r.raw, r.filled)]


def spread(d, perim):
    """Connected growth from the origin, one point per new farthest distance.

    A final perimeter often swallows separate starts that burned together later,
    so a plain running max would show those starts as sudden 40 km runs. Here a
    pixel counts only once it is within LINK_KM of the footprint grown outward
    from the origin. Pixels that were burning well before they linked up came
    from another start, and that step is flagged as a merge.

    Returns [[hours since discovery, km, bearing, merged 0/1], ...] and the
    number of pixels that never connected.
    """
    disc = perim["discovered"]
    x = d[d.time >= disc - pd.Timedelta("1h")].copy()
    x["km"] = haversine_km(perim["lat"], perim["lon"], x.lat.values, x.lon.values)
    x["bearing"] = bearing_deg(perim["lat"], perim["lon"], x.lat.values, x.lon.values)
    x["h"] = ((x.time - disc) / pd.Timedelta("1h")).clip(lower=0).astype(int)
    pixels = x.sort_values("time").groupby(["lat", "lon"], as_index=False).first()

    # Flat km coordinates are accurate enough at this scale.
    scale = np.array([KM_PER_DEG, KM_PER_DEG * np.cos(np.radians(perim["lat"]))])
    footprint = np.array([[perim["lat"], perim["lon"]]]) * scale
    pending = pixels.iloc[0:0]
    pts, best = [], 0.0

    for h, new in pixels.groupby("h"):
        pending = pd.concat([pending, new])
        joined = []
        while len(pending):
            xy = pending[["lat", "lon"]].values * scale
            gap = np.sqrt(((xy[:, None, :] - footprint[None, :, :]) ** 2).sum(axis=2)).min(axis=1)
            near = gap <= LINK_KM
            if not near.any():
                break
            joined.append(pending[near])
            footprint = np.vstack([footprint, xy[near]])
            pending = pending[~near]
        if joined:
            j = pd.concat(joined)
            far = j.loc[j.km.idxmax()]
            if far.km > best:
                best = far.km
                pts.append([int(h), round(float(far.km), 1), round(float(far.bearing)), int(h - far.h > MERGE_LAG_H)])
    return pts, len(pending)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--detections", required=True, help="path without extension")
    ap.add_argument("--perimeters", required=True)
    ap.add_argument("--out", default="data/fires.json")
    args = ap.parse_args()

    det = pd.read_csv(f"{args.detections}.csv", parse_dates=["time"])
    scans = pd.read_csv(f"{args.detections}_scans.csv", parse_dates=["time"])
    perims = load_perimeters(args.perimeters)

    n_raw = len(det)
    d = drop_one_off_pixels(det)
    d["utc_hour"] = d.time.dt.floor("h")
    per_hour = scans.groupby(scans.time.dt.floor("h")).size()
    d["w"] = 1 / d.utc_hour.map(per_hour)
    d = fill_frp(d)

    t0 = scans.time.min().floor("D")
    solar = d.time + pd.to_timedelta(d.lon / 15, unit="h")
    d["solar_idx"] = ((solar - t0) / pd.Timedelta("1h")).pipe(np.floor).astype(int)
    # Solar time runs about 8 hours behind UTC here. Keep only solar hours that
    # every longitude in the study area fully covers.
    last_idx = int((scans.time.max().ceil("D") - t0) / pd.Timedelta("1h")) - 9
    d = d[(d.solar_idx >= 0) & (d.solar_idx < last_idx)].copy()
    d["fire"] = attribute(d, perims)

    series = [dict(id="all", name="All West", place="All fires in the study area", rows=hourly_rows(d))]
    runs = []
    for fid, label, place, name in FIRES:
        f, p = d[d.fire == fid], perims[name]
        series.append(dict(id=fid, name=label, place=place, rows=hourly_rows(f)))
        pts, unlinked = spread(f, p)
        runs.append(dict(id=fid, name=label, place=place, acres=round(p["acres"]), cause=p["cause"],
                         discovered=p["discovered"].strftime("%Y-%m-%dT%H:%MZ"), pts=pts, unlinked=unlinked))

    meta = dict(satellite="GOES-18", product="ABI-L2-FDCC", bbox=[-125, 35, -110, 49.5],
                start=scans.time.min().strftime("%Y-%m-%d"), end=scans.time.max().strftime("%Y-%m-%d"),
                t0=t0.strftime("%Y-%m-%dT%H:%MZ"), hours=last_idx, scans=len(scans), rawPixels=n_raw, keptPixels=len(d),
                attributedPixels=int(d.fire.notna().sum()),
                noFrpShare=round(float(d.frp_mw.isna().mean()), 3))
    with open(args.out, "w") as f:
        json.dump(dict(meta=meta, series=series, spread=runs), f, separators=(",", ":"))
    print(json.dumps(meta))
    for r in runs:
        last = r["pts"][-1] if r["pts"] else None
        merges = [p[:2] for p in r["pts"] if p[3]]
        print(f'{r["name"]:14} {r["acres"]:>7} ac  unlinked {r["unlinked"]:>4}  final {last}  merges {merges}')
        print(f'{"":14} first steps {[p[:2] for p in r["pts"][:7]]}')


if __name__ == "__main__":
    main()
