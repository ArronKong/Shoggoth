"use strict";
// Real Service, SQLite/product stores, encrypted execution descriptor, MCP
// handler, permission engine, approval flow and OS execution. Only the native
// Runtime transport, credential cipher and authenticated delivery are controlled.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { createMcpStdioHandler } = require("../app/shoggoth-mcp-helper");
const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function until(read, label) {
  const end = Date.now() + 10000;
  while (!read()) { assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 10)); }
}

(async () => {
  const opened = { computer: 0, browser: 0 };
  const controller = kind => ({
    open() {}, async close() {}, async closeForProfile() {}, async closeForWorkRun() {}, list() { return []; },
    async status() { return kind === "computer" ? { available: true, driverVersion: "fixture", contractVersion: "fixture",
      permissions: { accessibility: true, screenRecording: true }, sessions: [] }
      : { available: true, reason: null, engineVersion: "fixture", browser: "chrome", sessions: [] }; },
    ...Object.fromEntries((kind === "computer" ? ["resume", "closeSession", "applicationList", "windowList", "snapshot", "focus", "action"]
      : ["closeSession", "listTools", "callTool"]).map(method => [method, async () => { throw new Error("Unused native UI controller"); }])),
    async create(input) { opened[kind]++; return { id: `${kind}-${opened[kind]}`, profileId: input.profileId,
      workRunId: input.workRunId, status: "ready", expiresAt: Date.now() + 60000 }; },
  });
  const f = await openHandoffFixture({ validateHandles: true, serviceOptions: {
    computerUseController: controller("computer"), browserUseController: controller("browser"),
  } });
  const coordinator = f.service.workRunCoordinator;
  const results = [];
  try {
    for (const runtime of ["antigravity", "pi", "opencode", "deepseek-harness"]) {
      if (!f.binding(runtime)) f.service.productStore.addAgentRuntimeBinding(f.profile.id, { runtime,
        runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(account => account.runtime === runtime && account.kind === "native-user").id },
      { operationId: `workspace-add-${runtime}` });
      const session = f.createSession();
      f.service.chatSessionStore.setPermissionMode(session.sessionKey, "auto-review");
      await f.switch(session.sessionKey, runtime);
      const run = await f.send(session.sessionKey, `workspace-${runtime}`, "Use workspace_execute for the requested workspace task.");
      assert.equal(run.status, "running", run.errorCode);
      const contract = coordinator.runExecutionContracts.get(run.id);
      assert.equal(contract.workspaceExecutionVersion, 1); assert.equal(contract.runtime, runtime);
      assert.match(contract.turnDeveloperInstructions, /workspace_execute/u);
      const frozen = await coordinator.runExecutionStore.get(run);
      assert.equal(frozen.contract.workspaceExecutionVersion, 1, "recovery retains the execution version");
      const token = crypto.randomBytes(32).toString("base64url");
      const binding = { runtimeProfileId: contract.runtimeProfileId, runtimeAccountId: contract.runtimeAccountId };
      const raw = f.transport.hosts.get(runtime);
      let holds = 0, releases = 0;
      raw.pauseManagedToolTimeout = input => {
        assert.equal(input.sessionId, run.runtimeSessionRef.sessionId); assert.equal(input.turnId, run.runtimeTurnRef.turnId);
        holds++; return () => { releases++; };
      };
      const context = { requestClient(method, params) {
        assert.equal(method, "elicitation/create");
        return raw.request("mcpServer/elicitation/request", { ...params,
          serverName: "shoggoth", threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId });
      } };
      const helper = createMcpStdioHandler({ ...binding, sessionToken: token, paths: f.paths,
        bindRuntimeCalls: runtime === "pi",
        requestService: async (_paths, request) => {
          assert.equal(request.method, "mcp.tool.call");
          assert.equal(request.params.sessionToken, token);
          const params = request.params;
          const invoke = scope => f.service.mcpProductToolController.handle(params.name, params.arguments,
            { profileId: f.profile.id, callId: params.callId, ...(params.confirmation ? { confirmation: true } : {}) }, scope);
          return runtime === "pi" ? coordinator.invokeBoundRuntimeMcpCall({ ...params, profileId: f.profile.id }, invoke)
            : coordinator.invokeRuntimeCapability({ ...binding, runId: run.id }, invoke);
        } });
      let id = 0;
      const namedCall = (name, args) => helper({ jsonrpc: "2.0", id: ++id, method: "tools/call",
        params: { name, arguments: args } }, context);
      const call = args => namedCall("workspace_execute", args);
      const initialized = await helper({ jsonrpc: "2.0", id: ++id, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "workspace-controlled-native", version: "1" } } });
      assert.equal(initialized.result.serverInfo.name, "shoggoth");
      const listing = await helper({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} });
      // tools/list is paginated; discovery starts at the current Registry revision.
      assert.ok(Array.isArray(listing.result.tools));
      const target = path.join(f.workspace, runtime + ".txt");
      const write = await call({ command: `${q(process.execPath)} -e ${q(`require('node:fs').writeFileSync(${JSON.stringify(target)},'workspace done')`)}` });
      assert.equal(write.result.isError, false, JSON.stringify(write));
      assert.equal(write.result.structuredContent.exitCode, 0);
      assert.equal(fs.readFileSync(target, "utf8"), "workspace done");
      assert.equal(coordinator.getRun(run.id).status, "running", "no approval card for workspace execution");
      for (const kind of ["computer", "browser"]) {
        const before = opened[kind];
        const opening = namedCall(`${kind}_session_open`, { source: "chat", sourceId: session.sessionKey,
          ...(kind === "computer" ? { allowedApplications: ["com.apple.TextEdit"] } : {}) });
        await until(() => coordinator.getRun(run.id).status === "waiting_input", `${kind} still requires product confirmation`);
        assert.equal(opened[kind], before, "machine access cannot begin before the user's confirmation");
        const request = coordinator.getRun(run.id);
        await coordinator.respondInput({ operationId: `confirm-${kind}-${runtime}`, runId: run.id,
          requestId: request.waitingRequestId, action: "submit", answers: { confirm_product_action: "确认执行" } });
        assert.equal((await opening).result.isError, false);
        assert.equal(opened[kind], before + 1);
      }
      const failed = await call({ command: "exit 7" });
      assert.equal(failed.result.isError, true); assert.equal(failed.result.structuredContent.exitCode, 7);
      if (runtime === "antigravity") {
        const large = await call({ command: `${q(process.execPath)} -e ${q("process.stdout.write('\\u0000'.repeat(100000))")}` });
        assert.equal(large.result.isError, false, JSON.stringify(large));
        assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 64 * 1024);
        const output = large.result.structuredContent || JSON.parse(large.result.content[0].text);
        assert.equal(output.outputTruncated, true);
      }
      const secret = path.join(f.root, runtime + "-outside"); fs.writeFileSync(secret, "outside canary", { mode: 0o600 });
      const blocked = await call({ command: `/bin/cat ${q(secret)}` });
      assert.equal(blocked.result.isError, true); assert.notEqual(blocked.result.structuredContent.exitCode, 0);
      assert.equal(coordinator.getRun(run.id).status, "running");
      const approved = call({ command: `/bin/cat ${q(secret)}`, access: { readPaths: [secret] }, reason: "Read this explicitly requested fixture file" });
      await until(() => coordinator.getRun(run.id).status === "waiting_approval", "wider access waits for the user");
      const waiting = coordinator.getRun(run.id);
      const record = coordinator.pendingRequests.get(waiting.waitingRequestId);
      assert.equal(record.expiresAt, null, "approval follows the Runtime lifecycle");
      assert.ok(holds > releases, "the outer Runtime timer stays paused while the user decides");
      assert.equal(record.params.sessionApprovalAvailable, false);
      assert.deepEqual(record.params.toolInput.effectiveAccess.readPaths, [secret]);
      assert.equal(record.params.toolName, "workspace_execute");
      await coordinator.respondApproval({ operationId: `workspace-approve-${runtime}`, runId: run.id,
        requestId: waiting.waitingRequestId, choice: "once" });
      const expanded = await approved;
      assert.equal(expanded.result.isError, false, JSON.stringify(expanded));
      assert.equal(expanded.result.structuredContent.stdout, "outside canary");
      const denied = call({ command: `/bin/cat ${q(secret)}`, access: { readPaths: [secret] }, reason: "A separate invocation requires its own decision" });
      await until(() => coordinator.getRun(run.id).status === "waiting_approval", "one approval does not persist");
      await coordinator.respondApproval({ operationId: `workspace-deny-${runtime}`, runId: run.id,
        requestId: coordinator.getRun(run.id).waitingRequestId, choice: "deny" });
      assert.equal((await denied).result.isError, true);
      f.service.chatSessionStore.setPermissionMode(session.sessionKey, "request-approval");
      const stillAuto = await call({ command: "printf frozen" });
      assert.equal(stillAuto.result.isError, false); assert.equal(stillAuto.result.structuredContent.stdout, "frozen");
      assert.ok(holds > 0); assert.equal(holds, releases);
      await f.complete(run);
      const next = await f.send(session.sessionKey, `workspace-next-${runtime}`);
      assert.equal(coordinator.runExecutionContracts.get(next.id).workspaceExecutionVersion, undefined);
      await f.complete(next);
      helper.close();
      results.push({ runtime, workspaceAutomatic: true, widerAccessOnce: true, deniedAccess: true, productConfirmation: true,
        nextTurnFrozen: true, encryptedRecoveryVersion: true, realExitStatus: true });
      console.log(`PASS ${runtime}: actual Service/MCP/sandbox/approval/frozen contract`);
    }
    console.log(JSON.stringify({ passed: results.length, results, realProvider: false }));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
