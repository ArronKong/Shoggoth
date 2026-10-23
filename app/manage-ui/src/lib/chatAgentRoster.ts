import { resolveBackendOwner } from "./chatBackend";

export type ChatAgentRoster = ReadonlyMap<string, ReadonlySet<string>>;

/** Only a successful, complete partition may remove an Agent from the roster. */
export function updateChatAgentRoster(
  previous: ChatAgentRoster,
  payload: unknown,
  backendIds: readonly string[],
): ChatAgentRoster {
  const snapshot = payload as { agents?: { id?: unknown; backendId?: unknown }[]; degradedBackends?: unknown } | null;
  if (!Array.isArray(snapshot?.agents)
    || snapshot.agents.some(row => !row || typeof row.id !== "string" || !row.id.trim())
    || (snapshot.degradedBackends !== undefined && (!Array.isArray(snapshot.degradedBackends)
      || snapshot.degradedBackends.some(id => typeof id !== "string" || !id)))) {
    throw new Error("Invalid Agent roster");
  }
  const incomplete = new Set(snapshot.degradedBackends as string[] | undefined);
  const byBackend = new Map<string, Set<string>>();
  for (const row of snapshot.agents) {
    const id = row.id as string;
    const backend = resolveBackendOwner(row.backendId, id);
    if (!byBackend.has(backend)) byBackend.set(backend, new Set());
    byBackend.get(backend)!.add(id);
  }
  const next = new Map(previous);
  for (const backend of new Set([...backendIds, ...previous.keys(), ...byBackend.keys()])) {
    const ids = byBackend.get(backend) ?? new Set<string>();
    if (!incomplete.has(backend)) next.set(backend, ids);
    // Partial rows may discover an Agent, but never remove one. If no complete
    // roster has arrived for this backend yet, retain its unknown membership.
    else if (previous.has(backend)) next.set(backend, new Set([...previous.get(backend)!, ...ids]));
  }
  return next;
}

export function isChatAgentListed(roster: ChatAgentRoster, backendId: string, agentId: string): boolean {
  return !roster.has(backendId) || roster.get(backendId)!.has(agentId);
}
