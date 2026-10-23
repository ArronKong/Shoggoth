"use strict";
const { createHash, randomUUID } = require("node:crypto");
const MAX_FRAME = 64 * 1024, MAX_MESSAGE = 8 * 1024 * 1024, CHUNK = 32 * 1024;
function nativeChatFrame(frame) {
  return frame?.payload?.message?.shoggoth?.nativeUiVersion === 1
    || frame?.payload?.messages?.some(message => message?.shoggoth?.nativeUiVersion === 1);
}
function readableFrame(frame) {
  const messages = frame.payload.message ? [frame.payload.message] : frame.payload.messages || [];
  for (const message of messages) message.content = message.content.map(part => part.type === "ui_artifact"
    ? { type: "text", text: `[交互卡片：${part.title}] ${part.summary}` } : part);
  return frame;
}
function encodeNativeChatFrames(raw, supported = true) {
  const frame = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!nativeChatFrame(frame)) return [typeof raw === "string" ? raw : JSON.stringify(raw)];
  let serialized = JSON.stringify(supported ? frame : readableFrame(frame));
  if (!supported && Buffer.byteLength(serialized) > MAX_FRAME) {
    // A client that did not opt into fragmentation gets bounded text summaries.
    // It cannot be sent an unrecognized fragment or an oversized JSON frame.
    const messages = frame.payload.message ? [frame.payload.message] : frame.payload.messages || [];
    for (const message of messages) for (const part of message.content) if (part.type === "text" && part.text?.length > 1200)
      part.text = `${Array.from(part.text).slice(0, 1000).join("")}\n…（完整内容保存在会话历史）`;
    serialized = JSON.stringify(frame);
  }
  const body = Buffer.from(serialized);
  if (body.length <= MAX_FRAME) return [serialized];
  if (!supported || body.length > MAX_MESSAGE) throw Object.assign(new Error("聊天内容超出显示容量"), { code: "CHAT_HISTORY_TOO_LARGE" });
  const transferId = randomUUID(), sha256 = createHash("sha256").update(body).digest("hex"), count = Math.ceil(body.length / CHUNK);
  return Array.from({ length: count }, (_, index) => {
    const value = JSON.stringify({ type: "event", event: "chat.native.fragment", payload: {
      version: 1, transferId, sha256, byteLength: body.length, index, count,
      data: body.subarray(index * CHUNK, (index + 1) * CHUNK).toString("base64"),
    } });
    if (Buffer.byteLength(value) > MAX_FRAME) throw new Error("Native UI fragment exceeds frame bound");
    return value;
  });
}
module.exports = { encodeNativeChatFrames, nativeChatFrame, MAX_FRAME, MAX_MESSAGE };
