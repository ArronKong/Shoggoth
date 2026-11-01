#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { BridgeRuntime } from "../resources/deepseek-harness/shoggoth-dsh-bridge.mjs";
const require = createRequire(import.meta.url);
const { DEEPSEEK_HARNESS_CAPABILITIES } = require("../app/agent-service/deepseek-harness-runtime-adapter.js");
const { nativeCompaction, runtimeContextCapabilities } = require("../app/agent-service/runtime-context-usage.js");

function fixture({ outcome = "success", flushFails = false } = {}) {
  const frames = [], native = [];
  const session = { id: "native-session" };
  let dispatches = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const agent = { session, whenIdle: async () => {}, inject: () => {} };
  let bridge;
  const emit = (type, data) => {
    const event = { seq: native.length + 1, type, data };
    native.push(event); bridge.onSessionEvent(session, event);
  };
  const lifecycle = { compactionId: "compact-one", sourceCommandId: "command-one", turn: null };
  bridge = new BridgeRuntime({
    commands: {
      find: (_agent, name) => name === "compact",
      execute: async () => {
        dispatches++;
        emit("command/run", { commandId: "command-one", name: "compact", source: { kind: "user" } });
        if (outcome === "noop") return { result: { kind: "success", text: "No compactable history yet." } };
        emit("compaction/start", lifecycle);
        if (outcome === "success") emit("compaction/summary", { compactionId: lifecycle.compactionId, sourceCommandId: lifecycle.sourceCommandId,
          summary: [{ type: "text", text: "PRIVATE_SUMMARY" }], shadowedSeqs: [1, 2], shadowedTokenCount: 562 });
        emit("compaction/end", { ...lifecycle, ...(outcome === "oversized" ? {
          error: "summary is not smaller than the shadowed content (942 estimated framed tokens >= 562)",
        } : {}) });
        return { result: outcome === "oversized"
          ? { kind: "error", text: "Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log." }
          : { kind: "success", text: "Compacted 2 history items." } };
      },
    },
    sessions: { flush: async () => { if (flushFails) throw new Error("save failed"); } },
    get: () => ({ measure: () => ({ totalTokens: 42 }) }),
  });
  bridge.sessions.set(session.id, { agent, setTurnInstructions: () => {} });
  bridge.write = async frame => { frames.push(frame); if (frame.event?.type === "complete") finish(); };
  const run = async () => {
    await bridge.onRequest({ type: "request", id: "request-one", command: "turn/start", params: {
      remoteSessionId: session.id, sessionId: "public-session", turnId: "turn-one", operationId: "operation-one", prompt: "/compact",
    } });
    await done;
  };
  return { bridge, frames, native, session, lifecycle, emit, run, get dispatches() { return dispatches; } };
}

test("DeepSeek manual compact capability uses the native turn path without enabling automatic dispatch", () => {
  assert.equal(DEEPSEEK_HARNESS_CAPABILITIES["context.compact.native"], true);
  assert.equal(runtimeContextCapabilities("deepseek-harness")["context.compact.native"], true);
  assert.deepEqual(nativeCompaction("deepseek-harness"), { mode: "turn", automatic: false });
});

test("native summary lifecycle publishes compacted only after command acceptance and durable flush", async () => {
  const f = fixture(); await f.run();
  const events = f.frames.filter(frame => frame.type === "event").map(frame => frame.event);
  assert.equal(events.filter(event => event.type === "status" && event.status === "compacting").length, 1);
  const compacted = events.filter(event => event.type === "context_compacted");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].sessionId, "public-session");
  assert.equal(compacted[0].turnId, "turn-one");
  assert.equal(compacted[0].contextUsage.usedTokens, 42);
  assert.equal(events.at(-1).status, "completed");
  assert.equal(f.frames[0].type, "response");
  assert.equal(JSON.stringify(f.frames).includes("PRIVATE_SUMMARY"), false);
  assert.equal(f.dispatches, 1);
});

for (const options of [{ outcome: "oversized" }, { flushFails: true }, { outcome: "noop" }]) {
  test(`compact does not claim a replacement for ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); await f.run();
    assert.equal(f.frames.some(frame => frame.event?.type === "context_compacted"), false);
    const end = f.frames.find(frame => frame.event?.type === "complete").event;
    assert.equal(end.status, options.outcome === "noop" ? "completed" : "failed");
    if (end.status === "failed") assert.equal(end.errorCode, "RUNTIME_COMPACTION_FAILED");
    assert.equal(f.dispatches, 1, "failure must not retry the command");
    if (options.outcome === "oversized") {
      assert.equal(f.native.some(event => event.type === "compaction/summary"), false);
      assert.match(f.frames.find(frame => frame.event?.type === "text").event.text, /conversation is unchanged/u);
    }
  });
}

test("mismatched or incomplete native lifecycles never become compaction receipts", () => {
  const f = fixture();
  const active = { sessionId: "public-session", turnId: "turn-one", toolCalls: new Map() };
  const map = (type, data) => f.bridge.mapEvent(active, { type, data });
  assert.deepEqual(map("compaction/end", f.lifecycle), []);
  map("compaction/start", f.lifecycle);
  map("compaction/summary", { compactionId: "other", sourceCommandId: f.lifecycle.sourceCommandId, summary: [{ type: "text", text: "wrong" }], shadowedSeqs: [1] });
  assert.deepEqual(map("compaction/end", f.lifecycle), []);
  map("compaction/start", f.lifecycle);
  map("compaction/summary", { compactionId: f.lifecycle.compactionId, sourceCommandId: f.lifecycle.sourceCommandId, summary: [{ type: "text", text: "summary" }], shadowedSeqs: [1] });
  assert.deepEqual(map("compaction/end", { ...f.lifecycle, sourceCommandId: "different" }), []);
  assert.deepEqual(map("compaction/end", { ...f.lifecycle, turn: 9 }), []);
  assert.equal(map("compaction/end", f.lifecycle)[0].type, "context_compacted");
  assert.deepEqual(map("compaction/end", f.lifecycle), [], "duplicate terminal does not republish");
});
