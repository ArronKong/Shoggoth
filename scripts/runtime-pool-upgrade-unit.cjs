"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { RuntimeExecutableIdentity } = require("../app/agent-service/runtime-executable-identity");
const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
const pools = [
  ["codex", "CodexRuntimePool"], ["grok-build", "GrokBuildRuntimePool"], ["pi", "PiRuntimePool"],
  ["antigravity", "AntigravityRuntimePool"], ["claude-code", "ClaudeCodeRuntimePool"],
  ["opencode", "OpenCodeRuntimePool"], ["deepseek-harness", "DeepSeekHarnessRuntimePool"],
];
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, runtime, className) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-pool-upgrade-")));
  const binary = path.join(root, "binary"); fs.writeFileSync(binary, "binary-one");
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const account = DEFAULT_RUNTIME_ACCOUNTS.find(value => value.runtime === runtime && value.kind === "native-user");
  const binding = profile => ({ runtime, runtimeProfileId: profile, runtimeAccountId: account.id });
  const homeKey = { codex: "CODEX_HOME", "grok-build": "GROK_HOME", pi: "PI_CODING_AGENT_DIR", antigravity: "HOME",
    "claude-code": "CLAUDE_CONFIG_DIR", opencode: "XDG_DATA_HOME", "deepseek-harness": "DSH_HOME" }[runtime];
  const environment = value => Object.freeze({ runtime, runtimeAccountId: value.runtimeAccountId,
    kind: "native-user", installationKind: "system", homeKind: "system-default", home: root, nativeHome: root,
    integrationRoot: null, configSourceHome: root, strategy: "native", binaryPath: binary,
    launchArgs: Object.freeze([]), spawnEnv: Object.freeze({ HOME: root, [homeKey]: root }),
    configurationMode: runtime === "codex" ? "overlay" : ["antigravity", "deepseek-harness"].includes(runtime) ? "integration" : "native" });
  const identity = new RuntimeExecutableIdentity(), hosts = [];
  let authorityIdle = true, nextInitializeGate = null;
  const Pool = require(`../app/agent-service/${runtime}-runtime-pool`)[className];
  const pool = new Pool({ runtimeAccountLookup: () => account,
    runtimeAccountResolver: { resolve: environment,
      observeExecutable: () => identity.observe({ binaryPath: binary }), captureExecutable: value => identity.capture(value) },
    canRetireChangedHost: () => authorityIdle,
    hostFactory(options) {
      const terminal = defer(), initializeGate = nextInitializeGate; nextInitializeGate = null;
      const host = { options, profileState: options.profileState, state: "new", stopped: 0, idle: true, stopGate: null,
        runtimeEnvironment: options.runtimeEnvironment, terminated: terminal.promise,
        async initialize() { if (initializeGate) await initializeGate.promise; this.state = "ready"; return this; },
        beginAcquire() {}, canRetireIdle() { return this.idle; },
        async stop() { this.stopped++; if (this.earlyTerminal) terminal.resolve(); if (this.stopGate) await this.stopGate.promise;
          if (this.failStop) throw new Error("unconfirmed fixture stop"); this.state = "stopped"; terminal.resolve(); },
      };
      hosts.push(host); return host;
    },
  });
  t.after(async () => { await pool.stopAll().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  return { pool, hosts, binary, binding, get: profile => pool.get(binding(profile), { workspace }),
    upgrade: () => fs.writeFileSync(binary, "binary-two"),
    setAuthorityIdle: value => { authorityIdle = value; },
    blockNextInitialize: gate => { nextInitializeGate = gate; } };
}

for (const [runtime, className] of pools) {
  test(`${runtime}: same-path upgrade drains only the selected idle host before one replacement`, async t => {
    const f = fixture(t, runtime, className);
    const first = await f.get("first"), sibling = await f.get("sibling");
    const stamp = f.pool.runtimeIdentityKey(f.binding("first"));
    f.upgrade(); assert.notEqual(f.pool.runtimeIdentityKey(f.binding("first")), stamp);
    const stopGate = defer(); first.stopGate = stopGate;
    const waiting = Promise.all([f.get("first"), f.get("first")]);
    waiting.catch(() => {});
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(first.stopped, 1); assert.equal(f.hosts.length, 2);
      assert.equal(sibling.stopped, 0);
    } finally { stopGate.resolve(); }
    const [a, b] = await waiting;
    assert.equal(a, b); assert.notEqual(a, first); assert.equal(f.hosts.length, 3);
    assert.notEqual(a.runtimeIdentity.stamp, first.runtimeIdentity.stamp);
  });

  test(`${runtime}: active work and an unconfirmed cleanup keep new admission blocked`, async t => {
    const f = fixture(t, runtime, className), first = await f.get("first");
    f.upgrade(); first.idle = false;
    await assert.rejects(f.get("first"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
    assert.equal(first.stopped, 0); assert.equal(f.hosts.length, 1);
    first.idle = true; f.setAuthorityIdle(false);
    await assert.rejects(f.get("first"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
    assert.equal(first.stopped, 0);
    f.setAuthorityIdle(true); first.failStop = true;
    await assert.rejects(f.get("first"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
    await assert.rejects(f.get("first"), { code: "RUNTIME_EXECUTABLE_CHANGED" });
    assert.equal(f.hosts.length, 1); assert.equal(first.stopped, 1);
    first.failStop = false;
  });

  test(`${runtime}: an executable changed during initialization never produces a usable host`, async t => {
    const f = fixture(t, runtime, className), gate = defer();
    f.blockNextInitialize(gate);
    const pending = f.get("first"); const result = Promise.allSettled([pending]);
    while (!f.hosts[0]?.runtimeIdentity) await new Promise(resolve => setImmediate(resolve));
    f.upgrade(); gate.resolve();
    assert.equal((await result)[0].status, "rejected");
    assert.equal(f.hosts[0].stopped, 1);
  });

  test(`${runtime}: an early process terminal cannot remove the pending cleanup fence`, async t => {
    const f = fixture(t, runtime, className), first = await f.get("first"), gate = defer();
    first.earlyTerminal = true; first.stopGate = gate; f.upgrade();
    const replacing = f.get("first"); replacing.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const concurrent = f.get("first"); concurrent.catch(() => {});
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(first.stopped, 1);
      assert.equal(f.hosts.length, 1, "termination notification is not a complete stop receipt");
    } finally { gate.resolve(); }
    assert.equal(await replacing, await concurrent);
    assert.equal(f.hosts.length, 2);
  });

  test(`${runtime}: failed startup cleanup retains a reapable host and blocks replacement`, async t => {
    const f = fixture(t, runtime, className), gate = defer();
    f.blockNextInitialize(gate);
    const starting = f.get("first"), result = Promise.allSettled([starting]);
    while (!f.hosts[0]?.runtimeIdentity) await new Promise(resolve => setImmediate(resolve));
    f.hosts[0].failStop = true; f.upgrade(); gate.resolve();
    assert.equal((await result)[0].status, "rejected");
    assert.equal(f.pool.entries.size, 1, "keep the unconfirmed process reachable for shutdown");
    assert.equal(f.pool.blockedProfiles.has("first"), true);
    await assert.rejects(f.get("first"), error => /CLEANUP_INCOMPLETE/u.test(error.code));
    assert.equal(f.hosts.length, 1);
    f.hosts[0].failStop = false;
    await f.pool.stopAll();
    assert.equal(f.hosts[0].state, "stopped");
  });
}

test("OpenCode model-only acquisition cannot reuse an ordinary execution host or loosen its policy", async t => {
  const f = fixture(t, "opencode", "OpenCodeRuntimePool"), binding = f.binding("model-only");
  const options = { workspace: null, permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } };
  const ordinary = await f.pool.get(binding, options);
  const isolated = await f.pool.get(binding, { ...options, modelOnly: true });
  assert.notEqual(ordinary, isolated); assert.equal(isolated.options.modelOnlyInstance, true);
  assert.equal(await f.pool.get(binding, { ...options, modelOnly: true }), isolated);
  await assert.rejects(f.pool.get(binding, { ...options, modelOnly: true,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" } }), { code: "OPENCODE_PERMISSION_UNSAFE" });
});

test("a stale V1 handle rejects new work while cancellation and original history remain available", async () => {
  let changed = false, starts = 0;
  const binding = { runtime: "grok-build", runtimeProfileId: "fixture", runtimeAccountId: "account" };
  const handle = runtimeHandleV1({ ...binding, capabilities: { "turn.start": true, "turn.interrupt": true, "session.read": true },
    terminated: new Promise(() => {}), subscribe: () => () => {}, host: {
      assertRuntimeIdentityCurrent() { if (changed) throw Object.assign(new Error("changed"), { code: "RUNTIME_EXECUTABLE_CHANGED" }); } },
    turnStart: async () => { starts++; return { turn: { id: "turn" } }; },
    turnInterrupt: async () => ({ interrupted: true }), sessionRead: async () => ({ session: { id: "session" } }),
  }, binding);
  changed = true;
  await assert.rejects(handle.turnStart({ sessionId: "session" }), { code: "RUNTIME_EXECUTABLE_CHANGED" });
  assert.equal(starts, 0);
  assert.deepEqual(await handle.turnInterrupt({ sessionId: "session", turnId: "turn" }), { interrupted: true });
  assert.deepEqual(await handle.sessionRead({ sessionId: "session" }), { session: { id: "session" } });
});
