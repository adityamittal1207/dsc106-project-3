/* Wildfire across the West: six linked D3 graphs driven by one shared state.
   state.fire    which fire every graph shows, and which line graph 6 highlights
   state.window  [startHour, endHour) zoom range set by the brush in graph 4; graphs 1, 2, 3 and 5 follow it
   state.hour    solar hour shown on the map in graph 3 and marked in graph 2. null means the peak hour
   state.mode    "filled" or "reported" power in graph 4
   state.spreadDays  x range of graph 6: 21, or null for every day */

const HOUR_MS = 3600e3;
const NIGHT_START = 19; // solar hour. The cloud flag drops out here, matching sunset in July and August.
const NIGHT_END = 5;
const NIGHT_BAND_MAX_DAYS = 14; // shading more days than this turns into stripes
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const fmtDay = d3.utcFormat("%b %-d");
const fmtHour = d3.utcFormat("%H:00");
const fmtInt = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtGW = v => (v >= 100 ? fmtInt(v) : d3.format(".1f")(v));
const hourLabel = h => `${String(h).padStart(2, "0")}:00`;
const isNight = h => h >= NIGHT_START || h < NIGHT_END;
const compass = deg => COMPASS[Math.round(deg / 45) % 8];

const SPREAD_DEFAULT_DAYS = 21;
const state = { fire: "all", window: null, hour: null, mode: "filled", spreadDays: SPREAD_DEFAULT_DAYS };
let meta, series, runs, seriesById, totalHours, pixelData, states;
const redraws = [];

const tooltip = (() => {
  const el = document.getElementById("tooltip");

  function row(value, label, color) {
    const div = document.createElement("div");
    div.className = "tip-row";
    if (color) {
      const key = document.createElement("span");
      key.className = "tip-key";
      key.style.background = color;
      div.append(key);
    }
    const b = document.createElement("b");
    b.textContent = value;
    const span = document.createElement("span");
    span.className = "tip-label";
    span.textContent = label;
    div.append(b, span);
    return div;
  }

  return {
    show(x, y, title, rows) {
      const head = document.createElement("div");
      head.className = "tip-title";
      head.textContent = title;
      el.replaceChildren(head, ...rows.map(r => row(...r)));
      el.hidden = false;
      const box = el.getBoundingClientRect();
      const left = x + 14 + box.width > window.innerWidth - 8 ? x - box.width - 14 : x + 14;
      const top = Math.min(Math.max(8, y - box.height - 10), window.innerHeight - box.height - 8);
      el.style.left = `${Math.max(8, left)}px`;
      el.style.top = `${top}px`;
    },
    hide() { el.hidden = true; },
  };
})();

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function activeSeries() {
  return seriesById.get(state.fire);
}

function currentWindow() {
  return state.window || [0, totalHours];
}

function hoursInWindow() {
  const [a, b] = currentWindow();
  return activeSeries().hours.slice(a, b);
}

function windowLabel() {
  const [a, b] = currentWindow();
  const start = hourDate(a);
  const end = hourDate(b - 1);
  return fmtDay(start) === fmtDay(end) ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end)}`;
}

function hourDate(i) {
  return new Date(+new Date(meta.t0) + i * HOUR_MS);
}

function chartSize(id, ratio, min, max) {
  const width = Math.max(300, document.getElementById(id).clientWidth);
  return { width, height: Math.round(Math.min(max, Math.max(min, width * ratio))) };
}

/* Pixels for graphs 1 to 3. pixels.json stores each position once, then per
   solar hour a flat list of [pixel index, scans that saw it, MW]. MW > 0 is
   reported power, MW < 0 a gap-filled estimate, 0 no value. */
/* GOES-18 fixed grid (Product User Guide vol. 3, sec. 5.1.2.8). Fire pixels sit on a
   56 microradian scan-angle grid, so each one's ground footprint is the four corners
   half a step either side. Over the West they come out about 2.2 by 3.4 km and tilted. */
const GOES = { a: 6378137, b: 6356752.31414, H: 6378137 + 35786023, lon0: -137 * Math.PI / 180, step: 56e-6 };

function geoToScan(lon, lat) {
  const { a, b, H, lon0 } = GOES;
  const phi = lat * Math.PI / 180;
  const lam = lon * Math.PI / 180;
  const phic = Math.atan((b * b) / (a * a) * Math.tan(phi));
  const rc = b / Math.sqrt(1 - ((a * a - b * b) / (a * a)) * Math.cos(phic) ** 2);
  const sx = H - rc * Math.cos(phic) * Math.cos(lam - lon0);
  const sy = -rc * Math.cos(phic) * Math.sin(lam - lon0);
  const sz = rc * Math.sin(phic);
  return [Math.asin(-sy / Math.hypot(sx, sy, sz)), Math.atan(sz / sx)];
}

function scanToGeo(x, y) {
  const { a, b, H, lon0 } = GOES;
  const qa = Math.sin(x) ** 2 + Math.cos(x) ** 2 * (Math.cos(y) ** 2 + (a / b) ** 2 * Math.sin(y) ** 2);
  const qb = -2 * H * Math.cos(x) * Math.cos(y);
  const qc = H * H - a * a;
  const rs = (-qb - Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  const sx = rs * Math.cos(x) * Math.cos(y);
  const sy = -rs * Math.sin(x);
  const sz = rs * Math.cos(x) * Math.sin(y);
  const lat = Math.atan((a / b) ** 2 * sz / Math.hypot(H - sx, sy));
  const lon = lon0 - Math.atan(sy / (H - sx));
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

function footprint(lon, lat) {
  const [x, y] = geoToScan(lon, lat);
  const h = GOES.step / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([dx, dy]) => scanToGeo(x + dx, y + dy));
}

function preparePixels(raw) {
  const n = raw.pixels.length / 3;
  const pos = new Array(n);
  for (let i = 0; i < n; i++) {
    const lat = raw.pixels[i * 3] / 1e4;
    const lon = raw.pixels[i * 3 + 1] / 1e4;
    pos[i] = { lat, lon, fire: raw.pixels[i * 3 + 2], corners: footprint(lon, lat) };
  }
  const fireIndex = new Map(raw.fires.map((id, i) => [id, i]));
  return { pos, hours: raw.hours, fireIndex };
}

function pixelFilter() {
  if (state.fire === "all") return () => true;
  const k = pixelData.fireIndex.get(state.fire);
  return i => pixelData.pos[i].fire === k;
}

function activeAt(h, keep) {
  const flat = pixelData.hours[h] || [];
  const out = [];
  for (let j = 0; j < flat.length; j += 3) {
    if (keep(flat[j])) out.push({ i: flat[j], scans: flat[j + 1], mw: flat[j + 2] });
  }
  return out;
}

/* First hour each pixel burned within the window. Shared by both maps and cached,
   because the brush can ask for it many times a second. */
let burnCache = { key: null };
function burnHistory() {
  const [a, b] = currentWindow();
  const key = `${state.fire}|${a}|${b}`;
  if (burnCache.key === key) return burnCache;
  const keep = pixelFilter();
  const first = new Map();
  for (let h = a; h < b; h++) {
    const flat = pixelData.hours[h] || [];
    for (let j = 0; j < flat.length; j += 3) {
      const i = flat[j];
      if (!first.has(i) && keep(i)) first.set(i, h);
    }
  }
  const byHour = d3.groups([...first], ([, h]) => h).map(([h, list]) => ({ h, pix: list.map(([i]) => i) }));
  burnCache = { key, keep, first, byHour };
  return burnCache;
}

function peakHour() {
  const visible = hoursInWindow();
  const peak = d3.greatest(visible, d => d.filled);
  return peak && peak.filled > 0 ? peak.i : currentWindow()[0];
}

function mapHour() {
  const [a, b] = currentWindow();
  if (state.hour == null) state.hour = peakHour();
  state.hour = Math.max(a, Math.min(b - 1, state.hour));
  return state.hour;
}

function hourStamp(i) {
  const d = hourDate(i);
  return `${fmtDay(d)}, ${fmtHour(d)} solar`;
}

function hourTitle(i) {
  return `${hourStamp(i)}${isNight(i % 24) ? " (night)" : ""}`;
}

/* d3 wants polygon rings clockwise; GeoJSON from shapely is the other way. */
function rewind(geom) {
  const fix = poly => (d3.geoArea({ type: "Polygon", coordinates: poly }) > 2 * Math.PI ? poly.map(r => r.slice().reverse()) : poly);
  return geom.type === "Polygon"
    ? { type: "Polygon", coordinates: fix(geom.coordinates) }
    : { type: "MultiPolygon", coordinates: geom.coordinates.map(fix) };
}

function studyAreaRing() {
  const [w, s, e, n] = meta.bbox;
  const steps = 30;
  const edge = (x0, y0, x1, y1) => d3.range(steps).map(k => [x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps]);
  return [...edge(w, s, e, s), ...edge(e, s, e, n), ...edge(e, n, w, n), ...edge(w, n, w, s), [w, s]];
}

const MIN_PIXEL_PX = 4.5; // burning pixels are enlarged to at least this size on the regional map
const NICE_KM = [5, 10, 20, 25, 50, 100, 200];

/* Graphs 1 and 3 share this map. follow = "peak" pins it to the peak power hour,
   follow = "slider" lets graph 3 move it. */
function createMap(id, { follow }) {
  const root = d3.select(`#${id}`);
  const svg = root.append("svg").attr("role", "img")
    .attr("aria-label", follow === "peak"
      ? "Map of fire pixels during the peak power hour, over ground burned earlier"
      : "Map of fire pixels at the hour chosen with the slider, over ground burned earlier");
  const clipId = `${id}-clip`;
  const clipRect = svg.append("defs").append("clipPath").attr("id", clipId).append("rect");
  const frame = svg.append("rect").attr("class", "map-frame");
  const body = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const statesG = body.append("g");
  const studyArea = body.append("path").attr("class", "study-area");
  const perimeter = body.append("path").attr("class", "perimeter");
  const burnedG = body.append("g");
  const pixelsG = body.append("g");
  const originsG = body.append("g");
  const caption = svg.append("text").attr("class", "map-caption");
  const captionSub = svg.append("text");
  const scaleBar = svg.append("g").attr("class", "scale-bar");

  let projection, quad, grow, history;

  function pixelTip(event, d) {
    const p = pixelData.pos[d.i];
    const run = runs.find(r => pixelData.fireIndex.get(r.id) === p.fire);
    const power = d.mw > 0 ? [`${fmtInt(d.mw)} MW`, "reported power", cssVar("--ember")]
      : d.mw < 0 ? [`~${fmtInt(-d.mw)} MW`, "estimated, cloud-flagged", cssVar("--nopower")]
      : ["No value", "low-probability pixel", cssVar("--nopower")];
    tooltip.show(event.clientX, event.clientY, hourTitle(history.hour), [
      power,
      [`${d.scans} of 12`, "scans saw it this hour"],
      [run ? run.name : "Unattributed", `${p.lat.toFixed(2)}°N, ${Math.abs(p.lon).toFixed(2)}°W`],
    ]);
  }

  function draw() {
    const width = Math.max(300, document.getElementById(id).clientWidth);
    const height = Math.round(Math.min(540, Math.max(320, width * 0.6)));
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    clipRect.attr("width", width).attr("height", height);
    frame.attr("width", width - 1).attr("height", height - 1).attr("x", 0.5).attr("y", 0.5).attr("rx", 8);
    clipRect.attr("rx", 8);

    const run = runs.find(r => r.id === state.fire);
    const target = run
      ? { type: "MultiPoint", coordinates: [run.origin, ...run.perimeterPoints] }
      : { type: "MultiPoint", coordinates: studyAreaRing() };
    const pad = run ? 40 : 20;
    projection = d3.geoConicConformal().parallels([38, 47]).rotate([run ? -run.origin[0] : 117.5, 0])
      .fitExtent([[pad, pad + 14], [width - pad, height - pad]], target);
    const path = d3.geoPath(projection);

    statesG.selectAll("path").data(states.features).join("path").attr("class", "state").attr("d", path);
    studyArea.style("display", run ? "none" : null)
      .attr("d", path({ type: "LineString", coordinates: studyAreaRing() }));
    perimeter.style("display", run ? null : "none").attr("d", run ? path(run.perimeterGeo) : null);

    // Screen size of 1 km, from a step east of the map centre.
    const [cx, cy] = projection.invert([width / 2, height / 2]);
    const a = projection([cx, cy]);
    const b = projection([cx + 1 / (111.32 * Math.cos(cy * Math.PI / 180)), cy]);
    const kmPx = Math.hypot(b[0] - a[0], b[1] - a[1]);

    // Each pixel is drawn as its footprint, optionally scaled about its centre.
    const cache = new Map();
    const corners = i => {
      if (!cache.has(i)) cache.set(i, pixelData.pos[i].corners.map(c => projection(c)));
      return cache.get(i);
    };
    quad = (i, k = 1) => {
      const c = corners(i);
      const mx = d3.mean(c, p => p[0]);
      const my = d3.mean(c, p => p[1]);
      return "M" + c.map(([x, y]) => `${(mx + (x - mx) * k).toFixed(1)},${(my + (y - my) * k).toFixed(1)}`).join("L") + "Z";
    };
    grow = Math.max(1, MIN_PIXEL_PX / (kmPx * 2.2));

    history = burnHistory();
    burnedG.selectAll("path").data(history.byHour, d => d.h).join("path").attr("class", "burned")
      .attr("d", d => d.pix.map(i => quad(i, grow > 1 ? 1.4 : 1)).join(""));

    const origins = run ? [run] : runs;
    originsG.selectAll("g").data(origins, r => r.id).join(enter => {
      const g = enter.append("g");
      g.append("circle").attr("class", "origin-ring");
      g.append("text").attr("class", "origin-label");
      return g;
    })
      .attr("transform", r => `translate(${projection(r.origin)})`)
      .style("cursor", run ? null : "pointer")
      .on("pointermove", run ? null : (event, r) => tooltip.show(event.clientX, event.clientY, `${r.name}, ${r.place}`, [
        ["Origin", `discovered ${fmtDay(new Date(r.discovered))}`],
        [fmtInt(r.acres), "acres, final perimeter"],
        ["Click", "to zoom in"],
      ]))
      .on("pointerleave", () => tooltip.hide())
      .on("click", run ? null : (_, r) => setFire(r.id))
      .call(g => g.select("circle").attr("r", run ? 6 : 4.5).style("pointer-events", run ? "none" : "all"))
      .call(g => g.select("text").attr("x", 10).attr("y", 4).text(run ? "Origin" : ""));

    // Scale bar: the nice length closest to 90 px.
    const km = d3.least(NICE_KM, k => Math.abs(k * kmPx - 90));
    scaleBar.attr("transform", `translate(16,${height - 18})`);
    scaleBar.selectAll("line").data([0]).join("line").attr("x1", 0).attr("x2", km * kmPx).attr("y1", 0).attr("y2", 0);
    scaleBar.selectAll("text").data([0]).join("text").attr("x", km * kmPx + 6).attr("y", 4).text(`${km} km`);

    caption.attr("x", 16).attr("y", 24);
    captionSub.attr("x", 16).attr("y", 40);
    renderHour(follow === "peak" ? peakHour() : mapHour());
  }

  function renderHour(h) {
    history.hour = h;
    burnedG.selectAll("path").style("display", d => (d.h < h ? null : "none"));
    const active = activeAt(h, history.keep);
    pixelsG.selectAll("path").data(active, d => d.i).join("path")
      .attr("class", d => `pixel ${d.mw > 0 ? "power" : "nopower"}`)
      .attr("d", d => quad(d.i, grow))
      .attr("stroke-width", grow > 1 ? 0.5 : 1)
      .on("pointermove", pixelTip)
      .on("pointerleave", () => tooltip.hide());
    // Pixels with power on top, so the measured part of the front is never hidden.
    pixelsG.selectAll("path").sort((p, q) => (p.mw > 0) - (q.mw > 0));

    const fresh = active.filter(d => history.first.get(d.i) === h).length;
    const burned = d3.sum(history.byHour, d => (d.h < h ? d.pix.length : 0));
    caption.text(hourTitle(h));
    captionSub.text(`${fmtInt(active.length)} pixels burning · ${fmtInt(burned)} burned earlier`);
    return { active, fresh, burned };
  }

  return { draw, renderHour };
}

function updateSnapshotFinding() {
  const el = document.getElementById("snapshot-finding");
  const h = peakHour();
  const { first, keep } = burnHistory();
  const active = activeAt(h, keep);
  if (!active.length) {
    el.textContent = `${activeSeries().name} shows no fire pixels in this window.`;
    return;
  }
  const fresh = active.filter(d => first.get(d.i) === h).length;
  const before = [...first.values()].filter(v => v < h).length;
  const withPower = active.filter(d => d.mw > 0).length;
  el.textContent = `The peak came at ${hourTitle(h)}, with ${fmtInt(active.length)} pixels burning. ` +
    `${fmtPct(fresh / active.length)} of them were new ground, first seen that hour, on top of ${fmtInt(before)} pixels that burned earlier in the window. ` +
    (withPower / active.length > 0.9
      ? "Nearly all of them had a power value, so graph 4's peak here is mostly measured, not estimated."
      : `${fmtPct(1 - withPower / active.length)} had no power value, so graph 4's peak here leans partly on gap-filling.`);
}

function updateAnimapFinding(view, h) {
  const el = document.getElementById("animap-finding");
  if (!view.active.length) {
    el.textContent = `No fire pixels at ${hourTitle(h)}. A quiet hour can also mean smoke or cloud hid the fire.`;
    return;
  }
  const share = view.fresh / view.active.length;
  el.textContent = `${fmtInt(view.active.length)} pixels burning, ${fmtInt(view.fresh)} of them new this hour (${fmtPct(share)}). ` +
    (share > 0.3 ? "A large share of new ground means the fire is running." : share > 0.08
      ? "Some new ground: the front is creeping outward."
      : "Almost all of it burned before, so the fire is holding inside its own scar.");
}

/* Graph 2: pixels per scan over time, with a marker for graph 3's hour. */
function createCountsChart(onScrub) {
  const root = d3.select("#counts");
  const svg = root.append("svg").attr("role", "img")
    .attr("aria-label", "Area chart of average fire pixels per scan for each hour in the selected window");
  const margin = { top: 22, right: 14, bottom: 22, left: 46 };
  const clipRect = svg.append("defs").append("clipPath").attr("id", "counts-clip").append("rect");
  const plot = svg.append("g");
  const gridG = plot.append("g").attr("class", "grid");
  const nightG = plot.append("g").attr("clip-path", "url(#counts-clip)");
  const dataG = plot.append("g").attr("clip-path", "url(#counts-clip)");
  const area = dataG.append("path").attr("class", "count-area");
  const line = dataG.append("path").attr("class", "count-line");
  const xAxisG = plot.append("g").attr("class", "axis");
  const yAxisG = plot.append("g").attr("class", "axis");
  const unitLabel = plot.append("text").attr("y", -9).text("Pixels per scan");
  const marker = plot.append("line").attr("class", "hour-marker");
  const markerDot = plot.append("circle").attr("class", "marker").attr("r", 4);
  const crosshair = plot.append("line").attr("class", "crosshair").style("display", "none");
  const overlay = plot.append("rect").attr("fill", "transparent").style("cursor", "ew-resize").style("touch-action", "none");
  let x, y, innerH, visible;

  const total = d => d.withFrp + d.noFrp;

  function draw({ animate = false } = {}) {
    const { width, height } = chartSize("counts", 0.26, 220, 280);
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const innerW = width - margin.left - margin.right;
    innerH = height - margin.top - margin.bottom;
    plot.attr("transform", `translate(${margin.left},${margin.top})`);
    clipRect.attr("width", innerW).attr("height", innerH + 1);

    visible = hoursInWindow();
    const [a, b] = currentWindow();
    const days = (b - a) / 24;
    x = d3.scaleUtc().domain([hourDate(a), hourDate(b - 1)]).range([0, innerW]);
    y = d3.scaleLinear().domain([0, (d3.max(visible, total) || 1) * 1.08]).nice(4).range([innerH, 0]);

    gridG.call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));
    yAxisG.call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat(d3.format(",")));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, innerW / 90)).tickSizeOuter(0)
        .tickFormat(d => (days <= 4 && d.getUTCHours() !== 0 ? fmtHour(d) : fmtDay(d))));
    unitLabel.attr("x", -margin.left + 2);

    nightG.selectAll("rect").data(days <= NIGHT_BAND_MAX_DAYS ? nightSpans(a, b) : []).join("rect")
      .attr("class", "night-band")
      .attr("x", d => x(hourDate(d[0])))
      .attr("width", d => x(hourDate(d[1])) - x(hourDate(d[0])))
      .attr("height", innerH);

    const areaGen = d3.area().x(d => x(d.date)).y0(innerH).y1(d => y(total(d))).curve(d3.curveMonotoneX);
    const apply = sel => (animate ? sel.transition().duration(450) : sel);
    area.datum(visible);
    line.datum(visible);
    apply(area).attr("d", areaGen);
    apply(line).attr("d", areaGen.lineY1());

    const hourAt = event => {
      const [mx] = d3.pointer(event);
      return visible[d3.bisector(d => d.date).center(visible, x.invert(mx))];
    };
    overlay.attr("width", innerW).attr("height", innerH)
      .on("pointermove", event => {
        const d = hourAt(event);
        if (!d) return;
        const px = x(d.date);
        crosshair.style("display", null).attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", innerH);
        tooltip.show(event.clientX, event.clientY, hourTitle(d.i), [
          [d3.format(".1f")(total(d)), "pixels per scan", cssVar("--fg")],
          [`${fmtGW(d.filled)} GW`, "gap-filled power"],
        ]);
        if (event.buttons) onScrub(d.i);
      })
      .on("pointerdown", event => {
        const d = hourAt(event);
        if (d) onScrub(d.i);
      })
      .on("pointerleave", () => {
        crosshair.style("display", "none");
        tooltip.hide();
      });

    moveMarker();
    updateCountsFinding(visible);
  }

  function moveMarker() {
    if (!x) return;
    const h = mapHour();
    const d = activeSeries().hours[h];
    const px = x(d.date);
    marker.attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", innerH);
    markerDot.attr("cx", px).attr("cy", y(total(d)));
  }

  return { draw, moveMarker };
}

function updateCountsFinding(visible) {
  const el = document.getElementById("counts-finding");
  const total = d => d.withFrp + d.noFrp;
  const peak = d3.greatest(visible, total);
  if (!peak || !total(peak)) {
    el.textContent = `${activeSeries().name} shows no detections in this window.`;
    return;
  }
  const powerPeak = d3.greatest(visible, d => d.filled);
  const lag = powerPeak.i - peak.i;
  const r = pearson(visible.map(total), visible.map(d => d.filled));
  const lagText = lag === 0 ? "the same hour power peaks"
    : `${Math.abs(lag) < 48 ? `${Math.abs(lag)} hours` : `${d3.format(".0f")(Math.abs(lag) / 24)} days`} ${lag > 0 ? "before" : "after"} power peaks`;
  const together = r >= 0.85 ? "closely" : r >= 0.6 ? "loosely" : "only weakly";
  el.textContent = `The count tops out at ${d3.format(".0f")(total(peak))} pixels per scan on ${hourTitle(peak.i)}, ${lagText}. ` +
    `Across the window, hourly counts track power ${together} (correlation ${d3.format(".2f")(r)}): more burning ground mostly means more power, but not always.`;
}

function pearson(xs, ys) {
  const mx = d3.mean(xs), my = d3.mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function nightSpans(a, b) {
  const spans = [];
  for (let day = Math.floor(a / 24) - 1; day <= Math.ceil(b / 24); day++) {
    spans.push([day * 24 + NIGHT_START, (day + 1) * 24 + NIGHT_END]);
  }
  return spans;
}

/* Graph 3 controls: slider, play button, and the hour shared with graph 2. */
function createPlayer(animap, counts) {
  const slider = document.getElementById("hour-slider");
  const label = document.getElementById("hour-label");
  const button = document.getElementById("play");
  let timer = null;

  function show() {
    const [a, b] = currentWindow();
    const h = mapHour();
    slider.min = a;
    slider.max = b - 1;
    slider.value = h;
    label.value = hourStamp(h);
    updateAnimapFinding(animap.renderHour(h), h);
    counts.moveMarker();
  }

  function setHour(h) {
    state.hour = h;
    show();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Play");
  }

  function play() {
    const [a, b] = currentWindow();
    if (mapHour() >= b - 1) setHour(a);
    const step = Math.max(1, Math.round((b - a) / 400));
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", "Pause");
    timer = setInterval(() => {
      const [, end] = currentWindow();
      const next = mapHour() + step;
      if (next >= end) {
        setHour(end - 1);
        stop();
      } else {
        setHour(next);
      }
    }, 90);
  }

  button.addEventListener("click", () => (timer ? stop() : play()));
  slider.addEventListener("input", () => {
    stop();
    setHour(+slider.value);
  });

  return { show, setHour };
}

/* Graph 4: focus + context timeline of fire radiative power. */
function createIntensityChart() {
  const root = d3.select("#intensity");
  const svg = root.append("svg").attr("role", "img")
    .attr("aria-label", "Area chart of hourly fire radiative power in gigawatts, with a zoom strip below");
  const margin = { top: 22, right: 14, bottom: 22, left: 46 };
  const stripHeight = 44;
  const stripGap = 30;

  const clipId = "intensity-clip";
  const clipRect = svg.append("defs").append("clipPath").attr("id", clipId).append("rect");
  const plot = svg.append("g");
  const gridG = plot.append("g").attr("class", "grid");
  const nightG = plot.append("g").attr("clip-path", `url(#${clipId})`);
  const dataG = plot.append("g").attr("clip-path", `url(#${clipId})`);
  const area = dataG.append("path").attr("class", "value-area");
  const line = dataG.append("path").attr("class", "value-line");
  const xAxisG = plot.append("g").attr("class", "axis");
  const yAxisG = plot.append("g").attr("class", "axis");
  const unitLabel = plot.append("text").attr("y", -9).text("Gigawatts");
  const peakDot = plot.append("circle").attr("class", "marker").attr("r", 4);
  const peakLabel = plot.append("text").attr("class", "peak-label");
  const crosshair = plot.append("line").attr("class", "crosshair").style("display", "none");
  const cursorDot = plot.append("circle").attr("class", "marker").attr("r", 4).style("display", "none");
  const overlay = plot.append("rect").attr("fill", "transparent");

  const strip = svg.append("g");
  const stripArea = strip.append("path").attr("class", "context-area");
  const stripAxisG = strip.append("g").attr("class", "axis");
  const brushG = strip.append("g");
  const brush = d3.brushX().on("brush end", onBrush);

  let innerW = 0;
  let stripX = d3.scaleUtc();
  let syncingBrush = false;

  function onBrush(event) {
    if (syncingBrush) return;
    const sel = event.selection;
    if (!sel) {
      if (event.type === "end") setWindow(null);
      return;
    }
    const hourAt = px => (stripX.invert(px) - hourDate(0)) / HOUR_MS;
    const a = Math.max(0, Math.floor(hourAt(sel[0])));
    const b = Math.min(totalHours, Math.max(a + 2, Math.ceil(hourAt(sel[1]))));
    setWindow([a, b], { fromBrush: true });
  }

  function moveBrush() {
    syncingBrush = true;
    brushG.call(brush.move, state.window ? state.window.map(i => stripX(hourDate(i))) : null);
    syncingBrush = false;
  }

  function draw({ animate = false } = {}) {
    const { width, height } = chartSize("intensity", 0.36, 300, 380);
    const totalH = height + stripGap + stripHeight + 18;
    svg.attr("viewBox", `0 0 ${width} ${totalH}`).attr("height", totalH);
    innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    plot.attr("transform", `translate(${margin.left},${margin.top})`);
    clipRect.attr("width", innerW).attr("height", innerH + 1);

    const s = activeSeries();
    const visible = hoursInWindow();
    const [a, b] = currentWindow();
    const days = (b - a) / 24;

    const x = d3.scaleUtc().domain([hourDate(a), hourDate(b - 1)]).range([0, innerW]);
    // The y scale always comes from the filled values, so switching measure moves the curve, not the axis.
    const yMax = d3.max(visible, d => d.filled) || 1;
    const y = d3.scaleLinear().domain([0, yMax * 1.08]).nice(5).range([innerH, 0]);

    gridG.call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""));
    yAxisG.call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8).tickFormat(d3.format(",")));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, innerW / 90)).tickSizeOuter(0)
        .tickFormat(d => (days <= 4 && d.getUTCHours() !== 0 ? fmtHour(d) : fmtDay(d))));
    unitLabel.attr("x", -margin.left + 2);

    const nights = days <= NIGHT_BAND_MAX_DAYS ? nightSpans(a, b) : [];
    nightG.selectAll("rect").data(nights).join("rect")
      .attr("class", "night-band")
      .attr("x", d => x(hourDate(d[0])))
      .attr("width", d => x(hourDate(d[1])) - x(hourDate(d[0])))
      .attr("height", innerH);

    const value = d => d[state.mode];
    const areaGen = d3.area().x(d => x(d.date)).y0(innerH).y1(d => y(value(d))).curve(d3.curveMonotoneX);
    const lineGen = areaGen.lineY1();
    const apply = sel => (animate ? sel.transition().duration(450) : sel);
    area.datum(visible);
    line.datum(visible);
    apply(area).attr("d", areaGen);
    apply(line).attr("d", lineGen);

    const peak = d3.greatest(visible, value);
    const hasPeak = peak && value(peak) > 0;
    peakDot.style("display", hasPeak ? null : "none");
    peakLabel.style("display", hasPeak ? null : "none");
    if (hasPeak) {
      const px = x(peak.date);
      apply(peakDot).attr("cx", px).attr("cy", y(value(peak)));
      const onRight = px > innerW * 0.7;
      peakLabel.attr("x", px + (onRight ? -10 : 10)).attr("y", Math.max(10, y(value(peak)) - 8))
        .attr("text-anchor", onRight ? "end" : "start")
        .text(`Peak ${fmtGW(value(peak))} GW, ${fmtDay(peak.date)} ${fmtHour(peak.date)}`);
    }

    overlay.attr("width", innerW).attr("height", innerH)
      .on("pointermove", event => {
        const [mx] = d3.pointer(event);
        const i = d3.bisector(d => d.date).center(visible, x.invert(mx));
        const d = visible[i];
        if (!d) return;
        const px = x(d.date);
        crosshair.style("display", null).attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", innerH);
        cursorDot.style("display", null).attr("cx", px).attr("cy", y(value(d)));
        const ember = cssVar("--ember");
        const nopower = cssVar("--nopower");
        tooltip.show(event.clientX, event.clientY, `${fmtDay(d.date)}, ${fmtHour(d.date)} solar${isNight(d.hod) ? " (night)" : ""}`, [
          [`${fmtGW(d.filled)} GW`, "gap-filled", state.mode === "filled" ? ember : nopower],
          [`${fmtGW(d.reported)} GW`, "reported", state.mode === "reported" ? ember : nopower],
          [d3.format(".1f")(d.withFrp + d.noFrp), "pixels per scan"],
        ]);
      })
      .on("pointerleave", () => {
        crosshair.style("display", "none");
        cursorDot.style("display", "none");
        tooltip.hide();
      });

    // Context strip: always the full period, always the filled curve.
    const stripTop = height + stripGap;
    strip.attr("transform", `translate(${margin.left},${stripTop})`);
    stripX = d3.scaleUtc().domain([hourDate(0), hourDate(totalHours - 1)]).range([0, innerW]);
    const stripY = d3.scaleLinear().domain([0, d3.max(s.hours, d => d.filled) || 1]).range([stripHeight, 0]);
    stripArea.datum(s.hours).attr("d", d3.area().x(d => stripX(d.date)).y0(stripHeight).y1(d => stripY(d.filled)));
    stripAxisG.attr("transform", `translate(0,${stripHeight})`)
      .call(d3.axisBottom(stripX).ticks(d3.utcWeek.every(innerW < 480 ? 2 : 1)).tickSize(0).tickPadding(6).tickFormat(fmtDay));
    brush.extent([[0, 0], [innerW, stripHeight]]);
    brushG.call(brush);
    moveBrush();

    updateIntensityFinding(visible);
  }

  return { draw, moveBrush };
}

function updateIntensityFinding(visible) {
  const el = document.getElementById("intensity-finding");
  const sum = key => d3.sum(visible, d => d[key]);
  const reported = sum("reported");
  const filled = sum("filled");
  if (!filled) {
    el.textContent = `${activeSeries().name} shows no detections in this window.`;
    return;
  }
  const hidden = 1 - reported / filled;
  el.textContent = `In this window, reported power alone misses about ${fmtPct(hidden)} of the gap-filled estimate. ` +
    `Try Busiest 3 days, then Reported only: a second hump appears each evening exactly where the night shading begins. ` +
    `That is not the fires. Most daytime cloud flags vanish at sunset, so pixels suddenly regain a power value. Gap-filling removes most of the hump.`;
}

/* Graph 5: mean pixels per scan by solar hour, split by whether a power value exists. */
function hourProfile(rows) {
  const bins = d3.range(24).map(h => ({ h, withFrp: 0, noFrp: 0, count: 0 }));
  for (const d of rows) {
    const bin = bins[d.hod];
    bin.withFrp += d.withFrp;
    bin.noFrp += d.noFrp;
    bin.count += 1;
  }
  for (const bin of bins) {
    bin.withFrp = bin.count ? bin.withFrp / bin.count : 0;
    bin.noFrp = bin.count ? bin.noFrp / bin.count : 0;
    bin.total = bin.withFrp + bin.noFrp;
    bin.share = bin.total ? bin.noFrp / bin.total : 0;
  }
  return bins;
}

function roundedTopBar(x, y, w, h, r) {
  if (h <= 0) return `M${x},${y}h${w}v0h${-w}Z`;
  const c = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + c}Q${x},${y} ${x + c},${y}H${x + w - c}Q${x + w},${y} ${x + w},${y + c}V${y + h}Z`;
}

function createHoursChart() {
  const root = d3.select("#hours");
  const svg = root.append("svg").attr("role", "img")
    .attr("aria-label", "Stacked bar chart of average fire pixels per scan for each solar hour of the day");
  const margin = { top: 24, right: 8, bottom: 34, left: 40 };
  const nightG = svg.append("g");
  const gridG = svg.append("g").attr("class", "grid");
  const hitG = svg.append("g");
  const barsG = svg.append("g").style("pointer-events", "none");
  const xAxisG = svg.append("g").attr("class", "axis");
  const yAxisG = svg.append("g").attr("class", "axis");
  const unitLabel = svg.append("text").attr("y", 12).text("Pixels per scan");
  const xLabel = svg.append("text").attr("text-anchor", "end").text("Local solar hour");

  function draw({ animate = false } = {}) {
    const { width, height } = chartSize("hours", 0.32, 260, 330);
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const bottom = margin.top + innerH;

    const bins = hourProfile(hoursInWindow());
    const x = d3.scaleBand().domain(d3.range(24)).range([margin.left, margin.left + innerW]).paddingInner(0);
    const y = d3.scaleLinear().domain([0, d3.max(bins, d => d.total) || 1]).nice(4).range([bottom, margin.top]);
    const barW = Math.min(24, x.bandwidth() - 2);
    const barX = h => x(h) + (x.bandwidth() - barW) / 2;
    const apply = sel => (animate ? sel.transition().duration(350) : sel);

    nightG.selectAll("rect").data([[0, NIGHT_END], [NIGHT_START, 24]]).join("rect")
      .attr("class", "night-band")
      .attr("x", d => x(d[0]))
      .attr("width", d => (d[1] - d[0]) * x.step())
      .attr("y", margin.top).attr("height", innerH);

    gridG.attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(""));
    yAxisG.attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat(d3.format(",")));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${bottom})`)
      .call(d3.axisBottom(x).tickValues(d3.range(0, 24, innerW < 480 ? 6 : 3)).tickSizeOuter(0).tickFormat(hourLabel));
    xLabel.attr("x", margin.left + innerW).attr("y", height - 2);
    unitLabel.attr("x", 0);

    const GAP = 2;
    barsG.selectAll("path.bar-power").data(bins, d => d.h).join("path").attr("class", "bar-power")
      .call(sel => apply(sel).attr("d", d => {
        const top = y(d.withFrp);
        const h = bottom - top;
        return d.noFrp > 0 ? `M${barX(d.h)},${top}h${barW}v${h}h${-barW}Z` : roundedTopBar(barX(d.h), top, barW, h, 4);
      }));
    barsG.selectAll("path.bar-nopower").data(bins, d => d.h).join("path").attr("class", "bar-nopower")
      .call(sel => apply(sel).attr("d", d => {
        const top = y(d.total);
        const h = Math.max(0, y(d.withFrp) - top - GAP);
        return roundedTopBar(barX(d.h), top, barW, h, 4);
      }));

    const show = (event, d) => {
      const box = event.currentTarget.getBoundingClientRect();
      const px = event.clientX || box.left + box.width / 2;
      const py = event.clientY || box.top + 40;
      tooltip.show(px, py, `${hourLabel(d.h)} solar${isNight(d.h) ? " (night)" : ""}`, [
        [d3.format(".1f")(d.withFrp), "pixels with power", cssVar("--ember")],
        [d3.format(".1f")(d.noFrp), "pixels without", cssVar("--nopower")],
        [fmtPct(d.share), "have no power value"],
      ]);
    };
    hitG.selectAll("rect").data(bins, d => d.h).join("rect")
      .attr("class", "hit").attr("tabindex", 0)
      .attr("aria-label", d => `${hourLabel(d.h)}: ${d3.format(".1f")(d.total)} pixels per scan, ${fmtPct(d.share)} without a power value`)
      .attr("x", d => x(d.h)).attr("width", x.step())
      .attr("y", margin.top).attr("height", innerH)
      .on("pointermove focus", show)
      .on("pointerleave blur", () => tooltip.hide());

    updateHoursFinding(bins);
  }

  return { draw };
}

function updateHoursFinding(bins) {
  const el = document.getElementById("hours-finding");
  const peak = d3.greatest(bins, d => d.total);
  if (!peak || !peak.total) {
    el.textContent = "No detections in this window.";
    return;
  }
  const part = test => {
    const rows = bins.filter(test);
    const total = d3.sum(rows, d => d.total);
    return total ? d3.sum(rows, d => d.noFrp) / total : 0;
  };
  const day = part(d => d.h >= 9 && d.h < NIGHT_START - 1);
  const evening = part(d => d.h >= NIGHT_START && d.h < 24);
  const low = d3.least(bins.filter(d => d.total > 0), d => d.total);
  el.textContent = `Detections peak at ${hourLabel(peak.h)} solar, ${d3.format(".1f")(peak.total / Math.max(low.total, 0.01))} times the ${hourLabel(low.h)} low. ` +
    `Through the afternoon ${fmtPct(day)} of fire pixels have no power value, against ${fmtPct(evening)} after sunset.`;
}

/* Graph 6: running max distance from origin, one line per fire. */
function createSpreadChart() {
  const root = d3.select("#spread");
  const svg = root.append("svg").attr("role", "img")
    .attr("aria-label", "Step lines of the farthest fire pixel from each fire's origin over days since discovery");
  const margin = { top: 24, right: 92, bottom: 34, left: 40 };
  const clipRect = svg.append("defs").append("clipPath").attr("id", "spread-clip").append("rect");
  const gridG = svg.append("g").attr("class", "grid");
  const xAxisG = svg.append("g").attr("class", "axis");
  const yAxisG = svg.append("g").attr("class", "axis");
  const linesG = svg.append("g").attr("clip-path", "url(#spread-clip)");
  const mergeG = svg.append("g").attr("clip-path", "url(#spread-clip)");
  const labelsG = svg.append("g");
  const crosshair = svg.append("line").attr("class", "crosshair").style("display", "none");
  svg.append("text").attr("x", 0).attr("y", 12).text("Kilometres from origin");
  const xLabel = svg.append("text").attr("text-anchor", "end").text("Days since discovery");
  const overlay = svg.append("rect").attr("fill", "transparent").style("cursor", "pointer");
  let hovered = null;

  const kmAt = (run, h) => {
    const i = d3.bisector(p => p[0]).right(run.pts, h) - 1;
    return i >= 0 ? run.pts[i] : null;
  };

  function highlight() {
    const on = run => run.id === state.fire || run.id === hovered;
    linesG.selectAll("path").classed("on", on).filter(on).raise();
    linesG.selectAll("circle").classed("on", on).filter(on).raise();
    labelsG.selectAll("text").style("display", d => (on(d) || d.alwaysLabel ? null : "none"));
    d3.selectAll("#fire-table tbody tr").classed("hover", d => d.id === hovered);
  }

  function setHover(id) {
    if (hovered === id) return;
    hovered = id;
    highlight();
  }

  function draw() {
    const { width, height } = chartSize("spread", 0.56, 280, 340);
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const innerW = width - margin.left - margin.right;
    const bottom = height - margin.bottom;
    const maxDays = state.spreadDays || d3.max(runs, r => r.lastHour) / 24;
    const x = d3.scaleLinear().domain([0, maxDays]).nice().range([margin.left, margin.left + innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(runs, r => r.farthest)]).nice(5).range([bottom, margin.top]);
    clipRect.attr("x", margin.left - 6).attr("y", margin.top - 6).attr("width", innerW + 12).attr("height", bottom - margin.top + 12);

    gridG.attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""));
    yAxisG.attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8));
    yAxisG.select(".domain").remove();
    xAxisG.attr("transform", `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(6).tickSizeOuter(0));
    xLabel.attr("x", margin.left + innerW).attr("y", height - 2);

    const lineGen = d3.line().x(p => x(p[0] / 24)).y(p => y(p[1])).curve(d3.curveStepAfter);
    linesG.selectAll("path").data(runs, r => r.id).join("path").attr("class", "spread-line")
      .attr("d", r => lineGen(r.pts));
    linesG.selectAll("circle").data(runs, r => r.id).join("circle").attr("class", "spread-dot").attr("r", 4)
      .attr("cx", r => x(r.lastHour / 24)).attr("cy", r => y(r.farthest));
    mergeG.selectAll("circle")
      .data(runs.flatMap(r => r.pts.filter(p => p[3] === 1)))
      .join("circle").attr("class", "merge-ring").attr("r", 4)
      .attr("cx", p => x(p[0] / 24)).attr("cy", p => y(p[1]));
    labelsG.selectAll("text").data(runs, r => r.id).join("text").attr("class", "line-label")
      .attr("x", r => x(Math.min(r.lastHour / 24, x.domain()[1])) + 8)
      .attr("y", r => y(r.lastHour / 24 > x.domain()[1] ? kmAt(r, x.domain()[1] * 24)[1] : r.farthest) + 4)
      .text(r => r.name);

    overlay.attr("x", margin.left).attr("y", margin.top).attr("width", innerW).attr("height", bottom - margin.top)
      .on("pointermove", event => {
        const [mx, my] = d3.pointer(event);
        const h = Math.max(0, Math.round(x.invert(mx) * 24));
        const nearest = d3.least(
          runs.map(run => ({ run, p: kmAt(run, h) })).filter(c => c.p && h <= c.run.lastHour),
          c => Math.abs(y(c.p[1]) - my));
        if (!nearest) return;
        const px = x(h / 24);
        crosshair.style("display", null).attr("x1", px).attr("x2", px).attr("y1", margin.top).attr("y2", bottom);
        setHover(nearest.run.id);
        tooltip.show(event.clientX, event.clientY, `${nearest.run.name}, ${nearest.run.place}`, [
          [`${fmtInt(nearest.p[1])} km`, `${compass(nearest.p[2])} of origin`, cssVar("--ember")],
          [`Day ${d3.format(".1f")(h / 24)}`, "since discovery"],
          [fmtInt(nearest.run.acres), "acres, final perimeter"],
        ]);
      })
      .on("pointerleave", () => {
        crosshair.style("display", "none");
        setHover(null);
        tooltip.hide();
      })
      .on("click", () => {
        if (hovered) setFire(state.fire === hovered ? "all" : hovered);
      });

    highlight();
  }

  return { draw, highlight, setHover };
}

function buildFireTable(chart) {
  const rows = d3.select("#fire-table tbody").selectAll("tr").data(runs).join("tr")
    .attr("tabindex", 0)
    .on("pointerenter", (_, r) => chart.setHover(r.id))
    .on("pointerleave", () => chart.setHover(null))
    .on("click", (_, r) => setFire(state.fire === r.id ? "all" : r.id))
    .on("keydown", (event, r) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setFire(state.fire === r.id ? "all" : r.id);
      }
    });
  const name = rows.append("td");
  name.append("span").text(r => r.name);
  name.append("small").text(r => r.place);
  rows.append("td").attr("class", "n").text(r => `${fmtInt(r.fastest.km)} km`);
  rows.append("td").attr("class", "n").text(r => `${fmtInt(r.farthest)} km`);
}

function updateSpreadFinding() {
  const el = document.getElementById("spread-finding");
  const sel = runs.find(r => r.id === state.fire);
  const r = sel || runs[0];
  const start = sel ? `${sel.name} gained` : `${r.name} made the fastest run:`;
  el.textContent = `${start} ${fmtInt(r.fastest.km)} km in 6 hours around day ${d3.format(".1f")(r.fastest.hour / 24)}, ` +
    `${fmtPct(r.fastest.km / r.farthest)} of its ${fmtInt(r.farthest)} km reach. Fires advance in bursts, not at a steady pace.`;
}

function updateFilterUI() {
  const s = activeSeries();
  const scope = document.getElementById("scope-label");
  scope.textContent = `${s.place}, ${windowLabel()}`;
  document.getElementById("fire-select").value = state.fire;
  d3.selectAll("#fire-table tbody tr").attr("aria-selected", r => r.id === state.fire);
}

function redrawAll(opts) {
  updateFilterUI();
  updateSpreadFinding();
  redraws.forEach(fn => fn(opts));
}

function setFire(id) {
  if (state.fire === id) return;
  state.fire = id;
  state.window = null;
  state.hour = null;
  redrawAll({ animate: true });
}

function setWindow(win, { fromBrush = false } = {}) {
  const same = (win && state.window && win[0] === state.window[0] && win[1] === state.window[1]) || (!win && !state.window);
  if (same) return;
  state.window = win;
  state.hour = null;
  redrawAll({ animate: !fromBrush });
}

function busiestWindow(hours, span = 72) {
  const values = hours.map(d => d.filled);
  let sum = d3.sum(values.slice(0, span));
  let best = sum;
  let bestStart = 0;
  for (let i = span; i < values.length; i++) {
    sum += values[i] - values[i - span];
    if (sum > best) {
      best = sum;
      bestStart = i - span + 1;
    }
  }
  return [bestStart, bestStart + span];
}

function prepareData(raw) {
  meta = raw.meta;
  totalHours = meta.hours;
  series = raw.series.map(s => {
    const hours = d3.range(totalHours).map(i => ({
      i, date: hourDate(i), hod: i % 24, withFrp: 0, noFrp: 0, reported: 0, filled: 0,
    }));
    for (const [i, withFrp, noFrp, reported, filled] of s.rows) {
      if (i < totalHours) Object.assign(hours[i], { withFrp, noFrp, reported, filled });
    }
    return { ...s, hours };
  });
  seriesById = new Map(series.map(s => [s.id, s]));

  runs = raw.spread.map(r => {
    const last = r.pts[r.pts.length - 1];
    const perimeterGeo = rewind(r.perimeter);
    const perimeterPoints = (perimeterGeo.type === "Polygon" ? [perimeterGeo.coordinates] : perimeterGeo.coordinates).flat(2);
    return { ...r, perimeterGeo, perimeterPoints, lastHour: last[0], farthest: last[1], fastest: fastestRun(r.pts) };
  }).sort((a, b) => d3.descending(a.fastest.km, b.fastest.km));
  for (const r of d3.sort(runs, r => -r.farthest).slice(0, 2)) r.alwaysLabel = true;
}

/* Largest gain within a 6-hour span. Merge steps are taken out first, because
   linking up with a separate start is not the fire moving. */
function fastestRun(pts, span = 6) {
  let removed = 0;
  let previous = 0;
  const grown = pts.map(([hour, km, , merged]) => {
    if (merged) removed += km - previous;
    previous = km;
    return { hour, km: km - removed };
  });
  const kmAt = hour => {
    const i = d3.bisector(p => p.hour).right(grown, hour) - 1;
    return i >= 0 ? grown[i].km : 0;
  };
  return grown.reduce((best, p) => {
    const gain = p.km - kmAt(p.hour - span);
    return gain > best.km ? { km: gain, hour: p.hour } : best;
  }, { km: 0, hour: 0 });
}

function writeNotes() {
  document.getElementById("data-note").textContent =
    `Data: ${meta.satellite} ${meta.product}, 5-minute scans, ${meta.start} to ${meta.end}, western US only. ` +
    `${fmtInt(meta.scans)} scans reduced to ${fmtInt(meta.keptPixels)} fire pixels.`;
  document.getElementById("method-note").textContent =
    `All times are local solar time (UTC + longitude / 15), so 12:00 is when the sun is highest at any longitude. ` +
    `At 120°W, solar time is about 1 hour 20 minutes behind PDT. ` +
    `Gap-filled power gives each cloud-flagged pixel the mean power of valid pixels in the same half-degree cell and hour; it is an estimate. ` +
    `Spread uses NIFC perimeters and points of origin to assign pixels to fires; a pixel joins a fire once it lies within 6 km of that fire\u2019s connected footprint.`;
}

function bindControls(intensity) {
  const select = d3.select("#fire-select");
  select.selectAll("option").data(series).join("option").attr("value", s => s.id).text(s => s.name);
  select.on("change", event => setFire(event.target.value));

  const buttons = d3.selectAll("#mode-toggle button");
  buttons.on("click", event => {
    const mode = event.currentTarget.dataset.mode;
    if (mode === state.mode) return;
    state.mode = mode;
    buttons.attr("aria-checked", function () { return this.dataset.mode === mode; });
    redrawAll({ animate: true });
  });

  d3.select("#zoom-busiest").on("click", () => setWindow(busiestWindow(activeSeries().hours)));
  d3.select("#zoom-reset").on("click", () => setWindow(null));

  const spreadButtons = d3.selectAll("#spread-range button");
  spreadButtons.on("click", event => {
    const days = +event.currentTarget.dataset.days || null;
    if (days === state.spreadDays) return;
    state.spreadDays = days;
    spreadButtons.attr("aria-checked", function () { return (+this.dataset.days || null) === days; });
    redrawAll({});
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => redrawAll({}), 120);
  });
}

async function init() {
  let raw, rawPixels;
  try {
    [raw, rawPixels, states] = await Promise.all([
      d3.json("data/fires.json"), d3.json("data/pixels.json"), d3.json("data/states.geojson"),
    ]);
  } catch (err) {
    const p = document.createElement("p");
    p.className = "load-error";
    p.textContent = "Could not load the files in data/. Open this page through a local server, not as a file.";
    document.querySelector("main").prepend(p);
    return;
  }
  prepareData(raw);
  pixelData = preparePixels(rawPixels);
  writeNotes();

  const snapshot = createMap("snapshot", { follow: "peak" });
  const animap = createMap("animap", { follow: "slider" });
  let player;
  const counts = createCountsChart(h => player.setHour(h));
  player = createPlayer(animap, counts);
  const intensity = createIntensityChart();
  const hours = createHoursChart();
  const spread = createSpreadChart();
  buildFireTable(spread);
  bindControls(intensity);
  redraws.push(snapshot.draw, updateSnapshotFinding, counts.draw, animap.draw, player.show,
    intensity.draw, hours.draw, spread.draw);
  redrawAll({});
}

init();
