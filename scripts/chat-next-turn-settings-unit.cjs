"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { waitUntil } = require("./shoggoth-work-run-coordinator-unit.cjs");
const rpc = (f, method, params) => requestService(f.paths, { token: readClientToken(f.paths),
  version: PROTOCOL_VERSION, method, params });
const select = (f, session, runtime, model) => rpc(f, "chat.session.runtime.model.set", {
  profileId: f.profile.id, sessionKey: session.sessionKey, bindingId: f.binding(runtime).id,
  model, revision: f.service.chatSessionStore.getSession(session.sessionKey).revision, acceptAdjustments: true,
});

for (const runtime of ["codex", "pi", "deepseek-harness"]) test(`${runtime}: streaming picks leave current contract frozen and apply to the next turn`, async () => {
  const f = await openHandoffFixture({ catalogs: { codex: ["fixture-model", "next-model"],
    pi: ["fixture-model", "next-model"], "deepseek-harness": ["fixture-model", "next-model"] } });
  try {
    const session = f.createSession();
    if (runtime !== "codex") await f.switch(session.sessionKey, runtime);
    const first = await f.send(session.sessionKey, `first-${runtime}`);
    const frozen = structuredClone(f.service.workRunCoordinator.runExecutionContracts.get(first.id));
    const identity = f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId;
    for (const handle of f.transport.handles.values()) {
      const owner = handle.runtime === "codex" ? handle.host : handle;
      const method = handle.runtime === "codex" ? "modelList" : "modelsList";
      const list = owner[method];
      owner[method] = async params => { const page = await list(params); return { ...page, data: page.data.map(model => ({ ...model,
        capabilities: { thinkingOptions: ["low", "high"], thinkingDefault: "low", fastTier: "priority" } })) }; };
    }
    await select(f, session, runtime, "next-model");
    await rpc(f, "chat.session.permission.set", { sessionKey: session.sessionKey,
      mode: runtime === "pi" ? "full" : runtime === "deepseek-harness" ? "danger-full-access" : "full" });
    await rpc(f, "chat.session.settings.set", { sessionKey: session.sessionKey,
      patch: { thinkingLevel: "high", fastMode: true } });
    assert.deepEqual(f.service.workRunCoordinator.runExecutionContracts.get(first.id), frozen);
    assert.equal(f.service.workRunCoordinator.getRun(first.id).status, "running");
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).runtimeSessionId, identity);
    await f.complete(first, "answer before future settings");
    const second = await f.send(session.sessionKey, `second-${runtime}`);
    assert.equal(second.status, "running", second.errorCode);
    const next = f.service.workRunCoordinator.runExecutionContracts.get(second.id);
    assert.equal(next.defaultModel, "next-model");
    assert.deepEqual(next.modelSettings, { thinkingLevel: "high", serviceTier: "priority" });
    assert.notEqual(next.permissionMode, frozen.permissionMode);
    await f.complete(second);
  } finally { await f.close(); }
});

test("cross-Runtime model choice and later permission settings survive restart, then hand off once on the next send", async () => {
  let f = await openHandoffFixture({ catalogs: { codex: ["fixture-model"], pi: ["fixture-model", "pi-next", "pi-later"] } });
  try {
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "cross-first", "PRESERVE THIS HISTORY");
    const frozen = structuredClone(f.service.workRunCoordinator.runExecutionContracts.get(first.id));
    const selection = await select(f, session, "pi", "pi-next");
    assert.equal(selection.runtime, "pi");
    let saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.runtimeBindingId, f.binding("codex").id);
    assert.equal(saved.runtimeSessionId, first.runtimeSessionRef.sessionId);
    assert.equal(saved.nextRuntimeSelection.model, "pi-next");
    await rpc(f, "chat.session.permission.set", { sessionKey: session.sessionKey, mode: "full" });
    saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.nextRuntimeSelection.permissionMode, "full");
    await rpc(f, "chat.session.runtime.model.set", { profileId: f.profile.id, sessionKey: session.sessionKey,
      bindingId: f.binding("pi").id, model: "pi-later", revision: saved.revision, acceptAdjustments: false });
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).nextRuntimeSelection.permissionMode, "full",
      "a later model choice keeps the permission already selected for the next turn");
    assert.deepEqual(f.service.workRunCoordinator.runExecutionContracts.get(first.id), frozen);
    await f.complete(first, "FIRST ANSWER IS PRESERVED");
    const old = f; await old.close({ remove: false });
    f = await openHandoffFixture({ root: old.root, transport: old.transport,
      catalogs: { codex: ["fixture-model"], pi: ["fixture-model", "pi-next", "pi-later"] } });
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).nextRuntimeSelection.model, "pi-later");
    const second = await f.send(session.sessionKey, "cross-second");
    assert.equal(second.status, "running", second.errorCode);
    const next = f.service.workRunCoordinator.runExecutionContracts.get(second.id);
    assert.equal(next.runtime, "pi"); assert.equal(next.defaultModel, "pi-later");
    assert.equal(next.permissionMode, "full");
    assert.match(next.dynamicContext, /PRESERVE THIS HISTORY/u);
    assert.equal(f.service.chatSessionStore.getSession(session.sessionKey).nextRuntimeSelection, undefined);
    await f.complete(second);
  } finally { await f.close(); }
});

test("future permission edits during approval do not grant the outstanding request or invalidate its inherited restart contract", async () => {
  let f = await openHandoffFixture();
  try {
    // An inherited policy can differ from an explicit mode with the same name.
    f.service.productStore.putAgentProfile({ ...f.service.productStore.getAgentProfile(f.profile.id),
      permissionPolicy: { approvalPolicy: "on-failure", sandbox: "workspace-write" } });
    const session = f.createSession();
    const first = await f.send(session.sessionKey, "approval-first");
    const raw = f.transport.hosts.get("codex");
    const approval = raw.request("item/fileChange/requestApproval", { threadId: first.runtimeSessionRef.sessionId,
      turnId: first.runtimeTurnRef.turnId, itemId: "pending-change", startedAtMs: 1, grantRoot: null, reason: null }, "pending-request");
    await waitUntil(() => f.service.workRunCoordinator.getRun(first.id).status === "waiting_approval", 1000, "approval");
    await rpc(f, "chat.session.permission.set", { sessionKey: session.sessionKey, mode: "full" });
    assert.equal(f.service.workRunCoordinator.getRun(first.id).status, "waiting_approval");
    const old = f; await old.close({ remove: false });
    await approval;
    f = await openHandoffFixture({ root: old.root, transport: old.transport });
    await f.service.workRunCoordinator.waitForIdle(first.id);
    const restored = f.service.workRunCoordinator.getRun(first.id);
    assert.notEqual(restored.errorCode, "EXECUTION_BINDING_INVALID");
    assert.equal(raw.turnStartCalls, 1, "restart never replays the prompt");
  } finally { await f.close(); }
});
