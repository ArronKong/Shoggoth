"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const protocol = require("../app/agent-service/runtime-extension-status-protocol");
const { createRuntimeExtensionStatusController } = require("../app/agent-service/runtime-extension-status-controller");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { runtimeFeatureSupport } = require("../app/agent-service/runtime-capability-evidence");
const runtime = "ext-status-proof", accountId = "extension-ext-status-proof";
function fixture() {
  let catalog = [{ enabled: true, envelope: { manifest: { runtime } } }], current = true, host = null, calls = 0;
  const binding = { runtime, runtimeAccountId: accountId, runtimeProfileId: "profile-proof", enabled: true };
  const profile = { id: "profile", enabled: true, permissionPolicy: { sandbox: "danger-full-access", approvalPolicy: "never" } };
  const adapter = { runtimeIdentityKey() { if (!current) throw Error("private secret path"); return "identity"; } };
  const adapters = new Map([[runtime, adapter]]);
  const controller = createRuntimeExtensionStatusController({
    productStore: { listRuntimeAccounts: () => [{ id: accountId, runtime }], listAgentProfiles: () => [profile],
      getAgentRuntimeBindings: () => ({ bindings: [binding] }) },
    extensionCatalog: { read() { if (catalog === null) throw Error("private path"); return catalog; } },
    extensionRuntimeAdapters: adapters,
    runtimeManager: { acquire() { throw Error("status cannot acquire"); }, peek() { calls++; return host; } },
  });
  return { read: () => controller.read().entries[0], adapters, setCatalog: value => { catalog = value; },
    invalidate: () => { current = false; }, setHost: value => { host = value; }, calls: () => calls };
}
test("signed inventory never claims authentication or features before execution", () => {
  const f = fixture(), row = f.read();
  assert.equal(row.availability, "available"); assert.equal(row.authentication, "unverified");
  assert.deepEqual(row.features, runtimeFeatureSupport(null)); assert.equal(row.code, null);
});
test("disabled, removed, missing adapter, changed identity and corrupt catalog retain unavailable account rows", () => {
  for (const mutation of [f => f.setCatalog([]), f => f.setCatalog([{ enabled: false, envelope: { manifest: { runtime } } }]),
    f => f.adapters.clear(), f => f.invalidate(), f => f.setCatalog(null)]) {
    const f = fixture(); mutation(f); const row = f.read();
    assert.equal(row.availability, "unavailable"); assert.equal(row.authentication, "unverified");
    assert.equal(row.runtimeAccountId, accountId); assert.equal(f.calls(), 0);
    assert.equal(JSON.stringify(row).includes("private"), false);
  }
});
test("only a current local ACP snapshot supplies authentication; plugin RPC stays unused", () => {
  for (const transport of ["acp", "stdio"]) {
    const f = fixture();
    f.setHost({ host: { transport, getCachedAuthenticationState: () => ({ status: "authenticated" }) },
      authenticationState() { throw Error("cannot invoke RPC"); } });
    assert.equal(f.read().authentication, transport === "acp" ? "authenticated" : "unverified");
  }
});
test("an instance retired by the cached accessor cannot publish stale authentication or capabilities", () => {
  const f = fixture(); f.setHost({ host: { transport: "acp", getCachedAuthenticationState() { f.setHost(null); return { status: "authenticated" }; } } });
  assert.equal(f.read().authentication, "unverified");
});
test("public status rejects unknown fields, unsafe codes, duplicate accounts and inconsistent authentication", () => {
  const row = fixture().read();
  for (const input of [{ entries: [{ ...row, path: "/secret" }] }, { entries: [{ ...row, code: "private diagnostic" }] },
    { entries: [row, row] }, { entries: [{ ...row, availability: "unavailable", authentication: "authenticated" }] },
    { entries: [{ ...row, code: "RUNTIME_EXTENSION_UNTRUSTED" }] }, { entries: Object.assign([row], { private: true }) }]) {
    assert.throws(() => protocol.validateResult(input), { code: "RUNTIME_EXTENSION_STATUS_INVALID" });
  }
  assert.throws(() => protocol.validateParams({ acquire: true }), { code: "RUNTIME_EXTENSION_STATUS_INVALID" });
});
test("Backend projects extension inventory, guards missing bindings and keeps cold attachments unverified", async () => {
  const f = fixture(), backend = new ShoggothBackend({ paths: {} });
  backend.getStatus = async () => ({ connected: true }); backend.listOAuthProviders = async () => ({ providers: [] });
  backend._call = async method => { assert.equal(method, protocol.METHOD); return { entries: [f.read()] }; };
  let row = (await backend.getRuntimeStatuses()).find(row => row.runtime === runtime);
  assert.equal(row.readiness, "unverified"); assert.equal(row.toggleable, false);
  assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, true);
  const caps = backend._chatCapabilitiesForProfile({ id: "profile", runtime, runtimeAccountId: accountId });
  assert.deepEqual(caps.attachments, {}); assert.equal(caps.steer, false); assert.deepEqual(caps.runtimeFeatures, runtimeFeatureSupport(null));
  f.invalidate(); row = (await backend.getRuntimeStatuses()).find(row => row.runtime === runtime);
  assert.equal(row.installation, "unavailable"); assert.equal(row.readiness, "unverified");
  assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, false);
  assert.throws(() => backend._assertRuntimeEnabled({ agentId: "agent", runtime, runtimeAccountId: accountId }), { code: "RUNTIME_IDENTITY_UNAVAILABLE" });
  backend._call = async () => { throw Error("offline"); }; await backend.getRuntimeStatuses();
  assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, false);
});

test("diagnostic stage samples keep unknown outcomes out of success and expose their scope", () => {
  const { RuntimeTelemetry } = require("../app/agent-service/runtime-telemetry");
  const telemetry = new RuntimeTelemetry();
  for (const outcome of ["success", "error", "unknown", "stop-unconfirmed"]) telemetry.record("runtime.stage", { stage: "acp_cancel", outcome });
  for (const outcome of ["unknown", "success", "error"]) telemetry.record("runtime.switch.first_turn", { outcome });
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot.stageSamples.acp_cancel, { count: 4, success: 1, error: 1, unknown: 2 });
  assert.deepEqual(snapshot.switchFirstTurnSamples, { known: 2, unknown: 1, succeeded: 1, failed: 1 });
  assert.equal(snapshot.switchFirstTurnFailureRate, 0.5); assert.equal(snapshot.scope, "service-process");
  for (let i = 0; i < 300; i++) telemetry.record("runtime.stage", { stage: "stage_" + i, outcome: "unknown" });
  assert.equal(Object.keys(telemetry.snapshot().stageSamples).length, 128);
});


test("real authenticated Service status IPC stays passive and immediately reflects catalog and package retirement", async t => {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  const { resolveServicePaths } = require("../app/agent-service/paths");
  const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
  const { createAgentService } = require("../app/agent-service/server");
  const { requestService, readClientToken } = require("../app/agent-service/client");
  const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
  const directory = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-extension-status-ipc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = resolveServicePaths({ homeDir: directory, trustedRoot: directory, stateRoot: path.join(directory, "state"),
    cacheRoot: path.join(directory, "cache"), profileRoot: path.join(directory, "profile") });
  const command = fs.realpathSync(process.execPath), script = path.join(directory, "worker.cjs"), marker = path.join(directory, "started");
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\nprocess.stdin.resume();\n`, { mode: 0o600 });
  const manifest = { version: 1, runtime, transport: "acp", command, args: [script], files: [command, script].map(file => ({
    path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  const catalog = new RuntimeExtensionCatalog(paths);
  catalog.install({ manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  const service = createAgentService({ paths, runtimeStorageHomedir: directory, parentEnv: { HOME: directory, PATH: "/usr/bin:/bin" },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  try {
    await service.start();
    const read = () => requestService(paths, { token: readClientToken(paths), version: SERVICE_PROTOCOL_VERSION, method: protocol.METHOD, params: {} });
    const first = (await read()).entries.find(entry => entry.runtime === runtime);
    assert.equal(first.availability, "available"); assert.equal(first.authentication, "unverified"); assert.deepEqual(first.features, runtimeFeatureSupport(null));
    assert.equal(JSON.stringify(first).includes(directory), false); assert.equal(fs.existsSync(marker), false);
    catalog.setEnabled(runtime, false);
    const disabled = (await read()).entries.find(entry => entry.runtime === runtime);
    assert.equal(disabled.code, "RUNTIME_EXTENSION_DISABLED"); assert.equal(disabled.availability, "unavailable");
    catalog.setEnabled(runtime, true); fs.appendFileSync(script, "// package replacement\n");
    const changed = (await read()).entries.find(entry => entry.runtime === runtime);
    assert.equal(changed.availability, "unavailable"); assert.equal(changed.authentication, "unverified");
    assert.equal(changed.code, "RUNTIME_EXTENSION_UNTRUSTED"); assert.equal(fs.existsSync(marker), false);
    assert.equal(service.runtimeManager.statistics().hosts, 0);
  } finally { await service.stop({ notify: false }); }
});

test("an extension status response cannot cross a Backend Service generation", async () => {
  const backend = new ShoggothBackend({ paths: {} }), row = fixture().read();
  backend._call = async () => ({ entries: [row] }); await backend._refreshExtensionRuntimeStatuses();
  assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, true);
  backend._generation++; assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, false);
  let complete; backend._call = async () => new Promise(resolve => { complete = resolve; });
  const pending = backend._refreshExtensionRuntimeStatuses(); backend._generation++;
  complete({ entries: [row] }); assert.deepEqual(await pending, []);
  assert.equal(backend._bindingAvailability("agent", runtime, accountId).available, false);
});

test("trusted terminal reasons have distinct product messages and exact localized UI mappings", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const ts = require("../app/manage-ui/node_modules/typescript");
  const source = fs.readFileSync(path.join(__dirname, "../app/manage-ui/src/lib/gatewayErrors.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mapped = { exports: {} }; vm.runInNewContext(`(function(module,exports){${compiled}\n})(module,module.exports)`, { module: mapped });
  const cases = [
    ["RUNTIME_MAX_TOKENS", "runtimeMaxTokens", "Agent 已达到本轮输出长度限制，本轮未完成；请缩小任务范围后继续"],
    ["RUNTIME_MAX_TURN_REQUESTS", "runtimeMaxTurnRequests", "Agent 已达到本轮请求次数限制，本轮已停止；请缩小任务范围后继续"],
    ["RUNTIME_REFUSED", "runtimeRefused", "Agent 拒绝了本轮请求，原生会话不会保留这一轮；请调整请求后再发送"],
  ];
  const backend = new ShoggothBackend({ paths: {} });
  for (const [code, key, message] of cases) {
    const errors = [], run = { id: "terminal-probe", source: "chat", status: "failed", errorCode: code };
    await backend._settleTerminal({ sessionKey: "terminal-session", run, hooks: { error: value => errors.push(value) }, poll: { cancelled: false } }, { settled: false }, run);
    assert.deepEqual(errors, [message]);
    for (const raw of [code, message, `错误：${message}`]) assert.equal(mapped.exports.translateGatewayError(raw, value => value), `chat.gwErrors.${key}`);
    const detailed = `${code}: provider detail must stay visible`;
    assert.equal(mapped.exports.translateGatewayError(detailed, value => value), detailed);
  }
});
