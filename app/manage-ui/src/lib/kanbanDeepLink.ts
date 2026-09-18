import type { FederatedKanbanProject, FederatedKanbanSource, UnifiedTask } from "../types";

export interface KanbanDeepLink {
  project: string;
  backend: string;
  board: string;
  task: string;
}

export interface ResolvedKanbanDeepLinkSource {
  projectKey: string;
  backendId: string;
}

function sourceMatchesBoard(source: FederatedKanbanSource, board: string): boolean {
  return source.boardId === board || source.slug === board;
}

/** Resolve legacy links whose backend was hardcoded, but only when board ownership is unambiguous. */
export function resolveKanbanDeepLinkSource(
  projects: FederatedKanbanProject[],
  target: KanbanDeepLink,
): ResolvedKanbanDeepLinkSource | null {
  if (!target.board) return null;
  const candidates = projects.flatMap((project) => project.sources
    .filter((source) => sourceMatchesBoard(source, target.board))
    .map((source) => ({ projectKey: project.key, backendId: source.backendId })));
  const exact = target.backend
    ? candidates.filter((candidate) => candidate.backendId === target.backend)
    : [];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

/** Find one card without guessing when duplicate task or board identities are present. */
export function findKanbanDeepLinkTask(
  tasks: UnifiedTask[],
  target: KanbanDeepLink,
  resolvedBackendId?: string,
): UnifiedTask | null {
  if (!target.task) return null;
  const candidates = tasks.filter((task) => task.id === target.task);
  for (const backendId of [resolvedBackendId, target.backend]) {
    if (!backendId) continue;
    const matches = candidates.filter((task) => task.backendId === backendId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  if (target.board) {
    const matches = candidates.filter((task) => task.sourceBoard === target.board);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
