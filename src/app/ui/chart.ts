// Small time series charts with uPlot (the library the plan names for graphs, docs/PLAN.md).
// A template places `chartSlot(id)`; the view's `mount` calls `mountCharts` with each slot's
// data, which draws the charts and keeps them sized to their slot. One series per chart:
// a cat's weight, a cat's visits. Hovering shows the day and value in the legend line.
import { html } from "lit-html";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface ChartSpec {
  /** Local dates, "YYYY-MM-DD", oldest first. */
  dates: string[];
  /** One value per date; null leaves a gap. */
  values: (number | null)[];
  label: string;
  color: string;
  kind: "line" | "bars";
  /** Digits after the decimal point in the hover readout. */
  decimals: number;
}

const HEIGHT = 140;

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

/** Half a day of room at each end, so the first and last bars aren't cut in half. */
const dayRange: uPlot.Range.Function = (_u, min, max) => [min - 43_200, max + 43_200];

/** Bars start at zero. */
const barRange: uPlot.Range.Function = (_u, _min, max) => [0, Math.max(1, Math.ceil(max))];

/** At least a 1-unit span around a line (a cat's weight moves by tenths of a pound). */
const lineRange: uPlot.Range.Function = (_u, min, max) => {
  if (min == null || max == null) return [0, 1];
  const middle = (min + max) / 2;
  const half = Math.max(0.5, (max - min) / 2 * 1.2);
  return [middle - half, middle + half];
};

/** uPlot's x values are seconds; each date sits at its local midnight. */
function data(spec: ChartSpec): uPlot.AlignedData {
  const seconds = spec.dates.map((date) => new Date(`${date}T00:00:00`).getTime() / 1000);
  return [seconds, spec.values];
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
    cursor: { y: false, points: { size: 8 } },
    scales: { x: { time: true, range: dayRange }, y: { range: spec.kind === "bars" ? barRange : lineRange } },
    axes: [
      { ...axis, values: (_u, ticks) => ticks.map((t) => new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" })) },
      {
        ...axis,
        size: 44,
        // Counts get whole-number steps only, so no two ticks read the same.
        ...(spec.kind === "bars" ? { incrs: [1, 2, 5, 10, 20, 50] } : {}),
        values: (_u, ticks) => ticks.map((t) => t.toFixed(spec.kind === "bars" ? 0 : 1)),
      },
    ],
    series: [
      { label: "Day", value: (_u, t) => (t == null ? "" : new Date(t * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })) },
      {
        label: spec.label,
        stroke: spec.color,
        width: 2,
        value: (_u, v) => (v == null ? "–" : v.toFixed(spec.decimals)),
        ...(spec.kind === "bars"
          ? { fill: spec.color, paths: uPlot.paths.bars!({ size: [0.6, 16], radius: 0.25 }), points: { show: false } }
          : { points: { show: true, size: 5, fill: spec.color }, spanGaps: true }),
      },
    ],
  };
}
