import type { UnifiedCronJob } from "../types";

// Codex Desktop 任务和系统心跳保留原调度，只排除其界面投影。
export function isVisibleCronJob(job: UnifiedCronJob): boolean {
  if (job.origin === "codex-desktop") return false;
  if (job.payload?.kind) return job.payload.kind !== "heartbeat";
  // 兼容只保留能力标签的任务快照，不按名称匹配普通用户任务。
  return !job.backendDetails?.capabilityTags?.includes("heartbeat")
    && !job.rawCapabilities?.includes("heartbeat");
}
