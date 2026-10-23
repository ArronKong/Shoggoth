"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { resolveServicePaths } = require("../app/agent-service/paths");

const tests = [];
function test(name, run) { tests.push({ name, run }); }
const drain = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-transcript-changes-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  const stores = [];
  return {
    paths,
    create() {
      const store = new TranscriptStore({ paths, now: () => 1234, ...options });
      stores.push(store); store.open(); return store;
    },
    cleanup() {
      for (const store of stores) store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function append(store, id = "event-1", overrides = {}) {
  return store.appendEvent({ profileId: "profile-1", sessionId: "session-1", id,
    runId: "run-1", kind: "user", content: { text: "private synthetic transcript body" },
    runtimeRef: null, contextExcluded: false, occurredAt: 1234, ...overrides });
}

test("notification follows journal fsync, manifest commit and current file identities", async () => {
  const trace = [], descriptors = new Map();
  const injectedFs = new Proxy(fs, { get(target, key) {
    if (key === "openSync") return (file, ...args) => {
      const fd = target.openSync(file, ...args); descriptors.set(fd, file); return fd;
    };
    if (key === "closeSync") return fd => { target.closeSync(fd); descriptors.delete(fd); };
    if (key === "fsyncSync") return fd => {
      target.fsyncSync(fd);
      const file = descriptors.get(fd);
      if (file?.endsWith("events.jsonl")) trace.push("journal-fsync");
      if (file?.endsWith(path.join("transcripts", "session-1"))) trace.push("manifest-parent-fsync");
    };
    if (key === "renameSync") return (from, to) => {
      target.renameSync(from, to);
      if (to.endsWith("manifest.json")) trace.push("manifest-rename");
    };
    return Reflect.get(target, key);
  } });
  const f = fixture({ fs: injectedFs });
  try {
    const store = f.create(), changes = [];
    store.subscribeChanges(change => {
      // These reads revalidate the cached journal and manifest identities.
      const snapshot = store.getIndexSnapshot(change.profileId, change.sessionId);
      assert.equal(snapshot.revision, change.revision);
      assert.equal(snapshot.lastSeq, change.lastEventSeq);
      assert.equal(snapshot.sourceIdentity, change.sourceIdentity);
      assert.equal(store.getEvent(change.profileId, change.sessionId, change.eventId).id, change.eventId);
      const manifest = JSON.parse(fs.readFileSync(path.join(f.paths.agentsDir,
        change.profileId, "transcripts", change.sessionId, "manifest.json"), "utf8"));
      assert.equal(manifest.revision, change.revision);
      trace.push("listener"); changes.push(change);
    });
    append(store);
    assert.equal(changes.length, 0, "listeners run after the append caller returns");
    await drain();
    assert.deepEqual(trace, ["journal-fsync", "manifest-rename", "manifest-parent-fsync", "listener"]);
    assert.equal(changes.length, 1);
    assert.deepEqual(Object.keys(changes[0]).sort(),
      ["eventId", "lastEventSeq", "profileId", "revision", "sessionId", "sourceIdentity", "type"]);
    assert.equal(Object.isFrozen(changes[0]), true);
    assert.equal(JSON.stringify(changes).includes("private synthetic transcript body"), false);
  } finally { f.cleanup(); }
});

test("append and context commits keep ordered durable revision identities; no-ops do not notify", async () => {
  const f = fixture();
  try {
    const store = f.create(), changes = [];
    store.subscribeChanges(change => changes.push(change));
    append(store, "first"); append(store, "first"); append(store, "second");
    store.setContextExcluded({ profileId: "profile-1", sessionId: "session-1",
      eventId: "first", contextExcluded: false });
    store.setContextExcluded({ profileId: "profile-1", sessionId: "session-1",
      eventId: "first", contextExcluded: true });
    store.setContextExcluded({ profileId: "profile-1", sessionId: "session-1",
      eventId: "first", contextExcluded: true });
    assert.throws(() => append(store, "first", { content: { text: "conflicting body" } }),
      error => error.code === "TRANSCRIPT_EVENT_CONFLICT");
    append(store, "other-profile", { profileId: "profile-2", sessionId: "session-2" });
    await drain();
    assert.deepEqual(changes.map(({ type, profileId, sessionId, eventId, revision, lastEventSeq }) =>
      [type, profileId, sessionId, eventId, revision, lastEventSeq]), [
      ["event.append", "profile-1", "session-1", "first", 1, 1],
      ["event.append", "profile-1", "session-1", "second", 2, 2],
      ["event.context.set", "profile-1", "session-1", "first", 3, 2],
      ["event.append", "profile-2", "session-2", "other-profile", 1, 1],
    ]);
    assert.equal(new Set(changes.slice(0, 3).map(change => change.sourceIdentity)).size, 3);
    assert.equal(changes[2].sourceIdentity, store.getIndexSnapshot("profile-1", "session-1").sourceIdentity);
  } finally { f.cleanup(); }
});

test("unsubscribe drops queued changes and resubscribing the same listener does not replay them", async () => {
  const f = fixture();
  try {
    const store = f.create(), changes = [], listener = change => changes.push(change);
    const unsubscribe = store.subscribeChanges(listener);
    append(store, "old"); unsubscribe(); unsubscribe();
    const nextUnsubscribe = store.subscribeChanges(listener);
    await drain(); assert.deepEqual(changes, []);
    append(store, "new"); await drain();
    assert.deepEqual(changes.map(change => change.eventId), ["new"]);
    nextUnsubscribe();
  } finally { f.cleanup(); }
});

test("AbortSignal cancels queued delivery and close removes its abort listener", async () => {
  const f = fixture();
  try {
    const store = f.create(), changes = [], controller = new AbortController();
    const aborted = new AbortController(); aborted.abort();
    store.subscribeChanges(change => changes.push(change), { signal: aborted.signal })();
    store.subscribeChanges(change => changes.push(change), { signal: controller.signal });
    append(store, "aborted"); controller.abort(); await drain();
    assert.deepEqual(changes, []);
    const lifetime = new AbortController();
    const nativeRemove = lifetime.signal.removeEventListener.bind(lifetime.signal);
    let removed = 0;
    lifetime.signal.removeEventListener = (...args) => { removed += 1; return nativeRemove(...args); };
    store.subscribeChanges(change => changes.push(change), { signal: lifetime.signal });
    append(store, "closed"); store.close();
    assert.equal(removed, 1); lifetime.abort(); await drain();
    assert.deepEqual(changes, []);
  } finally { f.cleanup(); }
});

test("close/reopen invalidates old subscriptions and queued commits without notifying replay", async () => {
  const f = fixture();
  try {
    const store = f.create(), changes = [], listener = change => changes.push(change);
    store.subscribeChanges(listener); append(store, "old-lifetime"); store.close(); store.open();
    store.subscribeChanges(listener);
    store.ensureSession({ profileId: "profile-1", sessionId: "session-1" });
    assert.equal(store.listEvents("profile-1", "session-1").length, 1);
    store.forgetProfile("profile-1"); store.listEvents("profile-1", "session-1");
    await drain(); assert.deepEqual(changes, []);
    append(store, "new-lifetime"); await drain();
    assert.deepEqual(changes.map(change => [change.eventId, change.revision]), [["new-lifetime", 2]]);
  } finally { f.cleanup(); }
});

test("throwing/rejecting listeners cannot poison commits; reentrant writes notify normally", async () => {
  const f = fixture(), rejections = [];
  const onRejection = error => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    const store = f.create(), changes = [];
    store.subscribeChanges(() => { throw new Error("synthetic listener failure"); });
    store.subscribeChanges(async () => { throw new Error("synthetic async listener failure"); });
    store.subscribeChanges(change => {
      assert.throws(() => { change.revision = 9000; }, TypeError);
      changes.push(change);
      if (change.eventId === "first") append(store, "reentrant");
    });
    assert.equal(append(store, "first").seq, 1); await drain();
    assert.deepEqual(changes.map(change => change.eventId), ["first", "reentrant"]);
    assert.equal(store.getRevision("profile-1", "session-1"), 2);
    assert.equal(store.poisonError, null);
    assert.deepEqual(rejections, []);
  } finally { process.off("unhandledRejection", onRejection); f.cleanup(); }
});

test("a listener can unsubscribe another listener before the same queued commit is delivered", async () => {
  const f = fixture();
  try {
    const store = f.create(); let first = 0, second = 0, stopSecond;
    store.subscribeChanges(() => { first += 1; stopSecond(); });
    stopSecond = store.subscribeChanges(() => { second += 1; });
    append(store); await drain(); assert.equal(first, 1); assert.equal(second, 0);
  } finally { f.cleanup(); }
});

test("failure before journal write emits no change and permits a later successful commit", async () => {
  let failOpen = true;
  const injectedFs = new Proxy(fs, { get(target, key) {
    if (key !== "openSync") return Reflect.get(target, key);
    return (file, flags, ...args) => {
      if (failOpen && file.endsWith("events.jsonl") && (flags & fs.constants.O_APPEND)) {
        failOpen = false; throw Object.assign(new Error("synthetic open failure"), { code: "EIO" });
      }
      return target.openSync(file, flags, ...args);
    };
  } });
  const f = fixture({ fs: injectedFs });
  try {
    const store = f.create(), changes = []; store.subscribeChanges(change => changes.push(change));
    assert.throws(() => append(store, "failed"), error => error.code === "EIO");
    await drain(); assert.deepEqual(changes, []); assert.equal(store.poisonError, null);
    append(store, "successful"); await drain();
    assert.deepEqual(changes.map(change => [change.eventId, change.revision]), [["successful", 1]]);
  } finally { f.cleanup(); }
});

for (const failureStage of ["journal-fsync", "manifest-rename", "file-identity"]) {
  test(`${failureStage} uncertainty emits no success or recovery replay notification`, async () => {
    let fail = true;
    const descriptors = new Map();
    const injectedFs = new Proxy(fs, { get(target, key) {
      if (key === "openSync") return (file, ...args) => {
        const fd = target.openSync(file, ...args); descriptors.set(fd, file); return fd;
      };
      if (key === "closeSync") return fd => { target.closeSync(fd); descriptors.delete(fd); };
      if (key === "fsyncSync") return fd => {
        target.fsyncSync(fd);
        if (fail && failureStage === "journal-fsync" && descriptors.get(fd)?.endsWith("events.jsonl")) {
          fail = false; throw new Error("synthetic post-fsync uncertainty");
        }
      };
      if (key === "renameSync") return (from, to) => {
        if (fail && failureStage === "manifest-rename" && to.endsWith("manifest.json")) {
          fail = false; throw new Error("synthetic manifest uncertainty");
        }
        return target.renameSync(from, to);
      };
      return Reflect.get(target, key);
    } });
    const f = fixture({ fs: injectedFs });
    try {
      let store = f.create(); const changes = [];
      store.subscribeChanges(change => changes.push(change));
      if (failureStage === "file-identity") {
        const writeManifest = store._writeManifest.bind(store), identity = store._fileIdentity.bind(store);
        let afterManifest = false;
        store._writeManifest = state => { writeManifest(state); afterManifest = true; };
        store._fileIdentity = file => {
          if (fail && afterManifest) { fail = false; throw new Error("synthetic identity uncertainty"); }
          return identity(file);
        };
      }
      assert.throws(() => append(store, "uncertain"), error => error.code === "TRANSCRIPT_COMMIT_UNCERTAIN"
        && error.committedUncertain === true);
      assert.throws(() => append(store, "blocked"), error => error.code === "TRANSCRIPT_COMMIT_UNCERTAIN");
      await drain(); assert.deepEqual(changes, []); store.close();
      store = f.create(); store.subscribeChanges(change => changes.push(change));
      assert.equal(store.getRevision("profile-1", "session-1"), 1);
      assert.deepEqual(store.listEvents("profile-1", "session-1").map(event => event.id), ["uncertain"]);
      await drain(); assert.deepEqual(changes, [], "recovery repairs metadata without announcing a new write");
      append(store, "after-replay"); await drain();
      assert.deepEqual(changes.map(change => [change.eventId, change.revision]), [["after-replay", 2]]);
    } finally { f.cleanup(); }
  });
}

test("subscriptions validate lifecycle and listener/signal contract", async () => {
  const f = fixture();
  try {
    const store = f.create();
    assert.throws(() => store.subscribeChanges(null), TypeError);
    assert.throws(() => store.subscribeChanges(() => {}, { signal: {} }), TypeError);
    store.close();
    assert.throws(() => store.subscribeChanges(() => {}), error => error.code === "TRANSCRIPT_STORE_CLOSED");
  } finally { f.cleanup(); }
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`ok - ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`not ok - ${name}`); console.error(error); }
  }
  if (passed === tests.length) console.log(`${passed}/${tests.length} transcript change tests passed`);
})();
