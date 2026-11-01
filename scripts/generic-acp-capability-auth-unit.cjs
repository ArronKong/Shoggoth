"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { AcpJsonlClient } = require("../app/agent-service/acp-jsonl-client");
const { createAcpHandle } = require("../app/agent-service/runtime-acp-handle");
const { readRuntimeAuthenticationState } = require("../app/agent-service/runtime-adapter");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const { runtimeOperationSupport } = require("../app/agent-service/runtime-capability-evidence");
const policy = Object.freeze({ approvalPolicy: "never", sandbox: "danger-full-access" });
const binding = Object.freeze({ runtime: "ext-auth-fixture", runtimeProfileId: "profile", runtimeAccountId: "account-a" });

async function fixture({ hello = { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  root, targetBinding = binding, host: hostOptions = {}, rpc: suppliedRpc } = {}) {
  const ownsRoot = !root;
  root ||= fs.realpathSync(fs.mkdtempSync("/tmp/generic-acp-auth-"));
  const calls = [], failures = new Map(), replies = new Map();
  let session = 0, closed;
  const terminated = new Promise(resolve => { closed = resolve; });
  const host = { transport: "acp", permissionPolicy: policy, runtimeIdentity: { digest: "fixture-digest" },
    assertRuntimeIdentityCurrent() {}, canRetireIdle() { return true; }, ...hostOptions };
  const rpc = suppliedRpc || { subscribe() { return () => {}; }, registerServerRequestHandler() { return () => {}; },
    preflightRequest() {}, notify: async () => {},
    async request(method, params, options) {
      calls.push({ method, params, options });
      if (method === "session/prompt") { options?.onWriteAttempt?.(); options?.onWritten?.(); }
      if (failures.has(method)) throw failures.get(method);
      if (replies.has(method)) return replies.get(method);
      if (method === "initialize") return hello;
      if (method === "session/new") return { sessionId: `${targetBinding.runtimeAccountId}-session-${++session}` };
      if (method === "session/load") return {};
      if (method === "session/prompt") return { stopReason: "end_turn" };
      throw Error("Unexpected fixture RPC");
    } };
  try {
    const raw = await createAcpHandle({ binding: targetBinding, rpc, home: root, workspace: root,
      stateDir: root, trustedRoot: root, stop: async () => closed(), terminated, host });
    return { root, raw, handle: runtimeHandleV1(raw, targetBinding), host, calls, failures, replies,
      async close() { closed(); await Promise.resolve(); if (ownsRoot) fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { if (ownsRoot) fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
const start = f => f.handle.sessionStart({ cwd: f.root, source: "fixture-source" });
const prompt = (f, sessionId, operationId = "fixture-operation") => f.handle.turnStart({ cwd: f.root,
  sessionId, operationId, prompt: "controlled fixture prompt" });
const authRequired = () => Object.assign(new Error("Private remote error"), { code: "AUTH_REQUIRED", rpcCode: -32000 });

test("authentication methods never imply a login and status reads perform no ACP request", async () => {
  for (const authMethods of [undefined, [], [{ id: "oauth", name: "Fixture OAuth" }]]) {
    const f = await fixture({ hello: { protocolVersion: 1, authMethods, agentCapabilities: { loadSession: true } } });
    try {
      const before = f.calls.length;
      assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
      assert.deepEqual(await readRuntimeAuthenticationState(f.handle, { allowDeferred: true }), { status: "unverified" });
      assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
      assert.equal(Object.isFrozen(f.host.getCachedAuthenticationState()), true);
      assert.equal(Object.hasOwn(await f.raw.authenticationState(), "credentialPresent"), false);
      assert.equal(f.calls.length, before, "polling must not authenticate, scan credentials, or prompt");
      const handshake = f.calls[0];
      assert.deepEqual(handshake.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } });
      assert.equal(handshake.params.clientInfo.name, "shoggoth");
      assert.equal(handshake.options.timeoutMs, 15_000);
    } finally { await f.close(); }
  }
});

test("only a successful prompt establishes the current Handle authentication fact", async () => {
  const f = await fixture({ hello: { protocolVersion: 1, authMethods: [{ id: "oauth" }], agentCapabilities: { loadSession: true } } });
  let restored;
  try {
    const { session } = await start(f);
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" }, "session/new may defer Provider authentication");
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
    await f.handle.sessionRename({ sessionId: session.id, name: "Local name" });
    await f.handle.sessionArchive({ sessionId: session.id });
    await f.handle.sessionUnarchive({ sessionId: session.id });
    assert.deepEqual(f.calls.map(call => call.method), ["initialize", "session/new"], "metadata remains product-owned");
    await prompt(f, session.id);
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "authenticated" });
    restored = await fixture({ root: f.root });
    assert.deepEqual(await readRuntimeAuthenticationState(restored.handle), { status: "unverified" }, "new Handle cannot inherit old auth proof");
    await restored.handle.sessionResume({ sessionId: session.id });
    assert.deepEqual(await readRuntimeAuthenticationState(restored.handle), { status: "unverified" }, "session/load alone is not a prompt or new-session auth proof");
    await prompt(restored, session.id);
    assert.deepEqual(await readRuntimeAuthenticationState(restored.handle), { status: "unverified" }, "local completed-operation receipt cannot authenticate a new Handle");
    assert.equal(restored.calls.filter(call => call.method === "session/prompt").length, 0);
    await prompt(restored, session.id, "restored-operation");
    assert.deepEqual(await readRuntimeAuthenticationState(restored.handle), { status: "authenticated" });
    assert.equal(restored.calls.filter(call => call.method === "session/prompt").length, 1);
  } finally { await restored?.close(); await f.close(); }
});

test("structured authentication rejection invalidates the fact without replaying a prompt", async () => {
  const f = await fixture();
  try {
    const { session } = await start(f);
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
    await prompt(f, session.id, "successful-operation");
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "authenticated" });
    f.failures.set("session/prompt", authRequired());
    await assert.rejects(prompt(f, session.id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle, { allowDeferred: true }), { status: "unauthenticated" });
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unauthenticated" });
    await assert.rejects(prompt(f, session.id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(f.calls.filter(call => call.method === "session/prompt").length, 2, "one success and one rejection, with no replay");
    assert.equal(f.host.canRetireIdle(), false, "unknown acceptance keeps the host fenced");
  } finally { await f.close(); }
});

test("auth-required session creation cannot become a login success or an automatic retry", async () => {
  const f = await fixture();
  try {
    f.failures.set("session/new", authRequired());
    await assert.rejects(start(f), { code: "AUTH_REQUIRED" });
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unauthenticated" });
    f.failures.delete("session/new");
    await assert.rejects(start(f), { code: "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN" });
    assert.equal(f.calls.filter(call => call.method === "session/new").length, 1);
    assert.equal(f.host.canRetireIdle(), false);
  } finally { await f.close(); }
});

test("unknown failures and diagnostic authentication prose do not prove signed-out state", async () => {
  for (const error of [Object.assign(new Error("authentication required"), { code: "AUTH_REQUIRED", rpcCode: -32603 }),
    Object.assign(new Error("network"), { code: "ACP_REQUEST_TIMEOUT" })]) {
    const f = await fixture();
    try {
      f.failures.set("session/new", error);
      await assert.rejects(start(f));
      assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
    } finally { await f.close(); }
  }
});

test("malformed successful envelopes never create authentication evidence", async () => {
  const f = await fixture();
  try {
    f.replies.set("session/new", null);
    await assert.rejects(start(f), { code: "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN" });
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
  } finally { await f.close(); }
});

test("malformed prompt completion and early cancellation cannot prove authentication", async () => {
  for (const result of [null, { stopReason: "unknown" }, { stopReason: "cancelled" }]) {
    const f = await fixture();
    try {
      const { session } = await start(f);
      f.replies.set("session/prompt", result);
      if (result?.stopReason === "cancelled") assert.equal((await prompt(f, session.id)).turn.status, "canceled");
      else await assert.rejects(prompt(f, session.id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
      assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
    } finally { await f.close(); }
  }
});

test("authenticated state and local ledgers cannot cross RuntimeAccount bindings", async () => {
  const f = await fixture();
  let second;
  try {
    const { session } = await start(f);
    await prompt(f, session.id);
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "authenticated" });
    second = await fixture({ root: f.root, targetBinding: { ...binding, runtimeAccountId: "account-b" } });
    assert.deepEqual(await readRuntimeAuthenticationState(second.handle), { status: "unverified" });
    assert.deepEqual(await second.handle.sessionList({}), { data: [], nextCursor: null });
    assert.notEqual(f.handle.capabilityEvidence.scope.instanceId, second.handle.capabilityEvidence.scope.instanceId);
    assert.equal(second.handle.capabilityEvidence.scope.runtimeAccountId, "account-b");
  } finally { await second?.close(); await f.close(); }
});

test("only implemented loadSession enables resume; unsupported negotiated features stay closed", async () => {
  for (const loadSession of [undefined, false, true]) {
    const f = await fixture({ hello: { protocolVersion: 1, agentCapabilities: { loadSession,
      promptCapabilities: { image: true, audio: true, embeddedContext: true } } } });
    try {
      const { capabilities, capabilityEvidence: evidence } = f.handle;
      assert.equal(capabilities["session.resume"], loadSession === true);
      assert.deepEqual(evidence.observations["session.resume"], {
        state: loadSession === true ? "supported" : "unsupported", source: "handshake" });
      assert.equal(runtimeOperationSupport(evidence, "chat").supported, true);
      for (const name of ["model.generate.toolFree", "serverRequests"])
        assert.equal(capabilities[name], false, name);
      assert.deepEqual(await f.handle.modelsList({}), { data: [], nextCursor: null });
      assert.deepEqual((await f.handle.commandsList({})).commands, []);
      assert.equal(capabilities["turn.start.prepare"], true);
      assert.equal(capabilities["context.compact.auto"], false, "client notification support cannot prove Agent automatic compaction");
      assert.deepEqual(evidence.observations["context.compact.auto"], { state: "unsupported", source: "adapter-contract" });
      for (const kind of ["image", "pdf", "file"]) assert.deepEqual(evidence.observations[`attachment.${kind}`],
        { state: "unsupported", source: "adapter-contract" });
      assert.deepEqual(evidence.observations["permission.enforcement"], { state: "unverified", source: "adapter-contract" });
      for (const name of ["session.rename", "session.archive", "session.unarchive"])
        assert.deepEqual(evidence.observations[name], { state: "supported", source: "adapter-contract" });
      assert.deepEqual(evidence.scope.permissionPolicy, policy);
      assert.equal(evidence.scope.executableIdentity, "fixture-digest");
    } finally { await f.close(); }
  }
});

test("invalid understood handshake declarations fail before any session request", async () => {
  for (const hello of [null, { protocolVersion: 2 }, { protocolVersion: 1, agentCapabilities: [] },
    { protocolVersion: 1, agentCapabilities: { loadSession: "true" } },
    { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: 1 } } }]) {
    await assert.rejects(fixture({ hello }), { code: "RUNTIME_PROTOCOL_INVALID" });
  }
});

test("a late success after executable replacement cannot publish a fresh authentication proof", async () => {
  let replaced = false;
  const f = await fixture({ host: { assertRuntimeIdentityCurrent() {
    if (replaced) throw Object.assign(Error("changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  } } });
  try {
    let finish;
    f.replies.set("session/new", new Promise(resolve => { finish = resolve; }));
    const pending = start(f);
    await new Promise(resolve => setImmediate(resolve));
    replaced = true; finish({ sessionId: "late-native-session" });
    await assert.rejects(pending, { code: "RUNTIME_EXECUTABLE_CHANGED" });
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
    await assert.rejects(readRuntimeAuthenticationState(f.handle), { code: "RUNTIME_AUTH_STATUS_UNAVAILABLE" });
  } finally { await f.close(); }
});

test("late prompt completion after executable replacement cannot authenticate the old Handle", async () => {
  let replaced = false;
  const f = await fixture({ host: { assertRuntimeIdentityCurrent() {
    if (replaced) throw Object.assign(Error("changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  } } });
  try {
    const { session } = await start(f);
    let finish;
    f.replies.set("session/prompt", new Promise(resolve => { finish = resolve; }));
    const pending = prompt(f, session.id);
    await new Promise(resolve => setImmediate(resolve));
    replaced = true; finish({ stopReason: "end_turn" });
    await assert.rejects(pending, { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.deepEqual(f.host.getCachedAuthenticationState(), { status: "unverified" });
    assert.equal(f.host.canRetireIdle(), false);
  } finally { await f.close(); }
});

test("explicit tri-state auth supports safe own-data reads while legacy native contracts stay compatible", async () => {
  for (const status of ["unverified", "authenticated", "unauthenticated"]) {
    assert.deepEqual(await readRuntimeAuthenticationState({ authenticationState: () => ({ status }) }), { status });
  }
  await assert.rejects(readRuntimeAuthenticationState({ authenticationState: () => ({ status: "connected" }) }),
    { code: "RUNTIME_AUTH_STATUS_INVALID" });
  let reads = 0;
  await assert.rejects(readRuntimeAuthenticationState({ authenticationState: () => ({ get status() { reads++; return "authenticated"; } }) }),
    { code: "RUNTIME_AUTH_STATUS_INVALID" });
  assert.equal(reads, 0);
  for (const [raw, status] of [[{ authenticated: true, credentialPresent: true }, "authenticated"],
    [{ authenticated: false, credentialPresent: true }, "unverified"],
    [{ authenticated: false, credentialPresent: false }, "unauthenticated"]]) {
    assert.deepEqual(await readRuntimeAuthenticationState({ authenticationState: () => raw }), { status });
  }
});

// A local Node peer exercises the actual JSONL client, OS pipes and request
// error mapper. It has no credentials, Provider or external network access.
const AUTH_PEER_SOURCE = String.raw`
"use strict";
const fs = require("node:fs"), readline = require("node:readline");
const config = JSON.parse(process.argv[2]);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(config.log, request.method + "\n");
  if (request.method === "initialize") return send({ id: request.id,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (request.method === "session/new") return send({ id: request.id,
    ...(config.newError ? { error: config.newError } : { result: { sessionId: "controlled-native-session" } }) });
  if (request.method === "session/prompt") return send({ id: request.id,
    ...(config.promptError ? { error: config.promptError } : { result: { stopReason: "end_turn" } }) });
  if (request.method === "session/load") return send({ id: request.id, result: {} });
  if (Object.hasOwn(request, "id")) send({ id: request.id, error: { code: -32601, message: "Unsupported" } });
});
`;
function writeAuthPeer(root, config) {
  const script = path.join(root, "controlled-auth-peer.cjs"), log = path.join(root, "requests.log");
  fs.writeFileSync(script, AUTH_PEER_SOURCE, { mode: 0o600 });
  return { script, log, args: [script, JSON.stringify({ ...config, log })],
    methods: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [] };
}
async function pipeFixture(config) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/generic-acp-auth-pipes-"));
  const peer = writeAuthPeer(root, config);
  const child = spawn(process.execPath, peer.args, { cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  const rpc = new AcpJsonlClient(child, { requestTimeoutMs: 5000 });
  const cleanup = async () => {
    rpc.terminate(); child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await closed; } finally { clearTimeout(timer); fs.rmSync(root, { recursive: true, force: true }); }
  };
  try {
    const f = await fixture({ root, rpc });
    const closeFixture = f.close;
    return { ...f, methods: peer.methods, close: async () => { await closeFixture(); await cleanup(); } };
  } catch (error) { await cleanup(); throw error; }
}

test("real ACP pipes normalize opaque auth-required and reject prose-only auth classification", async () => {
  for (const [rpcCode, message, expectedCode, status] of [
    [-32000, "opaque-guard SECRET_MARKER", "AUTH_REQUIRED", "unauthenticated"],
    [-32001, "login required SECRET_MARKER", "ACP_REMOTE_ERROR", "unverified"],
  ]) {
    const f = await pipeFixture({ newError: { code: rpcCode, message, data: { message: "SECRET_DETAIL" } } });
    try {
      await assert.rejects(start(f), error => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.rpcCode, rpcCode);
        assert.equal(error.dispatchState, "write_attempted");
        assert.equal(Object.hasOwn(error, "rpcDetail"), false);
        assert.equal(Object.hasOwn(error, "cause"), false);
        assert.doesNotMatch(String(error) + JSON.stringify(error), /SECRET_MARKER|SECRET_DETAIL|opaque-guard/u);
        return true;
      });
      assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status });
      await assert.rejects(start(f), { code: "RUNTIME_SESSION_ACCEPTANCE_UNKNOWN" });
      assert.equal(f.methods().filter(method => method === "session/new").length, 1);
      assert.equal(f.methods().includes("session/prompt"), false);
    } finally { await f.close(); }
  }
});

test("a real opaque prompt auth rejection keeps unknown acceptance and never replays", async () => {
  const f = await pipeFixture({ promptError: { code: -32000, message: "opaque-guard SECRET_PROMPT_DETAIL" } });
  try {
    const { session } = await start(f);
    await assert.rejects(prompt(f, session.id), error => {
      assert.equal(error.code, "RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
      assert.doesNotMatch(String(error) + JSON.stringify(error), /SECRET_PROMPT_DETAIL|opaque-guard/u);
      return true;
    });
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unauthenticated" });
    await assert.rejects(prompt(f, session.id), { code: "RUNTIME_TURN_ACCEPTANCE_UNKNOWN" });
    assert.equal(f.methods().filter(method => method === "session/prompt").length, 1);
  } finally { await f.close(); }
});

test("local transport failures without rpcCode retain their existing error classification", async () => {
  const f = await fixture();
  try {
    const failure = Object.assign(Error("local transport ended"), { code: "ACP_STDOUT_ENDED", dispatchState: "write_attempted" });
    f.failures.set("session/new", failure);
    await assert.rejects(start(f), error => error === failure);
    assert.deepEqual(await readRuntimeAuthenticationState(f.handle), { status: "unverified" });
  } finally { await f.close(); }
});

test("isolated Service treats an opaque session/new -32000 as auth-required without retry or prompt", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/generic-acp-auth-service-"));
  const peer = writeAuthPeer(root, { newError: { code: -32000, message: "opaque-guard SECRET_SERVICE_DETAIL" } });
  const paths = require("../app/agent-service/paths").resolveServicePaths({ homeDir: root, trustedRoot: root,
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const command = fs.realpathSync(process.execPath);
  const manifest = { version: 1, runtime: binding.runtime, transport: "acp", command, args: peer.args,
    files: [command, peer.script].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
    endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  new (require("../app/agent-service/runtime-extension-manifest").RuntimeExtensionCatalog)(paths).install({ manifest,
    signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  const service = require("../app/agent-service/server").createAgentService({ paths, runtimeStorageHomedir: root,
    parentEnv: { HOME: root, PATH: "/usr/bin:/bin" }, safeStorage: { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  try {
    await service.start();
    const base = { ...service.productStore.listAgentProfiles()[0] };
    for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
    const profile = service.productStore.putAgentProfile({ ...base, ...binding, id: crypto.randomUUID(),
      runtimeAccountId: `extension-${binding.runtime}`, agentId: "controlled-auth-agent", name: "Controlled auth fixture",
      isDefault: false, enabled: true, defaultModel: null, defaultCwd: root, permissionPolicy: policy });
    service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
    service.memoryStore.ensureProfile(profile.id);
    const session = service.chatSessionStore.createSession({ operationId: "auth-create", profileId: profile.id,
      workspace: root, createdAt: Date.now() });
    const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey,
      operationId: "auth-send", prompt: "Controlled auth fixture request" });
    let timer;
    const run = await Promise.race([service.workRunCoordinator.waitForTerminal(ack.run.id),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Controlled auth fixture did not settle")), 10_000); })])
      .finally(() => clearTimeout(timer));
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "RUNTIME_AUTH_REQUIRED");
    assert.equal(peer.methods().filter(method => method === "session/new").length, 1);
    assert.equal(peer.methods().includes("session/prompt"), false);
    assert.equal(peer.methods().includes("authenticate"), false);
    assert.doesNotMatch(JSON.stringify(run), /SECRET_SERVICE_DETAIL|opaque-guard/u);
  } finally { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); }
});
