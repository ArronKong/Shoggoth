export interface AgentNameSource {
  id: string;
  name?: string | null;
  backendId?: string | null;
  identity?: { name?: string | null } | null;
}

export type AgentNameIndex = Record<string, string>;

const agentNameKey = (agentId: string, backendId = ""): string => `${backendId}\u0000${agentId}`;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Build a current-name lookup without changing the stable agent id used for routing and avatars. */
export function createAgentNameIndex(rows: AgentNameSource[]): AgentNameIndex {
  const index: AgentNameIndex = {};
  for (const row of rows) {
    const id = clean(row?.id);
    const name = clean(row?.name) || clean(row?.identity?.name);
    if (!id || !name) continue;
    index[agentNameKey(id, clean(row.backendId))] = name;
  }
  return index;
}

export function findAgentDisplayName(
  index: AgentNameIndex,
  agentId: string,
  backendId?: string,
): string | undefined {
  const id = clean(agentId);
  if (!id) return undefined;
  const backend = clean(backendId);
  return (backend ? index[agentNameKey(id, backend)] : undefined) || index[agentNameKey(id)];
}

export function resolveAgentDisplayName(
  index: AgentNameIndex,
  agentId: string,
  backendId?: string,
  fallback?: string,
): string {
  return findAgentDisplayName(index, agentId, backendId) || clean(fallback) || clean(agentId);
}
