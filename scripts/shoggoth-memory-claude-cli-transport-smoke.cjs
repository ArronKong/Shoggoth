"use strict";

// Real local stdio workers, synthetic SDK/CLI/model only. This never starts a
// Claude executable, reads credentials, or connects to a provider.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), readline = require("node:readline");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
const { projectClaudeMemorySettings: project, describeClaudeMemoryModel: describe,
  planClaudeMemoryTransport: plan, resolveClaudeMemoryExecution: resolve } = require("../app/agent-service/claude-memory-model-settings");
const core = require("../app/agent-service/shoggoth-memory/core.cjs");
const LEGACY = "claude-sonnet-4-5", NATIVE = "claude-opus-4-6";
const keys = ["MAX_THINKING_TOKENS", "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"];
const nativeMetadata = model => ({ value: model, supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true, supportsFastMode: true });

function childMain() {
  const config = JSON.parse(process.argv[3]);
  let networkAttempts = 0;
  const deny = () => { networkAttempts++; throw new Error("Synthetic CLI network is disabled"); };
  globalThis.fetch = deny;
  require("node:net").Socket.prototype.connect = deny;
  const settings = { applied: { model: config.model, ...(config.native ? { effort: "high" } : {}) },
    effective: { alwaysThinkingEnabled: true, fastMode: false } };
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.type === "user") {
      write({ type: "result", subtype: "success", is_error: false, result: "Amber", modelUsage: { [config.model]: {} } });
      return;
    }
    const request = message.request;
    let response = {};
    if (request.subtype === "initialize") response = { models: config.native ? [{ ...nativeMetadata(config.model),
      ...(config.adaptive === false ? { supportsAdaptiveThinking: false } : {}) }] :
      [{ value: "legacy-alias", resolvedModel: config.model, displayName: "Synthetic", description: "Synthetic CLI" }],
      transportEnv: Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), networkAttempts };
    else if (request.subtype === "get_settings") response = settings;
    else if (request.subtype === "apply_flag_settings") {
      Object.assign(settings.effective, request.settings);
      if (request.settings.effortLevel !== undefined) settings.applied.effort = request.settings.effortLevel;
    } else if (request.subtype !== "set_max_thinking_tokens") throw new Error("Unexpected synthetic control");
    // Manual budget controls intentionally return an empty acknowledgement.
    write({ type: "control_response", request_id: message.request_id, response });
  });
}

function queue() {
  const values = [], waiters = [];
  return {
    push(value) { if (waiters.length) waiters.shift()(value); else values.push(value); },
    async next() { return values.length ? values.shift() : new Promise(resolve => waiters.push(resolve)); },
  };
}

function fixture({ model = LEGACY, native = false, adaptive, poisonSdkEnv = false, workerConfig = () => ({}), hook = () => {}, closing = () => {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-claude-cli-transport-")));
  const f = { root, workers: [], requests: [], valid: true, hook, closing };
  const baseEnv = { HOME: root, CLAUDE_CONFIG_DIR: root, TMPDIR: root, ELECTRON_RUN_AS_NODE: "1" };
  f.host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), {
    state: "ready", fs, binaryPath: fs.realpathSync(process.execPath), userHome: root,
    controlProcesses: new Map(), controlProcessGroups: new WeakSet(), controlQueries: new Set(),
    cleanupIncomplete: false, killGraceMs: 500, shutdownGraceMs: 500,
    _spawnEnvironment: () => ({ ...baseEnv }),
    spawnProcess(command, args, options) {
      assert.equal(command, fs.realpathSync(process.execPath));
      for (const previous of f.workers) assert.ok(previous.child.exitCode !== null || previous.child.signalCode !== null,
        "The discovery worker must physically exit before its replacement starts");
      const child = spawn(command, [__filename, "--synthetic-cli",
        JSON.stringify({ model, native, adaptive, ...workerConfig(f.workers.length) })], options);
      f.workers.push({ child, env: options.env, wire: [], prompts: [], initialized: null });
      return child;
    },
    killProcessGroup(pid, signal) { try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } },
    sdk: { query(request) {
      const ordinal = f.requests.length;
      f.requests.push(request);
      const child = request.options.spawnClaudeCodeProcess({ command: f.host.binaryPath, args: ["--synthetic-sdk"],
        cwd: request.options.cwd, env: { ...request.options.env,
          ...(poisonSdkEnv ? { MAX_THINKING_TOKENS: "999999999", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "0", UNTRUSTED_ENV: "discard" } : {}) } });
      const worker = f.workers.at(-1), pending = new Map(), output = queue();
      let id = 0, closed = false;
      const send = async request => {
        const requestId = `${ordinal}-${++id}`;
        worker.wire.push(request);
        const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`);
        return response;
      };
      readline.createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        if (message.type === "control_response") {
          const waiting = pending.get(message.request_id); pending.delete(message.request_id); waiting?.resolve(message.response);
        } else output.push({ done: false, value: message });
      });
      child.once("exit", () => {
        for (const waiting of pending.values()) waiting.reject(new Error("Synthetic process exited"));
        pending.clear(); output.push({ done: true });
      });
      child.stderr.on("data", data => { worker.stderr = `${worker.stderr || ""}${data}`; });
      const initialization = send({ subtype: "initialize" }).then(value => { worker.initialized = value; return value; });
      const control = async (method, request) => {
        await initialization;
        const value = request ? await send(request) : worker.initialized.models;
        await f.hook(method, ordinal, worker);
        return value;
      };
      (async () => {
        for await (const message of request.prompt) {
          worker.prompts.push(message);
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }
      })().catch(() => {});
      return {
        getSettings: () => control("getSettings", { subtype: "get_settings" }),
        supportedModels: () => control("supportedModels"),
        applyFlagSettings: settings => control("applyFlagSettings", { subtype: "apply_flag_settings", settings }),
        setMaxThinkingTokens: max => control("setMaxThinkingTokens", { subtype: "set_max_thinking_tokens", max_thinking_tokens: max }),
        close() { if (closed) return; closed = true; f.closing(ordinal); child.stdin.end(); },
        [Symbol.asyncIterator]() { return { next: () => output.next() }; },
      };
    } },
  });
  f.generate = (thinking, extra = {}) => f.host.generateModelOnly({ model, prompt: "Synthetic amber telescope",
    operationId: "cli-transport-fixture", execution: { thinking }, assertCurrent() {
      if (!f.valid) throw Object.assign(new Error("Source withdrawn"), { code: "SOURCE_REVOKED" });
    }, ...extra });
  f.cleanup = () => {
    for (const worker of f.workers) assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null);
    assert.equal(f.host.controlProcesses.size, 0); assert.equal(f.host.controlQueries.size, 0);
    try {
      for (const worker of f.workers) {
        // Electron Node emits this macOS host diagnostic before fixture code.
        // Preserve strict failure for every other stderr byte, including any
        // synthetic protocol error; ordinary Node permits no diagnostic.
        const stderr = process.versions.electron ? (worker.stderr || "").replace(
          /^\[\d{4}\/\d{6}\.\d{6}:ERROR:electron\/shell\/common\/mac\/codesign_util\.cc:79\] task_name_for_pid: \(os\/kern\) failure \(5\)\n/gmu, "") : worker.stderr || "";
        assert.equal(stderr, "");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  return f;
}

if (process.argv[2] === "--synthetic-cli") childMain();
else {
  test("upstream CLI budget plans preserve ranked choices without claiming native capabilities or output caps", () => {
    const settings = project({ applied: { model: LEGACY }, effective: { alwaysThinkingEnabled: true } });
    for (const row of [{ value: LEGACY }, { value: "legacy-alias", resolvedModel: LEGACY },
      { value: LEGACY, supportsEffort: false, maxOutputTokens: 8, supportsManualThinking: true }]) {
      const model = describe(settings, [row], LEGACY);
      assert.deepEqual(model.capabilities.thinkingOptions, ["off"]);
      assert.equal(model.maxOutputTokens, undefined);
      for (const [thinking, budget] of [["off", 0], ["minimal", 1024], ["low", 2048], ["medium", 8192],
        ["high", 16384], ["xhigh", 16384], ["max", 16384], ["adaptive", 8192]]) {
        const planned = plan({ thinking }, LEGACY);
        assert.equal(planned.thinkingBudgetRequested, budget);
        assert.equal(planned.thinkingBudgetApplied, undefined);
        assert.ok(Object.isFrozen(planned) && Object.isFrozen(planned.thinkingEnv));
        assert.deepEqual(planned.thinkingEnv, core.resolveClaudeMemoryCliThinkingEnv(budget === 0 ? "off" :
          { 1024: "minimal", 2048: "low", 8192: "medium", 16384: "high" }[budget], LEGACY));
        assert.deepEqual(resolve({ thinking }, model), { thinkingEnabled: budget !== 0, thinkingBudgetRequested: budget });
      }
    }
    assert.throws(() => describe(settings, [{ value: LEGACY, supportsEffort: "false" }], LEGACY), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
  });

  test("each legacy request is bound to actual stdio worker environment and its control before the only prompt", async () => {
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"]) {
      const f = fixture({ poisonSdkEnv: true });
      try {
        const result = await f.generate(thinking), expected = plan({ thinking }, LEGACY), worker = f.workers[1];
        assert.equal(result.text, "Amber"); assert.equal(result.thinkingBudgetRequested, undefined);
        assert.equal(result.thinkingBudgetApplied, undefined);
        assert.deepEqual(worker.initialized.transportEnv, expected.thinkingEnv);
        assert.equal(worker.initialized.networkAttempts, 0);
        assert.equal(worker.env.UNTRUSTED_ENV, undefined);
        assert.equal(worker.wire.find(row => row.subtype === "set_max_thinking_tokens").max_thinking_tokens, expected.thinkingBudgetRequested);
        assert.deepEqual(worker.wire.map(row => row.subtype), ["initialize", "get_settings", "apply_flag_settings", "set_max_thinking_tokens", "get_settings"]);
        assert.equal(worker.prompts.length, 1); assert.equal(f.workers.length, 2);
        assert.equal(f.workers[0].prompts.length, 0); assert.deepEqual(f.workers[0].initialized.transportEnv, {});
      } finally { f.cleanup(); }
    }
  });

  test("native adaptive effort uses its existing controls and ignores SDK-injected manual environment values", async () => {
    const f = fixture({ model: NATIVE, native: true, poisonSdkEnv: true });
    try {
      await f.generate("max"); const worker = f.workers[0];
      assert.deepEqual(worker.initialized.transportEnv, {});
      assert.equal(worker.wire.find(row => row.subtype === "set_max_thinking_tokens").max_thinking_tokens, null);
      assert.deepEqual(worker.wire.find(row => row.subtype === "apply_flag_settings").settings, { alwaysThinkingEnabled: true, effortLevel: "max" });
      assert.equal(f.workers.length, 1); assert.equal(worker.prompts.length, 1);
    } finally { f.cleanup(); }
  });

  test("a generic profile with actual native effort metadata retains one process and no manual budget", async () => {
    const f = fixture({ native: true, adaptive: false, poisonSdkEnv: true });
    try {
      await f.generate("high"); const worker = f.workers[0];
      assert.deepEqual(worker.initialized.transportEnv, {});
      assert.equal(worker.wire.find(row => row.subtype === "set_max_thinking_tokens").max_thinking_tokens, null);
      assert.deepEqual(worker.wire.find(row => row.subtype === "apply_flag_settings").settings, { alwaysThinkingEnabled: true, effortLevel: "high" });
      assert.equal(f.workers.length, 1); assert.equal(worker.prompts.length, 1);
    } finally { f.cleanup(); }
  });

  test("an unfixed legacy default is discovered without prompting and retired before the bound generation process", async () => {
    const f = fixture();
    try {
      await f.generate("high", { model: null });
      assert.equal(f.workers.length, 2);
      assert.deepEqual(f.workers[0].wire.map(row => row.subtype), ["initialize", "get_settings"]);
      assert.equal(f.workers[0].prompts.length, 0); assert.deepEqual(f.workers[0].initialized.transportEnv, {});
      assert.equal(f.requests[1].options.model, LEGACY);
      assert.deepEqual(f.workers[1].initialized.transportEnv, plan({ thinking: "high" }, LEGACY).thinkingEnv);
      assert.equal(f.workers[1].prompts.length, 1);
    } finally { f.cleanup(); }
  });

  test("an unfixed native default retains one process and no manual budget projection", async () => {
    const f = fixture({ model: NATIVE, native: true });
    try { await f.generate("high", { model: null }); assert.equal(f.workers.length, 1); assert.equal(f.workers[0].prompts.length, 1); }
    finally { f.cleanup(); }
  });

  test("source withdrawal or cancellation at each legacy control retires the worker without prompting", async () => {
    for (const stage of ["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens", "receipt"]) {
      const workers = ["getSettings", "supportedModels"].includes(stage) ? [0, 1] : [1];
      for (const selectedWorker of workers) for (const canceled of [false, true]) {
        const controller = new AbortController();
        const f = fixture({ hook(method, ordinal, worker) {
          if (ordinal === selectedWorker && (stage === "receipt" ? method === "getSettings"
            && worker.wire.some(row => row.subtype === "apply_flag_settings") : stage === method)) {
            f.valid = false; if (canceled) controller.abort();
          }
        } });
        try {
          await assert.rejects(f.generate("high", { signal: controller.signal }), { code: canceled ? "MODEL_ONLY_CANCELED" : "SOURCE_REVOKED" });
          for (const worker of f.workers) assert.equal(worker.prompts.length, 0);
        } finally { f.cleanup(); }
      }
    }
  });

  test("withdrawing the source or canceling during default discovery retirement prevents a second process", async () => {
    for (const canceled of [false, true]) {
      const controller = new AbortController();
      const f = fixture({ closing() { f.valid = false; if (canceled) controller.abort(); } });
      try {
        await assert.rejects(f.generate("high", { model: null, signal: controller.signal }),
          { code: canceled ? "MODEL_ONLY_CANCELED" : "SOURCE_REVOKED" });
        assert.equal(f.workers.length, 1); assert.equal(f.workers[0].prompts.length, 0);
      } finally { f.cleanup(); }
    }
  });

  test("changed model identity or native controls in the bound worker rejects positive and zero budgets before any prompt", async () => {
    for (const thinking of ["off", "high"]) {
      for (const changed of [{ model: "claude-haiku-4-5" }, { native: true, adaptive: false }]) {
        const f = fixture({ workerConfig: ordinal => ordinal === 1 ? changed : {} });
        try {
          await assert.rejects(f.generate(thinking, { model: null }), { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" });
          assert.equal(f.workers.length, 2);
          assert.equal(f.workers[1].initialized.transportEnv.MAX_THINKING_TOKENS, thinking === "off" ? "0" : "16384");
          for (const worker of f.workers) assert.equal(worker.prompts.length, 0);
        } finally { f.cleanup(); }
      }
    }
  });
}
