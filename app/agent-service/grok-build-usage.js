"use strict";
const { execFile } = require("node:child_process");

// Grok's public read-only command supplies per-turn usage; ACP usage_update is
// context occupancy and must never be added to consumed tokens.
// Grok user guide 17-sessions: costUsdTicks / 1e10 = USD.
function readGrokUsage({ binaryPath, env, cwd, sessionId, sinceMs = 0, untilMs = Date.now() }) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ["usage", sessionId], { env, cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Grok usage unavailable"));
      try { resolve(projectGrokUsage(JSON.parse(stdout), { sessionId, sinceMs, untilMs })); }
      catch { reject(new Error("Grok usage response invalid")); }
    });
  });
}

function projectGrokUsage(value, { sessionId, sinceMs = 0, untilMs = Infinity }) {
  if (value?.sessionId !== sessionId || !Array.isArray(value.turns)) throw new Error("Invalid Grok session usage");
  const seen = new Set();
  return value.turns.flatMap(turn => {
    const at = Date.parse(turn.endedAt);
    if (!Number.isFinite(at) || !Number.isSafeInteger(turn.turnNumber) || turn.turnNumber < 1) throw new Error("Invalid Grok turn usage");
    if (at < sinceMs || at > untilMs || seen.has(turn.turnNumber)) return [];
    seen.add(turn.turnNumber);
    const usage = {
      totalTokens: turn.totalTokens, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
      cachedInputTokens: turn.cachedReadTokens ?? 0, cacheWriteInputTokens: turn.cacheCreationTokens ?? 0,
      reasoningOutputTokens: turn.reasoningTokens ?? 0,
    };
    if (Object.values(usage).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("Invalid Grok token counts");
    const costUsd = Number.isSafeInteger(turn.costUsdTicks) && turn.costUsdTicks >= 0 ? turn.costUsdTicks / 1e10 : undefined;
    return [{ responseId: `grok-usage-${sessionId}-${turn.turnNumber}`, usage, createdAt: at,
      model: typeof turn.primaryModelId === "string" ? turn.primaryModelId : null, provider: "xai",
      ...(costUsd !== undefined ? { costUsd } : {}) }];
  });
}

module.exports = { readGrokUsage, projectGrokUsage };
