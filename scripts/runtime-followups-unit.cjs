"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { RuntimeExtensionAdapter } = require("../app/agent-service/runtime-extension-adapter");
const { RuntimeExtensionCatalog, verifyManifest } = require("../app/agent-service/runtime-extension-manifest");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
const { createRuntimeWorker } = require("../app/agent-service/runtime-plugin-sdk");
const { runtimeData, runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { RuntimeQueueClock, RuntimeTelemetry } = require("../app/agent-service/runtime-telemetry");
const { resolveServicePaths } = require("../app/agent-service/paths");
const policy = { sandbox: "danger-full-access", approvalPolicy: "never" };
const binding = { runtime: "ext-fixture", runtimeProfileId: "fixture-profile", runtimeAccountId: "fixture-account" };
function fixture() { const root = fs.mkdtempSync("/tmp/runtime-followups-");
  return { root, paths: resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") }), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }; }
function signed(transport) {
  const command = fs.realpathSync(process.execPath), script = path.resolve(__dirname, "fixtures", transport === "acp" ? "runtime-v1-acp.cjs" : "runtime-v1-plugin.cjs");
  const manifest = { version: 1, runtime: binding.runtime, transport, command, args: [script],
    files: [command, script].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
    endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const text = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  return { envelope: { manifest, signature: crypto.sign(null, Buffer.from(text), privateKey).toString("base64") },
    trustedKey: publicKey.export({ type: "spki", format: "pem" }) };
}
for (const transport of ["stdio", "acp"]) test(`${transport} crosses real pipes, validates V1, persists a session and retires its process`, async () => {
  const f = fixture(), signedManifest = signed(transport), manifest = verifyManifest(signedManifest.envelope, signedManifest.trustedKey);
  const adapter = new RuntimeExtensionAdapter({ paths: f.paths, manifest,
    verify: () => verifyManifest(signedManifest.envelope, signedManifest.trustedKey) });
  const registry = new RuntimeAdapterRegistry(); registry.register(binding.runtime, adapter);
  try {
    await assert.rejects(registry.acquire(binding, { workspace: f.root, permissionPolicy: { sandbox: "read-only", approvalPolicy: "never" } }), { code: "RUNTIME_PERMISSION_UNSUPPORTED" });
    const handle = await registry.acquire(binding, { workspace: f.root, permissionPolicy: policy }); assert.equal(handle.version, 1);
    const events = []; handle.subscribe(event => events.push(event));
    const { session } = await handle.sessionStart({ cwd: f.root, source: "fixture-source", model: null });
    const input = { cwd: f.root, sessionId: session.id, operationId: "fixture-operation", input: [{ type: "text", text: "reply" }] };
    const result = await handle.turnStart(input); assert.ok(result.turn.id);
    const deadline = Date.now() + 2000;
    while (events.at(-1)?.type !== "complete" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.at(-1)?.type, "complete");
    assert.equal((await handle.sessionRead({ sessionId: session.id })).session.id, session.id);
    if (transport === "acp") {
      assert.equal((await handle.turnStart(input)).turn.id, result.turn.id, "same operation cannot dispatch twice");
      await assert.rejects(handle.turnStart({ ...input, input: [{ type: "text", text: "changed" }] }), { code: "RUNTIME_OPERATION_CONFLICT" });
    }
    await registry.stopAll(); await handle.terminated;
    await assert.rejects(handle.sessionRead({ sessionId: session.id }), { code: "RUNTIME_HANDLE_TERMINATED" });
    assert.equal(registry.statistics().hosts, 0);
  } finally { await registry.stopAll(); f.cleanup(); }
});
test("signed package lifecycle refuses tampering and retains disabled history", () => {
  const f = fixture(); try {
    const entry = signed("stdio"), catalog = new RuntimeExtensionCatalog(f.paths);
    catalog.install(entry.envelope, entry.trustedKey); assert.equal(catalog.read().length, 1);
    const changed = structuredClone(entry.envelope); changed.manifest.args.push("--inject");
    assert.throws(() => verifyManifest(changed, entry.trustedKey));
    catalog.setEnabled(binding.runtime, false); assert.equal(catalog.read()[0].enabled, false);
    catalog.setEnabled(binding.runtime, true); catalog.uninstall(binding.runtime); assert.deepEqual(catalog.read(), []);
  } finally { f.cleanup(); }
});
test("Remote Worker authenticates before constructing a scoped runtime and does not replay on disconnect", async () => {
  const f = fixture(), token = "fixture-token-" + crypto.randomBytes(32).toString("hex"); let constructions = 0;
  const worker = createRuntimeWorker({ token, authorize: ({ binding: candidate }) => candidate.runtimeAccountId === binding.runtimeAccountId,
    factory: async () => { constructions++; return { capabilities: { "models.list": true }, homeIdentity: "worker-account",
      modelsList: () => ({ data: [] }), authenticationState: () => ({ authenticated: true }), stop() {} }; } });
  const address = await worker.listen();
  const manifest = { runtime: binding.runtime, transport: "remote", endpoint: `tcp://127.0.0.1:${address.port}`, credentialRef: "runtime-worker-fixture" };
  const adapter = new RuntimeExtensionAdapter({ manifest, paths: f.paths, verify() {}, getToken: () => token });
  const wrong = new RuntimeExtensionAdapter({ manifest, paths: f.paths, verify() {}, getToken: () => "wrong-".repeat(10) });
  try {
    await assert.rejects(wrong.acquire(binding, { permissionPolicy: policy })); assert.equal(constructions, 0);
    const handle = await adapter.acquire(binding, { permissionPolicy: policy }); assert.equal(constructions, 1);
    assert.deepEqual(await handle.modelsList({}), { data: [] });
    await worker.close(); await handle.terminated;
    await assert.rejects(handle.modelsList({})); assert.equal(constructions, 1);
  } finally { await adapter.stopAll(); await wrong.stopAll(); if (worker.server.listening) await worker.close(); f.cleanup(); }
});
test("V1 cannot bypass validation with a forged version marker or executable properties", () => {
  assert.throws(() => runtimeHandleV1({ ...binding, version: 1, kind: "shoggoth-runtime-handle", capabilities: { "turn.start": true },
    subscribe() {}, terminated: new Promise(() => {}) }, binding), { code: "RUNTIME_HANDLE_INVALID" });
  assert.throws(() => runtimeData({ get prompt() { throw new Error("getter executed"); } }), { code: "RUNTIME_PROTOCOL_INVALID" });
  assert.throws(() => runtimeData(new Array(3)), { code: "RUNTIME_PROTOCOL_INVALID" });
});
test("V1 preserves native streamed deltas, structured reasoning and account backoff", async () => {
  const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
  let receive, stops = 0;
  const raw = { ...binding, capabilities: { events: true }, terminated: new Promise(() => {}),
    subscribe(listener) { receive = listener; return () => {}; }, stop() { stops++; } };
  const handle = runtimeHandleV1(raw, binding), events = []; handle.subscribe(event => events.push(event));
  for (const [method, extra] of [
    ["item/agentMessage/delta", { delta: "Hello" }], ["item/reasoning/textDelta", { delta: "Thinking" }],
    ["item/reasoning/summaryPartAdded", { summaryIndex: 0 }],
    ["item/completed", { item: { id: "reasoning-item", type: "reasoning", summary: [{ text: "Ready" }] } }],
  ]) receive(normalizeCodexEvent({ method, params: { threadId: "native-session", turnId: "native-turn", ...extra } }));
  receive({ known: true, type: "account_unavailable", errorCode: "RUNTIME_ACCOUNT_QUOTA_EXHAUSTED" });
  assert.deepEqual(events.map(event => event.type), ["text_delta", "reasoning_delta", "reasoning", "reasoning", "account_unavailable"]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 0);
  receive({ known: true, type: "text_delta", sessionId: "native-session", delta: 42 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1);
});
test("queue age survives restart and diagnostics contain only bounded metadata", () => {
  const f = fixture(); try {
    const clock = new RuntimeQueueClock({ paths: f.paths, now: () => 10_000 }); clock.set("queued-run", 100);
    const restored = new RuntimeQueueClock({ paths: f.paths, now: () => 20_000 }); assert.equal(restored.get("queued-run"), 100);
    restored.delete("queued-run"); assert.equal(new RuntimeQueueClock({ paths: f.paths }).has("queued-run"), false);
    const telemetry = new RuntimeTelemetry({ now: () => 10 });
    telemetry.record("runtime.preflight.failed", { runId: "secret raw id", reason: "AUTH_REQUIRED", prompt: "private conversation" });
    const output = JSON.stringify(telemetry.snapshot()); assert.doesNotMatch(output, /private conversation|secret raw id/u); assert.match(output, /AUTH_REQUIRED/u);
  } finally { f.cleanup(); }
});
for (const transport of ["stdio", "acp"]) test(`an explicitly installed signed ${transport} CLI completes a product-owned chat`, async () => {
  const f = fixture(), entry = signed(transport);
  new RuntimeExtensionCatalog(f.paths).install(entry.envelope, entry.trustedKey);
  const { createAgentService } = require("../app/agent-service/server");
  const service = createAgentService({ paths: f.paths, runtimeStorageHomedir: f.root,
    parentEnv: { HOME: f.root, PATH: process.env.PATH }, safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  try {
    await service.start(); assert.ok(service.productStore.getRuntimeAccount("extension-ext-fixture"));
    const base = { ...service.productStore.listAgentProfiles()[0] };
    for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
    const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: "extension-test-agent", name: "Extension test",
      runtime: binding.runtime, runtimeProfileId: "extension-runtime-profile", runtimeAccountId: "extension-ext-fixture",
      isDefault: false, enabled: true, defaultModel: null, defaultCwd: f.root, permissionPolicy: policy });
    service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
    const session = service.chatSessionStore.createSession({ operationId: "extension-create", profileId: profile.id, workspace: f.root, createdAt: Date.now() });
    const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "extension-send", prompt: "fixture task" });
    let timer;
    const completed = await Promise.race([service.workRunCoordinator.waitForTerminal(ack.run.id),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("extension turn timed out")), 10_000); })]).finally(() => clearTimeout(timer));
    assert.equal(completed.status, "completed", completed.errorCode || "extension completion");
    assert.equal(completed.runtimeSessionRef.runtime, binding.runtime);
    const events = service.transcriptStore.listEvents(profile.id, session.id);
    assert.ok(events.some(event => event.kind === "assistant" && event.content.text.includes(transport === "stdio" ? "Fixture complete" : "ACP fixture")));
  } finally { await service.stop({ notify: false }); f.cleanup(); }
});
