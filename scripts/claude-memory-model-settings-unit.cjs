"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
const { CLAUDE_CODE_CAPABILITIES } = require("../app/agent-service/claude-code-runtime-adapter");
const { projectClaudeMemorySettings: project, describeClaudeMemoryModel: describe,
  resolveClaudeMemoryExecution: resolve } = require("../app/agent-service/claude-memory-model-settings");

const model = "claude-opus-4-6", input = { model, prompt: "Recall the amber telescope", operationId: "claude-memory-settings" };
const metadata = (id = model) => ({ value: id, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"],
  supportsAdaptiveThinking: true, supportsFastMode: true });
const selection = (id = model) => ({ applied: { model: id, effort: "high" }, effective: { alwaysThinkingEnabled: true, fastMode: false },
  model: "decoy-model", env: { KEY: "never-output-this-secret" } });
const unavailable = { code: "MODEL_ONLY_SETTINGS_UNAVAILABLE" };

test("Claude settings project only applied identity and minimal effective flags", () => {
  const result = project(selection());
  assert.deepEqual(result, { model, effort: "high", thinkingEnabled: true, fastMode: false });
  assert.ok(Object.isFrozen(result));
  for (const value of [{}, { applied: { model: "bad\nmodel" } }, { ...selection(), applied: { model, effort: "ultra" } },
    { ...selection(), effective: { fastMode: "auto" } }, { ...selection(), effective: { alwaysThinkingEnabled: 1 } }]) {
    assert.throws(() => project(value), unavailable);
  }
});

test("Claude native profiles intersect SDK metadata and preserve mandatory thinking", () => {
  assert.equal(CLAUDE_CODE_CAPABILITIES["model.generate.settings"], true);
  for (const [id, thinking, expected] of [
    [model, "off", { thinkingEnabled: false }],
    [model, "minimal", { thinkingEnabled: true, effort: "low" }],
    [model, "max", { thinkingEnabled: true, effort: "max" }],
    [model, "adaptive", { thinkingEnabled: true }],
    ["claude-opus-5-5", "off", { thinkingEnabled: true, effort: "low" }],
    ["claude-sonnet-5-5", "adaptive", { thinkingEnabled: true, effort: "high" }],
  ]) assert.deepEqual(resolve({ thinking }, describe(project(selection(id)), [metadata(id)], id)), expected);
  const legacy = describe(project(selection("claude-sonnet-4-5")), [{ value: "claude-sonnet-4-5", supportsEffort: false }], null);
  assert.deepEqual(resolve({ thinking: "off" }, legacy), { thinkingEnabled: false, thinkingBudgetRequested: 0 });
  assert.deepEqual(resolve({ thinking: "high" }, legacy), { thinkingEnabled: true, thinkingBudgetRequested: 16384 });
  assert.deepEqual(legacy.capabilities.thinkingOptions, ["off"], "CLI budget requests do not invent native SDK capabilities");
  const noFast = describe(project(selection()), [{ ...metadata(), supportsFastMode: false }], model);
  assert.throws(() => resolve({ thinking: "low", fastMode: true }, noFast), unavailable);
});

test("Claude catalog aliases attest canonical metadata but cannot bypass Product alias resolution", () => {
  const alias = { ...metadata(), value: "opus", resolvedModel: model };
  assert.equal(describe(project(selection()), [alias], model).model, model);
  assert.equal(describe(project(selection()), [alias], null).model, model);
  assert.throws(() => describe(project(selection()), [alias], "opus"), unavailable);
  assert.throws(() => describe(project(selection()), [{ ...alias, resolvedModel: "different" }], "opus"), unavailable);
  assert.throws(() => describe(project(selection()), [alias], "unlisted"), unavailable);
  const other = { ...alias, value: "another", supportedEffortLevels: ["low"] };
  assert.throws(() => describe(project(selection()), [alias, other], null), unavailable);
  assert.ok(describe(project(selection()), [metadata(), alias, other], model));
  for (const catalog of [[], [metadata("other")], [{ value: model }], [{ ...metadata(), supportsEffort: "true" }],
    [{ ...metadata(), supportedEffortLevels: ["unknown"] }], [{ ...metadata(), supportedEffortLevels: ["high", "high"] }],
    [{ ...metadata(), supportsAdaptiveThinking: "true" }], [{ ...metadata(), supportsFastMode: 1 }]]) {
    assert.throws(() => describe(project(selection()), catalog, model), unavailable);
  }
});

class Child extends EventEmitter {
  constructor(mode) {
    super(); Object.assign(this, { pid: 20_001, mode, signals: [], exited: false, scheduled: false });
    this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
  }
  kill(signal) {
    this.signals.push(signal);
    if (this.mode === "stuck" || this.exited || this.scheduled) return true;
    this.scheduled = true;
    setTimeout(() => { this.exited = true; this.emit("exit", null, signal); this.emit("close", null, signal); }, 5);
    return true;
  }
}

function fixture({ id = model, mode } = {}) {
  const f = { settings: selection(id), catalog: [metadata(id)], calls: [], prompts: [], closed: false, hook: () => {},
    result: { type: "result", subtype: "success", result: "Amber", modelUsage: { [id]: {} } }, children: [] };
  f.host = Object.assign(Object.create(ClaudeCodeRuntimeHost.prototype), {
    state: "ready", fs, binaryPath: fs.realpathSync(process.execPath), userHome: "/private/tmp",
    controlProcesses: new Map(), controlProcessGroups: new WeakSet(), controlQueries: new Set(),
    cleanupIncomplete: false, killGraceMs: 20, shutdownGraceMs: 20,
    activeTurns: new Map(), resolveTerminated() {},
    _spawnEnvironment: () => ({ HOME: "/private/tmp" }),
    spawnProcess() { const child = new Child(mode); f.children.push(child); return child; },
    killProcessGroup(pid, signal) { f.children.find(child => child.pid === pid).kill(signal); },
    sdk: { query(request) {
      f.request = request;
      const child = request.options.spawnClaudeCodeProcess({ command: f.host.binaryPath, args: ["--fixture"],
        cwd: request.options.cwd, env: request.options.env });
      // The real SDK consumes the stream from query construction, before the
      // caller begins iterating output. This detects premature prompt release.
      const first = request.prompt.next().then(next => {
        if (!next.done) { f.prompts.push(next.value); f.calls.push(["prompt"]); }
        return next;
      });
      const control = async (method, params, action) => {
        f.calls.push([method, params]); await f.hook(method, params);
        return action?.();
      };
      return f.query = {
        getSettings: () => control("getSettings", undefined, () => structuredClone(f.settings)),
        supportedModels: () => control("supportedModels", undefined, () => structuredClone(f.catalog)),
        applyFlagSettings: flags => control("applyFlagSettings", flags, () => {
          Object.assign(f.settings.effective, flags);
          if (flags.effortLevel !== undefined) f.settings.applied.effort = flags.effortLevel;
        }),
        setMaxThinkingTokens: cap => control("setMaxThinkingTokens", cap),
        close() { f.closed = true; child.kill("SIGTERM"); },
        async *[Symbol.asyncIterator]() {
          await first;
          await f.hook("generate");
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Amber" } } };
          yield f.result;
        },
      };
    } },
  });
  f.generate = (execution, extra = {}) => f.host.generateModelOnly({ ...input, model: id, execution, ...extra });
  return f;
}

function assertClosed(f) {
  assert.ok(f.closed);
  assert.equal(f.host.controlQueries.size, 0);
  assert.equal(f.host.controlProcesses.size, 0);
  assert.equal(f.children[0].exited, true);
  assert.equal(f.request.options.abortController.signal.aborted, true);
  assert.throws(() => f.request.options.spawnClaudeCodeProcess({}), { code: "MODEL_ONLY_CANCELED" });
}

test("Claude verifies control receipts before releasing one tool-free memory prompt", async () => {
  const f = fixture();
  const result = await f.generate({ thinking: "max", fastMode: true });
  assert.equal(result.text, "Amber"); assert.equal(result.model, model);
  assert.deepEqual(f.calls.map(([method]) => method), ["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens", "getSettings", "prompt"]);
  assert.deepEqual(f.calls[2][1], { alwaysThinkingEnabled: true, effortLevel: "max", fastMode: true });
  assert.equal(f.calls[3][1], null);
  assert.equal(f.prompts.length, 1); assert.deepEqual(f.prompts[0].message.content, [{ type: "text", text: input.prompt }]);
  for (const key of ["tools", "allowedTools", "skills", "settingSources"]) assert.deepEqual(f.request.options[key], []);
  assert.deepEqual(f.request.options.mcpServers, {}); assert.equal(f.request.options.persistSession, false);
  assert.equal(f.request.options.strictMcpConfig, true); assert.equal(f.request.options.permissionMode, "dontAsk");
  assert.equal(f.request.options.cwd, "/private/tmp"); assertClosed(f);
});

test("Claude disables optional thinking but clamps off on a mandatory-thinking model", async () => {
  for (const id of [model, "claude-opus-5-5"]) {
    const f = fixture({ id }); await f.generate({ thinking: "off", fastMode: false });
    assert.deepEqual(f.calls[2][1], { alwaysThinkingEnabled: id !== model, fastMode: false,
      ...(id === model ? {} : { effortLevel: "low" }) });
    assert.equal(f.calls[3][1], id === model ? 0 : null); assertClosed(f);
  }
});

test("Claude auto speed is re-evaluated after controls and read back before prompting", async t => {
  let clock = 61_000; t.mock.method(Date, "now", () => clock);
  const f = fixture();
  f.hook = method => { if (method === "setMaxThinkingTokens") clock = 61_001; };
  await f.generate({ thinking: "low", fastMode: "auto", startedAtMs: 1000 });
  assert.deepEqual(f.calls.filter(([method]) => method === "applyFlagSettings").map(([, flags]) => flags), [
    { alwaysThinkingEnabled: true, effortLevel: "low", fastMode: true }, { fastMode: false },
  ]);
  assert.deepEqual(f.calls.slice(-3).map(([method]) => method), ["applyFlagSettings", "getSettings", "prompt"]);
  assertClosed(f);
});

test("Claude rejects unavailable controls, metadata and settings overridden by policy before prompting", async () => {
  for (const action of ["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens", "catalog", "alias", "fast", "effort", "thinking", "model"]) {
    const f = fixture();
    const original = f.host.sdk.query;
    if (["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens"].includes(action)) {
      f.host.sdk.query = request => { const query = original(request); delete query[action]; return query; };
    } else if (action === "catalog") f.catalog = [{ value: model }];
    else if (action === "alias") f.catalog = [{ ...metadata(), value: "opus", resolvedModel: model }];
    else f.hook = method => {
      if (method !== "getSettings" || !f.calls.some(([called]) => called === "applyFlagSettings")) return;
      if (action === "fast") f.settings.effective.fastMode = false;
      if (action === "thinking") f.settings.effective.alwaysThinkingEnabled = false;
      if (action === "effort") f.settings.applied.effort = "low";
      if (action === "model") f.settings.applied.model = "different";
    };
    await assert.rejects(f.generate({ thinking: "max", fastMode: true }, action === "alias" ? { model: "opus" } : {}), unavailable);
    assert.equal(f.prompts.length, 0, action); assertClosed(f);
  }
});

test("Claude drops raw SDK control errors and raw settings from failures", async () => {
  for (const stage of ["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens"]) {
    const f = fixture(); f.hook = method => { if (method === stage) throw new Error("never-output-this-secret"); };
    await assert.rejects(f.generate({ thinking: "low" }), error => {
      assert.equal(error.code, unavailable.code); assert.doesNotMatch(String(error.stack), /never-output-this-secret|decoy-model/); return true;
    });
    assert.equal(f.prompts.length, 0); assertClosed(f);
  }
});

test("Claude checks source authority and cancellation after every control boundary", async () => {
  for (const stage of ["getSettings", "supportedModels", "applyFlagSettings", "setMaxThinkingTokens", "receipt"]) {
    for (const canceled of [false, true]) {
      const f = fixture(), controller = new AbortController(); let valid = true;
      f.hook = method => {
        if (stage === "receipt" ? method === "getSettings" && f.calls.length > 1 : stage === method) {
          valid = false; if (canceled) controller.abort();
        }
      };
      await assert.rejects(f.generate({ thinking: "high" }, { signal: controller.signal,
        assertCurrent() { if (!valid) throw Object.assign(new Error("source changed"), { code: "SOURCE_REVOKED" }); },
      }), { code: canceled ? "MODEL_ONLY_CANCELED" : "SOURCE_REVOKED" });
      assert.equal(f.prompts.length, 0, `${stage}/${canceled}`); assertClosed(f);
    }
  }
});

test("Claude cancellation interrupts a hung SDK iterator and waits only for owned workers", async () => {
  const f = fixture(), controller = new AbortController(); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const other = new Child(); other.pid++; f.host._trackControlProcess(other);
  f.hook = method => { if (method === "generate") { entered(); return new Promise(() => {}); } };
  const pending = f.generate({ thinking: "high" }, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, { code: "MODEL_ONLY_CANCELED" });
  assert.equal(f.children[0].exited, true); assert.deepEqual(other.signals, []);
  assert.deepEqual([...f.host.controlProcesses.keys()], [other]);
  other.emit("exit", 0, null); assertClosed(f);
});

test("Claude settings cleanup failure retains the worker and overrides cancellation", async () => {
  const f = fixture({ mode: "stuck" }), controller = new AbortController();
  f.hook = method => { if (method === "supportedModels") controller.abort(); };
  await assert.rejects(f.generate({ thinking: "low" }, { signal: controller.signal }), { code: "RUNTIME_STOP_UNCONFIRMED" });
  assert.equal(f.prompts.length, 0); assert.ok(f.host.cleanupIncomplete);
  assert.equal(f.host.controlProcesses.size, 1); assert.ok(f.children[0].signals.includes("SIGKILL"));
  f.children[0].emit("exit", 0, null);
});

test("Claude rejects a result from a different model and revokes partial text", async () => {
  const f = fixture(), seen = []; f.result.modelUsage = { different: {} };
  await assert.rejects(f.generate({ thinking: "low" }, { onText: text => seen.push(text) }), { code: "RUNTIME_MODEL_CATALOG_CHANGED" });
  assert.deepEqual(seen, ["Amber", ""]); assertClosed(f);
});
