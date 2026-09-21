"use strict";

// Recover only turns already owned by a Shoggoth WorkRun. Native CLI sessions
// outside those bindings, and inherited/forked history, are never charged again.
async function reconcileGrokUsage({ profiles, runs, usageStore, readUsage, sinceMs, now = Date.now() }) {
  const byProfile = new Map(profiles.filter(p => p.runtime === "grok-build").map(p => [p.id, p]));
  const recorded = new Set(usageStore.list().map(row => `${row.profileId}\0${row.threadId}\0${row.turnId}`));
  const groups = new Map();
  let complete = true;
  for (const run of runs) {
    const profile = byProfile.get(run.profileId);
    const session = run.runtimeSessionRef;
    const turnId = run.runtimeTurnRef?.turnId;
    if (!profile || !session?.sessionId || !turnId || run.finishedAt === null || run.finishedAt < sinceMs) continue;
    if (session.runtime !== "grok-build" || session.runtimeProfileId !== profile.runtimeProfileId
      || session.runtimeAccountId !== profile.runtimeAccountId) { complete = false; continue; }
    if (recorded.has(`${profile.id}\0${session.sessionId}\0${turnId}`)) continue;
    const key = `${profile.runtimeAccountId}\0${session.sessionId}`;
    const group = groups.get(key) || { profile, sessionId: session.sessionId, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  // Keep the read-only CLI fan-out bounded; limits never truncate the records.
  const queue = [...groups.values()];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const group = queue.shift();
      try {
        const rows = await readUsage(group.profile, { sessionId: group.sessionId,
          cwd: group.runs[0].workspace || undefined, sinceMs, untilMs: now });
        const recovered = new Set();
        for (const row of rows) {
          const matches = group.runs.filter(run => row.createdAt >= (run.startedAt ?? run.createdAt)
            && row.createdAt <= run.finishedAt);
          if (matches.length !== 1) continue;
          const run = matches[0];
          recovered.add(run.id);
          usageStore.record({ profileId: run.profileId,
            agentId: group.profile.agentId || group.profile.id,
            agentName: group.profile.name || group.profile.agentId || group.profile.id,
            source: run.source, sourceId: run.sourceId, threadId: group.sessionId,
            turnId: run.runtimeTurnRef.turnId, responseId: row.responseId,
            model: row.model, provider: row.provider, usage: row.usage, createdAt: row.createdAt,
            ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}) });
        }
        if (group.runs.some(run => run.status === "completed" && !recovered.has(run.id))) complete = false;
      } catch { complete = false; }
    }
  }));
  return complete;
}

module.exports = { reconcileGrokUsage };
