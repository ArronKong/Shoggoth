"use strict";
// Composer model menu cache: facade -> authenticated real fixture Service.
// Only the facade's Service transport is wrapped to delay or fail catalog reads.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { requestService } = require("../app/agent-service/client");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_CLAUDE_CODE_RUNTIME_ACCOUNT_ID: CLAUDE,
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { isRuntimeAvailable } = require("../app/runtime-availability");
const { createConfigStore, projectNativeRuntimeConfig } = require("../app/core/config-store");
const { createRuntimeModelCacheStore } = require("../app/core/runtime-model-cache-store");

const PI = "native-pi-default-v1";
const HARNESS = SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
const SLOW = 800;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const catalogs = { codex: ["fixture-model", "codex-only"], pi: ["fixture-model", "pi-only"],
    opencode: ["fixture-model", "opencode-only"], "deepseek-harness": ["fixture-model", "dsh-only"],
    "claude-code": ["opus", "sonnet"] };
  const f = await openHandoffFixture({ builtinCliProfiles: true, catalogs });
  try {
    const configStore = createConfigStore(path.join(f.root, "ui-config.json"));
    configStore.ensure();
    f.service.nativeRuntimeConfig.apply({ ...projectNativeRuntimeConfig(configStore.read()),
      revision: f.service.nativeRuntimeConfig.read().revision + 1 });
    const cli = DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.kind === "native-user").map(account => ({
      runtime: account.runtime, name: account.runtime, runtimeAccountId: account.id,
      binaryPath: path.join(f.root, "fixture-cli"), accountHome: path.join(f.root, account.id), processHome: f.root,
      homeEnv: null, accountKind: account.kind, credentialFile: "auth.json", loginArgs: [], logoutArgs: [], docsUrl: "https://example.invalid/",
    }));
    // Per runtime account: { delayMs, fail } applied to its catalog reads.
    const rules = new Map();
    const accountOf = bindingId => {
      for (const profile of f.service.productStore.listAgentProfiles()) {
        const binding = f.service.productStore.getAgentRuntimeBindings(profile.id).bindings.find(entry => entry.id === bindingId);
        if (binding) return binding.runtimeAccountId;
      }
      return null;
    };
    const transport = async (paths, request, options) => {
      if (request.method === "profile.binding.models.list") {
        const rule = rules.get(accountOf(request.params.bindingId));
        if (rule?.legacy && request.params.includeSourceStatus) throw Object.assign(new Error("older Service"), { code: "INVALID_PARAMS" });
        if (rule?.delayMs) await delay(rule.delayMs);
        if (rule?.fail) throw Object.assign(new Error("fixture catalog failure"), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
      }
      return requestService(paths, request, options);
    };
    const makeBackend = (options = {}) => {
      const value = new ShoggothBackend({ paths: f.paths, runtimeCliAuth: cli, requestService: transport, ...options });
      value.setDisabledBackendsProvider(() => ["grok-build", "antigravity"]);
      value._state = "started";
      return value;
    };
    const backend = makeBackend();
    const session = f.createSession();
    const sessionFor = agentId => {
      const profile = f.service.productStore.listAgentProfiles().find(entry => entry.agentId === agentId);
      return f.service.chatSessionStore.createSession({ operationId: `menu-cache-${agentId}`,
        profileId: profile.id, workspace: f.workspace, createdAt: Date.now() });
    };
    const piAgentSession = sessionFor("shoggoth-pi");
    const openCodeAgentSession = sessionFor("shoggoth-opencode");
    await backend._refreshManagedProfiles();
    const read = async (agentId = f.profile.agentId, sessionKey = session.sessionKey, facade = backend) => {
      const started = Date.now();
      const result = await facade.getSessionRuntimeModels(agentId, `agent:${agentId}:${sessionKey}`);
      return { result, ms: Date.now() - started };
    };
    const group = (result, runtimeAccountId) => {
      const runtime = DEFAULT_RUNTIME_ACCOUNTS.find(account => account.id === runtimeAccountId).runtime;
      const groups = result.runtimes.filter(entry => entry.runtime === runtime);
      const found = runtime === "codex" ? groups.find(entry => entry.name === "Shoggoth") : groups[0];
      return { ...found, ids: result.models.filter(model => model.bindingId === found.bindingId).map(model => model.id) };
    };
    const settle = () => delay(SLOW + 200);

    // 1. A cold menu loads every candidate together instead of three at a time.
    const accounts = [HARNESS, "native-codex-default-v1", PI, "native-opencode-default-v1", "native-deepseek-harness-default-v1"];
    if (isRuntimeAvailable("claude-code")) accounts.push(CLAUDE);
    for (const account of accounts) {
      rules.set(account, { delayMs: SLOW });
    }
    let { result, ms } = await read();
    assert.equal(result.runtimes.length, accounts.length, JSON.stringify(result.runtimes));
    assert.ok(result.runtimes.every(entry => entry.available), "cold catalogs all load");
    assert.ok(ms >= SLOW - 50, `cold read waits for real catalogs (${ms}ms)`);
    assert.ok(ms < SLOW * 2 - 100, `slow catalogs load concurrently (${ms}ms)`);
    rules.clear();

    // 2. A slow refresh no longer holds the menu: the previous catalog is shown.
    rules.set(PI, { delayMs: SLOW });
    ({ result, ms } = await read());
    assert.ok(ms < SLOW - 100, `cached catalog returned within the fresh budget (${ms}ms)`);
    assert.equal(group(result, PI).available, true);
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-only"]);
    await settle(); rules.clear();

    // 3. A refresh that settles within the budget is shown instead of the cache.
    catalogs.pi = ["fixture-model", "pi-only", "pi-new"];
    ({ result } = await read());
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-only", "pi-new"], "fast refresh wins");

    // 4. A slow refresh is kept for the next read.
    catalogs.pi = ["fixture-model", "pi-newer"];
    rules.set(PI, { delayMs: SLOW });
    ({ result, ms } = await read());
    assert.ok(ms < SLOW - 100, `slow refresh does not block (${ms}ms)`);
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-only", "pi-new"], "previous catalog meanwhile");
    await settle();
    ({ result, ms } = await read());
    assert.ok(ms < SLOW - 100);
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-newer"], "background refresh reaches the next read");
    await settle(); rules.clear();

    // 5. A failure is never hidden by an older catalog.
    rules.set(PI, { fail: true });
    ({ result } = await read());
    assert.equal(group(result, PI).available, false, "fast failure shown at once");
    rules.clear();
    ({ result } = await read());
    assert.equal(group(result, PI).available, true, "recovered catalog shown");
    rules.set(PI, { delayMs: SLOW, fail: true });
    ({ result, ms } = await read());
    assert.ok(ms < SLOW - 100);
    assert.equal(group(result, PI).available, true, "slow failure: previous catalog for this read only");
    await settle();
    ({ result, ms } = await read());
    assert.ok(ms >= SLOW - 50, `after a failed refresh the next read waits (${ms}ms)`);
    assert.equal(group(result, PI).available, false, "failure reaches the next read");
    rules.clear();
    ({ result } = await read());
    assert.equal(group(result, PI).available, true);

    // 6. Catalog writes through the facade, connection changes and a new Service
    //    generation make the next read wait for a fresh catalog.
    const piBinding = f.binding("pi");
    const bindings = f.service.productStore.getAgentRuntimeBindings(f.profile.id);
    await backend.updateAgentRuntimeBinding(f.profile.agentId, piBinding.id, { label: "Pi cache test" },
      { revision: bindings.revision });
    for (const invalidate of [() => {}, () => backend.onConnectionsChanged(), () => { backend._generation += 1; }]) {
      invalidate();
      rules.set(PI, { delayMs: SLOW });
      ({ result, ms } = await read());
      assert.ok(ms >= SLOW - 50, `invalidated catalog is reloaded (${ms}ms)`);
      assert.equal(group(result, PI).available, true);
      rules.clear();
    }
    ({ ms } = await read());

    // 7. Native CLI accounts are shared across Agents; Harness catalogs are not.
    rules.set(PI, { delayMs: SLOW });
    ({ result, ms } = await read("shoggoth-pi", piAgentSession.sessionKey));
    assert.ok(ms < SLOW - 100, `another Agent reuses the native Pi catalog (${ms}ms)`);
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-newer"]);
    await settle(); rules.clear();
    rules.set(HARNESS, { delayMs: SLOW });
    ({ result, ms } = await read("shoggoth-opencode", openCodeAgentSession.sessionKey));
    assert.ok(ms >= SLOW - 50, `a Harness catalog is loaded for its own Agent (${ms}ms)`);
    assert.equal(group(result, HARNESS).available, true);
    await settle(); rules.clear();

    // 8. Last good catalogs persist: a restarted facade and a new Service
    //    generation show them while refreshing. Start-cycle writes keep them;
    //    a user write after start and a failed refresh drop them.
    const cache = createRuntimeModelCacheStore({ trustedRoot: f.root });
    const restarted = async () => { const value = makeBackend({ runtimeModelCache: cache }); await value._refreshManagedProfiles(); return value; };
    const own = (facade) => read(undefined, undefined, facade);
    let facade = await restarted();
    await own(facade); await settle();
    if (isRuntimeAvailable("claude-code")) {
      const stored = cache.read();
      const saved = stored[`account:${CLAUDE}`];
      saved.snapshot.models.unshift({ id: "default", displayName: "Default (recommended)", description: "", isDefault: true });
      cache.write(stored);
      const claudeSession = sessionFor("shoggoth-claude-code");
      f.service.chatSessionStore.setModelOverride(claudeSession.sessionKey, "default");
      facade = await restarted();
      rules.set(CLAUDE, { delayMs: SLOW });
      ({ result } = await read("shoggoth-claude-code", claudeSession.sessionKey, facade));
      assert.deepEqual(group(result, CLAUDE).ids, ["opus", "sonnet"], "old cache never offers the retired alias");
      assert.equal(result.selection.model, "opus", "saved default highlights the concrete model");
      assert.equal(f.service.chatSessionStore.getSession(claudeSession.sessionKey).modelOverride, "default");
      rules.clear();
    }
    facade = await restarted();
    rules.set(PI, { delayMs: SLOW });
    ({ result, ms } = await own(facade));
    assert.ok(ms < SLOW - 100, `a restarted facade shows the persisted catalog (${ms}ms)`);
    assert.deepEqual(group(result, PI).ids, ["fixture-model", "pi-newer"]);
    await settle();
    facade._generation += 1;
    ({ result, ms } = await own(facade));
    assert.ok(ms < SLOW - 100, `a new Service generation shows the persisted catalog (${ms}ms)`);
    await settle(); rules.clear();
    facade._state = "starting";
    await facade._call("agent.binding.update", { profileId: f.profile.id, bindingId: piBinding.id,
      patch: { label: "Pi start cycle" }, revision: f.service.productStore.getAgentRuntimeBindings(f.profile.id).revision });
    facade._state = "started";
    facade = await restarted();
    rules.set(PI, { delayMs: SLOW });
    ({ ms } = await own(facade));
    assert.ok(ms < SLOW - 100, `a start-cycle write keeps persisted catalogs (${ms}ms)`);
    await settle(); rules.clear();
    await facade.updateAgentRuntimeBinding(f.profile.agentId, piBinding.id, { label: "Pi user write" },
      { revision: f.service.productStore.getAgentRuntimeBindings(f.profile.id).revision });
    facade = await restarted();
    rules.set(PI, { delayMs: SLOW });
    ({ ms } = await own(facade));
    assert.ok(ms >= SLOW - 50, `a user write drops persisted catalogs (${ms}ms)`);
    rules.set(PI, { fail: true });
    ({ result } = await own(facade));
    assert.equal(group(result, PI).available, false);
    facade = await restarted();
    rules.set(PI, { delayMs: SLOW });
    ({ result, ms } = await own(facade));
    assert.ok(ms >= SLOW - 50, `a failed refresh drops the persisted catalog (${ms}ms)`);
    assert.equal(group(result, PI).available, true);
    rules.clear();

    // 9. Prewarm loads the most recent conversation's menu after a start.
    const warm = makeBackend();
    await warm._refreshManagedProfiles();
    let latest = null;
    for (const value of warm._sessionsByKey.values()) if (!latest || value.updatedAt > latest.updatedAt) latest = value;
    const latestAgent = warm._profilesById.get(latest.profileId).agentId;
    await warm._prewarmSessionRuntimeModels(warm._generation);
    rules.set(PI, { delayMs: SLOW });
    ({ ms } = await read(latestAgent, latest.sessionKey, warm));
    assert.ok(ms < SLOW - 100, `a prewarmed menu opens from cache (${ms}ms)`);
    await settle(); rules.clear();
    // A failed ChatGPT source can coexist with verified endpoint models on one Binding.
    f.service.productStore.putModelProvider({ id: "fixture-endpoint", kind: "custom-responses", name: "Endpoint",
      baseUrl: "https://example.invalid/v1", model: "endpoint-only", models: ["endpoint-only"],
      credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
    const auth = f.service.accountAuthManager;
    const readAuth = auth.read.bind(auth);
    auth.read = async () => { throw new Error("temporary catalog authority timeout"); };
    facade = await restarted();
    facade.onConnectionsChanged();
    ({ result } = await own(facade));
    const partial = group(result, HARNESS);
    assert.deepEqual(partial.ids, ["endpoint-only"], "verified endpoint rows remain selectable");
    assert.equal(partial.unavailableSource, "ChatGPT", "a transient source failure must not look like a complete catalog");
    const cachedHarness = () => Object.entries(cache.read()).find(([key]) => key.endsWith(":" + partial.bindingId));
    assert.equal(cachedHarness(), undefined, "a partial result cannot become the persisted catalog");
    auth.read = readAuth;
    ({ result } = await own(facade));
    assert.deepEqual(group(result, HARNESS).ids, [...catalogs.codex, "endpoint-only"]);
    assert.equal(group(result, HARNESS).unavailableSource, undefined);
    assert.ok(cachedHarness());
    auth.read = async () => ({ account: null, requiresOpenaiAuth: true, login: null });
    ({ result } = await own(facade));
    assert.deepEqual(group(result, HARNESS).ids, ["endpoint-only"]);
    assert.equal(group(result, HARNESS).unavailableSource, undefined, "a confirmed sign-out is a complete read");
    assert.deepEqual(cachedHarness()[1].snapshot.models.map(row => row.id), ["endpoint-only"]);
    rules.set(HARNESS, { legacy: true });
    ({ result } = await own(facade));
    assert.deepEqual(group(result, HARNESS).ids, ["endpoint-only"], "a compatible read preserves older Service endpoints");
    assert.equal(group(result, HARNESS).unavailableSource, "ChatGPT", "a legacy endpoint-only response has unconfirmed source coverage");
    assert.equal(cachedHarness(), undefined, "a known partial refresh also invalidates an earlier complete result");
    auth.read = readAuth;
    ({ result } = await own(facade));
    assert.deepEqual(group(result, HARNESS).ids, [...catalogs.codex, "endpoint-only"]);
    assert.equal(group(result, HARNESS).unavailableSource, undefined);
    console.log("PASS Runtime model menu cache: concurrent cold load, cached slow refresh, fresh budget, failures never hidden, write/connection/generation invalidation, account-shared native catalogs, per-Agent Harness, persisted catalogs across restarts and start prewarm.");
  } finally { await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
