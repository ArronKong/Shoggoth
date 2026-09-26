#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { validateRuntimeContextUsage, validateRuntimeContextCapabilities, runtimeContextCapabilities,
  unknownRuntimeContextUsage, piRuntimeContextUsage } = require("../app/agent-service/runtime-context-usage");
const { validateChatServiceResult } = require("../app/agent-service/chat-service-protocol");

test("context quality cannot invent zero, window, or totals; the detached DTO is strict", () => {
  const unknown = unknownRuntimeContextUsage("session-1", { observedAt: 1 });
  assert.equal(unknown.usedTokens, null);
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.quality, "unknown");
  assert.ok(Object.isFrozen(unknown));
  for (const item of [{ ...unknown, quality: "exact" }, { ...unknown, usedTokens: 0 },
    { ...unknown, contextWindow: 0 }, { ...unknown, prompt: "private" }]) {
    assert.throws(() => validateRuntimeContextUsage(item), { code: "RUNTIME_CONTEXT_INVALID" });
  }
  let getters = 0;
  const accessor = { ...unknown };
  Object.defineProperty(accessor, "usedTokens", { get() { getters++; return 10; } });
  assert.throws(() => validateRuntimeContextUsage(accessor));
  assert.equal(getters, 0);
  assert.equal(runtimeContextCapabilities("pi")["context.usage.estimated"], true);
  assert.equal(runtimeContextCapabilities("deepseek-harness")["context.usage.estimated"], true);
  assert.throws(() => validateRuntimeContextCapabilities({ ...runtimeContextCapabilities("codex"), prompt: "private" }));
});

test("Pi uses current estimates and model catalog window; legacy billing totals stay unknown", () => {
  assert.equal(piRuntimeContextUsage("session-1", { tokens: { total: 900_000 } }, 128_000, 1).usedTokens, null);
  const estimated = piRuntimeContextUsage("session-1", {
    tokens: { total: 900_000 }, contextUsage: { tokens: 60_000, contextWindow: 999_999, percent: 90 },
  }, 128_000, 1);
  assert.equal(estimated.usedTokens, 60_000);
  assert.equal(estimated.contextWindow, 128_000);
  assert.equal(estimated.quality, "estimated");
  assert.equal(piRuntimeContextUsage("session-1", { contextUsage: { tokens: null } }, 128_000, 2).quality, "unknown");
});

test("Codex normalizer and adapter preserve last-window usage independently of billed totals", async () => {
  let hostListener;
  let compactions = 0;
  const host = { subscribe(listener) { hostListener = listener; return () => {}; },
    async threadCompactStart() { compactions++; } };
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host } });
  const handle = await adapter.acquire({ runtime: "codex", runtimeProfileId: "fixture", runtimeAccountId: "fixture-account" });
  const events = [];
  handle.subscribe((event) => events.push(event));
  const tokens = (total) => ({ totalTokens: total, inputTokens: total - 10, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
  for (const turns of [5, 15, 30, 50]) {
    for (let turn = 1; turn <= turns; turn++) {
      hostListener(normalizeCodexEvent({ method: "thread/tokenUsage/updated", params: {
        threadId: "session-1", turnId: `turn-${turn}`, tokenUsage: {
          last: tokens(1000 + turn), total: tokens(turn * 1000), modelContextWindow: 200_000,
        },
      } }));
      const observed = events.at(-2);
      assert.equal(observed.type, "context_usage");
      assert.equal(observed.contextUsage.usedTokens, 1000 + turn);
      assert.equal(observed.contextUsage.contextWindow, 200_000);
      assert.equal(observed.contextUsage.quality, "exact");
      assert.equal(events.at(-1).type, "usage");
    }
  }
  hostListener(normalizeCodexEvent({ method: "thread/compacted", params: { threadId: "session-1" } }));
  assert.equal(events.at(-1).type, "context_compacted");
  assert.equal(events.at(-1).contextUsage.usedTokens, null);
  assert.equal(compactions, 0, "observation must never trigger automatic compaction");
  await handle.commandExecute({ sessionId: "session-1", text: "/compact" });
  assert.equal(compactions, 1, "only an explicit existing command starts compaction");
});

test("session list protocol rejects mismatched native-session context and unsupported fields", () => {
  const session = { id: "44444444-4444-4444-8444-444444444444", sessionKey: "11111111-1111-4111-8111-111111111111",
    profileId: "profile-1", runtimeSessionId: "session-1", workspace: null, title: null, modelOverride: null,
    permissionMode: null, status: "ready", createdAt: 1, updatedAt: 1, derivedTitle: null,
    contextUsage: unknownRuntimeContextUsage("session-1", { observedAt: 1 }),
    contextCapabilities: runtimeContextCapabilities("codex") };
  const page = (value) => ({ sessions: [value], nextCursor: null, hasMore: false });
  assert.equal(validateChatServiceResult("chat.session.list", page(session)).sessions[0].contextUsage.quality, "unknown");
  assert.throws(() => validateChatServiceResult("chat.session.list", page({ ...session,
    contextUsage: unknownRuntimeContextUsage("another-session", { observedAt: 1 }) })), { code: "CHAT_RESPONSE_INVALID" });
});
