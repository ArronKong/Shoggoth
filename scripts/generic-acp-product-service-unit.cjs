"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const source = path.resolve(__dirname, ".."), command = fs.realpathSync(process.execPath);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(20); }
  throw Error(label);
}
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-acp-service-")), home = path.join(root, "home"), snapshot = path.join(root, "source");
  fs.chmodSync(root, 0o700); fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(path.join(snapshot, "scripts/fixtures"), { recursive: true, mode: 0o700 });
  // Freeze the controlled executable and launcher used by the full App proof.
  // The production source remains the same module graph as this test process.
  fs.symlinkSync(path.join(source, "app"), path.join(snapshot, "app"));
  for (const file of ["generic-acp-app-worker.cjs", "generic-acp-app-helper.cjs"])
    fs.copyFileSync(path.join(__dirname, "fixtures", file), path.join(snapshot, "scripts/fixtures", file));
  const script = path.join(snapshot, "scripts/fixtures/generic-acp-app-worker.cjs"), paths = resolveServicePaths({ homeDir: home });
  const runtime = "ext-product-service", accountId = `extension-${runtime}`;
  const manifest = { version: 1, runtime, transport: "acp", command, args: [script], files: [command, script].map(file => ({ path: file,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"), payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  new RuntimeExtensionCatalog(paths).install({ manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command, argsPrefix: [] }, bootstrapPath: path.join(snapshot, "scripts/fixtures/generic-acp-app-helper.cjs") });
  const service = createAgentService({ paths, runtimeMcpGateIssuer: issuer, prewarmMcpAuth: false,
    runtimeStorageHomedir: () => home, parentEnv: { HOME: home, PATH: process.env.PATH, TMPDIR: root },
    runtimePool: { get() { throw Error("native runtime forbidden"); }, async stopAll() {}, async stop() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() } });
  const audit = () => fs.existsSync(path.join(root, "acp-worker-audit.jsonl")) ? fs.readFileSync(path.join(root, "acp-worker-audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    await service.stop({ notify: false });
    for (const pid of new Set(audit().flatMap(row => row.kind === "started" ? [row.pid] : row.kind === "helper-started" ? [row.helperPid] : [])))
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const base = { ...service.productStore.listAgentProfiles()[0] }; for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
  const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: "acp-product-proof", name: "ACP product proof", runtime,
    runtimeProfileId: "product-proof-profile", runtimeAccountId: accountId, isDefault: false, enabled: true, defaultModel: null, defaultCwd: root,
    permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "on-request" } });
  service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name }); service.memoryStore.ensureProfile(profile.id);
  const session = service.chatSessionStore.createSession({ operationId: "create-product-chat", profileId: profile.id, workspace: root, createdAt: Date.now() });
  return { root, service, profile, session, audit };
}

test("real Service authorizes the first MCP call and native permission from the prepared attempt, then resumes on a new per-Run process", { timeout: 35000 }, async t => {
  const f = await fixture(t), { service, profile, session } = f, coordinator = service.workRunCoordinator;
  const first = await coordinator.send({ sessionKey: session.sessionKey, operationId: "first-product-turn", prompt: "[ACP_PROBE:first] [ACP_REQUIRE_MCP] [ACP_APPROVAL]" });
  const waiting = await until(() => { const run = service.productStore.getWorkRun(first.run.id); if (["failed", "needs_verification"].includes(run?.status)) throw Error(`${run.status}: ${run.errorCode}`);
    return run?.status === "waiting_approval" && run; }, "first-event ACP permission did not reach the product");
  assert.equal(waiting.runtimeTurnRef, null); assert.equal(waiting.runtimeSessionRef, null);
  assert.equal(waiting.runtimeAttemptRef?.dispatchState, "write_attempted"); assert(waiting.runtimeAttemptRef.attemptId);
  assert(f.audit().some(row => row.kind === "mcp-call" && row.token === "first" && row.ok), "real Helper tool call precedes the native permission");
  const requestId = waiting.waitingRequestId;
  await coordinator.respondApproval({ operationId: "allow-first-product-turn", runId: waiting.id, requestId, choice: "once" });
  const completed = await until(() => { const run = service.productStore.getWorkRun(waiting.id); return !["starting", "running", "waiting_approval", "queued"].includes(run.status) && run; }, "first product run terminal");
  assert.equal(completed.status, "completed", completed.errorCode); assert(completed.runtimeTurnRef.turnId); assert(completed.runtimeSessionRef.sessionId);
  assert.equal(f.audit().filter(row => row.kind === "approval" && row.token === "first" && row.optionId === "controlled-allow-once").length, 1);
  await assert.rejects(coordinator.respondApproval({ operationId: "late-first-approval", runId: completed.id, requestId, choice: "once" }));
  const second = await coordinator.send({ sessionKey: session.sessionKey, operationId: "second-product-turn", prompt: "[ACP_PROBE:second] [ACP_REQUIRE_MCP]" });
  const resumed = await until(() => { const run = service.productStore.getWorkRun(second.run.id); return !["starting", "running", "waiting_approval", "queued"].includes(run.status) && run; }, "second product run terminal");
  assert.equal(resumed.status, "completed", resumed.errorCode); assert.equal(resumed.runtimeSessionRef.sessionId, completed.runtimeSessionRef.sessionId);
  const prompts = f.audit().filter(row => row.kind === "prompt"); assert.deepEqual(prompts.map(row => row.token), ["first", "second"]);
  assert.notEqual(prompts[0].pid, prompts[1].pid, "Product MCP authority is isolated by Run process");
  assert(f.audit().some(row => row.kind === "session/load" && row.sessionId === completed.runtimeSessionRef.sessionId));
  const transcript = service.transcriptStore.listEvents(profile.id, session.id);
  assert(transcript.some(event => event.kind === "assistant" && event.content.text?.includes("ACP answer first")));
  assert(transcript.some(event => event.kind === "assistant" && event.content.text?.includes("ACP answer second")));
  assert(!transcript.some(event => event.kind === "assistant" && event.content.text?.includes("ACP replay-only marker")));
});


test("real prepared approval can be aborted while prompt is unresolved and its late response cannot enter the next Run", { timeout: 35000 }, async t => {
  const f = await fixture(t), { service, session } = f, coordinator = service.workRunCoordinator;
  const first = await coordinator.send({ sessionKey: session.sessionKey, operationId: "cancel-product-turn", prompt: "[ACP_PROBE:cancel] [ACP_REQUIRE_MCP] [ACP_APPROVAL]" });
  const waiting = await until(() => { const run = service.productStore.getWorkRun(first.run.id); return run?.status === "waiting_approval" && run; }, "cancel target approval");
  const requestId = waiting.waitingRequestId;
  await coordinator.abort({ operationId: "cancel-prepared-product-turn", sessionKey: session.sessionKey, runId: waiting.id });
  const canceled = await until(() => { const run = service.productStore.getWorkRun(waiting.id); return run?.status === "canceled" && run; }, "prepared execution cancel terminal");
  assert.equal(canceled.runtimeAttemptRef?.attemptId, waiting.runtimeAttemptRef.attemptId);
  await assert.rejects(coordinator.respondApproval({ operationId: "late-canceled-approval", runId: canceled.id, requestId, choice: "once" }));
  // The controlled peer returned a matching cancelled terminal, so the native
  // session can continue. A process stop without that receipt retains the
  // unresolved ledger barrier covered by the Handle lifecycle regressions.
  const next = await coordinator.send({ sessionKey: session.sessionKey, operationId: "after-canceled-product-turn", prompt: "[ACP_PROBE:after-cancel] [ACP_REQUIRE_MCP]" });
  await assert.rejects(coordinator.respondApproval({ operationId: "old-request-next-run", runId: next.run.id, requestId, choice: "once" }));
  const completed = await until(() => { const run = service.productStore.getWorkRun(next.run.id); return !["queued", "starting", "running", "waiting_approval"].includes(run.status) && run; }, "next execution terminal");
  assert.equal(completed.status, "completed", completed.errorCode);
  assert.deepEqual(f.audit().filter(row => row.kind === "prompt").map(row => row.token), ["cancel", "after-cancel"]);
  assert(!f.audit().some(row => row.kind === "approval" && row.token === "cancel" && row.optionId === "controlled-allow-once"));
  assert.equal(coordinator.getMemoryStats().pendingRequests, 0);
});
