#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { prepareCodexHome, resolveCodexRuntimeLayout } = require(path.join(
  ROOT, "app", "agent-service", "codex-runtime-paths.js",
));
const { EncryptedSecretStore } = require(path.join(
  ROOT, "app", "agent-service", "encrypted-secret-store.js",
));
const { JsonlProductStore } = require(path.join(ROOT, "app", "agent-service", "product-store.js"));
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require(path.join(ROOT, "app", "agent-service", "runtime-account.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));

let CodexRuntimeConfigWriter;
let ProviderRuntimeBridge;
let configOverridesFor;
let providerCredentialEnvName;
let providerConfigAlias;
let moduleLoadError = null;
try {
  ({ CodexRuntimeConfigWriter, configOverridesFor } = require(path.join(
    ROOT, "app", "agent-service", "codex-runtime-config.js",
  )));
  ({ ProviderRuntimeBridge, providerCredentialEnvName } = require(path.join(
    ROOT, "app", "agent-service", "provider-runtime-bridge.js",
  )));
  ({ providerConfigAlias } = require(path.join(
    ROOT, "app", "agent-service", "codex-runtime-config.js",
  )));
} catch (error) {
  moduleLoadError = error;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("Provider runtime/config 模块可用", () => {
  assert.ifError(moduleLoadError);
  assert.equal(typeof CodexRuntimeConfigWriter, "function");
  assert.equal(typeof ProviderRuntimeBridge, "function");
  assert.equal(typeof configOverridesFor, "function");
  assert.equal(typeof providerCredentialEnvName, "function");
  assert.equal(typeof providerConfigAlias, "function");
});

function fixturePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-provider-runtime-"));
  return {
    root,
    paths: resolveServicePaths({
      stateRoot: path.join(root, "state"),
      cacheRoot: path.join(root, "cache"),
    }),
  };
}

function xorCipher(value) {
  const bytes = Buffer.from(value, "utf8");
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0x5a;
  return bytes;
}

function safeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => xorCipher(value),
    decryptString: (bytes) => xorCipher(Buffer.from(bytes)).toString("utf8"),
  };
}

function provider(id = "provider-openrouter", overrides = {}) {
  return {
    id,
    kind: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5",
    credentialRef: `credential-${id}`,
    headers: { "HTTP-Referer": "https://product.test/shoggoth", "X-OpenRouter-Title": "Shoggoth" },
    awsRegion: null,
    awsProfile: null,
    validationStatus: "unverified",
    ...overrides,
  };
}

function runtimeAccountIdFor() {
  return SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID;
}

function profile(id, providerRef = null) {
  return {
    id,
    backendId: "shoggoth",
    agentId: id,
    name: `Fixture ${id}`,
    runtime: "codex",
    runtimeProfileId: id,
    runtimeAccountId: runtimeAccountIdFor(id),
    providerRef,
    defaultModel: null,
    defaultCwd: null,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: 1 },
    isDefault: false,
    enabled: true,
  };
}

function putProfile(productStore, id, providerRef = null) {
  return productStore.putAgentProfile(profile(id, providerRef));
}

function openResources(options = {}) {
  const fixture = fixturePaths();
  const productStore = new JsonlProductStore({ paths: fixture.paths });
  productStore.open();
  const secretStore = new EncryptedSecretStore({
    paths: fixture.paths,
    safeStorage: options.safeStorage || safeStorage(),
  });
  secretStore.open();
  const configWriter = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const bridge = new ProviderRuntimeBridge({
    productStore,
    secretStore,
    configWriter,
    parentEnv: options.parentEnv,
  });
  return { ...fixture, productStore, secretStore, configWriter, bridge };
}

async function closeResources(resources) {
  await resources.secretStore.close();
  resources.productStore.close();
}

test("config writer 原子生成真实 custom provider TOML，使用内部 alias/env 且不含 secret", () => {
  const fixture = fixturePaths();
  const helperCommand = "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth";
  const writer = new CodexRuntimeConfigWriter({
    paths: fixture.paths,
    mcpHelperLaunch: { command: helperCommand, argsPrefix: [] },
  });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-config");
  const runtimeConfig = {
    provider: {
      id: "provider-openrouter",
      kind: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5",
      headers: { "HTTP-Referer": "https://product.test/shoggoth", "X-OpenRouter-Title": "Shoggoth" },
      awsRegion: null,
      awsProfile: null,
      credentialEnv: "SHOGGOTH_PROVIDER_1234567890ABCDEF_API_KEY",
    },
  };
  const result = writer.write({
    runtimeProfileId: "runtime-config",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig,
  });
  assert.equal(result.configPath, path.join(codexHome, "config.toml"));
  const config = fs.readFileSync(result.configPath, "utf8");
  const alias = providerConfigAlias(runtimeConfig.provider);
  assert.match(config, /^# Managed by Shoggoth/m);
  assert.match(config, /^check_for_update_on_startup = false$/m);
  assert.match(config, /^\[shell_environment_policy\]$/m);
  assert.match(config, /^inherit = "core"$/m);
  assert.match(config, /^ignore_default_excludes = false$/m);
  assert.match(config, /^\[features\]$/m);
  assert.match(config, /^memories = false$/m);
  assert.match(config, /^\[memories\]$/m);
  assert.match(config, /^generate_memories = false$/m);
  assert.match(config, /^use_memories = false$/m);
  assert.match(config, /^disable_on_external_context = false$/m);
  for (const pattern of [
    "SHOGGOTH_*_API_KEY", "*_API_KEY", "*_KEY", "*_SECRET", "*_TOKEN",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  ]) assert.equal(config.includes(`"${pattern}"`), true, pattern);
  assert.equal(config.includes(`model = "openai/gpt-5"`), true);
  assert.equal(config.includes(`model_provider = "${alias}"`), true);
  assert.equal(config.includes(`[model_providers.${alias}]`), true);
  assert.equal(config.includes('name = "OpenRouter"'), true);
  assert.equal(config.includes('base_url = "https://openrouter.ai/api/v1"'), true);
  assert.equal(config.includes('wire_api = "responses"'), true);
  assert.equal(config.includes('env_key = "SHOGGOTH_PROVIDER_1234567890ABCDEF_API_KEY"'), true);
  assert.equal(config.includes('http_headers = { "HTTP-Referer" = "https://product.test/shoggoth", "X-OpenRouter-Title" = "Shoggoth" }'), true);
  assert.match(config, /^\[mcp_servers\.shoggoth\]$/m);
  assert.equal(config.includes(`command = ${JSON.stringify(helperCommand)}`), true);
  assert.equal(config.includes([
    'args = ["--shoggoth-internal-role=mcp",',
    '"--shoggoth-runtime-profile=runtime-config",',
    `"--shoggoth-runtime-account=${SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID}"]`,
  ].join(" ")), true);
  assert.equal(config.includes('env = { SHOGGOTH_INTERNAL_LAUNCH = "launch-agent-v1" }'), true);
  assert.match(config, /^startup_timeout_sec = 150$/m);
  assert.match(config, /^tool_timeout_sec = 2147000$/m);
  assert.match(config, /^required = true$/m);
  assert.equal(config.includes("mcp-token"), false);
  assert.equal(config.includes("sessionToken"), false);
  assert.equal(fs.statSync(result.configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(codexHome).mode & 0o777, 0o700);
});

test("Codex 0.149.0 本地解析生成的 update/shell env policy 语法", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "strict-config");
  writer.write({
    runtimeProfileId: "strict-config",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: {
      provider: {
        id: "strict-custom-provider",
        kind: "custom-responses",
        name: 'Strict "Custom" 🚀',
        baseUrl: "https://example.test/响应/🚀",
        model: "fixture/模型-🚀",
        headers: { "X-Safe-Fixture": "值🚀" },
        awsRegion: null,
        awsProfile: null,
        credentialEnv: "SHOGGOTH_PROVIDER_ABCDEF0123456789_API_KEY",
      },
    },
  });
  const layout = resolveCodexRuntimeLayout({ repoRoot: ROOT });
  const result = spawnSync(layout.runtimePath, ["features", "list"], {
    cwd: ROOT,
    env: {
      HOME: fixture.root,
      PATH: process.env.PATH || "/usr/bin:/bin",
      TMPDIR: os.tmpdir(),
      CODEX_HOME: codexHome,
    },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /^memories\s+stable\s+false$/m);
});

test("六种 Provider TOML 使用准确 wire/built-in/AWS 语义并由真实 Codex 0.149.0 离线解析", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const common = {
    name: "Fixture Provider",
    model: "fixture/model",
    headers: null,
    awsRegion: null,
    awsProfile: null,
    credentialEnv: null,
  };
  const cases = [
    {
      id: "runtime-openai", kind: "openai-api-key", baseUrl: null,
      credentialEnv: "OPENAI_API_KEY",
      expected: [
        'base_url = "https://api.openai.com/v1"', 'wire_api = "responses"',
        'env_key = "OPENAI_API_KEY"', "requires_openai_auth = false",
      ],
      forbidden: ['model_provider = "openai"'],
    },
    {
      id: "runtime-openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://product.test/shoggoth", "X-OpenRouter-Title": "Shoggoth",
      },
      credentialEnv: "SHOGGOTH_PROVIDER_0123456789ABCDEF_API_KEY",
      expected: [
        'base_url = "https://openrouter.ai/api/v1"', 'wire_api = "responses"',
        '"HTTP-Referer" = "https://product.test/shoggoth"',
        '"X-OpenRouter-Title" = "Shoggoth"',
      ],
    },
    {
      id: "runtime-ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1",
      expected: ['base_url = "http://127.0.0.1:11434/v1"', 'wire_api = "responses"'],
    },
    {
      id: "runtime-lmstudio", kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1",
      expected: ['base_url = "http://127.0.0.1:1234/v1"', 'wire_api = "responses"'],
    },
    {
      id: "runtime-custom", kind: "custom-responses", baseUrl: "https://gateway.test/openai/v1",
      expected: ['base_url = "https://gateway.test/openai/v1"', 'wire_api = "responses"'],
    },
    {
      id: "runtime-bedrock", kind: "amazon-bedrock", baseUrl: null,
      awsRegion: "us-west-2", awsProfile: "engineering-dev",
      expected: [
        'model_provider = "amazon-bedrock"', '[model_providers.amazon-bedrock.aws]',
        'region = "us-west-2"', 'profile = "engineering-dev"',
      ],
      forbidden: ["base_url =", "wire_api =", "env_key =", "http_headers ="],
    },
  ];
  const layout = resolveCodexRuntimeLayout({ repoRoot: ROOT });
  for (const fixtureCase of cases) {
    const { expected, forbidden = [], ...overrides } = fixtureCase;
    const codexHome = prepareCodexHome(fixture.paths, fixtureCase.id);
    writer.write({
      runtimeProfileId: fixtureCase.id,
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      codexHome,
      runtimeConfig: { provider: { ...common, ...overrides } },
    });
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    for (const fragment of expected) assert.equal(config.includes(fragment), true, `${fixtureCase.kind}: ${fragment}`);
    for (const fragment of forbidden) assert.equal(config.includes(fragment), false, `${fixtureCase.kind}: ${fragment}`);
    const result = spawnSync(layout.runtimePath, ["features", "list"], {
      cwd: ROOT,
      env: {
        HOME: fixture.root,
        PATH: process.env.PATH || "/usr/bin:/bin",
        TMPDIR: os.tmpdir(),
        CODEX_HOME: codexHome,
      },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `${fixtureCase.kind}: ${result.stderr}`);
    assert.equal(result.signal, null);
  }
});

test("ChatGPT overlay 让真实 app-server 忽略共享 Home 中的旧 API key", async () => {
  const fixture = fixturePaths();
  const layout = resolveCodexRuntimeLayout({ repoRoot: ROOT });
  const codexHome = path.join(fixture.root, "legacy-key-home");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const env = {
    HOME: fixture.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    CODEX_HOME: codexHome,
  };
  const appServerMessages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "shoggoth-test", version: "0" }, capabilities: null },
    },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "account/read",
      params: { refreshToken: false },
    },
  ];
  const readAccount = (args) => new Promise((resolve, reject) => {
    const child = spawn(layout.runtimePath, [...args, "app-server", "--stdio"], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Codex account/read timed out: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 1024 * 1024) {
        finish(new Error("Codex account/read output exceeded its bound"));
        return;
      }
      for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify(appServerMessages[1])}\n`);
          child.stdin.write(`${JSON.stringify(appServerMessages[2])}\n`);
        } else if (message.id === 2) finish(null, message.result?.account);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") <= 64 * 1024) stderr += chunk;
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (!settled) finish(new Error(`Codex account/read exited (${code ?? signal}): ${stderr}`));
    });
    child.stdin.write(`${JSON.stringify(appServerMessages[0])}\n`);
  });
  try {
    const login = spawnSync(layout.runtimePath, ["login", "--with-api-key"], {
      cwd: ROOT,
      env,
      input: "sk-shoggoth-test-only-not-a-real-key-000001\n",
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(login.status, 0);
    const legacyAccount = await readAccount([]);
    assert.equal(legacyAccount === "apiKey" || legacyAccount?.type === "apiKey", true);
    const forcedArgs = configOverridesFor(null).flatMap((value) => ["-c", value]);
    assert.equal(forcedArgs.includes('forced_login_method="chatgpt"'), true);
    assert.equal(forcedArgs.includes('model_provider="openai"'), true);
    assert.equal(await readAccount(forcedArgs), null);
    const stored = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    assert.equal(stored.auth_mode, "apikey");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("所有进入 TOML 的 provider 字段拒绝 lone surrogate", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-config-unicode");
  const base = {
    id: "unicode-custom-provider",
    kind: "custom-responses",
    name: "Unicode Provider",
    baseUrl: "https://example.test/responses",
    model: "fixture/model",
    headers: { "X-Safe-Fixture": "value" },
    awsRegion: null,
    awsProfile: null,
    credentialEnv: "SHOGGOTH_PROVIDER_ABCDEF0123456789_API_KEY",
  };
  for (const providerInput of [
    { ...base, name: `bad-name-\uD800` },
    { ...base, model: `bad-model-\uDC00` },
    { ...base, baseUrl: `https://example.test/bad-\uD800` },
    { ...base, headers: { [`X-Bad-\uD800`]: "value" } },
    { ...base, headers: { "X-Safe-Fixture": `bad-value-\uDC00` } },
  ]) {
    assert.throws(
      () => writer.write({
        runtimeProfileId: "runtime-config-unicode",
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        codexHome,
        runtimeConfig: { provider: providerInput },
      }),
      (error) => error.code === "CODEX_RUNTIME_CONFIG_INVALID",
    );
  }
});

test("config writer 在真实 hardlink backup crash 后恢复旧事务再原子覆盖", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-config-crash");
  writer.write({
    runtimeProfileId: "runtime-config-crash",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: null,
  });
  const configPath = path.join(codexHome, "config.toml");
  const beforeIno = fs.statSync(configPath).ino;
  const helper = `
    const fs = require("node:fs");
    const { atomicWritePrivateFile } = require(${JSON.stringify(path.join(ROOT, "app", "agent-service", "private-file.js"))});
    const target = ${JSON.stringify(configPath)};
    const wrapped = Object.create(fs);
    wrapped.linkSync = (source, backup) => { fs.linkSync(source, backup); process.exit(91); };
    atomicWritePrivateFile(target, "# crash candidate\\n", {
      fs: wrapped,
      trustedRoot: ${JSON.stringify(fixture.paths.trustedRoot)},
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", helper], { encoding: "utf8", timeout: 5_000 });
  assert.equal(crashed.status, 91, crashed.stderr);
  assert.equal(fs.statSync(configPath).ino, beforeIno);
  assert.equal(fs.statSync(configPath).nlink, 2);
  assert.equal(fs.existsSync(`${configPath}.tmp`), true);

  writer.write({
    runtimeProfileId: "runtime-config-crash",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: null,
  });
  assert.equal(fs.statSync(configPath).nlink, 1);
  assert.equal(fs.existsSync(`${configPath}.tmp`), false);
  assert.equal(fs.readdirSync(codexHome).some((name) => name.startsWith("config.toml.backup-")), false);
  assert.equal(fs.readFileSync(configPath, "utf8").includes("check_for_update_on_startup = false"), true);
});

test("config writer 清理无 backup 的私有单 link 固定 temp 后继续写入", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-config-temp");
  const tempPath = path.join(codexHome, "config.toml.tmp");
  const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  fs.writeFileSync(fd, "# uncommitted config\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  writer.write({
    runtimeProfileId: "runtime-config-temp",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: null,
  });
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")
    .includes("check_for_update_on_startup = false"), true);
});

test("config writer 拒绝路径错配、敏感/未知 runtime config 与 final/temp link", () => {
  const canary = `sk-proj-${"Z".repeat(32)}`;
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-unsafe");
  for (const runtimeConfig of [
    { provider: null, extra: true },
    { apiKey: canary },
    { provider: { ...provider(), credentialEnv: "USER_CHOSEN_ENV" } },
    {
      provider: {
        id: "account-provider",
        kind: "chatgpt",
        name: "ChatGPT",
        baseUrl: null,
        model: null,
        headers: null,
        awsRegion: null,
        awsProfile: null,
        credentialEnv: "SHOGGOTH_PROVIDER_1234567890ABCDEF_API_KEY",
      },
    },
    {
      provider: {
        id: "local-provider-with-secret",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "fixture/model",
        headers: null,
        awsRegion: null,
        awsProfile: null,
        credentialEnv: "SHOGGOTH_PROVIDER_1234567890ABCDEF_API_KEY",
      },
    },
    {
      provider: {
        id: "openrouter-placeholder-attribution",
        kind: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "fixture/model",
        headers: {
          "HTTP-Referer": "https://example",
          "X-OpenRouter-Title": "Shoggoth",
        },
        awsRegion: null,
        awsProfile: null,
        credentialEnv: "SHOGGOTH_PROVIDER_1234567890ABCDEF_API_KEY",
      },
    },
    {
      provider: {
        id: "custom-endpoint-not-root",
        kind: "custom-responses",
        name: "Custom",
        baseUrl: "https://gateway.test/v1/responses",
        model: "fixture/model",
        headers: null,
        awsRegion: null,
        awsProfile: null,
        credentialEnv: null,
      },
    },
  ]) {
    assert.throws(
      () => writer.write({
        runtimeProfileId: "runtime-unsafe",
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        codexHome,
        runtimeConfig,
      }),
      (error) => ["CODEX_RUNTIME_CONFIG_INVALID", "STORE_SENSITIVE_FIELD", "STORE_SENSITIVE_VALUE"].includes(error.code)
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
    );
  }
  assert.throws(
    () => writer.write({
      runtimeProfileId: "other-runtime",
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      codexHome,
      runtimeConfig: null,
    }),
    (error) => error.code === "CODEX_RUNTIME_CONFIG_PATH_INVALID",
  );
  const victim = path.join(fixture.root, "config-victim");
  fs.writeFileSync(victim, "config-victim-evidence", { mode: 0o600 });
  fs.symlinkSync(victim, path.join(codexHome, "config.toml"));
  assert.throws(
    () => writer.write({
      runtimeProfileId: "runtime-unsafe",
      runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      codexHome,
      runtimeConfig: null,
    }),
    (error) => error.code === "UNSAFE_SYMLINK",
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "config-victim-evidence");
});

test("无 Provider 配置默认返回进程 overlay，且不创建逐 Profile CODEX_HOME", async () => {
  const resources = openResources();
  try {
    putProfile(resources.productStore, "runtime-empty");
    const codexHome = path.join(resources.paths.stateDir, "codex", "runtime-empty");
    const prepared = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-empty",
      runtimeAccountId: runtimeAccountIdFor("runtime-empty"),
      codexHome,
    });
    assert.deepEqual(prepared.spawnEnv, {});
    assert.deepEqual(prepared.registeredSecrets, []);
    assert.equal(prepared.runtimeConfig, null);
    assert.equal(prepared.configArgs.length > 0, true);
    assert.equal(prepared.configArgs.includes("-c"), true);
    assert.equal(fs.existsSync(codexHome), false);
  } finally {
    await closeResources(resources);
  }
});

test("只在对应 runtimeProfile 解密，返回确定性专用 env/registered secret 且不改 process.env", async () => {
  const resources = openResources();
  const canary = "runtime-provider-secret-canary-000001";
  try {
    resources.productStore.putModelProvider(provider());
    putProfile(resources.productStore, "runtime-provider", "provider-openrouter");
    putProfile(resources.productStore, "runtime-other");
    await resources.secretStore.put("credential-provider-openrouter", canary, { kind: "openrouter" });
    const envName = providerCredentialEnvName(provider());
    const beforeDedicatedEnv = process.env[envName];
    const emptyHome = path.join(resources.paths.stateDir, "codex", "runtime-other");
    const empty = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-other",
      runtimeAccountId: runtimeAccountIdFor("runtime-other"),
      codexHome: emptyHome,
    });
    assert.deepEqual(empty.spawnEnv, {});
    const codexHome = path.join(resources.paths.stateDir, "codex", "runtime-provider");
    const prepared = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-provider",
      runtimeAccountId: runtimeAccountIdFor("runtime-provider"),
      codexHome,
    });
    assert.match(envName, /^SHOGGOTH_PROVIDER_[A-F0-9]{16}_API_KEY$/);
    assert.deepEqual(prepared.spawnEnv, { [envName]: canary });
    assert.deepEqual(prepared.registeredSecrets, [canary]);
    assert.deepEqual(prepared.runtimeConfig.provider, {
      id: "provider-openrouter",
      kind: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5",
      headers: { "HTTP-Referer": "https://product.test/shoggoth", "X-OpenRouter-Title": "Shoggoth" },
      awsRegion: null,
      awsProfile: null,
      credentialEnv: envName,
    });
    assert.equal(JSON.stringify(prepared.runtimeConfig).includes(canary), false);
    assert.equal(process.env[envName], beforeDedicatedEnv);
    assert.equal(prepared.configArgs.some((value) => value.includes(canary)), false);
    assert.equal(fs.existsSync(codexHome), false);
  } finally {
    await closeResources(resources);
  }
});

test("共享 internal Home 的 OpenAI key 只注入绑定 Profile，ChatGPT Profile 不继承", async () => {
  const resources = openResources();
  const canary = "openai-profile-only-key-canary-000001";
  const openAiProvider = provider("provider-openai-profile", {
    kind: "openai-api-key",
    name: "OpenAI API Key",
    baseUrl: null,
    credentialRef: "credential-provider-openai-profile",
    headers: null,
    model: "gpt-5",
  });
  try {
    resources.productStore.putModelProvider(openAiProvider);
    putProfile(resources.productStore, "runtime-openai-profile", openAiProvider.id);
    putProfile(resources.productStore, "runtime-chatgpt-profile");
    await resources.secretStore.put(openAiProvider.credentialRef, canary, { kind: "openai-api-key" });
    const sharedHome = path.join(resources.paths.runtimeAccountsDir, "codex", "shared", "home");

    const chatGpt = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-chatgpt-profile",
      runtimeAccountId: runtimeAccountIdFor(),
      codexHome: sharedHome,
    });
    const openAi = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-openai-profile",
      runtimeAccountId: runtimeAccountIdFor(),
      codexHome: sharedHome,
    });

    assert.deepEqual(chatGpt.spawnEnv, {});
    assert.deepEqual(chatGpt.registeredSecrets, []);
    assert.equal(providerCredentialEnvName(openAiProvider), "OPENAI_API_KEY");
    assert.deepEqual(openAi.spawnEnv, { OPENAI_API_KEY: canary });
    assert.deepEqual(openAi.registeredSecrets, [canary]);
    assert.equal(openAi.runtimeConfig.provider.credentialEnv, "OPENAI_API_KEY");
    assert.equal(openAi.configArgs.some((value) => value.includes(canary)), false);
    const alias = providerConfigAlias(openAiProvider);
    assert.equal(openAi.configArgs.some((value) => (
      value === `model_provider=${JSON.stringify(alias)}`
    )), true);
    assert.equal(openAi.configArgs.includes(
      `model_providers.${alias}.base_url="https://api.openai.com/v1"`,
    ), true);
    assert.equal(openAi.configArgs.includes(
      `model_providers.${alias}.env_key="OPENAI_API_KEY"`,
    ), true);
    assert.equal(openAi.configArgs.includes(
      `model_providers.${alias}.requires_openai_auth=false`,
    ), true);
    assert.equal(openAi.configArgs.some((value) => value === 'model_provider="openai"'), false);
    assert.equal(fs.existsSync(sharedHome), false);
  } finally {
    await closeResources(resources);
  }
});

test("Bedrock 只向绑定 runtimeProfile 透传标准 AWS 凭据链，secret 登记脱敏且 shell policy 继续 deny", async () => {
  const awsEnv = {
    AWS_ACCESS_KEY_ID: "bedrock-access-key-id-fixture-000001",
    AWS_SECRET_ACCESS_KEY: "bedrock-secret-access-key-fixture-000001",
    AWS_SESSION_TOKEN: "bedrock-session-token-fixture-000001",
    AWS_SECURITY_TOKEN: "bedrock-security-token-fixture-000001",
    AWS_PROFILE: "ambient-profile-must-be-overridden",
    AWS_REGION: "eu-central-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_SHARED_CREDENTIALS_FILE: "/private/fixture/credentials",
    AWS_CONFIG_FILE: "/private/fixture/config",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/private/fixture/web-identity-token",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/shoggoth-fixture",
    AWS_ROLE_SESSION_NAME: "shoggoth-fixture",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fixture",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1/fixture-credentials",
    AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-authorization-token-fixture-000001",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/private/fixture/container-token",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://127.0.0.1:1338",
    AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: "IPv4",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer-token-fixture-000001",
    AWS_UNRELATED_FIXTURE: "must-not-pass",
  };
  const resources = openResources({ parentEnv: awsEnv });
  try {
    resources.productStore.putModelProvider(provider("provider-bedrock-env", {
      kind: "amazon-bedrock",
      name: "Amazon Bedrock",
      baseUrl: null,
      credentialRef: null,
      headers: null,
      awsRegion: "us-west-2",
      awsProfile: "engineering-dev",
    }));
    resources.productStore.putModelProvider(provider("provider-ollama-env", {
      kind: "ollama",
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialRef: null,
      headers: null,
    }));
    putProfile(resources.productStore, "runtime-bedrock-env", "provider-bedrock-env");
    putProfile(resources.productStore, "runtime-ollama-env", "provider-ollama-env");

    const bedrockHome = path.join(resources.paths.stateDir, "codex", "runtime-bedrock-env");
    const prepared = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-bedrock-env",
      runtimeAccountId: runtimeAccountIdFor("runtime-bedrock-env"),
      codexHome: bedrockHome,
    });
    assert.equal(prepared.spawnEnv.AWS_REGION, "us-west-2");
    assert.equal(prepared.spawnEnv.AWS_DEFAULT_REGION, "us-west-2");
    assert.equal(prepared.spawnEnv.AWS_PROFILE, "engineering-dev");
    assert.equal(prepared.spawnEnv.AWS_ACCESS_KEY_ID, awsEnv.AWS_ACCESS_KEY_ID);
    assert.equal(prepared.spawnEnv.AWS_SHARED_CREDENTIALS_FILE, awsEnv.AWS_SHARED_CREDENTIALS_FILE);
    assert.equal(prepared.spawnEnv.AWS_WEB_IDENTITY_TOKEN_FILE, awsEnv.AWS_WEB_IDENTITY_TOKEN_FILE);
    assert.equal(prepared.spawnEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI, awsEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI);
    assert.equal(prepared.spawnEnv.AWS_BEARER_TOKEN_BEDROCK, awsEnv.AWS_BEARER_TOKEN_BEDROCK);
    assert.equal(prepared.spawnEnv.AWS_UNRELATED_FIXTURE, undefined);
    for (const secret of [
      awsEnv.AWS_ACCESS_KEY_ID,
      awsEnv.AWS_SECRET_ACCESS_KEY,
      awsEnv.AWS_SESSION_TOKEN,
      awsEnv.AWS_SECURITY_TOKEN,
      awsEnv.AWS_CONTAINER_AUTHORIZATION_TOKEN,
      awsEnv.AWS_BEARER_TOKEN_BEDROCK,
    ]) assert.equal(prepared.registeredSecrets.includes(secret), true, secret);
    const config = prepared.configArgs.join("\n");
    for (const pattern of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN"]) {
      assert.equal(config.includes(`"${pattern}"`), true, pattern);
    }

    assert.equal(fs.existsSync(bedrockHome), false);
    const ollamaHome = path.join(resources.paths.stateDir, "codex", "runtime-ollama-env");
    const local = await resources.bridge.prepareRuntime({
      runtimeProfileId: "runtime-ollama-env",
      runtimeAccountId: runtimeAccountIdFor("runtime-ollama-env"),
      codexHome: ollamaHome,
    });
    assert.deepEqual(local.spawnEnv, {});
    assert.deepEqual(local.registeredSecrets, []);
  } finally {
    await closeResources(resources);
  }
});

test("runtime config 同样拒绝 percent-encoded custom request endpoint", () => {
  const fixture = fixturePaths();
  const writer = new CodexRuntimeConfigWriter({ paths: fixture.paths });
  const codexHome = prepareCodexHome(fixture.paths, "runtime-encoded-endpoint");
  for (const baseUrl of [
    "https://gateway.test/v1/%72esponses",
    "https://gateway.test/v1/%2Fresponses",
    "https://gateway.test/v1/chat%2Fcompletions",
    "https://gateway.test/v1/%252Fresponses",
    "https://gateway.test/v1/chat%252Fcompletions",
    "https://gateway.test/v1/%2572esponses",
    "https://gateway.test/v1/%2Fmodels",
    "https://gateway.test/v1/%2fmodels",
    "https://gateway.test/v1/%252Fmodels",
    "https://gateway.test/v1/%252fmodels",
    "https://gateway.test/v1/%25252Fmodels",
    "https://gateway.test/v1/models%2Fdetail",
    "https://gateway.test/v1%5cresponses",
    "https://gateway.test/v1%255cresponses",
    "https://gateway.test/v1%5cchat%5ccompletions",
    "https://gateway.test/v1%255cchat%255ccompletions",
    "https://gateway.test/v1%00models",
    "https://gateway.test/v1%2500models",
    "https://gateway.test/v1%1fmodels",
    "https://gateway.test/v1%251fmodels",
    "https://gateway.test/v1/%E0%A4%A",
    "https://gateway.test/v1/./models",
    "https://gateway.test/v1/../models",
    "https://gateway.test/v1/%2e/models",
    "https://gateway.test/v1/%2E%2e/models",
    "https://gateway.test/v1/%252e/models",
    "https://gateway.test/v1/%252e%252e/models",
    "https://gateway.test/v1/responses/%252e",
    "https://gateway.test/v1/chat/completions/%252e",
  ]) {
    assert.throws(
      () => writer.write({
        runtimeProfileId: "runtime-encoded-endpoint",
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        codexHome,
        runtimeConfig: { provider: {
          id: "encoded-custom",
          kind: "custom-responses",
          name: "Encoded Custom",
          baseUrl,
          model: "fixture/model",
          credentialEnv: null,
          headers: null,
          awsRegion: null,
          awsProfile: null,
        } },
      }),
      (error) => error.code === "CODEX_RUNTIME_CONFIG_INVALID",
    );
  }
  assert.doesNotThrow(() => writer.write({
    runtimeProfileId: "runtime-encoded-endpoint",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    codexHome,
    runtimeConfig: { provider: {
      id: "plain-slash-custom",
      kind: "custom-responses",
      name: "Plain Slash Custom",
      baseUrl: "https://gateway.test/v1/models.json",
      model: "fixture/model",
      credentialEnv: null,
      headers: null,
      awsRegion: null,
      awsProfile: null,
    } },
  }));
});

test("locked/missing/kind mismatch/未知 profile 都返回结构化错误且不生成 config", async () => {
  const lockedResources = openResources();
  const canary = "locked-runtime-secret-canary-0001";
  try {
    lockedResources.productStore.putModelProvider(provider());
    putProfile(lockedResources.productStore, "runtime-locked", "provider-openrouter");
    await lockedResources.secretStore.put("credential-provider-openrouter", canary, { kind: "openrouter" });
    await lockedResources.secretStore.close();
    lockedResources.secretStore = new EncryptedSecretStore({
      paths: lockedResources.paths,
      safeStorage: safeStorage(false),
    });
    lockedResources.secretStore.open();
    lockedResources.bridge = new ProviderRuntimeBridge({
      productStore: lockedResources.productStore,
      secretStore: lockedResources.secretStore,
      configWriter: lockedResources.configWriter,
    });
    const codexHome = prepareCodexHome(lockedResources.paths, "runtime-locked");
    await assert.rejects(
      lockedResources.bridge.prepareRuntime({
        runtimeProfileId: "runtime-locked",
        runtimeAccountId: runtimeAccountIdFor("runtime-locked"),
        codexHome,
      }),
      (error) => error.code === "credentials_locked"
        && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(canary),
    );
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
  } finally {
    await closeResources(lockedResources);
  }

  const missing = openResources();
  try {
    missing.productStore.putModelProvider(provider());
    putProfile(missing.productStore, "runtime-missing", "provider-openrouter");
    const codexHome = prepareCodexHome(missing.paths, "runtime-missing");
    await assert.rejects(
      missing.bridge.prepareRuntime({
        runtimeProfileId: "runtime-missing",
        runtimeAccountId: runtimeAccountIdFor("runtime-missing"),
        codexHome,
      }),
      (error) => error.code === "credentials_missing",
    );
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
    await assert.rejects(
      missing.bridge.prepareRuntime({
        runtimeProfileId: "runtime-unknown",
        runtimeAccountId: runtimeAccountIdFor("runtime-unknown"),
        codexHome,
      }),
      (error) => error.code === "RUNTIME_PROFILE_NOT_FOUND",
    );
  } finally {
    await closeResources(missing);
  }

  const mismatch = openResources();
  try {
    mismatch.productStore.putModelProvider(provider("provider-mismatch", {
      credentialRef: "credential-mismatch",
    }));
    putProfile(mismatch.productStore, "runtime-mismatch", "provider-mismatch");
    await mismatch.secretStore.put("credential-mismatch", "mismatch-secret-canary-0001", { kind: "ollama" }); // gitleaks:allow -- synthetic test fixture; not a usable credential
    const codexHome = prepareCodexHome(mismatch.paths, "runtime-mismatch");
    await assert.rejects(
      mismatch.bridge.prepareRuntime({
        runtimeProfileId: "runtime-mismatch",
        runtimeAccountId: runtimeAccountIdFor("runtime-mismatch"),
        codexHome,
      }),
      (error) => error.code === "credentials_mismatch",
    );
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
  } finally {
    await closeResources(mismatch);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`PASS codex provider runtime unit (${tests.length})`);
})();
