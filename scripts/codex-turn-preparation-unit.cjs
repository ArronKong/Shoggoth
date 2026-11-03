"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");

async function fixture() {
  const calls = [];
  let injectionFails = false, turnFails = false, catalogFails = false;
  const host = {
    terminated: new Promise(() => {}),
    threadResume: async input => ({ thread: { id: input.threadId } }),
    threadInjectItems: async input => {
      calls.push(["inject", structuredClone(input)]);
      if (injectionFails) throw new Error("fixture injection failed");
      return {};
    },
    modelList: async () => {
      calls.push(["models"]);
      if (catalogFails) throw new Error("fixture catalog failed");
      return { data: [{ model: "fixture", isDefault: true, defaultReasoningEffort: "medium" }], nextCursor: null };
    },
    turnStart: async input => {
      calls.push(["turn", structuredClone(input)]);
      if (turnFails) throw new Error("fixture turn failed");
      return { turn: { id: "turn-1" } };
    },
  };
  const handle = await new CodexRuntimeAdapter({ runtimePool: { get: async () => host } }).acquire({
    runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: "fixture-account" });
  await handle.sessionResume({ sessionId: "session-1", developerInstructions: "CURRENT_POLICY" });
  const turn = (overrides = {}) => handle.turnStart({ sessionId: "session-1", operationId: "operation-1",
    prompt: "actual request", context: "UNTRUSTED_MEMORY", thinkingLevel: "high",
    turnDeveloperInstructions: "CURRENT_RUN_RULES\n\nCurrent Shoggoth Run ID: run-1", ...overrides });
  return { calls, handle, turn, failInjection: value => { injectionFails = value; },
    failTurn: value => { turnFails = value; }, failCatalog: () => { catalogFails = true; } };
}

test("Codex prepares policy, turn rules and context in one ordered RPC before the user request", async () => {
  const f = await fixture();
  await f.turn();
  assert.deepEqual(f.calls.map(([kind]) => kind), ["inject", "turn"], "three serial preparation RPCs collapse to one");
  const items = f.calls[0][1].items;
  assert.deepEqual(items.map(item => item.role), ["developer", "developer", "user"]);
  assert.match(items[0].content[0].text, /CURRENT_POLICY$/u);
  assert.equal(items[1].content[0].text, "CURRENT_RUN_RULES\n\nCurrent Shoggoth Run ID: run-1");
  assert.equal(items[2].content[0].text, "UNTRUSTED_MEMORY");
  assert.equal(f.calls[1][1].input[0].text, "actual request");
  assert.equal(f.calls[1][1].clientUserMessageId, "operation-1");
});

test("Codex injection failure blocks dispatch and leaves all preparation due", async () => {
  const f = await fixture();
  f.failInjection(true);
  await assert.rejects(f.turn(), /injection failed/u);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["inject"]);
  f.failInjection(false);
  await f.turn();
  assert.deepEqual(f.calls.map(([kind]) => kind), ["inject", "inject", "turn"]);
  assert.deepEqual(f.calls[0][1], f.calls[1][1], "a failed batch cannot mark policy or context as delivered");
});

test("Codex warm turns reuse delivered policy and context but always update the Run ID", async () => {
  const f = await fixture();
  await f.turn();
  f.calls.length = 0;
  await f.turn({ operationId: "operation-2", turnDeveloperInstructions: "CURRENT_RUN_RULES\n\nCurrent Shoggoth Run ID: run-2" });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["inject", "turn"]);
  assert.equal(f.calls[0][1].items.length, 1);
  assert.match(f.calls[0][1].items[0].content[0].text, /SHOGGOTH CONTEXT UNCHANGED[\s\S]*run-2$/u);
  assert.doesNotMatch(f.calls[0][1].items[0].content[0].text, /CURRENT_POLICY|UNTRUSTED_MEMORY/u);
});

test("Codex failed turn retains context for the next attempt without repeating applied policy", async () => {
  const f = await fixture();
  f.failTurn(true);
  await assert.rejects(f.turn(), /turn failed/u);
  f.failTurn(false);
  f.calls.length = 0;
  await f.turn();
  assert.deepEqual(f.calls.map(([kind]) => kind), ["inject", "turn"]);
  assert.deepEqual(f.calls[0][1].items.map(item => item.role), ["developer", "user"]);
  assert.equal(f.calls[0][1].items[1].content[0].text, "UNTRUSTED_MEMORY");
});

test("Codex resolves inherited effort before mutating model history", async () => {
  const f = await fixture();
  await f.turn({ thinkingLevel: null });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["models", "inject", "turn"]);
  assert.equal(f.calls.at(-1)[1].effort, "medium");
  const failed = await fixture();
  failed.failCatalog();
  await assert.rejects(failed.turn({ thinkingLevel: null }), /catalog failed/u);
  assert.deepEqual(failed.calls.map(([kind]) => kind), ["models"]);
});
