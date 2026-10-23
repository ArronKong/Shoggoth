import { callHost } from "shoggoth-memory-host";
import { maybeResolveActiveRecall as resolveNativeRecall } from "upstream:extensions/active-memory/recall.ts";

// Freeze the Product model only after native eligibility/trigger checks and
// before native cache lookup. Observe the result and retain cleanup ownership;
// the original selection/cache policy stays intact.
export function maybeResolveActiveRecall(params: Parameters<typeof resolveNativeRecall>[0]) {
  return callHost("trackActiveMemoryResolution", resolveNativeRecall, params);
}
