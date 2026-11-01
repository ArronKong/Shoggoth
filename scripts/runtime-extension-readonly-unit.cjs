"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { RuntimeAdapterRegistry } = require("../app/agent-service/runtime-adapter-registry");
const { createRuntimeSupportFacts } = require("../app/agent-service/runtime-support");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const policy = { sandbox: "danger-full-access", approvalPolicy: "never" };
const binding = { runtime: "ext-readonly", runtimeProfileId: "readonly-profile", runtimeAccountId: "extension-ext-readonly" };

function fakeRegistry({ transport = "acp", models, catalogReadHook = () => {} } = {}) {
  let acquisitions = 0, valid = true, resolveTerminated, cachedStatus = "unverified", localReads = 0, rpcReads = 0, readHook = () => {};
  const raw = { ...binding, capabilities: models ? { "models.list": true } : {}, workspace: "/controlled-workspace",
    subscribe: () => () => {}, terminated: new Promise(resolve => { resolveTerminated = resolve; }),
    host: { transport, permissionPolicy: policy, runtimeIdentity: { digest: "controlled-digest" },
      assertRuntimeIdentityCurrent() { if (!valid) throw Object.assign(Error("changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" }); },
      getCachedAuthenticationState() { localReads++; readHook(); return { status: cachedStatus }; } },
    authenticationState() { rpcReads++; throw Error("status read attempted RPC"); },
    modelsList() { rpcReads++; catalogReadHook(); if (models) return { data: models, nextCursor: null }; throw Error("status read attempted catalog discovery"); },
    stop: async () => { resolveTerminated(); } };
  const registry = new RuntimeAdapterRegistry();
  registry.register(binding.runtime, { acquire: async () => { acquisitions++; return raw; },
    stop: () => raw.stop(), stopAll: () => raw.stop() });
  return { registry, counts: () => ({ acquisitions, localReads, rpcReads }), invalidate: () => { valid = false; },
    setAuth: status => { cachedStatus = status; }, setReadHook: hook => { readHook = hook; }, retire: () => raw.stop() };
}

test("peek never acquires and keeps binding, policy, identity and retirement boundaries", async () => {
  const f = fakeRegistry();
  assert.equal(f.registry.peek(binding, { permissionPolicy: policy }), null);
  assert.equal(f.counts().acquisitions, 0);
  const handle = await f.registry.acquire(binding);
  assert.equal(f.registry.peek(binding, { permissionPolicy: policy }), handle);
  assert.equal(f.registry.peek({ ...binding, runtimeAccountId: "other-account" }), null);
  assert.equal(f.registry.peek({ ...binding, runtimeProfileId: "other-profile" }), null);
  assert.equal(f.registry.peek(binding, { permissionPolicy: { ...policy, approvalPolicy: "on-request" } }), null);
  assert.equal(f.registry.peek(binding, { workspace: "/other-workspace" }), null);
  f.invalidate();
  assert.equal(f.registry.peek(binding), null);
  await f.registry.stopAll();
  assert.equal(f.registry.peek(binding), null);
  assert.deepEqual(f.counts(), { acquisitions: 1, localReads: 0, rpcReads: 0 });
});

test("extension facts use only a current local ACP snapshot and reflect auth changes immediately", async () => {
  const f = fakeRegistry(), facts = createRuntimeSupportFacts({ runtimeManager: f.registry,
    discover() { throw Error("extension status cannot discover a transport"); } });
  const selected = { ...binding, id: "readonly-binding", revision: 1, enabled: true };
  const profile = { permissionPolicy: policy };
  assert.equal((await facts.read(selected, profile)).installed, "unknown");
  assert.equal(f.counts().acquisitions, 0);
  await f.registry.acquire(binding);
  assert.equal((await facts.read(selected, profile)).authenticated, "unverified");
  f.setAuth("authenticated");
  const verified = await facts.read(selected, profile);
  assert.equal(verified.authenticated, true);
  assert.equal(verified.capabilityEvidence.scope.executableIdentity, "controlled-digest");
  f.setAuth("unauthenticated");
  assert.equal((await facts.read(selected, profile)).authenticated, false);
  f.invalidate();
  assert.equal((await facts.read(selected, profile)).installed, "unknown");
  assert.equal(f.counts().acquisitions, 1);
  assert.equal(f.counts().rpcReads, 0);
  await f.registry.stopAll();
});

test("a held stdio plugin cannot turn settings reads into authentication or model RPC", async () => {
  const f = fakeRegistry({ transport: "stdio" });
  await f.registry.acquire(binding);
  const facts = await createRuntimeSupportFacts({ runtimeManager: f.registry })
    .read({ ...binding, id: "readonly-binding", revision: 1, enabled: true }, { permissionPolicy: policy });
  assert.equal(facts.installed, true);
  assert.equal(facts.authenticated, "unknown");
  assert.deepEqual(f.counts(), { acquisitions: 1, localReads: 0, rpcReads: 0 });
  await f.registry.stopAll();
});

function profileController(registry) {
  const profile = { id: "readonly-profile", ...binding, enabled: true, permissionPolicy: policy };
  const productStore = Object.fromEntries(["getModelProvider", "putAgentProfile", "getRuntimeAccount", "listAgentProfiles",
    "lookupMcpToolCall", "beginMcpToolCall", "completeMcpToolCall"].map(name => [name, () => { throw Error("unexpected store mutation"); }]));
  productStore.getAgentProfile = () => structuredClone(profile);
  const controller = require("../app/agent-service/profile-service-controller").createProfileServiceController({
    productStore, runtimeManager: registry, accountAuthManager: { read() { throw Error("unexpected account RPC"); } },
    providerBootstrap: { configureOpenAiApiKey() {}, clearUnreferencedOpenAiApiKey() {} } });
  controller.open(); return { profile, controller };
}

test("an existing stdio model catalog remains available without acquiring a new host", async () => {
  const model = { model: "controlled-model", displayName: "Controlled model", description: "", isDefault: true, hidden: false };
  const f = fakeRegistry({ transport: "stdio", models: [model] }), { controller, profile } = profileController(f.registry);
  const input = { profileId: profile.id, cursor: null, limit: 50 };
  await assert.rejects(controller.handle("profile.models.list", input), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
  assert.equal(f.counts().acquisitions, 0);
  await f.registry.acquire(binding);
  const result = await controller.handle("profile.models.list", input);
  assert.equal(result.models[0].id, model.model);
  assert.deepEqual(f.counts(), { acquisitions: 1, localReads: 0, rpcReads: 1 });
  await controller.close(); await f.registry.stopAll();
});

test("a model catalog response from a retired extension is rejected", async () => {
  let retire = () => {};
  const model = { model: "controlled-model", displayName: "Controlled", description: "", isDefault: true, hidden: false };
  const f = fakeRegistry({ transport: "stdio", models: [model], catalogReadHook: () => retire() });
  await f.registry.acquire(binding); retire = f.retire;
  const { controller, profile } = profileController(f.registry);
  await assert.rejects(controller.handle("profile.models.list", { profileId: profile.id, cursor: null, limit: 50 }),
    { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
  assert.equal(f.counts().acquisitions, 1);
  assert.equal(f.registry.peek(binding), null);
  await controller.close(); await f.registry.stopAll();
});

test("retirement during a cached read cannot publish old support or Profile authentication", async () => {
  for (const surface of ["facts", "profile"]) {
    const f = fakeRegistry();
    await f.registry.acquire(binding);
    f.setAuth("authenticated");
    f.setReadHook(() => { void f.retire(); });
    if (surface === "facts") {
      const result = await createRuntimeSupportFacts({ runtimeManager: f.registry })
        .read({ ...binding, id: "readonly-binding", revision: 1, enabled: true }, { permissionPolicy: policy });
      assert.equal(result.installed, "unknown");
      assert.equal(result.authenticated, "unknown");
      assert.equal(result.capabilityEvidence, undefined);
    } else {
      const { controller, profile } = profileController(f.registry);
      assert.deepEqual(await controller.handle("profile.auth.read", { profileId: profile.id }), { status: "unverified" });
      await controller.close();
    }
    assert.equal(f.registry.statistics().hosts, 0);
    assert.equal(f.registry.peek(binding), null);
    assert.equal(f.counts().rpcReads, 0);
    await f.registry.stopAll();
  }
});

test("pending startup and ambiguous workspace hosts are never selected by a read", async () => {
  let finish, acquisitions = 0;
  const raw = workspace => ({ ...binding, workspace, capabilities: {}, subscribe: () => () => {},
    terminated: new Promise(() => {}), host: { permissionPolicy: policy, assertRuntimeIdentityCurrent() {} } });
  const registry = new RuntimeAdapterRegistry();
  registry.register(binding.runtime, { acquire: () => { acquisitions++; return new Promise(resolve => { finish = resolve; }); },
    stop() {}, stopAll() {} });
  const first = registry.acquire(binding);
  assert.equal(registry.peek(binding), null);
  assert.equal(acquisitions, 1);
  finish(raw("/one")); await first;
  const second = registry.acquire(binding); finish(raw("/two")); await second;
  assert.equal(registry.peek(binding, { permissionPolicy: policy }), null);
  assert.equal(registry.peek(binding, { permissionPolicy: policy, workspace: "/one" }).workspace, "/one");
});

function serviceFixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-extension-readonly-"));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const script = path.join(root, "controlled-agent.cjs"), marker = path.join(root, "starts.log");
  fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "spawn\\n");\n`
    + fs.readFileSync(path.join(__dirname, "fixtures/runtime-v1-acp.cjs"), "utf8"), { mode: 0o600 });
  const command = fs.realpathSync(process.execPath);
  const manifest = { version: 1, runtime: binding.runtime, transport: "acp", command, args: [script],
    files: [command, script].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
    endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  new RuntimeExtensionCatalog(paths).install({ manifest,
    signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }, publicKey.export({ type: "spki", format: "pem" }));
  const service = createAgentService({ paths, runtimeStorageHomedir: root, parentEnv: { HOME: root, PATH: "/usr/bin:/bin" },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  return { root, paths, script, marker, service, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("real Service settings stay passive before execution, use current proof afterwards, and invalidate an upgraded package", async () => {
  const f = serviceFixture(), { service } = f;
  try {
    await service.start();
    const base = { ...service.productStore.listAgentProfiles()[0] };
    for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
    const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: "readonly-extension-agent", name: "Readonly extension",
      ...binding, isDefault: false, enabled: true, defaultModel: null, defaultCwd: f.root, permissionPolicy: policy });
    service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
    service.memoryStore.ensureProfile(profile.id);
    const selected = service.productStore.getAgentRuntimeBindings(profile.id).bindings[0];
    const facts = createRuntimeSupportFacts({ runtimeManager: service.runtimeManager });
    const readAuth = () => service.profileServiceController.handle("profile.auth.read", { profileId: profile.id });
    const readCapabilities = () => service.profileServiceController.handle("profile.capabilities.read", { profileId: profile.id });
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(await readAuth(), { status: "unverified" });
      assert.deepEqual(await readCapabilities(), { attachments: [], resume: "unverified", compact: "unverified", steer: "unverified" });
      assert.equal((await facts.read(selected, profile)).installed, "unknown");
    }
    await assert.rejects(service.profileServiceController.handle("profile.models.list", { profileId: profile.id, cursor: null, limit: 50 }),
      { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
    assert.equal(fs.existsSync(f.marker), false, "settings/list reads cannot launch the configured agent");
    const session = service.chatSessionStore.createSession({ operationId: "readonly-create", profileId: profile.id, workspace: f.root, createdAt: Date.now() });
    const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "readonly-send", prompt: "controlled fixture task" });
    let timer;
    const run = await Promise.race([service.workRunCoordinator.waitForTerminal(ack.run.id),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("controlled extension did not complete")), 10_000); })]).finally(() => clearTimeout(timer));
    assert.equal(run.status, "completed", run.errorCode);
    const starts = fs.readFileSync(f.marker, "utf8");
    assert.deepEqual(await readAuth(), { status: "authenticated" });
    assert.deepEqual(await readCapabilities(), { attachments: [], resume: "supported", compact: "unsupported", steer: "unsupported" });
    assert.equal((await facts.read(selected, profile)).authenticated, true);
    assert.equal(fs.readFileSync(f.marker, "utf8"), starts);
    fs.appendFileSync(f.script, "\n// same-path package changed\n");
    assert.deepEqual(await readAuth(), { status: "unverified" });
    assert.deepEqual(await readCapabilities(), { attachments: [], resume: "unverified", compact: "unverified", steer: "unverified" });
    assert.equal((await facts.read(selected, profile)).installed, "unknown");
    assert.equal(fs.readFileSync(f.marker, "utf8"), starts, "invalidated proof cannot relaunch the package from a read");
  } finally { await service.stop({ notify: false }); f.cleanup(); }
});
