"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager } = require("./shoggoth-work-run-coordinator-unit.cjs");
const { CHAT_PERMISSION_MODES: MODES, resolveRuntimePermissionMode, adapterPermissionMode } =
  require("../app/agent-service/runtime-permission-modes");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { createSessionRuntimeController } = require("../app/agent-service/session-runtime-controller");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-unified-permissions-"));
async function fixture(runtime, permissionMode) {
  const host = new FakeHost([]);
  const manager = directRuntimeManager(host, runtime);
  const acquire = manager.acquire;
  const acquisitions = [];
  manager.acquire = (binding, options) => {
    acquisitions.push(options);
    return acquire(binding, options);
  };
  const value = await openFixture({ runtime, permissionMode, host, runtimeManager: manager, sessionWorkspace: root });
  const { ack } = await sendAndDrain(value, { operationId: `unified-${runtime}-${permissionMode}` });
  const run = value.coordinator.getRun(ack.run.id);
  assert.equal(run.status, "running");
  return { ...value, run, acquisitions,
    params: { threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      itemId: "permission-test", cwd: root } };
}
async function mustAsk(value, method, extra = {}) {
  const response = value.host.request(method, { ...value.params, ...extra });
  const run = value.coordinator.getRun(value.run.id);
  assert.equal(run.status, "waiting_approval");
  await value.coordinator.respondApproval({ operationId: `deny-${run.waitingRequestId}`,
    runId: run.id, requestId: run.waitingRequestId, choice: "deny" });
  assert.deepEqual(await response, { decision: "decline" });
}

(async () => {
  try {
    for (const runtime of ["codex", "claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]) {
      for (const permissionMode of Object.values(MODES)) {
        const value = await fixture(runtime, permissionMode);
        try {
          const expected = resolveRuntimePermissionMode(runtime, permissionMode, {});
          assert.deepEqual(value.host.lastTurnStartParams.permissionPolicy, expected.permissionPolicy);
          assert.equal(value.host.lastTurnStartParams.permissionMode, adapterPermissionMode(runtime, permissionMode));
          if (runtime !== "codex") assert.deepEqual(value.acquisitions[0].permissionPolicy, expected.permissionPolicy);
          if (permissionMode === MODES.full) {
            assert.deepEqual(await value.host.request("item/commandExecution/requestApproval",
              { ...value.params, command: "execute task" }), { decision: "accept" });
            assert.equal(value.coordinator.getRun(value.run.id).status, "running");
          } else if (permissionMode === MODES.auto && ["antigravity", "pi", "opencode", "deepseek-harness"].includes(runtime)) {
            value.sessions.session.permissionMode = MODES.full;
            assert.deepEqual(await value.host.request("item/commandExecution/requestApproval",
              { ...value.params, command: "node -e 'workspace task'" }), { decision: "decline" });
            assert.equal(value.coordinator.getRun(value.run.id).status, "running", "native workspace execution redirects without an approval card");
            const contract = value.coordinator.runExecutionContracts.get(value.run.id);
            assert.equal(contract.workspaceExecutionVersion, 1);
            assert.match(contract.turnDeveloperInstructions, /workspace_execute/u);
            assert.deepEqual(await value.host.request("item/commandExecution/requestApproval",
              { ...value.params, command: "native outside task", cwd: path.dirname(root) }), { decision: "decline" });
            assert.equal(value.coordinator.getRun(value.run.id).status, "running", "wider access must use the managed tool's one-off approval");
          } else {
            // Changing the next-turn setting must not widen this running turn.
            value.sessions.session.permissionMode = MODES.full;
            await mustAsk(value, "item/commandExecution/requestApproval", { command: "unknown --network" });
          }
        } finally { await value.coordinator.close(); }
      }
    }
    for (const runtime of ["pi", "opencode", "deepseek-harness", "antigravity"]) {
      const value = await fixture(runtime, MODES.auto);
      try {
        value.sessions.session.permissionMode = MODES.ask;
        assert.deepEqual(await value.host.request("item/fileChange/requestApproval", { ...value.params,
          toolName: "write", toolInput: { path: "new.txt", content: "safe draft" } }), { decision: "decline" });
        assert.equal(value.coordinator.getRun(value.run.id).status, "running");
        assert.deepEqual(await value.host.request("item/fileChange/requestApproval",
          { ...value.params, cwd: path.dirname(root), toolName: "write", toolInput: { path: "../outside.txt" } }), { decision: "decline" });
        assert.throws(() => value.host.request("item/fileChange/requestApproval",
          { ...value.params, threadId: "foreign-session", toolName: "write", toolInput: { path: "new.txt" } }),
        { code: "WORK_RUN_REQUEST_UNROUTABLE" });
      } finally { await value.coordinator.close(); }
    }
    const retiring = await fixture("pi", MODES.auto);
    let closing;
    const audit = [];
    retiring.coordinator.transcriptStore = { appendEvent(event) { audit.push(event); return event; } };
    retiring.coordinator.onTranscriptCommitted = () => { closing = retiring.coordinator.close(); };
    assert.throws(() => retiring.host.request("item/fileChange/requestApproval", {
      ...retiring.params, toolName: "write", toolInput: { path: "new.txt" },
    }), error => ["WORK_RUN_REQUEST_UNROUTABLE", "HOST_CAPABILITY_REVOKED"].includes(error.code));
    await closing;
    assert.equal(audit[0].content.transcriptType, "approval.auto");
    assert.equal(audit[0].contextExcluded, true);
    assert.equal(audit[0].content.reviewer, "workspace-managed-execution");
    assert.equal(audit[0].content.decision, "decline");

    const profile = { id: "permission-profile", defaultModel: null,
      permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } };
    const bindings = ["codex", "claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]
      .map((runtime, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        profileId: profile.id, runtime, runtimeProfileId: `runtime-${index}`, runtimeAccountId: `account-${index}`, enabled: true }));
    const session = { sessionKey: "11111111-1111-4111-8111-111111111111", profileId: profile.id,
      runtimeBindingId: bindings[0].id, revision: 1, workspace: root, permissionMode: MODES.auto };
    const controller = createSessionRuntimeController({
      productStore: { getAgentProfile: () => profile, getAgentRuntimeBindings: () => ({ bindings }) },
      chatSessionStore: { getSession: () => session, getBinding: () => null },
      coordinator: { getRuntimeContext: () => null },
      facts: { read: async () => ({ installed: true, authenticated: true, permissionEnforcementProven: true }) },
      getNativeRuntimeConfig: () => ({ flags: { runtimeConversationHandoff: true } }),
    });
    const snapshot = () => controller.handle("chat.session.runtime.get",
      { profileId: profile.id, sessionKey: session.sessionKey });
    for (const mode of Object.values(MODES)) {
      session.permissionMode = mode;
      const result = await snapshot();
      assert.ok(result.candidates.every(candidate => candidate.support.supported
        && candidate.adjustments.permissionMode === mode), "all Runtime switch candidates retain the canonical selection");
    }
    session.permissionMode = "read-only";
    assert.equal((await snapshot()).candidates.find(candidate => candidate.bindingId === bindings[6].id).support.code,
      "PERMISSION_ENFORCEMENT_UNPROVEN", "unsupported legacy read-only cannot inherit a writable target default");

    const calls = [];
    let supportsReview = true;
    const host = {
      async threadStart(params) { calls.push(params); return { thread: { id: "thread" },
        approvalsReviewer: supportsReview ? params.approvalsReviewer : "user" }; },
      async threadResume(params) { return this.threadStart(params); },
      async turnStart(params) { calls.push(params); return { turn: { id: "turn" } }; },
    };
    const codex = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } })
      .acquire({ runtime: "codex", runtimeProfileId: "profile", runtimeAccountId: "account" });
    const permissionPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
    await codex.sessionStart({ source: "review", permissionMode: "auto-review", permissionPolicy });
    await codex.sessionResume({ sessionId: "thread", permissionMode: "auto-review", permissionPolicy });
    await codex.turnStart({ sessionId: "thread", operationId: "op", prompt: "test", permissionMode: "auto-review", permissionPolicy });
    assert.ok(calls.every(params => params.approvalsReviewer === "auto_review"));
    supportsReview = false;
    await assert.rejects(codex.sessionResume({ sessionId: "thread", permissionMode: "auto-review", permissionPolicy }),
      { code: "RUNTIME_APPROVAL_UNAVAILABLE" });
    await codex.sessionResume({ sessionId: "thread", permissionMode: "ask", permissionPolicy });
    assert.equal(calls.at(-1).approvalsReviewer, "user");
    console.log("PASS 7 Runtime × 3 modes, frozen running policies, scoped review, and Codex reviewer verification");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
