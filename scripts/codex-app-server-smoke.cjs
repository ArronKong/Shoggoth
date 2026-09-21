#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  CODEX_VERSION,
  CodexSchemaContract,
  validateSchemaValue,
} = require("../app/agent-service/codex-schema-contract");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { probeCodexBinaryVersion } = require("../app/agent-service/codex-binary-probe");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeAccountResolver, defaultRuntimeAccountLookup } = require("../app/agent-service/runtime-account-resolver");
const {
  CODEX_APP_SERVER_ARGS,
  buildCodexSpawnEnv,
  prepareCodexHome,
  resolveCodexRuntimeLayout,
} = require("../app/agent-service/codex-runtime-paths");
const { DEFAULT_MAX_REGISTERED_SECRETS } = require("../app/agent-service/codex-rpc-safety");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_RUNTIME_ACCOUNT_ID = "shoggoth-internal-codex-default-v1";

function codexHostRuntimeOptions({
  paths,
  runtimeProfileId,
  repoRoot = REPO_ROOT,
  packaged = false,
  resourcesPath,
}) {
  const home = prepareCodexHome(paths, runtimeProfileId);
  const layout = resolveCodexRuntimeLayout({ repoRoot, packaged, resourcesPath });
  const runtimeBinding = Object.freeze({
    runtime: "codex",
    runtimeProfileId,
    runtimeAccountId: TEST_RUNTIME_ACCOUNT_ID,
  });
  return {
    runtimeProfileId,
    runtimeAccountId: TEST_RUNTIME_ACCOUNT_ID,
    runtimeBinding,
    runtimeEnvironment: Object.freeze({
      runtime: "codex",
      runtimeAccountId: TEST_RUNTIME_ACCOUNT_ID,
      kind: "shoggoth-managed",
      installationKind: "bundled",
      homeKind: "managed-shared",
      strategy: "managed-shared",
      home,
      nativeHome: null,
      integrationRoot: null,
      binaryPath: layout.runtimePath,
      launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]),
      spawnEnv: Object.freeze({ HOME: os.homedir(), CODEX_HOME: home }),
      configurationMode: "overlay",
    }),
  };
}

function rejectsCode(action, code) {
  assert.throws(action, (error) => error?.code === code, `expected ${code}`);
}

function testGeneratedMethodMappingAndContracts() {
  const contract = new CodexSchemaContract({ repoRoot: REPO_ROOT });
  assert.equal(contract.version, "0.149.0");
  assert.equal(CODEX_VERSION, "0.149.0");
  assert.deepEqual(Object.fromEntries(Object.entries(contract.operations).map(([name, operation]) => [name, operation.method])), {
    initialize: "initialize",
    threadStart: "thread/start",
    threadResume: "thread/resume",
    threadInjectItems: "thread/inject_items",
    threadRead: "thread/read",
    threadList: "thread/list",
    threadSetName: "thread/name/set",
    threadArchive: "thread/archive",
    threadUnarchive: "thread/unarchive",
    threadDelete: "thread/delete",
    threadCompactStart: "thread/compact/start",
    threadGoalSet: "thread/goal/set",
    threadGoalGet: "thread/goal/get",
    threadGoalClear: "thread/goal/clear",
    turnStart: "turn/start",
    turnSteer: "turn/steer",
    turnInterrupt: "turn/interrupt",
    accountRead: "account/read",
    accountLoginStart: "account/login/start",
    accountLoginCancel: "account/login/cancel",
    accountLogout: "account/logout",
    modelList: "model/list",
    mcpServerStatusList: "mcpServerStatus/list",
    skillsList: "skills/list",
  });

  contract.validateParams("initialize", {
    clientInfo: { name: "shoggoth", version: "0.8.41" },
    capabilities: null,
  });
  contract.validateResponse("initialize", {
    userAgent: "codex/0.149.0",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "macos",
  });
  contract.validateParams("threadStart", {
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    threadSource: "shoggoth:chat",
  });
  contract.validateParams("threadResume", { threadId: "thread-1" });
  contract.validateParams("threadRead", { threadId: "thread-1", includeTurns: true });
  contract.validateParams("threadList", {
    limit: 25,
    sourceKinds: ["appServer"],
    archived: false,
  });
  contract.validateParams("threadSetName", { threadId: "thread-1", name: "Renamed" });
  contract.validateParams("threadArchive", { threadId: "thread-1" });
  contract.validateParams("threadUnarchive", { threadId: "thread-1" });
  contract.validateParams("threadDelete", { threadId: "thread-1" });
  contract.validateParams("threadCompactStart", { threadId: "thread-1" });
  contract.validateResponse("threadCompactStart", {});
  contract.validateParams("threadGoalSet", {
    threadId: "thread-1", objective: "Ship native slash commands", status: "active",
  });
  contract.validateParams("threadGoalGet", { threadId: "thread-1" });
  contract.validateResponse("threadGoalGet", { goal: null });
  contract.validateParams("threadGoalClear", { threadId: "thread-1" });
  contract.validateResponse("threadGoalClear", { cleared: true });
  contract.validateParams("mcpServerStatusList", {
    cursor: null, detail: "toolsAndAuthOnly", limit: 100, threadId: "thread-1",
  });
  contract.validateResponse("mcpServerStatusList", { data: [], nextCursor: null });
  contract.validateParams("skillsList", { cwds: ["/tmp"], forceReload: false });
  contract.validateResponse("skillsList", { data: [] });
  contract.validateParams("turnStart", {
    threadId: "thread-1",
    input: [{ type: "text", text: "offline", text_elements: [] }],
  });
  contract.validateParams("turnSteer", {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "steer", text_elements: [] }],
  });
  contract.validateParams("turnInterrupt", { threadId: "thread-1", turnId: "turn-1" });
  contract.validateParams("accountRead", { refreshToken: false });
  contract.validateParams("accountLoginStart", { type: "chatgpt" });
  contract.validateParams("accountLoginStart", { type: "chatgptDeviceCode" });
  contract.validateParams("accountLoginCancel", { loginId: "login-1" });
  contract.validateParams("accountLogout", undefined);
  contract.validateParams("modelList", { cursor: null, limit: 100, includeHidden: false });
  contract.validateResponse("accountRead", { account: null, requiresOpenaiAuth: true });
  contract.validateResponse("accountLoginStart", {
    type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example.test/start",
  });
  contract.validateResponse("accountLoginCancel", { status: "canceled" });
  contract.validateResponse("accountLogout", {});
  contract.validateResponse("modelList", {
    data: [{
      id: "gpt-fixture",
      model: "gpt-fixture",
      displayName: "GPT Fixture",
      description: "Fixture model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
    }],
    nextCursor: null,
  });
  contract.validateResponse("threadList", {
    data: [thread("thread-listed", { threadSource: "shoggoth:chat" })],
    nextCursor: null,
    backwardsCursor: "previous-page",
  });
  contract.validateResponse("threadSetName", {});
  contract.validateResponse("threadArchive", {});
  contract.validateResponse("threadUnarchive", {
    thread: thread("thread-unarchived", { threadSource: "shoggoth:chat" }),
  });
  contract.validateResponse("threadDelete", {});

  rejectsCode(() => contract.validateParams("threadRead", {}), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("threadList", { limit: -1 }), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("threadSetName", { threadId: "thread-1" }), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("threadArchive", {}), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("threadUnarchive", {}), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("threadDelete", {}), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateResponse("threadList", {
    data: [thread("thread-invalid-source", { threadSource: 7 })],
  }), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateResponse("threadUnarchive", {}), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateResponse("initialize", { userAgent: "bad" }), "CODEX_SCHEMA_ERROR");
  rejectsCode(() => contract.validateParams("missing", {}), "CODEX_SCHEMA_OPERATION_UNKNOWN");
}

function testNotificationAndServerRequestGates() {
  const contract = new CodexSchemaContract({ repoRoot: REPO_ROOT });
  assert.deepEqual(contract.validateNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "ok" },
  }), { known: true, method: "item/agentMessage/delta" });
  rejectsCode(() => contract.validateNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: 7 },
  }), "CODEX_SCHEMA_ERROR");
  assert.deepEqual(contract.validateNotification({
    method: "future/notification",
    params: { secret: "not-copied" },
  }), { known: false, method: "future/notification" });

  assert.equal(contract.serverRequests["item/commandExecution/requestApproval"].paramsDefinition, "CommandExecutionRequestApprovalParams");
  rejectsCode(() => contract.validateServerRequest({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: {},
  }), "CODEX_SCHEMA_ERROR");
  assert.deepEqual(contract.validateServerRequest({ id: 2, method: "future/request", params: {} }), {
    known: false,
    method: "future/request",
  });
}

function testDraft07SubsetAndLocalRefs() {
  const root = {
    definitions: {
      Choice: { oneOf: [{ enum: ["a"] }, { type: "integer", minimum: 1 }] },
    },
  };
  assert.deepEqual(validateSchemaValue({
    type: "object",
    required: ["choice", "items"],
    properties: {
      choice: { $ref: "#/definitions/Choice" },
      items: { type: "array", minItems: 1, items: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
    additionalProperties: false,
  }, { choice: 2, items: ["x", null] }, root), []);
  assert.ok(validateSchemaValue({ $ref: "#/definitions/Choice" }, 0, root).length > 0);
  assert.ok(validateSchemaValue({ type: "object", additionalProperties: false }, { extra: true }, root).length > 0);
}

function testGeneratedNumericFormatsAreEnforced() {
  const accepts = [
    ["int32", -2_147_483_648],
    ["int32", 2_147_483_647],
    ["int64", Number.MIN_SAFE_INTEGER],
    ["int64", Number.MAX_SAFE_INTEGER],
    ["uint", 0],
    ["uint", Number.MAX_SAFE_INTEGER],
    ["uint16", 0],
    ["uint16", 65_535],
    ["uint32", 0],
    ["uint32", 4_294_967_295],
    ["uint64", 0],
    ["uint64", Number.MAX_SAFE_INTEGER],
  ];
  for (const [format, value] of accepts) {
    assert.deepEqual(validateSchemaValue({ type: "integer", format }, value), [], `${format} boundary`);
  }
  const rejects = [
    ["int32", -2_147_483_649],
    ["int32", 2_147_483_648],
    ["int64", 1e100],
    ["uint", -1],
    ["uint16", -1],
    ["uint16", 65_536],
    ["uint32", -1],
    ["uint32", 4_294_967_296],
    ["uint64", -1],
    ["uint64", 1e100],
  ];
  for (const [format, value] of rejects) {
    assert.ok(validateSchemaValue({ type: "integer", format }, value).length > 0, `${format} rejects ${value}`);
  }
  assert.deepEqual(
    validateSchemaValue({ type: "integer", format: "future-compatible-format" }, 1e100),
    [],
    "unknown formats remain compatible",
  );
}

function testSchemaTamperFailsClosed() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-contract-tamper-"));
  try {
    const source = path.join(REPO_ROOT, "schemas", "codex-app-server", CODEX_VERSION);
    const target = path.join(scratch, "schemas", "codex-app-server", CODEX_VERSION);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    fs.appendFileSync(path.join(target, "json", "codex_app_server_protocol.v2.schemas.json"), "\n");
    rejectsCode(() => new CodexSchemaContract({ repoRoot: scratch }), "CODEX_SCHEMA_TAMPERED");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function testSchemaBundlesParseTheSameVerifiedRead() {
  const v2Path = path.join(
    REPO_ROOT,
    "schemas",
    "codex-app-server",
    CODEX_VERSION,
    "json",
    "codex_app_server_protocol.v2.schemas.json",
  );
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  const tamperedSchema = JSON.parse(originalReadFileSync(v2Path, "utf8"));
  tamperedSchema.definitions.InitializeParams = true;
  const tamperedContents = Buffer.from(JSON.stringify(tamperedSchema));
  let bundleReads = 0;
  fs.openSync = function injectedOpen(target, ...args) {
    if (path.resolve(String(target)) === v2Path) bundleReads += 1;
    return originalOpenSync.call(fs, target, ...args);
  };
  fs.readFileSync = function injectedRead(target, ...args) {
    if (path.resolve(String(target)) === v2Path) {
      bundleReads += 1;
      if (bundleReads > 1) {
        return args[0] === "utf8" ? tamperedContents.toString("utf8") : Buffer.from(tamperedContents);
      }
    }
    return originalReadFileSync.call(fs, target, ...args);
  };
  let contract;
  try {
    contract = new CodexSchemaContract({ repoRoot: REPO_ROOT });
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
  }
  rejectsCode(() => contract.validateParams("initialize", { injected: true }), "CODEX_SCHEMA_ERROR");
  assert.equal(bundleReads, 1, "a verified schema bundle must be read exactly once");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function thread(id = "thread-1", overrides = {}) {
  return {
    id,
    preview: "",
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    ephemeral: true,
    turns: [],
    cwd: REPO_ROOT,
    cliVersion: CODEX_VERSION,
    source: "appServer",
    sessionId: `session-${id}`,
    projectId: null,
    ...overrides,
  };
}

function threadConfigResponse(id = "thread-1") {
  return {
    thread: thread(id),
    model: "fake-model",
    modelProvider: "fake",
    serviceTier: null,
    cwd: REPO_ROOT,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort: null,
  };
}

function testCoreThreadResponseRejectsUnsafeInt64Timestamps() {
  const contract = new CodexSchemaContract({ repoRoot: REPO_ROOT });
  for (const field of ["createdAt", "updatedAt"]) {
    const response = threadConfigResponse();
    response.thread[field] = 1e100;
    rejectsCode(() => contract.validateResponse("threadStart", response), "CODEX_SCHEMA_ERROR");
  }
}

class FakeAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = options.pid ?? 5000;
    this.requests = [];
    this.responses = [];
    this.notifications = [];
    this.invalidInitialize = options.invalidInitialize;
    this.accountResponse = options.accountResponse;
    this.closed = false;
    let buffer = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this._receive(message);
      }
    });
  }

  _send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  _receive(message) {
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      this.responses.push(message);
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      this.notifications.push(message);
      return;
    }
    this.requests.push(message);
    let result;
    if (message.method === "initialize") {
      result = this.invalidInitialize ? { userAgent: "invalid" } : {
        userAgent: `codex/${CODEX_VERSION}`,
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      };
    } else if (message.method === "thread/start") {
      result = threadConfigResponse("thread-started");
      result.thread.threadSource = message.params.threadSource ?? null;
    }
    else if (message.method === "thread/resume") result = threadConfigResponse(message.params.threadId);
    else if (message.method === "thread/read") result = { thread: thread(message.params.threadId) };
    else if (message.method === "thread/list") result = {
      data: [thread("thread-listed", { threadSource: "shoggoth:chat" })],
      nextCursor: "next-page",
      backwardsCursor: null,
    };
    else if (message.method === "thread/name/set") result = {};
    else if (message.method === "thread/archive") result = {};
    else if (message.method === "thread/unarchive") result = {
      thread: thread(message.params.threadId, { threadSource: "shoggoth:chat" }),
    };
    else if (message.method === "thread/delete") result = {};
    else if (message.method === "turn/start") result = { turn: { id: "turn-started", status: "inProgress", items: [] } };
    else if (message.method === "turn/steer") result = { turnId: message.params.expectedTurnId };
    else if (message.method === "turn/interrupt") result = {};
    else if (message.method === "account/read") result = this.accountResponse || {
      account: { type: "chatgpt", email: "private@example.test", planType: "plus" },
      requiresOpenaiAuth: true,
    };
    else if (message.method === "account/login/start" && message.params.type === "chatgpt") result = {
      type: "chatgpt", loginId: "login-browser", authUrl: "https://auth.example.test/browser",
    };
    else if (message.method === "account/login/start" && message.params.type === "chatgptDeviceCode") result = {
      type: "chatgptDeviceCode",
      loginId: "login-device",
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    };
    else if (message.method === "account/login/start" && message.params.type === "apiKey") result = {
      type: "apiKey",
    };
    else if (message.method === "account/login/cancel") result = { status: "canceled" };
    else if (message.method === "account/logout") result = {};
    else throw new Error(`unexpected method ${message.method}`);
    queueMicrotask(() => this._send({ id: message.id, result }));
  }

  sendNotification(method, params) {
    this._send({ method, params });
  }

  sendServerRequest(id, method, params) {
    this._send({ id, method, params });
  }

  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function servicePathsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-unit-"));
  return {
    root,
    paths: resolveServicePaths({
      trustedRoot: root,
      stateRoot: path.join(root, "state"),
      profileRoot: path.join(root, "profile"),
      cacheRoot: path.join(root, "cache"),
    }),
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`${label} timed out`);
}

function writeRuntimeFixture(root) {
  const packageRoot = path.join(root, ".vendor", "codex", process.arch, "package");
  const bin = path.join(packageRoot, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const runtimePath = path.join(bin, "codex");
  const hostPath = path.join(bin, "codex-code-mode-host");
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "fixtures", "codex-app-server-fake.cjs"), runtimePath);
  fs.writeFileSync(hostPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(runtimePath, 0o755);
  fs.chmodSync(hostPath, 0o755);
  fs.writeFileSync(path.join(packageRoot, "codex-package.json"), `${JSON.stringify({
    layoutVersion: 1,
    version: CODEX_VERSION,
    target: process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
    variant: "codex",
    entrypoint: "bin/codex",
  })}\n`);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.writeFileSync(path.join(root, "build", "codex-runtime-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runtime: { name: "codex", version: CODEX_VERSION },
    schema: { version: CODEX_VERSION, includeExperimental: false },
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        destination: path.relative(root, runtimePath),
        packageDestination: path.relative(root, packageRoot),
        hostDestination: path.relative(root, hostPath),
      },
    },
  })}\n`);
  return { runtimePath, hostPath, packageRoot };
}

function testPackagedRuntimeUsesResourcesLayout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-packaged-layout-")));
  try {
    const resources = path.join(root, "Resources");
    const packageRoot = path.join(resources, "codex", "package");
    const bin = path.join(packageRoot, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ["codex", "codex-code-mode-host"]) {
      fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    fs.writeFileSync(path.join(packageRoot, "codex-package.json"), `${JSON.stringify({
      layoutVersion: 1, version: CODEX_VERSION, variant: "codex", entrypoint: "bin/codex",
    })}\n`);
    fs.copyFileSync(
      path.join(REPO_ROOT, "build", "codex-runtime-manifest.json"),
      path.join(resources, "codex", "runtime-manifest.json"),
    );
    const layout = resolveCodexRuntimeLayout({
      packaged: true,
      resourcesPath: resources,
      repoRoot: "/must/not/be/used",
    });
    assert.equal(layout.runtimePath, path.join(resources, "codex", "package", "bin", "codex"));
    const builder = fs.readFileSync(path.join(REPO_ROOT, "electron-builder.yml"), "utf8");
    assert.match(builder, /from: build\/codex-runtime-manifest\.json[\s\S]*to: codex\/runtime-manifest\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRuntimeManifestPathsStayInsideTrustedRoot() {
  const assertManifestRejected = (root, packaged = false, resourcesPath) => {
    assert.throws(
      () => resolveCodexRuntimeLayout({ repoRoot: root, packaged, resourcesPath }),
      (error) => error?.code === "CODEX_RUNTIME_MANIFEST_INVALID",
    );
  };
  const rewritePlatform = (root, update) => {
    const manifestPath = path.join(root, "build", "codex-runtime-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    Object.assign(manifest.platforms[`${process.platform}-${process.arch}`], update);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  };

  for (const update of [
    { destination: `.vendor/codex/${process.arch}/package/bin/../bin/codex` },
    { packageDestination: `.vendor/codex/${process.arch}/other/../package` },
    { hostDestination: `.vendor/codex/${process.arch}/package/bin/../bin/codex-code-mode-host` },
    { destination: path.join(os.tmpdir(), "codex-absolute-escape") },
    { packageDestination: path.join(os.tmpdir(), "codex-package-absolute-escape") },
    { hostDestination: path.join(os.tmpdir(), "codex-host-absolute-escape") },
  ]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-manifest-containment-")));
    try {
      writeRuntimeFixture(root);
      rewritePlatform(root, update);
      assertManifestRejected(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const symlinkRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-manifest-symlink-")));
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-manifest-external-")));
  try {
    const layout = writeRuntimeFixture(symlinkRoot);
    fs.cpSync(layout.packageRoot, external, { recursive: true });
    fs.rmSync(layout.packageRoot, { recursive: true, force: true });
    fs.symlinkSync(external, layout.packageRoot);
    assertManifestRejected(symlinkRoot);
  } finally {
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }

  const packagedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-packaged-containment-")));
  const packagedExternal = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-packaged-external-")));
  try {
    writeRuntimeFixture(packagedExternal);
    fs.mkdirSync(path.join(packagedRoot, "Resources"), { recursive: true });
    fs.symlinkSync(path.join(packagedExternal, ".vendor", "codex", process.arch), path.join(packagedRoot, "Resources", "codex"));
    fs.copyFileSync(
      path.join(packagedExternal, "build", "codex-runtime-manifest.json"),
      path.join(packagedExternal, ".vendor", "codex", process.arch, "runtime-manifest.json"),
    );
    assertManifestRejected(packagedRoot, true, path.join(packagedRoot, "Resources"));
  } finally {
    fs.rmSync(packagedRoot, { recursive: true, force: true });
    fs.rmSync(packagedExternal, { recursive: true, force: true });
  }
}

function hostFixture(overrides = {}) {
  const fixture = servicePathsFixture();
  const children = [];
  const spawns = [];
  const kills = [];
  const spawnProcess = (command, args, options) => {
    const child = new FakeAppServer({ pid: 5000 + children.length, ...overrides.childOptions });
    children.push(child);
    spawns.push({ command, args, options });
    return child;
  };
  const killProcessGroup = (pid, signal) => {
    kills.push({ pid, signal });
    const child = children.find((entry) => entry.pid === pid);
    if (signal === "SIGTERM") queueMicrotask(() => child?.close(0, signal));
  };
  const runtimeProfileId = overrides.runtimeProfileId || "profile-a";
  const runtimeOptions = codexHostRuntimeOptions({
    paths: fixture.paths,
    runtimeProfileId,
    repoRoot: overrides.hostOptions?.repoRoot || REPO_ROOT,
    packaged: overrides.hostOptions?.packaged,
    resourcesPath: overrides.hostOptions?.resourcesPath,
  });
  const host = new CodexRuntimeHost({
    ...runtimeOptions,
    paths: fixture.paths,
    repoRoot: REPO_ROOT,
    packageVersion: "0.8.41",
    schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    probeBinary: overrides.probeBinary || (async () => {}),
    spawnProcess,
    killProcessGroup,
    processGroupExists: overrides.processGroupExists || (() => false),
    prepareRuntime: overrides.prepareRuntime,
    parentEnv: {
      HOME: os.homedir(),
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      LANG: "en_US.UTF-8",
      EVIL_TOKEN: "parent-secret-must-not-pass",
    },
    spawnEnv: overrides.spawnEnv,
    registeredSecrets: overrides.registeredSecrets,
    requestTimeoutMs: 100,
    initializeTimeoutMs: 100,
    shutdownGraceMs: 50,
    killGraceMs: overrides.killGraceMs ?? 50,
    ...overrides.hostOptions,
  });
  return { ...fixture, host, children, spawns, kills };
}

async function testPackagedHostUsesPhysicalCodexHomeAsProcessCwd() {
  const packagedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-packaged-host-cwd-")));
  const resourcesPath = path.join(packagedRoot, "Resources");
  const packageRoot = path.join(resourcesPath, "codex", "package");
  const binPath = path.join(packageRoot, "bin");
  fs.mkdirSync(binPath, { recursive: true });
  for (const name of ["codex", "codex-code-mode-host"]) {
    fs.writeFileSync(path.join(binPath, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(path.join(packageRoot, "codex-package.json"), `${JSON.stringify({
    layoutVersion: 1,
    version: CODEX_VERSION,
    variant: "codex",
    entrypoint: "bin/codex",
  })}\n`);
  fs.copyFileSync(
    path.join(REPO_ROOT, "build", "codex-runtime-manifest.json"),
    path.join(resourcesPath, "codex", "runtime-manifest.json"),
  );
  const virtualRepoRoot = path.join(resourcesPath, "app.asar");
  fs.writeFileSync(virtualRepoRoot, "asar is not a process cwd");
  let probeCwd = null;
  const fixture = hostFixture({
    probeBinary: async (_binary, options) => { probeCwd = options.cwd; },
    hostOptions: {
      packaged: true,
      resourcesPath,
      repoRoot: virtualRepoRoot,
      schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    },
  });
  try {
    await fixture.host.initialize();
    const codexHome = path.join(fixture.paths.stateDir, "codex", "profile-a");
    assert.equal(probeCwd, codexHome);
    assert.equal(fixture.spawns[0].options.cwd, codexHome);
    assert.equal(fs.statSync(codexHome).isDirectory(), true);
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(packagedRoot, { recursive: true, force: true });
  }
}

async function testVersionProbeRunsBeforePrepareAndNeverReceivesProviderEnvironment() {
  const secret = "prepared-runtime-secret-00000001";
  const envName = "SHOGGOTH_PROVIDER_0123456789ABCDEF_API_KEY";
  const order = [];
  const prepared = hostFixture({
    prepareRuntime: async ({ runtimeProfileId, codexHome }) => {
      order.push("prepare");
      assert.equal(runtimeProfileId, "profile-a");
      assert.equal(codexHome, path.join(prepared.paths.stateDir, "codex", "profile-a"));
      return {
        spawnEnv: { [envName]: secret, AWS_SECRET_ACCESS_KEY: "prepared-aws-secret-000001" },
        registeredSecrets: [secret],
        runtimeConfig: { provider: { id: "provider-a" } },
      };
    },
    probeBinary: async (_binary, options) => {
      order.push("probe");
      assert.equal(options.env[envName], undefined);
      assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
    },
  });
  try {
    await prepared.host.initialize();
    assert.deepEqual(order, ["probe", "prepare"]);
    assert.equal(prepared.spawns.length, 1);
    assert.equal(prepared.spawns[0].options.env[envName], secret);
    assert.equal(prepared.spawns[0].options.env.AWS_SECRET_ACCESS_KEY, "prepared-aws-secret-000001");
    const events = [];
    prepared.host.subscribe((event) => events.push(event));
    prepared.children[0].sendNotification("future/prepared", { token: secret });
    await delay(0);
    const event = events.at(-1);
    assert.equal(JSON.stringify(event).includes(secret), false);
  } finally {
    await prepared.host.stop();
    assert.deepEqual(prepared.host.registeredSecrets, []);
    assert.deepEqual(prepared.host.options.spawnEnv, {});
    assert.deepEqual(prepared.host.options.registeredSecrets, []);
    fs.rmSync(prepared.root, { recursive: true, force: true });
  }

  let probed = false;
  const locked = hostFixture({
    prepareRuntime: async () => {
      const error = new Error("credentials_locked");
      error.code = "credentials_locked";
      throw error;
    },
    probeBinary: async () => { probed = true; },
  });
  try {
    await assert.rejects(
      locked.host.initialize(),
      (error) => error.code === "credentials_locked",
    );
    assert.equal(probed, true);
    assert.equal(locked.spawns.length, 0);
  } finally {
    await locked.host.stop().catch(() => {});
    fs.rmSync(locked.root, { recursive: true, force: true });
  }

  const poolFixture = servicePathsFixture();
  let poolSpawns = 0;
  let poolProbes = 0;
  const pool = new CodexRuntimePool({
    paths: poolFixture.paths,
    hostFactory: (options) => new CodexRuntimeHost({
      ...options,
      repoRoot: REPO_ROOT,
      schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
      prepareRuntime: async () => {
        const error = new Error("credentials_locked");
        error.code = "credentials_locked";
        throw error;
      },
      probeBinary: async () => { poolProbes += 1; },
      spawnProcess: () => { poolSpawns += 1; throw new Error("spawn must not run"); },
    }),
  });
  try {
    await assert.rejects(
      pool.get("pool-locked"),
      (error) => error.code === "credentials_locked",
    );
    assert.equal(poolProbes, 1);
    assert.equal(poolSpawns, 0);
  } finally {
    await pool.stopAll().catch(() => {});
    fs.rmSync(poolFixture.root, { recursive: true, force: true });
  }
}

async function testBedrockPreparedAwsEnvIsAppServerOnlyAndRedacted() {
  const secret = "bedrock-secret-access-key-host-fixture-000001";
  const session = "bedrock-session-token-host-fixture-000001";
  const fixture = hostFixture({
    prepareRuntime: async () => ({
      spawnEnv: {
        AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP", // gitleaks:allow -- synthetic test fixture; not a usable credential
        AWS_SECRET_ACCESS_KEY: secret,
        AWS_SESSION_TOKEN: session,
        AWS_PROFILE: "engineering-dev",
        AWS_REGION: "us-west-2",
        AWS_DEFAULT_REGION: "us-west-2",
      },
      registeredSecrets: ["AKIAABCDEFGHIJKLMNOP", secret, session], // gitleaks:allow -- synthetic test fixture; not a usable credential
      runtimeConfig: { provider: { kind: "amazon-bedrock" } },
    }),
  });
  try {
    await fixture.host.initialize();
    const env = fixture.spawns[0].options.env;
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIAABCDEFGHIJKLMNOP"); // gitleaks:allow -- synthetic test fixture; not a usable credential
    assert.equal(env.AWS_SECRET_ACCESS_KEY, secret);
    assert.equal(env.AWS_SESSION_TOKEN, session);
    assert.equal(env.AWS_PROFILE, "engineering-dev");
    assert.equal(env.AWS_REGION, "us-west-2");
    assert.equal(env.AWS_DEFAULT_REGION, "us-west-2");
    const events = [];
    fixture.host.subscribe((event) => events.push(event));
    fixture.children[0].sendNotification("future/bedrock", { diagnostic: `${secret}:${session}` });
    await delay(0);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(JSON.stringify(events).includes(session), false);
  } finally {
    await fixture.host.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testHostOwnsFrozenSecretContainersAndIdleStopSettles() {
  const fixture = servicePathsFixture();
  const externalSpawnEnv = Object.freeze({
    SHOGGOTH_PROVIDER_ABCDEF0123456789_API_KEY: "frozen-provider-secret-000001",
  });
  const externalRegisteredSecrets = Object.freeze(["frozen-provider-secret-000001"]);
  const host = new CodexRuntimeHost({
    ...codexHostRuntimeOptions({
      paths: fixture.paths,
      runtimeProfileId: "profile-frozen-input",
    }),
    paths: fixture.paths,
    repoRoot: REPO_ROOT,
    packageVersion: "0.8.41",
    schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    spawnEnv: externalSpawnEnv,
    registeredSecrets: externalRegisteredSecrets,
  });
  try {
    assert.notEqual(host.options.spawnEnv, externalSpawnEnv);
    assert.notEqual(host.options.registeredSecrets, externalRegisteredSecrets);
    await host.stop();
    await host.terminated;
    assert.equal(host.state, "stopped");
    assert.deepEqual(host.options.spawnEnv, {});
    assert.deepEqual(host.options.registeredSecrets, []);
    assert.deepEqual(externalSpawnEnv, {
      SHOGGOTH_PROVIDER_ABCDEF0123456789_API_KEY: "frozen-provider-secret-000001",
    });
    assert.deepEqual(externalRegisteredSecrets, ["frozen-provider-secret-000001"]);
  } finally {
    await host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testBinaryVersionProbeIsStrictBoundedAndSanitized() {
  const safeEnv = Object.freeze({ HOME: "/safe/home", CODEX_HOME: "/safe/codex", PATH: "/usr/bin:/bin" });
  let nextPid = 7_000;
  const fakeSpawn = ({ stdout = "", stderr = "", code = 0, hang = false } = {}) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (!hang) {
      queueMicrotask(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", code, null);
      });
    }
    return child;
  };
  const calls = [];
  const success = await probeCodexBinaryVersion("/safe/codex", {
    cwd: "/safe/repo",
    env: safeEnv,
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      return fakeSpawn({ stdout: `codex-cli ${CODEX_VERSION}\n` });
    },
  });
  assert.deepEqual(success, { version: CODEX_VERSION });
  assert.equal(calls[0].file, "/safe/codex");
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.cwd, "/safe/repo");
  assert.equal(calls[0].options.env, safeEnv);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, process.platform !== "win32");
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.windowsHide, true);

  for (const version of [CODEX_VERSION, "0.153.4", "0.154.0-alpha.2", "0.153.4+build.1"]) {
    const result = await probeCodexBinaryVersion("/safe/system-codex", {
      installationKind: "system",
      env: safeEnv,
      spawnImpl: () => fakeSpawn({ stdout: `codex-cli ${version}\n` }),
    });
    assert.deepEqual(result, { version });
  }
  for (const version of ["0.148.99", "0.149.0-alpha.1", "0.153", "99999999999999999.0.0", "invalid-output"]) {
    await assert.rejects(probeCodexBinaryVersion("/safe/system-codex", {
      installationKind: "system",
      env: safeEnv,
      spawnImpl: () => fakeSpawn({ stdout: `codex-cli ${version}\n` }),
    }), (error) => error.code === "CODEX_RUNTIME_VERSION_MISMATCH");
  }

  const secret = "registered-probe-secret";
  const failures = [
    { child: { stdout: "codex-cli 0.150.0\n", stderr: secret }, code: "CODEX_RUNTIME_VERSION_MISMATCH" },
    { child: { stdout: `codex-cli ${CODEX_VERSION}\n`, stderr: secret, code: 7 }, code: "CODEX_RUNTIME_VERSION_PROBE_FAILED" },
    { child: { stdout: secret.repeat(2_000) }, code: "CODEX_RUNTIME_VERSION_PROBE_FAILED" },
  ];
  for (const failure of failures) {
    await assert.rejects(
      probeCodexBinaryVersion("/safe/codex", {
        cwd: "/safe/repo",
        env: { ...safeEnv, OPENAI_API_KEY: secret },
        spawnImpl: () => fakeSpawn(failure.child),
        killProcessGroup: (_pid, _signal, child) => child.emit("close", null, "SIGTERM"),
        timeoutMs: 10,
      }),
      (error) => error?.code === failure.code && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret),
    );
  }

  const timeoutChild = fakeSpawn({ hang: true });
  const timeoutKills = [];
  let timeoutGroupAlive = true;
  await assert.rejects(
    probeCodexBinaryVersion("/safe/codex", {
      cwd: "/safe/repo",
      env: safeEnv,
      spawnImpl: () => timeoutChild,
      timeoutMs: 10,
      killGraceMs: 10,
      hardSettleMs: 100,
      killProcessGroup(_pid, signal, child) {
        timeoutKills.push(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, signal));
        if (signal === "SIGKILL") timeoutGroupAlive = false;
      },
      processGroupExists: () => timeoutGroupAlive,
    }),
    (error) => error?.code === "CODEX_RUNTIME_VERSION_PROBE_FAILED",
  );
  assert.deepEqual(timeoutKills, ["SIGTERM", "SIGKILL"]);

  const unconfirmedChild = fakeSpawn({ hang: true });
  const unconfirmedKills = [];
  await assert.rejects(
    probeCodexBinaryVersion("/safe/codex", {
      cwd: "/safe/repo",
      env: safeEnv,
      spawnImpl: () => unconfirmedChild,
      timeoutMs: 10,
      killGraceMs: 10,
      hardSettleMs: 20,
      killProcessGroup(_pid, signal, child) {
        unconfirmedKills.push(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0, signal));
      },
      processGroupExists: () => true,
    }),
    (error) => error?.code === "CODEX_RUNTIME_VERSION_PROBE_FAILED" && error.cleanupIncomplete === true,
  );
  assert.deepEqual(unconfirmedKills, ["SIGTERM", "SIGKILL"]);

  await assert.rejects(
    probeCodexBinaryVersion("/safe/codex", {
      cwd: "/safe/repo",
      env: { ...safeEnv, OPENAI_API_KEY: secret },
      spawnImpl() { throw new Error(secret); },
    }),
    (error) => error?.code === "CODEX_RUNTIME_VERSION_PROBE_FAILED"
      && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(secret),
  );

  const rejected = hostFixture({
    probeBinary: async () => {
      const error = new Error("Codex binary version is incompatible");
      error.code = "CODEX_RUNTIME_VERSION_MISMATCH";
      throw error;
    },
  });
  try {
    await assert.rejects(rejected.host.initialize(), (error) => error?.code === "CODEX_RUNTIME_VERSION_MISMATCH");
    assert.equal(rejected.spawns.length, 0, "app-server must not spawn after a rejected binary probe");
  } finally {
    await rejected.host.stop().catch(() => {});
    fs.rmSync(rejected.root, { recursive: true, force: true });
  }

  let probed = false;
  const accepted = hostFixture({ probeBinary: async () => { probed = true; } });
  try {
    await accepted.host.initialize();
    assert.equal(probed, true);
    assert.equal(accepted.spawns.length, 1, "app-server may spawn only after a successful binary probe");
  } finally {
    await accepted.host.stop();
    fs.rmSync(accepted.root, { recursive: true, force: true });
  }
}

async function testBinaryVersionProbeAsyncSpawnFailuresAreContained() {
  if (process.platform === "win32") return;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-spawn-error-")));
  const secret = "async-spawn-secret";
  const invalidInterpreterPath = path.join(root, "invalid-interpreter");
  const nonExecutablePath = path.join(root, "non-executable");
  fs.writeFileSync(invalidInterpreterPath, `#!/private/${secret}/missing-node\n`, { mode: 0o755 });
  fs.writeFileSync(nonExecutablePath, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  const cases = [
    ["missing executable", path.join(root, `missing-${secret}`)],
    ["invalid interpreter", invalidInterpreterPath],
    ["non-executable", nonExecutablePath],
  ];
  const processErrors = [];
  const captureUncaught = (error, origin) => {
    processErrors.push({ type: "uncaughtException", origin, code: error?.code, message: error?.message });
  };
  const captureUnhandled = (error) => {
    processErrors.push({ type: "unhandledRejection", code: error?.code, message: error?.message });
  };
  process.prependListener("uncaughtException", captureUncaught);
  process.prependListener("unhandledRejection", captureUnhandled);
  try {
    const outcomes = [];
    for (const [name, runtimePath] of cases) {
      let childClosed;
      const closed = new Promise((resolve) => { childClosed = resolve; });
      let rejectionCount = 0;
      let probeFailure;
      const fixture = hostFixture({
        probeBinary: async () => {
          try {
            return await probeCodexBinaryVersion(runtimePath, {
              cwd: root,
              env: {
                HOME: root,
                PATH: process.env.PATH || "/usr/bin:/bin",
                TMPDIR: os.tmpdir(),
                OPENAI_API_KEY: secret,
              },
              spawnImpl(file, args, options) {
                const child = spawn(file, args, options);
                child.once("close", childClosed);
                return child;
              },
            });
          } catch (error) {
            rejectionCount += 1;
            probeFailure = error;
            throw error;
          }
        },
      });
      try {
        await assert.rejects(
          fixture.host.initialize(),
          (error) => error?.code === "CODEX_RUNTIME_VERSION_PROBE_FAILED",
          name,
        );
        const closeObserved = await Promise.race([
          closed.then(() => true),
          delay(100).then(() => false),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(rejectionCount, 1, `${name} must reject exactly once`);
        assert.equal(probeFailure?.code, "CODEX_RUNTIME_VERSION_PROBE_FAILED");
        assert.equal(
          JSON.stringify(probeFailure, Object.getOwnPropertyNames(probeFailure)).includes(secret),
          false,
          `${name} rejection must be sanitized`,
        );
        assert.equal(fixture.spawns.length, 0, `${name} must not spawn app-server`);
        outcomes.push({ name, closeObserved });
      } finally {
        await fixture.host.stop().catch(() => {});
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(processErrors, [], "async spawn failures must not escape to process-level handlers");
    assert.equal(outcomes.every((outcome) => outcome.closeObserved), true, "async spawn failures must close child lifecycle");
  } finally {
    process.removeListener("uncaughtException", captureUncaught);
    process.removeListener("unhandledRejection", captureUnhandled);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRealVersionProbeKillsTermIgnoringProcessGroup() {
  if (process.platform === "win32") return;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-hang-")));
  const runtimePath = path.join(root, "codex");
  const readyPath = path.join(root, "probe.ready");
  const kills = [];
  let pids = [];
  let ready;
  let readyError;
  let timeoutStartedAt;
  const readyWaiter = new Int32Array(new SharedArrayBuffer(4));
  const waitForReady = (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(fs.readFileSync(readyPath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      Atomics.wait(readyWaiter, 0, 0, Math.min(10, deadline - Date.now()));
    }
    return null;
  };
  try {
    fs.copyFileSync(
      path.join(REPO_ROOT, "scripts", "fixtures", "codex-version-probe-hang.cjs"),
      runtimePath,
    );
    fs.chmodSync(runtimePath, 0o755);
    const startedAt = Date.now();
    await assert.rejects(
      probeCodexBinaryVersion(runtimePath, {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env.PATH || "/usr/bin:/bin",
          TMPDIR: os.tmpdir(),
          CODEX_PROBE_READY_PATH: readyPath,
        },
        timeoutMs: 50,
        killGraceMs: 25,
        hardSettleMs: 500,
        spawnImpl(file, args, options) {
          const child = spawn(file, args, options);
          try {
            ready = waitForReady(5_000);
            if (ready) {
              pids = [ready.pid, ready.descendantPid];
              if (ready.pid !== child.pid || ready.pgid !== child.pid || !pids.every(processAlive)) {
                readyError = new Error("probe fixture ready marker is inconsistent");
              }
            }
          } catch (error) {
            readyError = error;
          }
          timeoutStartedAt = Date.now();
          return child;
        },
        killProcessGroup(pid, signal) {
          kills.push({ signal, groupAliveBefore: processAlive(-pid) });
          try {
            process.kill(-pid, signal);
          } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
        },
      }),
      (error) => error?.code === "CODEX_RUNTIME_VERSION_PROBE_FAILED" && error.cleanupIncomplete !== true,
    );
    if (readyError) throw readyError;
    assert.ok(ready, "probe fixture ready handshake timed out");
    assert.ok(timeoutStartedAt >= startedAt, "probe timeout must start after fixture readiness");
    assert.ok(Date.now() - timeoutStartedAt < 1_000, "leader-exiting probe must reject within its hard bound");
    assert.deepEqual(kills, [
      { signal: "SIGTERM", groupAliveBefore: true },
      { signal: "SIGKILL", groupAliveBefore: true },
    ], "descendant process group must survive leader TERM exit and require KILL");
    assert.deepEqual(ready, { pid: pids[0], descendantPid: pids[1], pgid: pids[0] });
    await waitFor(() => pids.every((pid) => !processAlive(pid)), 2_000, "probe process group cleanup");
    assert.equal(processAlive(-ready.pgid), false, "probe process group must no longer exist");
  } finally {
    for (const pid of pids) {
      if (processAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRuntimeHostCoreApiEnvironmentAndEvents() {
  const fixture = hostFixture({ spawnEnv: { OPENAI_API_KEY: "explicit-provider-secret" } });
  try {
    const initialized = await fixture.host.initialize();
    assert.equal(initialized.userAgent, `codex/${CODEX_VERSION}`);
    assert.equal(fixture.spawns.length, 1);
    const spawn = fixture.spawns[0];
    assert.deepEqual(spawn.args, ["-c", "check_for_update_on_startup=false", "app-server", "--stdio"]);
    assert.equal(spawn.options.detached, true);
    assert.equal(spawn.options.env.EVIL_TOKEN, undefined);
    assert.equal(spawn.options.env.OPENAI_API_KEY, "explicit-provider-secret");
    assert.equal(spawn.options.env.CODEX_HOME, path.join(fixture.paths.stateDir, "codex", "profile-a"));
    assert.equal(fixture.children[0].requests[0].params.clientInfo.name, "shoggoth");
    assert.equal(fixture.children[0].requests[0].params.clientInfo.version, "0.8.41");
    assert.deepEqual(fixture.children[0].notifications[0], { method: "initialized" });

    const threadSource = "shoggoth:chat";
    const started = await fixture.host.threadStart({
      cwd: REPO_ROOT,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      threadSource,
    });
    assert.equal(started.thread.id, "thread-started");
    assert.equal(started.thread.threadSource, threadSource);
    assert.equal(
      fixture.children[0].requests.find((request) => request.method === "thread/start")
        .params.threadSource,
      threadSource,
    );
    assert.equal((await fixture.host.threadResume({ threadId: "thread-started" })).thread.id, "thread-started");
    assert.equal((await fixture.host.threadRead({ threadId: "thread-started", includeTurns: true })).thread.id, "thread-started");
    const listed = await fixture.host.threadList({ limit: 10, sourceKinds: ["appServer"] });
    assert.equal(listed.data[0].threadSource, "shoggoth:chat");
    assert.equal(listed.nextCursor, "next-page");
    assert.deepEqual(await fixture.host.threadSetName({ threadId: "thread-started", name: "Renamed" }), {});
    assert.deepEqual(await fixture.host.threadArchive({ threadId: "thread-started" }), {});
    assert.equal((await fixture.host.threadUnarchive({ threadId: "thread-started" })).thread.id, "thread-started");
    assert.deepEqual(await fixture.host.threadDelete({ threadId: "thread-started" }), {});
    assert.deepEqual(
      fixture.children[0].requests
        .filter((request) => [
          "thread/list",
          "thread/name/set",
          "thread/archive",
          "thread/unarchive",
          "thread/delete",
        ].includes(request.method))
        .map((request) => request.method),
      [
        "thread/list",
        "thread/name/set",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
      ],
    );
    assert.equal((await fixture.host.turnStart({ threadId: "thread-started", input: [{ type: "text", text: "offline", text_elements: [] }] })).turn.id, "turn-started");
    assert.equal((await fixture.host.turnSteer({ threadId: "thread-started", expectedTurnId: "turn-started", input: [{ type: "text", text: "steer", text_elements: [] }] })).turnId, "turn-started");
    assert.deepEqual(await fixture.host.turnInterrupt({ threadId: "thread-started", turnId: "turn-started" }), {});

    const events = [];
    fixture.host.subscribe((event) => events.push(event));
    fixture.children[0].sendNotification("item/agentMessage/delta", {
      threadId: "thread-started", turnId: "turn-started", itemId: "item-1", delta: "hello",
    });
    fixture.children[0].sendNotification("thread/tokenUsage/updated", {
      threadId: "thread-started",
      turnId: "turn-started",
      tokenUsage: {
        total: {
          totalTokens: 120,
          inputTokens: 80,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          outputTokens: 40,
          reasoningOutputTokens: 10,
        },
        last: {
          totalTokens: 30,
          inputTokens: 20,
          cachedInputTokens: 5,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 200_000,
      },
    });
    fixture.children[0].sendNotification("future/notification", {
      threadId: "thread-started", turnId: "turn-started", token: "explicit-provider-secret",
    });
    await delay(0);
    assert.equal(events[0].type, "text_delta");
    assert.equal(events[1].type, "usage");
    assert.deepEqual(events[1].usage, {
      totalTokens: 30,
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 2,
    });
    assert.match(events[1].responseId, /^thread-usage-[a-f0-9]{64}$/u);
    assert.equal(events[2].known, false);
    assert.equal(JSON.stringify(events[2]).includes("explicit-provider-secret"), false);

    let handledApprovalParams;
    fixture.host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
      handledApprovalParams = params;
      return { decision: "accept" };
    });
    fixture.children[0].sendServerRequest("approval-1", "item/commandExecution/requestApproval", {
      threadId: "thread-started",
      turnId: "turn-started",
      itemId: "item-approval",
      startedAtMs: 1,
      environmentId: null,
      command: "printf explicit-provider-secret",
    });
    await delay(0);
    assert.deepEqual(fixture.children[0].responses.at(-1), {
      id: "approval-1",
      result: { decision: "accept" },
    });
    assert.equal(handledApprovalParams.command, "printf explicit-provider-secret", "handler must receive original params");
    const publishedApproval = events.find((event) => event.requestId === "approval-1");
    assert.equal(publishedApproval.type, "approval");
    assert.equal(JSON.stringify(publishedApproval).includes("explicit-provider-secret"), false);

    let handledPromptParams;
    fixture.host.registerServerRequestHandler("item/tool/requestUserInput", async (params) => {
      handledPromptParams = params;
      return { answers: { choice: { answers: ["Yes"] } } };
    });
    fixture.children[0].sendServerRequest("prompt-1", "item/tool/requestUserInput", {
      threadId: "thread-started",
      turnId: "turn-started",
      itemId: "item-prompt",
      isBlocking: true,
      questions: [{
        id: "choice",
        header: "Choose",
        question: "Use explicit-provider-secret?",
        options: [{ label: "Yes", description: "explicit-provider-secret" }],
      }],
    });
    await delay(0);
    assert.equal(handledPromptParams.questions[0].question, "Use explicit-provider-secret?");
    const publishedPrompt = events.find((event) => event.requestId === "prompt-1");
    assert.equal(publishedPrompt.type, "prompt");
    assert.equal(publishedPrompt.questions[0].id, "choice");
    assert.equal(JSON.stringify(publishedPrompt).includes("explicit-provider-secret"), false);
  } finally {
    await fixture.host.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(fixture.kills.map((entry) => entry.signal), ["SIGTERM"]);
}

async function testAccountAuthHostApiUsesOnlyGeneratedMethods() {
  const fixture = hostFixture();
  const forbiddenApiKey = `sk-proj-${"A".repeat(32)}`;
  try {
    await fixture.host.initialize();
    assert.deepEqual(await fixture.host.accountRead({ refreshToken: false }), {
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    assert.deepEqual(await fixture.host.accountLoginStart({ type: "chatgpt" }), {
      type: "chatgpt",
      loginId: "login-browser",
      authUrl: "https://auth.example.test/browser",
    });
    assert.deepEqual(await fixture.host.accountLoginStart({ type: "chatgptDeviceCode" }), {
      type: "chatgptDeviceCode",
      loginId: "login-device",
      verificationUrl: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    });
    assert.deepEqual(await fixture.host.accountLoginCancel({ loginId: "login-browser" }), {
      status: "canceled",
    });
    assert.deepEqual(await fixture.host.accountLogout(), {});
    assert.deepEqual(await fixture.host.accountLoginApiKey(forbiddenApiKey), { type: "apiKey" });
    assert.equal(fixture.host.registeredSecrets.includes(forbiddenApiKey), true);
    assert.equal(fixture.host.rpc.registeredSecrets.includes(forbiddenApiKey), true);
    await assert.rejects(
      fixture.host.accountLoginStart({ type: "apiKey", apiKey: forbiddenApiKey }),
      (error) => error.code === "CODEX_ACCOUNT_LOGIN_TYPE_UNSUPPORTED"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(forbiddenApiKey),
    );
    assert.deepEqual(fixture.children[0].requests.slice(-6).map((request) => request.method), [
      "account/read",
      "account/login/start",
      "account/login/start",
      "account/login/cancel",
      "account/logout",
      "account/login/start",
    ]);
    assert.equal(fixture.children[0].requests.at(-1).params.apiKey, forbiddenApiKey);
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  const bedrock = hostFixture({
    childOptions: {
      accountResponse: {
        account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
        requiresOpenaiAuth: false,
      },
    },
  });
  try {
    await bedrock.host.initialize();
    assert.deepEqual(await bedrock.host.accountRead({ refreshToken: false }), {
      account: { type: "amazonBedrock", usesCodexManagedCredentials: true },
      requiresOpenaiAuth: false,
    });
  } finally {
    await bedrock.host.stop().catch(() => {});
    fs.rmSync(bedrock.root, { recursive: true, force: true });
  }
}

async function testHostDynamicSecretLimitFailsBeforeAccountRpcWrite() {
  const initial = Array.from(
    { length: DEFAULT_MAX_REGISTERED_SECRETS },
    (_, index) => `host-bounded-secret-${String(index).padStart(4, "0")}`,
  );
  const fixture = hostFixture({ registeredSecrets: initial });
  const overflow = "host-api-key-overflow-canary-000001";
  try {
    await fixture.host.initialize();
    const before = fixture.children[0].requests.length;
    await assert.rejects(
      fixture.host.accountLoginApiKey(overflow),
      (error) => error.code === "RPC_REGISTERED_SECRET_LIMIT"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(overflow),
    );
    assert.equal(fixture.children[0].requests.length, before);
    assert.equal(fixture.host.registeredSecrets.includes(overflow), false);
    assert.equal(fixture.host.rpc.registeredSecrets.includes(overflow), false);
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testAccountAuthUsesOpaqueLoginIdInternallyAndSanitizesPublicDisplay() {
  const registeredSecret = "registered-login-secret";
  const fixture = hostFixture({ registeredSecrets: [registeredSecret] });
  const internal = [];
  const published = [];
  try {
    fixture.host.subscribeAccountAuth((event) => internal.push(event));
    fixture.host.subscribe((event) => published.push(event));
    await fixture.host.initialize();
    const loginIds = [
      "a".repeat(100),
      "b".repeat(128),
      `${"c".repeat(100)}${registeredSecret}${"d".repeat(133)}`,
    ];
    assert.deepEqual(loginIds.map((value) => Buffer.byteLength(value)), [100, 128, 256]);
    for (const loginId of loginIds) {
      fixture.children[0].sendNotification("account/login/completed", {
        loginId,
        success: true,
        error: null,
        onboardingEntrypoint: null,
      });
    }
    fixture.children[0].sendNotification("account/login/completed", {
      success: false,
      error: "missing login id",
      onboardingEntrypoint: null,
    });
    fixture.children[0].sendNotification("account/login/completed", {
      loginId: null,
      success: false,
      error: "null login id",
      onboardingEntrypoint: null,
    });
    await delay(0);
    assert.deepEqual(internal.map((event) => event.loginId), loginIds);
    assert.equal(internal.every((event) => event.status === "succeeded"), true);
    assert.equal(published.every((event) => !Object.hasOwn(event, "loginId")), true);
    assert.equal(published.every((event) => !Object.hasOwn(event, "requestId")), true);
    assert.equal(published.filter((event) => event.loginIdDisplay !== undefined)
      .every((event) => Buffer.byteLength(event.loginIdDisplay) <= 96), true);
    assert.equal(published.slice(-2).every((event) => event.loginIdDisplay === undefined), true);
    assert.equal(JSON.stringify(published).includes(registeredSecret), false);
    assert.deepEqual(await fixture.host.accountRead({ refreshToken: false }), {
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testStopKillsOnlyAnExistingOriginalProcessGroup() {
  const absent = hostFixture({ processGroupExists: () => false });
  try {
    await absent.host.initialize();
    await absent.host.stop();
    assert.deepEqual(absent.kills.map((entry) => entry.signal), ["SIGTERM"]);
  } finally {
    fs.rmSync(absent.root, { recursive: true, force: true });
  }

  let descendantProbes = 0;
  const descendant = hostFixture({
    processGroupExists: () => {
      descendantProbes += 1;
      return descendantProbes < 3;
    },
  });
  try {
    await descendant.host.initialize();
    await descendant.host.stop();
    assert.deepEqual(descendant.kills.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
    assert.equal(descendantProbes >= 3, true, "SIGKILL 后必须独立复查 PGID 直至消失");
  } finally {
    fs.rmSync(descendant.root, { recursive: true, force: true });
  }

  const immortalGroup = hostFixture({ processGroupExists: () => true, killGraceMs: 10 });
  try {
    await immortalGroup.host.initialize();
    await assert.rejects(
      immortalGroup.host.stop(),
      (error) => error.code === "CODEX_RUNTIME_STOP_FAILED",
    );
    assert.equal(immortalGroup.host.cleanupIncomplete, true);
  } finally {
    fs.rmSync(immortalGroup.root, { recursive: true, force: true });
  }
}

async function testProcessGroupProbeFailureFailsClosedAndLeavesTombstone() {
  const fixture = servicePathsFixture();
  const child = new FakeAppServer();
  const kills = [];
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: (options) => new CodexRuntimeHost({
      ...options,
      repoRoot: REPO_ROOT,
      packageVersion: "0.8.41",
      schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
      probeBinary: async () => {},
      spawnProcess: () => child,
      killProcessGroup: (_pid, signal) => {
        kills.push(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child.close(0, signal));
      },
      processGroupExists: () => { throw new Error("process group probe failed"); },
      shutdownGraceMs: 10,
      killGraceMs: 10,
    }),
  });
  try {
    const host = await pool.get("probe-failure");
    await assert.rejects(pool.stop("probe-failure"), (error) => error?.code === "CODEX_RUNTIME_STOP_FAILED");
    assert.equal(host.cleanupIncomplete, true);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"], "unknown group state must fail closed");
    await assert.rejects(pool.get("probe-failure"), (error) => error?.code === "CODEX_RUNTIME_CLEANUP_INCOMPLETE");
  } finally {
    await pool.stopAll().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testStopCancelsPendingStartupBeforeSpawnAndGatesPoolReplacement() {
  const fixture = servicePathsFixture();
  let releaseProbe;
  let notifyProbeStarted;
  const probeStarted = new Promise((resolve) => { notifyProbeStarted = resolve; });
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let factoryCalls = 0;
  let spawnCalls = 0;
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: (options) => {
      factoryCalls += 1;
      if (factoryCalls > 1) {
        return { async initialize() {}, async stop() {} };
      }
      return new CodexRuntimeHost({
        ...options,
        repoRoot: REPO_ROOT,
        packageVersion: "0.8.41",
        schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
        probeBinary: async () => {
          notifyProbeStarted();
          await probeGate;
        },
        spawnProcess: () => {
          spawnCalls += 1;
          return new FakeAppServer();
        },
      });
    },
  });
  try {
    const starting = pool.get("startup-stop-race");
    const startingRejected = assert.rejects(starting, (error) => error?.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
    await probeStarted;
    const stopping = pool.stop("startup-stop-race");
    await delay(0);
    await assert.rejects(pool.get("startup-stop-race"), (error) => error?.code === "CODEX_POOL_STOPPING");
    assert.equal(spawnCalls, 0);
    releaseProbe();
    await stopping;
    await startingRejected;
    assert.equal(spawnCalls, 0, "a stopped startup generation must never spawn app-server");
    const replacement = await pool.get("startup-stop-race");
    assert.ok(replacement);
    assert.equal(factoryCalls, 2, "replacement is allowed only after startup stop settles");
  } finally {
    releaseProbe?.();
    await pool.stopAll().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testUnconfirmedStartupProbeCleanupLeavesPoolTombstone() {
  const fixture = servicePathsFixture();
  let factoryCalls = 0;
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: (options) => {
      factoryCalls += 1;
      return new CodexRuntimeHost({
        ...options,
        repoRoot: REPO_ROOT,
        packageVersion: "0.8.41",
        schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
        probeBinary: async () => {
          const error = new Error("probe cleanup unconfirmed");
          error.code = "CODEX_RUNTIME_VERSION_PROBE_FAILED";
          error.cleanupIncomplete = true;
          throw error;
        },
      });
    },
  });
  try {
    await assert.rejects(pool.get("probe-cleanup-tombstone"), (error) => error?.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
    await assert.rejects(
      pool.get("probe-cleanup-tombstone"),
      (error) => error?.code === "CODEX_RUNTIME_CLEANUP_INCOMPLETE",
    );
    assert.equal(factoryCalls, 1);
  } finally {
    await pool.stopAll().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testInvalidCriticalSchemaTerminatesHost() {
  const fixture = hostFixture();
  try {
    await fixture.host.initialize();
    fixture.children[0].sendNotification("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: 7,
    });
    await assert.rejects(fixture.host.terminated, (error) => error?.code === "CODEX_SCHEMA_ERROR");
    assert.ok(fixture.kills.some((entry) => entry.signal === "SIGTERM"));
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testFatalTerminationSettlesAfterProcessCleanup() {
  const fixture = servicePathsFixture();
  const child = new FakeAppServer();
  let closed = false;
  const host = new CodexRuntimeHost({
    ...codexHostRuntimeOptions({
      paths: fixture.paths,
      runtimeProfileId: "profile-fatal-order",
    }),
    paths: fixture.paths,
    repoRoot: REPO_ROOT,
    packageVersion: "0.8.41",
    schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    spawnProcess: () => child,
    killProcessGroup: (_pid, signal) => {
      if (signal === "SIGTERM") setTimeout(() => { closed = true; child.close(1, signal); }, 15);
    },
    shutdownGraceMs: 100,
  });
  try {
    await host.initialize();
    child.sendNotification("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: 9,
    });
    await assert.rejects(host.terminated, (error) => error.code === "CODEX_SCHEMA_ERROR" && closed);
  } finally {
    await host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testInvalidServerReplyTerminatesHost() {
  const fixture = hostFixture();
  try {
    await fixture.host.initialize();
    fixture.host.registerServerRequestHandler("item/commandExecution/requestApproval", async () => ({ decision: "invalid" }));
    fixture.children[0].sendServerRequest("approval-invalid", "item/commandExecution/requestApproval", {
      threadId: "thread-started", turnId: "turn-started", itemId: "item-approval",
      startedAtMs: 1, environmentId: null, command: "printf ok",
    });
    await assert.rejects(fixture.host.terminated, (error) => error.code === "CODEX_SCHEMA_ERROR");
  } finally {
    await fixture.host.stop().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testRuntimePathAndProfileSymlinkFailBeforeSpawn() {
  const invalidFixture = servicePathsFixture();
  try {
    const valid = codexHostRuntimeOptions({
      paths: invalidFixture.paths,
      runtimeProfileId: "valid-profile",
    });
    assert.throws(
      () => new CodexRuntimeHost({
        ...valid,
        runtimeBinding: {
          runtime: "codex",
          runtimeProfileId: "../escape",
          runtimeAccountId: TEST_RUNTIME_ACCOUNT_ID,
        },
        paths: invalidFixture.paths,
      }),
      (error) => error?.code === "RUNTIME_BINDING_INVALID",
    );
  } finally {
    fs.rmSync(invalidFixture.root, { recursive: true, force: true });
  }

  const symlinkFixture = servicePathsFixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "codex-symlink-victim-"));
  fs.mkdirSync(symlinkFixture.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(external, path.join(symlinkFixture.paths.stateDir, "codex"));
  try {
    assert.throws(
      () => codexHostRuntimeOptions({
        paths: symlinkFixture.paths,
        runtimeProfileId: "profile-symlink",
      }),
      (error) => error?.code === "UNSAFE_SYMLINK",
    );
    assert.deepEqual(fs.readdirSync(external), []);
  } finally {
    fs.rmSync(symlinkFixture.root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
}

async function testShutdownTimeoutFailsClosed() {
  const fixture = servicePathsFixture();
  const child = new FakeAppServer();
  const host = new CodexRuntimeHost({
    ...codexHostRuntimeOptions({
      paths: fixture.paths,
      runtimeProfileId: "profile-timeout",
    }),
    paths: fixture.paths,
    repoRoot: REPO_ROOT,
    packageVersion: "0.8.41",
    schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    spawnProcess: () => child,
    killProcessGroup: () => {},
    shutdownGraceMs: 10,
    killGraceMs: 10,
    requestTimeoutMs: 100,
  });
  try {
    await host.initialize();
    await assert.rejects(host.stop(), (error) => error?.code === "CODEX_RUNTIME_STOP_FAILED"
      && error.errors.some((entry) => entry.code === "CODEX_PROCESS_CLOSE_TIMEOUT"));
  } finally {
    child.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testRealProcessGroupDescendantCleanup() {
  if (process.platform === "win32") return;
  const runtimeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-group-")));
  const serviceFixture = servicePathsFixture();
  const pidPath = path.join(runtimeRoot, "descendant.pid");
  writeRuntimeFixture(runtimeRoot);
  const host = new CodexRuntimeHost({
    ...codexHostRuntimeOptions({
      paths: serviceFixture.paths,
      runtimeProfileId: "profile-tree",
      repoRoot: runtimeRoot,
    }),
    paths: serviceFixture.paths,
    repoRoot: runtimeRoot,
    packageVersion: "0.8.41",
    schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
    spawnEnv: { CODEX_FAKE_BEHAVIOR: "fork-descendant", CODEX_FAKE_PID_PATH: pidPath },
    requestTimeoutMs: 3_000,
    initializeTimeoutMs: 3_000,
    shutdownGraceMs: 100,
    killGraceMs: 100,
  });
  let descendantPid;
  try {
    await host.initialize();
    await waitFor(() => fs.existsSync(pidPath), 1_000, "descendant pid file");
    descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.equal(processAlive(descendantPid), true);
    await host.stop();
    await waitFor(() => !processAlive(descendantPid), 2_000, "descendant cleanup");
  } finally {
    await host.stop().catch(() => {});
    if (descendantPid && processAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(serviceFixture.root, { recursive: true, force: true });
  }
}

async function testPoolSingleFlightIsolationAndCircuitBreaker() {
  const fixture = servicePathsFixture();
  const starts = [];
  const stops = [];
  let release;
  const startGate = new Promise((resolve) => { release = resolve; });
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: (options) => ({
      runtimeProfileId: options.runtimeProfileId,
      async initialize() { starts.push(options.runtimeProfileId); await startGate; return { ok: true }; },
      async stop() { stops.push(options.runtimeProfileId); },
    }),
  });
  const first = pool.get("profile-a");
  const second = pool.get("profile-a");
  const isolated = pool.get("profile-b");
  await delay(0);
  assert.deepEqual(starts.sort(), ["profile-a", "profile-b"]);
  release();
  assert.equal(await first, await second);
  assert.notEqual(await first, await isolated);
  await pool.stop("profile-a");
  await pool.stopAll();
  assert.deepEqual(stops.sort(), ["profile-a", "profile-b"]);

  let now = 1_000;
  let attempts = 0;
  const circuit = new CodexRuntimePool({
    paths: fixture.paths,
    now: () => now,
    failureThreshold: 3,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    hostFactory: () => ({
      async initialize() {
        attempts += 1;
        const error = new Error("startup failed with secret detail");
        error.code = "RPC_PROCESS_EXITED";
        throw error;
      },
      async stop() {},
    }),
  });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(circuit.get("broken"), (error) => error?.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  }
  await assert.rejects(circuit.get("broken"), (error) => error?.code === "CODEX_CIRCUIT_OPEN");
  assert.equal(attempts, 3);
  now += 30_001;
  await assert.rejects(circuit.get("broken"), (error) => error?.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  assert.equal(attempts, 4);

  let resetAttempts = 0;
  const resetting = new CodexRuntimePool({
    paths: fixture.paths,
    now: () => now,
    failureThreshold: 3,
    hostFactory: () => ({
      async initialize() {
        resetAttempts += 1;
        if (resetAttempts === 1 || resetAttempts === 2 || resetAttempts === 4) throw new Error("fail");
      },
      async stop() {},
    }),
  });
  await assert.rejects(resetting.get("reset"), (error) => error.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  await assert.rejects(resetting.get("reset"), (error) => error.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  const resetHost = await resetting.get("reset");
  await resetting.stop("reset");
  assert.ok(resetHost);
  await assert.rejects(resetting.get("reset"), (error) => error.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  assert.equal(resetAttempts, 4, "successful initialize resets consecutive failures");
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function testPoolEvictsTerminatedHost() {
  const fixture = servicePathsFixture();
  const hosts = [];
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: () => {
      let rejectTerminated;
      const host = {
        terminated: new Promise((_, reject) => { rejectTerminated = reject; }),
        rejectTerminated,
        async initialize() {},
        async stop() {},
      };
      host.crash = () => rejectTerminated(Object.assign(new Error("raw crash detail"), { code: "RPC_PROCESS_EXITED" }));
      host.terminated.catch(() => {});
      hosts.push(host);
      return host;
    },
  });
  const first = await pool.get("crashing");
  first.crash();
  await delay(0);
  const second = await pool.get("crashing");
  assert.notEqual(first, second);
  assert.equal(hosts.length, 2);
  await pool.stopAll();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function testPoolStopInterruptsInitializeAndGatesReplacement() {
  const fixture = servicePathsFixture();
  let rejectInitialize;
  let stopStarted;
  const stopGate = new Promise((resolve) => { stopStarted = resolve; });
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: () => ({
      initialize() { return new Promise((_, reject) => { rejectInitialize = reject; }); },
      async stop() {
        stopStarted();
        rejectInitialize(Object.assign(new Error("stopped"), { code: "RPC_TERMINATED" }));
      },
    }),
  });
  const starting = pool.get("stopping");
  await delay(0);
  const stopping = pool.stop("stopping");
  await Promise.race([stopGate, delay(50).then(() => assert.fail("host.stop was not called while initialize was pending"))]);
  await assert.rejects(pool.get("stopping"), (error) => error.code === "CODEX_POOL_STOPPING");
  await stopping;
  await assert.rejects(starting, (error) => error.code === "RUNTIME_START_PROCESS_SPAWN_FAILED");
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function testPoolStopAllIsSingleFlightAndReusable() {
  const fixture = servicePathsFixture();
  let factoryCalls = 0;
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: () => {
      factoryCalls += 1;
      return { async initialize() {}, async stop() { await stopGate; } };
    },
  });
  await pool.get("singleflight");
  const first = pool.stopAll();
  const second = pool.stopAll();
  assert.equal(first, second, "concurrent stopAll calls must share one promise");
  let secondSettled = false;
  second.finally(() => { secondSettled = true; });
  await delay(0);
  assert.equal(secondSettled, false);
  releaseStop();
  await first;
  await pool.get("singleflight");
  assert.equal(factoryCalls, 2, "completed stopAll must release the gate for Service reuse");
  await pool.stopAll();
  fs.rmSync(fixture.root, { recursive: true, force: true });

  const failureFixture = servicePathsFixture();
  const stopFailure = Object.assign(new Error("fixed stop failure"), { code: "STOP_FAILURE" });
  const failing = new CodexRuntimePool({
    paths: failureFixture.paths,
    hostFactory: () => ({ async initialize() {}, async stop() { throw stopFailure; } }),
  });
  await failing.get("singleflight-error");
  const failedFirst = failing.stopAll();
  const failedSecond = failing.stopAll();
  assert.equal(failedFirst, failedSecond);
  const results = await Promise.allSettled([failedFirst, failedSecond]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, results[1].reason, "singleflight callers must observe the same aggregate error");
  fs.rmSync(failureFixture.root, { recursive: true, force: true });
}

async function testFatalCleanupTimeoutLeavesPoolTombstone() {
  const fixture = servicePathsFixture();
  const child = new FakeAppServer();
  let factoryCalls = 0;
  const pool = new CodexRuntimePool({
    paths: fixture.paths,
    hostFactory: (options) => {
      factoryCalls += 1;
      return new CodexRuntimeHost({
        ...options,
        repoRoot: REPO_ROOT,
        packageVersion: "0.8.41",
        schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
        spawnProcess: () => child,
        killProcessGroup: () => {},
        shutdownGraceMs: 5,
        killGraceMs: 5,
      });
    },
  });
  try {
    const host = await pool.get("fatal-cleanup");
    child.sendNotification("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: 7,
    });
    await assert.rejects(host.terminated, (error) => error.code === "CODEX_RUNTIME_FATAL_CLEANUP_FAILED"
      && error.cleanupIncomplete === true);
    await delay(0);
    await assert.rejects(pool.get("fatal-cleanup"), (error) => error.code === "CODEX_RUNTIME_CLEANUP_INCOMPLETE");
    assert.equal(factoryCalls, 1, "cleanup timeout must not create a replacement host");
  } finally {
    child.close();
    await pool.stopAll().catch(() => {});
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function testManualCleanupTimeoutLeavesPoolTombstone() {
  for (const stopMode of ["stop", "stopAll"]) {
    const fixture = servicePathsFixture();
    const children = [];
    let factoryCalls = 0;
    const pool = new CodexRuntimePool({
      paths: fixture.paths,
      hostFactory: (options) => {
        factoryCalls += 1;
        const child = new FakeAppServer();
        children.push(child);
        return new CodexRuntimeHost({
          ...options,
          repoRoot: REPO_ROOT,
          packageVersion: "0.8.41",
          schemaContract: new CodexSchemaContract({ repoRoot: REPO_ROOT }),
          spawnProcess: () => child,
          killProcessGroup: () => {},
          shutdownGraceMs: 5,
          killGraceMs: 5,
        });
      },
    });
    try {
      const host = await pool.get(`manual-${stopMode}`);
      const stopping = stopMode === "stop" ? pool.stop(`manual-${stopMode}`) : pool.stopAll();
      await assert.rejects(stopping);
      assert.equal(host.cleanupIncomplete, true);
      await assert.rejects(
        pool.get(`manual-${stopMode}`),
        (error) => error.code === "CODEX_RUNTIME_CLEANUP_INCOMPLETE",
      );
      assert.equal(factoryCalls, 1, `${stopMode} cleanup timeout must leave a tombstone`);
    } finally {
      for (const child of children) child.close();
      await pool.stopAll().catch(() => {});
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function testPoolPassesHomeAuthorityToHost() {
  const parentEnv = Object.freeze({ HOME: "/runtime-user", PATH: "/usr/bin:/bin" });
  const homedir = "/runtime-user";
  let received = null;
  const pool = new CodexRuntimePool({
    parentEnv,
    homedir,
    runtimeAccountLookup: () => ({}),
    runtimeAccountResolver: {
      resolve(binding) {
        return Object.freeze({
          runtime: "codex",
          runtimeAccountId: binding.runtimeAccountId,
          home: "/runtime-user/.codex",
          binaryPath: "/usr/bin/codex",
          launchArgs: Object.freeze([]),
          spawnEnv: Object.freeze({
            HOME: homedir,
            CODEX_HOME: "/runtime-user/.codex",
          }),
          configurationMode: "overlay",
        });
      },
    },
    hostFactory: (options) => {
      received = options;
      return {
        async initialize() {},
        async stop() {},
      };
    },
  });
  try {
    await pool.get("home-authority");
    assert.strictEqual(received.parentEnv, parentEnv);
    assert.equal(received.homedir, homedir);
  } finally {
    await pool.stopAll();
  }
}

async function testNativeNpmCliStartsWithLaunchAgentPath() {
  const fixture = servicePathsFixture();
  const nativeHome = path.join(fixture.root, ".codex");
  const installBin = path.join(fixture.root, ".local", "bin");
  fs.mkdirSync(nativeHome, { mode: 0o700 });
  fs.mkdirSync(installBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(installBin, "node"));
  const binaryPath = path.join(installBin, "codex");
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "fixtures", "codex-app-server-fake.cjs"), binaryPath);
  fs.chmodSync(binaryPath, 0o755);
  const parentEnv = { HOME: fixture.root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const runtimeBinding = {
    runtime: "codex", runtimeProfileId: "native-npm-cli", runtimeAccountId: "native-codex-default-v1",
  };
  const runtimeEnvironment = new RuntimeAccountResolver({
    paths: fixture.paths, homedir: fixture.root, parentEnv, repoRoot: REPO_ROOT,
  }).resolve(runtimeBinding, defaultRuntimeAccountLookup(runtimeBinding.runtimeAccountId));
  const host = new CodexRuntimeHost({
    paths: fixture.paths, repoRoot: REPO_ROOT, runtimeBinding, runtimeEnvironment, parentEnv,
  });
  try {
    await host.initialize();
    assert.equal(host.runtimeVersion, CODEX_VERSION);
    const account = await host.accountRead({ refreshToken: false });
    assert.equal(account.account.type, "chatgpt");
    assert.equal(parentEnv.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(buildCodexSpawnEnv({ codexHome: nativeHome, parentEnv }).PATH, parentEnv.PATH);
  } finally {
    await host.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function runRealBinarySmoke() {
  const fixture = servicePathsFixture();
  const contract = new CodexSchemaContract({ repoRoot: REPO_ROOT });
  const layout = resolveCodexRuntimeLayout({ repoRoot: REPO_ROOT });
  const cleanEnv = {
    HOME: fixture.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    CODEX_HOME: path.join(fixture.root, "version-home"),
  };
  fs.mkdirSync(cleanEnv.CODEX_HOME, { recursive: true, mode: 0o700 });
  const version = spawnSync(layout.runtimePath, ["--version"], {
    cwd: REPO_ROOT,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  assert.equal(version.status, 0, "real Codex --version failed");
  assert.match(version.stdout, /0\.149\.0/);
  const host = new CodexRuntimeHost({
    ...codexHostRuntimeOptions({
      paths: fixture.paths,
      runtimeProfileId: "real-offline-smoke",
    }),
    paths: fixture.paths,
    repoRoot: REPO_ROOT,
    packageVersion: "0.8.41",
    schemaContract: contract,
    parentEnv: cleanEnv,
    requestTimeoutMs: 30_000,
    initializeTimeoutMs: 30_000,
    shutdownGraceMs: 1_000,
    killGraceMs: 1_000,
  });
  try {
    const initialized = await host.initialize();
    const started = await host.threadStart({
      cwd: REPO_ROOT,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
    return {
      version: version.stdout.trim(),
      userAgent: initialized.userAgent,
      threadStarted: typeof started.thread?.id === "string",
      modelTurnExecuted: false,
      authenticated: false,
    };
  } finally {
    await host.stop();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !["--real-binary", "--authenticated-turn"].includes(arg));
  if (unknown.length > 0) throw new Error("unknown codex smoke argument");
  const tests = [
    testGeneratedMethodMappingAndContracts,
    testNotificationAndServerRequestGates,
    testDraft07SubsetAndLocalRefs,
    testSchemaTamperFailsClosed,
    testSchemaBundlesParseTheSameVerifiedRead,
    testGeneratedNumericFormatsAreEnforced,
    testCoreThreadResponseRejectsUnsafeInt64Timestamps,
    testPackagedRuntimeUsesResourcesLayout,
    testRuntimeManifestPathsStayInsideTrustedRoot,
    testBinaryVersionProbeIsStrictBoundedAndSanitized,
    testBinaryVersionProbeAsyncSpawnFailuresAreContained,
    testRealVersionProbeKillsTermIgnoringProcessGroup,
    testRuntimeHostCoreApiEnvironmentAndEvents,
    testAccountAuthHostApiUsesOnlyGeneratedMethods,
    testHostDynamicSecretLimitFailsBeforeAccountRpcWrite,
    testAccountAuthUsesOpaqueLoginIdInternallyAndSanitizesPublicDisplay,
    testPackagedHostUsesPhysicalCodexHomeAsProcessCwd,
    testVersionProbeRunsBeforePrepareAndNeverReceivesProviderEnvironment,
    testBedrockPreparedAwsEnvIsAppServerOnlyAndRedacted,
    testHostOwnsFrozenSecretContainersAndIdleStopSettles,
    testStopKillsOnlyAnExistingOriginalProcessGroup,
    testProcessGroupProbeFailureFailsClosedAndLeavesTombstone,
    testStopCancelsPendingStartupBeforeSpawnAndGatesPoolReplacement,
    testUnconfirmedStartupProbeCleanupLeavesPoolTombstone,
    testInvalidCriticalSchemaTerminatesHost,
    testFatalTerminationSettlesAfterProcessCleanup,
    testInvalidServerReplyTerminatesHost,
    testRuntimePathAndProfileSymlinkFailBeforeSpawn,
    testShutdownTimeoutFailsClosed,
    testRealProcessGroupDescendantCleanup,
    testPoolSingleFlightIsolationAndCircuitBreaker,
    testPoolEvictsTerminatedHost,
    testPoolStopInterruptsInitializeAndGatesReplacement,
    testPoolStopAllIsSingleFlightAndReusable,
    testFatalCleanupTimeoutLeavesPoolTombstone,
    testManualCleanupTimeoutLeavesPoolTombstone,
    testPoolPassesHomeAuthorityToHost,
    testNativeNpmCliStartsWithLaunchAgentPath,
  ];
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`codex app-server smoke (offline): ${tests.length}/${tests.length}\n`);
  if (args.includes("--real-binary")) {
    process.stdout.write(`${JSON.stringify(await runRealBinarySmoke())}\n`);
  }
  if (args.includes("--authenticated-turn")) {
    const authenticated = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "codex-m0-spike-regression.mjs"), "--authenticated-smoke"],
      { cwd: REPO_ROOT, stdio: "inherit", timeout: 360_000 },
    );
    assert.equal(authenticated.status, 0, "explicit authenticated turn smoke failed");
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
