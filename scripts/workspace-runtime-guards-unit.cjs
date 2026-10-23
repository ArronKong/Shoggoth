"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { buildPiRpcArgs } = require("../app/agent-service/pi-runtime-paths");
const { antigravityWorkspaceSessionMeta } = require("../app/agent-service/antigravity-workspace-execution");
const { nativePermissionRules, commandEnvironment, modelConnectionConfig, preparePrivateOpenCodeConfig } = require("../app/agent-service/opencode-runtime-host");

const POLICY = { approvalPolicy: "on-request", sandbox: "workspace-write" };

test("all four pools freeze the native guard with the execution contract", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-pools-")));
  try {
    for (const [runtime, file, name] of [
      ["antigravity", "antigravity-runtime-pool", "AntigravityRuntimePool"],
      ["pi", "pi-runtime-pool", "PiRuntimePool"],
      ["opencode", "opencode-runtime-pool", "OpenCodeRuntimePool"],
      ["deepseek-harness", "deepseek-harness-runtime-pool", "DeepSeekHarnessRuntimePool"],
    ]) {
      const Pool = require(`../app/agent-service/${file}`)[name];
      const binding = { runtime, runtimeProfileId: `guard-${runtime}`, runtimeAccountId: `account-${runtime}` };
      const env = Object.freeze({ runtime, runtimeAccountId: binding.runtimeAccountId, home: root,
        binaryPath: "/bin/true", configSourceHome: root, launchArgs: Object.freeze([]),
        spawnEnv: Object.freeze({ HOME: root, PI_CODING_AGENT_DIR: root, XDG_DATA_HOME: root, DSH_HOME: root }),
        configurationMode: ["antigravity", "deepseek-harness"].includes(runtime) ? "integration" : "native" });
      const hosts = [];
      const pool = new Pool({ paths: { trustedRoot: root, stateDir: path.join(root, "state") },
        runtimeAccountResolver: { resolve: () => env }, runtimeAccountLookup: () => ({}),
        hostFactory(options) {
          const host = { options, initialize: async () => {}, beginAcquire() {}, stop: async () => {},
            terminated: new Promise(() => {}) };
          hosts.push(host); return host;
        } });
      try {
        const contract = { runId: `run-${runtime}`, runtime, source: "chat", workspace: root,
          permissionMode: "auto-review", permissionPolicy: POLICY, workspaceExecutionVersion: 1 };
        const options = { workspace: root, permissionPolicy: POLICY, executionContract: contract };
        await pool.get(binding, options);
        assert.equal(hosts[0].options.workspaceExecutionVersion, 1, runtime);
        await assert.rejects(pool.get(binding, { ...options, executionContract: { ...contract, workspaceExecutionVersion: undefined } }),
          { code: "RUNTIME_PERMISSION_POLICY_CONFLICT" });
        await pool.get(binding, { ...options, executionContract: { ...contract, runId: `legacy-${runtime}`, workspaceExecutionVersion: undefined } });
        assert.equal(hosts[1].options.workspaceExecutionVersion, null, "old descriptors retain their native behavior");
      } finally { await pool.stopAll(); }
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("Pi removes every builtin rather than merely excluding bash", () => {
  const params = { permissionPolicy: POLICY, sessionId: "11111111-1111-4111-8111-111111111111",
    sessionDir: "/private/sessions", extensionPath: "/trusted/shoggoth.mjs" };
  const args = buildPiRpcArgs({ ...params, workspaceExecutionVersion: 1 });
  assert.ok(args.includes("--no-builtin-tools"));
  assert.ok(args.includes("--no-mcp"), "only the authenticated Shoggoth extension supplies tools");
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(!args.includes("--exclude-tools"));
  assert.ok(!buildPiRpcArgs(params).includes("--no-builtin-tools"), "legacy and other modes keep their existing tools");
});

test("Antigravity filters builtins and explicitly clears the persisted filter on mode exit", () => {
  assert.deepEqual(antigravityWorkspaceSessionMeta(1), { agy: { enabledTools: ["ask_question", "finish"] } });
  assert.deepEqual(antigravityWorkspaceSessionMeta(null), { agy: { disabledTools: [] } });
});

test("OpenCode removes all native tools while keeping gated Shoggoth calls", () => {
  assert.deepEqual(nativePermissionRules(POLICY, 1), [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "shoggoth_*", pattern: "*", action: "ask" },
  ]);
  const env = commandEnvironment({}, { spawnEnv: {} }, "/private/config", "p", POLICY, null, 1);
  const permissions = JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(permissions["*"], "deny"); assert.equal(permissions["shoggoth_*"], "ask");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, "1");
  assert.equal(nativePermissionRules(POLICY)[0].action, "ask");
});

test("managed OpenCode config keeps JSONC model credentials but excludes native executables", () => {
  const parsed = JSON.parse(modelConnectionConfig(Buffer.from(`{
    // Native model config may contain URLs and escaped strings.
    "model":"provider/model", "small_model":"provider/small",
    "provider":{"provider":{"options":{"baseURL":"https://example.invalid/a//b", "apiKey":"/*kept*/\\\"key"},}},
    /* These native surfaces must not be loaded. */
    "mcp":{"unsafe":{"command":["shell"]}}, "plugin":["unsafe"],
    "instructions":["/outside/file"], "command":{"unsafe":{"template":"!arbitrary"}},
  }`)));
  assert.deepEqual(Object.keys(parsed).sort(), ["model", "provider", "small_model"]);
  assert.equal(parsed.provider.provider.options.baseURL, "https://example.invalid/a//b");
  assert.equal(parsed.provider.provider.options.apiKey, '/*kept*/"key');
  assert.throws(() => modelConnectionConfig(Buffer.from('{"model":"x"/*')), { code: "OPENCODE_NATIVE_CONFIG_INVALID" });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-workspace-config-")));
  try {
    const source = path.join(root, "source"), target = path.join(root, "private");
    fs.mkdirSync(path.join(source, "opencode"), { recursive: true });
    const original = '{/* keep auth */"provider":{"a":{"options":{"apiKey":"synthetic"}}},"model":"a/b","mcp":{"other":{"command":["native"]}},}';
    const file = path.join(source, "opencode/opencode.jsonc"); fs.writeFileSync(file, original, { mode: 0o600 });
    preparePrivateOpenCodeConfig(fs, source, target, root, 1);
    assert.equal(fs.readFileSync(file, "utf8"), original, "native config is never rewritten");
    const copied = JSON.parse(fs.readFileSync(path.join(target, "config/opencode/opencode.jsonc"), "utf8"));
    assert.deepEqual(Object.keys(copied).sort(), ["model", "provider"], "the actual private file must be sanitized before CLI startup");
    assert.equal(copied.provider.a.options.apiKey, "synthetic");
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("DSH monotonic guard denies every native or foreign MCP call, including subdispatch", async () => {
  const { installWorkspaceExecutionGuard, BridgeRuntime } = await import(pathToFileURL(require.resolve(
    "../resources/deepseek-harness/shoggoth-dsh-bridge.mjs")).href);
  let before, guard, delegated = 0;
  const ctx = { on(name, fn, options) { assert.equal(name, "tools/pre-execute"); assert.equal(options.prepend, true); before = fn; },
    tools: { guard(fn) { guard = fn; }, restrict() {} } };
  installWorkspaceExecutionGuard(ctx);
  for (const name of ["read_file", "write_file", "bash", "run_code", "jobs", "spawn_agent", "cordis",
    "mcp__other__execute", "mcp__shoggoth_evil__read"]) {
    const exec = { name, parent: {}, agent: {}, arguments: {} };
    assert.equal((await before(exec, () => { delegated++; return Promise.resolve({ kind: "allow" }); })).kind, "deny");
    assert.equal(typeof guard(exec), "string", "pre-approval cannot override a monotonic denial");
  }
  assert.equal(delegated, 0);
  assert.deepEqual(await before({ name: "mcp__shoggoth__workspace_execute" }, async () => ({ kind: "allow" })), { kind: "allow" });
  assert.equal(guard({ name: "mcp__shoggoth__browser_open" }), undefined, "product confirmation remains in the Service");
  assert.throws(() => installWorkspaceExecutionGuard({ tools: {}, on() {} }), { code: "WORKSPACE_RUNTIME_GUARD_UNAVAILABLE" });
  let names, mode, setup;
  const bridge = new BridgeRuntime({ agents: { async create(options) { setup = options.setup;
    setup({ tools: { presentAs(value) { mode = value; }, schemas: () => ["bash", "read_file", "mcp__shoggoth__workspace_execute", "mcp__shoggoth__browser_open"]
      .map(name => ({ name })), restrict(filter) { names = filter.allow; } }, systemPrompt: { section() {} } });
    return { agent: { session: {} } }; } }, permissionPresets: { async set() {} } }, { workspaceExecution: true });
  await bridge.createHandle({ remoteSessionId: "guard-session", cwd: "/private/workspace",
    selection: { provider: "fixture", model: "model" }, developerInstructions: "", permissionMode: "workspace-write" }, false);
  assert.equal(mode, "native");
  assert.deepEqual(names, ["mcp__shoggoth__workspace_execute", "mcp__shoggoth__browser_open"]);
  assert.equal(typeof setup, "function");
});
