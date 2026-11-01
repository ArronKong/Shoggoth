"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { RuntimeExtensionAdapter } = require("../app/agent-service/runtime-extension-adapter");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
const { verifyManifest } = require("../app/agent-service/runtime-extension-manifest");
const { resolveServicePaths } = require("../app/agent-service/paths");
const binding = { runtime: "ext-identity-fixture", runtimeProfileId: "identity-profile", runtimeAccountId: "identity-account" };
const policy = { sandbox: "danger-full-access", approvalPolicy: "never" };
const script = String.raw`
"use strict";
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const mode = process.argv[2], acp = mode.startsWith("acp");
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
if (mode === "descendant") {
  const descendant = require("node:child_process").spawn(process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: false });
  descendant.once("message", () => fs.writeFileSync(path.join(process.env.HOME, "descendant.pid"), String(descendant.pid)));
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) return;
  fs.appendFileSync(path.join(process.env.HOME, "requests.jsonl"), JSON.stringify({ method: message.method }) + "\n");
  let result;
  if (message.method === "initialize") {
    if (acp) result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    else result = { version: mode === "bad-hello" ? 99 : 1, binding: message.params.binding, homeIdentity: process.env.HOME,
      capabilities: { "session.start": true, "session.read": true, "session.list": true, "turn.start": true,
        "turn.interrupt": true, "models.list": true, events: true, serverRequests: true, ...(mode === "forged-model" ? {
        "model.generate.toolFree": true, "model.generate.settings": true, "model.resolve.toolFree": true,
        "model.resolve.explicit": true, "model.session.release": true, "turn.start.prepare": true } : {}) } };
    if (mode === "acp-grok-ack") setTimeout(() => send({ id: "skills-reload", result: { result: { reloaded: 1 } } }), 30);
  } else if (message.method === "runtime/sessionStart") result = { session: { id: "fixture-session", cwd: message.params.cwd } };
  else if (message.method === "runtime/sessionRead") result = { session: { id: message.params.sessionId, turns: [] } };
  else if (message.method === "runtime/sessionList") result = { data: [] };
  else if (message.method === "runtime/modelsList") result = { data: [] };
  else if (message.method === "runtime/authenticationState") result = { authenticated: true };
  else if (message.method === "runtime/turnStart") {
    if (mode === "unknown") return send({ id: message.id, error: { code: -32603, message: "execution could not be determined" } });
    result = { turn: { id: "fixture-turn", status: "inProgress" } };
    if (mode === "reverse") setTimeout(() => send({ id: "permission-fixture", method: "fixture/permission", params: {} }), 15);
  } else if (message.method === "runtime/turnInterrupt") {
    send({ method: "runtime/event", params: { known: true, type: "complete", status: "canceled",
      sessionId: message.params.sessionId, turnId: "fixture-turn" } }); result = {};
  } else if (message.method === "session/new") result = { sessionId: "fixture-acp-session" };
  else if (message.method === "session/prompt") {
    if (mode === "acp-unknown") return send({ id: message.id, error: { code: -32603, message: "unknown" } });
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/cancel") return;
  else return send({ id: message.id, error: { code: -32601, message: "unsupported" } });
  send({ id: message.id, result });
});
`;
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error("fixture observation timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(t, mode = "hold", options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-extension-identity-")));
  const file = path.join(root, "fixture.cjs"); fs.writeFileSync(file, script, { mode: 0o700 });
  const command = fs.realpathSync(process.execPath);
  const manifest = { version: 1, runtime: binding.runtime, transport: mode.startsWith("acp") ? "acp" : "stdio",
    command, args: [file, mode], files: [command, file].map(file => ({ path: file, sha256: sha(fs.readFileSync(file)) })),
    endpoint: null, credentialRef: null };
  const keys = crypto.generateKeyPairSync("ed25519");
  const envelope = { manifest, signature: crypto.sign(null, Buffer.from(JSON.stringify(Object.fromEntries(
    Object.keys(manifest).sort().map(key => [key, manifest[key]])))), keys.privateKey).toString("base64") };
  const trustedKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  let verifications = 0;
  const adapter = new RuntimeExtensionAdapter({ manifest, paths, verify: () => { verifications++; return verifyManifest(envelope, trustedKey); },
    getManifestIdentity: () => sha(JSON.stringify([envelope, trustedKey])), ...options });
  const acquire = (value = binding, extra = {}) => adapter.acquire(value, { workspace: root, permissionPolicy: policy, ...extra });
  t.after(async () => { await adapter.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, envelope, trustedKey, adapter, acquire, verifications: () => verifications };
}

test("a real signed extension scopes evidence by executable, policy, account and handle generation", async t => {
  const f = fixture(t, "hold", { getAccountGeneration: () => 7 });
  const registry = new RuntimeAdapterRegistry(); registry.register(binding.runtime, f.adapter);
  const handle = await registry.acquire(binding, { workspace: f.root, permissionPolicy: policy });
  assert.match(handle.capabilityEvidence.scope.executableIdentity, /^[a-f0-9]{64}$/u);
  assert.deepEqual(handle.capabilityEvidence.scope.permissionPolicy, policy);
  assert.equal(handle.host.accountGeneration, 7); assert.equal(handle.host.transport, "stdio");
  assert.equal(handle.host.rpc.stderrAuthHints, true);
  assert.equal(Object.isFrozen(handle.host.permissionPolicy), true);
  assert.equal(await registry.acquire(binding, { workspace: f.root, permissionPolicy: policy }), handle);
  const other = { ...binding, runtimeAccountId: "identity-account-b" };
  const second = await registry.acquire(other, { workspace: f.root, permissionPolicy: policy });
  assert.notEqual(handle.host.child.pid, second.host.child.pid);
  assert.notEqual(handle.identity.homeIdentity, second.identity.homeIdentity);
  assert.notEqual(handle.capabilityEvidence.scope.instanceId, second.capabilityEvidence.scope.instanceId);
  await registry.stopAll(); assert.equal(registry.statistics().hosts, 0);
});

test("same-path executable observations invalidate old handles without stopping active execution", async t => {
  const f = fixture(t), handle = await f.acquire(), pid = handle.host.child.pid;
  await handle.turnStart({ sessionId: "fixture-session", operationId: "running" });
  const previous = f.adapter.runtimeIdentityKey(binding), stamp = fs.statSync(f.file);
  fs.utimesSync(f.file, stamp.atime, new Date(stamp.mtimeMs + 1000));
  assert.notEqual(f.adapter.runtimeIdentityKey(binding), previous);
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  await assert.rejects(handle.modelsList({}), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  assert.equal(f.adapter.handles.size, 1); assert.equal(handle.host.state, "ready"); process.kill(pid, 0);
  await handle.turnInterrupt({ sessionId: "fixture-session" });
  assert.equal((await handle.sessionRead({ sessionId: "fixture-session" })).session.id, "fixture-session");
  await f.adapter.stop(binding); const replacement = await f.acquire(); assert.notEqual(replacement.host.child.pid, pid);
});

test("tampered signed files and a changed manifest are rejected before a cache hit or spawn", async t => {
  const f = fixture(t), handle = await f.acquire();
  fs.appendFileSync(f.file, "\n// changed after installation\n");
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
  assert.equal(f.adapter.handles.size, 1); assert.equal(handle.host.state, "ready");
  await f.adapter.stopAll();
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXTENSION_UNTRUSTED" }); assert.equal(f.adapter.handles.size, 0);
});

test("permission snapshots cannot be mutated or reused under a changed policy", async t => {
  const f = fixture(t), requested = { ...policy, audit: { revision: 1 } };
  const handle = await f.acquire(binding, { permissionPolicy: requested });
  requested.audit.revision = 2;
  assert.equal(handle.host.permissionPolicy.audit.revision, 1);
  assert.equal(Object.isFrozen(handle.host.permissionPolicy.audit), true);
  await assert.rejects(f.acquire(binding, { permissionPolicy: requested }), { code: "RUNTIME_PERMISSION_CHANGED" });
  await assert.rejects(f.acquire(binding, { permissionPolicy: { ...policy, sandbox: "read-only" } }), { code: "RUNTIME_PERMISSION_UNSUPPORTED" });
  assert.equal(f.adapter.handles.size, 1); assert.equal(handle.host.state, "ready");
});

test("account generations fence new admissions while cancellation, history and stop remain available", async t => {
  let generation = 1; const f = fixture(t, "hold", { getAccountGeneration: () => generation });
  const handle = await f.acquire(), first = f.adapter.runtimeIdentityKey(binding);
  await handle.turnStart({ sessionId: "fixture-session", operationId: "running" }); generation++;
  assert.notEqual(f.adapter.runtimeIdentityKey(binding), first);
  await assert.rejects(f.acquire(), { code: "RUNTIME_ACCOUNT_GENERATION_STALE" });
  await assert.rejects(handle.modelsList({}), { code: "RUNTIME_ACCOUNT_GENERATION_STALE" });
  await handle.turnInterrupt({ sessionId: "fixture-session" });
  assert.equal((await handle.sessionRead({ sessionId: "fixture-session" })).session.id, "fixture-session");
  await f.adapter.stop(binding); assert.equal((await f.acquire()).host.accountGeneration, 2);
});

test("signing identity changes invalidate registration even after the previous host has stopped", async t => {
  let identity = sha("signer-one");
  const f = fixture(t, "hold", { getManifestIdentity: () => identity });
  const handle = await f.acquire(); identity = sha("signer-two");
  assert.throws(() => f.adapter.runtimeIdentityKey(binding), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
  await assert.rejects(handle.modelsList({}), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  assert.equal(handle.host.state, "ready"); assert.equal(f.adapter.handles.size, 1);
  await f.adapter.stop(binding);
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXTENSION_UNTRUSTED" }); assert.equal(f.adapter.handles.size, 0);
});

test("a registration snapshot cannot adopt a changed catalog identity before its first host", async t => {
  const f = fixture(t, "hold", { expectedManifestIdentity: sha("registered"), getManifestIdentity: () => sha("changed") });
  await assert.rejects(f.acquire(), { code: "RUNTIME_EXTENSION_UNTRUSTED" }); assert.equal(f.adapter.handles.size, 0);
});

test("manifest metadata tampering is fenced by the live signature identity without hashing file contents", async t => {
  const f = fixture(t), handle = await f.acquire(), reads = f.verifications();
  for (let index = 0; index < 5; index++) { f.adapter.runtimeIdentityKey(binding); handle.host.assertRuntimeIdentityCurrent(); }
  await handle.modelsList({}); assert.equal(f.verifications(), reads, "existing host observation does not rehash signed files");
  assert.equal(await f.acquire(), handle); assert.equal(f.verifications(), reads + 1, "new admission verifies the complete package");
  f.envelope.manifest.args.push("changed-metadata");
  assert.throws(() => f.adapter.runtimeIdentityKey(binding), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
  await assert.rejects(handle.modelsList({}), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  assert.equal(f.verifications(), reads + 1); await handle.turnInterrupt({ sessionId: "fixture-session" });
});

test("plugin self-advertisement cannot enable isolated model execution or its dependent helpers", async t => {
  const f = fixture(t, "forged-model"), registry = new RuntimeAdapterRegistry(); registry.register(binding.runtime, f.adapter);
  const handle = await registry.acquire(binding, { workspace: f.root, permissionPolicy: policy });
  for (const name of ["model.generate.toolFree", "model.generate.settings", "model.resolve.toolFree", "model.resolve.explicit", "model.session.release"]) {
    assert.equal(handle.capabilities[name], false); assert.equal(handle.capabilityEvidence.observations[name].state, "unsupported");
  }
  for (const method of ["generateModelOnly", "resolveModelOnly", "releaseModelOnlySession"]) assert.equal(handle[method], undefined);
  assert.equal(handle.capabilities["turn.start.prepare"], false);
  assert.equal(f.adapter.modelOnly, false); await registry.stopAll();
});

test("concurrent identical acquires share startup and profile retirement completes before reacquire", async t => {
  const f = fixture(t), [first, second] = await Promise.all([f.acquire(), f.acquire()]); assert.equal(first, second);
  const stopping = f.adapter.stop(binding), next = f.acquire(); await stopping;
  const replacement = await next; assert.notEqual(first.host.child.pid, replacement.host.child.pid);
  assert.equal(first.host.state, "stopped"); assert.equal(f.adapter.handles.size, 1);
});

test("active turns and pending reverse requests prevent extension idle retirement", async t => {
  const f = fixture(t, "reverse"), handle = await f.acquire();
  assert.equal(f.adapter.isBindingIdle(binding), true);
  let release, received = false;
  handle.registerServerRequestHandler("fixture/permission", () => { received = true; return new Promise(resolve => { release = () => resolve({ allowed: false }); }); });
  await handle.turnStart({ sessionId: "fixture-session", operationId: "active" });
  assert.equal(f.adapter.isBindingIdle(binding), false); await until(() => received);
  await handle.turnInterrupt({ sessionId: "fixture-session" });
  assert.equal(f.adapter.isBindingIdle(binding), false, "reverse request outlives the runtime turn");
  release(); await until(() => f.adapter.isBindingIdle(binding));
});

test("unknown execution blocks idle retirement and subsequent dispatch without replay", async t => {
  const f = fixture(t, "unknown"), handle = await f.acquire();
  const input = { sessionId: "fixture-session", operationId: "uncertain" };
  await assert.rejects(handle.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  assert.equal(f.adapter.isBindingIdle(binding), false);
  await assert.rejects(handle.turnStart(input), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  const requests = fs.readFileSync(path.join(handle.host.home, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter(item => item.method === "runtime/turnStart").length, 1);
  assert.equal(await f.acquire(), handle); assert.equal(f.adapter.handles.size, 1);
});

test("generic ACP rejects Grok maintenance acknowledgements using neutral protocol errors", async t => {
  const f = fixture(t, "acp-grok-ack"), handle = await f.acquire();
  await handle.terminated;
  assert.equal(handle.host.rpc.constructor.name, "AcpJsonlClient");
  assert.equal(handle.host.rpc.stderrAuthHints, false);
  assert.equal(handle.host.rpc.fatalError.code, "ACP_UNKNOWN_RESPONSE_ID");
  assert.equal(f.adapter.handles.size, 0); assert.equal(handle.host.state, "stopped");
});

test("generic ACP unresolved ledger turns prevent idle retirement", async t => {
  const f = fixture(t, "acp-unknown"), handle = await f.acquire();
  const { session } = await handle.sessionStart({ cwd: f.root, source: "acp-source" });
  assert.equal(f.adapter.isBindingIdle(binding), true);
  await assert.rejects(handle.turnStart({ sessionId: session.id, cwd: f.root, operationId: "acp-uncertain", text: "fixture" }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  assert.equal(f.adapter.isBindingIdle(binding), false);
});

test("stop failure retains the host and pending termination until physical cleanup is confirmed", async t => {
  const f = fixture(t), registry = new RuntimeAdapterRegistry(); registry.register(binding.runtime, f.adapter);
  const handle = await registry.acquire(binding, { workspace: f.root, permissionPolicy: policy });
  const original = process.kill, target = -handle.host.child.pid;
  process.kill = function (pid, signal) { if (pid === target) throw Object.assign(new Error("fixture denied process group query"), { code: "EPERM" }); return original.call(this, pid, signal); };
  t.after(() => { process.kill = original; });
  try {
    await assert.rejects(handle.stop(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    await assert.rejects(f.adapter.stopAll(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    await assert.rejects(f.acquire(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    const otherWorkspace = path.join(f.root, "other-workspace"); fs.mkdirSync(otherWorkspace);
    await assert.rejects(f.acquire(binding, { workspace: otherWorkspace }), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert.equal(handle.host.cleanupIncomplete, true); assert.equal(f.adapter.handles.size, 1);
    assert.equal(registry.statistics().hosts, 1); assert.equal(f.adapter.isBindingIdle(binding), false);
    let terminated = false; handle.terminated.then(() => { terminated = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(terminated, false);
  } finally { process.kill = original; }
  await registry.stopAll(); await handle.terminated;
  assert.equal(f.adapter.handles.size, 0); assert.equal(registry.statistics().hosts, 0);
});

test("failed initialization keeps an unconfirmed child reachable for a later shutdown retry", async t => {
  const f = fixture(t, "bad-hello"), original = process.kill;
  process.kill = function (pid, signal) { if (pid < -1) throw Object.assign(new Error("fixture denied cleanup"), { code: "EPERM" }); return original.call(this, pid, signal); };
  t.after(() => { process.kill = original; });
  try {
    await assert.rejects(f.acquire(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert.equal(f.adapter.handles.size, 1);
    const entry = [...f.adapter.handles.values()][0];
    assert.equal(entry.host.cleanupIncomplete, true); assert.ok(entry.host.child.pid > 1);
    await assert.rejects(f.adapter.stopAll(), { code: "RUNTIME_STOP_UNCONFIRMED" });
  } finally { process.kill = original; }
  await f.adapter.stopAll(); assert.equal(f.adapter.handles.size, 0);
});


test("global stop coalesces and fences an acquire already waiting for profile retirement", async t => {
  const f = fixture(t), handle = await f.acquire(), originalStop = handle.host.stop;
  let release; const blocked = new Promise(resolve => { release = () => resolve(originalStop()); });
  handle.host.stop = () => blocked;
  const profileStop = f.adapter.stop(binding), waitingAcquire = f.acquire();
  const globalStop = f.adapter.stopAll(); assert.equal(f.adapter.stopAll(), globalStop);
  const rejected = assert.rejects(waitingAcquire, { code: "RUNTIME_REGISTRY_STOPPING" });
  release(); await Promise.all([profileStop, globalStop, rejected]);
  assert.equal(f.adapter.handles.size, 0); assert.equal(handle.host.state, "stopped");
  assert.notEqual((await f.acquire()).host.child.pid, handle.host.child.pid);
});


function controlledGate() {
  let counter = 0;
  return { reserveMcpServer() { return { reservationId: String(++counter).padStart(64, "0"), name: "shoggoth",
    command: fs.realpathSync(process.execPath), args: [], env: [] }; }, bindMcpServer() {}, revokeMcpServer() {} };
}
function runContract(f, runId) { return { ...binding, runId, profileId: "identity-product-profile", workspace: f.root }; }

test("Generic ACP execution contracts isolate real subprocesses per Run while preserving same-Run reuse", async t => {
  const f = fixture(t, "acp-hold", { mcpGateIssuer: controlledGate() });
  const firstOptions = { executionContract: runContract(f, "run-first") }, secondOptions = { executionContract: runContract(f, "run-second") };
  const [first, second] = await Promise.all([f.acquire(binding, firstOptions), f.acquire(binding, secondOptions)]);
  assert.notEqual(first.host.child.pid, second.host.child.pid);
  assert.equal(first.host.mcpExecutionRunId, "run-first"); assert.equal(second.host.mcpExecutionRunId, "run-second");
  assert.equal(await f.acquire(binding, firstOptions), first); assert.equal(f.adapter.handles.size, 2);
});

test("full-access manual approval is supported only for ACP and never becomes workspace/read-only isolation", async t => {
  const f = fixture(t, "acp-hold"), manual = { sandbox: "danger-full-access", approvalPolicy: "on-request" };
  const handle = await f.acquire(binding, { permissionPolicy: manual }); assert.deepEqual(handle.host.permissionPolicy, manual);
  assert.equal(handle.capabilities.serverRequests, true);
  for (const sandbox of ["read-only", "workspace-write"]) {
    await assert.rejects(f.acquire(binding, { permissionPolicy: { ...manual, sandbox } }), { code: "RUNTIME_PERMISSION_UNSUPPORTED" });
  }
  const other = fixture(t, "hold");
  await assert.rejects(other.acquire(binding, { permissionPolicy: manual }), { code: "RUNTIME_PERMISSION_UNSUPPORTED" });
});

test("a bounded ACP pool retires only a Host proven idle by both local state and Service ownership", async t => {
  let retiredChecks = 0;
  const f = fixture(t, "acp-hold", { mcpGateIssuer: controlledGate(), resolveMaxHosts: () => 1,
    canRetireChangedHost(value, host, excludingRunId) { retiredChecks++; assert.equal(value.runtime, binding.runtime);
      assert.equal(host.mcpExecutionRunId, "run-first"); assert.equal(excludingRunId, "run-second"); return true; } });
  const first = await f.acquire(binding, { executionContract: runContract(f, "run-first") });
  const second = await f.acquire(binding, { executionContract: runContract(f, "run-second") });
  assert.equal(first.host.state, "stopped"); assert.notEqual(first.host.child.pid, second.host.child.pid);
  assert.equal(f.adapter.handles.size, 1); assert.equal(retiredChecks, 1);
});

test("capacity pressure never stops a Host when Service activity is unknown", async t => {
  const f = fixture(t, "acp-hold", { mcpGateIssuer: controlledGate(), resolveMaxHosts: () => 1 });
  const first = await f.acquire(binding, { executionContract: runContract(f, "run-first") });
  await assert.rejects(f.acquire(binding, { executionContract: runContract(f, "run-second") }), { code: "RUNTIME_HOST_CAPACITY" });
  assert.equal(first.host.state, "ready"); process.kill(first.host.child.pid, 0); assert.equal(f.adapter.handles.size, 1);
});

test("unresolved ACP execution cannot be evicted to make room for another Run", async t => {
  const f = fixture(t, "acp-unknown", { mcpGateIssuer: controlledGate(), resolveMaxHosts: () => 1, canRetireChangedHost: () => true });
  const first = await f.acquire(binding, { executionContract: runContract(f, "run-first") });
  const { session } = await first.sessionStart({ source: "unknown-run", cwd: f.root });
  await assert.rejects(first.turnStart({ sessionId: session.id, cwd: f.root, operationId: "unknown-operation", text: "fixture" }), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
  await assert.rejects(f.acquire(binding, { executionContract: runContract(f, "run-second") }), { code: "RUNTIME_HOST_CAPACITY" });
  assert.equal(first.host.state, "ready"); assert.equal(f.adapter.handles.size, 1); process.kill(first.host.child.pid, 0);
});

test("failed ACP gate revocation still stops its real child and retains the cleanup barrier until retry", async t => {
  const gate = controlledGate(); let refuseRevoke = true, revoked = 0;
  gate.revokeMcpServer = () => { revoked++; if (refuseRevoke) throw Error("controlled revoke failure"); };
  const f = fixture(t, "acp-hold", { mcpGateIssuer: gate });
  const options = { executionContract: runContract(f, "run-revoke") }, handle = await f.acquire(binding, options);
  await handle.sessionStart({ source: "revocation-test", cwd: f.root });
  const pid = handle.host.child.pid;
  try {
    await assert.rejects(handle.stop(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "physical cleanup continues after logical gate failure");
    assert.equal(handle.host.cleanupIncomplete, true); assert.equal(f.adapter.handles.size, 1);
    await assert.rejects(f.acquire(binding, options), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert.equal(f.adapter.isBindingIdle(binding), false);
  } finally { refuseRevoke = false; }
  await f.adapter.stopAll(); await handle.terminated;
  assert.equal(f.adapter.handles.size, 0); assert(revoked >= 2);
});


test("a real child close tolerates transient group EPERM only until real ESRCH confirms retirement", async t => {
  const f = fixture(t, "acp-hold"), handle = await f.acquire(), child = handle.host.child;
  const original = process.kill, target = -child.pid; let closed = false, unknown = false, injected = 0, confirmed = false;
  child.once("close", () => { closed = true; });
  process.kill = function (pid, signal) {
    if (pid === target && signal === 0 && closed && injected < 3) {
      injected++; unknown = true; throw Object.assign(Error("controlled transient probe denial"), { code: "EPERM" });
    }
    if (pid === target && signal !== 0) assert.equal(unknown, false, "an unknown group must never receive another signal");
    try { return original.call(this, pid, signal); }
    catch (error) { if (pid === target && signal === 0 && closed && error.code === "ESRCH") { confirmed = true; unknown = false; } throw error; }
  };
  try { await handle.stop(); await handle.terminated; }
  finally { process.kill = original; }
  assert.equal(injected, 3); assert.equal(confirmed, true); assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(handle.host.state, "stopped"); assert.equal(f.adapter.handles.size, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("persistent group EPERM after real child close retains the ACP barrier until an explicit confirmed retry", async t => {
  const gate = controlledGate(), f = fixture(t, "acp-hold", { mcpGateIssuer: gate });
  const options = { executionContract: runContract(f, "run-permission-denied") }, handle = await f.acquire(binding, options);
  await handle.sessionStart({ source: "group-probe-denied", cwd: f.root });
  const bridge = handle.host.acpBridge, original = process.kill, target = -handle.host.child.pid;
  let closed = false, denied = 0, signalsAfterClose = 0, terminated = false;
  handle.terminated.then(() => { terminated = true; }); handle.host.child.once("close", () => { closed = true; });
  process.kill = function (pid, signal) {
    if (pid === target && closed) {
      if (signal === 0) { denied++; throw Object.assign(Error("controlled persistent probe denial"), { code: "EPERM" }); }
      signalsAfterClose++;
    }
    return original.call(this, pid, signal);
  };
  const started = Date.now();
  try {
    await assert.rejects(handle.stop(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert(Date.now() - started < 5000, "unknown state must remain within the original four-second stop budget");
    assert.equal(closed, true); assert(denied > 1); assert.equal(signalsAfterClose, 0);
    assert.equal(handle.host.state, "cleanupIncomplete"); assert.equal(handle.host.cleanupIncomplete, true);
    assert.equal(handle.host.acpBridge, bridge); assert.equal(bridge.closed, true); assert.equal(f.adapter.handles.size, 1);
    assert.equal(terminated, false); await assert.rejects(f.acquire(binding, options), { code: "RUNTIME_STOP_UNCONFIRMED" });
  } finally { process.kill = original; }
  await handle.stop(); await handle.terminated;
  assert.equal(handle.host.state, "stopped"); assert.equal(handle.host.cleanupIncomplete, false); assert.equal(f.adapter.handles.size, 0);
});

test("a confirmed live descendant still receives SIGKILL and must disappear before the host retires", async t => {
  const f = fixture(t, "descendant"), handle = await f.acquire(), pidFile = path.join(handle.host.home, "descendant.pid");
  await until(() => fs.existsSync(pidFile)); const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  const original = process.kill, target = -handle.host.child.pid, signals = [];
  process.kill = function (pid, signal) { if (pid === target && signal !== 0) signals.push(signal); return original.call(this, pid, signal); };
  try { await handle.stop(); }
  finally { process.kill = original; }
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(handle.host.state, "stopped"); assert.equal(f.adapter.handles.size, 0);
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(target, 0), { code: "ESRCH" });
  t.diagnostic(JSON.stringify({ boundary: "real descendant in Adapter detached process group", workerPid: handle.host.child.pid,
    descendantPid: descendant, signals, descendantProbe: "ESRCH", processGroupProbe: "ESRCH", hostState: handle.host.state }));
});

test("a denied group signal never escalates or releases a still-live host before explicit retry", async t => {
  const f = fixture(t), handle = await f.acquire(), original = process.kill, target = -handle.host.child.pid, signals = [];
  process.kill = function (pid, signal) {
    if (pid === target && signal !== 0) { signals.push(signal); throw Object.assign(Error("controlled signal denial"), { code: "EPERM" }); }
    return original.call(this, pid, signal);
  };
  const started = Date.now();
  try {
    await assert.rejects(handle.stop(), { code: "RUNTIME_STOP_UNCONFIRMED" });
    assert(Date.now() - started < 5000); assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(handle.host.cleanupIncomplete, true); assert.equal(f.adapter.handles.size, 1); original.call(process, handle.host.child.pid, 0);
  } finally { process.kill = original; }
  await handle.stop(); assert.equal(handle.host.state, "stopped");
});

test("unexpected group probe errors retain the immediate failure boundary and can be retried", async t => {
  const f = fixture(t), handle = await f.acquire(), original = process.kill, target = -handle.host.child.pid;
  process.kill = function (pid, signal) { if (pid === target && signal === 0) throw Object.assign(Error("controlled unexpected probe failure"), { code: "EIO" }); return original.call(this, pid, signal); };
  const started = Date.now();
  try { await assert.rejects(handle.stop(), { code: "RUNTIME_STOP_UNCONFIRMED" }); assert(Date.now() - started < 1000); assert.equal(f.adapter.handles.size, 1); }
  finally { process.kill = original; }
  await handle.stop(); assert.equal(handle.host.state, "stopped");
});
