// Workouts found in the heart rate (docs/PLAN.md phase 7a, user 2026-10-17; investigation in
// agent-notes/2026-10-17-heart-rate-vs-steps.md). Steps stay the main activity measure; this
// only adds effort that steps miss, such as lifting (~1,100 steps an hour at ~40 bpm above rest).
// - A workout is a run of the ring's 10-minute heart-rate samples at or above resting + the
//   set bpm, lasting at least the set minutes, with one lower sample allowed inside. It must
//   stay under the set step pace and overlap no treadmill session: walks are already counted
//   by their steps.
// - Its energy is a fixed cost from the Compendium of Physical Activities, not fitted to the
//   user: (METs − 1) × weight (kg) × hours, minus the energy of the steps taken during it, so
//   nothing counts twice. Heart rate isn't used to size it: heart-rate formulas overestimate
//   lifting (straining raises heart rate more than energy use).
// - Missed workouts are accepted (user): a slow session that doesn't raise the heart rate
//   doesn't count.
import { stepEnergy } from "./energy.ts";
import { STEP_SOURCES, type StepPoint } from "./steps.ts";

const SAMPLE_MS = 10 * 60_000;
const LBS_PER_KG = 2.20462262185;

export interface WorkoutSettings {
  /** Heart rate at least this many bpm above the day's resting rate. */
  workoutHeartRateAbove: number;
  workoutMinMinutes: number;
  /** Faster stepping than this is a walk, which steps already count. */
  workoutMaxStepsPerHour: number;
  /** Compendium METs for the workout (3.5: resistance training, multiple exercises). */
  workoutMets: number;
}

export const DEFAULT_WORKOUT_SETTINGS: WorkoutSettings = {
  workoutHeartRateAbove: 30,
  workoutMinMinutes: 30,
  workoutMaxStepsPerHour: 3000,
  workoutMets: 3.5,
};

export interface HeartRateSample {
  /** Local date the sample belongs to. */
  day: string;
  /** UTC milliseconds. */
  time: number;
  bpm: number;
}

export interface Workout {
  /** Local date of its first sample. */
  date: string;
  /** ISO times; the end is the end of the last sample's 10 minutes. */
  start: string;
  end: string;
  minutes: number;
  /** Mean heart rate above that day's resting rate. */
  aboveRest: number;
  /** Steps during it (primary source). */
  steps: number;
}

/**
 * Finds workouts. `samples` in any order; `resting` gives each day's resting heart rate;
 * `stepPoints` are the raw step records (primary and treadmill sources are picked out here).
 */
export function detectWorkouts(
  samples: HeartRateSample[],
  resting: Map<string, number>,
  stepPoints: StepPoint[],
  settings: WorkoutSettings,
  sources = STEP_SOURCES,
): Workout[] {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const primary = stepPoints.filter((p) => sources.primary.includes(p.source));
  const treadmill = stepPoints.filter((p) => sources.treadmill.includes(p.source));
  const workouts: Workout[] = [];
  let run: HeartRateSample[] = [];
  let lowInside = false;

  const isHigh = (sample: HeartRateSample) => {
    const rest = resting.get(sample.day);
    return rest !== undefined && sample.bpm >= rest + settings.workoutHeartRateAbove;
  };
  const finish = () => {
    while (run.length && !isHigh(run.at(-1)!)) run.pop(); // a run never ends on its low sample
    if (run.length * 10 >= settings.workoutMinMinutes) {
      const workout = describe(run, resting, primary);
      const overlapsTreadmill = treadmill.some((p) => p.start < Date.parse(workout.end) && p.end > Date.parse(workout.start));
      const stepsPerHour = workout.steps / (workout.minutes / 60);
      if (!overlapsTreadmill && stepsPerHour < settings.workoutMaxStepsPerHour) workouts.push(workout);
    }
    run = [];
    lowInside = false;
  };

  for (const sample of sorted) {
    const follows = run.length > 0 && Math.round((sample.time - run.at(-1)!.time) / SAMPLE_MS) === 1;
    if (run.length > 0 && !follows) finish();
    if (isHigh(sample)) {
      run.push(sample);
    } else if (run.length > 0 && !lowInside) {
      run.push(sample); // one lower sample inside a workout, e.g. a long rest between sets
      lowInside = true;
    } else {
      finish();
    }
  }
  finish();
  return workouts;
}

function describe(run: HeartRateSample[], resting: Map<string, number>, primary: StepPoint[]): Workout {
  const start = run[0].time;
  const end = run.at(-1)!.time + SAMPLE_MS;
  const aboveRest = run.reduce((sum, s) => sum + (s.bpm - resting.get(s.day)!), 0) / run.length;
  return {
    date: run[0].day,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes: (end - start) / 60_000,
    aboveRest,
    steps: Math.round(primary.reduce((sum, p) => sum + p.count * overlapShare(p, start, end), 0)),
  };
}

/** The share of a step record's interval inside [start, end). */
function overlapShare(point: StepPoint, start: number, end: number): number {
  const length = point.end - point.start;
  if (length <= 0) return point.start >= start && point.start < end ? 1 : 0;
  return Math.max(0, Math.min(point.end, end) - Math.max(point.start, start)) / length;
}

/** Net energy of a workout beyond its steps, kcal: (METs − 1) × kg × hours − the steps' energy. */
export function workoutEnergy(workout: Workout, weightLbs: number, settings: Pick<WorkoutSettings, "workoutMets">): number {
  const gross = (settings.workoutMets - 1) * (weightLbs / LBS_PER_KG) * (workout.minutes / 60);
  return Math.max(0, gross - stepEnergy(workout.steps, weightLbs));
}
