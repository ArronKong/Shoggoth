"use strict";
// Composer model menu cache: facade -> authenticated real fixture Service.
// Only the facade's Service transport is wrapped to delay or fail catalog reads.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { requestService } = require("../app/agent-service/client");
const { DEFAULT_RUNTIME_ACCOUNTS, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { createConfigStore, projectNativeRuntimeConfig } = require("../app/core/config-store");

const PI = "native-pi-default-v1";
const HARNESS = SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
const SLOW = 800;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const catalogs = { codex: ["fixture-model", "codex-only"], pi: ["fixture-model", "pi-only"],
    opencode: ["fixture-model", "opencode-only"], "deepseek-harness": ["fixture-model", "dsh-only"] };
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
    const backend = new ShoggothBackend({ paths: f.paths, runtimeCliAuth: cli, requestService: async (paths, request, options) => {
      if (request.method === "profile.binding.models.list") {
        const rule = rules.get(accountOf(request.params.bindingId));
        if (rule?.delayMs) await delay(rule.delayMs);
        if (rule?.fail) throw Object.assign(new Error("fixture catalog failure"), { code: "PROFILE_MODEL_CATALOG_UNAVAILABLE" });
      }
      return requestService(paths, request, options);
    } });
    backend.setDisabledBackendsProvider(() => ["grok-build", "antigravity"]);
    backend._state = "started";
    const session = f.createSession();
    const sessionFor = agentId => {
      const profile = f.service.productStore.listAgentProfiles().find(entry => entry.agentId === agentId);
      return f.service.chatSessionStore.createSession({ operationId: `menu-cache-${agentId}`,
        profileId: profile.id, workspace: f.workspace, createdAt: Date.now() });
    };
    const piAgentSession = sessionFor("shoggoth-pi");
    const openCodeAgentSession = sessionFor("shoggoth-opencode");
    await backend._refreshManagedProfiles();
    const read = async (agentId = f.profile.agentId, sessionKey = session.sessionKey) => {
      const started = Date.now();
      const result = await backend.getSessionRuntimeModels(agentId, `agent:${agentId}:${sessionKey}`);
      return { result, ms: Date.now() - started };
    };
    const group = (result, runtimeAccountId) => {
      const runtime = DEFAULT_RUNTIME_ACCOUNTS.find(account => account.id === runtimeAccountId).runtime;
      const groups = result.runtimes.filter(entry => entry.runtime === runtime);
      const found = runtime === "codex" ? groups.find(entry => entry.name === "Codex Harness") : groups[0];
      return { ...found, ids: result.models.filter(model => model.bindingId === found.bindingId).map(model => model.id) };
    };
    const settle = () => delay(SLOW + 200);

    // 1. A cold menu loads every candidate together instead of three at a time.
    for (const account of [HARNESS, "native-codex-default-v1", PI, "native-opencode-default-v1", "native-deepseek-harness-default-v1"]) {
      rules.set(account, { delayMs: SLOW });
    }
    let { result, ms } = await read();
    assert.equal(result.runtimes.length, 5, JSON.stringify(result.runtimes));
    assert.ok(result.runtimes.every(entry => entry.available), "cold catalogs all load");
    assert.ok(ms >= SLOW - 50, `cold read waits for real catalogs (${ms}ms)`);
    assert.ok(ms < SLOW * 2 - 100, `five slow catalogs load concurrently (${ms}ms)`);
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
    console.log("PASS Runtime model menu cache: concurrent cold load, cached slow refresh, fresh budget, failures never hidden, write/connection/generation invalidation, account-shared native catalogs and per-Agent Harness.");
  } finally { await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
