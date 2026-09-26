#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FederationMcpSessionManager,
  ensureFederationMcpCredential,
  federationMcpAuthPath,
} = require("../app/agent-service/federation-mcp-auth");
const {
  DEFAULT_AGENT_PROFILE_ID,
  DEFAULT_RUNTIME_PROFILE_ID,
} = require("../app/agent-service/product-store");
const {
  SERVICE_PROTOCOL_VERSION,
} = require("../app/agent-service/service-protocol-version");
const {
  SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
} = require("../app/agent-service/runtime-account");
const { resolveCanonicalServicePaths, resolveServicePaths } = require("../app/agent-service/paths");
const {
  EXTERNAL_FEDERATION_MCP_INSTRUCTIONS,
  EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS,
  authenticateFederationMcpSession,
  createMcpStdioHandler,
} = require("../app/shoggoth-mcp-helper");
const {
  validateExternalFederationMcpRoleGate,
  validateMcpRoleGate,
} = require("../app/bootstrap-role");
const {
  createFederationMcpRegistrar,
} = require("../app/federation-mcp-registrar");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tempPaths() {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-mcp-"));
  fs.chmodSync(trustedRoot, 0o700);
  return resolveServicePaths({
    trustedRoot,
    stateRoot: path.join(trustedRoot, "state"),
    profileRoot: path.join(trustedRoot, "profile"),
    cacheRoot: path.join(trustedRoot, "cache"),
  });
}

function profileStore() {
  let enabled = true;
  return {
    getAgentProfile(id) {
      if (id !== DEFAULT_AGENT_PROFILE_ID) return null;
      return {
        id,
        enabled,
        runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
      };
    },
    disable() { enabled = false; },
  };
}

test("外部 MCP credential 为 0600，OpenClaw/Hermes session 相互隔离且只绑定默认原生 Agent", () => {
  const paths = tempPaths();
  const credential = ensureFederationMcpCredential(paths);
  assert.equal(fs.statSync(federationMcpAuthPath(paths)).mode & 0o077, 0);
  const store = profileStore();
  const manager = new FederationMcpSessionManager({
    productStore: store, paths, defaultProfileId: DEFAULT_AGENT_PROFILE_ID,
  });
  const open = manager.issue({
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    credentialToken: credential.token,
    client: "openclaw",
  });
  assert.equal(manager.authorize({
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    token: open.token,
  }).federationClient, "openclaw");
  assert.equal(manager.authorize({
    runtimeProfileId: "wrong",
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    token: open.token,
  }), null);
  assert.throws(() => manager.issue({
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    credentialToken: Buffer.alloc(32, 1).toString("base64url"),
    client: "hermes",
  }), (error) => error?.code === "MCP_AUTH_FAILED");
  store.disable();
  assert.equal(manager.authorize({
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    token: open.token,
  }), null);
  manager.reset();
});

test("外部 helper 通过独立 Service 握手认证，配置文件不直接携带 credential", async () => {
  const paths = tempPaths();
  const credential = ensureFederationMcpCredential(paths);
  const sessionToken = Buffer.alloc(32, 9).toString("base64url");
  let seen = null;
  const session = await authenticateFederationMcpSession({
    paths,
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    client: "hermes",
    authFile: federationMcpAuthPath(paths),
    async requestService(_paths, request) {
      seen = structuredClone(request);
      return {
        token: sessionToken, protocolVersion: SERVICE_PROTOCOL_VERSION,
        runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
        runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
        profileId: DEFAULT_AGENT_PROFILE_ID, expiresAt: Date.now() + 60_000,
      };
    },
  });
  assert.equal(session.token, sessionToken);
  assert.equal(seen.version, SERVICE_PROTOCOL_VERSION);
  assert.equal(seen.method, "mcp.federation.open");
  assert.equal(seen.params.credentialToken, credential.token);
  assert.equal(seen.params.client, "hermes");
});

test("外部 MCP 排除原生设定、记忆和 Computer Use，保留外部 Agent 的自身身份", async () => {
  assert.equal(EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS.length, 71);
  assert.equal(EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS.filter(tool => tool.name.startsWith("inspiration_")).length, 10);
  assert.equal(EXTERNAL_FEDERATION_MCP_INSTRUCTIONS
    .includes("You are the Shoggoth App's native Agent"), false);
  assert.match(EXTERNAL_FEDERATION_MCP_INSTRUCTIONS, /own Agent name, persona, memory and current model remain owned by your external backend/u);
  assert.doesNotMatch(EXTERNAL_FEDERATION_MCP_INSTRUCTIONS,
    /memory_save|memory_search|agent_definition_update|agent_definition_read|unnamespaced Codex request_user_input/u);
  assert.equal(EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS
    .some((definition) => definition.name.startsWith("computer_")), false);
  let serviceCalls = 0;
  const handler = createMcpStdioHandler({
    runtimeProfileId: DEFAULT_RUNTIME_PROFILE_ID,
    runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID,
    sessionToken: Buffer.alloc(32, 4).toString("base64url"),
    requestService: async () => { serviceCalls += 1; return {}; },
    toolDefinitions: EXTERNAL_FEDERATION_MCP_TOOL_DEFINITIONS,
  });
  await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
  } });
  const listed = await handler({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, 71);
  for (const shared of ["skill_catalog", "skill_read", "mcp_server_list", "mcp_server_tools", "mcp_server_call"]) {
    assert.equal(listed.result.tools.some((definition) => definition.name === shared), true, shared);
  }
  for (const hidden of ["external_agent_list", "external_agent_get", "external_agent_run",
    "native_agent_get", "native_agent_update", "native_agent_archive",
    "memory_search", "memory_save", "memory_confirm", "memory_forget", "agent_definition_read", "agent_definition_update"]) {
    assert.equal(listed.result.tools.some((definition) => definition.name === hidden), false);
  }
  for (const name of ["computer_status", "memory_search", "agent_definition_read"]) {
    const refused = await handler({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name, arguments: {},
    } });
    assert.equal(refused.error.code, -32602);
  }
  assert.equal(serviceCalls, 0);
  handler.close();
});

test("packaged 外部 role 只接受规范私有 credential 路径和显式客户端标记", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-federation-home-"));
  fs.chmodSync(home, 0o700);
  const userInfo = () => ({ homedir: home });
  const paths = resolveCanonicalServicePaths({ userInfo });
  ensureFederationMcpCredential(paths);
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    SHOGGOTH_FEDERATION_MCP_CLIENT: "openclaw",
    SHOGGOTH_FEDERATION_MCP_AUTH_FILE: federationMcpAuthPath(paths),
  };
  const argv = [
    `--shoggoth-runtime-profile=${DEFAULT_RUNTIME_PROFILE_ID}`,
    `--shoggoth-runtime-account=${SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID}`,
  ];
  const runtime = {
    platform: "darwin", defaultApp: false, ppid: 42,
    execPath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    resourcesPath: "/Applications/Shoggoth.app/Contents/Resources",
    userInfo,
    verifyExternalMcpApp: () => true,
  };
  const actual = { ...runtime, now: Date.now };
  assert.equal(validateExternalFederationMcpRoleGate(env, actual, runtime, argv).client,
    "openclaw");
  assert.equal(validateMcpRoleGate(env, runtime, argv).runtimeProfileId,
    DEFAULT_RUNTIME_PROFILE_ID);
  assert.equal(validateMcpRoleGate(env, runtime, argv).runtimeAccountId,
    SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  assert.throws(() => validateMcpRoleGate({ ...env,
    SHOGGOTH_FEDERATION_MCP_AUTH_FILE: path.join(home, "wrong.json"),
  }, runtime, argv));
});

test("静默注册使用官方 CLI 配置入口、覆盖本地 Hermes profiles，且 JSON 不含 token", async () => {
  const paths = tempPaths();
  const calls = [];
  const registrar = createFederationMcpRegistrar({
    paths,
    packaged: true,
    executablePath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    bootstrapPath: "/Applications/Shoggoth.app/Contents/Resources/app.asar/app/bootstrap.js",
    openclawBin: "/usr/local/bin/openclaw",
    hermesBin: "/usr/local/bin/hermes",
    listHermesProfiles: () => ["default", "work", "Invalid.Profile"],
    getHermesMode: () => "local",
    execFile(command, args, _options, callback) {
      calls.push([command, structuredClone(args)]);
      callback(null, "", "");
    },
  });
  const result = await registrar.reconcile();
  assert.deepEqual(result, { skipped: null, openclaw: true, hermes: ["default", "work"] });
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 3)), [
    ["mcp", "set", "shoggoth"],
    ["mcp", "reload"],
    ["config", "set", "--force"],
    ["--profile", "work", "config"],
  ]);
  const serialized = JSON.stringify(calls);
  const credential = ensureFederationMcpCredential(paths);
  assert.equal(serialized.includes(credential.token), false);
  assert.equal(serialized.includes("SHOGGOTH_FEDERATION_MCP_AUTH_FILE"), true);
  const openConfig = JSON.parse(calls[0][1][3]);
  assert.equal(openConfig.env.SHOGGOTH_FEDERATION_MCP_CLIENT, "openclaw");
  assert.equal(openConfig.args.includes(
    `--shoggoth-runtime-account=${SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID}`,
  ), true);
  const hermesConfig = JSON.parse(calls[2][1].at(-1));
  assert.equal(hermesConfig.env.SHOGGOTH_FEDERATION_MCP_CLIENT, "hermes");
  assert.equal(calls[2][1][3], "mcp_servers.shoggoth");
  assert.equal(calls.every(([, args]) => !args.includes("remove") && !args.includes("reset")), true);

  const remoteCalls = [];
  const remoteRegistrar = createFederationMcpRegistrar({
    paths,
    packaged: true,
    executablePath: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth",
    bootstrapPath: "/Applications/Shoggoth.app/Contents/Resources/app.asar/app/bootstrap.js",
    getHermesMode: () => "remote",
    execFile(command, args, _options, callback) {
      remoteCalls.push([command, structuredClone(args)]);
      callback(null, "", "");
    },
  });
  const remote = await remoteRegistrar.reconcile();
  assert.deepEqual(remote, { skipped: null, openclaw: true, hermes: [] });
  assert.equal(remoteCalls.some(([, args]) => args.includes("config")), false);
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
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
})();
