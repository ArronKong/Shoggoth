"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const asar = require("@electron/asar");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function resolveElectronBinary() {
  try { return require("electron"); } catch {
    const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: ROOT, encoding: "utf8",
    }).trim();
    return require(path.join(path.dirname(path.resolve(ROOT, commonGitDir)), "node_modules", "electron"));
  }
}

const tests = [];
let completedTests = 0;
function test(name, fn) { tests.push({ name, fn }); }

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const bootstrap = require(path.join(ROOT, "app", "bootstrap-role.js"));
const {
  attachAcceptedSocketErrorGuard,
  createAgentService,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} = require(path.join(ROOT, "app", "agent-service", "server.js"));
const { requestService, readClientToken } = require(path.join(ROOT, "app", "agent-service", "client.js"));
const { McpSessionManager, createMcpChallengeProof } = require(path.join(
  ROOT, "app", "agent-service", "mcp-session-manager.js",
));
const { MCP_STDIO_PROTOCOL_VERSION } = require(path.join(
  ROOT, "app", "shoggoth-mcp-helper.js",
));
const { createEventBuffer } = require(path.join(ROOT, "app", "agent-service", "event-buffer.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { CHAT_SESSION_STORE_VERSION } = require(path.join(
  ROOT, "app", "agent-service", "chat-session-store.js",
));
const { PRE_RUNTIME_SCHEMA_BACKUP_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-schema-migration.js",
));
const { PRE_MEMORY_AUTHORITY_BACKUP_ID } = require(path.join(
  ROOT, "app", "agent-service", "memory-migration.js",
));
const { assertStableAppPaths } = require(path.join(
  ROOT, "app", "agent-service", "bundle-paths.js",
));
const {
  acquireInstanceLock,
  defaultProcessIdentity,
} = require(path.join(ROOT, "app", "agent-service", "instance-state.js"));
const {
  DEFAULT_AGENT_PROFILE_ID,
  defaultAgentProfile,
  JsonlProductStore,
} = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const { NativeKanbanStore } = require(path.join(
  ROOT, "app", "agent-service", "native-kanban-store.js",
));
const { KanbanRunService } = require(path.join(
  ROOT, "app", "agent-service", "kanban-run-service.js",
));
const { NativeCronStore } = require(path.join(
  ROOT, "app", "agent-service", "native-cron-store.js",
));
const { NativeCronScheduler } = require(path.join(
  ROOT, "app", "agent-service", "native-cron-scheduler.js",
));
const { DomainWorkRunExecutor } = require(path.join(
  ROOT, "app", "agent-service", "domain-work-run-executor.js",
));
const { startAgentServiceProcess } = require(path.join(ROOT, "app", "agent-service.js"));
const {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  createLaunchAgentController,
  normalizeLaunchAgentProxyEnvironment,
  parseMacSystemProxyOutput,
} = require(path.join(ROOT, "app", "agent-service", "launch-agent.js"));

test("LaunchAgent 默认给代码身份校验留出 45 秒健康确认预算", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "app", "agent-service", "launch-agent.js"),
    "utf8",
  );
  assert.match(source, /const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;/);
  assert.match(
    source,
    /options\.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 1, 45_000, "healthTimeoutMs"/,
  );
});

test("LaunchAgent 同步拒绝非法健康预算与时钟，避免无界等待或零间隔忙循环", () => {
  for (const healthTimeoutMs of [null, "45", Number.NaN, 0, 45_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => launchFixture({ healthTimeoutMs }),
      (error) => error instanceof TypeError,
    );
  }
  for (const healthIntervalMs of [null, "10", Number.NaN, 0, 1_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => launchFixture({ healthIntervalMs }),
      (error) => error instanceof TypeError,
    );
  }
  for (const option of ["healthNow", "healthDelay"]) {
    for (const invalid of [null, 0, "clock", {}, []]) {
      assert.throws(
        () => launchFixture({ [option]: invalid }),
        (error) => error instanceof TypeError,
      );
    }
  }
});

test("package main 指向正式 bootstrap", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.main, "app/bootstrap.js");
});

test("bootstrap 只公开固定阶段码且不读取 hostile error accessor", async () => {
  assert.equal(bootstrap.bootstrapFailureCode(Object.assign(new Error(), {
    code: "MCP_HELPER_AUTH_FAILED",
  })), "MCP_HELPER_AUTH_FAILED");
  assert.equal(bootstrap.bootstrapFailureCode(Object.assign(new Error(), {
    code: "PRIVATE_SECRET_CODE",
  })), "BOOTSTRAP_FAILED");
  let getterHits = 0;
  const hostile = new Error("secret-canary");
  Object.defineProperty(hostile, "code", { get() { getterHits += 1; throw new Error("secret"); } });
  assert.equal(bootstrap.bootstrapFailureCode(hostile), "BOOTSTRAP_FAILED");
  assert.equal(getterHits, 0);

  await assert.rejects(
    Promise.resolve().then(() => bootstrap.main(
      ["--shoggoth-internal-role=agent-service"], {}, undefined, {},
    )),
    (error) => error.code === "BOOTSTRAP_ROLE_REJECTED",
  );
});

test("普通启动默认 UI，内部 role 必须带受控标记", () => {
  assert.equal(bootstrap.resolveRole([], {}), "ui");
  assert.throws(
    () => bootstrap.resolveRole(["--shoggoth-internal-role=agent-service"], {}),
    /受控启动标记|controlled launch marker/i,
  );
  assert.throws(
    () => bootstrap.resolveRole(
      ["--shoggoth-internal-role=agent-service"],
      { SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1" },
    ),
    /packaged|launchd|origin|来源/i,
  );
});

function packagedRoleFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-role-packaged-"));
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot);
  const bundle = makeTempAppBundle(applicationsRoot);
  return {
    env: {
      SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
      SHOGGOTH_LAUNCHD_LABEL: LAUNCH_AGENT_LABEL,
      SHOGGOTH_BOOTSTRAP_PATH: bundle.bootstrapPath,
      ...overrides.env,
    },
    runtime: {
      platform: "darwin",
      execPath: bundle.executablePath,
      resourcesPath: bundle.resourcesPath,
      applicationsRoot,
      ppid: 1,
      defaultApp: false,
      ...overrides.runtime,
    },
    bundle,
  };
}

test("Service role 生产 gate 同时校验 packaged 路径、bootstrap、launchd label 与 PPID", () => {
  const valid = packagedRoleFixture();
  assert.equal(fs.lstatSync(path.join(valid.bundle.resourcesPath, "app.asar")).isFile(), true);
  assert.equal(
    bootstrap.resolveRole(["--shoggoth-internal-role=agent-service"], valid.env, valid.runtime),
    "agent-service",
  );
  for (const broken of [
    packagedRoleFixture({ runtime: { ppid: 22 } }),
    packagedRoleFixture({ runtime: { execPath: "/tmp/Shoggoth" } }),
    packagedRoleFixture({ runtime: { resourcesPath: "/tmp/resources" } }),
    packagedRoleFixture({ env: { SHOGGOTH_BOOTSTRAP_PATH: "/tmp/bootstrap.js" } }),
    packagedRoleFixture({ env: { SHOGGOTH_LAUNCHD_LABEL: "evil.label" } }),
  ]) {
    assert.throws(
      () => bootstrap.resolveRole(["--shoggoth-internal-role=agent-service"], broken.env, broken.runtime),
      /packaged|launchd|bootstrap|来源|路径|parent/i,
    );
  }
});

test("test gate 仅允许 defaultApp+NODE_ENV=test+0600 nonce 文件，生产不能启用", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-role-gate-"));
  const gatePath = path.join(root, "gate.json");
  const nonce = "fixture-nonce";
  fs.writeFileSync(gatePath, `${JSON.stringify({ parentPid: process.pid, nonce })}\n`, { mode: 0o600 });
  const env = {
    NODE_ENV: "test",
    SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
    SHOGGOTH_TEST_ROLE_GATE_FILE: gatePath,
    SHOGGOTH_TEST_ROLE_GATE_NONCE: nonce,
  };
  const runtime = {
    platform: "darwin", execPath: resolveElectronBinary(), resourcesPath: "/tmp/resources",
    ppid: process.pid, defaultApp: true,
  };
  assert.equal(
    bootstrap.resolveRole(["--shoggoth-internal-role=agent-service"], env, runtime),
    "agent-service",
  );
  assert.throws(
    () => bootstrap.resolveRole(
      ["--shoggoth-internal-role=agent-service"],
      { ...env, NODE_ENV: "production" },
      runtime,
    ),
    /test gate|packaged|来源/i,
  );
  assert.throws(
    () => bootstrap.resolveRole(
      ["--shoggoth-internal-role=agent-service"], env, { ...runtime, defaultApp: false },
    ),
    /test gate|packaged|来源/i,
  );
});

test("未知 role fail closed，受控 MCP role 独立解析", () => {
  const env = { SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1" };
  assert.throws(() => bootstrap.resolveRole(["--shoggoth-internal-role=wat"], env), /未知|unknown/i);
  assert.throws(() => bootstrap.resolveRole(["--shoggoth-internal-role=browser-worker"], env), /未知|unknown/i);
  assert.throws(
    () => bootstrap.resolveRole(["--shoggoth-internal-role=mcp"], env),
    /MCP|parent|来源|签名|gate/i,
    "公开 env+argv marker 不能授权 helper",
  );
  assert.equal(bootstrap.resolveRole(
    ["--shoggoth-internal-role=mcp"],
    { ...env, NODE_ENV: "test" },
    {
      platform: "darwin", defaultApp: true, ppid: process.pid,
      verifyMcpParent: () => true,
    },
  ), "mcp");
  assert.equal(bootstrap.resolveRole(["--shoggoth-internal-role=mcp-crypto"], env), "mcp-crypto");
});

test("packaged MCP helper 只接受直接 Codex parent 的固定 TeamIdentifier/designated requirement", () => {
  const resourcesPath = "/Applications/Shoggoth.app/Contents/Resources";
  const codexPath = path.join(resourcesPath, "codex/package/bin/codex");
  const base = {
    platform: "darwin", defaultApp: false, ppid: 481,
    resourcesPath,
    parent: { executable: codexPath, command: `${codexPath} app-server` },
    verifyCodeIdentity: () => ({
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: "identifier codex and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"2DC432GLL2\"",
    }),
  };
  const env = { SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1" };
  assert.equal(bootstrap.resolveRole(["--shoggoth-internal-role=mcp"], env, base), "mcp");
  assert.equal(
    bootstrap.resolveRole(["--shoggoth-internal-role=mcp"], {}, base),
    "mcp",
    "Codex MCP launcher may omit the configured env table; the verified direct parent remains authoritative",
  );
  for (const broken of [
    { ...base, parent: { ...base.parent, executable: "/tmp/codex" } },
    { ...base, verifyCodeIdentity: () => ({ teamIdentifier: "FAKE", designatedRequirement: "identifier codex" }) },
    { ...base, verifyCodeIdentity: () => ({ teamIdentifier: "2DC432GLL2", designatedRequirement: "identifier fake" }) },
  ]) assert.throws(
    () => bootstrap.resolveRole(["--shoggoth-internal-role=mcp"], {}, broken),
    /MCP|parent|来源|签名|gate|BOOTSTRAP_CODE_IDENTITY_INVALID/i,
  );
});

test("原生 Codex MCP helper 只接受当前 CLI 安装对应的官方签名父进程", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-codex-mcp-")));
  const packageRoot = path.join(root, "node_modules", "@openai", "codex");
  const installBin = path.join(root, "bin");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  const platformRoot = path.join(packageRoot, "node_modules", "@openai", "codex-darwin-arm64");
  const nativeBinary = path.join(platformRoot, "vendor", "aarch64-apple-darwin", "bin", "codex");
  for (const target of [installBin, path.dirname(launcher), path.dirname(nativeBinary)]) {
    fs.mkdirSync(target, { recursive: true });
  }
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex", version: "0.153.4", bin: { codex: "bin/codex.js" },
  }));
  fs.writeFileSync(path.join(platformRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(nativeBinary, "native fixture", { mode: 0o755 });
  fs.symlinkSync(launcher, path.join(installBin, "codex"));
  const identity = {
    teamIdentifier: "2DC432GLL2",
    designatedRequirement: 'identifier codex and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "2DC432GLL2"',
  };
  const argv = ["--shoggoth-internal-role=mcp", "--shoggoth-runtime-profile=native-codex",
    "--shoggoth-runtime-account=native-codex-default-v1"];
  const env = { PATH: installBin };
  const runtime = {
    platform: "darwin", defaultApp: false, ppid: 481,
    resourcesPath: "/Applications/Shoggoth.app/Contents/Resources",
    userInfo: () => ({ homedir: root }),
    parent: { executable: nativeBinary, command: `${nativeBinary} app-server` },
    verifyCodeIdentity: (candidate) => { assert.equal(candidate, nativeBinary); return identity; },
  };
  try {
    assert.equal(bootstrap.resolveRole(argv, env, runtime), "mcp");
    for (const changed of [
      { argv: argv.slice(0, 2) },
      { argv: [argv[0], argv[2]] },
      { argv: [...argv, argv[2]] },
      { argv: [...argv.slice(0, 2), "--shoggoth-runtime-account=shoggoth-internal-codex-default-v1"] },
      { runtime: { ...runtime, parent: { ...runtime.parent, executable: path.join(root, "another-codex") } } },
      { runtime: { ...runtime, verifyCodeIdentity: () => ({ ...identity, teamIdentifier: "FAKE" }) } },
      { runtime: { ...runtime, verifyCodeIdentity: () => ({ ...identity, designatedRequirement: "identifier fake" }) } },
    ]) assert.throws(() => bootstrap.resolveRole(changed.argv || argv, env, changed.runtime || runtime));
    const directBinary = path.join(root, "direct", "codex");
    fs.mkdirSync(path.dirname(directBinary));
    fs.writeFileSync(directBinary, "standalone native fixture", { mode: 0o755 });
    assert.equal(bootstrap.resolveRole(argv, { PATH: path.dirname(directBinary) }, {
      ...runtime,
      parent: { executable: directBinary, command: `${directBinary} app-server` },
      verifyCodeIdentity: (candidate) => { assert.equal(candidate, directBinary); return identity; },
    }), "mcp");
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unrelated-cli" }));
    assert.throws(() => bootstrap.resolveRole(argv, env, runtime));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runtimeMcpGateFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-runtime-mcp-role-"));
  const gateHomeDir = path.join(root, "gate-home");
  const canonicalHomeDir = overrides.canonicalHomeDir || gateHomeDir;
  const gatePaths = resolveServicePaths({ homeDir: gateHomeDir });
  const gateRoot = path.join(gatePaths.runtimeDir, "mcp-gates");
  fs.mkdirSync(gateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(gateRoot, 0o700);
  const nonce = "b".repeat(64);
  const gatePath = path.join(gateRoot, `mcp-${nonce}.gate`);
  const servicePaths = overrides.servicePaths || Object.fromEntries([
    "trustedRoot", "stateDir", "mcpAuthPath", "runtimeDir", "socketPath",
  ].map((field) => [field, gatePaths[field]]));
  fs.writeFileSync(gatePath, `${JSON.stringify({
    schemaVersion: 2,
    nonce,
    parentPid: 9527,
    parentExecutable: "/opt/shoggoth/grok",
    runtimeProfileId: "runtime-grok",
    runtimeAccountId: "runtime-grok-account",
    expiresAt: 11_000,
    servicePaths,
    ...overrides.gate,
  })}\n`, { mode: overrides.mode || 0o600 });
  return {
    root,
    gatePath,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      SHOGGOTH_RUNTIME_MCP_GATE_FILE: gatePath,
      SHOGGOTH_RUNTIME_MCP_GATE_NONCE: nonce,
    },
    runtime: {
      platform: "darwin",
      defaultApp: true,
      ppid: 9527,
      now: () => 10_000,
      userInfo: () => ({ homedir: canonicalHomeDir }),
      parent: {
        executable: "/opt/shoggoth/grok",
        command: "/opt/shoggoth/grok --sandbox workspace agent --no-leader stdio",
        ...overrides.parent,
      },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("外部 Runtime MCP gate 先只读验证，再由 Service one-shot 消费后分派", async () => {
  const value = runtimeMcpGateFixture();
  const argv = [
    "--shoggoth-internal-role=mcp",
    "--shoggoth-runtime-profile=runtime-grok",
    "--shoggoth-runtime-account=runtime-grok-account",
  ];
  try {
    assert.equal(bootstrap.resolveRole(argv, value.env, value.runtime), "mcp");
    assert.equal(fs.existsSync(value.gatePath), true);
    let dispatched = false;
    const expectedBridge = Object.freeze({
      runtimeProfileId: "runtime-grok",
      runtimeAccountId: "runtime-grok-account",
      socket: {},
    });
    await bootstrap.main(argv, value.env, {
      ...value.runtime,
      async openRuntimeMcpBridge(context) {
        assert.equal(context.servicePaths.socketPath, path.join(value.root,
          "gate-home/Library/Application Support/Shoggoth/run/service.sock"));
        assert.equal(context.runtimeProfileId, "runtime-grok");
        assert.equal(context.runtimeAccountId, "runtime-grok-account");
        fs.unlinkSync(value.gatePath);
        return expectedBridge;
      },
    }, {
      runtimeMcpRelay(bridge) {
        dispatched = bridge === expectedBridge;
      },
    });
    assert.equal(dispatched, true);
    assert.equal(fs.existsSync(value.gatePath), false);
    assert.throws(() => bootstrap.resolveRole(argv, value.env, value.runtime));
  } finally { value.cleanup(); }
});

test("外部 Runtime MCP gate 不能自报伪造 Service 路径或在校验前触碰伪造 UDS", async () => {
  const value = runtimeMcpGateFixture({
    canonicalHomeDir: path.join(os.tmpdir(), "shoggoth-real-account-home"),
  });
  const argv = [
    "--shoggoth-internal-role=mcp",
    "--shoggoth-runtime-profile=runtime-grok",
    "--shoggoth-runtime-account=runtime-grok-account",
  ];
  let serviceRequests = 0;
  try {
    await assert.rejects(async () => bootstrap.main(argv, value.env, {
      ...value.runtime,
      async requestRuntimeMcpGate() {
        serviceRequests += 1;
        return { consumed: true };
      },
    }, { mcp() { throw new Error("must not dispatch"); } }), (error) => (
      error?.code === "BOOTSTRAP_ROLE_REJECTED"
    ));
    assert.equal(serviceRequests, 0);
  } finally { value.cleanup(); }
});

test("外部 Runtime MCP gate 拒绝跨 profile/account、过期、宽权限与错误 parent", () => {
  const variants = [
    { argvProfile: "runtime-other" },
    { argvAccount: "runtime-other-account" },
    { gate: { expiresAt: 9_999 } },
    { mode: 0o644 },
    { parent: { executable: "/tmp/fake-grok" } },
  ];
  for (const variant of variants) {
    const value = runtimeMcpGateFixture(variant);
    try {
      assert.throws(() => bootstrap.resolveRole([
        "--shoggoth-internal-role=mcp",
        `--shoggoth-runtime-profile=${variant.argvProfile || "runtime-grok"}`,
        `--shoggoth-runtime-account=${variant.argvAccount || "runtime-grok-account"}`,
      ], value.env, value.runtime));
    } finally { value.cleanup(); }
  }
});

test("Service 分派不会加载 UI 组合根", () => {
  const loaded = [];
  bootstrap.dispatchRole("agent-service", {
    ui: () => loaded.push("ui"),
    service: () => loaded.push("service"),
  });
  assert.deepEqual(loaded, ["service"]);
});

test("MCP 分派不会加载 UI 或 Service 组合根", () => {
  const loaded = [];
  bootstrap.dispatchRole("mcp", {
    ui: () => loaded.push("ui"),
    service: () => loaded.push("service"),
    mcp: () => loaded.push("mcp"),
  });
  assert.deepEqual(loaded, ["mcp"]);
  assert.doesNotThrow(() => bootstrap.assertMcpRoleIsolation({
    "/app/bootstrap-role.js": {},
    "/app/shoggoth-mcp-helper.js": {},
    "/app/agent-service/client.js": {},
  }));
  for (const forbidden of [
    "/app/ui-entry.js",
    "/app/agent-service/server.js",
    "/app/agent-service/product-store.js",
    "/app/core/openclaw-backend.js",
    "/app/core/hermes-backend.js",
  ]) {
    assert.throws(
      () => bootstrap.assertMcpRoleIsolation({ [forbidden]: {} }),
      /forbidden|隔离/i,
    );
  }
});

test("真实 MCP helper 模块加载不能把 ProductStore/领域 Store 带进隔离进程", () => {
  const script = [
    'const bootstrap = require("./app/bootstrap-role")',
    'require("./app/shoggoth-mcp-helper")',
    'bootstrap.assertMcpRoleIsolation()',
  ].join(";");
  assert.doesNotThrow(() => execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 5_000,
    stdio: "pipe",
  }));
});

test("MCP crypto 分派仅加载 one-shot worker，不加载 UI/Service 产品根", () => {
  const loaded = [];
  bootstrap.dispatchRole("mcp-crypto", {
    ui: () => loaded.push("ui"),
    service: () => loaded.push("service"),
    mcp: () => loaded.push("mcp"),
    mcpCrypto: () => loaded.push("mcp-crypto"),
  });
  assert.deepEqual(loaded, ["mcp-crypto"]);
  assert.doesNotThrow(() => bootstrap.assertMcpCryptoRoleIsolation({
    "/app/bootstrap-role.js": {},
    "/app/mcp-crypto-worker.js": {},
    "/app/agent-service/mcp-auth-secret-store.js": {},
  }));
  assert.throws(
    () => bootstrap.assertMcpCryptoRoleIsolation({ "/app/agent-service/server.js": {} }),
    /forbidden|隔离/i,
  );
});

test("Service role require-cache 发现 UI/OpenClaw/Hermes 产品模块即 fail closed", () => {
  assert.doesNotThrow(() => bootstrap.assertServiceRoleIsolation({
    "/app/agent-service.js": {},
    "/app/agent-service/server.js": {},
  }));
  for (const forbidden of [
    "/app/ui-entry.js",
    "/app/static-server.js",
    "/app/openclaw-host.js",
    "/app/core/openclaw-backend.js",
    "/app/core/openclaw-registry.js",
    "/app/core/hermes-backend.js",
    "/app/core/hermes-gateway.js",
  ]) {
    assert.throws(
      () => bootstrap.assertServiceRoleIsolation({ [forbidden]: {} }),
      /forbidden UI module|禁止.*UI|隔离/i,
    );
  }
});

test("main.js 仅保留兼容入口，UI 组合根已迁到 ui-entry.js", () => {
  const main = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
  const uiEntry = fs.readFileSync(path.join(ROOT, "app", "ui-entry.js"), "utf8");
  assert.match(main, /require\(["']\.\/ui-entry["']\)/);
  assert.doesNotMatch(main, /BrowserWindow|startStaticServer/);
  assert.match(uiEntry, /BrowserWindow/);
  assert.match(uiEntry, /startStaticServer/);
});

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function rawFrame(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("end", () => {
      socket.destroy();
      resolve(body);
    });
    socket.on("error", reject);
  });
}

function rawJsonRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); });
    socket.on("end", () => {
      const newline = buffered.indexOf(0x0a);
      const newlineCount = [...buffered].filter((byte) => byte === 0x0a).length;
      const frame = newline >= 0 ? buffered.subarray(0, newline) : buffered;
      const tail = newline >= 0 ? buffered.subarray(newline + 1) : Buffer.alloc(0);
      try {
        resolve({
          response: JSON.parse(frame.toString("utf8")),
          bytes: buffered.length,
          frameCount: newlineCount,
          tailBytes: tail.length,
        });
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function openJsonlConversation(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const frames = [];
    const waiters = [];
    let buffered = Buffer.alloc(0);
    let received = "";
    let connected = false;
    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
    const deliver = (value) => {
      const waiter = waiters.shift();
      if (!waiter) {
        frames.push(value);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    };
    const rejectWaiters = (error) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    };
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        try {
          deliver(JSON.parse(frame.toString("utf8")));
        } catch (error) {
          rejectWaiters(error);
        }
      }
    });
    socket.on("close", () => {
      closed = true;
      rejectWaiters(new Error("JSONL conversation closed"));
      resolveClosed();
    });
    socket.on("error", (error) => {
      if (!connected) reject(error);
      else rejectWaiters(error);
    });
    socket.once("connect", () => {
      connected = true;
      resolve({
        send(payload) {
          return new Promise((resolveWrite, rejectWrite) => {
            socket.write(`${JSON.stringify(payload)}\n`, (error) => {
              if (error) rejectWrite(error);
              else resolveWrite();
            });
          });
        },
        nextFrame(timeoutMs = 1_000) {
          if (frames.length > 0) return Promise.resolve(frames.shift());
          if (closed) return Promise.reject(new Error("JSONL conversation closed"));
          return new Promise((resolveFrame, rejectFrame) => {
            const waiter = { resolve: resolveFrame, reject: rejectFrame, timer: null };
            waiter.timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectFrame(new Error("JSONL frame timeout"));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        receivedText: () => received,
        isClosed: () => closed,
        end: () => socket.end(),
        destroy: () => socket.destroy(),
        waitClosed: () => closedPromise,
      });
    });
  });
}

async function requestFromMaliciousServer(responseFactory, timeoutMs = 100) {
  const root = fs.mkdtempSync("/tmp/sgmc-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.runtimeDir, 0o700);
  fs.writeFileSync(paths.tokenPath, "fixture-token\n", { mode: 0o600 });
  const sockets = new Set();
  const malicious = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let requestBytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      requestBytes = Buffer.concat([requestBytes, chunk]);
      const newline = requestBytes.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(requestBytes.subarray(0, newline).toString("utf8"));
      const response = responseFactory(request.id);
      const chunks = response.chunks || [];
      const send = (index) => {
        if (index >= chunks.length) {
          if (response.end !== false) socket.end();
          return;
        }
        socket.write(chunks[index], () => setImmediate(() => send(index + 1)));
      };
      send(0);
    });
  });
  await new Promise((resolve, reject) => malicious.listen(paths.socketPath, (error) => error ? reject(error) : resolve()));
  fs.chmodSync(paths.socketPath, 0o600);
  try {
    return await requestService(paths, {
      method: "service.status", token: "fixture-token", version: PROTOCOL_VERSION,
    }, { timeoutMs });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => malicious.close(resolve));
  }
}

function idleSocketResult(socketPath, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket 未在期限内由服务端关闭"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("end", () => {
      clearTimeout(deadline);
      socket.destroy();
      resolve(body);
    });
    socket.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待条件超时");
}

async function waitForHealthyService(paths, timeoutMs = 3000) {
  let status = null;
  await waitFor(async () => {
    if (!fs.existsSync(paths.socketPath) || !fs.existsSync(paths.tokenPath)) return false;
    try {
      const socketStat = fs.lstatSync(paths.socketPath);
      if (!socketStat.isSocket() || (socketStat.mode & 0o777) !== 0o600) return false;
      status = await requestService(paths, {
        method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
      }, { timeoutMs: 250 });
      return status?.healthy === true;
    } catch (error) {
      if ([
        "SERVICE_UNAVAILABLE", "SERVICE_DISCONNECTED", "REQUEST_TIMEOUT", "ECONNREFUSED", "ENOENT",
      ].includes(error?.code)) return false;
      throw error;
    }
  }, timeoutMs);
  return status;
}

function runProcess(executable, args, options = {}) {
  const { timeoutMs = 5_000, ...spawnOptions } = options;
  const detached = spawnOptions.detached ?? true;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
      detached,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolve, { code, signal, stdout, stderr }));
    const timeout = setTimeout(() => {
      const error = new Error(`测试子进程超过 ${timeoutMs}ms`);
      error.code = "TEST_PROCESS_TIMEOUT";
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      }
      finish(reject, error);
    }, timeoutMs);
    timeout.ref();
  });
}

test("子进程 helper 超时有界并终止独立进程组", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120)"], { timeoutMs: 20 }),
    (error) => error.code === "TEST_PROCESS_TIMEOUT",
  );
});

test("Service 路径与 UI userData/cache 完全独立，目录/凭据/socket 权限收紧", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-svc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  assert.notEqual(paths.profileDir, paths.cacheDir);
  assert.match(paths.profileDir, /profile$/);
  const service = createAgentService({ paths, version: "test-version" });
  await service.start();
  try {
    assert.equal(mode(paths.stateDir), 0o700);
    assert.equal(mode(paths.runtimeDir), 0o700);
    assert.equal(mode(paths.profileDir), 0o700);
    assert.equal(mode(paths.cacheDir), 0o700);
    assert.equal(mode(paths.tokenPath), 0o600);
    assert.equal(mode(paths.socketPath), 0o600);
    assert.equal(readClientToken(paths).length >= 32, true);
  } finally {
    await service.stop();
  }
});

test("运行端点不依赖可丢弃 cache，运行中清空 cache 后 Service 仍可通信", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-cache-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const service = createAgentService({ paths, version: "cache-independent" });
  await service.start();
  try {
    assert.equal(paths.runtimeDir, path.join(paths.userDataRoot, "run"));
    assert.equal(paths.socketPath.startsWith(paths.cacheDir), false);
    fs.rmSync(paths.cacheDir, { recursive: true, force: true });

    assert.equal(fs.existsSync(paths.cacheDir), false);
    assert.equal((await requestService(paths, {
      method: "service.status",
      token: readClientToken(paths),
      version: PROTOCOL_VERSION,
    })).healthy, true);
  } finally {
    await service.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧 cache 锁与新稳定锁并存时 writer lease 阻止跨版本双写", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-upgrade-lock-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const legacyRuntimeDir = path.join(paths.cacheDir, "run");
  const legacyPaths = Object.freeze({
    ...paths,
    runtimeDir: legacyRuntimeDir,
    socketPath: path.join(legacyRuntimeDir, "service.sock"),
    tokenPath: path.join(legacyRuntimeDir, "client.token"),
    lockPath: path.join(legacyRuntimeDir, "service.lock"),
    federationSocketPath: path.join(legacyRuntimeDir, "app-host.sock"),
    federationTokenPath: path.join(legacyRuntimeDir, "app-host.token"),
  });
  const legacy = createAgentService({ paths: legacyPaths, version: "legacy-cache-lock" });
  await legacy.start();
  try {
    const contender = createAgentService({ paths, version: "stable-lock-contender" });
    await assert.rejects(
      contender.start(),
      (error) => error?.code === "WRITER_LEASE_HELD",
    );
  } finally {
    await legacy.stop({ notify: false });
  }

  const upgraded = createAgentService({ paths, version: "stable-lock-upgraded" });
  try {
    await upgraded.start();
    assert.equal((await requestService(paths, {
      method: "service.status",
      token: readClientToken(paths),
      version: PROTOCOL_VERSION,
    })).healthy, true);
  } finally {
    await upgraded.stop({ notify: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instance lock 部分写入失败只清理自己 inode，并聚合 close/unlink 清理错误", async () => {
  async function attemptFailure(name, configure) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `shoggoth-lock-${name}-`));
    const paths = resolveServicePaths({
      stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
    });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const lockFs = Object.create(fs);
    const state = { closeCalls: 0, unlinkCalls: 0 };
    configure(lockFs, state, paths);
    let acquired = null;
    let failure = null;
    try {
      acquired = await acquireInstanceLock(paths.lockPath, {
        paths,
        instanceNonce: `nonce-${name}`,
        getProcessIdentity: () => "fixture-identity",
        lockProbeTimeoutMs: 20,
        protocolVersion: PROTOCOL_VERSION,
        fs: lockFs,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (acquired) fs.closeSync(acquired.fd);
      try { fs.unlinkSync(paths.lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    assert.ok(failure, `${name} 应拒绝 acquisition`);
    assert.equal(failure.code === "EIO" || failure.code === "SERVICE_LOCK_ACQUIRE_FAILED", true);
    return { error: failure, paths, state };
  }

  const writeFailure = await attemptFailure("write", (lockFs) => {
    let calls = 0;
    lockFs.writeSync = (...args) => {
      calls += 1;
      if (calls === 1) return fs.writeSync(...args.slice(0, 3), Math.min(args[3], 7), args[4]);
      const error = new Error("fixture lock write EIO");
      error.code = "EIO";
      throw error;
    };
  });
  assert.equal(fs.existsSync(writeFailure.paths.lockPath), false);

  const fsyncFailure = await attemptFailure("fsync", (lockFs) => {
    lockFs.fsyncSync = () => {
      const error = new Error("fixture lock fsync EIO");
      error.code = "EIO";
      throw error;
    };
  });
  assert.equal(fs.existsSync(fsyncFailure.paths.lockPath), false);

  const chmodFailure = await attemptFailure("chmod", (lockFs) => {
    lockFs.fchmodSync = () => {
      const error = new Error("fixture lock chmod EIO");
      error.code = "EIO";
      throw error;
    };
  });
  assert.equal(fs.existsSync(chmodFailure.paths.lockPath), false);

  const cleanupFailure = await attemptFailure("cleanup", (lockFs, state) => {
    lockFs.writeSync = () => {
      const error = new Error("fixture primary write failure");
      error.code = "EIO";
      throw error;
    };
    lockFs.closeSync = (fd) => {
      state.closeCalls += 1;
      fs.closeSync(fd);
      throw new Error("fixture close cleanup failure");
    };
    lockFs.unlinkSync = (target) => {
      state.unlinkCalls += 1;
      if (state.unlinkCalls === 1) throw new Error("fixture unlink cleanup failure");
      return fs.unlinkSync(target);
    };
  });
  assert.equal(cleanupFailure.error instanceof AggregateError, true);
  assert.match(cleanupFailure.error.errors.map((error) => error.message).join("\n"), /close cleanup failure/);
  assert.match(cleanupFailure.error.errors.map((error) => error.message).join("\n"), /unlink cleanup failure/);
  assert.equal(cleanupFailure.state.closeCalls >= 1, true);
  assert.equal(cleanupFailure.state.unlinkCalls >= 2, true);
  assert.equal(fs.existsSync(cleanupFailure.paths.lockPath), false);

  const replaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lock-replaced-"));
  const replacePaths = resolveServicePaths({
    stateRoot: path.join(replaceRoot, "state"), cacheRoot: path.join(replaceRoot, "cache"),
  });
  fs.mkdirSync(replacePaths.runtimeDir, { recursive: true, mode: 0o700 });
  const replaceFs = Object.create(fs);
  replaceFs.fsyncSync = () => {
    fs.unlinkSync(replacePaths.lockPath);
    fs.writeFileSync(replacePaths.lockPath, "replacement-owner\n", { mode: 0o600 });
    const error = new Error("fixture replacement fsync failure");
    error.code = "EIO";
    throw error;
  };
  await assert.rejects(
    acquireInstanceLock(replacePaths.lockPath, {
      paths: replacePaths,
      instanceNonce: "nonce-replaced",
      getProcessIdentity: () => "fixture-identity",
      lockProbeTimeoutMs: 20,
      protocolVersion: PROTOCOL_VERSION,
      fs: replaceFs,
    }),
    (error) => error.code === "EIO",
  );
  assert.equal(fs.readFileSync(replacePaths.lockPath, "utf8"), "replacement-owner\n");
  fs.unlinkSync(replacePaths.lockPath);
});

test("Service start 将 lock acquisition 纳入清理边界且失败不残留 owner 文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lock-start-failure-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const lockFs = Object.create(fs);
  lockFs.fsyncSync = () => {
    const error = new Error("fixture start lock fsync failure");
    error.code = "EIO";
    throw error;
  };
  const service = createAgentService({ paths, version: "lock-failure", lockFs });
  try {
    await assert.rejects(service.start(), (error) => error.code === "EIO");
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(fs.existsSync(paths.tokenPath), false);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
  }
});

test("Service 生命周期初始化/关闭 ProductStore，hello/status 与默认 profile 不回归", async () => {
  assert.equal(PROTOCOL_VERSION, 4);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-store-lifecycle-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  for (let restart = 0; restart < 2; restart += 1) {
    const service = createAgentService({ paths, version: "store-lifecycle" });
    await service.start();
    try {
      const token = readClientToken(paths);
      const hello = await requestService(paths, {
        method: "service.hello", token, version: PROTOCOL_VERSION,
      });
      assert.equal(hello.serviceVersion, "store-lifecycle");
      assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
      await assert.rejects(
        requestService(paths, {
          method: "service.hello", token, version: PROTOCOL_VERSION - 1,
        }),
        (error) => error.code === "PROTOCOL_VERSION_MISMATCH",
      );
      const status = await requestService(paths, {
        method: "service.status", token, version: PROTOCOL_VERSION,
      });
      assert.equal(status.healthy, true);
      assert.equal(fs.existsSync(paths.eventLogPath), true);
    } finally {
      await service.stop();
    }
    const snapshot = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
    const defaults = snapshot.agentProfiles.filter((profile) => profile.isDefault);
    assert.deepEqual(defaults.map((profile) => [profile.id, profile.name]), [
      [DEFAULT_AGENT_PROFILE_ID, "Shoggoth"],
    ]);
  }
});

test("默认启动只读导入旧 Codex memories，不复制整棵 legacy Runtime Home", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-no-copy-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"),
  });
  const runtimeProfileId = defaultAgentProfile().runtimeProfileId;
  const memoryRoot = path.join(paths.stateDir, "codex", runtimeProfileId, "memories");
  fs.mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  const source = path.join(memoryRoot, "preference.md");
  fs.writeFileSync(source, "Prefer concise answers.\n", { mode: 0o600 });
  const service = createAgentService({ paths, version: "memory-no-copy" });
  await service.start();
  await service.stop({ notify: false });
  assert.equal(fs.readFileSync(source, "utf8"), "Prefer concise answers.\n");
  assert.equal(fs.existsSync(path.join(paths.backupsDir, PRE_MEMORY_AUTHORITY_BACKUP_ID)), false);
  assert.equal(fs.existsSync(paths.memoryMigrationPath), true);
});

test("Service stop 先停止 Codex RuntimePool 再关闭 ProductStore，且未有 Run 时不 spawn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-rto-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const order = [];
  const store = new JsonlProductStore({ paths });
  const closeStore = store.close.bind(store);
  store.close = () => { order.push("store"); closeStore(); };
  const runtimePool = {
    get() { assert.fail("Service 不应在没有 Work Run 时 spawn Codex runtime"); },
    async stopAll() { order.push("runtime"); },
  };
  const service = createAgentService({ paths, version: "runtime-order", productStore: store, runtimePool });
  await service.start();
  await service.stop({ notify: false });
  assert.deepEqual(order, ["runtime", "store"]);
});

test("Service stop 聚合 RuntimePool 与 ProductStore 关闭失败并继续完整清理", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-rta-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const order = [];
  const store = new JsonlProductStore({ paths });
  const closeStore = store.close.bind(store);
  store.close = () => {
    order.push("store");
    closeStore();
    throw Object.assign(new Error("fixture store close failure"), { code: "STORE_CLOSE_FAILED" });
  };
  const runtimePool = {
    get() { assert.fail("Service 不应在没有 Work Run 时 spawn Codex runtime"); },
    async stopAll() {
      order.push("runtime");
      throw Object.assign(new Error("fixture runtime stop failure"), { code: "CODEX_RUNTIME_POOL_STOP_FAILED" });
    },
  };
  const service = createAgentService({ paths, version: "runtime-aggregate", productStore: store, runtimePool });
  await service.start();
  await assert.rejects(service.stop({ notify: false }), (error) => {
    assert.equal(error.code, "SERVICE_STOP_FAILED");
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.some((entry) => entry.code === "CODEX_RUNTIME_POOL_STOP_FAILED"), true);
    assert.equal(error.errors.some((entry) => entry.code === "STORE_CLOSE_FAILED"), true);
    return true;
  });
  assert.deepEqual(order, ["runtime", "store"]);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("Service 拥有 SecretStore/Provider bridge，按 secret→product→provider 打开并逆序关闭且聚合失败", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-provider-owner-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const order = [];
  const productStore = new JsonlProductStore({ paths });
  const originalOpen = productStore.open.bind(productStore);
  const originalClose = productStore.close.bind(productStore);
  productStore.open = () => { order.push("product.open"); return originalOpen(); };
  productStore.close = () => {
    order.push("product.close");
    originalClose();
    throw Object.assign(new Error("product close fixture"), { code: "STORE_CLOSE_FAILED" });
  };
  let secretMetadata = [{
    credentialRef: "provider-credential-startup-orphan",
    kind: "openrouter",
  }];
  const secretStore = {
    open() { order.push("secret.open"); },
    listMetadata() { return secretMetadata.map((entry) => ({ ...entry })); },
    async delete(credentialRef) {
      order.push(`secret.delete:${credentialRef}`);
      secretMetadata = secretMetadata.filter((entry) => entry.credentialRef !== credentialRef);
      return true;
    },
    matchesPlaintext() { return false; },
    withPlaintextMatcher(action) { return action(() => false); },
    async close() {
      order.push("secret.close");
      throw Object.assign(new Error("secret close fixture"), { code: "SECRET_CLOSE_FAILED" });
    },
  };
  const providerRuntimeBridge = {
    open() { order.push("provider.open"); },
    async prepareRuntime() { return { spawnEnv: {}, registeredSecrets: [], runtimeConfig: null }; },
    async close() {
      order.push("provider.close");
      throw Object.assign(new Error("provider close fixture"), { code: "PROVIDER_CLOSE_FAILED" });
    },
  };
  const runtimePool = {
    get() { assert.fail("Service 不应在没有 Work Run 时 spawn Codex runtime"); },
    async stopAll() {
      order.push("runtime.close");
      throw Object.assign(new Error("runtime close fixture"), { code: "CODEX_RUNTIME_POOL_STOP_FAILED" });
    },
  };
  const accountAuthStateStore = {
    open() { order.push("auth-state.open"); },
    async close() {
      order.push("auth-state.close");
      throw Object.assign(new Error("auth state close fixture"), { code: "AUTH_STATE_CLOSE_FAILED" });
    },
  };
  const accountAuthManager = {
    open() { order.push("auth-manager.open"); },
    async close() {
      order.push("auth-manager.close");
      throw Object.assign(new Error("auth manager close fixture"), { code: "AUTH_MANAGER_CLOSE_FAILED" });
    },
  };
  const service = createAgentService({
    paths,
    version: "provider-owner",
    productStore,
    secretStore,
    providerRuntimeBridge,
    runtimePool,
    accountAuthStateStore,
    accountAuthManager,
  });
  assert.equal(service.productStore, productStore);
  assert.equal(service.secretStore, secretStore);
  assert.equal(service.providerRuntimeBridge, providerRuntimeBridge);
  assert.equal(service.runtimePool, runtimePool);
  await service.start();
  assert.deepEqual(order, [
    "secret.open", "product.open", "secret.delete:provider-credential-startup-orphan",
    "provider.open", "auth-state.open", "auth-manager.open",
  ]);
  await assert.rejects(service.stop({ notify: false }), (error) => {
    assert.equal(error.code, "SERVICE_STOP_FAILED");
    assert.equal(error instanceof AggregateError, true);
    for (const code of [
      "CODEX_RUNTIME_POOL_STOP_FAILED", "PROVIDER_CLOSE_FAILED", "SECRET_CLOSE_FAILED", "STORE_CLOSE_FAILED",
      "AUTH_MANAGER_CLOSE_FAILED", "AUTH_STATE_CLOSE_FAILED",
    ]) assert.equal(error.errors.some((entry) => entry.code === code), true, code);
    return true;
  });
  assert.deepEqual(order, [
    "secret.open", "product.open", "secret.delete:provider-credential-startup-orphan",
    "provider.open", "auth-state.open", "auth-manager.open",
    "auth-manager.close", "runtime.close", "auth-state.close", "provider.close", "product.close", "secret.close",
  ]);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("Service auth.* IPC 严格校验并拥有 AuthState/Manager 生命周期", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-auth-ipc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const order = [];
  const calls = [];
  let leakRead = false;
  let bedrockRead = false;
  let startResultOverride = null;
  let cancelStatus = "canceled";
  const accountAuthStateStore = {
    open() { order.push("auth-state.open"); },
    async close() { order.push("auth-state.close"); },
  };
  const accountAuthManager = {
    open() { order.push("auth-manager.open"); },
    async close() { order.push("auth-manager.close"); },
    async read(params) {
      calls.push(["read", params]);
      if (bedrockRead) {
        return {
          account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
          requiresOpenaiAuth: false,
          login: null,
        };
      }
      if (leakRead) {
        return {
          account: { type: "chatgpt", planType: "plus", email: "manager-pii-canary@example.test" },
          requiresOpenaiAuth: true,
          login: null,
        };
      }
      return { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true, login: null };
    },
    async loginStart(params) {
      calls.push(["start", params]);
      if (startResultOverride) return startResultOverride;
      if (params.mode === "deviceCode") {
        return {
          requestId: "request-ipc",
          mode: params.mode,
          status: "waiting",
          loginId: "login-ipc",
          verificationUrl: "http://localhost:1455/device",
          userCode: "ABCD-EFGH",
        };
      }
      return {
        requestId: "request-ipc",
        mode: params.mode,
        status: "waiting",
        loginId: "login-ipc",
        authUrl: "https://auth.example.test/login",
      };
    },
    async loginCancel(params) {
      calls.push(["cancel", params]);
      return { requestId: params.requestId, status: cancelStatus };
    },
    async logout(params) {
      calls.push(["logout", params]);
      return { loggedOut: true };
    },
  };
  const runtimePool = {
    get() { assert.fail("Service 不应在没有 Work Run 时 spawn Codex runtime"); },
    async stopAll() { order.push("runtime.close"); },
  };
  const service = createAgentService({
    paths,
    version: "auth-ipc",
    runtimePool,
    accountAuthStateStore,
    accountAuthManager,
  });
  assert.equal(service.accountAuthStateStore, accountAuthStateStore);
  assert.equal(service.accountAuthManager, accountAuthManager);
  await service.start();
  try {
    assert.deepEqual(order.slice(0, 2), ["auth-state.open", "auth-manager.open"]);
    const token = readClientToken(paths);
    const base = { token, version: PROTOCOL_VERSION };
    assert.deepEqual(await requestService(paths, {
      ...base, method: "auth.read", params: { runtimeProfileId: "runtime-ipc" },
    }), { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true, login: null });
    assert.equal((await requestService(paths, {
      ...base,
      method: "auth.login.start",
      params: { runtimeProfileId: "runtime-ipc", mode: "browser" },
    })).requestId, "request-ipc");
    assert.equal((await requestService(paths, {
      ...base,
      method: "auth.login.start",
      params: { runtimeProfileId: "runtime-ipc", mode: "deviceCode" },
    })).userCode, "ABCD-EFGH");
    assert.deepEqual(await requestService(paths, {
      ...base,
      method: "auth.login.cancel",
      params: { runtimeProfileId: "runtime-ipc", requestId: "request-ipc" },
    }), { requestId: "request-ipc", status: "canceled" });
    cancelStatus = "interrupted";
    assert.deepEqual(await requestService(paths, {
      ...base,
      method: "auth.login.cancel",
      params: { runtimeProfileId: "runtime-ipc", requestId: "request-ipc" },
    }), { requestId: "request-ipc", status: "interrupted" });
    cancelStatus = "canceled";
    assert.deepEqual(await requestService(paths, {
      ...base, method: "auth.logout", params: { runtimeProfileId: "runtime-ipc" },
    }), { loggedOut: true });

    const secret = "service-auth-api-key-canary";
    await assert.rejects(
      requestService(paths, {
        ...base,
        method: "auth.login.start",
        params: { runtimeProfileId: "runtime-ipc", mode: "apiKey", apiKey: secret },
      }),
      (error) => error.code === "INVALID_PARAMS" && !error.message.includes(secret),
    );
    await assert.rejects(
      requestService(paths, {
        ...base,
        method: "auth.read",
        params: { runtimeProfileId: "runtime-ipc", unknown: true },
      }),
      (error) => error.code === "INVALID_PARAMS",
    );
    const envelopeSecret = "auth-envelope-api-key-canary";
    await assert.rejects(
      requestService(paths, {
        ...base,
        method: "auth.read",
        params: { runtimeProfileId: "runtime-ipc" },
        apiKey: envelopeSecret,
      }),
      (error) => error.code === "INVALID_PARAMS" && !error.message.includes(envelopeSecret),
    );
    assert.equal(calls.length, 6);
    const invalidStartResults = [
      {
        requestId: "request-ipc", mode: "browser", status: "waiting", loginId: "login-ipc",
        authUrl: "javascript:alert(1)",
      },
      {
        requestId: "request-ipc", mode: "browser", status: "waiting", loginId: "login-ipc",
        authUrl: "https://user:password@auth.example.test/login",
      },
      {
        requestId: "request-ipc", mode: "deviceCode", status: "waiting", loginId: "login-ipc",
        verificationUrl: "file:///tmp/device", userCode: "ABCD-EFGH",
      },
      {
        requestId: "request-ipc", mode: "deviceCode", status: "waiting", loginId: "login-ipc",
        verificationUrl: "https://auth.example.test/device", userCode: "ABCD\nEFGH",
      },
    ];
    for (const invalid of invalidStartResults) {
      startResultOverride = invalid;
      await assert.rejects(
        requestService(paths, {
          ...base,
          method: "auth.login.start",
          params: { runtimeProfileId: "runtime-ipc", mode: invalid.mode },
        }),
        (error) => error.code === "AUTH_RESPONSE_INVALID",
      );
    }
    startResultOverride = null;
    bedrockRead = true;
    assert.deepEqual(await requestService(paths, {
      ...base, method: "auth.read", params: { runtimeProfileId: "runtime-ipc" },
    }), {
      account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
      requiresOpenaiAuth: false,
      login: null,
    });
    bedrockRead = false;
    leakRead = true;
    await assert.rejects(
      requestService(paths, {
        ...base, method: "auth.read", params: { runtimeProfileId: "runtime-ipc" },
      }),
      (error) => error.code === "AUTH_RESPONSE_INVALID"
        && !error.message.includes("manager-pii-canary@example.test"),
    );
    assert.equal(calls.length, 12);
  } finally {
    await service.stop({ notify: false });
  }
  assert.deepEqual(order.slice(-3), ["auth-manager.close", "runtime.close", "auth-state.close"]);
});

test("Service 默认构造并暴露 provider 内部资源，safeStorage locked 不阻止 Service 启动", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-provider-default-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const service = createAgentService({ paths, version: "provider-default" });
  assert.equal(typeof service.productStore?.putModelProvider, "function");
  assert.equal(typeof service.secretStore?.put, "function");
  assert.equal(typeof service.providerRuntimeBridge?.prepareRuntime, "function");
  assert.equal(typeof service.runtimePool?.get, "function");
  await service.start();
  await assert.rejects(
    service.secretStore.put("credential-locked", "service-secret-canary-000001", { kind: "openrouter" }),
    (error) => error.code === "credentials_locked",
  );
  await service.stop({ notify: false });
  assert.throws(
    () => service.secretStore.listMetadata(),
    (error) => error.code === "SECRET_STORE_CLOSED",
  );
});

test("Provider IPC 严格分派 list/save/delete/secret set-clear/protocol validate 且不回显 secret", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-provider-ipc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const calls = [];
  const providerLifecycle = [];
  const provider = {
    id: "provider-ipc",
    kind: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture/model",
    credentialRef: null,
    headers: null,
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
  };
  const providerService = {
    async open() { providerLifecycle.push("open"); },
    async close() { providerLifecycle.push("close"); },
    list() { calls.push(["list"]); return [provider]; },
    async save(value) { calls.push(["save", value]); return provider; },
    async delete(value) { calls.push(["delete", value]); return provider; },
    async setSecret(value) { calls.push(["setSecret", value]); return provider; },
    async clearSecret(value) { calls.push(["clearSecret", value]); return provider; },
    async validate(value) {
      calls.push(["validate", value]);
      return { providerId: provider.id, validationStatus: "protocol_valid", parsedBy: "codex-0.149.0" };
    },
  };
  const service = createAgentService({ paths, version: "provider-ipc", providerService });
  assert.equal(service.providerService, providerService);
  await service.start();
  assert.deepEqual(providerLifecycle, ["open"]);
  const secret = "provider-ipc-secret-canary-000001";
  try {
    const token = readClientToken(paths);
    const base = { token, version: PROTOCOL_VERSION };
    assert.deepEqual(await requestService(paths, {
      ...base, method: "provider.list", params: {},
    }), [provider]);
    const endpoints = await requestService(paths, {
      ...base, method: "provider.endpoints.list", params: { profileId: null },
    });
    assert.equal(endpoints.supported, true);
    assert.deepEqual(endpoints.endpoints, []);
    assert.deepEqual(endpoints.form.apiOptions, ["openai-responses"]);
    const invalidEndpoint = await requestService(paths, {
      ...base, method: "provider.endpoints.discover", params: { profileId: null, endpoint: { baseUrl: "file:///tmp/models" } },
    });
    assert.equal(invalidEndpoint.code, "invalid_url");
    assert.deepEqual(await requestService(paths, {
      ...base, method: "provider.save", params: { provider: {
        id: provider.id, kind: provider.kind, name: provider.name, model: provider.model,
      } },
    }), provider);
    assert.deepEqual(await requestService(paths, {
      ...base, method: "provider.delete", params: { providerId: provider.id },
    }), provider);
    assert.deepEqual(await requestService(paths, {
      ...base,
      method: "provider.secret.set",
      params: { providerId: provider.id, secret },
    }), provider);
    assert.deepEqual(await requestService(paths, {
      ...base,
      method: "provider.secret.clear",
      params: { providerId: provider.id },
    }), provider);
    assert.deepEqual(await requestService(paths, {
      ...base,
      method: "provider.validate",
      params: { providerId: provider.id, level: "protocol" },
    }), {
      providerId: provider.id, validationStatus: "protocol_valid", parsedBy: "codex-0.149.0",
    });
    const response = await rawJsonRequest(paths.socketPath, {
      id: "provider-invalid",
      ...base,
      method: "provider.secret.set",
      params: { providerId: provider.id, secret, extra: true },
    });
    assert.equal(response.response.error.code, "INVALID_PARAMS");
    assert.equal(JSON.stringify(response.response).includes(secret), false);
    assert.equal(calls.length, 7);
  } finally {
    await service.stop({ notify: false });
  }
  assert.deepEqual(providerLifecycle, ["open", "close"]);
});

test("Profile IPC exact 分派 bind/configure，生命周期有序且 secret 不回显", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-profile-ipc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  const calls = [];
  const profileServiceController = {
    open() { calls.push(["open"]); },
    async close() { calls.push(["close"]); },
    async handle(method, params) {
      calls.push([method, structuredClone(params)]);
      return { profile: {
        ...defaultAgentProfile(params.createdAt - 1),
        providerRef: params.providerRef,
        defaultModel: params.defaultModel,
        updatedAt: params.createdAt,
      } };
    },
  };
  const service = createAgentService({
    paths, version: "profile-ipc", profileServiceController,
  });
  assert.strictEqual(service.profileServiceController, profileServiceController);
  await service.start();
  const token = readClientToken(paths);
  const createdAt = Date.now();
  const secret = "profile-ipc-secret-canary-000001";
  try {
    const bound = await requestService(paths, {
      token, version: PROTOCOL_VERSION, method: "profile.bind", params: {
        operationId: "profile-bind-ipc", profileId: DEFAULT_AGENT_PROFILE_ID,
        providerRef: null, defaultModel: "gpt-5", createdAt,
      },
    });
    assert.equal(bound.profile.providerRef, null);
    const configured = await requestService(paths, {
      token, version: PROTOCOL_VERSION, method: "profile.configure", params: {
        operationId: "profile-configure-ipc", profileId: DEFAULT_AGENT_PROFILE_ID,
        providerRef: "provider-openai", defaultModel: "gpt-5", secret, createdAt,
      },
    });
    assert.equal(configured.profile.providerRef, "provider-openai");
    assert.equal(JSON.stringify(configured).includes(secret), false);
    const raw = await rawJsonRequest(paths.socketPath, {
      id: "profile-invalid", token, version: PROTOCOL_VERSION, method: "profile.configure",
      params: {
        operationId: "profile-configure-invalid", profileId: DEFAULT_AGENT_PROFILE_ID,
        providerRef: "provider-openai", defaultModel: "gpt-5", secret, createdAt, extra: true,
      },
    });
    assert.equal(raw.response.error.code, "INVALID_PARAMS");
    assert.equal(JSON.stringify(raw.response).includes(secret), false);
  } finally {
    await service.stop({ notify: false });
  }
  assert.equal(calls[0][0], "open");
  assert.equal(calls.at(-1)[0], "close");
  assert.deepEqual(calls.slice(1, -1).map((entry) => entry[0]), ["profile.bind", "profile.configure"]);
});

test("默认 Service 用 open 期 SecretStore cache 拒绝 ProductStore 明文，restart/rotation/delete 与 locked restart 均 fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-dynamic-secret-redaction-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  let decryptLocked = false;
  let decryptCalls = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.from(value, "utf8").reverse(); },
    decryptString(value) {
      decryptCalls += 1;
      if (decryptLocked) throw new Error("ordinary-decrypt-failure-detail");
      return Buffer.from(value).reverse().toString("utf8");
    },
  };
  const canaryOne = "ordinary-dynamic-service-canary-one";
  const canaryTwo = "ordinary-dynamic-service-canary-two";
  const provider = (id, name) => ({
    id,
    kind: "openrouter",
    name,
    baseUrl: "https://api.example.test/v1",
    model: "fixture-model",
    credentialRef: "credential-dynamic-service",
    headers: null,
    validationStatus: "unverified",
  });

  const first = createAgentService({ paths, version: "dynamic-redaction", safeStorage });
  await first.start();
  await first.secretStore.put(
    "credential-dynamic-service", canaryOne, { kind: "openrouter" },
  );
  const decryptCallsBeforeRejectedWrite = decryptCalls;
  assert.throws(
    () => first.productStore.putModelProvider(provider("provider-leak-first", `name-${canaryOne}`)),
    (error) => error.code === "STORE_SENSITIVE_VALUE"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canaryOne),
  );
  assert.equal(decryptCalls - decryptCallsBeforeRejectedWrite, 0,
    "ProductStore 同步 matcher 只读取 open/put 维护的 cache，不重入 safeStorage");
  await first.stop({ notify: false });

  decryptLocked = true;
  const lockedRestart = createAgentService({ paths, version: "dynamic-redaction", safeStorage });
  await lockedRestart.start();
  assert.throws(
    () => lockedRestart.productStore.putModelProvider(provider("provider-locked-restart", "ordinary-provider-name")),
    (error) => error.code === "STORE_SENSITIVE_VALUE_CHECK_FAILED",
  );
  await lockedRestart.stop({ notify: false });
  decryptLocked = false;

  const second = createAgentService({ paths, version: "dynamic-redaction", safeStorage });
  await second.start();
  assert.throws(
    () => second.productStore.putModelProvider(provider("provider-leak-restart", canaryOne)),
    (error) => error.code === "STORE_SENSITIVE_VALUE",
  );
  await second.secretStore.put(
    "credential-dynamic-service", canaryTwo, { kind: "openrouter" },
  );
  assert.equal(second.secretStore.matchesPlaintext(canaryOne), false);
  assert.equal(second.secretStore.matchesPlaintext(canaryTwo), true);
  decryptLocked = true;
  const decryptCallsBeforeCachedWrite = decryptCalls;
  assert.equal(
    second.productStore.putModelProvider(
      provider("provider-cache-after-lock", "ordinary-provider-name"),
    ).id,
    "provider-cache-after-lock",
  );
  assert.equal(decryptCalls, decryptCallsBeforeCachedWrite,
    "密钥环迟到 locked 不得让同步 ProductStore 写重入主进程 safeStorage");
  decryptLocked = false;
  await second.secretStore.delete("credential-dynamic-service");
  assert.equal(second.secretStore.matchesPlaintext(canaryTwo), false);
  await second.stop({ notify: false });

  for (const entry of fs.readdirSync(paths.stateDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(path.join(paths.stateDir, entry.name), "utf8");
    assert.equal(bytes.includes(canaryOne), false, entry.name);
    assert.equal(bytes.includes(canaryTwo), false, entry.name);
  }
});

test("自定义 ProductStore 必须接受 Service 的动态 SecretStore matcher，不能旁路", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-product-store-matcher-contract-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "s"), cacheRoot: path.join(root, "c") });
  assert.throws(
    () => createAgentService({ paths, version: "matcher-contract", productStore: {} }),
    (error) => error.code === "PRODUCT_STORE_SECRET_MATCHER_REQUIRED",
  );
});

test("同一 Service 对象 start-stop-start-stop 仍会关闭第二轮 Store/socket/lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-service-restart-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "restart" });
  await service.start();
  await service.stop({ notify: false });
  await service.start();
  await service.stop({ notify: false });
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8")).agentProfiles.length, 1);
});

test("Service 默认构造并暴露 Native Kanban/Cron stores、services 与统一 domain executor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-domain-defaults-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const service = createAgentService({ paths, version: "domain-defaults" });
  assert.equal(service.nativeKanbanStore instanceof NativeKanbanStore, true);
  assert.equal(service.kanbanRunService instanceof KanbanRunService, true);
  assert.equal(service.nativeCronStore instanceof NativeCronStore, true);
  assert.equal(service.nativeCronScheduler instanceof NativeCronScheduler, true);
  assert.equal(service.domainWorkRunExecutor instanceof DomainWorkRunExecutor, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Service 仅在 private MCP transport ready 后启动 Coordinator/Kanban/Cron recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-domain-lifecycle-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const calls = [];
  let handshakeSecret = null;
  let gateConsumes = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      if (/^[A-Za-z0-9_-]{43}$/u.test(value)) {
        handshakeSecret = Buffer.from(value, "base64url");
      }
      return Buffer.from(value, "utf8").reverse();
    },
    decryptString(value) {
      return Buffer.from(value).reverse().toString("utf8");
    },
  };
  const runtimeMcpGateIssuer = {
    open() { calls.push("mcpGate.open"); return this; },
    close() { calls.push("mcpGate.close"); },
    createMcpServer() { throw new Error("not used"); },
    consume() { gateConsumes += 1; return { consumed: true }; },
  };
  const defaultProfile = defaultAgentProfile(0);
  const { runtimeProfileId, runtimeAccountId } = defaultProfile;
  async function probeStartupTransport(name) {
    assert.equal(fs.existsSync(paths.tokenPath), true, `${name}: token must exist before recovery`);
    assert.equal(fs.existsSync(paths.socketPath), true, `${name}: socket must exist before recovery`);
    assert.equal(mode(paths.socketPath), 0o600, `${name}: socket must already be private`);
    const token = readClientToken(paths);
    const ordinary = await rawJsonRequest(paths.socketPath, {
      id: `${name}-status`, token, version: PROTOCOL_VERSION, method: "service.status",
    });
    assert.equal(ordinary.response.ok, false);
    assert.equal(ordinary.response.error.code, "SERVICE_UNAVAILABLE");
    const unauthenticatedOrdinary = await rawJsonRequest(paths.socketPath, {
      id: `${name}-unauthenticated-status`, token: "wrong",
      version: PROTOCOL_VERSION, method: "service.status",
    });
    assert.equal(unauthenticatedOrdinary.response.error.code, "SERVICE_UNAVAILABLE");
    const wrongVersionOrdinary = await rawJsonRequest(paths.socketPath, {
      id: `${name}-wrong-version-status`, token,
      version: PROTOCOL_VERSION + 1, method: "service.status",
    });
    assert.equal(wrongVersionOrdinary.response.error.code, "SERVICE_UNAVAILABLE");

    const gate = await rawJsonRequest(paths.socketPath, {
      id: `${name}-gate`, version: PROTOCOL_VERSION, method: "mcp.runtime.gate.consume",
      params: {
        runtimeProfileId,
        runtimeAccountId,
        gatePath: path.join(paths.runtimeDir, `${name}.gate`),
        nonce: "a".repeat(64),
        parentPid: process.pid,
      },
    });
    assert.deepEqual(gate.response.result, { consumed: true });

    const clientNonce = crypto.randomBytes(32).toString("base64url");
    const challenged = await rawJsonRequest(paths.socketPath, {
      id: `${name}-challenge`, version: PROTOCOL_VERSION, method: "mcp.auth.challenge",
      params: { protocolVersion: PROTOCOL_VERSION, runtimeProfileId, runtimeAccountId, clientNonce },
    });
    assert.equal(challenged.response.ok, true);
    assert.ok(handshakeSecret, `${name}: startup HMAC secret must be available`);
    const challenge = challenged.response.result;
    const exchanged = await rawJsonRequest(paths.socketPath, {
      id: `${name}-exchange`, version: PROTOCOL_VERSION, method: "mcp.auth.exchange",
      params: {
        challengeId: challenge.challengeId,
        protocolVersion: challenge.protocolVersion,
        runtimeProfileId: challenge.runtimeProfileId,
        runtimeAccountId: challenge.runtimeAccountId,
        clientNonce: challenge.clientNonce,
        serverNonce: challenge.serverNonce,
        proof: createMcpChallengeProof(handshakeSecret, challenge),
      },
    });
    assert.equal(exchanged.response.ok, true);
    assert.equal(exchanged.response.result.runtimeProfileId, runtimeProfileId);
    assert.equal(exchanged.response.result.runtimeAccountId, runtimeAccountId);
  }
  const component = (name, asyncOpen = false) => ({
    open() {
      calls.push(`${name}.open`);
      return asyncOpen ? Promise.resolve(this) : this;
    },
    close() {
      calls.push(`${name}.close`);
      return asyncOpen ? Promise.resolve() : undefined;
    },
  });
  const nativeKanbanStore = component("kanbanStore");
  nativeKanbanStore.listBoards = () => [];
  const nativeCronStore = component("cronStore");
  nativeCronStore.listJobs = () => [];
  const recoveryComponent = (name) => ({
    async open() {
      calls.push(`${name}.open`);
      await probeStartupTransport(name);
      return this;
    },
    close() { calls.push(`${name}.close`); },
  });
  const kanbanRunService = recoveryComponent("kanbanService");
  const nativeCronScheduler = recoveryComponent("cronScheduler");
  const domainWorkRunExecutor = {
    schedule() { throw new Error("not used"); },
    recover() { throw new Error("not used"); },
  };
  const workRunCoordinator = {
    ...recoveryComponent("coordinator"),
    listRuns() { return []; },
    getRun() { return null; },
    send() { throw new Error("not used"); },
    subscribeRun() { return { unsubscribe() {} }; },
  };
  const chatServiceController = {
    ...component("chatController", true),
    handle() { throw new Error("not used"); },
  };
  const runtimePool = {
    get() { throw new Error("not used"); },
    async stopAll() { calls.push("runtime.stopAll"); },
  };
  const service = createAgentService({
    paths,
    version: "domain-lifecycle",
    nativeKanbanStore,
    kanbanRunService,
    nativeCronStore,
    nativeCronScheduler,
    domainWorkRunExecutor,
    nativeDomainServiceController: { handle() { throw new Error("not used"); } },
    workRunCoordinator,
    chatServiceController,
    runtimePool,
    safeStorage,
    runtimeMcpGateIssuer,
    onServerReady() { calls.push("server.ready"); },
  });
  assert.strictEqual(service.nativeKanbanStore, nativeKanbanStore);
  assert.strictEqual(service.kanbanRunService, kanbanRunService);
  assert.strictEqual(service.nativeCronStore, nativeCronStore);
  assert.strictEqual(service.nativeCronScheduler, nativeCronScheduler);
  assert.strictEqual(service.domainWorkRunExecutor, domainWorkRunExecutor);
  await service.start();
  assert.ok(calls.indexOf("kanbanStore.open") < calls.indexOf("kanbanService.open"));
  assert.ok(calls.indexOf("cronStore.open") < calls.indexOf("cronScheduler.open"));
  assert.ok(calls.indexOf("coordinator.open") < calls.indexOf("kanbanService.open"));
  assert.ok(calls.indexOf("kanbanService.open") < calls.indexOf("server.ready"));
  assert.ok(calls.indexOf("cronScheduler.open") < calls.indexOf("server.ready"));
  assert.equal(gateConsumes, 3);
  const status = await requestService(paths, {
    method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
  });
  assert.equal(status.healthy, true);
  await service.stop({ notify: false });
  assert.ok(calls.indexOf("cronScheduler.close") < calls.indexOf("coordinator.close"));
  assert.ok(calls.indexOf("kanbanService.close") < calls.indexOf("coordinator.close"));
  assert.ok(calls.indexOf("coordinator.close") < calls.indexOf("cronStore.close"));
  assert.ok(calls.indexOf("coordinator.close") < calls.indexOf("kanbanStore.close"));
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.tokenPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("domain background fatal 仅隔离对应领域，Service 与另一领域继续可用", async () => {
  const root = fs.mkdtempSync("/tmp/sg-domain-fatal-");
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const sourceError = Object.assign(new Error("scheduler source canary"), {
    code: "CRON_RUN_CORRUPT",
  });
  const runtimeFaults = [];
  const domainFaults = [];
  const processFaults = [];
  const onUnhandled = (error) => processFaults.push(error);
  process.on("unhandledRejection", onUnhandled);
  let service;
  const runtimePool = {
    get() { throw new Error("not used"); },
    async stopAll() { runtimeFaults.push(new Error("whole service cleanup must not run")); },
  };
  service = createAgentService({
    paths,
    version: "domain-fatal-once",
    runtimePool,
    onRuntimeError(error) { runtimeFaults.push(error); },
    onDomainRuntimeError(domain, error, cleanupError) {
      domainFaults.push({ domain, error, cleanupError, availability: service.getDomainAvailability() });
    },
  });
  try {
    await service.start();
    assert.equal(typeof service.nativeCronScheduler.onFatalError, "function");
    assert.equal(typeof service.kanbanRunService.onFatalError, "function");
    assert.equal(typeof service.nativeDomainServiceController.onFatalDomainError, "function");
    service.nativeCronScheduler.onFatalError(sourceError);
    service.nativeDomainServiceController.onFatalDomainError(
      "cron", new Error("parallel controller fatal"),
    );
    await waitFor(() => domainFaults.length === 1
      && service.getDomainAvailability().cron.available === false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(domainFaults.length, 1, "同领域并发 fatal 每 generation 只报告一次");
    assert.strictEqual(domainFaults[0].error, sourceError);
    assert.equal(domainFaults[0].cleanupError, null);
    assert.deepEqual(domainFaults[0].availability, {
      kanban: { available: true, reason: null },
      cron: { available: false, reason: "runtime_fatal" },
    });
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
    const statusAfterCron = await requestService(paths, {
      method: "service.status",
      token: readClientToken(paths),
      version: PROTOCOL_VERSION,
    });
    assert.equal(statusAfterCron.healthy, true);
    assert.equal(statusAfterCron.domainAvailability.kanban.available, true);
    assert.equal(statusAfterCron.domainAvailability.cron.available, false);

    const kanbanError = Object.assign(new Error("parallel kanban fatal"), {
      code: "KANBAN_RUN_CORRUPT",
    });
    service.kanbanRunService.onFatalError(kanbanError);
    await waitFor(() => domainFaults.length === 2
      && service.getDomainAvailability().kanban.available === false);
    assert.deepEqual(domainFaults.map((entry) => entry.domain), ["cron", "kanban"]);
    assert.strictEqual(domainFaults[1].error, kanbanError);
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.deepEqual(runtimeFaults, []);
    assert.deepEqual(processFaults, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("旧 generation 延迟 domain fatal 在显式 stop 后不得报告或干扰 restart", async () => {
  const root = fs.mkdtempSync("/tmp/sg-domain-fatal-generation-");
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const runtimeFaults = [];
  const service = createAgentService({
    paths,
    version: "domain-fatal-generation",
    onRuntimeError(error) { runtimeFaults.push(error); },
  });
  try {
    await service.start();
    const oldController = service.nativeDomainServiceController;
    service.nativeCronScheduler.onFatalError(new Error("old generation fatal"));
    await service.stop({ notify: false });
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimeFaults.length, 0);
    assert.notStrictEqual(service.nativeDomainServiceController, oldController);
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Native domain store commit-uncertain 在 listen 前 health probe fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-domain-poison-"));
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  let ready = 0;
  let closed = 0;
  const poison = new Error("kanban commit uncertain");
  poison.code = "KANBAN_COMMIT_UNCERTAIN";
  poison.committedUncertain = true;
  const nativeKanbanStore = {
    open() { return this; },
    listBoards() { throw poison; },
    close() { closed += 1; },
  };
  const nativeCronStore = {
    open() { return this; }, listJobs() { return []; }, close() { closed += 1; },
  };
  const inert = { open() { return this; }, close() {} };
  const service = createAgentService({
    paths,
    version: "domain-poison",
    nativeKanbanStore,
    nativeCronStore,
    kanbanRunService: inert,
    nativeCronScheduler: inert,
    domainWorkRunExecutor: { schedule() {}, recover() {} },
    nativeDomainServiceController: { handle() { throw new Error("not used"); } },
    onServerReady() { ready += 1; },
  });
  let startError = null;
  try { await service.start(); } catch (error) { startError = error; }
  if (!startError) await service.stop({ notify: false });
  assert.equal(startError?.code, "KANBAN_COMMIT_UNCERTAIN");
  assert.equal(ready, 0);
  assert.equal(closed >= 1, true, "startup cleanup 必须关闭已打开的 domain store");
  assert.equal(fs.existsSync(paths.socketPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("locked matcher 只降级含非空数据的领域并保留文件，解锁后下一代恢复", async () => {
  for (const lockedDomain of ["kanban", "cron"]) {
    // macOS sockaddr_un 只容纳短路径；这里测试领域锁降级，不让长 temp 根干扰目标 RED。
    const root = fs.mkdtempSync(`/tmp/sg-domain-locked-${lockedDomain}-`);
    const paths = resolveServicePaths({
      trustedRoot: root,
      stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"),
    });
    let locked = false;
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString(value) { return Buffer.from(value, "utf8").reverse(); },
      decryptString(value) {
        if (locked) throw new Error("locked-domain-matcher-canary");
        return Buffer.from(value).reverse().toString("utf8");
      },
    };
    const now = 2_000_000;
    const first = createAgentService({
      paths, version: "domain-locked", safeStorage, now: () => now,
    });
    await first.start();
    await first.secretStore.put("credential-domain-locked", "fixture-secret", {
      kind: "openrouter",
    });
    if (lockedDomain === "kanban") {
      first.nativeKanbanStore.createBoard({
        operationId: "create-locked-board",
        profileId: DEFAULT_AGENT_PROFILE_ID,
        slug: "locked-board",
        name: "Locked board",
        description: null,
        createdAt: now,
      });
    } else {
      first.nativeCronStore.createJob({
        operationId: "create-locked-job",
        name: "Locked job",
        enabled: false,
        profileId: DEFAULT_AGENT_PROFILE_ID,
        prompt: "Inspect repository state",
        workspace: null,
        schedule: { kind: "at", at: now + 60_000 },
        misfirePolicy: "skip",
        maxCatchUp: 1,
        overlapPolicy: "skip",
        threadPolicy: "new",
        threadId: null,
        nextRunAt: null,
        createdAt: now,
      });
    }
    await first.stop({ notify: false });

    const domainFile = path.join(
      paths.stateDir,
      lockedDomain === "kanban" ? "native-kanban.json" : "native-cron.json",
    );
    const beforeLockedStart = fs.readFileSync(domainFile, "utf8");
    locked = true;
    const second = createAgentService({
      paths, version: "domain-locked", safeStorage, now: () => now + 1,
    });
    await second.start();
    try {
      const availability = second.getDomainAvailability();
      assert.deepEqual(availability[lockedDomain], {
        available: false,
        reason: "sensitive_check_unavailable",
      });
      const otherDomain = lockedDomain === "kanban" ? "cron" : "kanban";
      assert.deepEqual(
        availability[otherDomain],
        lockedDomain === "cron"
          ? { available: false, reason: "sensitive_check_unavailable" }
          : { available: true, reason: null },
        "默认 Kanban Board 也需要已解锁的敏感值 matcher；空 Cron Store 可独立启动",
      );
      const status = await requestService(paths, {
        method: "service.status",
        token: readClientToken(paths),
        version: PROTOCOL_VERSION,
      });
      assert.equal(status.healthy, true);
    } finally {
      await second.stop({ notify: false });
    }
    assert.equal(fs.readFileSync(domainFile, "utf8"), beforeLockedStart);

    locked = false;
    const third = createAgentService({
      paths, version: "domain-locked", safeStorage, now: () => now + 2,
    });
    await third.start();
    try {
      assert.deepEqual(third.getDomainAvailability(), {
        kanban: { available: true, reason: null },
        cron: { available: true, reason: null },
      });
      if (lockedDomain === "kanban") {
        const boards = third.nativeKanbanStore.listBoards();
        assert.equal(boards.length, 2, "默认 Shoggoth Board 与锁前用户 Board 都必须保留");
        assert.equal(boards.some((board) => board.slug === "default"), true);
      }
      else assert.equal(third.nativeCronStore.listJobs().length, 1);
    } finally {
      await third.stop({ notify: false });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("recovery uncertain 在 locked matcher 下仍优先阻止 Service listen 并保留证据", async () => {
  for (const uncertainDomain of ["kanban", "cron"]) {
    const root = fs.mkdtempSync(`/tmp/sg-domain-uncertain-${uncertainDomain}-`);
    const paths = resolveServicePaths({
      trustedRoot: root,
      stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"),
    });
    let locked = false;
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString(value) { return Buffer.from(value, "utf8").reverse(); },
      decryptString(value) {
        if (locked) throw new Error("uncertain-locked-matcher-canary");
        return Buffer.from(value).reverse().toString("utf8");
      },
    };
    const now = 3_000_000;
    const first = createAgentService({
      paths, version: "domain-uncertain", safeStorage, now: () => now,
    });
    await first.start();
    await first.secretStore.put("credential-domain-uncertain", "fixture-secret", {
      kind: "openrouter",
    });
    first.nativeKanbanStore.createBoard({
      operationId: "create-uncertain-board",
      profileId: DEFAULT_AGENT_PROFILE_ID,
      slug: "uncertain-board",
      name: "Uncertain board",
      description: null,
      createdAt: now,
    });
    first.nativeCronStore.createJob({
      operationId: "create-uncertain-job",
      name: "Uncertain job",
      enabled: false,
      profileId: DEFAULT_AGENT_PROFILE_ID,
      prompt: "Inspect uncertain recovery",
      workspace: null,
      schedule: { kind: "at", at: now + 60_000 },
      misfirePolicy: "skip",
      maxCatchUp: 1,
      overlapPolicy: "skip",
      threadPolicy: "new",
      threadId: null,
      nextRunAt: null,
      createdAt: now,
    });
    await first.stop({ notify: false });

    const target = path.join(
      paths.stateDir,
      uncertainDomain === "kanban" ? "native-kanban.json" : "native-cron.json",
    );
    const backup = `${target}.backup-${process.pid}-0123456789abcdef`;
    fs.copyFileSync(target, backup);
    fs.chmodSync(backup, 0o600);
    const targetBefore = fs.readFileSync(target, "utf8");
    const backupBefore = fs.readFileSync(backup, "utf8");
    locked = true;
    const second = createAgentService({
      paths, version: "domain-uncertain", safeStorage, now: () => now + 1,
    });
    let startError = null;
    try { await second.start(); } catch (error) { startError = error; }
    if (!startError) await second.stop({ notify: false });
    assert.equal(
      startError?.code,
      uncertainDomain === "kanban" ? "KANBAN_COMMIT_UNCERTAIN" : "CRON_COMMIT_UNCERTAIN",
    );
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(fs.readFileSync(target, "utf8"), targetBefore);
    assert.equal(fs.readFileSync(backup, "utf8"), backupBefore);
    assert.equal(fs.existsSync(paths.lockPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("同一 Service 对象并发 start 共享同一个启动 promise 且只建立一个实例", async () => {
  const root = fs.mkdtempSync("/tmp/sg-start-sf-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "start-singleflight" });
  const firstStart = service.start();
  const secondStart = service.start();
  try {
    assert.strictEqual(secondStart, firstStart, "并发 start 必须复用同一个 in-flight promise");
    const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);
    assert.strictEqual(firstResult, service);
    assert.strictEqual(secondResult, service);
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.lockPath), true);
  } finally {
    await Promise.allSettled([firstStart, secondStart]);
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator.open 挂起时 stop 会封住启动续体并等待其退出后完整清理", async () => {
  const root = fs.mkdtempSync("/tmp/sg-stop-start-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const openEntered = deferred();
  const releaseOpen = deferred();
  let serverReadyCalls = 0;
  let closeCalls = 0;
  const coordinator = {
    async open() {
      openEntered.resolve();
      await releaseOpen.promise;
    },
    async close() { closeCalls += 1; },
    listRuns() { return []; },
    getRun() { return null; },
    send() { throw new Error("not used"); },
    subscribeRun() { return () => {}; },
  };
  const service = createAgentService({
    paths,
    version: "stop-during-start",
    workRunCoordinator: coordinator,
    onServerReady() { serverReadyCalls += 1; },
  });
  const starting = service.start();
  await openEntered.promise;
  assert.equal(fs.existsSync(paths.socketPath), true);
  assert.equal(fs.existsSync(paths.tokenPath), true);
  let stopSettled = false;
  const stopping = service.stop({ notify: false });
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false, "stop 必须等待挂起的 startup 到达 generation fence");
  releaseOpen.resolve();
  await assert.rejects(starting, (error) => error.code === "SERVICE_START_CANCELED");
  await stopping;
  assert.equal(serverReadyCalls, 0, "被 stop 取消的启动不得进入 ready handler");
  assert.equal(closeCalls, 1);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.tokenPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stop 清理中 start 稳定拒绝且不会在清理尾部偷偷重启", async () => {
  const root = fs.mkdtempSync("/tmp/sg-start-stop-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const stopAllEntered = deferred();
  const releaseStopAll = deferred();
  let openCalls = 0;
  const coordinator = {
    async open() {
      openCalls += 1;
      if (openCalls > 1) {
        const error = new Error("旧实现不应在 stop 尾部自动重启");
        error.code = "TEST_UNEXPECTED_RESTART";
        throw error;
      }
    },
    async close() {},
    listRuns() { return []; },
    getRun() { return null; },
    send() { throw new Error("not used"); },
    subscribeRun() { return () => {}; },
  };
  const runtimePool = {
    get() { throw new Error("not used"); },
    async stopAll() {
      stopAllEntered.resolve();
      await releaseStopAll.promise;
    },
  };
  const service = createAgentService({
    paths,
    version: "start-during-stop",
    workRunCoordinator: coordinator,
    runtimePool,
  });
  await service.start();
  const stopping = service.stop({ notify: false });
  await stopAllEntered.promise;
  const startDuringStop = service.start();
  releaseStopAll.resolve();
  await stopping;
  await assert.rejects(startDuringStop, (error) => error.code === "SERVICE_STOPPING");
  assert.equal(openCalls, 1);
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.equal(fs.existsSync(paths.lockPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safeStorage locked 时 Service 在 listen 前恢复 chat running/waiting，普通写仍拒绝且第三次重启不重复", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-active-recovery-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  let decryptLocked = false;
  const recoveryCanary = "ordinary-active-recovery-canary";
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.from(value, "utf8").reverse(); },
    decryptString(value) {
      if (decryptLocked) throw new Error(recoveryCanary);
      return Buffer.from(value).reverse().toString("utf8");
    },
  };
  const firstStore = new JsonlProductStore({ paths, now: () => 5_000 });
  let firstDispatcher = null;
  const first = createAgentService({
    paths,
    version: "recovery",
    productStore: firstStore,
    safeStorage,
    onWorkDispatcherReady(dispatcher) { firstDispatcher = dispatcher; },
  });
  const statuses = ["running", "waiting_approval", "waiting_input"];
  const before = new Map();
  await first.start();
  try {
    assert.ok(firstDispatcher, "Service 必须创建并交付自己的 WorkDispatcher");
    await first.secretStore.put(
      "credential-active-recovery", recoveryCanary, { kind: "openrouter" },
    );
    const recoveryProfile = firstStore.putAgentProfile({
      ...firstStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID),
      id: "profile-recovery",
      agentId: "recovery",
      runtimeProfileId: "recovery",
      name: "Recovery",
      isDefault: false,
      concurrency: { maxActive: 4, maxWorkspaceWrites: 4 },
    });
    for (const [index, status] of statuses.entries()) {
      const id = `run-recovery-${status}`;
      firstDispatcher.enqueue({
        id,
        source: "chat",
        sourceId: `source-${id}`,
        idempotencyKey: status === "waiting_approval"
          ? `shoggoth:chat-send:federation-send-${id}` : `idem-${id}`,
        profileId: "profile-recovery",
        workspace: path.join(root, `workspace-${index}`),
      });
      firstDispatcher.admit(id);
      firstDispatcher.transition(id, "running", {
        runtimeSessionRef: {
          runtime: "codex", runtimeProfileId: "recovery",
          runtimeAccountId: recoveryProfile.runtimeAccountId, sessionId: `thread-${index}`,
        },
        runtimeTurnRef: {
          runtime: "codex", runtimeProfileId: "recovery",
          runtimeAccountId: recoveryProfile.runtimeAccountId, sessionId: `thread-${index}`,
          turnId: `turn-${index}`,
        },
      });
      if (status === "waiting_approval" || status === "waiting_input") {
        firstDispatcher.transition(id, status, { waitingRequestId: `request-${index}` });
      }
      before.set(id, firstDispatcher.getRun(id));
    }
    decryptLocked = true;
  } finally {
    await first.stop({ notify: false });
  }

  let recoveredDispatcher = null;
  let serverReadyObservedInterrupted = false;
  const recoveredEvents = [];
  const second = createAgentService({
    paths,
    version: "recovery",
    productStore: new JsonlProductStore({ paths, now: () => 6_000 }),
    safeStorage,
    eventBuffer: {
      append(type, payload) {
        const event = { seq: recoveredEvents.length + 1, type, payload: structuredClone(payload) };
        recoveredEvents.push(event);
        return event;
      },
      page() { throw new Error("not used"); },
    },
    onWorkDispatcherReady(dispatcher) { recoveredDispatcher = dispatcher; },
    onServerReady() {
      serverReadyObservedInterrupted = [...before.keys()].every((id) => (
        recoveredDispatcher.getRun(id).status === "interrupted"
      ));
    },
  });
  await second.start();
  try {
    assert.ok(recoveredDispatcher);
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(serverReadyObservedInterrupted, true, "listen 可观察时 recovery 必须已落盘");
    for (const [id, previous] of before) {
      const recovered = recoveredDispatcher.getRun(id);
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.errorCode, "SERVICE_RESTARTED");
      assert.equal(recovered.eventSeq, previous.eventSeq + 1);
      assert.equal(recovered.codexThreadId, previous.codexThreadId);
      assert.equal(recovered.codexTurnId, previous.codexTurnId);
      assert.equal(recovered.finishedAt, 6_000);
    }
    assert.deepEqual(
      recoveredEvents.filter((event) => event.type === "federation.chat.terminal")
        .map(({ type, payload }) => ({ type, payload })),
      [{
        type: "federation.chat.terminal",
        payload: {
          runId: "run-recovery-waiting_approval",
          profileId: "profile-recovery",
          sessionKey: "source-run-recovery-waiting_approval",
          status: "interrupted",
          result: null,
          errorCode: "SERVICE_RESTARTED",
          finishedAt: 6_000,
        },
      }],
    );
    assert.throws(
      () => second.productStore.putModelProvider({
        id: "provider-locked-recovery",
        kind: "openrouter",
        name: recoveryCanary,
        baseUrl: null,
        model: "fixture-model",
        credentialRef: null,
        headers: null,
        validationStatus: "unverified",
      }),
      (error) => error.code === "STORE_SENSITIVE_VALUE_CHECK_FAILED"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(recoveryCanary),
    );
    assert.throws(
      () => recoveredDispatcher.enqueue({
        id: "run-locked-ordinary-write",
        source: "chat",
        sourceId: recoveryCanary,
        idempotencyKey: "idem-locked-ordinary-write",
        profileId: "profile-recovery",
        workspace: null,
      }),
      (error) => error.code === "STORE_SENSITIVE_VALUE_CHECK_FAILED"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(recoveryCanary),
    );
  } finally {
    await second.stop({ notify: false });
  }

  const afterSecond = JSON.parse(fs.readFileSync(paths.stateSnapshotPath, "utf8"));
  const recoveredSeq = new Map(afterSecond.workRuns.map((run) => [run.id, run.eventSeq]));
  let thirdReady = false;
  const thirdStore = new JsonlProductStore({ paths, now: () => 7_000 });
  const third = createAgentService({
    paths,
    version: "recovery",
    productStore: thirdStore,
    safeStorage,
    onServerReady() {
      thirdReady = true;
      for (const [id, seq] of recoveredSeq) assert.equal(thirdStore.getWorkRun(id).eventSeq, seq);
    },
  });
  await third.start();
  try {
    assert.equal(thirdReady, true);
  } finally {
    await third.stop({ notify: false });
  }
});

test("Darwin 合法长用户名下 socket 路径仍低于 sockaddr_un 上限", () => {
  const longHome = `/Users/${"x".repeat(31)}`;
  const paths = resolveServicePaths({ homeDir: longHome });
  assert.equal(Buffer.byteLength(paths.socketPath) < 104, true, paths.socketPath);
});

test("Electron utility 入口在 ready 前建立并注入独立 profile/cache", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-electron-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const calls = [];
  const electronApp = {
    isPackaged: true,
    setActivationPolicy(policy) { calls.push(["activation", policy]); },
    dock: { hide() { calls.push(["dock-hide"]); } },
    setPath(name, target) {
      assert.equal(fs.statSync(target).isDirectory(), true, `${name} 注入前目录必须存在`);
      calls.push(["setPath", name, target]);
    },
    async whenReady() { calls.push(["ready"]); },
    async resolveProxy(url) {
      assert.equal(this, electronApp);
      calls.push(["resolve-proxy", url]);
      return "PROXY 127.0.0.1:7897";
    },
    quit() { calls.push(["quit"]); },
  };
  const runtimePool = {
    get() { assert.fail("Service 不应在没有 Work Run 时 spawn Codex runtime"); },
    async stopAll() { calls.push(["runtime-stop"]); },
  };
  const electronSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.from(value, "utf8").reverse(); },
    decryptString(value) { return Buffer.from(value).reverse().toString("utf8"); },
  };
  const hostHome = path.join(root, "home");
  const downloads = path.join(hostHome, "Downloads");
  fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const electronShell = {
    async openPath(target) { calls.push(["host-open-path", target]); return ""; },
    async openExternal(target) { calls.push(["host-open-url", target]); },
    showItemInFolder(target) { calls.push(["host-select", target]); },
  };
  const service = await startAgentServiceProcess({
    paths,
    electronApp,
    version: "fixture",
    runtimePool,
    safeStorage: electronSafeStorage,
    resourcesPath: path.join(root, "Resources"),
    platform: "darwin",
    shell: electronShell,
    homeDirectory: hostHome,
    folderRoots: [hostHome],
  });
  try {
    assert.deepEqual(calls.slice(0, 6).map((call) => call[0] === "setPath" ? call[1] : call[0]), [
      "activation", "userData", "sessionData", "cache", "ready", "dock-hide",
    ]);
    assert.deepEqual(calls[0], ["activation", "prohibited"]);
    assert.equal(calls[1][2], paths.profileDir);
    assert.equal(calls[3][2], paths.cacheDir);
    assert.equal(typeof service.grokBuildRuntimePool.options.resolveProxy, "function");
    assert.equal(
      await service.grokBuildRuntimePool.options.resolveProxy("https://cli-chat-proxy.grok.com/v1/responses"),
      "PROXY 127.0.0.1:7897",
    );
    assert.deepEqual(calls.find((call) => call[0] === "resolve-proxy"), [
      "resolve-proxy", "https://cli-chat-proxy.grok.com/v1/responses",
    ]);
    await service.secretStore.put(
      "credential-electron-adapter",
      "electron-safe-storage-canary-0001",
      { kind: "openrouter" },
    );
    assert.equal(
      await service.secretStore.get("credential-electron-adapter"),
      "electron-safe-storage-canary-0001",
    );
    assert.deepEqual(await service.systemHostController.openFolder({
      path: "~/Downloads", select: null,
    }), { path: downloads, selected: null, opened: true });
    assert.deepEqual(await service.systemHostController.openUrl({
      url: "https://example.com/",
    }), { url: "https://example.com/", opened: true });
    assert.equal(calls.some((call) => call[0] === "host-open-path" && call[1] === downloads), true);
    assert.equal(calls.some((call) => call[0] === "host-open-url" && call[1] === "https://example.com/"), true);
  } finally {
    await service.stop({ notify: false });
  }
  assert.equal(calls.some((call) => call[0] === "runtime-stop"), true);
});

test("Computer Use 随 Service 生命周期启停，锁屏与睡眠只暂停且解锁不自动恢复", async () => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync("/tmp/sgcu-");
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const electronApp = new EventEmitter();
  electronApp.isPackaged = false;
  electronApp.setActivationPolicy = () => {};
  electronApp.dock = { hide() {} };
  electronApp.setPath = () => {};
  electronApp.whenReady = async () => {};
  electronApp.quit = () => {};
  const powerMonitor = new EventEmitter();
  powerMonitor.getSystemIdleTime = () => 100;
  const lifecycle = [];
  const unavailable = async () => { throw new Error("not used"); };
  const computerUseController = {
    open: async () => { lifecycle.push("open"); },
    close: async () => { lifecycle.push("close"); },
    status: async () => ({
      available: true, driverVersion: "0.22.0", contractVersion: "0.7.0",
      permissions: { accessibility: true, screenRecording: true }, sessions: [],
    }),
    list: () => [],
    closeForProfile: async () => {},
    closeForWorkRun: async () => {},
    pauseAll: (reason) => lifecycle.push(`pause:${reason}`),
    create: unavailable,
    resume: unavailable,
    closeSession: unavailable,
    applicationList: unavailable,
    windowList: unavailable,
    snapshot: unavailable,
    focus: unavailable,
    action: unavailable,
  };
  const service = await startAgentServiceProcess({
    paths, electronApp, powerMonitor, computerUseController, version: "computer-lifecycle-fixture",
  });
  try {
    assert.deepEqual(lifecycle, ["open"]);
    powerMonitor.emit("lock-screen");
    powerMonitor.emit("unlock-screen");
    powerMonitor.emit("suspend");
    assert.deepEqual(lifecycle, ["open", "pause:screen_locked", "pause:system_suspended"]);
  } finally {
    await service.stop({ notify: false });
  }
  assert.deepEqual(lifecycle, ["open", "pause:screen_locked", "pause:system_suspended", "close"]);
  assert.equal(powerMonitor.listenerCount("lock-screen"), 0);
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 0);
  assert.equal(powerMonitor.listenerCount("suspend"), 0);
});

test("后台 Service 收到 macOS activate 时单飞拉起独立 UI，停止后解除监听", async () => {
  const { EventEmitter } = require("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-service-activate-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const electronApp = new EventEmitter();
  electronApp.isPackaged = true;
  electronApp.setPath = () => {};
  electronApp.whenReady = async () => {};
  electronApp.quit = () => {};
  const firstOpen = deferred();
  let openCalls = 0;
  const service = await startAgentServiceProcess({
    paths,
    electronApp,
    version: "activate-fixture",
    openUiApp() {
      openCalls += 1;
      return openCalls === 1 ? firstOpen.promise : Promise.resolve();
    },
  });
  try {
    electronApp.emit("activate");
    electronApp.emit("activate");
    await waitFor(() => openCalls === 1);
    firstOpen.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    electronApp.emit("activate");
    await waitFor(() => openCalls === 2);
  } finally {
    await service.stop({ notify: false });
  }
  assert.equal(electronApp.listenerCount("activate"), 0);
  electronApp.emit("activate");
  assert.equal(openCalls, 2);
});

test("SIGTERM/SIGINT 清理失败采用确定非零退出且不产生 unhandled rejection", async () => {
  const { EventEmitter } = require("node:events");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const root = fs.mkdtempSync("/tmp/sgsig-");
    const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
    const signalEmitter = new EventEmitter();
    const exitCodes = [];
    const shutdownErrors = [];
    const processFaults = [];
    const onUnhandled = (error) => processFaults.push(error);
    process.on("unhandledRejection", onUnhandled);
    const service = await startAgentServiceProcess({
      paths,
      version: "fixture",
      signalEmitter,
      exitOnStop: true,
      exitProcess(code) { exitCodes.push(code); },
      onShutdownError(error) { shutdownErrors.push(error); },
      cleanupFs: {
        closeSync(fd) { fs.closeSync(fd); throw new Error(`fixture ${signal} close failure`); },
        unlinkSync: fs.unlinkSync.bind(fs),
      },
    });
    try {
      signalEmitter.emit(signal);
      await waitFor(() => exitCodes.length === 1, 500);
      assert.deepEqual(exitCodes, [1]);
      assert.equal(shutdownErrors.length, 1);
      assert.equal(shutdownErrors[0].code, "SERVICE_STOP_FAILED");
      assert.equal(fs.existsSync(paths.lockPath), false);
      assert.deepEqual(processFaults, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await service.stop({ notify: false }).catch(() => {});
    }
  }
});

test("hello/status 完成认证与版本握手，事件支持 afterSeq cursor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-svc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "9.9.9" });
  await service.start();
  try {
    const token = readClientToken(paths);
    const hello = await requestService(paths, { method: "service.hello", token, version: PROTOCOL_VERSION });
    assert.deepEqual(hello, { protocolVersion: PROTOCOL_VERSION, serviceVersion: "9.9.9" });
    const status = await requestService(paths, { method: "service.status", token, version: PROTOCOL_VERSION });
    assert.equal(status.healthy, true);
    assert.equal(status.pid, process.pid);
    const first = service.appendEvent("fixture.first", { value: 1 });
    service.appendEvent("fixture.second", { value: 2 });
    const events = await requestService(paths, {
      method: "events.subscribe", token, version: PROTOCOL_VERSION, params: { afterSeq: first.seq },
    });
    assert.deepEqual(events.events.map((event) => event.type), ["fixture.second"]);
    assert.equal(events.cursor, first.seq + 1);
  } finally {
    await service.stop();
  }
});

test("Runtime MCP bridge 同 socket 升级、内部续期不泄露且 close/stop 精确撤销", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-mcp-bridge-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const issuedTokens = [];
  const revokedSessions = [];
  let manager = null;
  let gateConsumes = 0;
  const service = createAgentService({
    paths,
    version: "mcp-bridge",
    frameTimeoutMs: 1_000,
    closeTimeoutMs: 1_000,
    mcpSessionTtlMs: 1_000,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => Buffer.from(value).toString("utf8"),
    },
    runtimeMcpGateIssuer: {
      open() { return this; },
      close() {},
      createMcpServer() { throw new Error("not used"); },
      consume() { gateConsumes += 1; return { consumed: true }; },
    },
    mcpSessionManagerFactory(options) {
      manager = new McpSessionManager(options);
      return {
        issueChallenge: manager.issueChallenge.bind(manager),
        exchangeChallenge: manager.exchangeChallenge.bind(manager),
        authorizeSession: manager.authorizeSession.bind(manager),
        issueBridgeSession(binding) {
          const session = manager.issueBridgeSession(binding);
          issuedTokens.push(session.token);
          return session;
        },
        revokeSession(request) {
          revokedSessions.push(structuredClone(request));
          return manager.revokeSession(request);
        },
        close: manager.close.bind(manager),
      };
    },
  });
  let first = null;
  let second = null;
  await service.start();
  const profileValue = service.productStore.listAgentProfiles()[0];
  const { runtimeProfileId, runtimeAccountId } = profileValue;
  const bridgeRequest = (suffix) => ({
    version: PROTOCOL_VERSION,
    method: "mcp.runtime.bridge.open",
    params: {
      runtimeProfileId,
      runtimeAccountId,
      gatePath: path.join(paths.runtimeDir, `${suffix}.gate`),
      nonce: suffix.repeat(64).slice(0, 64),
      parentPid: process.pid,
    },
  });
  try {
    const ordinary = await rawJsonRequest(paths.socketPath, {
      id: "ordinary-status",
      token: readClientToken(paths),
      version: PROTOCOL_VERSION,
      method: "service.status",
    });
    assert.equal(ordinary.response.ok, true);
    assert.equal(ordinary.frameCount, 1);
    assert.equal(ordinary.tailBytes, 0);

    first = await openJsonlConversation(paths.socketPath);
    await first.send(bridgeRequest("a"));
    assert.deepEqual(await first.nextFrame(), { ok: true, result: { bridged: true } });
    assert.equal(first.isClosed(), false);
    assert.equal(issuedTokens.length, 1);

    await first.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "bridge-fixture", version: "1" },
      },
    });
    const initialized = await first.nextFrame();
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.protocolVersion, MCP_STDIO_PROTOCOL_VERSION);

    await first.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "cron_delete",
        arguments: { jobId: "00000000-0000-4000-8000-000000000000" },
        confirmation: true,
      },
    });
    const forgedConfirmation = await first.nextFrame();
    assert.equal(forgedConfirmation.id, 2);
    assert.equal(forgedConfirmation.error.code, -32602);
    await first.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: {
        name: "cron_delete",
        arguments: { jobId: "00000000-0000-4000-8000-000000000000" },
        _meta: { confirmation: true },
      },
    });
    const forgedConfirmationMeta = await first.nextFrame();
    assert.equal(forgedConfirmationMeta.id, 3);
    assert.equal(forgedConfirmationMeta.result.isError, true);
    assert.equal(issuedTokens.length, 1, "Grok 提供的 confirmation 数据不得触发授权调用");

    await first.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "profile_get", arguments: {} },
    });
    const profileResponse = await first.nextFrame();
    assert.equal(profileResponse.id, 4);
    assert.equal(profileResponse.result.isError, false);
    assert.equal(profileResponse.result.structuredContent.runtimeProfileId, runtimeProfileId);
    assert.equal(issuedTokens.length, 2, "首个 tool call 应在 Service 内部安全续期");
    assert.notEqual(issuedTokens[0], issuedTokens[1]);
    for (const internalToken of issuedTokens) {
      assert.equal(first.receivedText().includes(internalToken), false);
    }

    first.end();
    await first.waitClosed();
    await waitFor(() => revokedSessions.length === 1);
    assert.deepEqual(revokedSessions[0], {
      runtimeProfileId, runtimeAccountId, token: issuedTokens[1],
    });
    assert.throws(
      () => manager.authorizeSession({ runtimeProfileId, runtimeAccountId, token: issuedTokens[1] }),
      (error) => error.code === "MCP_SESSION_INVALID",
    );

    second = await openJsonlConversation(paths.socketPath);
    await second.send(bridgeRequest("b"));
    assert.deepEqual(await second.nextFrame(), { ok: true, result: { bridged: true } });
    const secondToken = issuedTokens.at(-1);
    const stopping = service.stop({ notify: false });
    const stoppedInTime = await Promise.race([
      stopping.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 80)),
    ]);
    await stopping;
    await second.waitClosed();
    assert.equal(stoppedInTime, true, "bridge 长连接不得进入普通 one-request drain");
    assert.deepEqual(revokedSessions.at(-1), { runtimeProfileId, runtimeAccountId, token: secondToken });
    assert.equal(gateConsumes, 2);
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(fs.existsSync(paths.tokenPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    first?.destroy();
    second?.destroy();
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("错误 token/版本/未知方法均拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-svc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    const token = readClientToken(paths);
    await assert.rejects(
      requestService(paths, { method: "service.status", token: "wrong", version: PROTOCOL_VERSION }),
      (error) => error.code === "AUTH_FAILED",
    );
    await assert.rejects(
      requestService(paths, { method: "service.status", token, version: PROTOCOL_VERSION + 1 }),
      (error) => error.code === "PROTOCOL_VERSION_MISMATCH",
    );
    await assert.rejects(
      requestService(paths, { method: "no.such.method", token, version: PROTOCOL_VERSION }),
      (error) => error.code === "UNKNOWN_METHOD",
    );
  } finally {
    await service.stop();
  }
});

test("malformed/oversize 帧 fail closed，请求 timeout 有界", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-svc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    const malformed = await rawFrame(paths.socketPath, "{broken\n");
    assert.match(malformed, /MALFORMED_JSON/);
    const oversized = await rawFrame(paths.socketPath, `${"x".repeat(MAX_FRAME_BYTES + 1)}\n`);
    assert.match(oversized, /FRAME_TOO_LARGE/);
  } finally {
    await service.stop();
  }

  const timeoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-timeout-"));
  const timeoutPaths = resolveServicePaths({ stateRoot: path.join(timeoutRoot, "state"), cacheRoot: path.join(timeoutRoot, "cache") });
  fs.mkdirSync(timeoutPaths.runtimeDir, { recursive: true, mode: 0o700 });
  const hangingSockets = new Set();
  const hanging = net.createServer((socket) => {
    hangingSockets.add(socket);
    socket.on("close", () => hangingSockets.delete(socket));
  });
  await new Promise((resolve, reject) => hanging.listen(timeoutPaths.socketPath, (error) => error ? reject(error) : resolve()));
  fs.chmodSync(timeoutPaths.socketPath, 0o600);
  try {
    await assert.rejects(
      requestService(timeoutPaths, { method: "service.status", token: "x", version: PROTOCOL_VERSION }, { timeoutMs: 40 }),
      (error) => error.code === "REQUEST_TIMEOUT",
    );
  } finally {
    for (const socket of hangingSockets) socket.destroy();
    await new Promise((resolve) => hanging.close(resolve));
  }
});

test("未认证空闲连接不能阻塞 Service stop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-stop-idle-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test", frameTimeoutMs: 1000 });
  await service.start();
  const idle = net.createConnection(paths.socketPath);
  await new Promise((resolve, reject) => {
    idle.once("connect", resolve);
    idle.once("error", reject);
  });
  const stopPromise = service.stop();
  const stoppedInTime = await Promise.race([
    stopPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 80)),
  ]);
  idle.destroy();
  await stopPromise;
  assert.equal(stoppedInTime, true, "stop 必须先断开 accepted sockets 再等待 server.close");
});

test("stop 分阶段 best-effort 聚合主错误与清理错误，失败后仍释放 lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-stop-errors-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  let socketIdentity = null;
  const cleanupFs = {
    closeSync(fd) {
      fs.closeSync(fd);
      throw new Error("fixture lock close failure");
    },
    unlinkSync(target) {
      if (target === paths.socketPath) throw new Error("fixture socket unlink failure");
      return fs.unlinkSync(target);
    },
    lstatIfExists(target) {
      if (target === paths.socketPath) return socketIdentity;
      try { return fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
  };
  const service = createAgentService({
    paths,
    version: "test",
    cleanupFs,
    onStop() { throw new Error("fixture primary stop failure"); },
  });
  await service.start();
  socketIdentity = fs.lstatSync(paths.socketPath);
  try {
    await assert.rejects(service.stop(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.code, "SERVICE_STOP_FAILED");
      const detail = error.errors.map((item) => item.message).join("\n");
      assert.match(detail, /socket unlink failure/);
      assert.match(detail, /lock close failure/);
      assert.match(detail, /primary stop failure/);
      return true;
    });
    assert.equal(fs.existsSync(paths.lockPath), false, "前序清理失败不得跳过 lock unlink");
  } finally {
    try { fs.unlinkSync(paths.socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
});

test("stop 对永不回调的 server.close 有界并继续清理 lock", async () => {
  const root = fs.mkdtempSync("/tmp/sgclose-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  let runtimeServer = null;
  let releaseClose = null;
  const service = createAgentService({
    paths,
    version: "test",
    closeTimeoutMs: 30,
    onServerReady(server) {
      runtimeServer = server;
      const realClose = server.close.bind(server);
      server.close = (callback) => { releaseClose = () => realClose(callback); return server; };
    },
  });
  await service.start();
  const stopPromise = service.stop();
  const outcome = await Promise.race([
    stopPromise.then(() => ({ ok: true }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 80)),
  ]);
  try {
    assert.equal(outcome.timeout, undefined, "server.close 不回调不能永久阻塞 stop");
    assert.equal(outcome.error instanceof AggregateError, true);
    assert.equal(outcome.error.errors.some((error) => error.code === "SERVICE_CLOSE_TIMEOUT"), true);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    if (releaseClose) releaseClose();
    await stopPromise.catch(() => {});
    runtimeServer?.removeAllListeners();
  }
});

test("accepted socket ECONNRESET/EPIPE 只清理连接，不升级成未捕获异常", () => {
  const { EventEmitter } = require("node:events");
  const socket = new EventEmitter();
  let destroyed = 0;
  let cleaned = 0;
  socket.destroy = () => { destroyed += 1; };
  attachAcceptedSocketErrorGuard(socket, () => { cleaned += 1; });
  assert.doesNotThrow(() => socket.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })));
  assert.deepEqual({ destroyed, cleaned }, { destroyed: 1, cleaned: 1 });
});

test("监听期 server error 进入受控 shutdown，无进程级未捕获且释放资源", async () => {
  const root = fs.mkdtempSync("/tmp/sgrt-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  let runtimeServer = null;
  const runtimeFaults = [];
  const processFaults = [];
  const onUncaught = (error) => processFaults.push(error);
  const onUnhandled = (error) => processFaults.push(error);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  const service = createAgentService({
    paths,
    version: "test",
    onServerReady(server) { runtimeServer = server; },
    onRuntimeError(error, cleanupError) { runtimeFaults.push({ error, cleanupError }); },
  });
  try {
    await service.start();
    assert.ok(runtimeServer, "测试必须观测真实 active net.Server");
    assert.doesNotThrow(() => runtimeServer.emit("error", new Error("fixture runtime server failure")));
    await waitFor(() => !fs.existsSync(paths.socketPath) && !fs.existsSync(paths.lockPath));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processFaults.length, 0);
    assert.equal(runtimeFaults.length, 1);
    assert.match(runtimeFaults[0].error.message, /fixture runtime server failure/);
    assert.equal(runtimeFaults[0].cleanupError, null);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    await service.stop({ notify: false }).catch(() => {});
  }
});

test("首帧与半帧都有服务端有界 timer，EOF 非空 tail 明确拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-frame-timeout-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test", frameTimeoutMs: 40 });
  await service.start();
  try {
    const firstFrame = await idleSocketResult(paths.socketPath);
    assert.match(firstFrame, /FRAME_TIMEOUT/);

    const partialPromise = rawFrame(paths.socketPath, "{\"id\":");
    const partial = await Promise.race([
      partialPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("半帧 timer 未触发")), 300)),
    ]);
    assert.match(partial, /FRAME_TIMEOUT/);

    const eofBody = await new Promise((resolve, reject) => {
      const socket = net.createConnection(paths.socketPath);
      let body = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.end("{\"id\":"));
      socket.on("data", (chunk) => { body += chunk; });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    assert.match(eofBody, /INCOMPLETE_FRAME/);
  } finally {
    await service.stop();
  }
});

test("events.subscribe 仅缺省 afterSeq 才从 0 开始，非法 cursor 返回 INVALID_PARAMS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cursor-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    const token = readClientToken(paths);
    for (const afterSeq of [-1, 1.5, "0", null]) {
      await assert.rejects(
        requestService(paths, {
          method: "events.subscribe", token, version: PROTOCOL_VERSION, params: { afterSeq },
        }),
        (error) => error.code === "INVALID_PARAMS",
      );
    }
    const omitted = await requestService(paths, {
      method: "events.subscribe", token, version: PROTOCOL_VERSION, params: {},
    });
    assert.match(omitted.streamId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(omitted, {
      streamId: omitted.streamId,
      events: [], cursor: 0, nextCursor: 0, hasMore: false,
      oldestSeq: 1, baseSeq: 0, latestSeq: 0, gap: null, snapshot: null,
    });
  } finally {
    await service.stop();
  }
});

test("单个业务事件编码超过出站预算时 appendEvent fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-event-limit-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  assert.throws(
    () => service.appendEvent("fixture.large", { text: "界".repeat(24 * 1024) }),
    (error) => error.code === "EVENT_TOO_LARGE",
  );
});

test("appendEvent 保存深不可变 JSON 快照，原 payload 扩容不影响分页进展", () => {
  const buffer = createEventBuffer(MAX_FRAME_BYTES);
  const original = { nested: { text: "small" } };
  const event = buffer.append("fixture.snapshot", original);
  original.nested.text = "x".repeat(70 * 1024);

  const page = buffer.page(0, "fixture");
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].payload.nested.text, "small");
  assert.equal(page.cursor, event.seq);
  assert.equal(page.nextCursor, event.seq);
  assert.equal(page.hasMore, false);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen(event.payload.nested), true);
});

test("Event ring exposes a stable per-instance stream identity", () => {
  const first = createEventBuffer(MAX_FRAME_BYTES);
  const second = createEventBuffer(MAX_FRAME_BYTES);
  const firstStreamId = first.page(0, "fixture").streamId;
  assert.match(firstStreamId, /^[0-9a-f-]{36}$/u);
  assert.equal(first.page(0, "fixture-again").streamId, firstStreamId);
  assert.notEqual(second.page(0, "fixture").streamId, firstStreamId);
  assert.throws(
    () => createEventBuffer(MAX_FRAME_BYTES, { streamId: "not-a-uuid" }),
    /streamId/u,
  );
});

test("appendEvent 后原 payload 改成 circular 不影响稳定分页快照", () => {
  const buffer = createEventBuffer(MAX_FRAME_BYTES);
  const original = { value: "before" };
  const event = buffer.append("fixture.circular-mutation", original);
  original.self = original;
  const page = buffer.page(0, "fixture");
  assert.deepEqual(page.events[0].payload, { value: "before" });
  assert.equal(page.cursor, event.seq);
  assert.equal(page.hasMore, false);
});

test("appendEvent 明确拒绝初始 circular 与不可 JSON payload", () => {
  const buffer = createEventBuffer(MAX_FRAME_BYTES);
  const circular = {};
  circular.self = circular;
  for (const payload of [circular, { value: 1n }, { value: undefined }]) {
    assert.throws(
      () => buffer.append("fixture.invalid", payload),
      (error) => error.code === "INVALID_EVENT",
    );
  }
});

test("Event ring 同时按事件数与总字节高水位逐项淘汰并保持内存有界", () => {
  const countRing = createEventBuffer(MAX_FRAME_BYTES, { maxEvents: 3, maxTotalBytes: 1024 * 1024 });
  for (let index = 1; index <= 5; index += 1) countRing.append("fixture.count", { index });
  assert.deepEqual(countRing.stats(), {
    count: 3,
    totalBytes: countRing.stats().totalBytes,
    oldestSeq: 3,
    baseSeq: 2,
    latestSeq: 5,
    maxEvents: 3,
    maxTotalBytes: 1024 * 1024,
  });

  const byteRing = createEventBuffer(MAX_FRAME_BYTES, { maxEvents: 100, maxTotalBytes: 700 });
  let priorBase = 0;
  let sawSingleEviction = false;
  for (let index = 1; index <= 8; index += 1) {
    byteRing.append("fixture.bytes", { index, text: "x".repeat(180) });
    const stats = byteRing.stats();
    assert.equal(stats.totalBytes <= stats.maxTotalBytes, true);
    assert.equal(stats.count <= stats.maxEvents, true);
    if (stats.baseSeq === priorBase + 1) sawSingleEviction = true;
    priorBase = stats.baseSeq;
  }
  assert.equal(sawSingleEviction, true, "总字节高水位必须按最旧事件逐项淘汰");
  assert.equal(byteRing.stats().baseSeq > 0, true);
});

test("Event ring 陈旧 afterSeq 返回 cursor gap snapshot/baseSeq，再从新 base 继续分页", () => {
  const ring = createEventBuffer(MAX_FRAME_BYTES, { maxEvents: 2, maxTotalBytes: 1024 * 1024 });
  ring.append("fixture.one", { value: 1 });
  ring.append("fixture.two", { value: 2 });
  ring.append("fixture.three", { value: 3 });
  const gap = ring.page(0, "fixture");
  assert.match(gap.streamId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(gap, {
    streamId: gap.streamId,
    events: [],
    cursor: 1,
    nextCursor: 1,
    hasMore: true,
    oldestSeq: 2,
    baseSeq: 1,
    latestSeq: 3,
    gap: { code: "CURSOR_GAP", requestedAfterSeq: 0, baseSeq: 1, oldestSeq: 2 },
    snapshot: { kind: "cursor-reset", baseSeq: 1, latestSeq: 3 },
  });
  const resumed = ring.page(gap.nextCursor, "fixture");
  assert.deepEqual(resumed.events.map((event) => event.seq), [2, 3]);
  assert.equal(resumed.gap, null);
  assert.equal(resumed.snapshot, null);
  assert.equal(resumed.cursor, 3);
});

test("handleRequest 内部异常返回固定有界 INTERNAL_ERROR 且 Service 保持健康", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-internal-error-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const secret = "private-internal-stack-detail";
  const service = createAgentService({
    paths,
    version: "test",
    eventBuffer: {
      append() { throw new Error("unused"); },
      page() { throw new Error(secret); },
    },
  });
  await service.start();
  try {
    const token = readClientToken(paths);
    await assert.rejects(
      requestService(paths, {
        method: "events.subscribe", token, version: PROTOCOL_VERSION, params: { afterSeq: 0 },
      }),
      (error) => error.code === "INTERNAL_ERROR" && !error.message.includes(secret),
    );
    const hello = await requestService(paths, {
      method: "service.hello", token, version: PROTOCOL_VERSION,
    });
    assert.equal(hello.serviceVersion, "test");
  } finally {
    await service.stop({ notify: false });
  }
});

test("events.subscribe 按完整 JSONL 字节预算分页且每页可由 client 连续读取", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-event-pages-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    const token = readClientToken(paths);
    const expected = [];
    for (let index = 0; index < 24; index += 1) {
      expected.push(service.appendEvent("fixture.page", { index, text: "x".repeat(4096) }).seq);
    }
    const received = [];
    let afterSeq = 0;
    let pages = 0;
    while (true) {
      const raw = await rawJsonRequest(paths.socketPath, {
        id: "fixture",
        method: "events.subscribe", token, version: PROTOCOL_VERSION, params: { afterSeq },
      });
      assert.equal(raw.bytes <= MAX_FRAME_BYTES, true, `响应 ${raw.bytes} bytes 超过预算`);
      assert.equal(raw.frameCount, 1);
      assert.equal(raw.tailBytes, 0);
      assert.equal(raw.response.ok, true);
      const page = raw.response.result;
      pages += 1;
      assert.equal(Number.isSafeInteger(page.cursor), true);
      assert.equal(page.nextCursor, page.cursor);
      assert.equal(typeof page.hasMore, "boolean");
      received.push(...page.events.map((event) => event.seq));
      afterSeq = page.nextCursor;
      if (!page.hasMore) break;
      assert.equal(pages < 20, true, "分页 cursor 必须前进");
    }
    assert.equal(pages > 1, true, "事件必须被 64KiB JSONL 预算切成多页");
    assert.deepEqual(received, expected);
  } finally {
    await service.stop();
  }
});

test("旧 schema 升级会先清理 stale socket，重复启动仍保持单实例", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-svc-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.stateDir, "chat-sessions.json"), JSON.stringify({
    version: CHAT_SESSION_STORE_VERSION - 1,
    revision: 0,
    idempotencyFloorMs: 0,
    sessions: {},
    createOperations: {},
    bindingOperations: {},
    remoteOperations: {},
  }), { mode: 0o600 });
  fs.writeFileSync(paths.socketPath, "stale", { mode: 0o600 });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    assert.equal(fs.existsSync(path.join(
      paths.backupsDir, PRE_RUNTIME_SCHEMA_BACKUP_ID, "manifest.json",
    )), true);
    const duplicate = createAgentService({ paths, version: "test" });
    await assert.rejects(duplicate.start(), (error) => error.code === "SERVICE_ALREADY_RUNNING");
    const status = await requestService(paths, {
      method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
    });
    assert.equal(status.healthy, true);
  } finally {
    await service.stop();
  }
});

test("未取得 lock 的重复实例 stop 不得删除运行中 Service 的 socket/token", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-nonowner-stop-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const first = createAgentService({ paths, version: "first" });
  let nonOwnerStopNotifications = 0;
  const second = createAgentService({
    paths,
    version: "second",
    lockProbeTimeoutMs: 100,
    onStop: () => { nonOwnerStopNotifications += 1; },
  });
  await first.start();
  try {
    const tokenBefore = fs.readFileSync(paths.tokenPath, "utf8");
    const socketBefore = fs.lstatSync(paths.socketPath);
    await assert.rejects(second.start(), (error) => error.code === "SERVICE_ALREADY_RUNNING");
    await second.stop();
    assert.equal(nonOwnerStopNotifications, 0, "未持有实例的 stop 必须完整 no-op");
    const socketAfter = fs.lstatSync(paths.socketPath);
    assert.equal(socketAfter.dev, socketBefore.dev);
    assert.equal(socketAfter.ino, socketBefore.ino);
    assert.equal(fs.readFileSync(paths.tokenPath, "utf8"), tokenBefore);
    const hello = await requestService(paths, {
      method: "service.hello", token: readClientToken(paths), version: PROTOCOL_VERSION,
    });
    assert.equal(hello.serviceVersion, "first");
  } finally {
    await second.stop({ notify: false }).catch(() => {});
    await first.stop({ notify: false });
  }
});

test("Service lock 记录 nonce+进程启动身份并与认证 status 对应", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lock-record-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test", getProcessIdentity: () => "fixture-start-identity" });
  await service.start();
  try {
    const record = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    assert.equal(record.pid, process.pid);
    assert.equal(record.startIdentity, "fixture-start-identity");
    assert.match(record.nonce, /^[a-f0-9]{32,}$/);
    assert.deepEqual(Object.keys(record).sort(), ["createdAt", "nonce", "pid", "startIdentity"]);
    assert.equal(Number.isSafeInteger(record.createdAt), true);
    const status = await requestService(paths, {
      method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
    });
    assert.equal(status.instanceNonce, record.nonce);
  } finally {
    await service.stop();
  }
});

test("listen 后 lock inode/内容保持不可变，竞争实例只能安全拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lock-immutable-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"),
  });
  const lockFs = Object.create(fs);
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalFtruncateSync = fs.ftruncateSync;
  let ownedLockFd = null;
  let initialLockIdentity = null;
  let initialLockContents = null;
  let liveLockTruncateCalls = 0;
  lockFs.openSync = (target, ...args) => {
    const fd = originalOpenSync(target, ...args);
    if (target === paths.lockPath) ownedLockFd = fd;
    return fd;
  };
  lockFs.fsyncSync = (fd) => {
    originalFsyncSync(fd);
    if (fd === ownedLockFd && initialLockContents === null) {
      initialLockIdentity = fs.fstatSync(fd);
      initialLockContents = fs.readFileSync(paths.lockPath, "utf8");
    }
  };
  fs.ftruncateSync = (fd, ...args) => {
    if (fd === ownedLockFd) {
      liveLockTruncateCalls += 1;
      throw new Error("fixture forbids live lock truncation");
    }
    return originalFtruncateSync(fd, ...args);
  };

  const owner = createAgentService({
    paths, version: "owner", lockFs, lockProbeTimeoutMs: 100,
    getProcessIdentity: () => "fixture-start-identity",
  });
  const contenders = Array.from({ length: 12 }, (_, index) => createAgentService({
    paths, version: `contender-${index}`, lockProbeTimeoutMs: 100,
    getProcessIdentity: () => "fixture-start-identity",
  }));
  try {
    await owner.start();
    assert.equal(liveLockTruncateCalls, 0);
    const record = JSON.parse(initialLockContents);
    const before = fs.lstatSync(paths.lockPath);
    assert.deepEqual([before.dev, before.ino], [initialLockIdentity.dev, initialLockIdentity.ino]);
    assert.equal(fs.readFileSync(paths.lockPath, "utf8"), initialLockContents);

    const settled = await Promise.allSettled(contenders.map((service) => service.start()));
    assert.equal(settled.every((result) => result.status === "rejected"), true);
    for (const result of settled) {
      assert.equal(
        ["SERVICE_ALREADY_RUNNING", "SERVICE_LOCK_INDETERMINATE"].includes(result.reason.code),
        true,
      );
    }
    const after = fs.lstatSync(paths.lockPath);
    const afterContents = fs.readFileSync(paths.lockPath, "utf8");
    assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
    assert.equal(afterContents, initialLockContents);
    assert.equal(JSON.parse(afterContents).nonce, record.nonce);
  } finally {
    fs.ftruncateSync = originalFtruncateSync;
    await Promise.all(contenders.map((service) => service.stop({ notify: false }).catch(() => {})));
    await owner.stop({ notify: false }).catch(() => {});
  }
});

test("活 PID 的 legacy lock 无强身份凭据时必须有界 fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-live-stale-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.lockPath, `${process.pid}\n`, { mode: 0o600 });
  const service = createAgentService({
    paths,
    version: "test",
    getProcessIdentity: () => "fixture-start-identity",
    lockProbeTimeoutMs: 50,
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(
      service.start(),
      (error) => error.code === "SERVICE_LOCK_INDETERMINATE",
    );
    assert.equal(Date.now() - startedAt < 500, true, "fail closed 必须有界");
    assert.equal(fs.readFileSync(paths.lockPath, "utf8"), `${process.pid}\n`);
  } finally {
    await service.stop({ notify: false });
  }
});

test("活 PID 仅在启动身份明确不匹配时按 PID reuse 回收 stale lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pid-reuse-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.lockPath, `${JSON.stringify({
    pid: process.pid, nonce: "old-nonce", startIdentity: "old-process-start",
  })}\n`, { mode: 0o600 });
  const service = createAgentService({
    paths,
    version: "test",
    getProcessIdentity: () => "current-process-start",
    lockProbeTimeoutMs: 40,
  });
  await service.start();
  try {
    const record = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    assert.equal(record.startIdentity, "current-process-start");
    assert.notEqual(record.nonce, "old-nonce");
  } finally {
    await service.stop({ notify: false });
  }
});

test("并发启动竞态只能有一个 Service 获得 lock，另一方认证探测后拒绝", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-lock-race-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const first = createAgentService({ paths, version: "test", lockProbeTimeoutMs: 1_500 });
  const second = createAgentService({ paths, version: "test", lockProbeTimeoutMs: 1_500 });
  const settled = await Promise.allSettled([first.start(), second.start()]);
  const successes = settled.filter((item) => item.status === "fulfilled");
  const failures = settled.filter((item) => item.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.code, "SERVICE_ALREADY_RUNNING");
  await first.stop().catch(() => {});
  await second.stop().catch(() => {});
});

test("真实 Service 被 SIGSTOP 时第二实例 fail closed 且不改写 IPC", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-sigstop-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const fixture = path.join(ROOT, "scripts", "fixtures", "shoggoth-agent-service-fixture.cjs");
  const child = spawn(process.execPath, [fixture, JSON.stringify(paths)], { stdio: ["ignore", "pipe", "pipe"] });
  let resumed = false;
  const second = createAgentService({ paths, version: "second", lockProbeTimeoutMs: 80 });
  try {
    await waitForHealthyService(paths);
    const tokenBefore = fs.readFileSync(paths.tokenPath, "utf8");
    const socketBefore = fs.lstatSync(paths.socketPath);
    const lockBeforeStop = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    assert.equal(
      defaultProcessIdentity(child.pid),
      lockBeforeStop.startIdentity,
      "SIGSTOP 前 lock 必须使用相同的不可变进程启动身份",
    );
    process.kill(child.pid, "SIGSTOP");
    assert.equal(defaultProcessIdentity(child.pid), lockBeforeStop.startIdentity);
    const startedAt = Date.now();
    await assert.rejects(
      second.start(),
      (error) => error.code === "SERVICE_LOCK_INDETERMINATE",
    );
    assert.equal(Date.now() - startedAt < 750, true, "SIGSTOP 探测必须有界");
    assert.equal(fs.readFileSync(paths.tokenPath, "utf8"), tokenBefore);
    const socketAfter = fs.lstatSync(paths.socketPath);
    assert.deepEqual([socketAfter.dev, socketAfter.ino], [socketBefore.dev, socketBefore.ino]);
    process.kill(child.pid, "SIGCONT");
    resumed = true;
    await requestService(paths, {
      method: "service.stop", token: tokenBefore.trim(), version: PROTOCOL_VERSION,
    });
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  } finally {
    await second.stop({ notify: false }).catch(() => {});
    if (!resumed) {
      try { process.kill(child.pid, "SIGCONT"); } catch { /* already exited */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already exited */ }
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
  }
});

test("真实 Service 修改 process.title 后第二实例仍先认证 nonce，不能夺锁", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-title-change-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const fixture = path.join(ROOT, "scripts", "fixtures", "shoggoth-agent-service-fixture.cjs");
  const child = spawn(process.execPath, [fixture, JSON.stringify(paths)], { stdio: ["ignore", "pipe", "pipe"] });
  const duplicate = createAgentService({ paths, version: "duplicate", lockProbeTimeoutMs: 200 });
  try {
    await waitForHealthyService(paths);
    const tokenBefore = fs.readFileSync(paths.tokenPath, "utf8");
    const socketBefore = fs.lstatSync(paths.socketPath);
    const lockBefore = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    assert.match(defaultProcessIdentity(child.pid), /\S/);
    process.kill(child.pid, "SIGUSR1");
    await waitFor(() => fs.existsSync(path.join(paths.stateDir, "title-changed")));
    await assert.rejects(duplicate.start(), (error) => error.code === "SERVICE_ALREADY_RUNNING");
    assert.equal(fs.readFileSync(paths.tokenPath, "utf8"), tokenBefore);
    const socketAfter = fs.lstatSync(paths.socketPath);
    assert.deepEqual([socketAfter.dev, socketAfter.ino], [socketBefore.dev, socketBefore.ino]);
    assert.equal(JSON.parse(fs.readFileSync(paths.lockPath, "utf8")).nonce, lockBefore.nonce);
    const hello = await requestService(paths, {
      method: "service.hello", token: tokenBefore.trim(), version: PROTOCOL_VERSION,
    });
    assert.equal(hello.serviceVersion, "fixture");
  } finally {
    await duplicate.stop({ notify: false }).catch(() => {});
    try { process.kill(child.pid, "SIGTERM"); } catch { /* already exited */ }
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  }
});

test("socket/token symlink 被拒绝且不改写目标", async () => {
  for (const leaf of ["tokenPath", "socketPath"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-link-"));
    const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const victim = path.join(root, "victim");
    fs.writeFileSync(victim, "untouched");
    fs.symlinkSync(victim, paths[leaf]);
    const service = createAgentService({ paths, version: "test" });
    await assert.rejects(service.start(), (error) => error.code === "UNSAFE_SYMLINK");
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  }
});

test("cacheDir 中间 symlink 在创建 runtimeDir 前拒绝且 victim 零污染", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cache-parent-link-"));
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "marker"), "untouched");
  fs.symlinkSync(victim, path.join(root, "cache-link"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache-link", "service"),
    trustedRoot: root,
  });
  const service = createAgentService({ paths, version: "test" });
  await assert.rejects(service.start(), (error) => error.code === "UNSAFE_SYMLINK");
  assert.deepEqual(fs.readdirSync(victim), ["marker"]);
  await service.stop({ notify: false });
});

test("Service 拒绝 token/lock hardlink 且不改写链接目标", async () => {
  for (const leaf of ["tokenPath", "lockPath"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-hardlink-"));
    const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const victim = path.join(root, `victim-${leaf}`);
    fs.writeFileSync(victim, leaf === "lockPath" ? "0\n" : "untouched-token\n", { mode: 0o600 });
    fs.linkSync(victim, paths[leaf]);
    const service = createAgentService({ paths, version: "test", lockProbeTimeoutMs: 20 });
    try {
      await assert.rejects(service.start(), (error) => error.code === "UNSAFE_HARDLINK");
    } finally {
      await service.stop({ notify: false }).catch(() => {});
    }
    assert.equal(
      fs.readFileSync(victim, "utf8"),
      leaf === "lockPath" ? "0\n" : "untouched-token\n",
    );
  }
});

test("client 从同一 O_NOFOLLOW fd 校验 token hardlink/权限", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-client-token-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test" });
  await service.start();
  try {
    const extraLink = path.join(root, "token-link");
    fs.linkSync(paths.tokenPath, extraLink);
    assert.throws(() => readClientToken(paths), (error) => error.code === "UNSAFE_HARDLINK");
    fs.unlinkSync(extraLink);
    fs.chmodSync(paths.tokenPath, 0o644);
    assert.throws(() => readClientToken(paths), (error) => error.code === "UNSAFE_PERMISSIONS");
  } finally {
    await service.stop();
  }
});

test("client pin socket inode，连接建立时路径被替换则拒绝伪造响应", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-socket-swap-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.tokenPath, "fixture-token\n", { mode: 0o600 });
  const malicious = net.createServer((socket) => {
    fs.unlinkSync(paths.socketPath);
    socket.end(`${JSON.stringify({ id: "forged", ok: true, result: { healthy: "forged" } })}\n`);
  });
  await new Promise((resolve, reject) => malicious.listen(paths.socketPath, (error) => error ? reject(error) : resolve()));
  fs.chmodSync(paths.socketPath, 0o600);
  try {
    await assert.rejects(
      requestService(paths, {
        method: "service.status", token: "fixture-token", version: PROTOCOL_VERSION,
      }),
      (error) => error.code === "UNSAFE_SOCKET_CHANGED",
    );
  } finally {
    await new Promise((resolve) => malicious.close(resolve));
  }
});

test("client 等待 EOF 并严格拒绝错误 id、多帧、tail、半帧与超限响应", async () => {
  const success = (id, result = { healthy: true }) => JSON.stringify({ id, ok: true, result });
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [`${success(`${id}-wrong`)}\n`] })),
    (error) => error.code === "RESPONSE_ID_MISMATCH",
  );
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [`${success(id)}\n${success(id)}\n`] })),
    (error) => error.code === "MULTIPLE_RESPONSE_FRAMES",
  );
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [`${success(id)}\n`, `${success(id)}\n`] })),
    (error) => error.code === "MULTIPLE_RESPONSE_FRAMES",
  );
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [`${success(id)}\ngarbage-tail`] })),
    (error) => error.code === "RESPONSE_TRAILING_DATA",
  );
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [success(id).slice(0, 12)] })),
    (error) => error.code === "INCOMPLETE_RESPONSE",
  );
  await assert.rejects(
    requestFromMaliciousServer(() => ({ chunks: ["x".repeat(MAX_FRAME_BYTES + 1)] })),
    (error) => error.code === "RESPONSE_TOO_LARGE",
  );
  await assert.rejects(
    requestFromMaliciousServer((id) => ({ chunks: [`${success(id)}\n`], end: false }), 60),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  const splitValid = await requestFromMaliciousServer((id) => {
    const frame = `${success(id, { healthy: "split-valid" })}\n`;
    return { chunks: [frame.slice(0, 7), frame.slice(7)] };
  });
  assert.equal(splitValid.healthy, "split-valid");
});

test("独立 Service 不依赖 client/UI PID，graceful stop 后进程退出", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-child-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const fixture = path.join(ROOT, "scripts", "fixtures", "shoggoth-agent-service-fixture.cjs");
  const child = spawn(process.execPath, [fixture, JSON.stringify(paths)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await waitForHealthyService(paths);
  const token = readClientToken(paths);
  assert.equal(status.pid, child.pid);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  await requestService(paths, { method: "service.stop", token, version: PROTOCOL_VERSION });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(fs.existsSync(paths.socketPath), false);
});

test("launcher 与独立 client 真正退出后 Service 仍健康并脱离原父进程", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-launcher-exit-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const launcherFixture = path.join(ROOT, "scripts", "fixtures", "shoggoth-service-launcher-fixture.cjs");
  const clientFixture = path.join(ROOT, "scripts", "fixtures", "shoggoth-service-client-fixture.cjs");
  const launcher = await runProcess(process.execPath, [launcherFixture, JSON.stringify(paths)]);
  assert.equal(launcher.code, 0, launcher.stderr);
  const servicePid = Number.parseInt(launcher.stdout.trim(), 10);
  assert.equal(Number.isSafeInteger(servicePid), true, launcher.stdout);
  await waitForHealthyService(paths);

  const client = await runProcess(process.execPath, [clientFixture, JSON.stringify(paths)]);
  assert.equal(client.code, 0, client.stderr);
  const clientStatus = JSON.parse(client.stdout);
  assert.equal(clientStatus.pid, servicePid);
  assert.doesNotThrow(() => process.kill(servicePid, 0));

  const status = await requestService(paths, {
    method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
  });
  assert.equal(status.pid, servicePid);
  if (process.platform !== "win32") assert.equal(status.ppid, 1);
  await requestService(paths, {
    method: "service.stop", token: readClientToken(paths), version: PROTOCOL_VERSION,
  });
  await waitFor(() => {
    try { process.kill(servicePid, 0); return false; } catch { return true; }
  });
});

test("真实 Electron bootstrap 可有界启动 Service role 且不创建 BrowserWindow", async () => {
  if (process.platform !== "darwin") return;
  // Darwin sockaddr_un 只有 104 bytes；使用短 HOME 模拟真实 /Users/<name> 路径。
  const homeDir = fs.mkdtempSync("/tmp/sgel-");
  const paths = resolveServicePaths({ homeDir });
  const electronBinary = resolveElectronBinary();
  const gatePath = path.join(homeDir, "role-gate.json");
  const gateNonce = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(gatePath, `${JSON.stringify({ parentPid: process.pid, nonce: gateNonce })}\n`, { mode: 0o600 });
  const child = spawn(electronBinary, [ROOT, "--shoggoth-internal-role=agent-service"], {
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_ENV: "test",
      SHOGGOTH_INTERNAL_LAUNCH: "launch-agent-v1",
      SHOGGOTH_TEST_ROLE_GATE_FILE: gatePath,
      SHOGGOTH_TEST_ROLE_GATE_NONCE: gateNonce,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    try {
      await waitForHealthyService(paths, 5000);
      assert.equal(fs.lstatSync(paths.socketPath).mode & 0o777, 0o600);
    } catch (error) {
      throw new Error(`${error.message}\nElectron output:\n${output}`);
    }
    const status = await requestService(paths, {
      method: "service.status", token: readClientToken(paths), version: PROTOCOL_VERSION,
    });
    assert.equal(status.pid, child.pid);
    await requestService(paths, {
      method: "service.stop", token: readClientToken(paths), version: PROTOCOL_VERSION,
    });
    const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 0, output);
  } finally {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
});

function launchFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-launch-"));
  const homeDir = path.join(root, "home");
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot, { recursive: true });
  const bundle = makeTempAppBundle(applicationsRoot);
  const calls = [];
  const launchd = { enabled: false, loaded: false, loadedExecutable: null };
  const serviceVersion = "fixture-version";
  const healthProbe = async () => ({
    healthy: true,
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion,
  });
  const runner = async (_command, args) => {
    calls.push([...args]);
    if (typeof overrides.onRunLaunchctl === "function") {
      const overridden = await overrides.onRunLaunchctl([...args]);
      if (overridden !== undefined) return overridden;
    }
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => ${launchd.enabled ? "false" : "true"}\n`, stderr: "" };
    }
    if (args[0] === "print") {
      if (launchd.loaded) {
        return {
          code: 0,
          stdout: `label = ${LAUNCH_AGENT_LABEL}\nprogram = ${launchd.loadedExecutable}\n`,
          stderr: "",
        };
      }
      const error = new Error("Could not find service");
      error.stderr = `Could not find service ${LAUNCH_AGENT_LABEL}`;
      throw error;
    }
    if (args[0] === "enable") launchd.enabled = true;
    if (args[0] === "disable") launchd.enabled = false;
    if (args[0] === "bootstrap") {
      launchd.loaded = launchd.enabled;
      const plist = fs.readFileSync(args[2], "utf8");
      const match = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
      launchd.loadedExecutable = match?.[1]
        ?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<").replaceAll("&gt;", ">") || null;
      if (typeof overrides.onBootstrap === "function") overrides.onBootstrap();
    }
    if (args[0] === "bootout") {
      launchd.loaded = false;
      launchd.loadedExecutable = null;
    }
    if (args[0] === "kickstart" && typeof overrides.onKickstart === "function") {
      overrides.onKickstart();
    }
    return { code: 0 };
  };
  const controller = createLaunchAgentController({
    platform: "darwin",
    homeDir,
    uid: 501,
    applicationsRoot,
    ...bundle,
    runner,
    serviceVersion,
    healthProbe,
    resolveProxyEnvironment: () => ({}),
    ...overrides,
  });
  return {
    applicationsRoot, bundle, calls, controller, healthProbe, homeDir, launchd, root, runner, serviceVersion,
  };
}

function launchMutations(calls) {
  return calls.filter((args) => !["print", "print-disabled"].includes(args[0]));
}

test("LaunchAgent 将 macOS 静态代理投影为大小写兼容的无凭据环境", () => {
  const proxyEnvironment = parseMacSystemProxyOutput(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
    2 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`);
  assert.deepEqual(proxyEnvironment, {
    ALL_PROXY: "socks5://127.0.0.1:7897",
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1,.local",
    all_proxy: "socks5://127.0.0.1:7897",
    http_proxy: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    no_proxy: "127.0.0.1,.local",
  });
  const plist = buildLaunchAgentPlist({
    executablePath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    bootstrapPath: "/Applications/Shoggoth.app/Contents/Resources/app.asar/app/bootstrap.js",
    proxyEnvironment,
  });
  assert.match(plist, /<key>HTTPS_PROXY<\/key>\s*<string>http:\/\/127\.0\.0\.1:7897<\/string>/);
  assert.match(plist, /<key>https_proxy<\/key>\s*<string>http:\/\/127\.0\.0\.1:7897<\/string>/);
  assert.doesNotMatch(plist, /&lt;local&gt;/);
});

test("LaunchAgent 拒绝把带凭据、冲突或控制字符的代理写入 plist", () => {
  for (const proxyEnvironment of [
    { HTTPS_PROXY: "http://user:secret@127.0.0.1:7897" },
    { HTTPS_PROXY: "http://127.0.0.1:7897", https_proxy: "http://127.0.0.1:7898" },
    { NO_PROXY: "localhost\nInjected=1" },
  ]) {
    assert.throws(
      () => normalizeLaunchAgentProxyEnvironment(proxyEnvironment),
      (error) => error?.code === "LAUNCH_AGENT_PROXY_INVALID",
    );
  }
});

test("LaunchAgent install/start 使用固定 label、绝对 App 内路径与安全权限", async () => {
  const cleared = [];
  const { bundle, calls, controller } = launchFixture({
    clearExtendedAttributes(target) { cleared.push(target); },
  });
  const installed = await controller.install();
  assert.equal(installed.label, LAUNCH_AGENT_LABEL);
  assert.equal(mode(installed.stateDir), 0o700);
  assert.equal(mode(installed.plistPath), 0o600);
  assert.equal(mode(installed.statusPath), 0o600);
  assert.deepEqual(cleared, [installed.plistPath]);
  const plist = fs.readFileSync(installed.plistPath, "utf8");
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /--shoggoth-internal-role=agent-service/);
  assert.match(plist, /SHOGGOTH_INTERNAL_LAUNCH/);
  assert.equal(plist.includes(bundle.executablePath), true);
  assert.match(plist, /app\.asar\/app\/bootstrap\.js/);
  await controller.start();
  assert.deepEqual(launchMutations(calls).map((args) => args[0]), ["enable", "bootstrap"]);
  assert.equal(launchMutations(calls)[0][1], `gui/501/${LAUNCH_AGENT_LABEL}`);
});

test("LaunchAgent 系统代理变化进入 needsRepair 并重注册后台 Service", async () => {
  let proxyEnvironment = {};
  const { calls, controller } = launchFixture({
    resolveProxyEnvironment: () => proxyEnvironment,
  });
  await controller.start();
  proxyEnvironment = { HTTPS_PROXY: "http://127.0.0.1:7897" };
  const status = await controller.status();
  assert.equal(status.needsRepair, true);
  const repaired = await controller.repair();
  assert.equal(repaired.repaired, true);
  const plist = fs.readFileSync(controller.paths.plistPath, "utf8");
  assert.match(plist, /<key>HTTPS_PROXY<\/key>\s*<string>http:\/\/127\.0\.0\.1:7897<\/string>/);
  assert.deepEqual(
    launchMutations(calls).map((args) => args[0]),
    ["enable", "bootstrap", "disable", "bootout", "enable", "bootstrap"],
  );
});

test("LaunchAgent 迁移旧 Background 调度并保持后续启动幂等", async () => {
  const { calls, controller } = launchFixture();
  await controller.start();
  const current = fs.readFileSync(controller.paths.plistPath, "utf8");
  assert.match(current, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  fs.writeFileSync(controller.paths.plistPath, current.replace(
    "<string>Interactive</string>", "<string>Background</string>",
  ));
  assert.equal((await controller.status()).needsRepair, true);
  calls.length = 0;

  await controller.start();
  assert.equal((await controller.status()).needsRepair, false);
  assert.equal(fs.readFileSync(controller.paths.plistPath, "utf8"), current);
  assert.deepEqual(
    launchMutations(calls).map((args) => args[0]),
    ["disable", "bootout", "enable", "bootstrap"],
  );
  calls.length = 0;
  await controller.start();
  assert.deepEqual(launchMutations(calls), []);
});

test("LaunchAgent 同一次 start 等待慢 Service 成功且不触发二次 bootstrap", async () => {
  let phase = "initial";
  let slowHealthAttempts = 0;
  let virtualNow = 0;
  let fixture;
  fixture = launchFixture({
    healthTimeoutMs: 45,
    healthIntervalMs: 10,
    healthNow: () => virtualNow,
    healthDelay: async (delayMs) => { virtualNow += delayMs; },
    async healthProbe() {
      if (phase === "slow") {
        slowHealthAttempts += 1;
        if (slowHealthAttempts < 5) throw new Error("fixture code identity still resolving");
      }
      return {
        healthy: true,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: fixture.serviceVersion,
      };
    },
  });
  await fixture.controller.start();

  phase = "slow";
  fixture.calls.length = 0;
  await fixture.controller.start();

  assert.equal(slowHealthAttempts, 5);
  assert.deepEqual(
    launchMutations(fixture.calls),
    [],
    "慢但有效的 Service 必须在同一次健康确认内恢复，不能 stop/bootstrap 或 kickstart",
  );
});

test("LaunchAgent 默认 45 秒预算等待 loaded generation 到虚拟第 40 秒健康", async () => {
  let virtualNow = 0;
  let delayedHealth = false;
  let fixture;
  const healthNow = () => virtualNow;
  const healthDelay = async (delayMs) => { virtualNow += delayMs; };
  const healthProbe = async () => ({
    healthy: !delayedHealth
      || virtualNow >= 40_000
      || launchMutations(fixture.calls).some((args) => args[0] === "bootstrap"),
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: fixture.serviceVersion,
  });
  fixture = launchFixture({ healthDelay, healthNow, healthProbe });
  await fixture.controller.start();

  delayedHealth = true;
  virtualNow = 0;
  fixture.calls.length = 0;
  const realStartedAt = Date.now();
  await fixture.controller.start();
  const realElapsedMs = Date.now() - realStartedAt;

  assert.equal(virtualNow, 40_000, "默认 loaded grace 必须覆盖完整虚拟 40 秒且不能越界");
  assert.equal(realElapsedMs < 500, true, `虚拟 40 秒测试不能真实等待，实际 ${realElapsedMs}ms`);
  assert.deepEqual(
    launchMutations(fixture.calls),
    [],
    "旧 generation 在预算内变健康时不能 stop/bootstrap",
  );
});

test("LaunchAgent 串行所有 mutation、同种调用共享 Promise，冷启动并发修复只 bootstrap 一次", async () => {
  const firstStateQuery = deferred();
  let stateQueryBlocked = false;
  const fixture = launchFixture({
    onRunLaunchctl(args) {
      if (!stateQueryBlocked && args[0] === "print-disabled") {
        stateQueryBlocked = true;
        return firstStateQuery.promise;
      }
      return undefined;
    },
  });

  const startOne = fixture.controller.start();
  const startTwo = fixture.controller.start();
  const installOne = fixture.controller.install();
  const installTwo = fixture.controller.install();
  const repairOne = fixture.controller.repair();
  const repairTwo = fixture.controller.repair();
  const stopOne = fixture.controller.stop();
  const stopTwo = fixture.controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const callsBeforeRelease = fixture.calls.map((args) => [...args]);
  const plistExistedBeforeRelease = fs.existsSync(fixture.controller.paths.plistPath);
  firstStateQuery.resolve(undefined);
  const settled = await Promise.allSettled([
    startOne, startTwo, installOne, installTwo, repairOne, repairTwo, stopOne, stopTwo,
  ]);

  assert.strictEqual(startOne, startTwo);
  assert.strictEqual(installOne, installTwo);
  assert.strictEqual(repairOne, repairTwo);
  assert.strictEqual(stopOne, stopTwo);
  assert.deepEqual(callsBeforeRelease.map((args) => args[0]), ["print-disabled"]);
  assert.equal(plistExistedBeforeRelease, false);
  assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);
  assert.equal(launchMutations(fixture.calls).filter((args) => args[0] === "enable").length, 1);
  assert.equal(launchMutations(fixture.calls).filter((args) => args[0] === "bootstrap").length, 1);
});

test("LaunchAgent 同类 mutation 只合并相邻队列段，start-stop-start 不发生 ABA", async () => {
  const firstStateQuery = deferred();
  let stateQueryBlocked = false;
  let fixture;
  const healthProbe = async () => ({
    healthy: fixture.launchd.enabled && fixture.launchd.loaded,
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion: fixture.serviceVersion,
  });
  fixture = launchFixture({
    healthProbe,
    onRunLaunchctl(args) {
      if (!stateQueryBlocked && args[0] === "print-disabled") {
        stateQueryBlocked = true;
        return firstStateQuery.promise;
      }
      return undefined;
    },
  });

  const startOne = fixture.controller.start();
  const adjacentStartOne = fixture.controller.start();
  const stop = fixture.controller.stop();
  const startTwo = fixture.controller.start();
  const adjacentStartTwo = fixture.controller.start();

  assert.strictEqual(startOne, adjacentStartOne);
  assert.notStrictEqual(startOne, startTwo);
  assert.strictEqual(startTwo, adjacentStartTwo);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.calls.map((args) => args[0]), ["print-disabled"]);

  firstStateQuery.resolve(undefined);
  await Promise.all([startOne, adjacentStartOne, stop, startTwo, adjacentStartTwo]);

  assert.deepEqual(launchMutations(fixture.calls).map((args) => args[0]), [
    "enable", "bootstrap", "disable", "bootout", "enable", "bootstrap",
  ]);
  const status = await fixture.controller.status();
  const health = await healthProbe();
  assert.equal(status.enabled, true);
  assert.equal(status.loaded, true);
  assert.equal(health.healthy, true);
});

test("LaunchAgent loaded+enabled 但 Service health 缺失时 start/repair fail closed", async () => {
  let healthAttempts = 0;
  const absent = launchFixture({
    serviceVersion: "fixture-version",
    healthTimeoutMs: 40,
    healthIntervalMs: 5,
    async healthProbe() {
      healthAttempts += 1;
      throw new Error("fixture socket absent");
    },
  });
  await assert.rejects(
    absent.controller.start(),
    (error) => error.code === "SERVICE_HEALTH_NOT_CONFIRMED" && !error.message.includes("socket absent"),
  );
  assert.equal(absent.launchd.loaded, true, "fake launchd 已注册但 Service 未健康");
  assert.equal(healthAttempts > 1, true, "health probe 必须在有界窗口内轮询");
  assert.equal(JSON.parse(fs.readFileSync(absent.controller.paths.statusPath, "utf8")).enabled, false);

  const movedBundle = makeTempAppBundle(absent.applicationsRoot, "Health Repair.app");
  const repair = createLaunchAgentController({
    platform: "darwin",
    homeDir: absent.homeDir,
    uid: 501,
    applicationsRoot: absent.applicationsRoot,
    ...movedBundle,
    runner: absent.runner,
    serviceVersion: "fixture-version",
    healthTimeoutMs: 30,
    healthIntervalMs: 5,
    healthProbe: async () => ({
      healthy: false, protocolVersion: PROTOCOL_VERSION, serviceVersion: "fixture-version",
    }),
  });
  await assert.rejects(repair.repair(), (error) => error.code === "SERVICE_HEALTH_NOT_CONFIRMED");
  assert.equal(JSON.parse(fs.readFileSync(repair.paths.statusPath, "utf8")).enabled, false);

  const priorHealthy = launchFixture();
  await priorHealthy.controller.start();
  assert.equal(JSON.parse(fs.readFileSync(priorHealthy.controller.paths.statusPath, "utf8")).enabled, true);
  const crashLoop = createLaunchAgentController({
    platform: "darwin",
    homeDir: priorHealthy.homeDir,
    uid: 501,
    applicationsRoot: priorHealthy.applicationsRoot,
    ...priorHealthy.bundle,
    runner: priorHealthy.runner,
    serviceVersion: priorHealthy.serviceVersion,
    healthTimeoutMs: 20,
    healthIntervalMs: 5,
    healthProbe: async () => { throw new Error("fixture crash loop"); },
  });
  await assert.rejects(crashLoop.start(), (error) => error.code === "SERVICE_HEALTH_NOT_CONFIRMED");
  assert.equal(
    JSON.parse(fs.readFileSync(crashLoop.paths.statusPath, "utf8")).enabled,
    false,
    "旧 enabled=true 不能掩盖本次 health 失败",
  );
});

test("覆盖安装令 loaded job 进入 penalty box 时 start 仅重注册一次并恢复", async () => {
  let healthy = true;
  let virtualNow = 0;
  let fixture;
  fixture = launchFixture({
    healthTimeoutMs: 25,
    healthIntervalMs: 5,
    healthNow: () => virtualNow,
    healthDelay: async (delayMs) => { virtualNow += delayMs; },
    async healthProbe() {
      if (!healthy) throw new Error("fixture executable was replaced while launchd stayed loaded");
      return {
        healthy: true,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: fixture.serviceVersion,
      };
    },
    onBootstrap() { healthy = true; },
  });
  await fixture.controller.start();
  healthy = false;
  fixture.calls.length = 0;

  await fixture.controller.start();

  assert.deepEqual(launchMutations(fixture.calls), [
    ["disable", `gui/501/${LAUNCH_AGENT_LABEL}`],
    ["bootout", `gui/501/${LAUNCH_AGENT_LABEL}`],
    ["enable", `gui/501/${LAUNCH_AGENT_LABEL}`],
    ["bootstrap", "gui/501", fixture.controller.paths.plistPath],
  ]);
  assert.equal(JSON.parse(fs.readFileSync(fixture.controller.paths.statusPath, "utf8")).enabled, true);
});

test("loaded-unhealthy 恢复与重注册后的健康确认共享一次绝对预算", async () => {
  let healthy = true;
  let virtualNow = 0;
  let fixture;
  fixture = launchFixture({
    healthTimeoutMs: 40,
    healthIntervalMs: 5,
    healthNow: () => virtualNow,
    healthDelay: async (delayMs) => { virtualNow += delayMs; },
    async healthProbe() {
      if (!healthy) throw new Error("fixture remains unhealthy");
      return {
        healthy: true,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: fixture.serviceVersion,
      };
    },
  });
  await fixture.controller.start();
  healthy = false;
  fixture.calls.length = 0;

  const startedAt = virtualNow;
  await assert.rejects(
    fixture.controller.start(),
    (error) => error.code === "SERVICE_HEALTH_NOT_CONFIRMED",
  );
  const elapsedMs = virtualNow - startedAt;

  assert.equal(elapsedMs <= 40, true, `单次 40ms 预算不能嵌套成双窗口，实际 ${elapsedMs}ms`);
  assert.deepEqual(
    launchMutations(fixture.calls).map((args) => args[0]),
    ["disable", "bootout", "enable", "bootstrap"],
  );
});

test("覆盖安装恢复遇到挂起 launchctl 时有界失败且不伪报健康", async () => {
  let healthy = true;
  let hangBootout = false;
  let fixture;
  fixture = launchFixture({
    launchctlTimeoutMs: 20,
    healthTimeoutMs: 15,
    healthIntervalMs: 5,
    async healthProbe() {
      if (!healthy) throw new Error("fixture service absent");
      return {
        healthy: true,
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: fixture.serviceVersion,
      };
    },
    onRunLaunchctl(args) {
      if (hangBootout && args[0] === "bootout") return new Promise(() => {});
      return undefined;
    },
  });
  await fixture.controller.start();
  healthy = false;
  hangBootout = true;

  await assert.rejects(
    fixture.controller.start(),
    (error) => error.code === "LAUNCH_AGENT_STOP_FAILED"
      && error.errors?.some((cause) => cause?.code === "LAUNCHCTL_TIMEOUT")
      && !error.message.includes("fixture"),
  );
  assert.equal(JSON.parse(fs.readFileSync(fixture.controller.paths.statusPath, "utf8")).enabled, false);
});

test("packaged controller 可从当前 executable/resources 自动推导 App 内路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-launch-auto-"));
  const homeDir = path.join(root, "home");
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot);
  const bundle = makeTempAppBundle(applicationsRoot, "Auto.app");
  const controller = createLaunchAgentController({
    platform: "darwin",
    homeDir,
    uid: 501,
    applicationsRoot,
    processExecutablePath: bundle.executablePath,
    resourcesPath: bundle.resourcesPath,
    runner: async () => ({ code: 0 }),
  });
  const installed = await controller.install();
  const plist = fs.readFileSync(installed.plistPath, "utf8");
  assert.equal(plist.includes(bundle.executablePath), true);
  assert.equal(plist.includes(bundle.bootstrapPath), true);
});

test("显式 stop 先 disable 再 bootout，KeepAlive 不会自动拉起", async () => {
  const { calls, controller, launchd } = launchFixture();
  await controller.start();
  assert.equal(launchd.loaded, true);
  calls.length = 0;
  await controller.stop();
  assert.deepEqual(launchMutations(calls).map((args) => args[0]), ["disable", "bootout"]);
  if (launchd.enabled) launchd.loaded = true; // fake KeepAlive tick
  assert.deepEqual(launchd, { enabled: false, loaded: false, loadedExecutable: null });
});

test("repair 检测 App 移动，先停旧 job 再写入并启动当前绝对路径", async () => {
  const first = launchFixture();
  await first.controller.start();
  const movedBundle = makeTempAppBundle(first.applicationsRoot, "Shoggoth Renamed.app");
  const moved = createLaunchAgentController({
    platform: "darwin",
    homeDir: first.homeDir,
    uid: 501,
    applicationsRoot: first.applicationsRoot,
    ...movedBundle,
    runner: first.runner,
    serviceVersion: first.serviceVersion,
    healthProbe: first.healthProbe,
  });
  first.calls.length = 0;
  const repaired = await moved.repair();
  assert.equal(repaired.repaired, true);
  assert.deepEqual(
    launchMutations(first.calls).map((args) => args[0]),
    ["disable", "bootout", "enable", "bootstrap"],
  );
  const plist = fs.readFileSync(repaired.plistPath, "utf8");
  assert.match(plist, /Shoggoth Renamed\.app/);
  assert.doesNotMatch(plist, /\/Shoggoth\.app/);
});

test("LaunchAgent App 变更时查询失败保留旧配置证据，重试先卸载旧 executable 再加载新 executable", async () => {
  const fixture = launchFixture();
  const oldBundle = makeTempAppBundle(fixture.applicationsRoot, "Old.app");
  const oldController = createLaunchAgentController({
    platform: "darwin",
    homeDir: fixture.homeDir,
    uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...oldBundle,
    runner: fixture.runner,
    serviceVersion: fixture.serviceVersion,
    healthProbe: fixture.healthProbe,
  });
  await oldController.start();
  assert.equal(fixture.launchd.loadedExecutable, oldBundle.executablePath);
  const oldPlist = fs.readFileSync(oldController.paths.plistPath, "utf8");
  const oldStatus = fs.readFileSync(oldController.paths.statusPath, "utf8");

  const newBundle = makeTempAppBundle(fixture.applicationsRoot, "New.app");
  let failNextStateQuery = true;
  const flakyRunner = async (command, args) => {
    if (failNextStateQuery && args[0] === "print-disabled") {
      failNextStateQuery = false;
      const error = new Error("fixture launchd state query unavailable");
      error.code = "EIO";
      throw error;
    }
    return fixture.runner(command, args);
  };
  const newController = createLaunchAgentController({
    platform: "darwin",
    homeDir: fixture.homeDir,
    uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...newBundle,
    runner: flakyRunner,
    serviceVersion: fixture.serviceVersion,
    // Old/New 使用相同版本，证明不能仅凭 serviceVersion 健康探测认领 job。
    healthProbe: fixture.healthProbe,
  });

  await assert.rejects(newController.start(), (error) => error.code === "EIO");
  assert.equal(fs.readFileSync(newController.paths.plistPath, "utf8"), oldPlist);
  assert.equal(fs.readFileSync(newController.paths.statusPath, "utf8"), oldStatus);
  assert.equal(fixture.launchd.loadedExecutable, oldBundle.executablePath);

  fixture.calls.length = 0;
  await newController.start();
  assert.deepEqual(
    launchMutations(fixture.calls).map((args) => args[0]),
    ["disable", "bootout", "enable", "bootstrap"],
  );
  assert.equal(fixture.launchd.loadedExecutable, newBundle.executablePath);
  const status = JSON.parse(fs.readFileSync(newController.paths.statusPath, "utf8"));
  assert.equal(status.enabled, true);
  assert.equal(status.executablePath, newBundle.executablePath);
});

test("LaunchAgent 即使 plist 一致且同版本健康，也拒绝认领实际 program 路径不同的旧 job", async () => {
  const fixture = launchFixture();
  await fixture.controller.start();
  const oldBundle = makeTempAppBundle(fixture.applicationsRoot, "Old Runtime.app");
  // 模拟磁盘已是 desired plist，但 launchd 仍持有同版本的旧 executable。
  fixture.launchd.loadedExecutable = oldBundle.executablePath;
  fixture.calls.length = 0;

  await fixture.controller.start();

  assert.deepEqual(
    launchMutations(fixture.calls).map((args) => args[0]),
    ["disable", "bootout", "enable", "bootstrap"],
  );
  assert.equal(fixture.launchd.loadedExecutable, fixture.bundle.executablePath);
});

test("LaunchAgent stop 仅忽略精确 not-loaded，并以状态查询确认 disabled+unloaded", async () => {
  const fixture = launchFixture();
  const homeDir = fixture.homeDir;
  const calls = [];
  const runner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "bootout" || args[0] === "print") {
      const error = new Error("Could not find service");
      error.stderr = `Could not find service ${LAUNCH_AGENT_LABEL}`;
      throw error;
    }
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => true\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner,
    serviceVersion: fixture.serviceVersion,
    healthProbe: fixture.healthProbe,
  });
  await controller.install();
  await controller.stop();
  assert.deepEqual(launchMutations(calls).map((args) => args[0]), ["disable", "bootout"]);
  assert.deepEqual(calls.slice(-2).map((args) => args[0]), ["print-disabled", "print"]);
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, false);
});

test("LaunchAgent 接受当前 macOS print-disabled 的 enabled/disabled 单词格式", async () => {
  const fixture = launchFixture();
  const runner = async (_command, args) => {
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `"${LAUNCH_AGENT_LABEL}" => disabled\n`, stderr: "" };
    }
    if (args[0] === "print") {
      const error = new Error("Could not find service");
      error.stderr = `Could not find service ${LAUNCH_AGENT_LABEL}`;
      throw error;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner,
    stopConfirmTimeoutMs: 0,
  });
  await controller.install();
  await controller.stop();
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, false);
});

test("LaunchAgent stop 等待 bootout 的异步卸载完成后再返回成功", async () => {
  const fixture = launchFixture();
  const calls = [];
  let disabled = false;
  let loadedChecksRemaining = 2;
  const runner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "disable") disabled = true;
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => ${disabled ? "true" : "false"}\n`, stderr: "" };
    }
    if (args[0] === "print") {
      if (loadedChecksRemaining > 0) {
        loadedChecksRemaining -= 1;
        return {
          code: 0,
          stdout: `label = ${LAUNCH_AGENT_LABEL}\nprogram = ${fixture.bundle.executablePath}\n`,
          stderr: "",
        };
      }
      const error = new Error("Could not find service");
      error.stderr = `Could not find service ${LAUNCH_AGENT_LABEL}`;
      throw error;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner,
    stopConfirmTimeoutMs: 100,
    stopConfirmIntervalMs: 0,
  });
  await controller.install();
  await controller.stop();
  assert.equal(calls.filter((args) => args[0] === "print").length, 3);
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, false);
});

test("LaunchAgent stop 默认确认预算覆盖真实 launchd 超过两秒的异步卸载", async () => {
  const fixture = launchFixture();
  let disabled = false;
  let unloadAt = Number.POSITIVE_INFINITY;
  const runner = async (_command, args) => {
    if (args[0] === "disable") disabled = true;
    if (args[0] === "bootout") unloadAt = Date.now() + 2_200;
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `"${LAUNCH_AGENT_LABEL}" => ${disabled ? "true" : "false"}\n`, stderr: "" };
    }
    if (args[0] === "print") {
      if (Date.now() < unloadAt) {
        return {
          code: 0,
          stdout: `label = ${LAUNCH_AGENT_LABEL}\nprogram = ${fixture.bundle.executablePath}\n`,
          stderr: "",
        };
      }
      const error = new Error("Could not find service");
      error.stderr = `Could not find service ${LAUNCH_AGENT_LABEL}`;
      throw error;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner,
    stopConfirmIntervalMs: 25,
  });
  await controller.install();
  await controller.stop();
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, false);
});

test("LaunchAgent stop 对 permission denied/组合错误 fail closed 且不伪写 stopped", async () => {
  const fixture = launchFixture();
  await fixture.controller.install();
  const prior = JSON.parse(fs.readFileSync(fixture.controller.paths.statusPath, "utf8"));
  prior.enabled = true;
  fs.writeFileSync(fixture.controller.paths.statusPath, `${JSON.stringify(prior)}\n`, { mode: 0o600 });
  const calls = [];
  const deniedRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "disable" || args[0] === "bootout") {
      const error = new Error(`Permission denied: ${args[0]}`);
      error.code = "EACCES";
      error.stderr = "Operation not permitted";
      throw error;
    }
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => true\n`, stderr: "" };
    }
    const error = new Error("Could not find service");
    error.stderr = "Could not find service";
    throw error;
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner: deniedRunner,
  });
  await assert.rejects(
    controller.stop(),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(launchMutations(calls).map((args) => args[0]), ["disable", "bootout"]);
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, true);
});

test("LaunchAgent stop 状态查询未确认 disabled 时拒绝成功", async () => {
  const fixture = launchFixture();
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner: async (_command, args) => {
      if (args[0] === "print-disabled") {
        return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => false\n`, stderr: "" };
      }
      if (args[0] === "print") {
        const error = new Error("Could not find service");
        error.stderr = "Could not find service";
        throw error;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    stopConfirmTimeoutMs: 0,
  });
  await controller.install();
  await assert.rejects(controller.stop(), (error) => error.code === "STOP_NOT_CONFIRMED");
});

test("已 loaded 且 plist 一致时重复 start/repair 幂等，不重复 bootstrap", async () => {
  const fixture = launchFixture();
  await fixture.controller.start();
  fixture.calls.length = 0;
  await fixture.controller.start();
  assert.deepEqual(launchMutations(fixture.calls), []);
  fixture.calls.length = 0;
  const repaired = await fixture.controller.repair();
  assert.equal(repaired.repaired, false);
  assert.deepEqual(launchMutations(fixture.calls), []);
});

test("查询 unloaded 后 bootstrap 遇到精确 already-loaded 竞态时重新确认并成功", async () => {
  const fixture = launchFixture();
  const homeDir = fixture.homeDir;
  let loaded = false;
  let enabled = false;
  let firstPrint = true;
  const runner = async (_command, args) => {
    if (args[0] === "print-disabled") {
      return { code: 0, stdout: `\"${LAUNCH_AGENT_LABEL}\" => ${enabled ? "false" : "true"}\n`, stderr: "" };
    }
    if (args[0] === "print") {
      if (firstPrint) {
        firstPrint = false;
        const error = new Error("Could not find service");
        error.stderr = "Could not find service";
        throw error;
      }
      if (loaded) {
        return {
          code: 0,
          stdout: `label = ${LAUNCH_AGENT_LABEL}\nprogram = ${fixture.bundle.executablePath}\n`,
          stderr: "",
        };
      }
    }
    if (args[0] === "enable") { enabled = true; return { code: 0 }; }
    if (args[0] === "bootstrap") {
      loaded = true;
      const error = new Error("Service already loaded");
      error.stderr = "Bootstrap failed: 5: Input/output error: service already loaded";
      throw error;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createLaunchAgentController({
    platform: "darwin", homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot,
    ...fixture.bundle,
    runner,
    serviceVersion: fixture.serviceVersion,
    healthProbe: fixture.healthProbe,
  });
  await controller.start();
  assert.equal(JSON.parse(fs.readFileSync(controller.paths.statusPath, "utf8")).enabled, true);
});

test("非 macOS 明确 unsupported，非稳定安装位置 fail closed", async () => {
  const unsupported = createLaunchAgentController({ platform: "linux", homeDir: "/tmp", runner: async () => {} });
  assert.deepEqual(await unsupported.install(), { supported: false, reason: "unsupported-platform" });
  const outside = launchFixture({
    appPath: "/tmp/Shoggoth.app",
    executablePath: "/tmp/Shoggoth.app/Contents/MacOS/Shoggoth",
    resourcesPath: "/tmp/Shoggoth.app/Contents/Resources",
    bootstrapPath: "/tmp/Shoggoth.app/Contents/Resources/app.asar/app/bootstrap.js",
  }).controller;
  await assert.rejects(outside.install(), (error) => error.code === "UNSTABLE_INSTALL_LOCATION");
});

function makeTempAppBundle(applicationsRoot, name = "Shoggoth.app") {
  const appPath = path.join(applicationsRoot, name);
  const executablePath = path.join(appPath, "Contents", "MacOS", "Shoggoth");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const bootstrapPath = path.join(resourcesPath, "app.asar", "app", "bootstrap.js");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });
  fs.writeFileSync(executablePath, "fixture executable");
  fs.writeFileSync(path.join(resourcesPath, "app.asar"), "fixture archive");
  return { appPath, executablePath, resourcesPath, bootstrapPath };
}

test("packaged Electron 的 ASAR 虚拟目录 stat 不得误判物理 app.asar 类型", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-asar-stat-"));
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot);
  const bundle = makeTempAppBundle(applicationsRoot, "Asar.app");
  const archivePath = path.join(bundle.resourcesPath, "app.asar");
  const originalStatSync = fs.statSync;
  fs.statSync = function electronAsarStat(target, ...args) {
    const stats = originalStatSync.call(this, target, ...args);
    if (path.resolve(String(target)) !== archivePath) return stats;
    return new Proxy(stats, {
      get(value, property, receiver) {
        if (property === "isFile") return () => false;
        if (property === "isDirectory") return () => true;
        return Reflect.get(value, property, receiver);
      },
    });
  };
  try {
    assert.deepEqual(
      assertStableAppPaths(bundle, { applicationsRoot }),
      bundle,
    );
  } finally {
    fs.statSync = originalStatSync;
  }
});

test("真实 Electron 使用物理文件视图校验合法 app.asar", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-real-asar-stat-"));
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot);
  const bundle = makeTempAppBundle(applicationsRoot, "Real Asar.app");
  const sourceDir = path.join(root, "asar-source");
  fs.mkdirSync(path.join(sourceDir, "app"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "app", "bootstrap.js"), "module.exports = {};\n");
  fs.unlinkSync(path.join(bundle.resourcesPath, "app.asar"));
  await asar.createPackage(sourceDir, path.join(bundle.resourcesPath, "app.asar"));
  const result = await runProcess(resolveElectronBinary(), [
    path.join(ROOT, "scripts", "fixtures", "shoggoth-bundle-path-electron-fixture.cjs"),
    path.join(ROOT, "app", "agent-service", "bundle-paths.js"),
    JSON.stringify(bundle),
    JSON.stringify({ applicationsRoot }),
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: bundle });
});

test("Applications 门禁使用 lstat+realpath 拒绝 bundle/executable/resources/app.asar symlink escape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-app-realpath-"));
  const applicationsRoot = path.join(root, "Applications");
  fs.mkdirSync(applicationsRoot);
  const valid = makeTempAppBundle(applicationsRoot, "Valid.app");
  const validController = createLaunchAgentController({
    platform: "darwin", homeDir: path.join(root, "home-valid"), uid: 501,
    applicationsRoot, ...valid, runner: async () => ({ code: 0 }),
  });
  await validController.install();

  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(outsideRoot);
  const outsideBundle = makeTempAppBundle(outsideRoot, "Escaped.app");
  const bundleLink = path.join(applicationsRoot, "Escaped.app");
  fs.symlinkSync(outsideBundle.appPath, bundleLink);
  const linkedBundle = createLaunchAgentController({
    platform: "darwin", homeDir: path.join(root, "home-link"), uid: 501,
    applicationsRoot,
    appPath: bundleLink,
    executablePath: path.join(bundleLink, "Contents", "MacOS", "Shoggoth"),
    bootstrapPath: path.join(bundleLink, "Contents", "Resources", "app.asar", "app", "bootstrap.js"),
    resourcesPath: path.join(bundleLink, "Contents", "Resources"),
    runner: async () => ({ code: 0 }),
  });
  await assert.rejects(linkedBundle.install(), (error) => error.code === "UNSAFE_SYMLINK");

  for (const kind of ["executable", "resources", "archive"]) {
    const bundle = makeTempAppBundle(applicationsRoot, `${kind}.app`);
    if (kind === "executable") {
      fs.unlinkSync(bundle.executablePath);
      const outsideExecutable = path.join(root, "outside-executable");
      fs.writeFileSync(outsideExecutable, "outside");
      fs.symlinkSync(outsideExecutable, bundle.executablePath);
    } else if (kind === "resources") {
      fs.rmSync(bundle.resourcesPath, { recursive: true });
      const outsideResources = path.join(root, "outside-resources");
      fs.mkdirSync(outsideResources, { recursive: true });
      fs.writeFileSync(path.join(outsideResources, "app.asar"), "outside archive");
      fs.symlinkSync(outsideResources, bundle.resourcesPath);
    } else {
      const archivePath = path.join(bundle.resourcesPath, "app.asar");
      fs.unlinkSync(archivePath);
      const outsideArchive = path.join(root, "outside.asar");
      fs.writeFileSync(outsideArchive, "outside archive");
      fs.symlinkSync(outsideArchive, archivePath);
    }
    const controller = createLaunchAgentController({
      platform: "darwin", homeDir: path.join(root, `home-${kind}`), uid: 501,
      applicationsRoot, ...bundle, runner: async () => ({ code: 0 }),
    });
    await assert.rejects(
      controller.install(),
      (error) => error.code === "UNSAFE_SYMLINK" || error.code === "UNSAFE_APP_PATH",
    );
  }
});

test("plist XML 转义且 plist/status symlink 被拒绝", async () => {
  const fixture = launchFixture();
  const escapedBundle = makeTempAppBundle(fixture.applicationsRoot, "Shoggoth & Safe.app");
  const escaped = createLaunchAgentController({
    platform: "darwin", homeDir: fixture.homeDir, uid: 501,
    applicationsRoot: fixture.applicationsRoot, ...escapedBundle, runner: fixture.runner,
  });
  const installed = await escaped.install();
  assert.match(fs.readFileSync(installed.plistPath, "utf8"), /Shoggoth &amp; Safe/);

  for (const leaf of ["plistPath", "statusPath"]) {
    const fixture = launchFixture();
    const paths = fixture.controller.paths;
    fs.mkdirSync(path.dirname(paths[leaf]), { recursive: true, mode: 0o700 });
    const victim = path.join(fixture.homeDir, `victim-${leaf}`);
    fs.writeFileSync(victim, "safe");
    fs.symlinkSync(victim, paths[leaf]);
    await assert.rejects(fixture.controller.install(), (error) => error.code === "UNSAFE_SYMLINK");
    assert.equal(fs.readFileSync(victim, "utf8"), "safe");
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      completedTests += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  console.log("BOUNDARY source/fake: launchctl runner + temp HOME；packaged/real: Electron Service smoke only，未调用真实 launchd");
  console.log("BOUNDARY IPC: Node net 无 Unix peer-credential API；边界为 0700 parent + 0600 socket/token + token fd/socket inode pin");
  console.log("[shoggoth-service-lifecycle-unit] PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

process.on("beforeExit", () => {
  if (completedTests !== tests.length) {
    console.error(`FAIL 生命周期测试提前退出: ${completedTests}/${tests.length}`);
    process.exitCode = 1;
  }
});
