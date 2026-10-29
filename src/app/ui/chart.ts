// Small time series charts with uPlot (the library the plan names for graphs, docs/PLAN.md).
// Most are by date; a chart with `timeOfDay` is spread over one day instead (a histogram).
// A template places `chartSlot(id)`; the view's `mount` calls `mountCharts` with each slot's
// data, which draws the charts and keeps them sized to their slot. Used by the Pets page (a
// cat's weight and visits) and the Health page (several series per chart, a second y axis on
// the right for two measures with different units, one range shown across all charts).
// Hovering shows the day and each series' value in the legend under the plot; otherwise the
// legend shows the latest day with a real value. On a touch screen, touching or dragging
// across a plot does what hovering does. When a category (`SeriesSpec.group`)
// has more than one series, each category gets its own legend line, entries aligned in columns.
import { html } from "lit-html";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface SeriesSpec {
  label: string;
  /** One value per date; null leaves a gap. */
  values: (number | null)[];
  color: string;
  /** "points": dots only (raw readings); "bars": from zero. */
  kind: "line" | "bars" | "points";
  /** A dashed line, for targets. */
  dashed?: boolean;
  /** Join the line across missing days (default true). */
  spanGaps?: boolean;
  /** Dot size for points and lines, px. */
  pointSize?: number;
  /** Dots drawn as rings (for readings left out). */
  hollow?: boolean;
  /** Plot against the right-hand y axis (default left). */
  axis?: "left" | "right";
  /**
   * The label of a line in the same chart: a faint line joins each of this series' points to
   * that line's value on the same day, to show how far readings stray from it.
   */
  deviationTo?: string;
  /**
   * The legend category (default: the label, a category of its own). When any category has
   * more than one series, each starts a new legend line.
   */
  group?: string;
}

export interface ChartSpec {
  /** Local dates, "YYYY-MM-DD", oldest first. */
  dates: string[];
  series: SeriesSpec[];
  /** Digits after the decimal point in the hover readout and the y axis. */
  decimals: number;
  /** The same for the right-hand axis's series (default `decimals`). */
  rightDecimals?: number;
  /**
   * "zero": from zero (counts, bars); "span": at least `minSpan` around the data (a weight that
   * moves by tenths); "symmetric": centered on zero (deltas); "data": exactly the lowest and
   * highest shown values. Applies to both axes.
   */
  yRange: "zero" | "span" | "symmetric" | "data";
  minSpan?: number;
  /** Small whole-number counts (visits): ticks at whole steps only, so no two read the same. */
  counts?: boolean;
  /** Show only the last this many dates; the rest stay loaded. */
  visibleDays?: number;
  /** Charts with the same key share their cursor. */
  syncKey?: string;
  /** Unit labels beside the y axes, for charts with two. */
  leftLabel?: string;
  rightLabel?: string;
  /** Plot height, px (default 160). */
  height?: number;
  /**
   * Plot across one day instead of by date (`dates` is then ignored): each value's x is the
   * middle of its bin, in hours after midnight, and `binHours` is each bin's width.
   */
  timeOfDay?: { hours: number[]; binHours: number };
}


const HEIGHT = 160;
/** Opacity of the lines from readings to the line they stray from (user, 2026-10-20). */
const DEVIATION_ALPHA = 0.5;
const HALF_DAY_S = 43_200;
/** Card background (--surface), for hollow dots. */
const SURFACE = "#1e293b";

/** The time ranges a page's charts can show, in days (Health and Pets). */
export const RANGES = [[14, "2 weeks"], [28, "4 weeks"], [90, "90 days"]] as const;

/** A compact switch between RANGES; `name` keeps each page's radio group separate. */
export function rangePicker(name: string, days: number, onChange: (days: number) => void) {
  return html`
    <div class="segmented small-segmented" role="radiogroup" aria-label="Range">
      ${RANGES.map(([value, label]) => html`
        <label><input type="radio" name=${name} .checked=${days === value} @change=${() => onChange(value)}> ${label}</label>`)}
    </div>
  `;
}

export function chartSlot(id: string) {
  return html`<div class="chart" data-chart=${id}></div>`;
}

/** Draws each spec into its slot; charts are removed when `signal` aborts (the next render). */
export function mountCharts(specs: Record<string, ChartSpec>, signal: AbortSignal) {
  const charts: [uPlot, HTMLElement][] = [];
  for (const slot of document.querySelectorAll<HTMLElement>("[data-chart]")) {
    const spec = specs[slot.dataset.chart!];
    if (!spec) continue;
    const chart = new uPlot(options(spec, slot.clientWidth), data(spec), slot);
    if (hasGroups(spec)) groupLegend(chart, spec);
    followTouch(chart, signal);
    charts.push([chart, slot]);
  }
  const resize = () => charts.forEach(([chart, slot]) => chart.setSize({ width: slot.clientWidth, height: chart.height }));
  window.addEventListener("resize", resize, { signal });
  signal.addEventListener("abort", () => charts.forEach(([chart]) => chart.destroy()));
}

/**
 * uPlot's cursor follows only the mouse, and the Android WebView sends none while a finger
 * moves, so a touch moves the cursor itself. Vertical drags still scroll the page (style.css).
 */
function followTouch(chart: uPlot, signal: AbortSignal) {
  // uPlot's typings leave out setCursor's third argument, which passes the cursor to synced charts.
  const setCursor = chart.setCursor as (opts: { left: number; top: number }, fireHook?: boolean, publish?: boolean) => void;
  const move = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    const plot = chart.over.getBoundingClientRect();
    setCursor({ left: touch.clientX - plot.left, top: touch.clientY - plot.top }, true, true);
  };
  chart.over.addEventListener("touchstart", move, { passive: true, signal });
  chart.over.addEventListener("touchmove", move, { passive: true, signal });
}

/** uPlot's x values are seconds; each date sits at its local midnight. */
function data(spec: ChartSpec): uPlot.AlignedData {
  if (spec.timeOfDay) return [spec.timeOfDay.hours, ...spec.series.map((series) => series.values)];
  const seconds = spec.dates.map((date) => new Date(`${date}T00:00:00`).getTime() / 1000);
  return [seconds, ...spec.series.map((series) => series.values)];
}

const hasRightAxis = (spec: ChartSpec) => spec.series.some((series) => series.axis === "right");

function options(spec: ChartSpec, width: number): uPlot.Options {
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: "11px system-ui" };
  const yAxis = {
    ...axis,
    size: 48,
    space: 22, // the plots are short; uPlot's default (30 px) leaves some with a single tick
    ...(spec.counts ? { incrs: [1, 2, 5, 10, 20, 50, 100] } : {}),
    // uPlot's own labels: as many decimals as the tick step needs (9.25, not a rounded 9.3).
  };
  const right = hasRightAxis(spec);
  return {
    width,
    height: spec.height ?? HEIGHT,
    legend: { show: true, live: true },
    hooks: {
      // Drawn with the axes, so the deviation lines sit under the series.
      drawAxes: [(u) => drawDeviations(u, spec)],
      setLegend: [(u) => showDefaultDay(u, spec)],
    },
    cursor: { y: false, points: { size: 8 }, ...(spec.syncKey ? { sync: { key: spec.syncKey } } : {}) },
    scales: {
      x: spec.timeOfDay ? { time: false, range: [0, 24] } : { time: true, range: xRange(spec.visibleDays) },
      y: { range: yRange(spec) },
      ...(right ? { y2: { range: yRange(spec) } } : {}),
    },
    axes: [
      spec.timeOfDay
        ? { ...axis, incrs: [1, 2, 3, 6, 12], values: (_u, ticks) => ticks.map(clockTime) }
        : { ...axis, values: (_u, ticks) => ticks.map((t) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" })) },
      { ...yAxis, ...(spec.leftLabel ? { label: spec.leftLabel, labelSize: 16 } : {}) },
      // The right axis draws no grid of its own: two sets of grid lines would not line up.
      ...(right ? [{ ...yAxis, scale: "y2", side: 1, grid: { show: false }, ...(spec.rightLabel ? { label: spec.rightLabel, labelSize: 16 } : {}) }] : []),
    ],
    series: [
      spec.timeOfDay ? binSeries(spec.timeOfDay.binHours) : { label: "Day", value: (_u, t) => (t == null ? "" : new Date(t * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) },
      ...spec.series.map((series) => seriesOptions(series, series.axis === "right" ? spec.rightDecimals ?? spec.decimals : spec.decimals)),
    ],
  };
}

/** The x series of a time-of-day chart: the hovered bin's span, "9:00 – 9:30 AM". */
function binSeries(binHours: number): uPlot.Series {
  return { label: "Time", value: (_u, middle) => (middle == null ? "" : `${clockTime(middle - binHours / 2)} – ${clockTime(middle + binHours / 2)}`) };
}

/** Hours after midnight as a clock time: 6 → "6 AM", 9.5 → "9:30 AM". */
function clockTime(hours: number): string {
  const time = new Date(2000, 0, 1, 0, Math.round(hours * 60));
  return time.toLocaleTimeString([], { hour: "numeric", ...(time.getMinutes() ? { minute: "2-digit" } : {}) });
}

function seriesOptions(series: SeriesSpec, decimals: number): uPlot.Series {
  const base: uPlot.Series = {
    label: series.label,
    scale: series.axis === "right" ? "y2" : "y",
    stroke: series.color,
    width: 2,
    value: (_u, v) => (v == null ? "–" : v.toLocaleString([], { minimumFractionDigits: decimals, maximumFractionDigits: decimals })),
  };
  const dot = { size: series.pointSize ?? 5, fill: series.hollow ? SURFACE : series.color, stroke: series.color, width: series.hollow ? 2 : 1 };
  if (series.kind === "bars") {
    return { ...base, fill: series.color, fillTo: 0, paths: uPlot.paths.bars!({ size: [0.6, 16], radius: 0.25 }), points: { show: false } };
  }
  if (series.kind === "points") return { ...base, paths: () => null, points: { show: true, ...dot } };
  const showDots = !series.dashed && series.pointSize !== 0;
  return { ...base, dash: series.dashed ? [6, 4] : undefined, spanGaps: series.spanGaps ?? true, points: { show: showDots, ...dot } };
}

/**
 * With no day hovered, the legend shows the latest real value (user, 2026-10-26): the last day
 * with a reading (the first "points" series), else the last day of the first series, the
 * chart's main measure. Trends projected past it and averages carried past it don't count.
 */
function showDefaultDay(u: uPlot, spec: ChartSpec) {
  // A time-of-day chart has no latest bin: its legend waits for a hover.
  if (u.cursor.idx != null || spec.timeOfDay) return;
  const main = spec.series.find((series) => series.kind === "points") ?? spec.series[0];
  const values = main?.values ?? [];
  let last = values.length - 1;
  while (last >= 0 && values[last] === null) last--;
  if (last >= 0) u.setLegend({ idx: last }, false); // false: no hook, so no loop
}

const groupOf = (series: SeriesSpec) => series.group ?? series.label;

/** Whether any legend category has more than one series. */
function hasGroups(spec: ChartSpec): boolean {
  const groups = spec.series.map(groupOf);
  return new Set(groups).size < groups.length;
}

/**
 * One legend line per category: the legend becomes a grid (style.css) and each category's
 * first entry is put in its first column, which starts a new row. The columns are the same
 * for every category, so matching entries line up, also when a category wraps.
 */
function groupLegend(chart: uPlot, spec: ChartSpec) {
  const legend = chart.root.querySelector(".u-legend");
  if (!legend) return;
  legend.classList.add("grouped");
  // Row 0 is the day; series rows follow in spec order.
  const rows = legend.querySelectorAll<HTMLElement>("tr.u-series");
  rows[0]?.classList.add("legend-day");
  spec.series.forEach((series, i) => {
    if (i === 0 || groupOf(series) !== groupOf(spec.series[i - 1])) rows[i + 1]?.classList.add("legend-group-start");
  });
}

/** For each series with `deviationTo`, a vertical line from each point to that line. */
function drawDeviations(u: uPlot, spec: ChartSpec) {
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.globalAlpha = DEVIATION_ALPHA;
  ctx.lineWidth = devicePixelRatio;
  for (const series of spec.series) {
    const line = spec.series.find((other) => other.label === series.deviationTo);
    if (!line) continue;
    const scale = series.axis === "right" ? "y2" : "y";
    ctx.strokeStyle = series.color;
    ctx.beginPath();
    series.values.forEach((value, i) => {
      const lineValue = line.values[i];
      if (value === null || lineValue === null) return;
      const x = u.valToPos(u.data[0][i], "x", true);
      ctx.moveTo(x, u.valToPos(value, scale, true));
      ctx.lineTo(x, u.valToPos(lineValue, scale, true));
    });
    ctx.stroke();
  }
  ctx.restore();
}

/** The last `visibleDays` dates (all when unset), with half a day of room at each end for bars. */
function xRange(visibleDays: number | undefined): uPlot.Range.Function {
  return (_u, min, max) => [visibleDays ? Math.max(min, max - (visibleDays - 1) * 86_400) - HALF_DAY_S : min - HALF_DAY_S, max + HALF_DAY_S];
}

function yRange(spec: ChartSpec): uPlot.Range.Function {
  return (_u, min, max) => {
    if (min == null || max == null) return [0, 1];
    if (spec.yRange === "data") return min === max ? [min - 1, max + 1] : [min, max];
    if (spec.yRange === "zero") return [0, Math.max(1, Math.ceil(max * 1.05))];
    if (spec.yRange === "symmetric") {
      const reach = Math.max(1, Math.abs(min), Math.abs(max)) * 1.1;
      return [-reach, reach];
    }
    const middle = (min + max) / 2;
    const half = Math.max((spec.minSpan ?? 1) / 2, ((max - min) / 2) * 1.15);
    return [middle - half, middle + half];
  };
}
