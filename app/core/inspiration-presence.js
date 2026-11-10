"use strict";

// Presence is a read-only projection. Missing/partial activity data never means
// an agent is free; each backend must positively confirm its current workload.
const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "timed_out", "interrupted", "skipped"]);
const BUSY = new Set(["queued", "starting", "running", "waiting_input", "waiting_approval"]);
const SESSION_PENDING = new Set(["queued", "starting", "waiting_input", "waiting_approval"]);
const keyOf = (backendId, agentId) => JSON.stringify([backendId, agentId]);
const incomplete = (result) => result?.truncated === true || result?.hasMore === true || Boolean(result?.nextCursor);
const emptyPresence = () => ({ agents: [], busyAgents: [] });

async function agentPresence(agents, read) {
  const states = await Promise.all(agents.map(async (agent) => {
    try { return { agent, state: await read(agent) }; }
    catch { return { agent, state: "unknown" }; }
  }));
  return {
    agents: states.filter(({ state }) => state === "idle").map(({ agent }) => agent),
    busyAgents: states.filter(({ state }) => state === "busy").map(({ agent }) => agent),
  };
}

async function inspirationBusyAgents(registry) {
  const busy = new Set();
  const unknown = new Set();
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await registry.listInspirations({ filter: "active", query: "", cursor, limit: 50 });
    for (const idea of result.items) {
      if (!BUSY.has(idea.status) && idea.status !== "unknown") continue;
      if (!idea.latestExecution) throw new Error("Incomplete inspiration presence");
      (idea.status === "unknown" ? unknown : busy).add(keyOf(idea.latestExecution.backendId, idea.latestExecution.agentId));
    }
    if (!result.hasMore) return { busy, unknown };
    if (!result.nextCursor || seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Incomplete inspiration scan");
}

async function nativePresence(backend, agents) {
  backend._assertDomainReady();
  // Scan only live states. A decorative greeting must not pull every agent's
  // complete run history on each appearance.
  const runs = (await Promise.all(["queued", "starting", "running", "waiting_input", "waiting_approval"].map(status =>
    backend._page("run.list", { profileId: null, sessionKey: null, status }, "runs", {
      maxBytes: 1024 * 1024, maxItems: 1000,
    })))).flat();
  const occupiedProfiles = new Set(runs.filter((run) => !TERMINAL.has(run.status)).map((run) => run.profileId));
  const busyProfiles = new Set(runs.filter((run) => BUSY.has(run.status)).map((run) => run.profileId));
  for (const active of backend._activeBySession.values()) {
    if (!TERMINAL.has(active.status)) {
      if (!active.run?.profileId) return emptyPresence();
      occupiedProfiles.add(active.run.profileId);
      if (BUSY.has(active.status)) busyProfiles.add(active.run.profileId);
    }
  }
  return agentPresence(agents, async (agent) => {
    const profile = backend._profilesByAgent.get(agent.id);
    if (!profile || profile.enabled !== true) return "unknown";
    return busyProfiles.has(profile.id) ? "busy" : occupiedProfiles.has(profile.id) ? "unknown" : "idle";
  });
}

async function openClawPresence(backend, agents) {
  await backend._connect();
  const generation = backend._connectionGeneration;
  const socket = backend._ws;
  const busy = new Set();
  const unknown = new Set();
  const cursors = new Set();
  let cursor;
  // Newer gateways expose live work through sessions.list, without tasks.*.
  // Only query the ledger when this connection advertises it. A failed or
  // incomplete advertised ledger must still prevent an idle declaration.
  if (typeof backend.hasGatewayMethod !== "function") return emptyPresence();
  if (backend.hasGatewayMethod("tasks.list")) {
    let complete = false;
    for (let page = 0; page < 20; page++) {
      const result = await backend.request("tasks.list", { limit: 100, ...(cursor ? { cursor } : {}) }, 8000);
      if (!Array.isArray(result?.tasks) || result.truncated === true) return emptyPresence();
      for (const task of result.tasks) {
        if (TERMINAL.has(task?.status)) continue;
        const agentId = task?.agentId || /^agent:([^:]+):/u.exec(task?.sessionKey || "")?.[1];
        if (!agentId) return emptyPresence();
        (BUSY.has(task.status) ? busy : unknown).add(agentId);
      }
      if (!result.nextCursor) {
        complete = result.hasMore !== true;
        break;
      }
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) return emptyPresence();
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (!complete) return emptyPresence();
  }
  const snapshot = await agentPresence(agents, async (agent) => {
    if (busy.has(agent.id)) return "busy";
    if (!backend.hasGatewayMethod("sessions.list")) return "unknown";
    const result = await backend.request("sessions.list", { agentId: agent.id, limit: 100 }, 8000);
    if (!Array.isArray(result?.sessions)
      || result.sessions.some(row => !row?.key?.startsWith(`agent:${agent.id}:`))) return "unknown";
    if (result.sessions.some(row => row.hasActiveRun === true || SESSION_PENDING.has(row.status))) return "busy";
    if (unknown.has(agent.id) || incomplete(result)
      || result.sessions.length >= 100 || (typeof result.count === "number" && result.count > result.sessions.length)) return "unknown";
    // hasActiveRun is authoritative even for a stale 'running' session row.
    return result.sessions.every(row => row.hasActiveRun === false && row.status !== "unknown") ? "idle" : "unknown";
  });
  return backend._connectionGeneration === generation && backend._ws === socket ? snapshot : emptyPresence();
}

async function hermesPresence(backend, agents) {
  return agentPresence(agents, async (agent) => {
    const profile = backend.profileById.get(agent.id);
    const dash = backend.dashboards.get(profile);
    if (!profile || !dash) return "unknown";
    const socket = backend._gwSocket(profile, dash);
    const generation = socket.generation;
    const result = await socket.request("session.active_list", {}, { timeoutMs: 8000 });
    if (backend.gwSockets.get(profile) !== socket || socket.generation !== generation) return "unknown";
    // Include local ACP sends and queued submissions, which have not yet
    // reached the gateway's active-session list.
    const localKeys = [...backend.sendQueues.keys(), ...[...backend.gwTurns.values()].map((turn) => turn.sessionKey)];
    if (localKeys.some((key) => backend._sessionTarget(key).profile === profile)) return "busy";
    if (!Array.isArray(result?.sessions) || result.sessions.some(row => !row?.id || !row.session_key)) return "unknown";
    if (result.sessions.some(row => row.running === true || row.inflight != null
      || row.status === "working" || BUSY.has(row.status))) return "busy";
    return !incomplete(result) && result.sessions.every(row => row.status === "idle") ? "idle" : "unknown";
  });
}

async function loadIdleInspirationAgents(registry) {
  try {
    const [{ agents }, { busy, unknown }] = await Promise.all([registry.getInspirationAgents(), inspirationBusyAgents(registry)]);
    const groups = new Map();
    for (const agent of agents) {
      if (!agent.capabilities.execute || busy.has(keyOf(agent.backendId, agent.id)) || unknown.has(keyOf(agent.backendId, agent.id))) continue;
      if (!groups.has(agent.backendId)) groups.set(agent.backendId, []);
      groups.get(agent.backendId).push(agent);
    }
    const snapshots = await Promise.all([...groups].map(async ([backendId, candidates]) => {
      try {
        const backend = registry._activeGet(backendId);
        const read = { shoggoth: nativePresence, openclaw: openClawPresence, hermes: hermesPresence }[backendId];
        return backend && read ? await read(backend, candidates) : emptyPresence();
      } catch { return emptyPresence(); }
    }));
    return {
      agents: snapshots.flatMap(snapshot => snapshot.agents),
      busyAgents: [...agents.filter(agent => agent.capabilities.execute && busy.has(keyOf(agent.backendId, agent.id))),
        ...snapshots.flatMap(snapshot => snapshot.busyAgents)],
    };
  } catch { return emptyPresence(); }
}

module.exports = { loadIdleInspirationAgents };
