import type { UnifiedCronJob } from "../types";

// 系统心跳仍由后端调度；展示时排除，避免它反复占满日历。
export function isVisibleCronJob(job: UnifiedCronJob): boolean {
  if (job.payload?.kind) return job.payload.kind !== "heartbeat";
  // 兼容只保留能力标签的任务快照，不按名称匹配普通用户任务。
  return !job.backendDetails?.capabilityTags?.includes("heartbeat")
    && !job.rawCapabilities?.includes("heartbeat");
}
