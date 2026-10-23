#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { JsonlProductStore, assertNoSensitiveFields } = require("../app/agent-service/product-store");
const { createWorkDispatcher } = require("../app/agent-service/work-run");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");
const { openFixture, sendAndDrain, FakeHost, directRuntimeManager, PROFILE_ID } = require("./shoggoth-work-run-coordinator-unit.cjs");

const CASES = [
  ["credential placeholder in CLI instructions", '设置示例：\nexport AUTH_TOKEN="你的auth_token"', null],
  ["unregistered credential-shaped assignment", "api_key=fixture-example-value", null],
  ["unregistered bearer-shaped value", "Bearer fixture-example-value-1234567890", null],
  ["ordinary answer", "运行 bird --help 查看帮助。", "运行 bird --help 查看帮助。"],
];

for (const [name, answer, expectedSummary] of CASES) {
  test(`verified Antigravity completion survives ${name}`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-summary-terminal-")));
    const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
    const now = () => 1000;
    const store = new JsonlProductStore({ paths, now });
    const transcript = new TranscriptStore({ paths, now });
    let value;
    try {
      store.open();
      transcript.open();
      store.putAgentProfile({
        id: PROFILE_ID, backendId: "shoggoth", agentId: "summary-fixture", name: "Summary fixture",
        runtime: "antigravity", runtimeProfileId: "runtime-default",
        runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID,
        providerRef: null, defaultModel: null, defaultCwd: root,
        permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
        concurrency: { maxActive: 1, maxWorkspaceWrites: 1 }, isDefault: false, enabled: true,
      });
      const host = new FakeHost([], { accountReadSupported: false,
        authenticationStateResult: { authenticated: true, credentialPresent: true } });
      const manager = directRuntimeManager(host, "antigravity");
      const runtimeManager = { ...manager, async acquire(binding) {
        const handle = await manager.acquire(binding);
        return { ...handle, runtimeAccountId: binding.runtimeAccountId, async sessionRead(input) {
          const { thread } = await host.threadRead({ threadId: input.sessionId });
          // Use the actual ACP history projection, including its operation receipt.
          const session = AntigravityAcpRuntimeHost.prototype._projectSession({
            ...thread, source: thread.threadSource,
            turns: thread.turns.map(turn => ({ ...turn, acceptance: "accepted",
              operationId: turn.items.find(item => item.type === "userMessage").clientId,
              assistantMessages: turn.items.filter(item => item.type === "agentMessage") })),
          }, input.includeTurns);
          return { session };
        } };
      } };
      value = await openFixture({ runtime: "antigravity", host, runtimeManager, now,
        productStore: store, dispatcher: createWorkDispatcher({ store, now }),
        transcriptStore: transcript, sessionWorkspace: root, terminalRetryDelaysMs: [0] });
      const { ack, operationId } = await sendAndDrain(value);
      const run = value.coordinator.getRun(ack.run.id);
      assert.equal(run.status, "running");
      const turn = host.threads.find(thread => thread.id === run.runtimeSessionRef.sessionId).turns
        .find(item => item.id === run.runtimeTurnRef.turnId);
      turn.status = "completed";
      turn.items.push({ id: "answer", type: "agentMessage", text: answer, phase: "final_answer" });
      const common = { known: true, threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId };
      host.emit({ ...common, method: "session/update", type: "text", itemId: "answer",
        text: answer, phase: "final_answer", delivery: "local" });
      const readsBeforeCompletion = host.log.filter(item => item === "host.threadRead").length;
      host.emit({ ...common, method: "session/prompt", type: "complete", status: "completed" });
      const terminal = await value.coordinator.waitForIdle(run.id);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.errorCode, null);
      assert.equal(terminal.resultSummary, expectedSummary);
      assert.equal(value.inbox.get(operationId).state, "completed");
      assert.equal(host.turnStartCalls, 1, "must not replay the accepted operation");
      assert.equal(host.log.filter(item => item === "host.threadRead").length - readsBeforeCompletion, 1,
        "a rejected optional summary must not retry native history");
      const events = transcript.listEvents(PROFILE_ID, value.sessions.session.id);
      assert.equal(events.filter(event => event.content.text === answer).length, 1,
        "the existing final reply remains in the conversation");
      const terminals = events.filter(event => event.content.transcriptType === "terminal");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].content.status, "completed");
      assert.equal(terminals[0].content.resultSummary, expectedSummary);
      if (expectedSummary === null) {
        assert.throws(() => assertNoSensitiveFields({ resultSummary: answer }), { code: "STORE_SENSITIVE_VALUE" });
        assert.throws(() => store.putWorkRun({ ...terminal, eventSeq: terminal.eventSeq + 1, resultSummary: answer }),
          { code: "STORE_SENSITIVE_VALUE" }, "ProductStore credential protection remains enforced");
      }
      await value.coordinator.close();
      value = null;
      store.close();
      store.open();
      assert.deepEqual(store.getWorkRun(run.id), terminal, "completion remains durable after reopening storage");
    } finally {
      await value?.coordinator.close();
      transcript.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
