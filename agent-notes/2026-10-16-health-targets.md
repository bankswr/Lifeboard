# Health analysis: expenditure, adaptive targets, flags, heart-rate pull

2026-10-16, agent (Claude). Design agreed with the user in planning (docs/PLAN.md phase 7a);
built the same day. Tests pass; checked on a copy of the real database (sign-ins removed);
**not yet run as the user's own desktop app**, and the heart-rate pull hasn't hit real Google.

## Where things are
- `core/energy.ts`: pure math (7-day averages, slope, Katch-McArdle, fit, targets).
- `core/healthReview.ts`: flags (worked out from data each time, never stored), synced
  verdicts (`health_review`, id `<date>-<kind>`), one alert per pending flag per device
  (`rule_state` rule_id `health-flag`).
- `core/healthTargets.ts`: settings (synced `setting` id `health_targets`), `analyzeHealth`
  (review + targets + save to `health_target`, one synced row per day as JSON), history,
  `checkHealth` run at the end of each update.
- UI: Health page cards + `#/health/history`, `#/health-settings`, Monitor's Health card.
- Google pull now also fetches `heart-rate` (every sample, like steps) and
  `daily-resting-heart-rate` (daily type: the filter takes plain dates). Same OAuth scope as
  weight, so no new sign-in.

## 90-day history pull (user, 2026-10-16)
- Google and Cronometer each pull `HISTORY_DAYS` (90) once, remembered as `historyFrom` in
  the device's credential, so existing installs fetch it at their next update. After that
  they re-read 3 days, as before. Raising `HISTORY_DAYS` re-triggers the pull everywhere.
  The Cronometer history costs one export (one range).
- Google limits a query to 14 days for `heart-rate` and 90 days for other types
  (developers.google.com/health/data-types). `listDataPoints` splits ranges to fit.
- Run on the real desktop database 2026-10-16 (backup taken first). Results:
  - steps and heart rate: 91 days, about 141 heart-rate samples a day from the ring;
  - weight and body fat: 84 days;
  - Cronometer: 65 logged days of 90.
- Resting heart rate comes from two sources, the ring (90 days) and Google Fit (60 days).
  The daily value averages them; they agree within about 1 bpm.
- **Body water: not available.** The Google Health API has no body-water, lean-mass or
  bone-mass type (checked the data-types page 2026-10-16); `hydration-log` is drinking water.
  The scale app (`com.elink.fittrackhealth.pro`) writes only weight and body fat.

## Decisions not obvious from the code
- **Activity proxy.** One window gives one average, so it can't fit both a constant and a
  per-step slope. Instead each step has a fixed net cost (0.5 kcal/kg/km ÷ 1,300 steps/km),
  and the rest of the expenditure is fitted as a multiple of BMR. Targets use the window's
  average expenditure, so the day's own steps don't move the target (user: steps are
  informational). Steps are used only for "yesterday's burn".
- **Low-calorie flag** compares to BMR × fallback factor, not the fitted burn: the fit
  depends on which days are flagged, so using it here would be circular.
- **Flag semantics.** Day flags (no-log, low-calories, high-steps) drop the day's intake;
  weigh-in and body-fat flags drop only that measurement. Pending = left out until reviewed;
  accepted = counts; rejected = left out. An unlogged day can only be skipped (it never
  counts); logging it in Cronometer clears the flag.
- **Goal energy** always uses 3,500 kcal/lb, even in split mode.
- **Fit needs** half the window in logged days and fresh (not carried-forward) weight
  averages; otherwise the fallback BMR × factor (default 1.375) is used.
- **Saved targets.** Today's row is rewritten when the inputs change (only if the JSON
  differs); past rows aren't touched. Both devices may write today's row; newest wins.

## Finding on real data (2026-10-16)
- With 31 days of history, the 14-day window gave a weight trend of +1.83 lb/week and a burn
  of 1,732 kcal/day, below BMR (2,115). The cause is the data: weight rose about 3 lb in
  two weeks of high intake (likely partly water and glycogen).
- Other settings on the same data:

  | Window | 3,500 kcal/lb | Fat/lean split |
  |---|---|---|
  | 14 days | 1,732 | 2,505 |
  | 21 days | 2,014 | 2,418 |
  | 24 days | 2,225 | 2,466 |

- Short windows are noisy. Options for the user:
  - a longer default window;
  - a sanity bound (e.g. never below BMR × something);
  - smoothing between successive estimates;
  - backfilling more history (done: 90 days, see above).

  The user chose a longer default window (see below).
- With 90 days stored, the estimate by fit window (3,500 kcal/lb vs fat/lean split):

  | Window | 3,500 kcal/lb | Fat/lean split |
  |---|---|---|
  | 14 days | 1,732 | 2,505 |
  | 21 days | 2,014 | 2,418 |
  | 28 days | 2,424 | 2,495 |
  | 42 days | 2,631 | 2,551 |
  | 60 days | 2,392 | 2,451 |

  Windows of 28 days or more are stable. **Default window raised from 14 to 28 days**
  (user, 2026-10-16): the shortest window that was stable on this data.

## Open / later (with the Health page work)
- Charts and fuller explanations; side-by-side comparison of 3,500 vs fat/lean split.
- How to use heart rate as an activity proxy (data now being collected).
