import type { DashboardApprovalItem, DashboardRunningItem } from "../../types";

export type ActivityStatusRow = {
  key: string;
  running?: DashboardRunningItem;
  approval?: DashboardApprovalItem;
};

export const isDashboardTaskSource = (source?: string) =>
  ["cron", "kanban", "inspiration"].includes(source || "");

// A request belongs to a run, not to its agent, title or command. Keep the run's
// React key and list position when its current request arrives or disappears.
export function activityStatusRows(
  running: DashboardRunningItem[], approvals: DashboardApprovalItem[], previousOrder: string[] = [],
): ActivityStatusRow[] {
  const rows = new Map<string, ActivityStatusRow>();
  for (const item of running) {
    if (item.kind === "chat" || (item.status && !["starting", "running", "waiting_approval", "waiting_input"].includes(item.status))) continue;
    const key = JSON.stringify([item.backendId, item.runId ? "run" : "running", item.runId || item.id]);
    rows.set(key, { key, running: item });
  }
  for (const item of approvals) {
    const key = JSON.stringify([item.backendId, item.runId ? "run" : "approval", item.runId || item.id]);
    rows.set(key, { ...rows.get(key), key, approval: item });
  }
  const ordered = previousOrder.flatMap(key => {
    const row = rows.get(key);
    rows.delete(key);
    return row ? [row] : [];
  });
  return [...ordered, ...rows.values()];
}
