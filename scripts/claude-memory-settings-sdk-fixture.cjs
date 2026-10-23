#!/usr/bin/env node
"use strict";

// Read an explicitly supplied official SDK from outside the repository. The
// SDK talks only to this file's synthetic stdio CLI; no Claude binary, provider,
// credentials or production Home is used or distributed by this fixture.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { pathToFileURL } = require("node:url");
const MODEL = "claude-opus-4-6";

function childMain() {
  const [root, model, policy] = process.argv.slice(3);
  const log = path.join(root, "wire.jsonl"), settings = { applied: { model, effort: "high" },
    effective: { alwaysThinkingEnabled: true, fastMode: false } };
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    fs.appendFileSync(log, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    if (message.type === "user") {
      write({ type: "result", subtype: "success", is_error: false, result: "Amber", num_turns: 1,
        duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: "fixture-session", uuid: "fixture-result",
        usage: { input_tokens: 5, output_tokens: 1 }, permission_denials: [],
        modelUsage: { [model]: { inputTokens: 5, outputTokens: 1 } } });
      return;
    }
    if (message.type !== "control_request") throw new Error("unexpected fixture message");
    const request = message.request;
    let response = {};
    if (request.subtype === "initialize") response = { commands: [], agents: [], models: [{ value: "opus", resolvedModel: model,
      displayName: "Fixture", description: "Synthetic model", supportsEffort: policy !== "legacy-unattested",
      ...(policy === "legacy-unattested" ? {} : { supportedEffortLevels: ["low", "medium", "high", "max"] }),
      supportsAdaptiveThinking: policy !== "legacy-unattested", supportsFastMode: policy !== "legacy-unattested" }] };
    else if (request.subtype === "get_settings") response = settings;
    else if (request.subtype === "apply_flag_settings") {
      Object.assign(settings.effective, request.settings);
      if (request.settings.effortLevel) settings.applied.effort = policy === "override" ? "low" : request.settings.effortLevel;
    } else if (request.subtype !== "set_max_thinking_tokens") throw new Error("unexpected fixture control");
    write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
  });
}

async function main() {
  const sdkDirectory = process.argv[2];
  assert.ok(sdkDirectory && path.isAbsolute(sdkDirectory), "Pass the absolute path to an already downloaded official SDK directory");
  const packageJson = JSON.parse(fs.readFileSync(path.join(sdkDirectory, "package.json")));
  assert.equal(packageJson.name, "@anthropic-ai/claude-agent-sdk");
  // This test is strictly stdio. Prevent accidental HTTP, DNS or socket use by
  // the SDK, and retain the attempt count even if an SDK catches the rejection.
  let networkAttempts = 0;
  const deny = () => { networkAttempts++; throw new Error("SDK fixture network is disabled"); };
  globalThis.fetch = deny;
  for (const [module, methods] of [
    ["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]],
    ["node:http", ["request", "get"]], ["node:https", ["request", "get"]],
    ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]],
  ]) for (const method of methods) require(module)[method] = deny;
  require("node:net").Socket.prototype.connect = deny;
  require("node:module").syncBuiltinESMExports();
  const sdk = await import(pathToFileURL(path.join(sdkDirectory, "sdk.mjs")).href);
  const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
  const parent = fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-claude-sdk-control-"));
  const receipts = [], children = [];
  try {
    for (const [name, model, execution, policy] of [
      ["max-fast", MODEL, { thinking: "max", fastMode: true }, "accept"],
      ["optional-off", MODEL, { thinking: "off", fastMode: false }, "accept"],
      ["mandatory-off", "claude-opus-5-5", { thinking: "off", fastMode: false }, "accept"],
      ["policy-override", MODEL, { thinking: "max" }, "override"],
      ["alias-resolution", MODEL, null, "accept"],
      ["legacy-budget-unattested", "claude-sonnet-4-5", { thinking: "high" }, "legacy-unattested"],
    ]) {
      const root = path.join(parent, name); fs.mkdirSync(root, { mode: 0o700 });
      const env = { HOME: root, CLAUDE_CONFIG_DIR: root, TMPDIR: root, ELECTRON_RUN_AS_NODE: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
      let child, sdkArgs;
      const host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), {
        state: "ready", fs, sdk, binaryPath: fs.realpathSync(process.execPath), userHome: root,
        controlProcesses: new Map(), controlProcessGroups: new WeakSet(), controlQueries: new Set(),
        cleanupIncomplete: false, killGraceMs: 1000, shutdownGraceMs: 1000,
        _spawnEnvironment: () => ({ ...env }),
        spawnProcess(command, args, options) {
          assert.equal(command, fs.realpathSync(process.execPath)); sdkArgs = args;
          child = spawn(command, [__filename, "--control-child", root, model, policy], { ...options, env });
          children.push(child); return child;
        },
        killProcessGroup(pid, signal) { process.kill(-pid, signal); },
      });
      const resolving = name === "alias-resolution";
      const operation = resolving
        ? host.resolveModelOnly({ model: "opus", operationId: `sdk-fixture-${name}`, signal: AbortSignal.timeout(15_000) })
        : host.generateModelOnly({ prompt: "Recall the synthetic amber telescope", model, execution,
          operationId: `sdk-fixture-${name}`, signal: AbortSignal.timeout(15_000) });
      const refused = policy === "override" || policy === "legacy-unattested";
      if (refused) await assert.rejects(operation, { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
      else if (resolving) assert.deepEqual(await operation, { model, provider: "claude-code" });
      else assert.equal((await operation).text, "Amber");
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.equal(host.controlProcesses.size, 0); assert.equal(host.controlQueries.size, 0);
      const wire = fs.readFileSync(path.join(root, "wire.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const controls = wire.filter(row => row.type === "control_request").map(row => row.request);
      const prompts = wire.filter(row => row.type === "user");
      assert.deepEqual(controls.map(row => row.subtype), resolving || policy === "legacy-unattested" ? ["initialize", "get_settings"]
        : ["initialize", "get_settings", "apply_flag_settings", "set_max_thinking_tokens", "get_settings"]);
      assert.equal(prompts.length, resolving || refused ? 0 : 1);
      if (resolving) assert.equal(sdkArgs[sdkArgs.indexOf("--model") + 1], "opus");
      else if (policy !== "legacy-unattested") {
        assert.equal(controls[3].max_thinking_tokens, name === "optional-off" ? 0 : null);
        assert.deepEqual(controls[2].settings, { alwaysThinkingEnabled: name !== "optional-off",
          ...(name === "optional-off" ? {} : { effortLevel: name === "mandatory-off" ? "low" : "max" }),
          ...(execution.fastMode === undefined ? {} : { fastMode: execution.fastMode }) });
      }
      const toolsIndex = sdkArgs.indexOf("--tools");
      assert.ok(toolsIndex >= 0); assert.equal(sdkArgs[toolsIndex + 1], "");
      assert.ok(sdkArgs.includes("--no-session-persistence")); assert.ok(sdkArgs.includes("--strict-mcp-config"));
      if (prompts.length) assert.equal(wire.at(-1).type, "user", "all control acknowledgements precede the only prompt");
      receipts.push({ name, controls: controls.length, prompts: prompts.length, exited: true });
    }
    assert.equal(networkAttempts, 0);
    process.stdout.write(`${JSON.stringify({ verified: true, sdkVersion: packageJson.version, networkAttempts,
      scope: "official SDK, synthetic stdio CLI and model, temporary Home; not native Claude/provider acceptance", receipts }, null, 2)}\n`);
  } finally {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture worker did not exit; temporary Home retained")), 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    })));
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--control-child") childMain();
else main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
