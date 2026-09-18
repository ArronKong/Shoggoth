import type { CronRun } from "../../types";

export type CronRunTone = "success" | "error" | "warning" | "neutral";

export interface CronRunStatusView {
  value: string;
  tone: CronRunTone;
  detail?: string;
}

export function cronExecutionView(run: CronRun): CronRunStatusView {
  const value = run.completionStatus || run.status || "unknown";
  const tone: CronRunTone = value === "succeeded" || value === "ok"
    ? "success"
    : value === "failed" || value === "error"
      ? "error"
      : value === "skipped"
        ? "warning"
        : "neutral";
  const detailParts = [run.errorReason, run.error].filter((value): value is string => !!value);
  const detail = [...new Set(detailParts)].join(" · ") || undefined;
  return { value, tone, ...(detail ? { detail } : {}) };
}

export function cronDeliveryView(run: CronRun): CronRunStatusView | null {
  if (!run.deliveryStatus && !run.deliveryError && !run.deliverySuppressionReason) return null;
  const value = run.deliveryStatus || "unknown";
  const tone: CronRunTone = value === "delivered"
    ? "success"
    : value === "not-delivered"
      ? "warning"
      : "neutral";
  const detailParts = [run.deliveryError, run.deliverySuppressionReason]
    .filter((value): value is string => !!value);
  const detail = [...new Set(detailParts)].join(" · ") || undefined;
  return { value, tone, ...(detail ? { detail } : {}) };
}
