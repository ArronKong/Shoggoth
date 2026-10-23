#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), { test } = require("node:test");
const { ChatUiTextProjection } = require("../app/agent-service/chat-ui-text-projection");
const { reduceNativeContent, projectNativeContent, nativeHistoryContent } = require("../app/core/native-chat-ui-projection");
const { encodeNativeChatFrames, MAX_FRAME } = require("../app/core/native-chat-ui-frames");
const part = (number = 1) => ({ type: "ui_artifact", schemaVersion: 1, artifactId: `artifact-${number}`, revision: 1,
  sourceEventId: `source-${number}`, segmentId: `segment-${number}`, title: `方案${number}`, summary: "中文说明" });
test("runtime item crossing two card publications keeps text prefixes in canonical order", () => {
  const buffer = new ChatUiTextProjection(), state = {};
  const apply = (type, payload) => reduceNativeContent(state, "run-1", { type, payload });
  const text = (type, payload) => apply(type, buffer.observe("run-1", type, { itemId: "one-item", ...payload }));
  const card = number => { buffer.flush("run-1", `publication-${number}`, value => {
    apply("text", value); return value;
  }); const p = part(number); apply("ui_artifact", { part: p, sourceEventId: p.sourceEventId, segmentId: p.segmentId, transcriptSeq: number }); };
  text("text.delta", { delta: "前文" }); card(1);
  text("text.delta", { delta: "中间" }); card(2);
  text("text.delta", { delta: "后文" }); text("text", { text: "前文中间后文", phase: "final_answer" });
  assert.deepEqual(projectNativeContent(state.nativeContent).map(p => p.text || p.artifactId), ["前文", "artifact-1", "中间", "artifact-2", "后文"]);
  card(2); assert.equal(state.nativeContent.parts.length, 5);
  assert.ok(projectNativeContent(state.nativeContent, false).every(p => p.type === "text"));
});
test("already committed commentary is not appended a second time on a publication", () => {
  const buffer = new ChatUiTextProjection(); buffer.observe("run", "text", { itemId: "first", text: "说明", phase: "commentary" });
  let count = 0; buffer.flush("run", "pub", () => { count++; }); assert.equal(count, 0);
  assert.equal(buffer.observe("run", "text.delta", { itemId: "second", delta: "回答" }).segmentId, "native-text:run:2");
});
test("public progress survives native cards and canonical history without marking the final answer", () => {
  const state = {};
  const apply = (type, payload) => reduceNativeContent(state, "run", { type, payload });
  apply("text", { segmentId: "note", text: "核对官方配额", phase: "commentary" });
  const card = part();
  apply("ui_artifact", { part: card, sourceEventId: card.sourceEventId, segmentId: card.segmentId, transcriptSeq: 2 });
  apply("text", { segmentId: "answer", text: "最终答案", phase: "final_answer" });
  const live = projectNativeContent(state.nativeContent);
  assert.equal(live[0].activity, true); assert.equal(live[2].activity, undefined);
  const view = nativeHistoryContent([{ id: "run", role: "assistant", content: live }], "run");
  assert.deepEqual(projectNativeContent(view), live);
});
test("canonical history deduplicates exact segments and retains card-only output", () => {
  const p = part();
  const view = nativeHistoryContent([{ id: "one", role: "assistant", content: [p] }, { id: "same", role: "assistant", content: [p] }], "run");
  assert.equal(view.hasUi, true); assert.deepEqual(view.parts, [p]);
  assert.throws(() => reduceNativeContent({}, "run", { type: "ui_artifact", payload: { part: p, sourceEventId: "spoof", segmentId: p.segmentId, transcriptSeq: 1 } }));
});
test("full UTF-8/JSON envelopes stay within 64 KiB and fragments reconstruct exactly", () => {
  const frame = { type: "event", event: "chat", payload: { state: "final", sessionKey: "agent:one:session", message: {
    role: "assistant", content: [{ type: "text", text: "中文😀".repeat(40000) }, ...Array.from({ length: 40 }, (_, n) => part(n))],
    shoggoth: { nativeUiVersion: 1, displayId: "native-run:run", runId: "run" } } } };
  const encoded = encodeNativeChatFrames(frame);
  assert.ok(encoded.length > 1); encoded.forEach(raw => assert.ok(Buffer.byteLength(raw) <= MAX_FRAME));
  const body = Buffer.concat(encoded.map(raw => Buffer.from(JSON.parse(raw).payload.data, "base64")));
  assert.deepEqual(JSON.parse(body.toString()), frame);
  const fallback = encodeNativeChatFrames(frame, false); assert.equal(fallback.length, 1);
  assert.ok(Buffer.byteLength(fallback[0]) <= MAX_FRAME);
  assert.ok(JSON.parse(fallback[0]).payload.message.content.every(p => p.type === "text"));
});
