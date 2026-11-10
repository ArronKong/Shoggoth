"use strict";

// Hot paths (context compile, compaction planning, per-turn scans) only read
// transcript events. A store that offers shared frozen views serves them
// without a deep copy; other stores and test doubles keep their own methods.
// Callers must not modify what these return.
function readEvents(store, profileId, sessionId) {
  return typeof store.eventsView === "function"
    ? store.eventsView(profileId, sessionId) : store.listEvents(profileId, sessionId);
}

// The store's reader for a model-context body, or null when it has none.
function contextReader(store) {
  const read = store.contextEventView ?? store.contextEvent;
  return typeof read === "function" ? read.bind(store) : null;
}

module.exports = { readEvents, contextReader };
