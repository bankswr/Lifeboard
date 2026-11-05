import { describe, expect, it } from "vitest";
import { axisReadings, matchAxes, type MatchedAxis } from "../src/app/ui/matchedAxes.ts";

const MAX_TICKS = 12;
const span = ({ range }: MatchedAxis) => range[1] - range[0];
/** Each tick's height on the axis, 0 at the bottom and 1 at the top. */
const heights = (axis: MatchedAxis) => axis.ticks.map((tick) => (tick - axis.range[0]) / span(axis));

function expectAligned(a: MatchedAxis, b: MatchedAxis) {
  expect(a.ticks.length).toBeGreaterThan(1);
  expect(a.ticks.length).toBe(b.ticks.length);
  heights(a).forEach((height, i) => expect(height).toBeCloseTo(heights(b)[i], 9));
}

describe("matchAxes", () => {
  it("gives both axes the wider span and lines up their ticks", () => {
    const { left, right } = matchAxes({ low: 130.3, high: 134.3, latest: 134 }, { low: 30.1, high: 31.9, latest: 31 }, MAX_TICKS);
    expect(left.range).toEqual([130.3, 134.3]);
    expect(span(right)).toBeCloseTo(4, 9);
    expectAligned(left, right);
  });

  it("stays within half a tick of centered on the latest reading when the data allows", () => {
    const { left, right } = matchAxes({ low: 130.3, high: 134.3, latest: 134 }, { low: 30.1, high: 31.9, latest: 31 }, MAX_TICKS);
    const step = left.ticks[1] - left.ticks[0];
    expect(Math.abs((right.range[0] + right.range[1]) / 2 - 31)).toBeLessThanOrEqual(step / 2 + 1e-9);
  });

  it("moves off center rather than lose a point", () => {
    const { left, right } = matchAxes({ low: 130, high: 134, latest: 134 }, { low: 30, high: 32.5, latest: 30 }, MAX_TICKS);
    expect(right.range[0]).toBeLessThanOrEqual(30);
    expect(right.range[1]).toBeGreaterThanOrEqual(32.5);
    expect(span(right)).toBeCloseTo(span(left), 9);
    expectAligned(left, right);
  });

  it("lets the right axis set the scale when it is wider", () => {
    const { left, right } = matchAxes({ low: 130, high: 131, latest: 130.5 }, { low: 25.2, high: 31.2, latest: 26 }, MAX_TICKS);
    expect(right.range).toEqual([25.2, 31.2]);
    expect(span(left)).toBeCloseTo(6, 9);
    expectAligned(left, right);
  });

  it("grows both axes when spans nearly match and no aligned window fits", () => {
    const { left, right } = matchAxes({ low: 130.05, high: 134.05, latest: 134 }, { low: 30.3, high: 34.29, latest: 34 }, MAX_TICKS);
    expect(left.range[0]).toBe(130.05);
    expect(right.range[0]).toBeLessThanOrEqual(30.3);
    expect(right.range[1]).toBeGreaterThanOrEqual(34.29);
    expect(span(left)).toBeCloseTo(span(right), 9);
    expect(span(left)).toBeGreaterThan(4);
    expectAligned(left, right);
  });

  it("draws two flat lines on a usable axis", () => {
    const { left, right } = matchAxes({ low: 130, high: 130, latest: 130 }, { low: 30, high: 30, latest: 30 }, MAX_TICKS);
    expect(span(left)).toBe(2);
    expect(span(right)).toBe(2);
    expectAligned(left, right);
  });
});

describe("axisReadings", () => {
  it("takes the extremes from every series and the latest from the first", () => {
    expect(axisReadings([[31, 30.5, null], [null, 30, 29]])).toEqual({ low: 29, high: 31, latest: 30.5 });
  });

  it("is null with nothing to plot", () => {
    expect(axisReadings([[null, null]])).toBeNull();
  });
});
