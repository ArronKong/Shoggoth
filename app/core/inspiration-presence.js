"use strict";

// Presence is a read-only projection. Missing/partial activity data never means
// an agent is free; each backend must positively confirm its current workload.
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const BUSY = new Set(["queued", "starting", "running", "waiting_input", "waiting_approval", "unknown"]);
const keyOf = (backendId, agentId) => JSON.stringify([backendId, agentId]);
const incomplete = (result) => result?.truncated === true || result?.hasMore === true || Boolean(result?.nextCursor);

async function inspirationBusyAgents(registry) {
  const busy = new Set();
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await registry.listInspirations({ filter: "active", query: "", cursor, limit: 50 });
    for (const idea of result.items) {
      if (!BUSY.has(idea.status)) continue;
      if (!idea.latestExecution) throw new Error("Incomplete inspiration presence");
      busy.add(keyOf(idea.latestExecution.backendId, idea.latestExecution.agentId));
    }
    if (!result.hasMore) return busy;
    if (!result.nextCursor || seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Incomplete inspiration scan");
}

async function nativeIdle(backend, agents) {
  backend._assertDomainReady();
  // Scan only live states. A decorative greeting must not pull every agent's
  // complete run history on each appearance.
  const runs = (await Promise.all(["queued", "starting", "running", "waiting_input", "waiting_approval"].map(status =>
    backend._page("run.list", { profileId: null, sessionKey: null, status }, "runs", {
      maxBytes: 1024 * 1024, maxItems: 1000,
    })))).flat();
  const busyProfiles = new Set(runs.filter((run) => !TERMINAL.has(run.status)).map((run) => run.profileId));
  for (const active of backend._activeBySession.values()) {
    if (!TERMINAL.has(active.status)) {
      if (!active.run?.profileId) return [];
      busyProfiles.add(active.run.profileId);
    }
  }
  return agents.filter((agent) => {
    const profile = backend._profilesByAgent.get(agent.id);
    return profile?.enabled === true && !busyProfiles.has(profile.id);
  });
}

async function openClawIdle(backend, agents) {
  await backend._connect();
  const busy = new Set();
  const cursors = new Set();
  let cursor;
  let complete = false;
  for (let page = 0; page < 20; page++) {
    const result = await backend.request("tasks.list", { limit: 100, ...(cursor ? { cursor } : {}) }, 8000);
    if (!Array.isArray(result?.tasks) || result.truncated === true) return [];
    for (const task of result.tasks) {
      if (TERMINAL.has(task.status)) continue;
      const agentId = task.agentId || /^agent:([^:]+):/u.exec(task.sessionKey || "")?.[1];
      if (!agentId) return [];
      busy.add(agentId);
    }
    if (!result.nextCursor) {
      complete = result.hasMore !== true;
      break;
    }
    if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) return [];
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  if (!complete) return [];
  const idle = await Promise.all(agents.filter((agent) => !busy.has(agent.id)).map(async (agent) => {
    try {
      const result = await backend.request("sessions.list", { agentId: agent.id, limit: 100 }, 8000);
      if (!Array.isArray(result?.sessions) || incomplete(result)
        || result.sessions.length >= 100 || (typeof result.count === "number" && result.count > result.sessions.length)) return null;
      // hasActiveRun is authoritative even for a stale 'running' session row.
      return result.sessions.every((row) => row.hasActiveRun === false
        && !["queued", "starting", "waiting_input", "waiting_approval", "unknown"].includes(row.status)) ? agent : null;
    } catch { return null; }
  }));
  return idle.filter(Boolean);
}

async function hermesIdle(backend, agents) {
  const idle = await Promise.all(agents.map(async (agent) => {
    try {
      const profile = backend.profileById.get(agent.id);
      const dash = backend.dashboards.get(profile);
      if (!profile || !dash) return null;
      const socket = backend._gwSocket(profile, dash);
      const result = await socket.request("session.active_list", {}, { timeoutMs: 8000 });
      const generation = socket.generation;
      if (!Array.isArray(result?.sessions) || incomplete(result)
        || result.sessions.some((row) => !row?.id || !row.session_key || row.status !== "idle"
          || row.running === true || row.inflight != null)) return null;
      // Include local ACP sends and queued submissions, which have not yet
      // reached the gateway's active-session list.
      const localKeys = [...backend.sendQueues.keys(), ...[...backend.gwTurns.values()].map((turn) => turn.sessionKey)];
      if (localKeys.some((key) => backend._sessionTarget(key).profile === profile)) return null;
      return backend.gwSockets.get(profile) === socket && socket.generation === generation ? agent : null;
    } catch { return null; }
  }));
  return idle.filter(Boolean);
}

async function loadIdleInspirationAgents(registry) {
  try {
    const [{ agents }, busy] = await Promise.all([registry.getInspirationAgents(), inspirationBusyAgents(registry)]);
    const groups = new Map();
    for (const agent of agents) {
      if (!agent.capabilities.execute || busy.has(keyOf(agent.backendId, agent.id))) continue;
      if (!groups.has(agent.backendId)) groups.set(agent.backendId, []);
      groups.get(agent.backendId).push(agent);
    }
    const snapshots = await Promise.all([...groups].map(async ([backendId, candidates]) => {
      try {
        const backend = registry._activeGet(backendId);
        const read = { shoggoth: nativeIdle, openclaw: openClawIdle, hermes: hermesIdle }[backendId];
        return backend && read ? await read(backend, candidates) : [];
      } catch { return []; }
    }));
    return { agents: snapshots.flat() };
  } catch { return { agents: [] }; }
}

module.exports = { loadIdleInspirationAgents };
