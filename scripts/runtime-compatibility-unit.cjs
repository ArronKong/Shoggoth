"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isRuntimeIncompatible } = require("../app/agent-service/runtime-compatibility");
const { runtimeStageError, runtimeStageFromError, isRetryablePreTurnStageError } = require("../app/agent-service/runtime-stage-error");
const { createRuntimeSupportFacts, supports } = require("../app/agent-service/runtime-support");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");

const fail = code => Object.assign(new Error("private upstream text /private/secret"), { code });
const contractCodes = ["CODEX_RUNTIME_VERSION_MISMATCH", "CLAUDE_CODE_VERSION_UNSUPPORTED",
  "PI_VERSION_UNSUPPORTED", "GROK_ACP_INITIALIZE_INVALID", "OPENCODE_VERSION_UNSUPPORTED",
  "DEEPSEEK_HARNESS_PROTOCOL_UNSUPPORTED", "ANTIGRAVITY_ACP_INITIALIZE_INVALID"];

test("all seven runtime contract failures survive wrapping without exposing diagnostics or retrying", async () => {
  for (const code of contractCodes) {
    const wrapped = new Error("private", { cause: fail(code) });
    assert.equal(isRuntimeIncompatible(wrapped), true, code);
    const error = runtimeStageError("runtime_acquire", wrapped);
    assert.equal(error.code, "RUNTIME_INCOMPATIBLE");
    assert.equal(runtimeStageFromError(error), "runtime_acquire");
    assert.equal(runtimeStageFromError(runtimeStageError("rpc_initialize", error)), "runtime_acquire");
    assert.equal(error.message.includes("private"), false);
    assert.equal(isRetryablePreTurnStageError(error), false);
    const binding = { id: code, runtime: "pi", enabled: true };
    const cache = createRuntimeSupportFacts({ discover: async () => { throw wrapped; } });
    const facts = await cache.read(binding, {});
    assert.notEqual(facts.installed, false);
    assert.deepEqual(supports({ binding, facts }), { supported: false, code: "RUNTIME_INCOMPATIBLE" });
  }
  for (const code of ["REQUEST_TIMEOUT", "AUTH_REQUIRED", "PI_RPC_CLOSED", "ANTIGRAVITY_NETWORK_UNAVAILABLE",
    "PI_AUTH_STATUS_UNAVAILABLE", "PI_BINARY_NOT_FOUND", "RUNTIME_MODEL_CATALOG_INVALID"]) {
    assert.equal(isRuntimeIncompatible(fail(code)), false, code);
  }
  assert.equal(isRuntimeIncompatible({ get code() { throw Error("must not invoke getters"); } }), false);
});

test("native account readiness requires protocol, auth and catalog proof; recheck recovers without changing user intent", async () => {
  const accounts = DEFAULT_RUNTIME_ACCOUNTS.filter(account => account.kind === "native-user");
  let piFailure = true;
  const calls = [];
  const backend = new ShoggothBackend({ paths: {}, runtimeCliAuth: accounts.map(account => ({
    runtime: account.runtime, runtimeAccountId: account.id, name: account.runtime,
    binaryPath: `/fixture/${account.runtime}`, accountHome: "/fixture/home", processHome: "/fixture/home",
    homeEnv: null, accountKind: "native-user", credentialProbe: "runtime", credentialFile: null,
    loginArgs: [], logoutArgs: [], docsUrl: "https://example.invalid/", unavailableReason: "missing",
  })) });
  backend.getStatus = async () => ({ connected: true });
  backend._profilesByAgent = new Map(accounts.map(account => [account.id, {
    id: account.id, agentId: account.id, name: account.runtime, runtime: account.runtime,
    runtimeAccountId: account.id, providerRef: null,
  }]));
  backend._call = async (method, input) => {
    calls.push([method, input.profileId]);
    const runtime = accounts.find(account => account.id === input.profileId).runtime;
    if ((runtime === "pi" && piFailure) || runtime === "antigravity") throw fail("RUNTIME_INCOMPATIBLE");
    if (runtime === "deepseek-harness") throw fail("REQUEST_TIMEOUT");
    if (method === "profile.auth.read") return { status: runtime === "grok-build" ? "unverified"
      : runtime === "opencode" ? "unauthenticated" : "authenticated" };
    assert.equal(method, "profile.models.list");
    assert.equal(input.limit, 1);
    return { models: [{ id: "model" }], nextCursor: null };
  };
  const rows = await backend.getRuntimeStatuses();
  const row = runtime => rows.find(item => item.runtime === runtime);
  assert.equal(rows.length, 7);
  assert.equal(row("codex").readiness, "ready");
  assert.equal(row("pi").readiness, "incompatible");
  assert.equal(row("grok-build").readiness, "unverified");
  assert.equal(row("deepseek-harness").readiness, "unverified");
  assert.equal(row("opencode").readiness, "auth-required");
  assert.equal(row("claude-code").releaseEnabled, false);
  assert.ok(!calls.some(([, id]) => id.includes("claude")));
  const piId = row("pi").runtimeAccountId;
  assert.deepEqual(backend._bindingAvailability("", "pi", piId), { available: false, reason: "runtime-incompatible" });
  assert.throws(() => backend._assertRuntimeEnabled({ runtime: "pi", runtimeAccountId: piId }), { code: "RUNTIME_INCOMPATIBLE" });
  const provider = (await backend.listOAuthProviders()).providers.find(item => item.id === piId);
  assert.equal(provider.status.loggedIn, false);
  assert.equal(provider.status.verification, "incompatible");
  assert.equal(provider.connection.enabled, true, "saved intent is not silently changed");
  assert.equal(JSON.stringify(provider).includes("/private/secret"), false);
  piFailure = false;
  assert.equal((await backend.getRuntimeStatuses()).find(item => item.runtime === "pi").readiness, "ready");
  assert.equal(backend._bindingAvailability("", "pi", piId).available, true);
  backend._generation++;
  assert.equal(backend._runtimeReadinessFor(piId), "unverified", "old Service proof cannot survive a generation change");
  backend._profilesByAgent.clear();
  assert.ok((await backend.getRuntimeStatuses()).every(item => item.readiness === "unverified"));
});
