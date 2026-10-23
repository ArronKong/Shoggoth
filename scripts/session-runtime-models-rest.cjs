"use strict";
// Full REST -> native facade -> authenticated Service -> real Product/Chat stores.
// Only CLI model catalogs/auth/transport are fixtures, with no provider traffic.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { DEFAULT_RUNTIME_ACCOUNTS, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
  NATIVE_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { createConfigStore, projectNativeRuntimeConfig } = require("../app/core/config-store");

async function run() {
  const f = await openHandoffFixture({ builtinCliProfiles: true, catalogs: {
    codex: ["fixture-model", "codex-only"], pi: ["fixture-model", "pi-only"],
    opencode: ["fixture-model", "opencode-only"],
    "deepseek-harness": ["fixture-model", "dsh-only"],
  } });
  let server;
  try {
    // Use the real first-install configuration instead of test-only gate enabling.
    const configStore = createConfigStore(path.join(f.root, "ui-config.json"));
    configStore.ensure();
    const config = projectNativeRuntimeConfig(configStore.read());
    assert.ok(Object.values(config.flags).every(Boolean), "fresh App must enable the shipped Runtime framework");
    f.service.nativeRuntimeConfig.apply({ ...config,
      revision: f.service.nativeRuntimeConfig.read().revision + 1 });
    const cli = DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.kind === "native-user").map(account => ({
      runtime: account.runtime, name: account.runtime, runtimeAccountId: account.id,
      binaryPath: path.join(f.root, "fixture-cli"), accountHome: path.join(f.root, account.id), processHome: f.root,
      homeEnv: null, accountKind: account.kind, credentialFile: "auth.json", loginArgs: [], logoutArgs: [], docsUrl: "https://example.invalid/",
    }));
    const backend = new ShoggothBackend({ paths: f.paths, runtimeCliAuth: cli });
    let disabled = ["grok-build", "antigravity"];
    backend.setDisabledBackendsProvider(() => disabled);
    backend._state = "started";
    const session = f.createSession();
    await f.complete(await f.send(session.sessionKey, "model-menu-history", "Keep this conversation"));
    const original = f.service.chatSessionStore.getSession(session.sessionKey);
    const initialDefault = f.service.productStore.getAgentProfile(f.profile.id).defaultBindingId;
    const otherProfile = f.service.productStore.listAgentProfiles().find(profile => profile.agentId === "shoggoth-pi");
    const otherSession = f.service.chatSessionStore.createSession({ operationId: "other-agent-model-menu",
      profileId: otherProfile.id, workspace: f.workspace, createdAt: Date.now() });
    await f.complete(await f.send(otherSession.sessionKey, "other-agent-history", "Keep the Pi Agent conversation"));
    const otherOriginal = f.service.chatSessionStore.getSession(otherSession.sessionKey);
    const fallbackProfile = f.service.productStore.listAgentProfiles().find(profile => profile.agentId === "shoggoth-opencode");
    const fallbackSession = f.service.chatSessionStore.createSession({ operationId: "no-cli-harness-model-menu",
      profileId: fallbackProfile.id, workspace: f.workspace, createdAt: Date.now() });
    await backend._refreshManagedProfiles();
    const initialBindings = f.service.productStore.getAgentRuntimeBindings(f.profile.id);
    assert.ok(initialBindings.bindings.some(binding => binding.runtimeAccountId === "native-codex-default-v1"), "connected CLI bound automatically");
    const registry = new BackendRegistry(); registry.register(backend); registry.setDisabledBackendsProvider(() => disabled);
    server = await startStaticServer(0, { registry, homeDir: f.root, userDataRoot: path.join(f.root, "ui") });
    const publicKey = `agent:${f.profile.agentId}:${session.sessionKey}`;
    const route = `/__api/agents/${f.profile.agentId}/runtime-models?backend=shoggoth&sessionKey=${encodeURIComponent(publicKey)}`;
    const request = async (body, origin = server.url, target = route) => {
      const response = await fetch(`${server.url}${target}`, { method: body ? "PUT" : "GET",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const otherRoute = `/__api/agents/${otherProfile.agentId}/runtime-models?backend=shoggoth&sessionKey=${encodeURIComponent(
      `agent:${otherProfile.agentId}:${otherSession.sessionKey}`)}`;
    const otherCatalog = await request(undefined, server.url, otherRoute);
    assert.equal(otherCatalog.status, 200, JSON.stringify(otherCatalog.body));
    assert.deepEqual(otherCatalog.body.runtimes.filter(runtime => runtime.runtime === "codex")
      .map(runtime => runtime.name).sort(), ["Codex CLI", "Codex Harness"],
    "an Agent with a native CLI default must also offer the bundled Codex Harness");
    const otherBindings = f.service.productStore.getAgentRuntimeBindings(otherProfile.id);
    const otherHarness = otherBindings.bindings.find(binding =>
      binding.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    const otherCli = otherBindings.bindings.find(binding => binding.runtimeAccountId === NATIVE_CODEX_RUNTIME_ACCOUNT_ID);
    assert.notEqual(otherHarness.id, otherCli.id, "Harness and CLI remain separate account bindings");
    await request(undefined, server.url, otherRoute);
    assert.deepEqual(f.service.productStore.getAgentRuntimeBindings(otherProfile.id), otherBindings,
      "automatic Harness binding is idempotent");
    const otherChanged = await request({ bindingId: otherHarness.id, model: "codex-only",
      revision: otherCatalog.body.selection.revision, acceptAdjustments: true }, server.url, otherRoute);
    assert.equal(otherChanged.status, 200, JSON.stringify(otherChanged.body));
    const otherSaved = f.service.chatSessionStore.getSession(otherSession.sessionKey);
    assert.equal(otherSaved.runtimeBindingId, otherHarness.id);
    assert.equal(otherSaved.modelOverride, "codex-only");
    assert.equal(otherSaved.retiredRuntimeSessions.at(-1).runtimeSessionId, otherOriginal.runtimeSessionId);
    assert.equal(f.service.productStore.getAgentProfile(otherProfile.id).defaultBindingId, otherProfile.defaultBindingId);
    const harnessRun = await f.send(otherSession.sessionKey, "other-agent-harness-run");
    assert.equal(harnessRun.status, "running", harnessRun.errorCode);
    const harnessAcquisition = f.transport.acquisitions.at(-1);
    assert.equal(harnessAcquisition.binding.runtimeAccountId, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      "the selected Harness model executes through the managed account");
    await f.complete(harnessRun, "Harness answer for the Pi Agent");
    const otherEvents = f.service.transcriptStore.listEvents(otherProfile.id, otherSession.id);
    assert.ok(otherEvents.some(event => event.content?.text === "Keep the Pi Agent conversation"));
    assert.ok(otherEvents.some(event => event.content?.text === "Harness answer for the Pi Agent"));
    let catalog = await request();
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.selection.canSwitch, true, "fresh App must allow cross-Runtime selection");
    assert.deepEqual(new Set(catalog.body.runtimes.map(runtime => runtime.runtime)), new Set(["codex", "pi", "opencode", "deepseek-harness"]));
    assert.deepEqual(catalog.body.runtimes.filter(runtime => runtime.runtime === "codex")
      .map(runtime => runtime.name), ["Codex Harness", "Codex CLI"]);
    assert.equal(catalog.body.models.length, 10, JSON.stringify(catalog.body));
    assert.equal(catalog.body.models.filter(model => model.id === "fixture-model").length, 5);
    assert.equal(new Set(catalog.body.models.map(model => `${model.bindingId}:${model.id}`)).size, 10);
    assert.equal(catalog.body.runtimes.find(runtime => runtime.runtime === "deepseek-harness").name, "DeepSeek");
    await request();
    assert.deepEqual(f.service.productStore.getAgentRuntimeBindings(f.profile.id), initialBindings, "repeat reads do not create duplicate bindings");
    let selection = catalog.body.selection;
    const input = (runtime, model) => ({ bindingId: f.binding(runtime).id, model, revision: selection.revision, acceptAdjustments: true });
    assert.equal((await request(input("pi", "pi-only"), null)).status, 403, "Origin is required");
    assert.equal((await request({ ...input("pi", "pi-only"), profileId: "foreign" })).status, 400);
    assert.equal((await request(input("pi", "codex-only"))).body.code, "MODEL_ROUTE_UNSUPPORTED");
    assert.deepEqual(f.service.chatSessionStore.getSession(session.sessionKey), original, "invalid model leaves whole conversation unchanged");
    const changed = await request(input("pi", "pi-only"));
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); selection = changed.body;
    let saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.modelOverride, "pi-only"); assert.equal(saved.runtimeBindingId, f.binding("pi").id);
    assert.equal(saved.runtimeSessionId, null); assert.equal(saved.retiredRuntimeSessions.length, 1);
    assert.equal(saved.retiredRuntimeSessions[0].runtimeSessionId, original.runtimeSessionId);
    assert.equal(f.service.productStore.getAgentProfile(f.profile.id).defaultBindingId, initialDefault);
    const active = await f.send(session.sessionKey, "model-menu-run");
    assert.equal(active.status, "running", active.errorCode);
    assert.equal(active.runtimeSessionRef.runtime, "pi");
    assert.equal(f.transport.hosts.get("pi").lastTurnStartParams.model, "pi-only");
    assert.equal(f.transport.acquisitions.at(-1).options.executionContract.provider.modelRef, "pi-only");
    selection = (await request()).body.selection;
    const futureSelection = await request(input("codex", "codex-only"));
    assert.equal(futureSelection.status, 200, JSON.stringify(futureSelection.body));
    const stillActive = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(stillActive.runtimeBindingId, f.binding("pi").id);
    assert.equal(stillActive.runtimeSessionId, active.runtimeSessionRef.sessionId);
    assert.equal(stillActive.nextRuntimeSelection.model, "codex-only");
    assert.equal(f.service.workRunCoordinator.getRun(active.id).status, "running");
    await f.complete(active, "Answer after selection");
    catalog = await request(); selection = catalog.body.selection;
    const beforeSame = f.service.chatSessionStore.getSession(session.sessionKey);
    const stale = input("pi", "fixture-model");
    const same = await request(stale); assert.equal(same.status, 200, JSON.stringify(same.body)); selection = same.body;
    saved = f.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(saved.runtimeSessionId, null, "same CLI model change starts a new native session");
    assert.equal(saved.retiredRuntimeSessions.length, beforeSame.retiredRuntimeSessions.length + 1);
    assert.equal(saved.retiredRuntimeSessions.at(-1).runtimeSessionId, beforeSame.runtimeSessionId);
    assert.equal((await request(stale)).body.code, "CHAT_SESSION_REVISION_CONFLICT");
    disabled = [...disabled, "deepseek-harness"];
    assert.equal((await request()).body.models.some(model => model.runtime === "deepseek-harness"), false);
    assert.equal((await request(input("deepseek-harness", "dsh-only"))).body.code, "NATIVE_RUNTIME_DISABLED");
    const events = f.service.transcriptStore.listEvents(f.profile.id, session.id);
    assert.ok(events.some(event => event.content?.text === "Keep this conversation"));
    assert.ok(events.some(event => event.content?.text === "Answer after selection"));
    assert.equal(f.service.chatSessionStore.listPendingRuntimeSwitches().length, 0);
    backend.runtimeCliAuth.delete("native-codex-default-v1");
    catalog = await request();
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.deepEqual(catalog.body.runtimes.filter(runtime => runtime.runtime === "codex")
      .map(runtime => runtime.name), ["Codex Harness"],
    "Shoggoth's bundled Codex remains available without the system Codex CLI");
    const nativeCodex = initialBindings.bindings.find(binding => binding.runtimeAccountId === "native-codex-default-v1");
    assert.equal((await request({ bindingId: nativeCodex.id, model: "codex-only",
      revision: catalog.body.selection.revision, acceptAdjustments: true })).body.code, "RUNTIME_NOT_INSTALLED");
    const managedCodex = await request({ bindingId: initialDefault, model: "codex-only",
      revision: catalog.body.selection.revision, acceptAdjustments: true });
    assert.equal(managedCodex.status, 200, JSON.stringify(managedCodex.body));
    const fallbackBindings = f.service.productStore.getAgentRuntimeBindings(fallbackProfile.id);
    const fallbackHarness = fallbackBindings.bindings.find(binding =>
      binding.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    f.service.productStore.removeAgentRuntimeBinding(fallbackProfile.id, fallbackHarness.id,
      { revision: fallbackBindings.revision });
    backend.runtimeCliAuth.clear();
    const fallbackRoute = `/__api/agents/${fallbackProfile.agentId}/runtime-models?backend=shoggoth&sessionKey=${encodeURIComponent(
      `agent:${fallbackProfile.agentId}:${fallbackSession.sessionKey}`)}`;
    const fallbackCatalog = await request(undefined, server.url, fallbackRoute);
    assert.equal(fallbackCatalog.status, 200, JSON.stringify(fallbackCatalog.body));
    assert.deepEqual(fallbackCatalog.body.runtimes.map(runtime => runtime.name), ["Codex Harness"],
      "an Agent without a Harness binding can discover it with no native CLI installed");
    const fallbackState = f.service.productStore.getAgentRuntimeBindings(fallbackProfile.id);
    const restoredHarness = fallbackState.bindings.find(binding =>
      binding.runtimeAccountId === SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
    await request(undefined, server.url, fallbackRoute);
    assert.deepEqual(f.service.productStore.getAgentRuntimeBindings(fallbackProfile.id), fallbackState);
    const disabledHarness = await backend.updateAgentRuntimeBinding(fallbackProfile.agentId, restoredHarness.id,
      { enabled: false }, { revision: fallbackState.revision });
    const disabledCatalog = await request(undefined, server.url, fallbackRoute);
    assert.equal(disabledCatalog.status, 200, JSON.stringify(disabledCatalog.body));
    assert.deepEqual(disabledCatalog.body.runtimes, [], "sync must preserve an explicitly disabled Harness binding");
    assert.equal(f.service.productStore.getAgentRuntimeBindings(fallbackProfile.id).bindings
      .find(binding => binding.id === restoredHarness.id).enabled, false);
    await backend.updateAgentRuntimeBinding(fallbackProfile.agentId, restoredHarness.id,
      { enabled: true }, { revision: disabledHarness.revision });
    const fallbackChanged = await request({ bindingId: restoredHarness.id, model: "codex-only",
      revision: fallbackCatalog.body.selection.revision, acceptAdjustments: true }, server.url, fallbackRoute);
    assert.equal(fallbackChanged.status, 200, JSON.stringify(fallbackChanged.body));
    assert.equal(f.service.productStore.getAgentProfile(fallbackProfile.id).defaultBindingId, fallbackProfile.defaultBindingId);
    assert.equal(f.service.chatSessionStore.getSession(fallbackSession.sessionKey).runtimeBindingId, restoredHarness.id);
    console.log("PASS Runtime model REST: other Agents discover and execute through Codex Harness; account separation, no-CLI binding, explicit disable, atomic selection, history and Agent defaults preserved.");
  } finally { if (server) await server.close(); await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
