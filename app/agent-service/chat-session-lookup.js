"use strict";

// Memory and recall checks run on the Service loop many times per turn.
// Use ChatSessionStore's indexed lookups when present; stores without them
// (older doubles and read-only views) keep the original roster scan.
function findProfileSession(store, profileId, sessionId) {
  if (typeof store.findSessionById === "function") {
    const session = store.findSessionById(sessionId);
    return session?.profileId === profileId ? session : null;
  }
  return store.listSessions().find(session => session.id === sessionId && session.profileId === profileId) ?? null;
}

function listProfileSessions(store, profileId) {
  if (typeof store.listProfileSessions === "function") return store.listProfileSessions(profileId);
  return store.listSessions().filter(session => session.profileId === profileId);
}

module.exports = { findProfileSession, listProfileSessions };
