"use strict";
// Full REST -> native facade -> authenticated Service -> real Product/Chat stores.
// Only CLI model catalogs/auth/transport are fixtures, with no provider traffic.
const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { createConfigStore, projectNativeRuntimeConfig } = require("../app/core/config-store");

async function run() {
  const f = await openHandoffFixture({ catalogs: {
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
    let catalog = await request();
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.selection.canSwitch, true, "fresh App must allow cross-Runtime selection");
    assert.deepEqual(new Set(catalog.body.runtimes.map(runtime => runtime.runtime)), new Set(["codex", "pi", "opencode", "deepseek-harness"]));
    assert.equal(catalog.body.models.length, 8, JSON.stringify(catalog.body));
    assert.equal(catalog.body.models.filter(model => model.id === "fixture-model").length, 4);
    assert.equal(new Set(catalog.body.models.map(model => `${model.bindingId}:${model.id}`)).size, 8);
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
    assert.equal((await request(input("codex", "codex-only"))).body.code, "SESSION_BUSY");
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
    console.log("PASS Runtime model REST: automatic binding, CLI catalogs, duplicate IDs, atomic selection, native-session renewal, busy/CAS/origin/ownership gates and unchanged Agent default.");
  } finally { if (server) await server.close(); await f.close(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
