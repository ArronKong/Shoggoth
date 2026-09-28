"use strict";

// A Runtime renewal retires the native session and returns the product
// session to draft. Its verified transcript remains a valid historical source.
function isHistoricalChatSession(session) {
  return session?.status === "ready" || session?.status === "archived"
    || (session?.status === "draft" && session.runtimeSessionId === null
      && Array.isArray(session.retiredRuntimeSessions)
      && session.retiredRuntimeSessions.length > 0);
}

module.exports = { isHistoricalChatSession };
