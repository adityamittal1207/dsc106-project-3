/* Spread explorer: one zoomable map of GOES fire pixels with a timeline underneath.

   S.fire   id of the fire being followed, or null for the whole West
   S.hour   solar hour index shown on the map
   S.view   "power" (what burns now, coloured by heat) or "arrival" (all burned ground, coloured by date)

   The time span on the timeline follows the selection: the whole period, or one fire's life. */

const S = { fire: null, hour: 0, view: "power" };
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const UNMEASURED = "#8fa0b8";
const SCAR = "#050403";
const TRAIL_HOURS = 12;        // recently burning pixels fade out over this long
const PLAY_SECONDS = 45;       // a full play-through of the visible span
// NASA Blue Marble shaded relief (EPSG:3857): a sharp tile over the study area and a wide, coarser one behind it.
const BASEMAP = { href: "data/basemap.jpg", west: -128, east: -107, south: 33, north: 51 };
const BASEMAP_WIDE = { href: "data/basemap-wide.jpg", west: -142, east: -93, south: 29, north: 54 };
const CITIES = [
  ["Seattle", -122.33, 47.61, 1], ["Portland", -122.68, 45.52, 1], ["Spokane", -117.43, 47.66, 1],
  ["Boise", -116.2, 43.62, 1], ["Salt Lake City", -111.89, 40.76, 1], ["Reno", -119.81, 39.53, 1],
  ["Sacramento", -121.49, 38.58, 1], ["San Francisco", -122.42, 37.77, 1], ["Las Vegas", -115.14, 36.17, 1],
  ["Bend", -121.31, 44.06, 2], ["Medford", -122.87, 42.33, 2], ["Yakima", -120.51, 46.6, 2],
  ["Missoula", -113.99, 46.87, 2], ["Redding", -122.39, 40.59, 2], ["Twin Falls", -114.46, 42.56, 2],
  ["Elko", -115.76, 40.83, 2], ["Fresno", -119.79, 36.74, 2], ["Eugene", -123.09, 44.05, 2.5],
  ["Burns", -119.05, 43.59, 3], ["Wenatchee", -120.31, 47.42, 3], ["Pendleton", -118.79, 45.67, 3],
  ["Winnemucca", -117.74, 40.97, 3], ["Baker City", -117.83, 44.77, 3], ["Omak", -119.53, 48.41, 3],
  ["Richfield", -112.08, 38.77, 3], ["Susanville", -120.65, 40.42, 3],
].map(([name, lon, lat, minK]) => ({ name, lon, lat, minK }));

let N, firstHour, pixHours, activeAt, firstByHour;
let map, timeline, player;

const fmt1 = d3.format(".1f");
const hourStamp = h => `${fmtDay(hourDate(h))}, ${fmtHour(hourDate(h))}`;
const fmtPower = gw => (gw >= 1 ? `${fmtGW(gw)} GW` : `${fmtInt(gw * 1000)} MW`);
const runById = id => runs.find(r => r.id === id);
const selectedRun = () => (S.fire ? runById(S.fire) : null);
const discoveryHour = run => (new Date(run.discovered) - new Date(meta.t0)) / HOUR_MS + run.origin[0] / 15;

/* ---------- data ---------- */

function indexPixels() {
  N = pixelData.pos.length;
  firstHour = new Int32Array(N).fill(-1);
  pixHours = Array.from({ length: N }, () => []);
  activeAt = new Array(totalHours);
  for (let h = 0; h < totalHours; h++) {
    const flat = pixelData.hours[h] || [];
    const list = [];
    for (let j = 0; j < flat.length; j += 3) {
      const i = flat[j];
      list.push({ i, scans: flat[j + 1], mw: flat[j + 2] });
      if (firstHour[i] < 0) firstHour[i] = h;
      pixHours[i].push(h);
    }
    activeAt[h] = list;
  }
  firstByHour = d3.groups(d3.range(N).filter(i => firstHour[i] >= 0), i => firstHour[i])
    .map(([h, pix]) => ({ h, pix })).sort((a, b) => a.h - b.h);
}

/* Hourly rows for the selection: power from the build (per-scan average), pixel counts from the
   pixel table so they match what the map draws. */
const seriesCache = new Map();
function scopeSeries() {
  const key = S.fire || "all";
  if (seriesCache.has(key)) return seriesCache.get(key);
  const k = S.fire ? pixelData.fireIndex.get(S.fire) : null;
  const exact = seriesById.get(key).hours;
  const hours = d3.range(totalHours).map(h => {
    let n = 0;
    for (const r of activeAt[h]) if (k == null || pixelData.pos[r.i].fire === k) n++;
    return { i: h, date: hourDate(h), hod: h % 24, n, filled: exact[h].filled, reported: exact[h].reported };
  });
  seriesCache.set(key, hours);
  return hours;
}

/* Hours shown on the timeline: everything, or one fire from just before its first spark to its last detection. */
function win() {
  const run = selectedRun();
  if (!run) return [0, totalHours];
  if (!run.span) {
    const rows = scopeSeries();
    const first = rows.findIndex(d => d.n > 0);
    const last = rows.length - 1 - [...rows].reverse().findIndex(d => d.n > 0);
    const start = Math.min(first < 0 ? totalHours : first, Math.floor(discoveryHour(run)));
    run.span = [Math.max(0, start - 6), Math.min(totalHours, Math.max(last, start + 48) + 12)];
  }
  return run.span;
}
const clampHour = h => { const [a, b] = win(); return Math.max(a, Math.min(b - 1, h)); };

/* ---------- colour ---------- */

const fireRamp = d3.interpolateRgbBasis(["#b3260f", "#e8501a", "#ff8a1f", "#ffc23d", "#fff6c4"]);
const powerScale = d3.scaleSequentialLog([40, 2500], fireRamp).clamp(true);
const arrivalRamp = t => d3.interpolateViridis(0.22 + 0.78 * t);
let arrivalScale = d3.scaleSequential([0, 1], arrivalRamp).clamp(true);

/* Date range for the arrival colours: when the selection's ground first burned, cut at the 95th
   percentile so a few late pixels do not flatten the days when the fire actually ran. */
function arrivalDomain() {
  const k = S.fire ? pixelData.fireIndex.get(S.fire) : null;
  const hours = [];
  for (let i = 0; i < N; i++) if (firstHour[i] >= 0 && (k == null || pixelData.pos[i].fire === k)) hours.push(firstHour[i]);
  hours.sort(d3.ascending);
  if (!hours.length) return [0, 1];
  const lo = hours[0];
  return [lo, Math.max(lo + 24, d3.quantileSorted(hours, S.fire ? 0.95 : 1))];
}
const rampCss = ramp => `linear-gradient(to right, ${d3.range(0, 1.001, 0.1).map(ramp).join(",")})`;

function drawLegend() {
  const key = (color, text) => `<span><i style="background:${color}"></i>${text}</span>`;
  let title, ramp, ticks, keys;
  if (S.view === "power") {
    title = "Heat from each burning pixel";
    ramp = rampCss(fireRamp);
    ticks = ["40 MW", "300", "2,500+"];
    keys = key(UNMEASURED, "Burning, heat hidden by cloud") + key(SCAR, "Already burned");
  } else {
    const [a, b] = arrivalDomain();
    title = "Date fire first reached each pixel";
    ramp = rampCss(arrivalRamp);
    ticks = [fmtDay(hourDate(a)), fmtDay(hourDate(Math.floor((a + b) / 2))), `${fmtDay(hourDate(b))}${S.fire ? " on" : ""}`];
    keys = key("#fff", "Burning now");
  }
  d3.select("#map-legend").html(`<div class="lg-title">${title}</div><div class="lg-ramp" style="background:${ramp}"></div>` +
    `<div class="lg-ticks">${ticks.map(t => `<span>${t}</span>`).join("")}</div><div class="lg-keys">${keys}</div>`);
}

/* ---------- map ---------- */

function destination([lon, lat], bearingDeg, km) {
  const d = km / 6371, br = bearingDeg * Math.PI / 180;
  const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [l2 * 180 / Math.PI, p2 * 180 / Math.PI];
}

/* Farthest connected point of a fire at the end of solar hour h: [hours, km, bearing, merged] or null. */
function reachAt(run, h) {
  const t = h + 1 - discoveryHour(run);
  const i = d3.bisector(p => p[0]).right(run.pts, t) - 1;
  return i >= 0 ? run.pts[i] : null;
}

function createMap() {
  const wrap = d3.select("#map");
  const svg = wrap.insert("svg", ":first-child").attr("role", "img")
    .attr("aria-label", "Zoomable map of the western United States showing where the satellite saw fire in the selected hour");
  const zoomG = svg.append("g");
  const imageWide = zoomG.append("image").attr("href", BASEMAP_WIDE.href).attr("preserveAspectRatio", "none");
  const image = zoomG.append("image").attr("href", BASEMAP.href).attr("preserveAspectRatio", "none");
  const shade = zoomG.append("rect").attr("class", "m-shade");
  const outside = zoomG.append("path").attr("class", "m-outside").attr("fill-rule", "evenodd");
  const studyEdge = zoomG.append("path").attr("class", "m-study");
  const statesG = zoomG.append("g");
  const scarG = zoomG.append("g").attr("class", "m-pixels m-scar");
  const trailG = zoomG.append("g").attr("class", "m-pixels m-trail");
  const activeG = zoomG.append("g").attr("class", "m-pixels m-active");
  const perimG = zoomG.append("g");
  const reachRing = zoomG.append("path").attr("class", "m-reach");
  const reachLine = zoomG.append("line").attr("class", "m-reach-line");
  const hoverPath = zoomG.append("path").attr("class", "m-hover");
  const labelsG = svg.append("g").attr("class", "m-labels");
  const stateLabels = labelsG.append("g");
  const cityLabels = labelsG.append("g");
  const fireLabels = labelsG.append("g");
  const reachLabel = labelsG.append("text").attr("class", "reach-label");
  const scaleBar = svg.append("g").attr("class", "m-scale");
  scaleBar.append("line");
  scaleBar.append("text");

  let W = 0, H = 0, projection, path, pxBase = 1;
  let t = d3.zoomIdentity;
  let cx, cy, dstr, quadtree;
  let scarNodes = [], scarHours = [], scarShown = [];
  let hoverId = null, nowSet = new Map(), reachXY = null;

  const zoom = d3.zoom().scaleExtent([1, 32])
    .on("zoom", e => {
      t = e.transform;
      zoomG.attr("transform", t);
      onTransform();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function studyRing() {
    const [w, s, e, n] = meta.bbox;
    const steps = 30;
    const edge = (x0, y0, x1, y1) => d3.range(steps).map(k => [x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps]);
    return [...edge(w, s, e, s), ...edge(e, s, e, n), ...edge(e, n, w, n), ...edge(w, n, w, s), [w, s]];
  }

  /* Screen pixels per km at a latitude, before zoom (Mercator stretches with latitude). */
  const kmPxAt = lat => projection.scale() / (6371 * Math.cos(lat * Math.PI / 180));

  function layout() {
    const node = wrap.node();
    W = Math.max(300, node.clientWidth);
    H = Math.max(300, node.clientHeight);
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    const ring = studyRing();
    // Mercator, so the NASA basemap (EPSG:3857) lines up exactly.
    projection = d3.geoMercator().fitExtent([[14, 14], [W - 14, H - 14]], { type: "MultiPoint", coordinates: ring });
    path = d3.geoPath(projection);
    zoom.extent([[0, 0], [W, H]]).translateExtent([[-W * 0.5, -H * 0.2], [W * 1.5, H * 1.2]]);
    pxBase = kmPxAt(42) * 2.2;

    const place = (el, b) => {
      const [x0, y0] = projection([b.west, b.north]);
      const [x1, y1] = projection([b.east, b.south]);
      el.attr("x", x0).attr("y", y0).attr("width", x1 - x0).attr("height", y1 - y0);
    };
    place(imageWide, BASEMAP_WIDE);
    place(image, BASEMAP);
    place(shade, BASEMAP_WIDE);
    const nw = projection([BASEMAP_WIDE.west, BASEMAP_WIDE.north]);
    const se = projection([BASEMAP_WIDE.east, BASEMAP_WIDE.south]);
    outside.attr("d", `M${nw[0]},${nw[1]}H${se[0]}V${se[1]}H${nw[0]}Z M` + ring.map(p => projection(p).map(v => v.toFixed(1)).join(",")).join("L") + "Z");

    studyEdge.attr("d", path({ type: "LineString", coordinates: ring }));

    cx = new Float32Array(N);
    cy = new Float32Array(N);
    dstr = new Array(N);
    for (let i = 0; i < N; i++) {
      const pts = pixelData.pos[i].corners.map(p => projection(p));
      cx[i] = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      cy[i] = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      dstr[i] = "M" + pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("L") + "Z";
    }
    quadtree = d3.quadtree().x(i => cx[i]).y(i => cy[i]).addAll(d3.range(N));

    statesG.selectAll("path").data(states.features).join("path").attr("class", "m-state").attr("d", path);
    stateLabels.selectAll("text").data(states.features).join("text").attr("class", "state-label")
      .attr("text-anchor", "middle").text(d => d.properties.name)
      .each(d => { d.xy = path.centroid(d); });

    for (const r of runs) {
      r.xy = projection(r.origin);
      r.bounds = path.bounds(r.perimeterGeo);
    }
    for (const r of runs) {
      // Put the name on the left when another fire's marker sits just to the right.
      r.labelLeft = runs.some(o => o !== r && o.xy[0] - r.xy[0] > 0 && o.xy[0] - r.xy[0] < 130 && Math.abs(o.xy[1] - r.xy[1]) < 14);
    }
    perimG.selectAll("path").data(runs, r => r.id).join("path").attr("class", "m-perim")
      .attr("d", r => path(r.perimeterGeo))
      .on("click", (event, r) => { if (S.fire !== r.id) setFire(r.id); });

    const scar = scarG.selectAll("path").data(firstByHour, d => d.h).join("path")
      .attr("d", d => d.pix.map(i => dstr[i]).join(""));
    scarNodes = scar.nodes();
    scarHours = firstByHour.map(d => d.h);
    scarShown = scarNodes.map(() => null);

    for (const city of CITIES) city.xy = projection([city.lon, city.lat]);
    cityLabels.selectAll("g").data(CITIES).join(enter => {
      const g = enter.append("g").attr("class", "city");
      g.append("circle").attr("r", 1.8);
      g.append("text").attr("x", 5).attr("y", 3.5).text(d => d.name);
      return g;
    });

    fireLabels.selectAll("g").data(runs, r => r.id).join(enter => {
      // The whole marker (ring and name) selects the fire, so readers can click the name they see.
      const g = enter.append("g").attr("class", "fire")
        .on("click", (event, r) => setFire(S.fire === r.id ? null : r.id))
        .on("pointerenter", (event, r) => highlight(r.id))
        .on("pointerleave", () => highlight(null));
      g.append("circle").attr("class", "origin").attr("r", 4.5);
      g.append("text").attr("class", "fire-label").attr("y", 4).text(r => r.name);
      return g;
    }).select("text")
      .attr("x", r => (r.labelLeft ? -9 : 9)).attr("text-anchor", r => (r.labelLeft ? "end" : "start"));

    paint();
    selectionChanged();
    svg.call(zoom.transform, targetTransform());
    renderHour();
  }

  function targetTransform() {
    const run = selectedRun();
    if (!run) return d3.zoomIdentity;
    const [[x0, y0], [x1, y1]] = run.bounds;
    const k = Math.max(1, Math.min(14, 0.5 / Math.max((x1 - x0) / W, (y1 - y0) / H)));
    return d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  }

  function fly() {
    svg.transition().duration(REDUCED_MOTION ? 0 : 1100).call(zoom.transform, targetTransform());
  }

  // Pixels never shrink below a few screen pixels; the stroke supplies the padding. Never below a
  // hairline, so neighbouring pixels of one colour do not show seams.
  const pad = minPx => Math.max(0.7, minPx - pxBase * t.k);

  function onTransform() {
    scarG.attr("stroke-width", pad(2.4));
    trailG.attr("stroke-width", pad(3));
    activeG.attr("stroke-width", pad(3.6));
    stateLabels.selectAll("text").attr("transform", d => `translate(${t.apply(d.xy)})`)
      .style("display", t.k < 3 ? null : "none");
    // A city name gives way when a fire's name would sit on top of it.
    const fireXY = runs.map(r => t.apply(r.xy));
    cityLabels.selectAll("g").attr("transform", d => `translate(${t.apply(d.xy)})`)
      .style("display", d => {
        const [x, y] = t.apply(d.xy);
        const clash = fireXY.some(f => Math.abs(f[1] - y) < 13 && x - f[0] > -70 && x - f[0] < 130);
        return t.k >= d.minK && !clash ? null : "none";
      });
    fireLabels.selectAll("g").attr("transform", r => `translate(${t.apply(r.xy)})`);
    placeReachLabel();
    const centre = projection.invert(t.invert([W / 2, H / 2]));
    const kmPx = kmPxAt(centre[1]) * t.k;
    const km = d3.least([2, 5, 10, 20, 50, 100, 200, 500], k => Math.abs(k * kmPx - 90));
    const len = km * kmPx;
    const right = S.fire ? 334 : 16; // clear of the fire card
    scaleBar.attr("transform", `translate(${Math.max(290, W - right - len)},${H - 18})`);
    scaleBar.select("line").attr("x1", 0).attr("x2", len);
    scaleBar.select("text").attr("x", len).attr("y", -6).attr("text-anchor", "end").text(`${km} km`);
  }

  /* Colours that depend on the view or the time span, not on the hour. */
  function paint() {
    arrivalScale = d3.scaleSequential(arrivalDomain(), arrivalRamp).clamp(true);
    const byDate = S.view === "arrival";
    for (let k = 0; k < scarNodes.length; k++) {
      scarNodes[k].style.color = byDate ? arrivalScale(scarHours[k]) : "";
    }
    scarG.classed("by-date", byDate);
    activeG.classed("by-date", byDate);
    trailG.style("display", byDate ? "none" : null);
  }

  function renderHour() {
    const h = S.hour;
    const active = activeAt[h] || [];
    nowSet = new Map(active.map(r => [r.i, r]));

    for (let k = 0; k < scarNodes.length; k++) {
      const show = scarHours[k] <= h;
      if (scarShown[k] !== show) {
        scarNodes[k].style.display = show ? "" : "none";
        scarShown[k] = show;
      }
    }

    activeG.selectAll("path").data(active, d => d.i).join("path")
      .attr("d", d => dstr[d.i])
      .style("color", d => (S.view === "power" ? (d.mw > 0 ? powerScale(d.mw) : UNMEASURED) : "#fff"));
    if (S.view === "power") activeG.selectAll("path").sort((p, q) => (p.mw > 0 ? p.mw : 0) - (q.mw > 0 ? q.mw : 0));

    let trail = [];
    if (S.view === "power") {
      const last = new Map();
      for (let g = Math.max(0, h - TRAIL_HOURS); g < h; g++) {
        for (const r of activeAt[g]) if (!nowSet.has(r.i)) last.set(r.i, g);
      }
      trail = [...last];
    }
    trailG.selectAll("path").data(trail, d => d[0]).join("path")
      .attr("d", d => dstr[d[0]])
      .style("opacity", d => 0.1 + 0.6 * (1 - (h - d[1]) / TRAIL_HOURS));

    drawReach();
  }

  function drawReach() {
    const run = selectedRun();
    const p = run ? reachAt(run, S.hour) : null;
    reachRing.style("display", p ? null : "none");
    reachLine.style("display", p ? null : "none");
    reachXY = null;
    if (p) {
      const o = projection(run.origin);
      const far = projection(destination(run.origin, p[2], p[1]));
      reachRing.attr("d", path(d3.geoCircle().center(run.origin).radius(p[1] / 111.195).precision(3)()));
      reachLine.attr("x1", o[0]).attr("y1", o[1]).attr("x2", far[0]).attr("y2", far[1]);
      reachXY = far;
      reachLabel.text(`${fmtInt(p[1])} km`);
    }
    placeReachLabel();
  }

  function placeReachLabel() {
    reachLabel.style("display", reachXY ? null : "none");
    if (reachXY) {
      const [x, y] = t.apply(reachXY);
      reachLabel.attr("x", x + 8).attr("y", y - 6);
    }
  }

  function selectionChanged() {
    perimG.selectAll("path").classed("selected", r => r.id === S.fire);
    fireLabels.selectAll("g").classed("dim", r => S.fire && r.id !== S.fire);
    drawReach();
    onTransform();
  }

  function highlight(id) {
    perimG.selectAll("path").classed("hover", r => r.id === id && r.id !== S.fire);
  }

  /* Nearest pixel that has burned by the current hour. */
  function nearestBurned(bx, by, r) {
    let best = -1, bd = r * r;
    const h = S.hour;
    quadtree.visit((node, x0, y0, x1, y1) => {
      if (x0 > bx + r || x1 < bx - r || y0 > by + r || y1 < by - r) return true;
      if (!node.length) {
        let n = node;
        do {
          const i = n.data;
          const d = (cx[i] - bx) ** 2 + (cy[i] - by) ** 2;
          if (d < bd && firstHour[i] <= h) { bd = d; best = i; }
        } while ((n = n.next));
      }
      return false;
    });
    return best;
  }

  function pixelTip(event, i) {
    const p = pixelData.pos[i];
    const rec = nowSet.get(i);
    const run = runs.find(r => pixelData.fireIndex.get(r.id) === p.fire);
    const rows = [];
    if (rec) {
      rows.push(rec.mw > 0 ? [`${fmtInt(rec.mw)} MW`, "of heat, measured", powerScale(rec.mw)]
        : rec.mw < 0 ? [`about ${fmtInt(-rec.mw)} MW`, "estimated, cloud in the way", UNMEASURED]
        : ["Burning", "too faint to measure", UNMEASURED]);
    } else {
      rows.push(["Not burning", "this hour"]);
    }
    rows.push([hourStamp(firstHour[i]), "fire first seen here"]);
    rows.push([`${d3.bisectRight(pixHours[i], S.hour)} h`, "seen burning so far"]);
    tooltip.show(event.clientX, event.clientY,
      `${run ? `${run.name} fire` : "Fire pixel"} · ${p.lat.toFixed(2)}°N ${Math.abs(p.lon).toFixed(2)}°W`, rows);
  }

  svg.on("pointermove.hover", event => {
    if (event.buttons) return;
    const [bx, by] = t.invert(d3.pointer(event, svg.node()));
    const i = nearestBurned(bx, by, Math.max(pxBase * 1.1, 7 / t.k));
    if (i >= 0) {
      if (hoverId !== i) hoverPath.attr("d", dstr[i]).style("display", null);
      hoverId = i;
      pixelTip(event, i);
      return;
    }
    hoverId = null;
    hoverPath.style("display", "none");
    const r = d3.select(event.target).datum();
    if (r && r.perimeterGeo) {
      highlight(r.id);
      tooltip.show(event.clientX, event.clientY, `${r.name} fire, ${r.place}`, [
        [fmtInt(r.acres), "acres by the end"],
        [fmtDay(new Date(r.discovered)), "first reported"],
        ...(r.id === S.fire ? [] : [["Click", "to follow this fire"]]),
      ]);
    } else {
      highlight(null);
      tooltip.hide();
    }
  });
  svg.on("pointerleave.hover", () => {
    hoverId = null;
    hoverPath.style("display", "none");
    highlight(null);
    tooltip.hide();
  });

  const zoomBy = k => svg.transition().duration(REDUCED_MOTION ? 0 : 250).call(zoom.scaleBy, k);
  d3.select("#zoom-in").on("click", () => zoomBy(1.8));
  d3.select("#zoom-out").on("click", () => zoomBy(1 / 1.8));
  d3.select("#zoom-home").on("click", () => svg.transition().duration(REDUCED_MOTION ? 0 : 600).call(zoom.transform, d3.zoomIdentity));

  return { layout, renderHour, paint, selectionChanged, fly, zoomBy };
}

/* ---------- timeline ---------- */

function createTimeline() {
  const svg = d3.select("#timeline").append("svg").attr("role", "img")
    .attr("aria-label", "Fire power by hour. Drag to move through time.");
  const margin = { top: 16, right: 10, bottom: 18, left: 10 };
  const focusH = 64;
  const clipRect = svg.append("defs").append("clipPath").attr("id", "tl-clip").append("rect");
  const plot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const nightG = plot.append("g").attr("clip-path", "url(#tl-clip)");
  const area = plot.append("path").attr("class", "tl-area").attr("clip-path", "url(#tl-clip)");
  const line = plot.append("path").attr("class", "tl-line").attr("clip-path", "url(#tl-clip)");
  const future = plot.append("rect").attr("class", "tl-future");
  const xAxisG = plot.append("g").attr("class", "axis");
  const unitLabel = plot.append("text").attr("y", -5).attr("text-anchor", "end");
  const peakLabel = plot.append("text").attr("class", "peak-label");
  const crosshair = plot.append("line").attr("class", "crosshair").style("display", "none");
  const playhead = plot.append("g").attr("class", "playhead").style("pointer-events", "none");
  playhead.append("line");
  playhead.append("path").attr("d", "M-5,-8h10v4l-5,5l-5,-5z");
  const overlay = plot.append("rect").attr("fill", "transparent").style("cursor", "ew-resize").style("touch-action", "none");
  const startsG = plot.append("g");
  let x, rows = [], innerW = 0, dragging = false;

  function draw({ animate = false } = {}) {
    const width = Math.max(260, document.getElementById("timeline").clientWidth);
    const totalH = margin.top + focusH + margin.bottom;
    svg.attr("viewBox", `0 0 ${width} ${totalH}`).attr("height", totalH);
    innerW = width - margin.left - margin.right;
    clipRect.attr("width", innerW).attr("height", focusH + 1);

    const [a, b] = win();
    rows = scopeSeries().slice(a, b);
    const days = (b - a) / 24;
    x = d3.scaleUtc().domain([hourDate(a), hourDate(b - 1)]).range([0, innerW]);
    const peak = d3.greatest(rows, d => d.filled);
    const y = d3.scaleLinear().domain([0, (peak ? peak.filled : 0) || 1]).range([focusH, 4]);

    xAxisG.attr("transform", `translate(0,${focusH})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, innerW / 110)).tickSize(3).tickSizeOuter(0)
        .tickFormat(d => (d.getUTCHours() !== 0 ? fmtHour(d) : fmtDay(d))));
    const run = selectedRun();
    unitLabel.attr("x", innerW).text(`Heat given off by ${run ? `the ${run.name} fire` : "every fire in the West"}, hour by hour`);

    nightG.selectAll("rect").data(days <= NIGHT_BAND_MAX_DAYS ? nightSpans(a, b) : []).join("rect")
      .attr("class", "tl-night")
      .attr("x", d => x(hourDate(d[0]))).attr("width", d => x(hourDate(d[1])) - x(hourDate(d[0])))
      .attr("height", focusH);

    const areaGen = d3.area().x(d => x(d.date)).y0(focusH).y1(d => y(d.filled)).curve(d3.curveMonotoneX);
    const apply = sel => (animate && !REDUCED_MOTION ? sel.transition().duration(500) : sel);
    area.datum(rows);
    line.datum(rows);
    apply(area).attr("d", areaGen);
    apply(line).attr("d", areaGen.lineY1());

    const hasPeak = peak && peak.filled > 0;
    peakLabel.style("display", hasPeak ? null : "none");
    if (hasPeak) {
      const px = x(peak.date);
      const right = px > innerW * 0.75;
      peakLabel.attr("x", px + (right ? -8 : 8)).attr("y", 12).attr("text-anchor", right ? "end" : "start")
        .text(`Peak: ${fmtPower(peak.filled)}, ${hourStamp(peak.i)}`);
    }

    // One marker per named fire at the hour it was first reported.
    const starts = (run ? [run] : runs).filter(r => discoveryHour(r) >= a && discoveryHour(r) < b);
    startsG.selectAll("circle").data(starts, r => r.id).join("circle").attr("class", "tl-start").attr("r", 4)
      .classed("on", r => r.id === S.fire)
      .attr("cx", r => x(hourDate(discoveryHour(r)))).attr("cy", focusH)
      .on("pointermove", (event, r) => tooltip.show(event.clientX, event.clientY, `${r.name} fire, ${r.place}`, [
        [fmtDay(new Date(r.discovered)), "first reported"],
        [fmtInt(r.acres), "acres by the end"],
        ...(r.id === S.fire ? [] : [["Click", "to follow this fire"]]),
      ]))
      .on("pointerleave", () => tooltip.hide())
      .on("click", (event, r) => { if (S.fire !== r.id) setFire(r.id, { fromStart: true }); });

    const hourAtPointer = event => {
      const [mx] = d3.pointer(event, overlay.node());
      return rows[d3.bisector(d => d.date).center(rows, x.invert(Math.max(0, Math.min(innerW, mx))))];
    };
    overlay.attr("y", -margin.top).attr("width", innerW).attr("height", focusH + margin.top)
      .on("pointerdown", event => {
        dragging = true;
        overlay.node().setPointerCapture(event.pointerId);
        const d = hourAtPointer(event);
        if (d) { player.stop(); setHour(d.i); }
      })
      .on("pointermove", event => {
        const d = hourAtPointer(event);
        if (!d) return;
        if (dragging) setHour(d.i);
        const px = x(d.date);
        crosshair.style("display", dragging ? "none" : null).attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", focusH);
        tooltip.show(event.clientX, event.clientY, `${hourStamp(d.i)}${isNight(d.hod) ? ", night" : ""}`, [
          [fmtPower(d.filled), "of heat", "#f0701c"],
          [fmtInt(d.n), "pixels burning"],
        ]);
      })
      .on("pointerup pointercancel", event => {
        dragging = false;
        overlay.node().releasePointerCapture(event.pointerId);
      })
      .on("pointerleave", () => {
        crosshair.style("display", "none");
        tooltip.hide();
      });

    movePlayhead();
  }

  function movePlayhead() {
    if (!x) return;
    const px = x(hourDate(S.hour));
    playhead.attr("transform", `translate(${px},0)`).select("line").attr("y1", 0).attr("y2", focusH);
    future.attr("x", px).attr("y", 0).attr("width", Math.max(0, innerW - px)).attr("height", focusH);
  }

  return { draw, movePlayhead };
}

/* ---------- playback ---------- */

function createPlayer() {
  const button = document.getElementById("play");
  let timer = null;

  function stop() {
    if (!timer) return;
    timer.stop();
    timer = null;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Play");
  }

  function play() {
    const [a, b] = win();
    if (S.hour >= b - 1) setHour(a);
    button.setAttribute("aria-pressed", "true");
    button.setAttribute("aria-label", "Pause");
    const speed = Math.max(3, (b - a) / PLAY_SECONDS); // hours per second
    let last = 0, acc = 0;
    timer = d3.timer(elapsed => {
      acc += Math.min(120, elapsed - last) / 1000 * speed;
      last = elapsed;
      if (acc < 1) return;
      const step = Math.floor(acc);
      acc -= step;
      const end = win()[1] - 1;
      if (S.hour + step >= end) {
        setHour(end);
        stop();
      } else {
        setHour(S.hour + step);
      }
    });
  }

  button.addEventListener("click", () => (timer ? stop() : play()));
  return { play, stop, toggle: () => (timer ? stop() : play()) };
}

/* ---------- text ---------- */

function updateClock() {
  const h = S.hour;
  const d = scopeSeries()[h];
  document.getElementById("clock-date").textContent = `${fmtDay(hourDate(h))} · ${fmtHour(hourDate(h))}`;
  document.getElementById("clock-sub").innerHTML = d.n
    ? `<b>${fmtInt(d.n)}</b> pixel${d.n === 1 ? "" : "s"} burning · ${d.filled >= 0.0005 ? `<b>${fmtPower(d.filled)}</b> of heat` : "too faint to measure"}`
    : `No fire seen this hour${isNight(h % 24) ? ", night" : ""}`;
}

function updateFireCard() {
  const run = selectedRun();
  document.getElementById("fire-card").hidden = !run;
  if (!run) return;
  document.getElementById("fire-name").textContent = `${run.name} fire`;
  document.getElementById("fire-facts").textContent =
    `${run.place} · ${fmtInt(run.acres)} acres by the end · first reported ${fmtDay(new Date(run.discovered))}`;
  const days = (S.hour + 1 - discoveryHour(run)) / 24;
  const p = reachAt(run, S.hour);
  document.getElementById("fire-reach").textContent = days < 0 ? "Not yet reported."
    : p ? `Day ${fmt1(days)}: the front is ${fmtInt(p[1])} km ${compass(p[2])} of where it started.`
    : `Day ${fmt1(days)}: the satellite has not picked it up yet.`;
}

/* ---------- state changes ---------- */

function renderHourAll() {
  map.renderHour();
  timeline.movePlayhead();
  updateClock();
  updateFireCard();
  writeHash();
}

function setHour(h) {
  h = clampHour(Math.round(h));
  if (h === S.hour) return;
  S.hour = h;
  renderHourAll();
}

function setFire(id, { fromStart = false } = {}) {
  player.stop();
  S.fire = id;
  const [a, b] = win();
  const inside = S.hour >= a && S.hour < b;
  // Follow a fire from its first hour, unless the map is already inside its life.
  S.hour = id && (fromStart || !inside) ? firstBurnHour() : clampHour(S.hour);
  map.paint();
  map.selectionChanged();
  map.fly();
  drawLegend();
  timeline.draw({ animate: true });
  renderHourAll();
}

function firstBurnHour() {
  const [a] = win();
  const d = scopeSeries().slice(a).find(r => r.n > 0);
  return d ? d.i : a;
}

function setView(view) {
  S.view = view;
  d3.selectAll("#view-toggle button").attr("aria-checked", function () { return String(this.dataset.view === view); });
  map.paint();
  drawLegend();
  map.renderHour();
  writeHash();
}

/* ---------- URL hash ---------- */

let hashTimer = null;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (S.fire) p.set("f", S.fire);
    p.set("h", S.hour);
    if (S.view !== "power") p.set("v", S.view);
    history.replaceState(null, "", `#${p}`);
  }, 250);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("f") && runById(p.get("f"))) S.fire = p.get("f");
  if (p.get("v") === "arrival") S.view = "arrival";
  const h = Number(p.get("h"));
  if (p.has("h") && Number.isInteger(h) && h >= 0 && h < totalHours) S.hour = h;
}

/* ---------- controls ---------- */

function bindControls() {
  d3.selectAll("#view-toggle button").on("click", e => setView(e.currentTarget.dataset.view));
  d3.select("#scope-clear").on("click", () => setFire(null));

  document.addEventListener("keydown", event => {
    const tag = event.target.tagName;
    if (event.metaKey || event.ctrlKey || event.altKey || tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
    const step = event.shiftKey ? 24 : 1;
    if (event.key === " " && tag !== "BUTTON") { event.preventDefault(); player.toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); player.stop(); setHour(S.hour + step); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); player.stop(); setHour(S.hour - step); }
    else if (event.key === "Escape" && S.fire) setFire(null);
    else if (event.key === "+" || event.key === "=") map.zoomBy(1.8);
    else if (event.key === "-") map.zoomBy(1 / 1.8);
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      map.layout();
      timeline.draw();
    }, 150);
  });
}

function writeNotes() {
  const fmtLong = d3.utcFormat("%B %-d");
  document.getElementById("period").textContent = `${fmtLong(new Date(meta.start))} to ${fmtLong(new Date(meta.end))}, ${meta.end.slice(0, 4)}`;
  document.getElementById("method-note").innerHTML =
    `Data: NOAA ${meta.satellite} ${meta.product} fire detections, one scan every 5 minutes, ${meta.start} to ${meta.end}, inside the lit part of the map. ` +
    `${fmtInt(meta.scans)} scans gave ${fmtInt(meta.rawPixels)} fire pixels; ${fmtInt(meta.keptPixels)} remain after dropping pixels not seen again within two hours, which are mostly false alarms. ` +
    `Scans are averaged into hours of local solar time (UTC + longitude / 15), about 1 h 20 min behind PDT at 120°W. ` +
    `"Heat" is fire radiative power. ${fmtPct(meta.noFrpShare)} of fire pixels have no power value, mostly because of a daytime cloud flag; the timeline gives each of those the mean power of measured pixels in the same half-degree cell and hour, and map colour only ever shows measured power. ` +
    `At the regional scale pixels are drawn larger than life so they stay visible; zoom in for true footprints. ` +
    `Fire names, origins and final outlines are NIFC perimeters for the nine largest fires with a single origin; distance from origin counts a pixel once it lies within 6 km of the fire's connected footprint. ` +
    `Smoke and cloud hide fire from the satellite, so a quiet hour is not always a calm one. ` +
    `Basemap: NASA Blue Marble shaded relief, via GIBS. ` +
    `<a href="explore.html">See the six exploratory graphs that led to this design.</a>`;
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
  indexPixels();
  // Open on the worst hour of the summer.
  S.hour = d3.greatest(seriesById.get("all").hours, d => d.filled).i;
  readHash();
  S.hour = clampHour(S.hour);

  writeNotes();
  map = createMap();
  timeline = createTimeline();
  player = createPlayer();
  bindControls();
  d3.selectAll("#view-toggle button").attr("aria-checked", function () { return String(this.dataset.view === S.view); });

  drawLegend();
  map.layout();
  timeline.draw();
  updateClock();
  updateFireCard();
}

init();
