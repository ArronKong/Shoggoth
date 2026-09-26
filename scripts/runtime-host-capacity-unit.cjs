#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { DEFAULT_MAX_HOSTS, HARD_MAX_HOSTS } = require("../app/agent-service/runtime-pool-capacity");
const { PiRuntimePool } = require("../app/agent-service/pi-runtime-pool");
const { DeepSeekHarnessRuntimePool } = require("../app/agent-service/deepseek-harness-runtime-pool");
const { GrokBuildRuntimePool } = require("../app/agent-service/grok-build-runtime-pool");
const { AntigravityRuntimePool } = require("../app/agent-service/antigravity-runtime-pool");
const { ClaudeCodeRuntimePool } = require("../app/agent-service/claude-code-runtime-pool");
const pools = [
  ["pi", PiRuntimePool], ["deepseek-harness", DeepSeekHarnessRuntimePool],
  ["grok-build", GrokBuildRuntimePool], ["antigravity", AntigravityRuntimePool],
  ["claude-code", ClaudeCodeRuntimePool],
];
const capacity = { code: "RUNTIME_HOST_CAPACITY" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(runtime, Pool, options = {}) {
  const hosts = [];
  const account = DEFAULT_RUNTIME_ACCOUNTS.find(value => value.runtime === runtime);
  const binding = id => ({ runtime, runtimeProfileId: id, runtimeAccountId: account.id });
  const homeKey = { pi: "PI_CODING_AGENT_DIR", "grok-build": "GROK_HOME", antigravity: "HOME",
    "claude-code": "CLAUDE_CONFIG_DIR", "deepseek-harness": "DSH_HOME" }[runtime];
  const environment = value => Object.freeze({
    runtime, runtimeAccountId: value.runtimeAccountId, kind: "native-user",
    installationKind: "system", homeKind: "system-default", home: "/tmp/fixture-home",
    nativeHome: "/tmp/fixture-home", integrationRoot: null,
    strategy: "native", binaryPath: "/tmp/fixture-binary", launchArgs: Object.freeze([]),
    spawnEnv: Object.freeze({ HOME: "/tmp/fixture-home", [homeKey]: "/tmp/fixture-home" }),
    configurationMode: ["antigravity", "deepseek-harness"].includes(runtime) ? "integration" : "native",
  });
  const pool = new Pool({
    runtimeAccountLookup: id => id === account.id ? account : null,
    runtimeAccountResolver: { resolve: environment },
    canRetireHost: () => true,
    hostFactory(hostOptions) {
      const host = {
        options: hostOptions, stopped: 0, idle: false, gate: null, stopGate: null,
        terminated: new Promise(() => {}),
        async initialize() { return this; }, beginAcquire() {},
        canRetireIdle() { return this.idle; },
        async modelsList() { if (this.gate) await this.gate.promise; return []; },
        async stop() { this.stopped += 1; if (this.stopGate) await this.stopGate.promise; },
      };
      hosts.push(host); return host;
    },
    ...options,
  });
  return { pool, hosts, binding, get: (id, workspace = `/tmp/${id}`) => pool.get(binding(id), { workspace }) };
}

for (const [runtime, Pool] of pools) {
  test(`${runtime}: 100 execution hosts plus 16 control hosts fit; the next is capacity-blocked`, async () => {
    const f = fixture(runtime, Pool);
    assert.equal(f.pool.maxHosts, DEFAULT_MAX_HOSTS);
    for (let i = 0; i < 16; i += 1) await f.pool.get(f.binding(`control-${i}`));
    for (let i = 0; i < 100; i += 1) await f.get(`run-${i}`);
    assert.equal(f.pool.entries.size, 116);
    await assert.rejects(f.get("overflow"), capacity);
    f.hosts[0].idle = true;
    await f.get("replacement");
    assert.equal(f.pool.entries.size, 116);
    assert.equal(f.hosts[0].stopped, 1);
    assert.equal(f.hosts.slice(1).some(host => host.stopped), false);
    await f.pool.stopAll();
  });

  test(`${runtime}: dynamic reduction preserves existing hosts and requires both idle proofs`, async () => {
    let limit = 2;
    let authorityIdle = false;
    const f = fixture(runtime, Pool, { resolveMaxHosts: () => limit, canRetireHost: () => authorityIdle });
    const first = await f.get("same-profile", "/tmp/one");
    const second = await f.get("same-profile", "/tmp/two");
    first.idle = true;
    limit = 1;
    assert.equal(await f.get("same-profile", "/tmp/two"), second);
    await assert.rejects(f.get("new-profile"), capacity);
    assert.equal(first.stopped, 0);
    authorityIdle = true;
    // Retire only the idle workspace, then keep the active sibling alive.
    await assert.rejects(f.get("new-profile"), capacity);
    assert.equal(first.stopped, 1);
    assert.equal(second.stopped, 0);
    second.idle = true;
    await f.get("new-profile");
    assert.equal(second.stopped, 1);
    await f.pool.stopAll();
    assert.throws(() => fixture(runtime, Pool, { maxHosts: HARD_MAX_HOSTS + 1 }));
  });

  test(`${runtime}: async I/O and cleanup hold slots; concurrent requests cannot exceed the limit`, async () => {
    const f = fixture(runtime, Pool, { maxHosts: 1 });
    const first = await f.get("first");
    first.idle = true;
    first.gate = deferred();
    const io = first.modelsList();
    await assert.rejects(f.get("second"), capacity);
    assert.equal(first.stopped, 0);
    first.gate.resolve(); await io;
    first.stopGate = deferred();
    const next = f.get("second");
    await Promise.resolve();
    assert.equal(f.pool.entries.size, 1);
    assert.throws(() => first.modelsList(), capacity);
    const third = f.get("third");
    first.stopGate.resolve();
    const outcomes = await Promise.allSettled([next, third]);
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(f.pool.entries.size, 1);
    await f.pool.stopAll();
  });
}

test("native Host idle predicates refuse active turns, control work, pending RPC and approvals", () => {
  const specs = [
    ["pi", "PiRuntimeHost", { activeTurns: new Map(), turnProcesses: new Map(), controlProcesses: new Map() }, "turnProcesses"],
    ["claude-code", "ClaudeCodeRuntimeHost", { activeTurns: new Map(), controlProcesses: new Map(), controlQueries: new Set() }, "controlQueries"],
    ["antigravity", "AntigravityRuntimeHost", { activeTurns: new Map(), controlProcesses: new Map(), controlRequests: new Map() }, "controlRequests"],
  ];
  for (const [runtime, name, fields, field] of specs) {
    const Host = require(path.join("..", "app", "agent-service", `${runtime}-runtime-host`))[name];
    const host = Object.assign(Object.create(Host.prototype), fields, { state: "ready", cleanupIncomplete: false, stopping: null });
    assert.equal(host.canRetireIdle(), true);
    host.activeTurns.set("approval", {}); assert.equal(host.canRetireIdle(), false); host.activeTurns.clear();
    if (host[field] instanceof Set) host[field].add("work"); else host[field].set("work", {});
    assert.equal(host.canRetireIdle(), false);
  }
  for (const [runtime, name, transport] of [
    ["deepseek-harness", "DeepSeekHarnessRuntimeHost", "process"],
    ["grok-build", "GrokBuildRuntimeHost", "rpc"],
  ]) {
    const Host = require(path.join("..", "app", "agent-service", `${runtime}-runtime-host`))[name];
    const child = { stdin: { writableLength: 0 } };
    const rpc = { pending: new Map(), activeServerRequests: 0, activeServerRequestIds: new Set(), child, closed: false, ended: false };
    const host = Object.assign(Object.create(Host.prototype), { state: "ready", activeTurns: new Map(), child, [transport]: rpc });
    assert.equal(host.canRetireIdle(), true);
    rpc.pending.set("rpc", {}); assert.equal(host.canRetireIdle(), false); rpc.pending.clear();
    rpc.activeServerRequests = 1; rpc.activeServerRequestIds.add("approval");
    assert.equal(host.canRetireIdle(), false);
  }
});
