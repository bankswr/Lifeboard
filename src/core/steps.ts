// Daily step totals from overlapping sources, ported from FitThing aggregate._steps_by_day
// (FitThing agent-notes/2026-10-06-treadmill-steps.md has the evidence behind it):
//   - The ring is the primary source; the phone and other sources would double-count.
//   - While the walking treadmill runs, its own count replaces the ring's for that stretch
//     (the ring misses steps when the hands are still). A ring bucket that's partly inside
//     a treadmill session keeps only the share outside it.
//   - Overlapping treadmill records are one session uploaded twice: merged, counted once.

/** Sources by app package. From the user's FitThing setup; change here if devices change. */
export const STEP_SOURCES = {
  primary: ["com.gdjztech.ringconn"],
  treadmill: ["com.urevo.app"],
};

export interface StepPoint {
  /** Local date the point is credited to. */
  day: string;
  /** UTC times in milliseconds. */
  start: number;
  end: number;
  count: number;
  source: string;
}

export function stepsByDay(points: StepPoint[], sources = STEP_SOURCES): Map<string, number> {
  const sessions = mergeOverlapping(points.filter((p) => sources.treadmill.includes(p.source)));
  const totals = new Map<string, number>();
  const add = (day: string, steps: number) => totals.set(day, (totals.get(day) ?? 0) + steps);

  for (const point of points.filter((p) => sources.primary.includes(p.source))) {
    add(point.day, point.count * shareOutside(point, sessions));
  }
  for (const session of sessions) add(session.day, session.count);
  return totals;
}

/** Overlapping sessions become one, keeping the earliest one's day and the larger count. */
function mergeOverlapping(sessions: StepPoint[]): StepPoint[] {
  const merged: StepPoint[] = [];
  for (const session of [...sessions].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && session.start < last.end) {
      merged[merged.length - 1] = { ...last, end: Math.max(last.end, session.end), count: Math.max(last.count, session.count) };
    } else {
      merged.push(session);
    }
  }
  return merged;
}

/** The share of a point's interval that falls outside every session (0..1). */
function shareOutside(point: StepPoint, sessions: StepPoint[]): number {
  const length = point.end - point.start;
  if (length <= 0) return sessions.some((s) => s.start <= point.start && point.start < s.end) ? 0 : 1;
  const inside = sessions.reduce((sum, s) => sum + Math.max(0, Math.min(point.end, s.end) - Math.max(point.start, s.start)), 0);
  return Math.max(0, 1 - inside / length);
}
