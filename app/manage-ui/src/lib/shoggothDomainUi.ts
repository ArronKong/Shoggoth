import type { KanbanBoard, TaskBoardCapabilities, TaskInput, UnifiedTaskDetail, WorkboardRunMode } from "../types";

export interface NativeTaskRunCommand {
  mode: WorkboardRunMode;
  retryOf?: string;
}

export function nativeBoardsForProfile(
  boards: KanbanBoard[],
  profileId: string | undefined,
): Array<KanbanBoard & { id: string }> {
  if (!profileId) return [];
  return boards.filter((board): board is KanbanBoard & { id: string } =>
    board.profileId === profileId && typeof board.id === "string" && board.id.length > 0,
  );
}

export function usesExplicitBoardIdentity(boards: KanbanBoard[]): boolean {
  return boards.some((board) =>
    typeof board.id === "string" && board.id.length > 0
      && typeof board.profileId === "string" && board.profileId.length > 0,
  );
}

export function fallbackBoardIdentity(boards: KanbanBoard[]): string {
  const board = boards.find((candidate) => candidate.current === true) || boards[0];
  if (!board) return "";
  return usesExplicitBoardIdentity(boards) ? board.id || "" : board.slug;
}

export function resolveNativeBoardId(boards: KanbanBoard[], selectedSlug: string): string | null {
  const exactId = selectedSlug ? boards.filter((board) => board.id === selectedSlug) : [];
  const current = selectedSlug ? [] : boards.filter((board) => board.current === true);
  const candidates = exactId.length > 0
    ? exactId
    : selectedSlug
      ? boards.filter((board) => board.slug === selectedSlug)
      : current.length === 1 ? current : boards.length === 1 ? boards : [];
  if (candidates.length !== 1) return null;
  const id = candidates[0].id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function nativeTaskCanMoveTo(capabilities: TaskBoardCapabilities, status: string): boolean {
  if (!capabilities.moveTargets?.includes(status)) return false;
  return status !== "done" || capabilities.manualComplete === true;
}

export function nativeTaskCreateSpec(spec: TaskInput): TaskInput {
  return { ...spec, status: undefined, column: "backlog" };
}

export function nativeTaskEditPlan(
  spec: TaskInput,
  current: Pick<UnifiedTaskDetail, "column">,
): TaskInput[] {
  const fields: TaskInput = {};
  if (Object.prototype.hasOwnProperty.call(spec, "title")) fields.title = spec.title;
  if (Object.prototype.hasOwnProperty.call(spec, "body")) fields.body = spec.body;
  const plan = Object.keys(fields).length > 0 ? [fields] : [];
  const status = spec.status || spec.column;
  if (status && status !== current.column) plan.push({ column: status });
  return plan;
}

const RETRYABLE_STATUSES = new Set(["failed", "canceled", "interrupted", "skipped"]);

function runTime(run: NonNullable<UnifiedTaskDetail["runs"]>[number]): number {
  if (typeof run.finishedAt === "number") return run.finishedAt;
  if (typeof run.startedAt === "number") return run.startedAt;
  return Number.NEGATIVE_INFINITY;
}

export function nativeTaskRunCommand(
  capabilities: TaskBoardCapabilities,
  detail: Pick<UnifiedTaskDetail, "runs">,
  intent: "run" | "retry",
): NativeTaskRunCommand | null {
  if (intent === "run") return capabilities.run === true ? { mode: "autonomous" } : null;
  if (capabilities.retry !== true || !detail.runs?.length) return null;
  const latest = detail.runs.reduce((best, run) => runTime(run) >= runTime(best) ? run : best);
  return latest.id && RETRYABLE_STATUSES.has(latest.status || "")
    ? { mode: "retry", retryOf: latest.id }
    : null;
}
