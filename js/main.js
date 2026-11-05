/* Wildfire across the West: three linked D3 graphs driven by one shared state.
   state.fire    which series graphs 4 and 5 show, and which line graph 6 highlights
   state.window  [startHour, endHour) zoom range set by the brush in graph 4
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
const state = { fire: "all", window: null, mode: "filled", spreadDays: SPREAD_DEFAULT_DAYS };
let meta, series, runs, seriesById, totalHours;
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

    const nights = [];
    if (days <= NIGHT_BAND_MAX_DAYS) {
      const firstDay = Math.floor(a / 24);
      for (let day = firstDay - 1; day <= Math.ceil(b / 24); day++) {
        nights.push([day * 24 + NIGHT_START, (day + 1) * 24 + NIGHT_END]);
      }
    }
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
  redrawAll({ animate: true });
}

function setWindow(win, { fromBrush = false } = {}) {
  const same = (win && state.window && win[0] === state.window[0] && win[1] === state.window[1]) || (!win && !state.window);
  if (same) return;
  state.window = win;
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
    return { ...r, lastHour: last[0], farthest: last[1], fastest: fastestRun(r.pts) };
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
  let raw;
  try {
    raw = await d3.json("data/fires.json");
  } catch (err) {
    const p = document.createElement("p");
    p.className = "load-error";
    p.textContent = "Could not load data/fires.json. Open this page through a local server, not as a file.";
    document.querySelector("main").prepend(p);
    return;
  }
  prepareData(raw);
  writeNotes();

  const intensity = createIntensityChart();
  const hours = createHoursChart();
  const spread = createSpreadChart();
  buildFireTable(spread);
  bindControls(intensity);
  redraws.push(intensity.draw, hours.draw, spread.draw);
  redrawAll({});
}

init();
