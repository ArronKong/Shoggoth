"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { validateDefinition } = require("../app/agent-service/hook-contract");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");
const crypto = require("node:crypto");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createProductHostController } = require("../app/product-host-controller");
const { createLaunchAgentController, LAUNCH_AGENT_LABEL } = require("../app/agent-service/launch-agent");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const VERSION = "storage-recovery-fixture";
function fixturePaths() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-disk-recovery-")));
  fs.chmodSync(root, 0o700);
  return { root, paths: resolveServicePaths({ trustedRoot: root, homeDir: path.join(root, "home"),
    stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") }) };
}
function serviceFor(paths, options = {}) {
  return createAgentService({ paths, version: VERSION, ...options,
    cryptoBroker: { async open() {}, async close() {},
      async encrypt(value) { return Buffer.from(value); }, async decrypt(value) { return Buffer.from(value); } },
    nativeMemorySemanticService: { async start() {}, async close() {}, scheduleMemory() {}, invalidateProfile() {} },
  });
}
function call(paths, method, params = {}, token = readClientToken(paths)) {
  return requestService(paths, { id: "disk-recovery-probe", token, version: PROTOCOL_VERSION, method, params },
    { timeoutMs: 2_000 });
}

test("真实 Hook SQLite 写满后阻止新任务，Host 只冷重启一次并恢复同一会话聊天", async () => {
  const { root, paths } = fixturePaths();
  const host = new InspirationRuntime();
  const options = { autoSparkNotes: false,
    runtimePool: { async get() { return host; }, async stopAll() {} } };
  let service = serviceFor(paths, options);
  try {
    await service.start();
    const sessions = await call(paths, "chat.session.list", {
      profileId: DEFAULT_AGENT_PROFILE_ID, includeArchived: false, cursor: null, limit: 20,
    });
    const command = { operationId: crypto.randomUUID(), sessionKey: sessions.sessions[0].sessionKey,
      prompt: "isolated recovered chat", createdAt: Date.now() };
    const beforeRuns = service.workDispatcher.listRuns().length;
    const beforeSnapshots = service.hookStore.db.prepare("SELECT count(*) AS n FROM snapshots").get().n;
    const pages = service.hookStore.db.prepare("PRAGMA page_count").get().page_count;
    service.hookStore.db.exec("PRAGMA max_page_count=" + pages);
    const definition = validateDefinition({ schemaVersion: 1, name: "isolated capacity fixture",
      event: "tool.before", kind: "guard", scope: { workspace: "profile", sources: ["chat"] },
      matcher: { toolScopes: ["product"], toolNames: ["business_tool"] },
      handler: { type: "script", language: "javascript",
        source: "module.exports=()=>({decision:'allow'});/*" + "x".repeat(100000) + "*/" },
    }, null);
    assert.throws(() => service.hookStore.register(DEFAULT_AGENT_PROFILE_ID, crypto.randomUUID(), definition),
      error => error.errcode === 13 || error.code === "SQLITE_FULL");
    assert.equal(service.hookStore.poisoned, true);
    assert.throws(() => service.hookStore.list(DEFAULT_AGENT_PROFILE_ID), { code: "HOOK_UNAVAILABLE" });
    await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
    await assert.rejects(call(paths, "chat.send", command), { code: "SERVICE_RECOVERY_REQUIRED" });
    assert.equal(service.workDispatcher.listRuns().length, beforeRuns);
    assert.equal(service.hookStore.db.prepare("SELECT count(*) AS n FROM snapshots").get().n, beforeSnapshots);
    assert.equal(host.turnStarts, 0);
    const diagnostic = JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "service-recovery.json"), "utf8"));
    assert.equal(diagnostic.component, "hook-store");
    assert.equal(diagnostic.errorCode, "HOOK_UNAVAILABLE");
    assert.equal(diagnostic.causeCode, "SQLITE_FULL");
    assert.ok(!JSON.stringify(diagnostic).includes("isolated"));
    let restarts = 0;
    const controller = createProductHostController({ serviceRequest: method => call(paths, method), launchAgent: {
      async status() { return { supported: true, installed: true, loaded: true, enabled: true, needsRepair: false }; },
      async start() {
        restarts += 1;
        await service.stop({ notify: false });
        service = serviceFor(paths, options);
        await service.start();
      },
    } });
    await controller.ensureBackgroundRunning();
    await controller.ensureBackgroundRunning();
    assert.equal(restarts, 1);
    assert.equal((await call(paths, "service.status")).healthy, true);
    assert.equal(service.hookStore.list(DEFAULT_AGENT_PROFILE_ID).items.length, 0);
    const accepted = await call(paths, "chat.send", command);
    const waitFor = async status => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const run = service.workDispatcher.getRun(accepted.run.id);
        assert.ok(!["failed", "interrupted", "canceled"].includes(run.status), JSON.stringify(run));
        if (run.status === status) return run;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("recovered Hook chat fixture timed out");
    };
    const run = await waitFor("running");
    assert.ok(service.hookStore.snapshotForRun(run.id));
    host.complete(run, "isolated fixture completed");
    await waitFor("completed");
    assert.equal(host.turnStarts, 1);
    assert.equal(fs.readFileSync(path.join(paths.runtimeDir, "service-recovery.json"), "utf8"), `${JSON.stringify(diagnostic)}\n`);
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const state of ["closed", "missing writer lease"]) {
  test(`Hook Store ${state} 拒绝伪健康与新聊天，保留停止入口`, async () => {
    const { root, paths } = fixturePaths();
    const service = serviceFor(paths);
    let heldLease;
    try {
      await service.start();
      const sessions = await call(paths, "chat.session.list", {
        profileId: DEFAULT_AGENT_PROFILE_ID, includeArchived: false, cursor: null, limit: 20,
      });
      const beforeRuns = service.workDispatcher.listRuns().length;
      if (state === "closed") service.hookStore.close();
      else { heldLease = service.hookStore.lease; service.hookStore.lease = null; }
      await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
      await assert.rejects(call(paths, "chat.send", { operationId: crypto.randomUUID(),
        sessionKey: sessions.sessions[0].sessionKey, prompt: "isolated fixture", createdAt: Date.now(),
      }), { code: "SERVICE_RECOVERY_REQUIRED" });
      assert.equal(service.workDispatcher.listRuns().length, beforeRuns);
      await call(paths, "service.hello");
      await call(paths, "service.stopImpact");
      const diagnostic = JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "service-recovery.json"), "utf8"));
      assert.equal(diagnostic.component, "hook-store");
      assert.equal(diagnostic.errorCode, "HOOK_UNAVAILABLE");
      assert.equal(diagnostic.causeCode, null);
    } finally {
      if (heldLease) service.hookStore.lease = heldLease;
      await service.stop({ notify: false });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const method of ["writeSync", "fsyncSync"]) {
  test(`真实 IPC：一次 ${method} ENOSPC 后拒绝伪健康，App 重开后冷回放恢复`, async () => {
    const { root, paths } = fixturePaths();
    let failOnce = false;
    const injectedFs = new Proxy(fs, { get(target, key) {
      if (key !== method) return Reflect.get(target, key);
      return (...args) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("private-disk-path-and-secret-canary"), { code: "ENOSPC" });
        }
        return target[method](...args);
      };
    } });
    const productStore = new JsonlProductStore({ paths, fs: injectedFs });
    let service = serviceFor(paths, { productStore });
    try {
      await service.start();
      assert.equal((await call(paths, "service.status")).healthy, true);
      const before = productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
      failOnce = true;
      assert.throws(() => productStore.putAgentProfile({ ...before, name: "uncertain update" }),
        { code: "STORE_COMMIT_UNCERTAIN" });
      await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
      await assert.rejects(call(paths, "profile.list", { backendId: "shoggoth", enabledOnly: false, cursor: null, limit: 100 }),
        { code: "SERVICE_RECOVERY_REQUIRED" });
      await assert.rejects(call(paths, "service.status", {}, "wrong-token"), { code: "AUTH_FAILED" });
      const diagnosticPath = path.join(paths.runtimeDir, "service-recovery.json");
      const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, "utf8"));
      assert.equal(diagnostic.component, "product-store");
      assert.equal(diagnostic.errorCode, "STORE_COMMIT_UNCERTAIN");
      assert.equal(diagnostic.causeCode, "ENOSPC");
      assert.equal(fs.statSync(diagnosticPath).mode & 0o777, 0o600);
      assert.ok(!JSON.stringify(diagnostic).includes("canary"));
      assert.ok(fs.statSync(diagnosticPath).size < 1_024);
      await call(paths, "service.status").catch(() => {});
      assert.equal(fs.readFileSync(diagnosticPath, "utf8"), `${JSON.stringify(diagnostic)}\n`);
      let restartCalls = 0;
      const host = createProductHostController({ serviceRequest: method => call(paths, method), launchAgent: {
        async status() { return { supported: true, installed: true, loaded: true, enabled: true, needsRepair: false }; },
        async start() {
          restartCalls += 1;
          await service.stop({ notify: false });
          service = serviceFor(paths);
          await service.start();
        },
      } });
      await host.ensureBackgroundRunning();
      await host.ensureBackgroundRunning();
      assert.equal(restartCalls, 1);
      assert.equal((await call(paths, "service.status")).healthy, true);
      const recovered = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
      assert.equal(recovered.name, method === "writeSync" ? before.name : "uncertain update");
      service.productStore.putAgentProfile({ ...recovered, name: "after cold replay" });
      assert.equal(service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID).name, "after cold replay");
      assert.equal(fs.readFileSync(diagnosticPath, "utf8"), `${JSON.stringify(diagnostic)}\n`);
    } finally {
      await service.stop({ notify: false });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("各共享存储及 Coordinator 的失效都进入恢复门禁，凭据暂时锁定不触发重启", async () => {
  const { root, paths } = fixturePaths();
  const service = serviceFor(paths);
  try {
    await service.start();
    const locked = service.pendingCommandInbox.isLocked;
    service.pendingCommandInbox.isLocked = () => true;
    assert.equal((await call(paths, "service.status")).healthy, true);
    service.pendingCommandInbox.isLocked = locked;
    for (const [target, property] of [
      [service.transcriptStore, "poisonError"], [service.chatSessionStore, "commitUncertain"],
      [service.pendingCommandInbox, "commitUncertain"], [service.workRunCoordinator, "poisonError"],
    ]) {
      const before = target[property];
      // Test-only marker injection; production always recovers through a cold reopen.
      target[property] = property === "commitUncertain" ? true : new Error("private-canary");
      await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
      if (target === service.transcriptStore) await call(paths, "service.stopImpact");
      target[property] = before;
      assert.equal((await call(paths, "service.status")).healthy, true);
    }
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const method of ["writeSync", "fsyncSync"]) {
  test(`Transcript ${method} ENOSPC 阻止跨 Agent 写入，冷回放不重复记录`, async () => {
    const { root, paths } = fixturePaths();
    let failOnce = false;
    const injectedFs = new Proxy(fs, { get(target, key) {
      if (key !== method) return Reflect.get(target, key);
      return (...args) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error("private-canary"), { code: "ENOSPC" });
        }
        return target[method](...args);
      };
    } });
    const transcriptStore = new TranscriptStore({ paths, fs: injectedFs });
    let service = serviceFor(paths, { transcriptStore });
    const append = (store, id, profileId = DEFAULT_AGENT_PROFILE_ID) => store.appendEvent({
      profileId, sessionId: "probe-session", id, runId: "probe-run", kind: "user",
      content: { text: id }, runtimeRef: null,
    });
    try {
      await service.start();
      append(transcriptStore, "before");
      failOnce = true;
      assert.throws(() => append(transcriptStore, "uncertain"), { code: "TRANSCRIPT_COMMIT_UNCERTAIN" });
      assert.throws(() => append(transcriptStore, "blocked", "another-agent"), { code: "TRANSCRIPT_COMMIT_UNCERTAIN" });
      await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED", systemIssue: "STORAGE_FULL" });
      const diagnostic = JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "service-recovery.json"), "utf8"));
      assert.equal(diagnostic.component, "transcript-store");
      assert.equal(diagnostic.causeCode, "ENOSPC");
      await service.stop({ notify: false });
      service = serviceFor(paths);
      await service.start();
      assert.equal((await call(paths, "service.status")).healthy, true);
      const recovered = service.transcriptStore.listEvents(DEFAULT_AGENT_PROFILE_ID, "probe-session");
      assert.deepEqual(recovered.map(event => event.id), method === "writeSync" ? ["before"] : ["before", "uncertain"]);
      append(service.transcriptStore, "after-replay");
      append(service.transcriptStore, "other-agent-recovered", "another-agent");
      const final = service.transcriptStore.listEvents(DEFAULT_AGENT_PROFILE_ID, "probe-session");
      assert.equal(new Set(final.map(event => event.id)).size, final.length);
      assert.deepEqual(final.map(event => event.seq), final.map((_, index) => index + 1));
    } finally {
      await service.stop({ notify: false });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("诊断写入失败不掩盖恢复门禁，恢复写入后只保存安全代码且不触发 getter", async () => {
  const { root, paths } = fixturePaths();
  const service = serviceFor(paths);
  try {
    await service.start();
    let getterCalls = 0;
    const error = Object.defineProperties(new Error("private-canary"), {
      code: { get() { getterCalls += 1; throw new Error("private-canary"); } },
      cause: { get() { getterCalls += 1; throw new Error("private-canary"); } },
    });
    const diagnosticPath = path.join(paths.runtimeDir, "service-recovery.json");
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, diagnosticPath);
    service.transcriptStore.poisonError = error;
    await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
    assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
    fs.unlinkSync(diagnosticPath);
    await assert.rejects(call(paths, "service.status"), { code: "SERVICE_RECOVERY_REQUIRED" });
    assert.equal(getterCalls, 0);
    const record = JSON.parse(fs.readFileSync(diagnosticPath, "utf8"));
    assert.equal(record.causeCode, null);
    assert.equal(record.errorCode, "TRANSCRIPT_COMMIT_UNCERTAIN");
    assert.ok(!JSON.stringify(record).includes("private-canary"));
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function launchFixture() {
  const { root } = fixturePaths();
  const homeDir = path.join(root, "home");
  const applicationsRoot = path.join(root, "Applications");
  const appPath = path.join(applicationsRoot, "Shoggoth.app");
  const executablePath = path.join(appPath, "Contents/MacOS/Shoggoth");
  const resourcesPath = path.join(appPath, "Contents/Resources");
  const bootstrapPath = path.join(resourcesPath, "app.asar/app/bootstrap.js");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executablePath, "fixture");
  fs.writeFileSync(path.join(resourcesPath, "app.asar"), "fixture");
  const state = { loaded: false, enabled: false, poisoned: false, poisonAfterBootstrap: false,
    timeoutOnce: false, hostileOnce: false, getterCalls: 0, clock: 0 };
  const mutations = [];
  const healthy = () => ({ healthy: true, protocolVersion: PROTOCOL_VERSION, serviceVersion: VERSION });
  const controller = createLaunchAgentController({ platform: "darwin", homeDir, applicationsRoot, uid: 501,
    appPath, executablePath, resourcesPath, bootstrapPath, serviceVersion: VERSION,
    resolveProxyEnvironment: () => ({}), clearExtendedAttributes() {},
    healthNow: () => state.clock, healthDelay: async ms => { state.clock += ms; },
    healthProbe: async () => {
      if (state.hostileOnce) {
        state.hostileOnce = false;
        throw Object.defineProperty(new Error("private-canary"), "code", {
          get() { state.getterCalls += 1; throw new Error("must not read getter"); },
        });
      }
      if (state.timeoutOnce) {
        state.timeoutOnce = false;
        throw Object.assign(new Error("temporary"), { code: "REQUEST_TIMEOUT" });
      }
      if (state.poisoned) throw Object.assign(new Error("fixed public message"), { code: "SERVICE_RECOVERY_REQUIRED" });
      return healthy();
    },
    runner: async (_command, args) => {
      const action = args[0];
      if (action === "print-disabled") return { code: 0, stdout: `"${LAUNCH_AGENT_LABEL}" => ${!state.enabled}\n` };
      if (action === "print") {
        if (state.loaded) return { code: 0, stdout: `program = ${executablePath}\n` };
        throw Object.assign(new Error("absent"), { stderr: `Could not find service ${LAUNCH_AGENT_LABEL}` });
      }
      mutations.push(action);
      if (action === "enable") state.enabled = true;
      if (action === "disable") state.enabled = false;
      if (action === "bootout") state.loaded = false;
      if (action === "bootstrap") { state.loaded = true; state.poisoned = state.poisonAfterBootstrap; }
      return { code: 0 };
    },
  });
  return { root, state, mutations, controller };
}

test("LaunchAgent 对明确失效立即重注册一次，普通超时或 hostile error 仍等待", async () => {
  const value = launchFixture();
  try {
    await value.controller.start();
    value.mutations.length = 0;
    value.state.poisoned = true;
    await value.controller.start();
    assert.deepEqual(value.mutations, ["disable", "bootout", "enable", "bootstrap"]);
    assert.equal(value.state.clock, 0, "明确失效不能再等完整 loaded grace");
    value.mutations.length = 0;
    value.state.timeoutOnce = true;
    await value.controller.start();
    assert.deepEqual(value.mutations, []);
    assert.ok(value.state.clock > 0, "暂时超时仍按既有节拍等待");
    value.state.hostileOnce = true;
    await value.controller.start();
    assert.equal(value.state.getterCalls, 0);
    assert.deepEqual(value.mutations, []);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("重新启动后仍失效则停止恢复，不反复重启", async () => {
  const value = launchFixture();
  try {
    await value.controller.start();
    value.mutations.length = 0;
    value.state.poisoned = true;
    value.state.poisonAfterBootstrap = true;
    await assert.rejects(value.controller.start(), { code: "SERVICE_HEALTH_NOT_CONFIRMED" });
    assert.deepEqual(value.mutations, ["disable", "bootout", "enable", "bootstrap"]);
    assert.equal(value.state.clock, 0);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS ${tests.length}/${tests.length}; isolated state and IPC; no real launchd or model requests`);
})().catch(error => { console.error(error); process.exitCode = 1; });
