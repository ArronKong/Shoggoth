"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { RuntimeExtensionCatalog } = require("../app/agent-service/runtime-extension-manifest");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const policy = { sandbox: "danger-full-access", approvalPolicy: "never" };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/runtime-isolation-"));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  return { root, paths, catalog: new RuntimeExtensionCatalog(paths), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function signed(f, runtime) {
  const command = fs.realpathSync(process.execPath), script = path.join(f.root, runtime + ".cjs"), marker = script + ".starts";
  const sdk = path.resolve(__dirname, "../app/agent-service/runtime-plugin-sdk");
  const source = fs.readFileSync(path.join(__dirname, "fixtures/runtime-v1-plugin.cjs"), "utf8")
    .replace('require("../../app/agent-service/runtime-plugin-sdk")', `require(${JSON.stringify(sdk)})`);
  fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n");\n` + source, { mode: 0o600 });
  const manifest = { version: 1, runtime, transport: "stdio", command, args: [script],
    files: [command, script].map(file => ({ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })),
    endpoint: null, credentialRef: null };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]])));
  return { script, marker, envelope: { manifest, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") },
    trustedKey: publicKey.export({ type: "spki", format: "pem" }) };
}
function install(f, entry) { f.catalog.install(entry.envelope, entry.trustedKey); }
function corruptSignature(f, runtime) {
  const entries = f.catalog.read({ verifyEnabled: false }), entry = entries.find(item => item.envelope.manifest.runtime === runtime);
  entry.envelope.signature = "invalid-sensitive-signature-material"; f.catalog.write(entries);
}
function serviceFor(f) {
  return createAgentService({ paths: f.paths, runtimeStorageHomedir: f.root,
    parentEnv: { HOME: f.root, PATH: "/usr/bin:/bin" },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
}
function addProfile(service, f, runtime) {
  const base = { ...service.productStore.listAgentProfiles()[0] };
  for (const key of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[key];
  const profile = service.productStore.putAgentProfile({ ...base, id: crypto.randomUUID(), agentId: runtime + "-agent", name: runtime,
    runtime, runtimeProfileId: runtime + "-profile", runtimeAccountId: "extension-" + runtime,
    isDefault: false, enabled: true, defaultModel: null, defaultCwd: f.root, permissionPolicy: policy });
  service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
  service.memoryStore.ensureProfile(profile.id); return profile;
}
async function chat(service, f, profile, operation) {
  const session = service.chatSessionStore.createSession({ operationId: operation + "-create", profileId: profile.id, workspace: f.root, createdAt: Date.now() });
  const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: operation + "-send", prompt: "controlled fixture task" });
  let timer;
  const run = await Promise.race([service.workRunCoordinator.waitForTerminal(ack.run.id),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("controlled chat timed out")), 10_000); })]).finally(() => clearTimeout(timer));
  assert.equal(run.status, "completed", run.errorCode || "controlled chat completion");
  const events = service.transcriptStore.listEvents(profile.id, session.id);
  assert.ok(events.some(event => event.kind === "assistant" && event.content.text.includes("Fixture complete")));
  return { session, events };
}
async function diagnostics(service, f) {
  const result = await requestService(f.paths, { version: SERVICE_PROTOCOL_VERSION, token: readClientToken(f.paths),
    method: "runtime.observability.get", params: {} });
  const output = JSON.stringify(result);
  assert.ok(Buffer.byteLength(output) < 64 * 1024);
  assert.ok(!output.includes(f.root), "diagnostics cannot reveal the private absolute package path");
  assert.doesNotMatch(output, /BEGIN PUBLIC KEY|invalid-sensitive-signature|ENOENT|sha256|controlled fixture task/u);
  return result.events.filter(event => event.name === "runtime.preflight.failed" && event.outcome === "isolated");
}

test("a private empty catalog stays empty without creating configuration", () => {
  const f = fixture(); try {
    assert.deepEqual(f.catalog.loadEnabled(), { entries: [], diagnostics: [] });
    assert.equal(fs.existsSync(f.catalog.file), false);
  } finally { f.cleanup(); }
});

test("package verification isolates each bad enabled package; disabled metadata remains administrable", () => {
  const f = fixture(); try {
    const good = signed(f, "ext-good"), bad = signed(f, "ext-bad"), disabled = signed(f, "ext-disabled");
    install(f, good); install(f, bad); install(f, disabled); f.catalog.setEnabled("ext-disabled", false);
    corruptSignature(f, "ext-bad"); fs.unlinkSync(disabled.script);
    const before = fs.readFileSync(f.catalog.file), snapshot = f.catalog.loadEnabled();
    assert.deepEqual(snapshot.entries.map(item => item.manifest.runtime), ["ext-good"]);
    assert.deepEqual(snapshot.diagnostics, [{ scope: "package", runtime: "ext-bad", code: "RUNTIME_EXTENSION_UNTRUSTED" }]);
    assert.deepEqual(fs.readFileSync(f.catalog.file), before);
    assert.throws(() => f.catalog.setEnabled("ext-bad", true));
    f.catalog.setEnabled("ext-bad", false);
    assert.equal(f.catalog.read().find(entry => entry.envelope.manifest.runtime === "ext-bad").enabled, false);
    f.catalog.uninstall("ext-bad"); f.catalog.uninstall("ext-disabled");
    assert.deepEqual(f.catalog.read().map(entry => entry.envelope.manifest.runtime), ["ext-good"]);
    assert.equal(fs.existsSync(good.marker), false, "catalog operations do not execute a package");
  } finally { f.cleanup(); }
});

test("malformed catalog structure rejects the complete catalog without using earlier valid entries", () => {
  const f = fixture(); try {
    const good = signed(f, "ext-good"); install(f, good);
    const valid = JSON.parse(fs.readFileSync(f.catalog.file));
    const invalid = [null, [], { ...valid, extra: true }, { ...valid, version: 2 },
      { ...valid, entries: [...valid.entries, valid.entries[0]] },
      { ...valid, entries: [...valid.entries, { enabled: true, envelope: { manifest: { runtime: "codex" } }, trustedKey: "no" }] },
      { ...valid, entries: [...valid.entries, { ...valid.entries[0], unknown: true }] },
      { ...valid, entries: [...valid.entries, { enabled: true, envelope: {}, trustedKey: "no" }] },
      { version: 1, entries: Array.from({ length: 33 }, () => valid.entries[0]) }];
    for (const value of invalid) {
      const bytes = JSON.stringify(value); fs.writeFileSync(f.catalog.file, bytes);
      assert.deepEqual(f.catalog.loadEnabled(), { entries: [], diagnostics: [{ scope: "catalog", code: "RUNTIME_EXTENSION_CATALOG_UNAVAILABLE" }] });
      assert.throws(() => f.catalog.read({ verifyEnabled: false }));
      assert.equal(fs.readFileSync(f.catalog.file, "utf8"), bytes);
    }
    fs.writeFileSync(f.catalog.file, "{invalid sensitive catalog input");
    assert.deepEqual(f.catalog.loadEnabled(), { entries: [], diagnostics: [{ scope: "catalog", code: "RUNTIME_EXTENSION_CATALOG_UNAVAILABLE" }] });
    assert.equal(fs.existsSync(good.marker), false);
  } finally { f.cleanup(); }
});

test("private-file mode and symlink protections still reject the whole catalog", () => {
  const f = fixture(); try {
    const good = signed(f, "ext-good"); install(f, good);
    const before = fs.readFileSync(f.catalog.file);
    fs.chmodSync(f.catalog.file, 0o644);
    assert.equal(f.catalog.loadEnabled().diagnostics[0].scope, "catalog");
    assert.equal(fs.statSync(f.catalog.file).mode & 0o777, 0o644, "startup must not repair unsafe permissions");
    fs.chmodSync(f.catalog.file, 0o600);
    const target = f.catalog.file + ".retained"; fs.renameSync(f.catalog.file, target); fs.symlinkSync(target, f.catalog.file);
    assert.equal(f.catalog.loadEnabled().diagnostics[0].scope, "catalog");
    assert.ok(fs.lstatSync(f.catalog.file).isSymbolicLink()); assert.deepEqual(fs.readFileSync(target), before);
  } finally { f.cleanup(); }
});

test("a first-start bad package receives no managed account while the good package remains executable", async () => {
  const f = fixture(); let service;
  try {
    const good = signed(f, "ext-good"), bad = signed(f, "ext-bad"); install(f, good); install(f, bad);
    corruptSignature(f, "ext-bad");
    service = serviceFor(f); await service.start();
    assert.equal(service.productStore.getRuntimeAccount("extension-ext-bad"), null);
    assert.ok(service.productStore.getRuntimeAccount("extension-ext-good"));
    await assert.rejects(service.runtimeManager.acquire({ runtime: "ext-bad", runtimeProfileId: "bad-profile",
      runtimeAccountId: "extension-ext-bad" }, { workspace: f.root, permissionPolicy: policy }), { code: "RUNTIME_UNSUPPORTED" });
    await chat(service, f, addProfile(service, f, "ext-good"), "first-start-good");
    assert.equal(fs.existsSync(bad.marker), false);
    assert.equal((await diagnostics(service, f)).length, 1);
  } finally { if (service) await service.stop({ notify: false }); f.cleanup(); }
});

for (const failure of ["signature", "missing", "tampered"]) test(`real Service isolates ${failure} package, preserves historical binding and completes the healthy package`, async () => {
  const f = fixture(); let service;
  try {
    const good = signed(f, "ext-good"), bad = signed(f, "ext-bad"), disabled = signed(f, "ext-disabled");
    install(f, good); install(f, bad); install(f, disabled); f.catalog.setEnabled("ext-disabled", false);
    service = serviceFor(f); await service.start();
    const profile = addProfile(service, f, "ext-bad"), history = await chat(service, f, profile, "historical");
    const account = service.productStore.getRuntimeAccount("extension-ext-bad");
    const persistedProfile = service.productStore.getAgentProfile(profile.id);
    await service.stop({ notify: false }); service = null;
    const beforeStarts = fs.readFileSync(bad.marker, "utf8");
    if (failure === "signature") corruptSignature(f, "ext-bad");
    else if (failure === "missing") fs.unlinkSync(bad.script);
    else fs.appendFileSync(bad.script, "\n// untrusted changed package bytes\n");
    const catalogBytes = fs.readFileSync(f.catalog.file);
    service = serviceFor(f); await service.start();
    assert.deepEqual(service.productStore.getRuntimeAccount("extension-ext-bad"), account);
    assert.deepEqual(service.productStore.getAgentProfile(profile.id), persistedProfile);
    assert.ok(service.chatSessionStore.getSession(history.session.sessionKey));
    assert.deepEqual(service.transcriptStore.listEvents(profile.id, history.session.id), history.events);
    assert.ok(service.productStore.getRuntimeAccount("extension-ext-good"));
    assert.equal(service.productStore.getRuntimeAccount("extension-ext-disabled"), null);
    assert.ok(service.runtimeManager.statistics().adapters >= 5, "built-in runtime registration survives");
    await assert.rejects(service.runtimeManager.acquire({ runtime: "ext-bad", runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId }, { workspace: f.root, permissionPolicy: policy }), { code: "RUNTIME_UNSUPPORTED" });
    assert.equal(fs.readFileSync(bad.marker, "utf8"), beforeStarts, "isolated package cannot acquire or launch again");
    const healthy = addProfile(service, f, "ext-good"); await chat(service, f, healthy, "healthy");
    const events = await diagnostics(service, f);
    assert.deepEqual(events.map(({ source, stage, reason }) => ({ source, stage, reason })), [{ source: "ext-bad",
      stage: "extension_package", reason: "RUNTIME_EXTENSION_UNTRUSTED" }]);
    assert.deepEqual(fs.readFileSync(f.catalog.file), catalogBytes, "Service cannot silently disable or rewrite catalog entries");
    assert.equal(fs.existsSync(disabled.marker), false);
    assert.equal(service.runtimeManager.statistics().hosts, 1, "only the explicitly executed healthy fixture owns a host");
    await service.stop({ notify: false }); assert.equal(service.runtimeManager.statistics().hosts, 0); service = null;
    assert.equal(fs.existsSync(f.paths.socketPath), false);
  } finally { if (service) await service.stop({ notify: false }); f.cleanup(); }
});

test("real Service starts with a corrupt catalog, retains historical state and refuses every extension", async () => {
  const f = fixture(); let service;
  try {
    const good = signed(f, "ext-good"); install(f, good);
    service = serviceFor(f); await service.start();
    const profile = addProfile(service, f, "ext-good"), history = await chat(service, f, profile, "retained");
    const account = service.productStore.getRuntimeAccount("extension-ext-good");
    await service.stop({ notify: false }); service = null;
    const bytes = "{\"version\":1,\"entries\":[ invalid sensitive content";
    fs.writeFileSync(f.catalog.file, bytes);
    const starts = fs.readFileSync(good.marker, "utf8");
    service = serviceFor(f); await service.start();
    assert.deepEqual(service.productStore.getRuntimeAccount("extension-ext-good"), account);
    assert.ok(service.productStore.getAgentProfile(profile.id)); assert.ok(service.chatSessionStore.getSession(history.session.sessionKey));
    assert.deepEqual(service.transcriptStore.listEvents(profile.id, history.session.id), history.events);
    await assert.rejects(service.runtimeManager.acquire({ runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId }, { workspace: f.root, permissionPolicy: policy }), { code: "RUNTIME_UNSUPPORTED" });
    assert.equal(service.runtimeManager.statistics().hosts, 0);
    assert.ok(service.runtimeManager.statistics().adapters >= 4);
    assert.equal(fs.readFileSync(good.marker, "utf8"), starts);
    const events = await diagnostics(service, f);
    assert.deepEqual(events.map(({ source, stage, reason }) => ({ source, stage, reason })), [{ source: "extension-catalog",
      stage: "extension_catalog", reason: "RUNTIME_EXTENSION_CATALOG_UNAVAILABLE" }]);
    assert.equal(fs.readFileSync(f.catalog.file, "utf8"), bytes);
  } finally { if (service) await service.stop({ notify: false }); f.cleanup(); }
});


for (const mutation of ["disabled", "removed", "key", "manifest", "catalog"]) {
  for (const alreadyAcquired of [false, true]) test(`live ${mutation} catalog change rejects ${alreadyAcquired ? "existing" : "cold"} adapter admission without erasing history or blocking stop`, async () => {
    const f = fixture(); let service;
    try {
      const entry = signed(f, "ext-current"); install(f, entry);
      service = serviceFor(f); await service.start();
      const binding = { runtime: "ext-current", runtimeProfileId: "catalog-profile", runtimeAccountId: "extension-ext-current" };
      let handle, session;
      if (alreadyAcquired) {
        handle = await service.runtimeManager.acquire(binding, { workspace: f.root, permissionPolicy: policy });
        session = (await handle.sessionStart({ cwd: f.root, source: "catalog-history", model: null })).session;
      }
      const starts = fs.existsSync(entry.marker) ? fs.readFileSync(entry.marker, "utf8") : null;
      if (mutation === "disabled") f.catalog.setEnabled(binding.runtime, false);
      else if (mutation === "removed") f.catalog.uninstall(binding.runtime);
      else if (mutation === "catalog") fs.writeFileSync(f.catalog.file, "{corrupt private catalog");
      else {
        const entries = f.catalog.read({ verifyEnabled: false });
        if (mutation === "key") entries[0].trustedKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
        else entries[0].envelope.manifest.args.push("--changed-signed-payload");
        f.catalog.write(entries);
      }
      await assert.rejects(service.runtimeManager.acquire(binding, { workspace: f.root, permissionPolicy: policy }), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
      await assert.rejects(service.runtimeManager.acquire({ ...binding, runtimeProfileId: "fresh-catalog-profile" },
        { workspace: f.root, permissionPolicy: policy }), { code: "RUNTIME_EXTENSION_UNTRUSTED" });
      if (starts === null) assert.equal(fs.existsSync(entry.marker), false, "changed catalog cannot launch a cold old adapter");
      else assert.equal(fs.readFileSync(entry.marker, "utf8"), starts, "changed catalog cannot launch a second host");
      assert.ok(service.productStore.getRuntimeAccount(binding.runtimeAccountId));
      if (handle) {
        assert.equal((await handle.sessionRead({ sessionId: session.id })).session.id, session.id);
        await handle.turnInterrupt({ sessionId: session.id });
      }
      await service.stop({ notify: false });
      if (handle) await handle.terminated;
      assert.equal(service.runtimeManager.statistics().hosts, 0); service = null;
    } finally { if (service) await service.stop({ notify: false }); f.cleanup(); }
  });
}
