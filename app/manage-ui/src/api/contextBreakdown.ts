import type { ContextBreakdown } from "../types";
import { jsonFetch } from "./client";

export function getContextBreakdown(backend: string, agentId: string, sessionKey: string, runId: string, signal: AbortSignal) {
  const params = new URLSearchParams({ backend, sessionKey, runId });
  return jsonFetch<ContextBreakdown>(`/__api/agents/${encodeURIComponent(agentId)}/context?${params}`, { signal });
}
