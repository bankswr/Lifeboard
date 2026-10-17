# Heart rate vs steps as the activity measure (phase 7a investigation)

2026-10-17, agent (Claude). Asked by the user: is there a meaningful difference in estimating
calories burned from heart rate, steps or both, without overfitting, mainly as a backup for
days with missing data. Read-only analysis on a copy of the real database (2026-07-17 to
2026-10-15). Scripts were throwaway (session scratchpad).

## Data
- Heart rate: the ring, every 10 minutes, ~141 samples/day; 89 of 91 days complete (≥120).
- Resting heart rate: ring (91 days) + Google Fit (60 days), daily.
- Steps: every day has steps (several sources merged by `core/steps.ts`), so a fully
  missing steps day hasn't happened yet in this data.

## Findings
- **Filling in a day's steps** (leave-one-out: each day predicted without itself):
  | Method | Median miss | ≈ kcal |
  |---|---|---|
  | Typical day: median of the previous 14 days (nothing fitted) | 2,170 steps | 82 |
  | Heart rate alone (best of: load above rest, minutes ≥ rest+20/30/40, mean) | 2,174–2,787 | 83–106 |
  | Typical day + heart rate (2 fitted numbers) | 1,871 | 71 |
  Heart rate alone is no better than the typical day; combining them saves about 11 kcal a
  day, small against a ~2,500 kcal burn and the weight-trend noise.
- **Within a day heart rate does follow walking**: 10-minute bins, r = 0.49; walking bins
  (≥500 steps) sit a median 31 bpm above rest, step-free bins 5 bpm. Over a whole day the
  signal is diluted by everything else that moves heart rate (daily steps vs heart-rate
  load r ≈ 0.35).
- **Effort without steps is rare**: 1.6% of step-free 10-minute bins are ≥30 bpm above rest
  (lifting, cycling, or noise). Only one day (07-26) had a high heart-rate load with low steps.
- **Resting heart rate is not an activity measure**: same-day and next-day correlation with
  steps ≈ 0 (−0.02 / 0.07). It drifts over weeks (fortnight averages 69.6 → 75.9 → 71.2 bpm),
  which looks like fitness, recovery or intake, not activity.
- **Can't be checked against measured burn**: burn implied by intake and weight trend over
  14-day windows ranges 900–3,100 kcal/day (water and logging noise), far larger than any
  difference between activity measures (~±200 kcal). Windows rose with steps (r 0.61) but
  steps, intake and logging all rose over the same weeks, so that isn't evidence.

## Recommendation given to the user
No meaningful difference. Keep steps as the only activity input (fixed physiological cost,
nothing fitted). As the backup for a day without steps, use the typical day (median of the
previous 14 days), marked as estimated; heart rate isn't worth two fitted numbers for ~11
kcal/day. Resting heart rate stays a graph on the Health page, informational only.
