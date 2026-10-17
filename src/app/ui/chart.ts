// Small time series charts with uPlot (the library the plan names for graphs, docs/PLAN.md).
// A template places `chartSlot(id)`; the view's `mount` calls `mountCharts` with each slot's
// data, which draws the charts and keeps them sized to their slot. Used by the Pets page (a
// cat's weight and visits) and the Health page (several series per chart, one range shown
// across all charts, and a cursor that moves across them together). Hovering shows the day
// and each series' value in the legend under the plot.
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
}

export interface ChartSpec {
  /** Local dates, "YYYY-MM-DD", oldest first. */
  dates: string[];
  series: SeriesSpec[];
  /** Digits after the decimal point in the hover readout and the y axis. */
  decimals: number;
  /**
   * "zero": from zero (counts, bars); "span": at least `minSpan` around the data (a weight that
   * moves by tenths); "symmetric": centered on zero (deltas).
   */
  yRange: "zero" | "span" | "symmetric";
  minSpan?: number;
  /** Small whole-number counts (visits): ticks at whole steps only, so no two read the same. */
  counts?: boolean;
  /** Show only the last this many dates; the rest stay loaded. */
  visibleDays?: number;
  /** Charts with the same key share their cursor. */
  syncKey?: string;
}

const HEIGHT = 160;
const HALF_DAY_S = 43_200;
/** Card background (--surface), for hollow dots. */
const SURFACE = "#1e293b";

export function chartSlot(id: string) {
  return html`<div class="chart" data-chart=${id}></div>`;
}

/** Draws each spec into its slot; charts are removed when `signal` aborts (the next render). */
export function mountCharts(specs: Record<string, ChartSpec>, signal: AbortSignal) {
  const charts: [uPlot, HTMLElement][] = [];
  for (const slot of document.querySelectorAll<HTMLElement>("[data-chart]")) {
    const spec = specs[slot.dataset.chart!];
    if (spec) charts.push([new uPlot(options(spec, slot.clientWidth), data(spec), slot), slot]);
  }
  const resize = () => charts.forEach(([chart, slot]) => chart.setSize({ width: slot.clientWidth, height: HEIGHT }));
  window.addEventListener("resize", resize, { signal });
  signal.addEventListener("abort", () => charts.forEach(([chart]) => chart.destroy()));
}

/** uPlot's x values are seconds; each date sits at its local midnight. */
function data(spec: ChartSpec): uPlot.AlignedData {
  const seconds = spec.dates.map((date) => new Date(`${date}T00:00:00`).getTime() / 1000);
  return [seconds, ...spec.series.map((series) => series.values)];
}

function options(spec: ChartSpec, width: number): uPlot.Options {
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, font: "11px system-ui" };
  return {
    width,
    height: HEIGHT,
    legend: { show: true, live: true },
    cursor: { y: false, points: { size: 8 }, ...(spec.syncKey ? { sync: { key: spec.syncKey } } : {}) },
    scales: { x: { time: true, range: xRange(spec.visibleDays) }, y: { range: yRange(spec) } },
    axes: [
      { ...axis, values: (_u, ticks) => ticks.map((t) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" })) },
      {
        ...axis,
        size: 48,
        space: 22, // the plots are short; uPlot's default (30 px) leaves some with a single tick
        ...(spec.counts ? { incrs: [1, 2, 5, 10, 20, 50, 100] } : {}),
        // uPlot's own labels: as many decimals as the tick step needs (9.25, not a rounded 9.3).
      },
    ],
    series: [
      { label: "Day", value: (_u, t) => (t == null ? "" : new Date(t * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) },
      ...spec.series.map((series) => seriesOptions(series, spec.decimals)),
    ],
  };
}

function seriesOptions(series: SeriesSpec, decimals: number): uPlot.Series {
  const base: uPlot.Series = {
    label: series.label,
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

/** The last `visibleDays` dates (all when unset), with half a day of room at each end for bars. */
function xRange(visibleDays: number | undefined): uPlot.Range.Function {
  return (_u, min, max) => [visibleDays ? Math.max(min, max - (visibleDays - 1) * 86_400) - HALF_DAY_S : min - HALF_DAY_S, max + HALF_DAY_S];
}

function yRange(spec: ChartSpec): uPlot.Range.Function {
  return (_u, min, max) => {
    if (min == null || max == null) return [0, 1];
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
