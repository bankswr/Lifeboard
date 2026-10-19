# LitterHopper estimate

2026-10-19, agent (Claude). The user asked whether Lifeboard can see the hopper's capacity,
then asked for the Pets bar fix and a refill-based estimate; hopper status not wanted.

## Findings
- The Pets card's bar labelled "Litter Hopper" showed `litterLevelPercentage`: the litter in
  the globe, not the LitterHopper accessory. Renamed "Litter level".
- Whisker has no hopper fill level. pylitterbot lists `hopperStatus` (enabled/disabled/empty/
  motor faults) and `isHopperRemoved`; not read (user). The activity log has one
  `litterHopperDispensed` entry per dispense: 1,477 in the user's past year (≈4/day; see
  2026-10-18-litter-cycle-stalls.md).

## Built (`core/whisker/hopper.ts`, migration 21 `litter_hopper_event`, synced)
- Each Whisker update stores the dispenses in the 72 h activity read it already makes for
  stalls; ids `<serial>-dispense-<UTC ISO>` so overlapping reads and both devices add nothing.
  No backfill of older history: the rate only needs the last 14 days.
- Refill press (Pets → Litter-Robot card): after the first, stores the dispense count since
  the previous refill as a sample; capacity = median of samples ≥ 1 (per robot, unlike the
  pooled feeders). Refills listed and removable under Settings → Litter-Robot.
- Days left = (capacity − dispenses since refill) / dispenses per day over the last 14 days
  (from the first dispense seen if newer; learning until a day of dispenses has been seen).
  Thresholds in days (default 3 / 1) and an optional "Refill the litter hopper" task, both in
  `LitterSettings`. Pets widget row "Hopper empty" once a refill exists.

## Open
- Not run against the real account yet. Unknown whether the robot keeps logging
  `litterHopperDispensed` when the hopper is empty; if it does, a refill made long after it
  ran dry over-counts the sample (the median dampens one such refill).
