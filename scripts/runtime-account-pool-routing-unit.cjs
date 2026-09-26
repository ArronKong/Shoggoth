#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  DEFAULT_RUNTIME_ACCOUNTS,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const {
  CodexRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "codex-runtime-pool.js"));
const {
  GrokBuildRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "grok-build-runtime-pool.js"));
const {
  AntigravityRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "antigravity-runtime-pool.js"));
const {
  PiRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "pi-runtime-pool.js"));
const {
  ClaudeCodeRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "claude-code-runtime-pool.js"));
const {
  DeepSeekHarnessRuntimePool,
} = require(path.join(ROOT, "app", "agent-service", "deepseek-harness-runtime-pool.js"));

const ACCOUNT_BY_RUNTIME = new Map(
  DEFAULT_RUNTIME_ACCOUNTS.filter((account) => account.kind === "native-user")
    .map((account) => [account.runtime, account]),
);
const POOLS = new Map([
  ["codex", CodexRuntimePool],
  ["grok-build", GrokBuildRuntimePool],
  ["antigravity", AntigravityRuntimePool],
  ["pi", PiRuntimePool],
  ["claude-code", ClaudeCodeRuntimePool],
  ["deepseek-harness", DeepSeekHarnessRuntimePool],
]);

function binding(runtime, runtimeProfileId, runtimeAccountId) {
  return { runtime, runtimeProfileId, runtimeAccountId };
}

function environmentFor(value) {
  const userHome = "/tmp/shoggoth-native-user-home";
  const nativeHome = `${userHome}/.${value.runtime}`;
  const accountHome = `/tmp/shoggoth-runtime-account/${value.runtimeAccountId}`;
  const home = value.runtime === "antigravity" ? accountHome : nativeHome;
  const homeKey = {
    codex: "CODEX_HOME",
    "grok-build": "GROK_HOME",
    antigravity: "HOME",
    pi: "PI_CODING_AGENT_DIR",
    "claude-code": "CLAUDE_CONFIG_DIR",
    "deepseek-harness": "DSH_HOME",
  }[value.runtime];
  const spawnEnv = { HOME: value.runtime === "antigravity" ? home : userHome };
  spawnEnv[homeKey] = home;
  return Object.freeze({
    runtime: value.runtime,
    runtimeAccountId: value.runtimeAccountId,
    kind: "native-user",
    installationKind: "system",
    homeKind: "system-default",
    strategy: value.runtime === "antigravity" ? "account-integration"
      : value.runtime === "deepseek-harness" ? "native-with-account-integration" : "native",
    home,
    nativeHome,
    integrationRoot: value.runtime === "antigravity" ? path.dirname(home) : null,
    binaryPath: "/tmp/shoggoth-runtime-binary",
    launchArgs: Object.freeze(value.runtime === "codex"
      ? ["-c", "check_for_update_on_startup=false", "app-server", "--stdio"] : []),
    spawnEnv: Object.freeze(spawnEnv),
    configurationMode: value.runtime === "codex" ? "overlay"
      : value.runtime === "antigravity" || value.runtime === "deepseek-harness"
        ? "integration" : "native",
  });
}

function never() { return new Promise(() => {}); }

async function exercisePool(runtime, Pool) {
  const account = ACCOUNT_BY_RUNTIME.get(runtime);
  const resolved = [];
  const created = [];
  const lookup = [];
  const runtimeAccountLookup = (runtimeAccountId) => {
    lookup.push(runtimeAccountId);
    return DEFAULT_RUNTIME_ACCOUNTS.find((item) => item.id === runtimeAccountId) || null;
  };
  const runtimeAccountResolver = {
    resolve(value, accountRecord) {
      assert.equal(accountRecord.id, value.runtimeAccountId);
      resolved.push(value);
      return environmentFor(value);
    },
  };
  const hostFactory = (options) => {
    const host = {
      options,
      terminated: never(),
      cleanupIncomplete: false,
      initializeCalls: 0,
      beginAcquireCalls: 0,
      stopCalls: 0,
      async initialize() { this.initializeCalls += 1; return this; },
      beginAcquire() { this.beginAcquireCalls += 1; },
      async stop() { this.stopCalls += 1; },
    };
    created.push(host);
    return host;
  };
  const pool = new Pool({
    runtimeAccountLookup,
    runtimeAccountResolver,
    hostFactory,
    maxHosts: 8,
  });
  const firstBinding = binding(runtime, "profile-one", account.id);
  const secondBinding = binding(runtime, "profile-two", account.id);
  const first = await pool.get(firstBinding);
  const reused = await pool.get(firstBinding);
  const second = await pool.get(secondBinding);

  assert.equal(first, reused);
  assert.notEqual(first, second);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0].options.runtimeBinding, firstBinding);
  assert.equal(created[0].options.runtimeAccountId, account.id);
  assert.equal(created[0].options.runtimeEnvironment.home, created[1].options.runtimeEnvironment.home);
  assert.deepEqual(lookup, [account.id, account.id]);
  assert.deepEqual(resolved, [firstBinding, secondBinding]);
  if (runtime !== "codex") assert.equal(first.beginAcquireCalls, 1);
  if (["antigravity", "pi", "claude-code", "deepseek-harness"].includes(runtime)) {
    assert.equal(created[0].options.profileState, created[1].options.profileState);
  }

  await assert.rejects(
    () => pool.get(binding(runtime, "profile-one", "another-account-v1")),
    (error) => error.code === "RUNTIME_ACCOUNT_BINDING_CONFLICT",
  );
  await pool.stop("profile-one");
  assert.equal(first.stopCalls, 1);
  assert.equal(second.stopCalls, 0);
  assert.equal(pool.entries.size, 1);
  await pool.stopAll();
  assert.equal(second.stopCalls, 1);
  assert.equal(pool.entries.size, 0);
}

(async () => {
  for (const [runtime, Pool] of POOLS) {
    await exercisePool(runtime, Pool);
    console.log(`PASS ${runtime} RuntimeAccount pool routing`);
  }
  console.log(`PASS runtime account pool routing (${POOLS.size})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
