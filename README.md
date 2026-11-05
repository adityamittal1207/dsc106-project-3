# Wildfire across the West, hour by hour

DSC 106 Project 3 checkpoint work: three linked D3 graphs built from NOAA GOES fire
detections for the western US, July 13 to August 31, 2026.

## View the page

The page loads a JSON file, so it needs a local server. Opening `index.html` directly will not work.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

VS Code Live Server also works. D3 v7 is the only plotting library, and it loads from a CDN.
`data/fires.json` is already built, so viewing the page needs no Python.

## The data

| | |
|---|---|
| Source | [NOAA GOES on AWS](https://registry.opendata.aws/noaa-goes/) (public, no account needed) |
| Satellite | GOES-18 (bucket `noaa-goes18`), sitting at 137°W |
| Product | `ABI-L2-FDCC`, Fire/Hot Spot Characterization, CONUS sector, one file every 5 minutes |
| Subset used | Pixels flagged as fire inside 125–110°W, 35–49.5°N |
| Period | 2026-07-13 to 2026-08-31 |
| Volume | 14,391 of 14,400 possible scans, 522,491 fire pixels, 30 MB as CSV, 125 KB as page data |

Files are stored as `<Product>/<Year>/<Day of Year>/<Hour>/<Filename>`. Each hour holds 12 `FDCC` files
or 6 `FDCF` files. The filename contains the scan start time, for example `s20262062101181` is year 2026,
day 206, 21:01:18.1 UTC.

**Why GOES-18 `FDCC`.** The demo notebook and the example prefix point at the Full Disk product.
Both work, but for the West this pairing is better:

| | GOES-18 `FDCC` | GOES-19 `FDCF` |
|---|---|---|
| Scan interval | 5 min | 10 min |
| View angle at central Oregon | about 54° | about 68° (pixels stretch much more) |

**Variables used**

| Variable | Meaning | Used for |
|---|---|---|
| `Mask` | Category of each pixel. Fire codes are 10–15 and 30–35 | Finding fire pixels, cloud flags |
| `Power` | Fire radiative power in MW. Empty for cloud-flagged and low-probability pixels | Graphs 4 and 5 |
| `x`, `y`, `goes_imager_projection` | Scan angles and satellite geometry | Converting to latitude and longitude |
| Filename `s...` | Scan start time | All time axes |

`Temp`, `Area` and `DQF` are also extracted but no graph uses them yet.

## Accessing the data

**AWS CLI**, for browsing and single files:

```bash
aws s3 ls --no-sign-request s3://noaa-goes18/ABI-L2-FDCC/2026/206/21/
aws s3 cp --no-sign-request s3://noaa-goes18/ABI-L2-FDCC/2026/206/21/<filename>.nc .
```

**Python with s3fs**, the same approach as the demo notebook. Files are read into memory, so nothing is saved to disk:

```python
import s3fs, netCDF4

fs = s3fs.S3FileSystem(anon=True)
keys = fs.ls("noaa-goes18/ABI-L2-FDCC/2026/206/21/")
with netCDF4.Dataset("mem.nc", memory=fs.cat(keys[0])) as nc:
    mask, power = nc["Mask"][:], nc["Power"][:]
```

## Rebuilding the data

Only needed to change the period, region or fires. `requirements.txt` pins `netCDF4==1.7.4` because newer
releases have no prebuilt wheel for Apple Silicon on Python 3.12 and fail to compile.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1. Stream the files from S3 and keep the fire pixels (about 50 minutes, 240 MB of memory)
python scripts/extract_fdc.py --sat 18 --start 2026-07-13T00 --end 2026-09-01T00 \
    --bbox -125 35 -110 49.5 --out data/raw/detections

# 2. Build the page data (under a minute)
python scripts/build_fires.py --detections data/raw/detections \
    --perimeters data/perimeters.geojson --out data/fires.json
```

`data/raw/` is gitignored because of its size. To explore other subsets, `extract_fdc.py` also accepts
`--every N` (one file per N minutes) and a different `--bbox`, `--sat` or `--product`.

`data/perimeters.geojson` is a saved copy of the
[NIFC WFIGS interagency perimeters](https://data-nifc.opendata.arcgis.com/) for western fires of 20,000 acres
or more discovered since July 1, 2026. It is supplementary: it supplies each fire's official origin, discovery
time and final outline, and is only used to attribute pixels to fires for Graph 6 and the fire filter.

## Processing steps

`scripts/build_fires.py`, in order:

1. **Remove false alarms.** A pixel is dropped unless the same pixel fires again within 2 hours. This keeps 96% of pixels.
2. **Convert to local solar time** (UTC + longitude / 15), so 15:00 means the same sun position across the West.
3. **Gap-fill power.** Cloud-flagged pixels (`Mask` 12, 32) get the mean power of valid pixels in the same
   half-degree cell and hour. Low-probability pixels (15, 35) stay at zero, because they are faint.
4. **Hourly rates.** Each detection is weighted by 1 / (scans that hour). Power is already a rate, so
   adding scans together would depend on how many arrived.
5. **Attribute pixels to fires.** A pixel belongs to a fire if it is within 5 km of its final perimeter.
6. **Connected spread.** A pixel counts toward a fire's reach only once it is within 6 km of the footprint
   grown outward from the official origin. Results are stable from 5 to 8 km.

## Known limits

- **No power value for 37% of fire pixels.** The share of pixels flagged cloud-contaminated stays around 30–46%
  through the day, then falls to about 1% at sunset. That abrupt change points to a cloud test that only runs in
  daylight, but this is inferred from the data rather than confirmed in NOAA's algorithm documents.
- **Gap-filled power is an estimate.** It assumes a cloud-flagged pixel burns like its neighbours. It removes most
  of the false evening peak, but a small notch remains on some days.
- **Smoke and cloud hide fire.** An hour with few detections may be obscured rather than quiet.
- **Pixels are about 3 km wide here,** so small steps in distance are not meaningful, and small fires can be missed.
- **Fires are a chosen subset.** Graph 6 uses nine large fires with one identifiable start. Complexes that merged
  from many starts, such as Crosswhite, appear only under All West. Biscar is left out because its recorded origin
  falls outside its own perimeter.

## Files

```
dsc106-project-3/
├── index.html
├── css/style.css
├── js/main.js                 all D3 code
├── data/
│   ├── fires.json             what the page loads
│   ├── perimeters.geojson     NIFC perimeters (input to the build)
│   └── raw/                   detection CSVs (gitignored)
├── scripts/
│   ├── extract_fdc.py         S3 -> detections CSV
│   └── build_fires.py         detections CSV -> fires.json
└── requirements.txt
```
