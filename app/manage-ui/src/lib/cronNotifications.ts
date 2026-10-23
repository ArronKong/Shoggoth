import type { UnifiedCronJob } from "../types";

// Pending executions must not consume their startedAt watermark: the delivery
// decision arrives later with the same timestamp. Silence does consume it.
export function consumeCronNotification(lastRuns: Map<string, number>, job: UnifiedCronJob, seeded: boolean): boolean {
  if (job.outputDisposition === "pending" || job.lastStatus === "running") return false;
  const last = job.lastRunAt ?? 0, previous = lastRuns.get(job.id);
  lastRuns.set(job.id, last);
  return seeded && previous !== undefined && last > previous && job.outputDisposition !== "silent";
}
