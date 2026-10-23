"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { RuntimeInstructionState, instructionRenewal } = require("../app/agent-service/runtime-instruction-state");
const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { instructionDelivery, systemInstructions } = require("../app/agent-service/native-instruction-delivery");
const { PiRuntimeHost } = require("../app/agent-service/pi-runtime-host");
const { GrokBuildRuntimeHost } = require("../app/agent-service/grok-build-runtime-host");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");

const RUNTIMES = ["codex", "pi", "grok-build", "claude-code", "deepseek-harness", "opencode", "antigravity"];

for (const runtime of RUNTIMES) test(`${runtime}: stable policy is unchanged across Runs and work sources`, () => {
  const f = contextFixture({ runtime });
  try {
    const common = { profile: f.profile, transcriptSessionId: f.transcriptSessionId,
      contextLifecycleV1: true, query: "ordinary task" };
    const first = f.compiler.compile({ ...common, run: f.run });
    const second = f.compiler.compile({ ...common, run: { ...f.run,
      id: "another-run", source: "cron", sourceId: "another-source" } });
    assert.equal(first.stableDeveloperInstructions, second.stableDeveloperInstructions);
    assert.ok(first.stableDeveloperInstructions.length > 1000);
    assert.doesNotMatch(first.stableDeveloperInstructions, /Frozen permission context:|Trusted current work source:|run-1/u);
    assert.match(second.turnDeveloperInstructions, /another-run/u);
    assert.match(second.turnDeveloperInstructions, /another-source/u);
    assert.doesNotMatch(second.turnDeveloperInstructions, /run-1/u);
    assert.match(first.stableDeveloperInstructions, /app_help_search|memory_search/u);
    assert.match(first.stableDeveloperInstructions, /SHOGGOTH AGENT DEFINITION/u);
    assert.equal(first.report.instructionDelivery.stableHash, second.report.instructionDelivery.stableHash);
    assert.equal(first.report.instructionDelivery.measurement, "utf8_bytes");
    assert.equal(first.report.instructionDelivery.mode, instructionDelivery(runtime));
    assert.equal(first.report.instructionDelivery.stableBytes, Buffer.byteLength(first.stableDeveloperInstructions));
    assert.match(first.developerInstructions, /Frozen permission context:/u,
      "immutable legacy projection retains the original complete evidence");
  } finally { f.cleanup(); }
});

test("changed Agent rules remain complete and change the stable policy hash", () => {
  const f = contextFixture();
  try {
    const input = { profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId };
    const before = f.compiler.compile(input);
    const definition = f.definitions.get(f.profile.id);
    f.definitions.update({ profileId: f.profile.id, expectedRevision: definition.manifest.revision,
      actor: "user", reason: "instruction-change", documents: { AGENTS: "# Rules\nPreserve the exact long-tail requirement XYZ." } });
    const after = f.compiler.compile(input);
    assert.notEqual(before.report.instructionDelivery.stableHash, after.report.instructionDelivery.stableHash);
    assert.match(after.stableDeveloperInstructions, /Preserve the exact long-tail requirement XYZ\./u);
  } finally { f.cleanup(); }
});

test("a selected Skill is complete in the current turn and does not churn session policy", () => {
  const skill = { id: "rare-skill", name: "rare-skill", version: "1.0.0", source: "user",
    description: "A rare workflow", contentHash: "a".repeat(64) };
  const f = contextFixture({ skillStore: {
    catalog: () => ({ registryRevision: "b".repeat(64), profileRevision: 1, items: [skill], ineligible: [] }),
    select: (_id, query) => ({ registryRevision: "b".repeat(64), profileRevision: 1,
      items: [skill], ineligible: [], selected: query.includes("$rare-skill") ? [skill] : [] }),
    read: () => ({ ...skill, content: "# Rare workflow\nDo every specialized step; do not omit the last requirement." }),
  }, runtimeCapabilitiesForProfile: () => ["mcp"] });
  try {
    const input = { profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId };
    const plain = f.compiler.compile({ ...input, query: "ordinary" });
    const selected = f.compiler.compile({ ...input, query: "$rare-skill" });
    assert.equal(plain.stableDeveloperInstructions, selected.stableDeveloperInstructions);
    assert.match(selected.turnDeveloperInstructions, /do not omit the last requirement/u);
    assert.equal(selected.report.selectedSkillRefs[0].contentHash, skill.contentHash);
    assert.match(selected.dynamicContext, /skill_catalog/u, "full Skill discovery remains available");
  } finally { f.cleanup(); }
});

test("request-system runtimes retain instructions outside native user-message history", () => {
  const host = Object.create(PiRuntimeHost.prototype);
  host.sessionConfigs = new Map([["s", { developerInstructions: "STABLE_POLICY" }]]);
  host.commandCatalog = [];
  const prompt = host._promptText("s", { prompt: "actual user request", context: "UNTRUSTED_MEMORY",
    turnDeveloperInstructions: "CURRENT_RUN_RULES" });
  assert.doesNotMatch(prompt, /STABLE_POLICY|CURRENT_RUN_RULES/u);
  assert.match(prompt, /UNTRUSTED_MEMORY/u);
  assert.match(prompt, /actual user request/u);
  assert.equal(systemInstructions("STABLE_POLICY", "CURRENT_RUN_RULES"), "STABLE_POLICY\n\nCURRENT_RUN_RULES");
});

test("ACP fallback keeps complete policy and turn rules when no system replacement is proven", () => {
  for (const Host of [GrokBuildRuntimeHost, AntigravityAcpRuntimeHost]) {
    const host = Object.create(Host.prototype);
    host.sessionConfigs = new Map([["s", { developerInstructions: "STABLE_POLICY" }]]);
    host.commandCatalogs = new Map([["s", []]]);
    const prompt = host._promptText("s", { prompt: "actual user request", context: "UNTRUSTED_MEMORY",
      turnDeveloperInstructions: "CURRENT_RUN_RULES" });
    assert.match(prompt, /STABLE_POLICY/u);
    assert.match(prompt, /CURRENT_RUN_RULES/u);
    assert.match(prompt, /UNTRUSTED_MEMORY/u);
  }
  assert.equal(instructionDelivery("a-future-runtime"), "prompt_fallback");
});

test("native system-rule receipts survive restart, isolate accounts, and reject corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-instruction-state-"));
  fs.chmodSync(root, 0o700);
  try {
    const options = { directory: path.join(root, "private"), trustedRoot: root,
      binding: { runtime: "grok-build", runtimeProfileId: "profile-1", runtimeAccountId: "account-a" } };
    const first = new RuntimeInstructionState(options);
    first.record("native-session", "complete policy");
    const restarted = new RuntimeInstructionState(options);
    assert.equal(restarted.matches("native-session", "complete policy"), true);
    assert.equal(restarted.matches("native-session", "updated policy"), false);
    assert.equal(restarted.has("a-different-session"), false);
    const other = new RuntimeInstructionState({ ...options,
      binding: { ...options.binding, runtimeAccountId: "account-b" } });
    assert.equal(other.has("native-session"), false);
    fs.writeFileSync(first.target, fs.readFileSync(first.target, "utf8").replace('"version":1', '"version":2'));
    assert.throws(() => restarted.matches("native-session", "complete policy"), { code: "RUNTIME_INSTRUCTION_STATE_INVALID" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("renewal accepts only a definite pre-prompt rejection and never reads hostile getters", () => {
  const failure = Object.assign(new Error("policy changed"), {
    code: "RUNTIME_SESSION_INSTRUCTIONS_CHANGED", acceptance: "not_sent", sessionId: "native-session" });
  assert.deepEqual(instructionRenewal({ cause: failure }), { sessionId: "native-session" });
  assert.equal(instructionRenewal({ ...failure, acceptance: "unknown" }), null);
  assert.equal(instructionRenewal({ get code() { throw new Error("hostile getter"); } }), null);
});

test("Grok skips the full prompt policy only with an exact persisted native-system receipt", () => {
  const host = Object.create(GrokBuildRuntimeHost.prototype);
  host.nativeRulesSupported = true;
  host.instructionState = { has: () => true, matches: (_id, policy) => policy === "STABLE_POLICY" };
  host.sessionConfigs = new Map([["s", { developerInstructions: "STABLE_POLICY", nativeRules: true }]]);
  host.commandCatalogs = new Map([["s", []]]);
  assert.equal(host._nativeRules("s", "STABLE_POLICY"), true);
  assert.throws(() => host._nativeRules("s", "CHANGED_POLICY"), { code: "RUNTIME_SESSION_INSTRUCTIONS_CHANGED", acceptance: "not_sent" });
  const prompt = host._promptText("s", { prompt: "actual user request", context: "MEMORY",
    turnDeveloperInstructions: "CURRENT_RUN_RULES" });
  assert.doesNotMatch(prompt, /STABLE_POLICY/u);
  assert.match(prompt, /CURRENT_RUN_RULES/u);
  host.instructionState = { has: () => false };
  assert.equal(host._nativeRules("legacy", "STABLE_POLICY"), false);
});

test("Codex appends only current Run data when unchanged session policy is resumed", async () => {
  const injected = [], requests = [];
  const host = {
    threadStart: async input => ({ thread: { id: "s", threadSource: input.threadSource } }),
    threadResume: async input => ({ thread: { id: input.threadId } }),
    threadInjectItems: async input => { injected.push(input); },
    turnStart: async input => { requests.push(input); return { turn: { id: `t-${requests.length}` } }; },
  };
  const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
  const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire({
    runtime: "codex", runtimeProfileId: "profile", runtimeAccountId: "account" });
  await handle.sessionStart({ source: "chat", developerInstructions: "FULL_STABLE_POLICY" });
  for (const n of [1, 2]) {
    await handle.sessionResume({ sessionId: "s", developerInstructions: "FULL_STABLE_POLICY" });
    await handle.turnStart({ sessionId: "s", operationId: `op-${n}`, prompt: `user-${n}`,
      turnDeveloperInstructions: `CURRENT_RUN_${n}` });
  }
  assert.equal(injected.length, 2);
  assert.deepEqual(injected.map(value => value.items[0].role), ["developer", "developer"]);
  assert.deepEqual(injected.map(value => value.items[0].content[0].text), ["CURRENT_RUN_1", "CURRENT_RUN_2"]);
  assert.deepEqual(requests.map(value => value.input[0].text), ["user-1", "user-2"]);
});

test("DeepSeek combines stable and current-Run instructions in one registered complete prompt", async () => {
  const { BridgeRuntime } = await import("../resources/deepseek-harness/shoggoth-dsh-bridge.mjs");
  const sections = new Map([["native:core", "NATIVE_CORE_WITH_ALL_TOOLS"]]);
  const ctx = {
    agents: { create: async options => {
      options.setup({ systemPrompt: { section: value => {
        assert.equal(sections.has(value.name), false, "native DSH rejects duplicate registration");
        sections.set(value.name, value);
      } } });
      return { agent: { session: {} } };
    } }, permissionPresets: { set: async () => {} },
  };
  const bridge = new BridgeRuntime(ctx);
  await bridge.createHandle({ remoteSessionId: "s", cwd: "/tmp", developerInstructions: "COMPLETE_STABLE_POLICY",
    selection: { provider: "fixture", model: "fixture" }, permissionMode: "read-only" }, false);
  bridge.commandTurnStart = async () => ({ turnId: "command" });
  for (const text of ["CURRENT_RUN_1", "CURRENT_RUN_2", ""]) {
    await bridge.turnStart({ remoteSessionId: "s", sessionId: "public", turnId: "t", operationId: "op",
      prompt: "/fixture-command", turnDeveloperInstructions: text });
    assert.equal(sections.get("shoggoth:developer-instructions").text(),
      systemInstructions("COMPLETE_STABLE_POLICY", text));
  }
  assert.equal(sections.get("native:core"), "NATIVE_CORE_WITH_ALL_TOOLS");
  assert.equal(sections.get("shoggoth:developer-instructions").complete, true);
  assert.equal(sections.size, 2);
});

test("the request budget adds appended instructions to native occupancy without double-counting request-system policy", () => {
  const { requestBudget } = require("../app/agent-service/context-request-budget");
  const { historyInstructions } = require("../app/agent-service/native-instruction-delivery");
  const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
  const stable = "complete stable rules ".repeat(2000), turn = "current run rules";
  const options = { budget: { tokens: 100000, triggerTokens: 80000 }, developerInstructions: stable + turn,
    nativeUsage: { usedTokens: 60000 }, fresh: false, prompt: "continue" };
  const system = requestBudget({ ...options, appendedInstructions: historyInstructions("pi", stable, turn) });
  const append = requestBudget({ ...options, appendedInstructions: historyInstructions("antigravity", stable, turn) });
  assert.equal(append.estimatedTokens - system.estimatedTokens, estimateContextTokens(systemInstructions(stable, turn)));
  assert.equal(requestBudget({ ...options, fresh: true, appendedInstructions: stable }).estimatedTokens,
    requestBudget({ ...options, fresh: true }).estimatedTokens, "a first request counts the full policy exactly once");
});

// --- Turn rules stay out of per-turn churn; unchanged prompt blocks are not repeated ---
const delivery = require("../app/agent-service/native-instruction-delivery");
const RULES = "Current Shoggoth Run data supersedes older Run data.\n\nFrozen permission context: {\"source\":\"chat\"}";
const runTurn = runId => `${RULES}\n\n${delivery.runIdInstruction(runId)}`;

test("the Run ID paragraph splits from rules that stay identical across turns", () => {
  const first = delivery.splitTurnInstructions(runTurn("run-1"));
  const second = delivery.splitTurnInstructions(runTurn("run-2"));
  assert.equal(first.rules, RULES);
  assert.equal(first.rules, second.rules, "only the Run ID changes between turns");
  assert.equal(second.run, "Current Shoggoth Run ID: run-2");
  assert.deepEqual(delivery.splitTurnInstructions("LEGACY with run-1 inside"), { rules: "LEGACY with run-1 inside", run: "" },
    "persisted legacy turn text keeps its complete rules");
  assert.deepEqual(delivery.splitTurnInstructions(""), { rules: "", run: "" });
});

test("compiled turn rules keep the Run ID only in its own paragraph", () => {
  const f = contextFixture({ runtime: "claude-code" });
  try {
    const compiled = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      contextLifecycleV1: true, query: "ordinary task" });
    const turn = delivery.splitTurnInstructions(compiled.turnDeveloperInstructions);
    assert.equal(turn.run, "Current Shoggoth Run ID: run-1");
    assert.doesNotMatch(turn.rules, /run-1/u);
    assert.match(turn.rules, /Frozen permission context: \{"source":"chat"/u);
    assert.match(compiled.developerInstructions, /"runId":"run-1"/u, "the legacy projection keeps the full record");
  } finally { f.cleanup(); }
});

test("prompt blocks repeat only when undelivered, changed, refreshed or reset", () => {
  const ledger = new delivery.PromptBlockLedger();
  const blocks = { stable: "STABLE", rules: "RULES", context: "MEMORY" };
  const first = ledger.plan("s", blocks);
  assert.deepEqual(Object.keys(first.send), ["stable", "rules", "context"]);
  assert.deepEqual(Object.keys(ledger.plan("s", blocks).send), ["stable", "rules", "context"],
    "a send that was never accepted is repeated");
  first.commit(); first.commit();
  const unchanged = ledger.plan("s", blocks);
  assert.deepEqual(unchanged.send, {});
  assert.deepEqual(unchanged.omitted, ["stable", "rules", "context"]);
  unchanged.commit();
  const changed = ledger.plan("s", { ...blocks, context: "NEW MEMORY" });
  assert.deepEqual(changed.send, { context: "NEW MEMORY" });
  changed.commit();
  assert.deepEqual(Object.keys(ledger.plan("other", blocks).send), ["stable", "rules", "context"], "sessions are independent");
  // stable/rules were last sent on turn 0 and the new memory on turn 2; turns 3.. omit them.
  for (let turn = 3; turn < delivery.PROMPT_BLOCK_REFRESH_TURNS; turn++) {
    assert.deepEqual(ledger.plan("s", { ...blocks, context: "NEW MEMORY" }).send, {});
    ledger.plan("s", { ...blocks, context: "NEW MEMORY" }).commit();
  }
  assert.deepEqual(Object.keys(ledger.plan("s", { ...blocks, context: "NEW MEMORY" }).send), ["stable", "rules"],
    "blocks unsent for PROMPT_BLOCK_REFRESH_TURNS turns are refreshed");
  ledger.reset("s");
  assert.deepEqual(Object.keys(ledger.plan("s", blocks).send), ["stable", "rules", "context"]);
});

test("ACP prompt-only runtimes send unchanged policy once and the Run ID every turn", () => {
  for (const Host of [AntigravityAcpRuntimeHost, GrokBuildRuntimeHost]) {
    const host = Object.create(Host.prototype);
    host.promptLedger = new delivery.PromptBlockLedger();
    host.sessionConfigs = new Map([["s", { developerInstructions: "STABLE_POLICY" }]]);
    host.commandCatalogs = new Map([["s", []]]);
    const input = runId => ({ prompt: `request ${runId}`, context: "UNTRUSTED_MEMORY", turnDeveloperInstructions: runTurn(runId) });
    const first = host._promptParts("s", input("run-1"));
    for (const expected of [/STABLE_POLICY/u, /Frozen permission context/u, /UNTRUSTED_MEMORY/u, /Run ID: run-1/u, /request run-1/u]) {
      assert.match(first.text, expected, Host.name);
    }
    assert.doesNotMatch(host._promptParts("s", input("run-2")).text.replace(/request run-2/u, ""), /SHOGGOTH CONTEXT UNCHANGED/u,
      `${Host.name}: nothing is omitted before the Runtime accepted the first turn`);
    first.commit();
    const second = host._promptParts("s", input("run-2"));
    assert.doesNotMatch(second.text, /STABLE_POLICY|Frozen permission context|UNTRUSTED_MEMORY/u, Host.name);
    assert.match(second.text, /SHOGGOTH CONTEXT UNCHANGED/u);
    assert.match(second.text, /Run ID: run-2[\s\S]*CURRENT USER REQUEST\nrequest run-2$/u);
    host.sessionConfigs.set("renewed", { developerInstructions: "STABLE_POLICY" });
    host.commandCatalogs.set("renewed", []);
    const restored = host._promptParts("renewed", input("run-3"));
    for (const text of ["STABLE_POLICY", "Frozen permission context", "UNTRUSTED_MEMORY", "Run ID: run-3", "request run-3"]) {
      assert.equal(restored.text.split(text).length - 1, 1, `${Host.name}: fresh session resends ${text} once`);
    }
    restored.commit();
    const subsequent = host._promptParts("renewed", input("run-4"));
    assert.doesNotMatch(subsequent.text, /STABLE_POLICY|Frozen permission context|UNTRUSTED_MEMORY/u);
    assert.match(subsequent.text, /Run ID: run-4/u);
  }
});

test("system-prompt runtimes move only the Run ID into the user message and deduplicate memory there", () => {
  const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
  for (const Host of [ClaudeCodeRuntimeHost, PiRuntimeHost]) {
    const host = Object.create(Host.prototype);
    host.promptLedger = new delivery.PromptBlockLedger();
    host.commandCatalog = [];
    const input = runId => ({ prompt: "ask", context: "UNTRUSTED_MEMORY", turnDeveloperInstructions: runTurn(runId) });
    const first = host._promptParts("s", input("run-1"));
    assert.match(first.text, /UNTRUSTED_MEMORY\n\nCurrent Shoggoth Run ID: run-1\n\nCURRENT USER REQUEST\nask$/u, Host.name);
    assert.doesNotMatch(first.text, /Frozen permission context/u, `${Host.name}: rules stay in the system prompt`);
    first.commit();
    const second = host._promptParts("s", input("run-2"));
    assert.doesNotMatch(second.text, /UNTRUSTED_MEMORY/u);
    assert.match(second.text, /Run ID: run-2/u);
  }
});

test("DeepSeek keeps the Run ID out of its system section and injects unchanged memory once", async () => {
  const { DeepSeekHarnessRuntimeHost } = require("../app/agent-service/deepseek-harness-runtime-host");
  const host = Object.create(DeepSeekHarnessRuntimeHost.prototype);
  const sent = [];
  host.promptLedger = new delivery.PromptBlockLedger();
  host.process = { request: async (_method, params) => { sent.push(params); } };
  host._acceptActive = active => active.promptCommit();
  for (const runId of ["run-1", "run-2"]) {
    await host._beginTurn({ sessionId: "s", remoteSessionId: "r", turnId: runId, operationId: runId },
      { prompt: "ask", context: "UNTRUSTED_MEMORY", turnDeveloperInstructions: runTurn(runId) });
  }
  assert.deepEqual(sent.map(params => params.turnDeveloperInstructions), [RULES, RULES]);
  assert.match(sent[0].context, /UNTRUSTED_MEMORY\n\nCurrent Shoggoth Run ID: run-1$/u);
  assert.doesNotMatch(sent[1].context, /UNTRUSTED_MEMORY/u);
  assert.match(sent[1].context, /Run ID: run-2$/u);
});

test("Codex injects unchanged Run rules and context once, and again after compaction", async () => {
  const injected = [];
  let emit = null;
  const host = {
    threadStart: async () => ({ thread: { id: "s" } }),
    threadInjectItems: async input => { injected.push(input.items[0]); },
    turnStart: async () => ({ turn: { id: "t" } }),
    subscribe: listener => { emit = listener; return () => {}; },
  };
  const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
  const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire({
    runtime: "codex", runtimeProfileId: "profile", runtimeAccountId: "account" });
  handle.subscribe(() => {});
  const turn = async runId => {
    injected.length = 0;
    await handle.turnStart({ sessionId: "s", operationId: runId, prompt: "ask", context: "UNTRUSTED_MEMORY",
      turnDeveloperInstructions: runTurn(runId) });
    return injected.map(item => `${item.role}:${item.content[0].text}`);
  };
  const first = await turn("run-1");
  assert.equal(first.length, 2);
  assert.match(first[0], /^developer:Current Shoggoth Run data[\s\S]*Run ID: run-1$/u);
  assert.equal(first[1], "user:UNTRUSTED_MEMORY");
  const second = await turn("run-2");
  assert.equal(second.length, 1, "unchanged context is not injected again");
  assert.match(second[0], /^developer:SHOGGOTH CONTEXT UNCHANGED[\s\S]*Run ID: run-2$/u);
  assert.doesNotMatch(second[0], /Frozen permission context/u);
  emit({ known: true, type: "context_compacted", threadId: "s" });
  const third = await turn("run-3");
  assert.equal(third.length, 2, "compaction may drop earlier items, so they are injected again");
  assert.match(third[0], /Frozen permission context[\s\S]*Run ID: run-3$/u);
});
