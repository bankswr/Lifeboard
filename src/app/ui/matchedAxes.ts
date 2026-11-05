// The ranges and ticks for a chart whose two y axes share one scale (user, 2026-11-05): the same
// span on both, so a unit is the same height on each side, and ticks at the same heights, so the
// right axis's ticks sit on the left axis's grid lines. Apart from the data, nothing here
// depends on the chart, so it is tested on its own (uPlot itself needs a browser).

export interface AxisReadings {
  low: number;
  high: number;
  /** The value the axis should center on when it is the narrower one. */
  latest: number;
}

export interface MatchedAxis {
  range: [number, number];
  ticks: number[];
}

export interface MatchedAxes {
  left: MatchedAxis;
  right: MatchedAxis;
}

/** Tick steps within each power of ten, as in uPlot's own (which it doesn't export). */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

/** The smallest round step at least `minimum`. */
function roundStep(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(minimum));
  return power * STEP_MULTIPLES.find((multiple) => power * multiple >= minimum)!;
}

/** Clears floating point noise from a tick (31.000000000000004) so its label reads cleanly. */
const cleanTick = (value: number) => Number(value.toFixed(10));

/**
 * A measure's lowest, highest and latest value; `series` is what an axis plots, its main
 * measure first (that series supplies the latest value). Null with nothing to plot.
 */
export function axisReadings(series: (number | null)[][]): AxisReadings | null {
  const values = series.flat().filter((value) => value !== null);
  if (values.length === 0) return null;
  const main = series[0].filter((value) => value !== null);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return { low, high, latest: main.at(-1) ?? (low + high) / 2 };
}

/**
 * Where the narrower axis's window starts: as near centered on its latest value as ticks allow,
 * but keeping every value on the axis. It moves by whole steps from `widerLow`, which is what
 * puts its ticks at the wider axis's heights. Returns the start that keeps the lowest value when
 * no window of this span fits; the caller then grows the span to fit the highest.
 */
function narrowerStart(narrower: AxisReadings, widerLow: number, span: number, step: number): number {
  const stepsFromWider = (value: number) => (value - widerLow) / step;
  const centered = Math.round(stepsFromWider(narrower.latest - span / 2));
  const lowestAllowed = Math.ceil(stepsFromWider(narrower.high - span));
  const highestAllowed = Math.floor(stepsFromWider(narrower.low));
  return widerLow + step * Math.min(highestAllowed, Math.max(lowestAllowed, centered));
}

/**
 * Two axes with one span, set by the wider measure, which runs from its lowest value. `maxTicks`
 * is how many ticks fit the plot's height.
 */
export function matchAxes(left: AxisReadings, right: AxisReadings, maxTicks: number): MatchedAxes {
  const leftIsWider = left.high - left.low >= right.high - right.low;
  const [wider, narrower] = leftIsWider ? [left, right] : [right, left];
  const dataSpan = wider.high - wider.low;
  // Two flat lines still need an axis to be drawn on.
  const span = dataSpan > 0 ? dataSpan : 2;
  const widerLow = dataSpan > 0 ? wider.low : wider.low - 1;
  const step = roundStep(span / maxTicks);
  const narrowerLow = narrowerStart(narrower, widerLow, span, step);
  // Within one tick of the wider span there may be no aligned window that fits, so both grow.
  const finalSpan = Math.max(span, narrower.high - narrowerLow);

  const firstTick = Math.ceil(widerLow / step) * step;
  const widerTicks: number[] = [];
  for (let tick = 0; firstTick + tick * step <= widerLow + finalSpan; tick++) widerTicks.push(firstTick + tick * step);

  const axis = (low: number): MatchedAxis => ({
    range: [low, low + finalSpan],
    ticks: widerTicks.map((tick) => cleanTick(tick + low - widerLow)),
  });
  return leftIsWider
    ? { left: axis(widerLow), right: axis(narrowerLow) }
    : { left: axis(narrowerLow), right: axis(widerLow) };
}
