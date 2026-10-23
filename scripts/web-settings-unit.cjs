"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { WebSettings } = require("../app/agent-service/web-settings");
const p = require("../app/agent-service/web-settings-protocol");
async function fixture() {
  const root = fs.mkdtempSync("/private/tmp/sg-web-settings-");
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root, encryptedSecretsPath: path.join(root, "state/encrypted-secrets.json") };
  const key = crypto.randomBytes(32); let locked = false;
  const cryptoBroker = {
    async encrypt(bytes) { if (locked) throw Error("private crypto error"); const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); },
    async decrypt(bytes) { if (locked) throw Error("private crypto error"); const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0,12)); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12,-16)), decipher.final()]); },
  };
  const secrets = new EncryptedSecretStore({ paths, cryptoBroker }); await secrets.open();
  return { root, paths, secrets, settings: new WebSettings({ paths, secretStore: secrets }), lock: value => { locked = value; },
    close: async () => { await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test("settings schema excludes unsupported fetch providers, arbitrary endpoints and secret reads", () => {
  for (const value of [{ expectedRevision: 0, config: { searchProvider: "exa", fetchProvider: "brave" } },
    { expectedRevision: 0, config: { searchProvider: "other", fetchProvider: "direct" } },
    { expectedRevision: 0, config: { searchProvider: "exa", fetchProvider: "direct", baseUrl: "http://localhost" } }]) assert.throws(() => p.validateParams("web.settings.set", value));
  for (const apiKey of ["short", "space in key", "line\nkeyxxx", "汉".repeat(10), "x".repeat(4097)]) assert.throws(() => p.validateParams("web.credentials.set", { provider: "tavily", expectedRevision: null, apiKey }));
  assert.throws(() => p.validateParams("web.credentials.get", { provider: "tavily" }));
  assert.throws(() => p.validateParams("web.settings.get", { apiKey: "private" }));
});
test("defaults preserve keyless Exa/direct without creating a settings file", async () => {
  const f = await fixture(); try {
    const result = await f.settings.handle("web.settings.get", {});
    assert.equal(result.revision, 0); assert.deepEqual(result.config, { searchProvider: "exa", fetchProvider: "direct" });
    assert.equal(Object.values(result.credentials).every(row => !row.configured && row.revision === null), true);
    assert.equal(fs.existsSync(f.settings.file), false);
  } finally { await f.close(); }
});
test("encrypted keys are write-only, detected by canary and survive Store restart", async () => {
  const f = await fixture(), apiKey = "fixture-secret-tavily-key";
  try {
    const saved = await f.settings.handle("web.credentials.set", { provider: "tavily", apiKey, expectedRevision: null });
    assert.equal(saved.credentials.tavily.configured, true); assert(!JSON.stringify(saved).includes(apiKey));
    assert(!fs.readFileSync(f.paths.encryptedSecretsPath, "utf8").includes(apiKey));
    assert.throws(() => f.settings.assertSafe(`echo ${apiKey}`), { code: "WEB_RESPONSE_INVALID" });
    await f.settings.handle("web.settings.set", { expectedRevision: 0, config: { searchProvider: "tavily", fetchProvider: "tavily" } });
    assert.equal(fs.statSync(f.settings.file).mode & 0o777, 0o600);
    assert(!fs.readFileSync(f.settings.file, "utf8").includes(apiKey));
    await f.secrets.close(); await f.secrets.open();
    const settings = new WebSettings({ paths: f.paths, secretStore: f.secrets });
    const after = await settings.handle("web.settings.get", {}); assert.equal(after.revision, 1); assert.equal(after.config.fetchProvider, "tavily");
    assert.deepEqual(await settings.resolve("web_fetch"), { provider: "tavily", apiKey });
  } finally { await f.close(); }
});
test("selector CAS and competing credential writes reject stale operations", async () => {
  const f = await fixture(); try {
    const a = { expectedRevision: 0, config: { searchProvider: "brave", fetchProvider: "tinyfish" } };
    await f.settings.handle("web.settings.set", a);
    await assert.rejects(async () => f.settings.handle("web.settings.set", a), { code: "WEB_SETTINGS_CONFLICT" });
    const input = { provider: "brave", expectedRevision: null, apiKey: "fixture-brave-key" };
    const outcomes = await Promise.allSettled([f.settings.handle("web.credentials.set", input), f.settings.handle("web.credentials.set", { ...input, apiKey: "fixture-different-key" })]);
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
    const saved = outcomes.find(row => row.status === "fulfilled").value;
    await assert.rejects(async () => f.settings.handle("web.credentials.clear", { provider: "brave", expectedRevision: null }), { code: "WEB_SETTINGS_CONFLICT" });
    const cleared = await f.settings.handle("web.credentials.clear", { provider: "brave", expectedRevision: saved.credentials.brave.revision });
    assert.equal(cleared.credentials.brave.configured, false); assert.equal(cleared.config.searchProvider, "brave");
    assert.deepEqual(await f.settings.resolve("web_search"), { provider: "brave", apiKey: null });
  } finally { await f.close(); }
});
test("locked Store and malformed private settings cannot silently restore defaults", async () => {
  const f = await fixture(); try {
    f.lock(true);
    await assert.rejects(async () => f.settings.handle("web.credentials.set", { provider: "tinyfish", apiKey: "fixture-tinyfish-key", expectedRevision: null }));
    assert.equal((await f.settings.handle("web.settings.get", {})).credentials.tinyfish.configured, false);
    fs.writeFileSync(f.settings.file, "{broken", { mode: 0o600 });
    const broken = new WebSettings({ paths: f.paths, secretStore: f.secrets });
    assert.throws(() => broken.snapshot(), { code: "WEB_SETTINGS_UNAVAILABLE" });
    assert.throws(() => broken.snapshot(), { code: "WEB_SETTINGS_UNCERTAIN" });
  } finally { await f.close(); }
});

const A = "agent-alpha", B = "agent-beta", live = { assertCurrent() {} };
const own = (settings, profileId, expectedRevision, config, scope = live) => settings.handleTool("web_settings_set", profileId, { expectedRevision, config }, scope);
const defaults = (settings, profileId, expectedRevision, config) => settings.handleTool("web_defaults_set", profileId, { expectedRevision, config }, live);
test("native preference contracts accept partial/inherited choices and reject credentials, identity spoofing and unsupported services", () => {
  const { validateMcpProductToolArguments: valid, DEFAULT_TOOL_REGISTRY, isNativeOnlyMcpTool } = require("../app/agent-service/mcp-product-tool-controller");
  for (const [name, readOnly, risk] of [["web_settings_get", true, "read"], ["web_settings_set", false, "write"], ["web_defaults_set", false, "confirm"]]) {
    assert.equal(DEFAULT_TOOL_REGISTRY.get(name).risk, risk); assert.equal(isNativeOnlyMcpTool(name), true);
    assert.equal(DEFAULT_TOOL_REGISTRY.get(name).definition.annotations.readOnlyHint, readOnly);
  }
  assert.equal(valid("web_settings_get", {}), true);
  for (const name of ["web_settings_set", "web_defaults_set"]) {
    assert.equal(valid(name, { expectedRevision: 0, config: { searchProvider: "brave" } }), true);
    for (const config of [{}, { fetchProvider: "brave" }, { searchProvider: "auto" }, { apiKey: "private" }, { profileId: B }, { fetchProvider: "direct", endpoint: "https://other.example" }])
      assert.equal(valid(name, { expectedRevision: 0, config }), false);
    assert.equal(valid(name, { expectedRevision: -1, config: { searchProvider: "exa" } }), false);
    assert.equal(valid(name, { profileId: B, expectedRevision: 0, config: { searchProvider: "exa" } }), false);
  }
  assert.equal(valid("web_settings_set", { expectedRevision: 0, config: { searchProvider: null } }), true);
  assert.equal(valid("web_defaults_set", { expectedRevision: 0, config: { searchProvider: null } }), false);
});
test("per-capability inheritance, two Agent overrides and global UI updates remain independent", async () => {
  const f = await fixture(); try {
    const before = await f.settings.handleTool("web_settings_get", A, {}, live);
    assert.deepEqual(before.effective, { searchProvider: "exa", fetchProvider: "direct" });
    assert.deepEqual(before.source, { searchProvider: "global", fetchProvider: "global" });
    assert(!fs.existsSync(f.settings.agentFile(A)));
    await own(f.settings, A, 0, { searchProvider: "brave" });
    await own(f.settings, B, 0, { searchProvider: "tavily", fetchProvider: "tinyfish" });
    const global = await defaults(f.settings, A, 0, { searchProvider: "tinyfish", fetchProvider: "exa" });
    assert.deepEqual(global.effective, { searchProvider: "brave", fetchProvider: "exa" });
    assert.deepEqual(f.settings.agentSnapshot(B).effective, { searchProvider: "tavily", fetchProvider: "tinyfish" });
    const reset = await own(f.settings, B, 1, { searchProvider: null });
    assert.equal(reset.agent.config.fetchProvider, "tinyfish"); assert.equal(reset.effective.searchProvider, "tinyfish");
    assert.equal(reset.source.searchProvider, "global");
    await f.settings.handle("web.settings.set", { expectedRevision: 1, config: { searchProvider: "exa", fetchProvider: "direct" } });
    assert.deepEqual(f.settings.agentSnapshot(A).effective, { searchProvider: "brave", fetchProvider: "direct" });
    assert.deepEqual(f.settings.agentSnapshot(B).effective, { searchProvider: "exa", fetchProvider: "tinyfish" });
  } finally { await f.close(); }
});
test("Agent and global revisions have independent CAS and reject UI/tool races without dropping omitted fields", async () => {
  const f = await fixture(); try {
    const results = await Promise.allSettled([own(f.settings, A, 0, { searchProvider: "brave" }), own(f.settings, A, 0, { fetchProvider: "tavily" }), own(f.settings, B, 0, { searchProvider: "tavily" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
    assert.equal(results[1].reason.code, "WEB_SETTINGS_CONFLICT");
    const concurrent = await Promise.allSettled([
      defaults(f.settings, A, 0, { searchProvider: "tavily" }),
      f.settings.handle("web.settings.set", { expectedRevision: 0, config: { searchProvider: "tinyfish", fetchProvider: "tinyfish" } }),
    ]);
    assert.equal(concurrent[0].status, "fulfilled"); assert.equal(concurrent[1].reason.code, "WEB_SETTINGS_CONFLICT");
    assert.deepEqual(f.settings.snapshot().config, { searchProvider: "tavily", fetchProvider: "direct" });
    assert.equal(f.settings.agentSnapshot(A).agent.revision, 1);
  } finally { await f.close(); }
});
test("Agent preferences survive restart, share encrypted keys and leave model projections key-free", async () => {
  const f = await fixture(), apiKey = "fixture-shared-brave-key"; try {
    await f.settings.handle("web.credentials.set", { provider: "brave", expectedRevision: null, apiKey });
    await own(f.settings, A, 0, { searchProvider: "brave" }); await own(f.settings, B, 0, { searchProvider: "brave", fetchProvider: "tavily" });
    await defaults(f.settings, A, 0, { fetchProvider: "tinyfish" });
    await f.settings.close(); await f.secrets.close(); await f.secrets.open();
    const after = new WebSettings({ paths: f.paths, secretStore: f.secrets });
    for (const profileId of [A, B]) {
      assert.deepEqual(await after.resolve("web_search", profileId), { provider: "brave", apiKey });
      assert.equal(fs.statSync(after.agentFile(profileId)).mode & 0o777, 0o600);
      assert(!fs.readFileSync(after.agentFile(profileId), "utf8").includes(apiKey));
      const snapshot = after.agentSnapshot(profileId), json = JSON.stringify(snapshot);
      assert.equal(snapshot.credentials.brave.configured, true); assert(!json.includes(apiKey)); assert(!json.includes("credentialRef"));
      assert.deepEqual(Object.keys(snapshot.credentials.brave), ["configured"]);
    }
    assert.equal((await after.resolve("web_fetch", A)).provider, "tinyfish");
    assert.equal((await after.resolve("web_fetch", B)).provider, "tavily");
    await after.close();
  } finally { await f.close(); }
});
test("revoked queued saves make no change and capture their validated patch before waiting", async () => {
  const f = await fixture(); try {
    let release, alive = true;
    const blocker = f.settings.enqueue(() => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const pending = own(f.settings, A, 0, { searchProvider: "brave" }, { assertCurrent() {
      if (!alive) throw Object.assign(Error("revoked"), { code: "MCP_TOOL_FORBIDDEN" });
    } });
    alive = false; release(); await blocker;
    await assert.rejects(pending, { code: "MCP_TOOL_FORBIDDEN" }); assert(!fs.existsSync(f.settings.agentFile(A)));
    const args = { expectedRevision: 0, config: { searchProvider: "brave" } };
    const saved = f.settings.handleTool("web_settings_set", A, args, live); args.config.searchProvider = "tinyfish";
    assert.equal((await saved).effective.searchProvider, "brave");
  } finally { await f.close(); }
});
test("corrupt or symlinked Agent files fail closed without breaking another Agent or the global UI", async () => {
  const f = await fixture(); try {
    await own(f.settings, A, 0, { searchProvider: "brave" });
    fs.writeFileSync(f.settings.agentFile(A), "{broken", { mode: 0o600 });
    await assert.rejects(f.settings.resolve("web_search", A), { code: "WEB_SETTINGS_UNAVAILABLE" });
    await assert.rejects(f.settings.resolve("web_search", A), { code: "WEB_SETTINGS_UNCERTAIN" });
    assert.equal(f.settings.agentSnapshot(B).effective.searchProvider, "exa"); assert.equal(f.settings.snapshot().revision, 0);
    const target = path.join(f.root, "outside.json"); fs.writeFileSync(target, JSON.stringify({ revision: 99, config: { searchProvider: "brave", fetchProvider: null } }), { mode: 0o600 });
    const agentFile = f.settings.agentFile(B); fs.symlinkSync(target, agentFile);
    await assert.rejects(f.settings.resolve("web_search", B), { code: "WEB_SETTINGS_UNAVAILABLE" });
    const linked = "agent-linked"; fs.symlinkSync(f.root, path.dirname(f.settings.agentFile(linked)));
    await assert.rejects(f.settings.resolve("web_search", linked), { code: "WEB_SETTINGS_UNAVAILABLE" });
    assert.equal(JSON.parse(fs.readFileSync(target)).revision, 99);
    for (const profileId of ["../other", "/other", "..", ""]) assert.throws(() => f.settings.agentFile(profileId));
  } finally { await f.close(); }
});
test("actual web routing uses trusted per-Agent choices and shared keys; missing keys never fall back", async () => {
  const { WebService } = require("../app/agent-service/web-service");
  const f = await fixture(); try {
    const apiKey = "fixture-shared-provider-key", calls = [];
    await f.settings.handle("web.credentials.set", { provider: "brave", expectedRevision: null, apiKey });
    await own(f.settings, A, 0, { searchProvider: "brave" }); await own(f.settings, B, 0, { searchProvider: "tavily" });
    const service = new WebService({ settings: f.settings, request: async (url, options) => {
      calls.push({ url, options }); return { body: Buffer.from(JSON.stringify({ web: { results: [{ url: "https://example.com", title: "Page", description: "Brave result" }] } })) };
    } });
    assert.equal((await service.call("web_search", { query: "test" }, { profileId: A })).provider, "brave");
    assert.equal(calls[0].options.headers["X-Subscription-Token"], apiKey);
    await assert.rejects(service.call("web_search", { query: "test" }, { profileId: B }), { code: "WEB_API_KEY_REQUIRED" });
    assert.equal(calls.length, 1);
    assert.equal((await f.settings.resolve("web_search", null)).provider, "exa");
  } finally { await f.close(); }
});
