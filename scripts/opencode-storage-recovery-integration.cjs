"use strict";
// Real Service/socket/Coordinator, Adapter, Pool and Host; isolated native HTTP
// responses and ledger ENOSPC injection. No installed App, account or provider.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { OpenCodeRuntimePool } = require("../app/agent-service/opencode-runtime-pool");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { OpenCodeRuntimeAdapter } = require("../app/agent-service/opencode-runtime-adapter");
const { OpenCodeRuntimeLedger } = require("../app/agent-service/opencode-runtime-ledger");
const { openRuntimeLedger } = require("../app/agent-service/runtime-shared-ledger");
const { openCodeWorkspaceShardId } = require("../app/agent-service/opencode-runtime-paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");

async function main() {
  const f = await openHandoffFixture();
  const hosts = [], messages = [], nativeSessions = new Map();
  let diskFull = false, prompts = 0, aborts = 0, clock = Date.now(), verified = false;
  const fileSystem = Object.create(fs);
  fileSystem.writeSync = (...args) => {
    if (diskFull) throw Object.assign(Error("injected storage exhaustion"), { code: "ENOSPC" });
    return fs.writeSync(...args);
  };
  const pool = new OpenCodeRuntimePool({ paths: f.paths, fs: fileSystem,
    runtimeAccountResolver: { resolve(binding) {
      return Object.freeze({ runtime: "opencode", runtimeAccountId: binding.runtimeAccountId,
        home: f.root, configSourceHome: f.root, binaryPath: "/usr/bin/true", configurationMode: "native",
        launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: f.root, XDG_DATA_HOME: f.root }) });
    } },
    hostFactory(options) {
      const host = new OpenCodeRuntimeHost({ ...options, now: () => clock }); hosts.push(host);
      host.initialize = async () => {
        host.ledger = await openRuntimeLedger(host.ledgerSlot, () => new OpenCodeRuntimeLedger({
          fs: fileSystem, trustedRoot: f.root, stateRoot: path.join(f.paths.stateDir, "runtime-ledgers/opencode"),
          runtimeProfileId: host.runtimeProfileId, runtimeAccountId: host.runtimeAccountId,
          workspaceShardId: openCodeWorkspaceShardId(host),
        }).open());
        host.modelSecretRoute = { ready: () => true, close() {} };
        host.client = { async request(method, route, body) {
          if (route === "/provider") return { data: { connected: ["fixture"],
            all: [{ id: "fixture", models: { model: {} } }] } };
          if (route === "/config") return { data: { model: "fixture/model" } };
          if (method === "POST" && route === "/session") {
            const native = { id: `ses_${randomUUID()}`, directory: host.workspace, permission: body.permission };
            nativeSessions.set(native.id, native); return { data: native };
          }
          if (method === "GET" && nativeSessions.has(route.slice(9))) return { data: nativeSessions.get(route.slice(9)) };
          if (method === "POST" && route.endsWith("/prompt_async")) {
            prompts++;
            const sessionID = route.split("/")[2];
            messages.push({ info: { id: body.messageID, sessionID, role: "user" }, parts: [] },
              { info: { id: `msg_answer${prompts}`, sessionID, role: "assistant", parentID: body.messageID,
                ...(prompts > 1 ? { time: { completed: clock }, finish: "stop" } : {}) },
              parts: prompts > 1 ? [{ type: "text", id: "prt_recovered", text: "Storage recovered; conversation continued." }] : [] });
            return { status: 204 };
          }
          if (method === "POST" && route.endsWith("/abort")) { aborts++; diskFull = true; return { data: true }; }
          if (route.includes("/message?")) return { data: structuredClone(messages) };
          if (route === "/session/status") { clock += 61_000; return { data: {} }; }
          if (route === "/permission" || route === "/question") return { data: [] };
          throw Error(`Unexpected native request: ${method} ${route}`);
        } };
        host.state = "ready";
        return host;
      };
      return host;
    },
  });
  const adapter = new OpenCodeRuntimeAdapter({ runtimePool: pool });
  const acquire = f.service.runtimeManager.acquire.bind(f.service.runtimeManager);
  f.service.runtimeManager.acquire = (binding, options) => binding.runtime === "opencode"
    ? adapter.acquire(binding, options) : acquire(binding, options);
  const token = readClientToken(f.paths);
  const ipc = (method, params) => requestService(f.paths, { id: randomUUID(), token, version: PROTOCOL_VERSION, method, params });
  try {
    const added = f.service.productStore.addAgentRuntimeBinding(f.profile.id,
      { runtime: "opencode", runtimeAccountId: "native-opencode-default-v1" }, { operationId: "storage-fixture" });
    f.service.productStore.setAgentDefaultBinding(f.profile.id, added.binding.id, { revision: added.revision });
    f.service.productStore.putAgentProfile({ ...f.service.productStore.getAgentProfile(f.profile.id),
      defaultModel: "fixture/model", permissionPolicy: { approvalPolicy: "on-request", sandbox: "danger-full-access" } });
    const session = f.createSession();
    const send = async (operationId, prompt) => {
      const ack = await ipc("chat.send", { sessionKey: session.sessionKey, operationId, prompt, createdAt: Date.now() });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await f.service.workRunCoordinator.waitForIdle(ack.run.id);
        const run = f.service.workRunCoordinator.getRun(ack.run.id);
        if (["failed", "interrupted", "completed", "canceled"].includes(run.status)) return run;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("Service did not settle the native turn within 10 seconds");
    };
    const first = await send("storage-interrupted", "Original operation");
    assert.equal(first.status, "interrupted", JSON.stringify(first));
    assert.equal(first.errorCode, "CODEX_TERMINAL_RECONCILIATION_FAILED");
    assert.equal(prompts, 1); assert.equal(aborts, 1);
    const firstHost = hosts.find(host => !host.controlInstance);
    assert.equal(firstHost.ledger.snapshot().sessions[0].turns[0].status, "inProgress");
    diskFull = false;
    const next = await send("new-message-after-storage-restored", "Continue with a new message");
    assert.equal(next.status, "completed", JSON.stringify(next));
    assert.equal(next.runtimeSessionRef.sessionId, first.runtimeSessionRef.sessionId);
    assert.equal((await send("storage-interrupted", "Original operation")).id, first.id);
    assert.equal(prompts, 2, "the failed operation must never be dispatched again");
    assert.equal(aborts, 1);
    assert.equal(firstHost.state, "ready", "no Service or original Host restart was needed");
    assert.deepEqual(firstHost.ledger.snapshot().sessions[0].turns.map(turn => turn.status), ["failed", "completed"]);
    const history = await ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
    assert(JSON.stringify(history).includes("Storage recovered; conversation continued."));
    console.log(JSON.stringify({ verified: true, prompts, aborts, sameSession: true,
      oldOperationNotReplayed: true, continuedWithoutRestart: true, historyContainsReply: true }));
    verified = true;
  } finally {
    diskFull = false;
    await adapter.stopAll();
    await f.close({ remove: verified });
    if (!verified) console.error(JSON.stringify({ retainedFailure: f.root }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
