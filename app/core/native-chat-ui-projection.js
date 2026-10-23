"use strict";
const { normalizePart } = require("../agent-service/chat-ui-contract");

function stateFor(state, runId) {
  if (!state.nativeContent) state.nativeContent = { runId, parts: [], byId: new Map(), hasUi: false };
  if (state.nativeContent.runId !== runId) throw new Error("Native UI Run identity changed");
  return state.nativeContent;
}
function reduceNativeContent(state, runId, event) {
  const view = stateFor(state, runId), payload = event.payload || {};
  let part;
  if (event.type === "ui_artifact") {
    part = normalizePart(payload.part);
    if (part.sourceEventId !== payload.sourceEventId || part.segmentId !== payload.segmentId
      || !Number.isSafeInteger(payload.transcriptSeq) || payload.transcriptSeq < 1) throw new Error("Native UI source mismatch");
    view.hasUi = true;
  } else if (["text.delta", "text"].includes(event.type)) {
    const segmentId = payload.segmentId || `native-text:${runId}:legacy`;
    const previous = view.byId.get(segmentId);
    part = { type: "text", segmentId, text: event.type === "text.delta"
      ? `${previous?.text || ""}${payload.delta || ""}` : payload.text || "",
      ...(payload.phase === "commentary" || previous?.activity ? { activity: true } : {}),
      ...(typeof payload.sourceEventId === "string" ? { sourceEventId: payload.sourceEventId } : {}) };
  } else return view;
  const index = view.parts.findIndex(value => value.segmentId === part.segmentId);
  if (index < 0) view.parts.push(part); else view.parts[index] = part;
  view.byId.set(part.segmentId, part); return view;
}
function projectNativeContent(view, enabled = true) {
  return view.parts.map(part => part.type === "ui_artifact" && !enabled
    ? { type: "text", text: `[交互卡片：${part.title}] ${part.summary}`, segmentId: part.segmentId,
      sourceEventId: part.sourceEventId } : structuredClone(part));
}
function nativeHistoryContent(messages, runId) {
  const parts = [], seen = new Set(); let hasUi = false;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const [index, raw] of (message.content || []).entries()) {
      if (!["text", "ui_artifact"].includes(raw?.type)) continue;
      const part = raw.type === "ui_artifact" ? normalizePart(raw)
        : { ...raw, segmentId: raw.segmentId || `native-history:${message.id}:${index}` };
      if (seen.has(part.segmentId)) continue;
      seen.add(part.segmentId); parts.push(part); hasUi ||= part.type === "ui_artifact";
    }
  }
  return { runId, parts, hasUi };
}
function projectNativeHistory(messages, enabled) {
  return messages.map(message => ({ ...message, content: message.content.map(part => {
    if (part?.type !== "ui_artifact") return part;
    const checked = normalizePart(part);
    return enabled ? checked : { type: "text", text: `[交互卡片：${checked.title}] ${checked.summary}`,
      segmentId: checked.segmentId, sourceEventId: checked.sourceEventId };
  }) }));
}
module.exports = { reduceNativeContent, projectNativeContent, nativeHistoryContent, projectNativeHistory };
