# Litter-Robot clean-cycle stalls

2026-10-18, agent (Claude). The user asked for an alert when it has been suspiciously long
since the Litter-Robot ran a clean cycle, and for the distribution of times between cycles
first. Probed the user's real account read-only (no commands): the LR4 activity log
(`getLitterRobot4Activity`, see 2026-10-17-cat-weights.md), 2025-10-01 to 2026-10-18,
fetched a month at a time (largest month 3,105 entries, under the 5,000 limit used).

## Activity log values (a year)
catWeight 5506, odometerCleanCycles 4668, robotCycleStatusIdle 4667, robotCycleStatusDump
4663, robotStatusCatDetect 4645, DFILevelPercent 2260, litterHopperDispensed 1477,
robotCycleStateCatDetect 418, DFIFullFlagOn 246, globeMotorFaultStatusFaultPinch 9,
globeMotorFaultStatusFaultOvertorqueSlope 3, robotCycleStatusAbort 1.
A clean cycle = `robotCycleStatusDump` (start; `Idle` follows, and `odometerCleanCycles`
counts up). A visit = `catWeight` (as for the cats' visit counts).

## Time between cycles (4,663 cycles, ≈12/day)
Median 1.2 h; p75 2.5 h; p90 4.0 h; p95 4.9 h; p99 8.5 h; p99.5 23 h; max 123 h.
<1 h 43%, 1–2 h 24%, 2–3 h 13%, 3–4 h 9.5%, 4–6 h 8.2%, 6–12 h 1.2%, 12–24 h 0.2%,
>24 h 0.5% (22 gaps). Long gaps are of two kinds: cats kept visiting with no cycle (nearly
all begin with `DFIFullFlagOn`: the robot stops cycling while the drawer is full; up to
88 h), or almost nothing logged (robot off/offline/unused, e.g. 123 h in Oct 2025).

## Visit → next cycle
Median 3 min, p90 27 min (bumps at 0–5 and 10–15 min: the robot's wait time); 30–60 min
1.2%; over 60 min only 39 times in the year: 27 drawer-full stalls (5–88 h, many visits)
and 12 single visits answered 1–5 h later.

## Built (user decisions)
- Visit-based alert (user chose it over "time since last cycle"): `core/whisker/stalls.ts`.
  Each Whisker update reads the last 72 h of each robot's activity (`api.activity`, start
  timestamp required: without one Whisker returns ~6 days); stall = visits since the last
  cycle, the first ≥ `stallAlertMinutes` ago (default 60, min 15, null = off; in the synced
  `litter_levels` setting, Settings → Litter-Robot).
- **Renew if cleared (user):** no edge state; an alert is raised whenever a stall is on and
  no undismissed alert (`rule_id = 'litter-stall'`) was created since the stall began. So
  it stays up for the stall, comes back at the next update after a dismissal, and a new
  stall gets a new alert. `recordAlert` gained optional `ruleId` and `at` (so the check's
  clock is used; tests don't depend on the wall clock).
- Message names the visit count and wait, and adds "The drawer is full." when it is.
- Per device like other alerts (desktop hourly; phone at its daily update).
- Verified: 4 tests; live read of the last 72 h (255 entries, 41 cycles, 42 visits, no
  stall at the time). No real alert seen yet.

## 2026-11-01: missed stall (no weigh-ins)
From 2026-10-30 15:13 UTC the robot sat in `ROBOT_CAT_DETECT_DELAY` / `DC_CAT_DETECT_30M`
("Cat sensor timing") for ~2 days: the last activity entry was `robotStatusCatDetect`, then
nothing (no `catWeight`, no cycles), and the box overflowed. No alert, because only weigh-ins
started a stall; the drawer level also stayed at 72% (it only updates after a cycle), so the
drawer-full rule couldn't fire either. Fix: `robotStatusCatDetect` and
`robotCycleStateCatDetect` after the last cycle also start a stall; with no weigh-ins the
message says "since it detected a cat … (status: …)". Checked against the live log: flagged.
Also seen: `lastSeen` (2026-10-29 22:42) lagged the activity log, so it is no use as a
"robot silent" signal.
