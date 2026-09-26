import type { InspirationExecution } from '../types';
import { stepsFromParts, type TimelinePartLike, type TurnStep } from '../lib/turnTimeline';

export function latestInspirationStep(parts: TimelinePartLike[], live: boolean): TurnStep | undefined {
  // Tool results and plan updates amend an earlier step. Array order alone
  // would leave a newer parallel tool on screen after an older tool finishes.
  return stepsFromParts(parts, { live, includeText: true }).reduce<TurnStep | undefined>((latest, step) =>
    !latest || (step.endTs ?? step.startTs) >= (latest.endTs ?? latest.startTs) ? step : latest, undefined);
}

export function inspirationRunTone(execution: InspirationExecution) {
  if (execution.attention?.active) return 'attention';
  // A failed tool can be retried while the run continues. Only the run's
  // authoritative status determines the card's failure state.
  if (['failed', 'canceled', 'interrupted'].includes(execution.status)) return 'error';
  if (['waiting_approval', 'waiting_input'].includes(execution.status)) return 'attention';
  return 'running';
}
