import { describe, expect, it } from "vitest";
import { addDays } from "../src/core/dates.ts";
import { computeTargets, datesBetween, fillMissingSteps, stepEnergy, type EnergyDay } from "../src/core/energy.ts";
import { DEFAULT_HEALTH_SETTINGS } from "../src/core/healthTargets.ts";
import { DEFAULT_WORKOUT_SETTINGS, detectWorkouts, workoutEnergy, type HeartRateSample } from "../src/core/workouts.ts";
import type { StepPoint } from "../src/core/steps.ts";

const DAY = "2026-10-14";
const T0 = Date.parse("2026-10-14T11:00:00Z");
const MIN = 60_000;
const RING = "com.gdjztech.ringconn";
const TREADMILL = "com.urevo.app";

/** 10-minute samples starting at T0 with these bpm values (resting 70). */
const samples = (...bpm: number[]): HeartRateSample[] => bpm.map((value, i) => ({ day: DAY, time: T0 + i * 10 * MIN, bpm: value }));
const resting = new Map([[DAY, 70]]);
const steps = (minutesFromT0: number, length: number, count: number, source = RING): StepPoint =>
  ({ day: DAY, start: T0 + minutesFromT0 * MIN, end: T0 + (minutesFromT0 + length) * MIN, count, source });

describe("workout detection", () => {
  it("finds a run at rest + 30 for 30+ minutes, allowing one lower sample inside", () => {
    const found = detectWorkouts(samples(75, 105, 110, 90, 115, 108, 72, 74), resting, [steps(0, 80, 900)], DEFAULT_WORKOUT_SETTINGS);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ date: DAY, minutes: 50, start: new Date(T0 + 10 * MIN).toISOString() });
    expect(found[0].aboveRest).toBeCloseTo((35 + 40 + 20 + 45 + 38) / 5);
    expect(found[0].steps).toBe(Math.round((900 * 50) / 80));
  });

  it("ignores short runs, walks (fast stepping) and treadmill time", () => {
    expect(detectWorkouts(samples(110, 110), resting, [], DEFAULT_WORKOUT_SETTINGS)).toEqual([]); // 20 minutes
    const hard = samples(110, 110, 110, 110);
    expect(detectWorkouts(hard, resting, [steps(0, 40, 2400)], DEFAULT_WORKOUT_SETTINGS)).toEqual([]); // 3,600 steps/h
    expect(detectWorkouts(hard, resting, [steps(0, 40, 600), steps(5, 20, 1500, TREADMILL)], DEFAULT_WORKOUT_SETTINGS)).toEqual([]);
    expect(detectWorkouts(samples(110, 80, 80, 110, 110), resting, [], DEFAULT_WORKOUT_SETTINGS)).toEqual([]); // two lows split it
  });

  it("sizes a workout from METs, minus the steps already counted", () => {
    const workout = { date: DAY, start: "", end: "", minutes: 60, aboveRest: 40, steps: 1100 };
    const kg = 220 / 2.20462262185;
    expect(workoutEnergy(workout, 220, { workoutMets: 3.5 })).toBeCloseTo(2.5 * kg - stepEnergy(1100, 220));
  });
});

describe("days without steps", () => {
  const day = (date: string, steps: number | null): EnergyDay => ({ date, calories: 2000, steps, weightLbs: 200, bodyFatPercent: 20 });

  it("get the median of the previous 14 days' measured steps, marked estimated", () => {
    const days = [day("2026-10-01", 8000), day("2026-10-02", 10000), day("2026-10-03", 12000), day("2026-10-04", null), day("2026-10-05", null)];
    const filled = fillMissingSteps(days);
    expect(filled[3]).toMatchObject({ steps: 10000, stepsEstimated: true });
    expect(filled[4]).toMatchObject({ steps: 10000, stepsEstimated: true }); // estimates don't feed later estimates
    expect(fillMissingSteps([day("2026-10-01", 8000), day("2026-10-02", null)])[1].steps).toBeNull(); // too few days
  });
});

describe("workouts in the expenditure fit", () => {
  it("leave the average burn alone and move energy from the fitted part to workout days", () => {
    const today = "2026-10-16";
    const base = datesBetween(addDays(today, -30), addDays(today, -1)).map((date, i): EnergyDay =>
      ({ date, calories: 2000, steps: 8000, weightLbs: 200 + 0.1 * (29 - i), bodyFatPercent: 20 }));
    const settings = { ...DEFAULT_HEALTH_SETTINGS, windowDays: 14 };
    const without = computeTargets(today, base, settings)!;
    const lifting = base.map((d, i) => ({ ...d, workoutKcal: i % 2 === 1 ? 200 : 0 })); // yesterday (the last day) is a workout day
    const withWorkouts = computeTargets(today, lifting, settings)!;
    expect(withWorkouts.expenditure).toBeCloseTo(without.expenditure);
    expect(withWorkouts.calories).toBeCloseTo(without.calories);
    expect(withWorkouts.averageWorkoutKcal).toBeCloseTo(100);
    expect(withWorkouts.activityMultiplier!).toBeLessThan(without.activityMultiplier!);
    expect(withWorkouts.previousDayExpenditure! - without.previousDayExpenditure!).toBeCloseTo(100, 0);
  });
});
