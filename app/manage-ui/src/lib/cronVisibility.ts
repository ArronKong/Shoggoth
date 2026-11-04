import type { UnifiedCronJob } from "../types";

// 系统任务保留原调度，只排除其界面投影。
export function isVisibleCronJob(job: UnifiedCronJob): boolean {
  if (job.origin === "codex-desktop") return false;
  if (job.backendId === "openclaw" && (job.systemManaged === true
    || job.actions?.reason === "system-managed"
    || job.payload?.kind === "skillCollectionReview")) return false;
  if (job.payload?.kind) return job.payload.kind !== "heartbeat";
  // 兼容只保留能力标签的任务快照，不按名称匹配普通用户任务。
  if (job.backendId === "openclaw" && (job.backendDetails?.capabilityTags?.includes("skillCollectionReview")
    || job.rawCapabilities?.includes("skillCollectionReview"))) return false;
  return !job.backendDetails?.capabilityTags?.includes("heartbeat")
    && !job.rawCapabilities?.includes("heartbeat");
}
