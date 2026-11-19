"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexSchemaContract } = require("../app/agent-service/codex-schema-contract");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID: NATIVE, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID: MANAGED } =
  require("../app/agent-service/runtime-account");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");

function fixtureCodex(schemaContract, accountId, percent, resetsAt) {
  const calls = [];
  const account = { type: "chatgpt", planType: "plus", email: `${accountId.split("-")[0]}@example.test` };
  const limits = { limitId: "codex", primary: { usedPercent: percent, windowDurationMins: 300, resetsAt } };
  const state = { account, quota: {
    accountId, rateLimits: limits, rateLimitResetCredits: { availableCount: 2, credits: null }, rateLimitsByLimitId: {
      codex: { ...limits, secondary: { usedPercent: 110, windowDurationMins: 10_080, resetsAt } },
      "codex-extra": { limitName: "Extra models", primary: { usedPercent: 0 } },
    },
  } };
  const host = Object.assign(Object.create(CodexRuntimeHost.prototype), {
    schemaContract, nativeAccountId: accountId, state: "ready", accountRevision: 0, registeredSecrets: [], calls,
    _markFatal: async () => { assert.fail("an optional usage response cannot stop the runtime"); },
    rpc: { async request(method, params) {
      calls.push(method);
      if (method === "account/read") {
        assert.deepEqual(params, { refreshToken: false });
        return { account: state.account, requiresOpenaiAuth: true };
      }
      assert.equal(method, "account/rateLimits/read");
      assert.equal(params, undefined);
      return state.read ? state.read() : state.quota;
    } },
  });
  return { host, state, limits };
}

function fixtureOpenClaw(resetAt) {
  const backend = new OpenClawBackend();
  const calls = [];
  const state = { owner: "oauth:selected", oldGateway: false };
  backend._configSnapshot = async () => ({ parsed: { agents: { entries: { main: {}, other: {} } } } });
  backend._providerCatalogSnapshot = () => ({ providers: { openai: { label: "OpenAI", oauth: ["login"] } } });
  backend._isLocalGateway = () => false;
  backend.request = async (method, params) => {
    assert.equal(method, "models.authStatus");
    calls.push(params);
    if (state.oldGateway && params.refreshUsage) throw new Error("Unexpected refreshUsage");
    return { providers: [{
      provider: "openai",
      profiles: ["oauth:selected", "oauth:other"].map(profileId => ({
        profileId, status: "ok", type: "oauth", source: "saved",
        email: `${params.agentId}-${profileId.split(":").at(-1)}@example.test`,
      })),
      ...(params.refreshUsage && { usage: {
        // The second agent has a local credential with the same profile id.
        authProfileId: params.agentId === "main" ? state.owner : "oauth:selected",
        windows: [{ label: "5h", usedPercent: params.agentId === "main" ? 25 : 82, resetAt }],
      } }),
    }] };
  };
  return { backend, calls, state };
}

async function run() {
  const fixture = await openHandoffFixture({ builtinCliProfiles: true, validateHandles: true });
  let server;
  try {
    const schema = new CodexSchemaContract();
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const managed = fixtureCodex(schema, "managed-private-id", 28, resetsAt);
    const native = fixtureCodex(schema, "native-private-id", 61, resetsAt);
    const openClaw = fixtureOpenClaw(resetsAt * 1_000);
    const manager = fixture.service.runtimeManager;
    const acquire = manager.acquire.bind(manager);
    manager.acquire = async (binding, options) => {
      const handle = await acquire(binding, options);
      const codex = binding.runtimeAccountId === MANAGED ? managed : binding.runtimeAccountId === NATIVE ? native : null;
      if (codex) handle.host.accountQuotaRead = () => codex.host.accountQuotaRead();
      return handle;
    };
    const registry = new BackendRegistry();
    const backend = new ShoggothBackend({ paths: fixture.paths });
    let disabled = [];
    const originalRuns = fixture.service.workRunCoordinator.listRuns().length;
    registry.register(backend);
    registry.register(openClaw.backend);
    registry.setDisabledBackendsProvider(() => disabled);
    server = await startStaticServer(0, { registry, homeDir: fixture.root, userDataRoot: path.join(fixture.root, "ui") });
    const nativeQuota = (provider = MANAGED, options) => fetch(`${server.url}/__api/oauth/quota?backend=shoggoth&provider=${provider}`, options);
    const gatewayAccount = async (quotaOnly = false) => (await (await fetch(
      `${server.url}/__api/oauth?backend=openclaw${quotaOnly ? "&view=quota" : ""}`,
    )).json()).providers[0];
    const gatewayQuota = async () => (await fetch(`${server.url}/__api/oauth/quota?backend=openclaw&provider=openai`)).json();

    const response = await nativeQuota();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const snapshot = await response.json();
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.accountName, "managed@example.test");
    assert.equal(snapshot.resetCredits, 2);
    assert.deepEqual(snapshot.windows, [
      { label: null, durationMinutes: 300, usedPercent: 28, resetsAt: resetsAt * 1_000 },
      { label: null, durationMinutes: 10_080, usedPercent: 100, resetsAt: resetsAt * 1_000 },
      { label: "Extra models", durationMinutes: null, usedPercent: 0, resetsAt: null },
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /managed-private-id/);
    const nativeSnapshot = await (await nativeQuota(NATIVE)).json();
    assert.equal(nativeSnapshot.accountName, "native@example.test");
    assert.equal(nativeSnapshot.windows[0].usedPercent, 61);

    native.state.quota = { rateLimits: native.limits }; // Legacy single-bucket response.
    assert.equal((await (await nativeQuota(NATIVE)).json()).windows.length, 1);
    native.state.account = { type: "apiKey" };
    const nativeCalls = native.host.calls.length;
    assert.deepEqual(await (await nativeQuota(NATIVE)).json(), { status: "unsupported" });
    assert.deepEqual(native.host.calls.slice(nativeCalls), ["account/read"]);
    disabled = ["codex"];
    assert.deepEqual(await (await nativeQuota(NATIVE)).json(), { status: "unsupported" });
    assert.equal(native.host.calls.length, nativeCalls + 1, "a disconnected CLI is never read");
    assert.equal((await nativeQuota("bad/provider")).status, 400);
    assert.equal((await nativeQuota(MANAGED, { method: "POST" })).status, 405);

    managed.state.quota.accountId = "different-private-id";
    assert.deepEqual(await (await nativeQuota()).json(), { status: "unavailable" });
    managed.state.quota.accountId = "managed-private-id";
    const began = Promise.withResolvers();
    const pending = Promise.withResolvers();
    managed.state.read = () => { began.resolve(); return pending.promise; };
    const read = nativeQuota();
    try {
      await Promise.race([began.promise, read.then(() => assert.fail("quota read did not reach Codex"))]);
      const admission = fixture.service.runtimeAccountAdmission;
      admission.finishMutation(admission.beginMutation({ runtimeAccountId: MANAGED, operationId: "rotate-fixture-account" }));
    } finally { pending.resolve(managed.state.quota); }
    assert.deepEqual(await (await read).json(), { status: "unavailable" });
    managed.state.read = () => ({ rateLimits: { primary: { usedPercent: "invalid" } } });
    assert.deepEqual(await (await nativeQuota()).json(), { status: "unavailable" });
    managed.state.read = () => ({ rateLimits: {}, rateLimitResetCredits: { availableCount: 0, credits: [] } });
    assert.deepEqual(await (await nativeQuota()).json(), { status: "unsupported" });
    managed.state.read = () => ({ rateLimits: {}, rateLimitResetCredits: { availableCount: 1, credits: null } });
    const resetOnly = await (await nativeQuota()).json();
    assert.equal(resetOnly.status, "available");
    assert.deepEqual(resetOnly.windows, []);
    assert.equal(resetOnly.resetCredits, 1);
    managed.state.account = { ...managed.state.account, email: "bad\nname@example.test" };
    assert.equal(Object.hasOwn(await (await nativeQuota()).json(), "accountName"), false);
    assert.equal(fixture.service.workRunCoordinator.listRuns().length, originalRuns);
    assert.equal(managed.host.state, "ready");

    const account = await gatewayAccount(true);
    assert.equal(account.status.loggedIn, true);
    assert.equal(account.canReadQuota, true);
    assert.equal(openClaw.calls.some(params => params.refreshUsage), false, "loading the card does not refresh usage");
    const beforeQuota = openClaw.calls.length;
    const gateway = await gatewayQuota();
    assert.equal(gateway.accountName, "main-selected@example.test");
    assert.deepEqual(gateway.windows, [{ label: "5h", durationMinutes: null, usedPercent: 25, resetsAt: resetsAt * 1_000 }]);
    assert.equal(openClaw.calls.slice(beforeQuota).every(params => params.refreshUsage === true), true);
    openClaw.state.owner = "oauth:other";
    assert.deepEqual(await gatewayQuota(), { status: "unsupported" }, "another account's quota cannot be borrowed across scopes");
    openClaw.state.oldGateway = true;
    assert.deepEqual(await gatewayQuota(), { status: "unsupported" });
    assert.equal((await gatewayAccount()).status.loggedIn, true);
    console.log("PASS account quota over REST and Service IPC, Codex isolation and OpenClaw account attribution");
  } finally {
    try { await server?.close(); } finally { await fixture.close(); }
  }
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
