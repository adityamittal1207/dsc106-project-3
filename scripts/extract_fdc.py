#!/usr/bin/env python3
"""Extract fire-pixel detections from GOES ABI-L2-FDC files on S3 into a flat CSV.

Each .nc file is a full image grid (mostly "no fire"). This script streams the
files straight from the public bucket, keeps only the pixels flagged as fire
inside a lat/lon box, and converts the satellite's scan-angle grid to lat/lon.

Two files are written:
  <out>.csv        one row per fire pixel per scan
  <out>_scans.csv  one row per scan (even with zero fires), so that a quiet
                   hour can be told apart from a satellite gap

Example:
  python extract_fdc.py --sat 18 --product ABI-L2-FDCC \
      --start 2026-07-14T00 --end 2026-08-05T00 \
      --bbox -125 35 -110 49.5 --out detections
"""
import argparse
import csv
import re
from datetime import datetime, timedelta, timezone

import netCDF4
import numpy as np
import s3fs

# Fire categories in the Mask variable (Mask codes 10-15, plus the "temporally
# filtered" 30-35 versions, which are the same pixels confirmed by earlier scans).
FIRE_CODES = (10, 11, 12, 13, 14, 15, 30, 31, 32, 33, 34, 35)
STAMP = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_")
BATCH = 48  # files fetched concurrently per round


def scan_start(key):
    """Scan start time, parsed from the _sYYYYDDDHHMMSSt part of the filename."""
    y, doy, h, m, s, tenth = (int(g) for g in STAMP.search(key).groups())
    return datetime(y, 1, 1, h, m, s, tenth * 100000, tzinfo=timezone.utc) + timedelta(days=doy - 1)


def list_keys(fs, bucket, product, start, end):
    """List every file between two datetimes using Product/Year/DOY/Hour prefixes."""
    keys, t = [], start.replace(minute=0, second=0, microsecond=0)
    while t < end:
        prefix = f"{bucket}/{product}/{t:%Y}/{t.timetuple().tm_yday:03d}/{t:%H}/"
        try:
            keys += [k for k in fs.ls(prefix) if k.endswith(".nc")]
        except FileNotFoundError:
            pass  # a whole hour missing from the archive
        t += timedelta(hours=1)
    return [k for k in sorted(keys) if start <= scan_start(k) < end]


def thin(keys, every_minutes):
    """Keep one file per time bin, for coarse surveys."""
    if not every_minutes:
        return keys
    kept, seen = [], set()
    for k in keys:
        t = scan_start(k)
        b = (t.toordinal(), (t.hour * 60 + t.minute) // every_minutes)
        if b not in seen:
            seen.add(b)
            kept.append(k)
    return kept


def scan_angles_to_latlon(x, y, proj):
    """GOES-R Product User Guide vol. 3 sec. 5.1.2.8.1: fixed grid -> geodetic."""
    H = proj.perspective_point_height + proj.semi_major_axis
    a, b = proj.semi_major_axis, proj.semi_minor_axis
    lon0 = np.radians(proj.longitude_of_projection_origin)
    sinx, cosx, siny, cosy = np.sin(x), np.cos(x), np.sin(y), np.cos(y)
    qa = sinx**2 + cosx**2 * (cosy**2 + (a / b) ** 2 * siny**2)
    qb = -2 * H * cosx * cosy
    qc = H**2 - a**2
    rs = (-qb - np.sqrt(qb**2 - 4 * qa * qc)) / (2 * qa)
    sx, sy, sz = rs * cosx * cosy, -rs * sinx, rs * cosx * siny
    lat = np.arctan((a / b) ** 2 * sz / np.sqrt((H - sx) ** 2 + sy**2))
    lon = lon0 - np.arctan(sy / (H - sx))
    return np.degrees(lat), np.degrees(lon)


def extract(buf, bbox):
    """Return (rows, status) for one in-memory .nc file."""
    west, south, east, north = bbox
    with netCDF4.Dataset("mem.nc", memory=buf) as nc:
        mask = nc["Mask"][:].filled(-1)
        rows_i, cols_i = np.nonzero(np.isin(mask, FIRE_CODES))
        if rows_i.size == 0:
            return [], 0
        x, y = nc["x"][cols_i].astype(float), nc["y"][rows_i].astype(float)
        lat, lon = scan_angles_to_latlon(x, y, nc["goes_imager_projection"])
        keep = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
        rows_i, cols_i, lat, lon = rows_i[keep], cols_i[keep], lat[keep], lon[keep]
        pick = lambda name: nc[name][:][rows_i, cols_i].astype(float).filled(np.nan)
        frp, temp, area = pick("Power"), pick("Temp"), pick("Area")
        dqf = nc["DQF"][:][rows_i, cols_i].filled(-1)
        codes = mask[rows_i, cols_i]
    rows = [
        [round(float(lat[i]), 4), round(float(lon[i]), 4),
         "" if np.isnan(frp[i]) else round(float(frp[i]), 2),
         "" if np.isnan(temp[i]) else round(float(temp[i]), 1),
         "" if np.isnan(area[i]) else round(float(area[i]), 0),
         int(codes[i]), int(dqf[i])]
        for i in range(lat.size)
    ]
    return rows, len(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sat", type=int, default=18, help="GOES satellite number: 16, 17, 18 or 19")
    ap.add_argument("--product", default="ABI-L2-FDCC", help="ABI-L2-FDCC (5 min) or ABI-L2-FDCF (10 min)")
    ap.add_argument("--start", required=True, help="UTC start, e.g. 2026-07-14T00")
    ap.add_argument("--end", required=True, help="UTC end (exclusive)")
    ap.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("W", "S", "E", "N"))
    ap.add_argument("--every", type=int, default=0, help="keep one file per N minutes (0 = all files)")
    ap.add_argument("--out", required=True, help="output path without extension")
    args = ap.parse_args()

    parse = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    start, end = parse(args.start), parse(args.end)
    fs = s3fs.S3FileSystem(anon=True)
    keys = thin(list_keys(fs, f"noaa-goes{args.sat}", args.product, start, end), args.every)
    print(f"{len(keys)} files, {start:%Y-%m-%d %H:%M} to {end:%Y-%m-%d %H:%M} UTC", flush=True)

    with open(f"{args.out}.csv", "w", newline="") as det, open(f"{args.out}_scans.csv", "w", newline="") as log:
        dw, lw = csv.writer(det), csv.writer(log)
        dw.writerow(["time", "lat", "lon", "frp_mw", "temp_k", "area_m2", "mask", "dqf"])
        lw.writerow(["time", "fire_pixels"])
        for i in range(0, len(keys), BATCH):
            batch = keys[i:i + BATCH]
            blobs = fs.cat(batch, on_error="return")  # fetched concurrently
            for key in batch:
                blob = blobs.get(key)
                if not isinstance(blob, bytes):
                    print(f"  skipped unreadable file: {key}", flush=True)
                    continue
                stamp = scan_start(key).strftime("%Y-%m-%dT%H:%M:%SZ")
                rows, n = extract(blob, args.bbox)
                dw.writerows([stamp] + r for r in rows)
                lw.writerow([stamp, n])
            print(f"  {min(i + BATCH, len(keys))}/{len(keys)}", flush=True)


if __name__ == "__main__":
    main()
