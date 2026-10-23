"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");

// All state is fictional and private to each fixture. No Runtime, credentials,
// network, personal journal or SQLite dependency/link participates here.
const flush = () => new Promise(resolve => setImmediate(resolve));
const bindingA = "10000000-0000-4000-8000-000000000001", bindingB = "10000000-0000-4000-8000-000000000002";
const settings = { thinkingLevel: null, serviceTier: null };

function chatFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shoggoth-session-subscriptions-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  let clock = 10_000, operations = 0;
  const store = new ChatSessionStore({ paths, now: () => clock++,
    getProfileBinding: (profileId, id = bindingA) => ({ id, profileId, enabled: true, runtime: "codex",
      runtimeAccountId: id === bindingA ? "native-codex-default-v1" : "synthetic-account-b" }), ...options });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store,
    create(profileId = "profile-1") { return store.createSession({ operationId: `create-${++operations}`,
      profileId, workspace: "/fictional/workspace", createdAt: clock }); },
    ready(session) { const operation = store.requestBinding(session.sessionKey, `bind-${++operations}`, clock);
      return store.completeBinding(session.sessionKey, operation.operationId, `synthetic-thread-${operations}`); },
  };
}

function policyFixture(t) {
  const value = memoryFixture(); t.after(() => value.cleanup());
  const canonicalRoot = fs.realpathSync(value.root);
  const paths = Object.freeze(Object.fromEntries(Object.entries(value.paths).map(([key, target]) => [key,
    typeof target === "string" && (target === value.root || target.startsWith(value.root + path.sep))
      ? path.join(canonicalRoot, path.relative(value.root, target)) : target])));
  value.engine.recallPolicy.paths = paths;
  let itemNumber = 0;
  return { ...value, paths, policy: value.engine.recallPolicy,
    note({ content, validUntil = null } = {}) {
      itemNumber++;
      return value.engine.propose({ profileId: "profile-1", scope: "user", type: validUntil === null ? "semantic" : "temporary",
        content: content || `Fictional telescope preference ${itemNumber}`,
        sourceRefs: [`synthetic-event-${itemNumber}`, `synthetic-run-${itemNumber}`], classification: "explicit", validUntil });
    },
    reopen() { value.close(); value.definitions.open(); value.store.open(); value.engine.open(["profile-1"]); },
  };
}

test("chat subscriptions observe installed durable candidates and preserve the existing event hook", async t => {
  let writing = false, fixture, legacy = 0;
  fixture = chatFixture(t, { atomicWrite(...args) { writing = true; try { atomicWritePrivateFile(...args); } finally { writing = false; } },
    onSessionEvent(session, kind) { legacy++; assert.equal(kind, "session.created"); assert.equal(fixture.store.getSession(session.sessionKey).id, session.id); } });
  const first = [], second = [];
  fixture.store.subscribeChanges(event => {
    assert.equal(writing, false); assert.ok(fixture.store.getRevision() >= event.revision);
    assert.equal(fixture.store.getSession(event.current.sessionKey).id, event.current.sessionId);
    event.changedFields.push("mutated-recipient-copy"); first.push(event);
  });
  fixture.store.subscribeChanges(event => second.push(event));
  fixture.store.open(); const session = fixture.create();
  assert.equal(legacy, 1); assert.equal(first.length, 0); await flush();
  assert.equal(first.length, 1); assert.equal(second.length, 1);
  assert.deepEqual(second[0].current, { sessionId: session.id, profileId: session.profileId, sessionKey: session.sessionKey });
  assert.equal(second[0].previous, null); assert.equal(second[0].committed, true);
  assert.equal(second[0].changedFields.includes("mutated-recipient-copy"), false);
  assert.equal(JSON.stringify(second).includes("/fictional/workspace"), false);
});

test("chat notifications can reenter without overwriting the outer installed container", async t => {
  const f = chatFixture(t); f.store.open();
  let child, first = true;
  f.store.subscribeChanges(event => { assert.ok(f.store.getSession(event.current.sessionKey));
    if (first) { first = false; child = f.create("profile-2"); } });
  const parent = f.create(); await flush();
  assert.equal(f.store.listSessions().length, 2); assert.ok(f.store.getSession(parent.sessionKey)); assert.ok(f.store.getSession(child.sessionKey));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.store.filePath, "utf8")).sessions).length, 2);
});

test("chat listeners fail independently and unsubscribe or abort revoke queued delivery", async t => {
  const f = chatFixture(t); f.store.open(); const events = [], controller = new AbortController(), dead = new AbortController(); dead.abort();
  f.store.subscribeChanges(() => { throw Error("synthetic listener failure"); });
  f.store.subscribeChanges(async () => { throw Error("synthetic asynchronous listener failure"); });
  const stop = f.store.subscribeChanges(event => events.push(event));
  let aborted = 0; f.store.subscribeChanges(() => aborted++, { signal: controller.signal });
  f.store.subscribeChanges(() => { throw Error("pre-aborted listener must never run"); }, { signal: dead.signal });
  const session = f.create(); controller.abort(); await flush();
  assert.equal(events.length, 1); assert.equal(aborted, 0);
  f.store.setModelOverride(session.sessionKey, "PRIVATE-MODEL-LABEL"); stop(); stop(); await flush();
  assert.equal(events.length, 1); assert.equal(f.store.getSession(session.sessionKey).modelOverride, "PRIVATE-MODEL-LABEL");
});

test("chat metadata, binding, runtime switch, archive and deletion include former and current identities", async t => {
  const f = chatFixture(t), events = []; f.store.open(); f.store.subscribeChanges(event => events.push(event));
  let session = f.create(); await flush(); events.length = 0;
  session = f.ready(session); await flush();
  assert.ok(events.some(event => event.changedFields.includes("runtimeSessionId")));
  f.store.setModelOverride(session.sessionKey, "PRIVATE-MODEL"); f.store.setPermissionMode(session.sessionKey, "acceptEdits");
  f.store.setModelSettings(session.sessionKey, { thinkingLevel: "high", serviceTier: null }); await flush();
  assert.ok(events.some(event => event.changedFields.includes("modelOverride")));
  assert.ok(events.some(event => event.changedFields.includes("permissionMode")));
  assert.ok(events.some(event => event.changedFields.includes("modelSettings")));
  assert.equal(JSON.stringify(events).includes("PRIVATE-MODEL"), false);
  session = f.store.getSession(session.sessionKey);
  f.store.switchRuntime(session.sessionKey, { bindingId: bindingB, revision: session.revision }); await flush();
  assert.ok(events.some(event => event.changedFields.includes("runtimeBindingId")));
  f.store.markRuntimeSwitchAudited(session.sessionKey, f.store.getSession(session.sessionKey).revision);
  session = f.ready(f.store.getSession(session.sessionKey));
  f.store.requestArchive(session.sessionKey, "archive-1", session.updatedAt); f.store.completeRemoteOperation("archive-1"); await flush();
  assert.equal(f.store.getSession(session.sessionKey).status, "archived");
  f.store.requestDelete(session.sessionKey, "delete-1", session.updatedAt); f.store.completeRemoteOperation("delete-1"); await flush();
  const removal = events.findLast(event => event.current === null);
  assert.deepEqual(removal.previous, { sessionId: session.id, profileId: session.profileId, sessionKey: session.sessionKey });
  assert.deepEqual(removal.profileIds, ["profile-1"]); assert.equal(f.store.getSession(session.sessionKey), null);
});

test("chat native import and full Profile purge invalidate the affected Profile", async t => {
  const f = chatFixture(t), events = []; f.store.open(); f.store.subscribeChanges(event => events.push(event));
  const sessionKey = crypto.randomUUID();
  const imported = f.store.importRuntimeSession({ sessionKey, profileId: "profile-2", runtimeBindingId: bindingA,
    runtimeSessionId: "synthetic-imported-thread", workspace: "/fictional/import", title: "PRIVATE-TITLE", modelOverride: null, modelSettings: settings });
  await flush(); assert.equal(events.length, 1); assert.equal(events[0].current.sessionId, imported.id);
  assert.deepEqual(events[0].profileIds, ["profile-2"]); assert.equal(JSON.stringify(events).includes("PRIVATE-TITLE"), false);
  f.store.purgeProfile("profile-2"); await flush(); assert.equal(events.length, 2);
  assert.equal(events[1].current, null); assert.equal(events[1].previous.sessionKey, sessionKey);
});

test("committed cleanup failures invalidate cron classification only after the durable candidate is installed", async t => {
  let fixture;
  fixture = chatFixture(t, { atomicWrite(...args) { atomicWritePrivateFile(...args); throw Object.assign(Error("synthetic committed cleanup"), { committed: true }); },
    onSessionEvent(session) { fixture.store.getCronSessionOrigin(session.sessionKey); } });
  const events = []; fixture.store.open(); fixture.store.subscribeChanges(event => {
    if (event.cronClassificationChanged) assert.equal(fixture.store.getCronSessionOrigin(event.current.sessionKey).cronJobId, "synthetic-job");
    events.push(event);
  });
  const session = fixture.store.ensureCronSession({ runId: "synthetic-run", jobId: "synthetic-job", profileId: "profile-1",
    workspace: "/fictional/cron", threadSource: "synthetic-cron-source", runtimeSessionId: null });
  assert.equal(fixture.store.getCronSessionOrigin(session.sessionKey).cronJobId, "synthetic-job"); await flush();
  assert.equal(events.length, 2); assert.equal(events[0].previous, null); assert.equal(events[1].cronClassificationChanged, true);
  assert.equal(events[1].changedFields.length, 0); assert.equal(JSON.stringify(events).includes("synthetic-cron-source"), false);
});

for (const outcome of ["failed", "uncertain"]) {
  test(`chat ${outcome} writes do not emit successful changes`, async t => {
    const f = chatFixture(t, { atomicWrite(...args) {
      if (outcome === "uncertain") atomicWritePrivateFile(...args);
      throw Object.assign(Error(`synthetic ${outcome} write`), outcome === "uncertain" ? { committedUncertain: true } : {});
    } });
    const events = []; f.store.open(); f.store.subscribeChanges(event => events.push(event));
    assert.throws(() => f.create(), { code: outcome === "uncertain" ? "CHAT_SESSION_COMMIT_UNCERTAIN" : "CHAT_SESSION_WRITE_FAILED" });
    await flush(); assert.equal(events.length, 0);
    if (outcome === "failed") assert.equal(f.store.listSessions().length, 0);
    else { f.store.close(); f.store.atomicWrite = atomicWritePrivateFile; f.store.open(); await flush();
      assert.equal(f.store.listSessions().length, 1); assert.equal(events.length, 0); }
  });
}

test("chat close and reopen discard queued events and previous subscriptions", async t => {
  const f = chatFixture(t), old = [], fresh = []; f.store.open(); f.store.subscribeChanges(event => old.push(event));
  f.create(); f.store.close(); f.store.subscribeChanges(event => fresh.push(event)); f.store.open(); await flush();
  assert.equal(old.length, 0); assert.equal(fresh.length, 0);
  const session = f.create(); await flush(); assert.equal(old.length, 0); assert.equal(fresh.length, 1);
  assert.equal(fresh[0].current.sessionId, session.id);
});

test("closing from a chat listener revokes remaining queued deliveries", async t => {
  const f = chatFixture(t); f.store.open(); let second = 0;
  f.store.subscribeChanges(() => f.store.close()); f.store.subscribeChanges(() => second++);
  f.create(); await flush(); assert.equal(second, 0); f.store.open();
});

test("policy withdrawal subscribers receive committed Profile metadata and preserve setOnChange", async t => {
  const f = policyFixture(t), first = [], second = [], callbackProfiles = [];
  f.policy.setOnChange(profile => callbackProfiles.push(profile));
  f.policy.subscribeChanges(event => { assert.ok(f.policy.getRevision(event.profileId) >= event.revision);
    event.reason = "recipient-copy"; first.push(event); });
  f.policy.subscribeChanges(event => second.push(event));
  const item = f.note({ content: "PRIVATE-FICTIONAL-MEMORY-BODY" });
  f.engine.delete({ profileId: item.profileId, id: item.id, reason: "forgotten", operationId: "synthetic-forget" });
  assert.deepEqual(callbackProfiles, ["profile-1"]); assert.equal(first.length, 0); await flush();
  assert.equal(second.length, 1); assert.equal(second[0].reason, "forgotten"); assert.equal(second[0].change, "withdrawal");
  assert.equal(second[0].committed, true); assert.equal(JSON.stringify(second).includes(item.content), false);
  assert.equal(JSON.stringify(second).includes(item.id), false); assert.equal(JSON.stringify(second).includes("synthetic-event"), false);
});

test("policy listeners fail independently and callback failures retain indexPending", async t => {
  const f = policyFixture(t), events = [];
  f.policy.setOnChange(() => { throw Error("synthetic derived-index failure"); });
  f.policy.subscribeChanges(() => { throw Error("synthetic policy listener failure"); });
  f.policy.subscribeChanges(async () => { throw Error("synthetic asynchronous policy listener failure"); });
  f.policy.subscribeChanges(event => events.push(event));
  const item = f.note(); f.engine.delete({ profileId: item.profileId, id: item.id, reason: "user_deleted", operationId: "synthetic-delete" });
  await flush(); assert.equal(events.length, 1); assert.equal(f.policy.getStatus("profile-1").indexPending, true);
  assert.equal(f.store.get("profile-1", item.id).status, "deleted");
});

test("the existing policy callback may reenter without changing committed event revisions", async t => {
  const f = policyFixture(t), events = [], outer = f.note(), nested = f.note({ content: "Fictional orchard preference" });
  const before = f.policy.getRevision("profile-1"); let entered = false;
  f.policy.subscribeChanges(event => events.push(event));
  f.policy.setOnChange(() => { if (!entered) { entered = true;
    f.policy.recordReason({ profileId: nested.profileId, item: nested, reason: "user_deleted", operationId: "synthetic-nested-policy" }); } });
  f.policy.recordReason({ profileId: outer.profileId, item: outer, reason: "forgotten", operationId: "synthetic-outer-policy" });
  await flush(); assert.deepEqual(events.map(event => event.revision), [before + 1, before + 2]);
});

test("policy expiry intent and primary commit proofs notify without suppressing callback changes", async t => {
  const f = policyFixture(t), events = [], callbacks = []; f.policy.setOnChange(profile => callbacks.push(profile));
  f.policy.subscribeChanges(event => events.push(event));
  const item = f.note({ validUntil: 100_000 }), operationId = "synthetic-expiry";
  f.policy.recordReason({ profileId: item.profileId, item, reason: "expired", operationId });
  const deleted = f.store.upsert({ ...item, status: "deleted", updatedAt: item.updatedAt + 1 });
  f.policy.recordExpiryCommit({ profileId: item.profileId, item: deleted, operationId }); await flush();
  assert.equal(events.length, 2); assert.ok(events.every(event => event.change === "expiry" && event.reason === "expired"));
  assert.deepEqual(callbacks, []);
  f.policy.recordReason({ profileId: item.profileId, item: deleted, reason: "expired", operationId });
  f.policy.recordExpiryCommit({ profileId: item.profileId, item: deleted, operationId }); await flush(); assert.equal(events.length, 2);
});

test("policy supplemental withdrawal sources notify only when a new durable repair is added", async t => {
  const f = policyFixture(t), events = [], item = f.note(), operationId = "synthetic-forget-repair";
  f.policy.subscribeChanges(event => events.push(event));
  f.policy.recordReason({ profileId: item.profileId, item, reason: "forgotten", operationId }); await flush();
  const input = { profileId: item.profileId, item, reason: "forgotten", operationId, revocationSourceRefs: ["synthetic-request", "synthetic-request-run"] };
  f.policy.recordReason(input); await flush(); assert.equal(events.length, 2); assert.equal(events[1].revision, events[0].revision + 1);
  f.policy.recordReason(input); await flush(); assert.equal(events.length, 2);
});

test("policy unsubscribe and AbortSignal revoke delivery independently", async t => {
  const f = policyFixture(t), controller = new AbortController(), dead = new AbortController(); dead.abort(); let seen = 0;
  const stop = f.policy.subscribeChanges(() => seen++); f.policy.subscribeChanges(() => seen++, { signal: controller.signal });
  f.policy.subscribeChanges(() => seen++, { signal: dead.signal });
  const item = f.note(); f.policy.recordReason({ profileId: item.profileId, item, reason: "forgotten", operationId: "synthetic-cancelled-delivery" });
  stop(); stop(); controller.abort(); await flush(); assert.equal(seen, 0);
});

test("policy close and reopen discard prior committed delivery and subscriptions", async t => {
  const f = policyFixture(t), old = [], fresh = [], item = f.note(); f.policy.subscribeChanges(event => old.push(event));
  f.engine.delete({ profileId: item.profileId, id: item.id, reason: "forgotten", operationId: "synthetic-close" });
  f.reopen(); f.policy.subscribeChanges(event => fresh.push(event)); await flush(); assert.equal(old.length, 0); assert.equal(fresh.length, 0);
  const later = f.note({ content: "Fictional orchard preference" });
  f.engine.delete({ profileId: later.profileId, id: later.id, reason: "forgotten", operationId: "synthetic-reopened" });
  await flush(); assert.equal(old.length, 0); assert.equal(fresh.length, 1);
});

for (const outcome of ["failed", "uncertain"]) {
  test(`policy ${outcome} journal append cannot masquerade as a committed change`, async t => {
    const f = policyFixture(t), events = [], item = f.note(), log = path.join(f.paths.agentsDir, item.profileId, "memory", "recall-policy.jsonl");
    const ino = fs.statSync(log).ino; f.policy.subscribeChanges(event => events.push(event));
    f.policy.fs = { ...fs,
      ...(outcome === "failed" ? { writeSync(fd, ...args) { if (fs.fstatSync(fd).ino === ino) throw Error("synthetic journal write failed"); return fs.writeSync(fd, ...args); } }
        : { fsyncSync(fd) { fs.fsyncSync(fd); if (fs.fstatSync(fd).ino === ino) throw Object.assign(Error("synthetic unknown fsync result"), { committedUncertain: true }); } }),
    };
    assert.throws(() => f.engine.delete({ profileId: item.profileId, id: item.id, reason: "forgotten", operationId: `synthetic-${outcome}` }), { code: "RECALL_POLICY_UNAVAILABLE" });
    await flush(); assert.equal(events.length, 0); f.policy.fs = fs;
    if (outcome === "uncertain") { f.reopen(); await flush(); assert.equal(events.length, 0); assert.equal(f.store.get(item.profileId, item.id).status, "deleted"); }
  });
}

test("full Profile installation removal invalidates subscribers after directory fsync", async t => {
  const f = policyFixture(t), events = []; f.policy.subscribeChanges(event => events.push(event));
  f.policy.forgetProfile("profile-1"); assert.equal(events.length, 0); await flush();
  assert.deepEqual(events, [{ type: "recall-policy.changed", profileId: "profile-1", revision: null,
    change: "profile-forgotten", reason: null, committed: true }]);
});

test("both stores reject invalid listeners and invalid cancellation handles", t => {
  const f = chatFixture(t), p = policyFixture(t);
  for (const store of [f.store, p.policy]) {
    assert.throws(() => store.subscribeChanges(null), TypeError);
    assert.throws(() => store.subscribeChanges(() => {}, { signal: {} }), TypeError);
  }
});
