"use strict";
// A model pick: the CLI catalog check is reused briefly, picking the model already
// in use prepares no runtime hand-off, and a pick that needs one becomes the next
// turn's choice that the next send applies.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createSessionRuntimeController } = require("../app/agent-service/session-runtime-controller");

function fixture() {
  const profile = { id: "profile-fixture", agentId: "shoggoth-fixture", enabled: true,
    permissionPolicy: { approvalPolicy: "never", sandbox: "danger-full-access" }, defaultModel: null };
  const binding = { id: "11111111-1111-4111-8111-111111111111", profileId: profile.id, revision: 1,
    runtime: "opencode", runtimeProfileId: "runtime-fixture", runtimeAccountId: "native-opencode-default-v1", enabled: true };
  const other = { ...binding, id: "22222222-2222-4222-8222-222222222222", runtime: "grok-build",
    runtimeAccountId: "native-grok-build-default-v1" };
  let session = { id: "44444444-4444-4444-8444-444444444444", sessionKey: "33333333-3333-4333-8333-333333333333",
    profileId: profile.id, runtimeBindingId: binding.id, runtimeSessionId: "native-thread", status: "ready",
    revision: 1, permissionMode: null, modelOverride: "model-a", workspace: "/fixture" };
  const bindings = { bindings: [binding, other], revision: 1, defaultBindingId: binding.id };
  const catalogReads = [], handoffs = [], switches = [];
  let generation = 0, authenticated = true;
  const controller = createSessionRuntimeController({
    productStore: {
      getAgentProfile: () => profile, getAgentRuntimeBindings: () => bindings,
      getAgentRuntimeBinding: (_profileId, id) => bindings.bindings.find(entry => entry.id === id),
      resolveAgentRuntimeProfile: (_profileId, id) => ({ ...profile, ...bindings.bindings.find(entry => entry.id === id), id: profile.id }),
    },
    chatSessionStore: {
      getSession: () => session, getBinding: () => null,
      switchRuntime(_key, change) {
        switches.push(change);
        const { nextRuntimeSelection: _next, ...settled } = session;
        session = { ...settled, runtimeBindingId: change.bindingId, revision: session.revision + 1,
          modelOverride: change.model ?? session.modelOverride,
          ...(change.renewSession ? { runtimeSessionId: null, status: "draft" } : {}) };
        return session;
      },
      dropRuntimeSelection(_key, { revision }) {
        assert.equal(revision, session.revision);
        const { nextRuntimeSelection: _next, ...settled } = session;
        session = { ...settled, revision: session.revision + 1 };
        return session;
      },
      queueRuntimeSelection(_key, next) {
        assert.equal(next.revision, session.revision);
        const { revision: _revision, ...selection } = next;
        session = { ...session, nextRuntimeSelection: selection, revision: session.revision + 1 };
        return session;
      },
    },
    coordinator: {
      getRuntimeContext: () => null, isSessionBusy: () => false, listSessionRuns: () => [],
      canSelectSessionBeforeSend: () => true,
      async prepareRuntimeHandoff(_session, target, options) { handoffs.push({ target: target.id, model: options.model }); },
    },
    facts: {
      async read() { return { installed: true, authenticated, releaseEnabled: true, permissionEnforcementProven: true }; },
      generation: () => generation,
    },
    async listBindingModels({ bindingId }) {
      catalogReads.push(bindingId);
      return { models: [{ id: "model-a" }, { id: "model-b" }], hasMore: false, nextCursor: null };
    },
    getNativeRuntimeConfig: () => ({ flags: { runtimeConversationHandoff: true } }),
  });
  const pick = (model, bindingId = binding.id) => controller.handle("chat.session.runtime.model.set", {
    profileId: profile.id, sessionKey: session.sessionKey, bindingId, model, revision: session.revision, acceptAdjustments: true,
  });
  const send = () => controller.selectForSend({ sessionKey: session.sessionKey });
  return { binding, other, catalogReads, handoffs, switches, pick, send, session: () => session,
    bumpGeneration: () => { generation += 1; }, bumpBinding: () => { binding.revision += 1; },
    setAuthenticated: value => { authenticated = value; } };
}

test("a recent catalog check is reused for the same Binding revision and account generation", async () => {
  const f = fixture();
  await f.pick("model-b");
  await f.pick("model-a");
  await f.pick("model-b");
  assert.deepEqual(f.catalogReads, [f.binding.id, f.binding.id], "each model is read once, then reused");
  f.bumpGeneration();
  await f.pick("model-a");
  assert.equal(f.catalogReads.length, 3, "an account change reads the catalog again");
  f.bumpBinding();
  await f.pick("model-b");
  assert.equal(f.catalogReads.length, 4, "a Binding change reads the catalog again");
  await assert.rejects(f.pick("model-missing"), { code: "MODEL_ROUTE_UNSUPPORTED" });
  await assert.rejects(f.pick("model-missing"), { code: "MODEL_ROUTE_UNSUPPORTED" });
  assert.equal(f.catalogReads.length, 6, "a missing model is never answered from reuse");
});

test("picking the model already in use prepares no hand-off", async () => {
  const f = fixture();
  await f.pick("model-a");
  assert.deepEqual(f.handoffs, [], "the same model on the same Binding renews nothing");
  assert.equal(f.session().nextRuntimeSelection, undefined);
});

test("a pick that needs a hand-off returns at once and the next send applies it", async () => {
  const f = fixture();
  await f.pick("model-b");
  assert.deepEqual(f.handoffs, [], "the pick prepares no hand-off");
  assert.deepEqual(f.switches, [], "the pick keeps the native session until the next send");
  assert.equal(f.session().nextRuntimeSelection.model, "model-b");
  assert.equal(f.session().runtimeSessionId, "native-thread");
  await f.pick("model-b", f.other.id);
  assert.equal(f.session().nextRuntimeSelection.bindingId, f.other.id, "a later pick replaces the queued one");
  assert.deepEqual(f.handoffs, []);
  await f.send();
  assert.deepEqual(f.handoffs, [{ target: f.other.id, model: "model-b" }], "the send prepares the hand-off");
  assert.equal(f.switches.at(-1).renewSession, true, "and renews the native session on the picked Runtime");
  assert.equal(f.session().runtimeBindingId, f.other.id);
  assert.equal(f.session().nextRuntimeSelection, undefined);
});

test("picking the current model again drops a queued choice", async () => {
  const f = fixture();
  await f.pick("model-b");
  assert.equal(f.session().nextRuntimeSelection.model, "model-b");
  await f.pick("model-a");
  assert.equal(f.session().nextRuntimeSelection, undefined, "the conversation stays on its current model");
  assert.equal(f.session().runtimeSessionId, "native-thread");
  assert.deepEqual(f.handoffs, []);
});

test("a send drops a queued pick that cannot run and keeps one that may succeed later", async () => {
  const f = fixture();
  await f.pick("model-b", f.other.id);
  f.setAuthenticated("unknown");
  await assert.rejects(f.send(), { code: "ACCOUNT_AUTH_UNKNOWN" });
  assert.equal(f.session().nextRuntimeSelection?.bindingId, f.other.id, "an unconfirmed sign-in keeps the pick for a retry");
  f.setAuthenticated(false);
  await assert.rejects(f.send(), { code: "ACCOUNT_NOT_AUTHENTICATED" });
  assert.equal(f.session().nextRuntimeSelection, undefined, "a signed-out target is dropped");
  assert.equal(f.session().runtimeBindingId, f.binding.id, "the conversation stays on its current Runtime");
  assert.equal(f.session().runtimeSessionId, "native-thread");
  assert.deepEqual(f.handoffs, []);
});
