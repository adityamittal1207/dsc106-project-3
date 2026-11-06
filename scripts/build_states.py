#!/usr/bin/env python3
"""Decode a TopoJSON of US states into a small GeoJSON of the western states.

The page draws these outlines under the fire pixel maps. Only the states that
touch the study area are kept, which makes the file about a quarter of the size.

Example:
  curl -sSL -o states-10m.json https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json
  python scripts/build_states.py states-10m.json --out data/states.geojson
"""
import argparse
import json

WEST = {"Washington", "Oregon", "California", "Idaho", "Nevada", "Utah", "Montana",
        "Wyoming", "Arizona", "Colorado", "New Mexico"}


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append([round(x * sx + tx, 4), round(y * sy + ty, 4)])
        arcs.append(pts)
    return arcs


def ring(indexes, arcs):
    out = []
    for i in indexes:
        pts = arcs[~i][::-1] if i < 0 else arcs[i]
        out += pts if not out else pts[1:]
    return out


def geometry(g, arcs):
    if g["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [ring(r, arcs) for r in g["arcs"]]}
    return {"type": "MultiPolygon", "coordinates": [[ring(r, arcs) for r in poly] for poly in g["arcs"]]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("topojson")
    ap.add_argument("--out", default="data/states.geojson")
    args = ap.parse_args()

    topo = json.load(open(args.topojson))
    arcs = decode_arcs(topo)
    features = [
        {"type": "Feature", "properties": {"name": g["properties"]["name"]}, "geometry": geometry(g, arcs)}
        for g in topo["objects"]["states"]["geometries"] if g["properties"]["name"] in WEST
    ]
    with open(args.out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"{len(features)} states written to {args.out}")


if __name__ == "__main__":
    main()
