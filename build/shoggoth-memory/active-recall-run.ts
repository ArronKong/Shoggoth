import { callHost } from "shoggoth-memory-host";
import { runRecallSubagent as runNativeRecall } from "upstream:extensions/active-memory/recall-run.ts";

// Keep the original runner (including its finally cleanup) intact. The Service
// retains this promise when the native outer watchdog returns before it settles.
export function runRecallSubagent(params: Parameters<typeof runNativeRecall>[0]) {
  return callHost("trackActiveMemoryRecall", () => runNativeRecall(params));
}
