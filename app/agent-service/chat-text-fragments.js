"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const MAX_TEXT_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 24 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = code => Object.assign(new Error("聊天文字分片无效，需重新读取历史"), { code });

// Run events keep the existing 48 KiB bound. Large immutable text snapshots
// are transported as independently bounded pieces, without changing segment
// or canonical source identity. The ordinary text path remains unchanged.
function appendChatText(stream, type, payload, assertSecretSafe, runId) {
  if (!["text", "text.delta"].includes(type)) return stream.append(type, payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length <= 40 * 1024) return stream.append(type, payload);
  if (bytes.length > MAX_TEXT_BYTES) throw failure("RUN_EVENT_TOO_LARGE");
  // Inspect the original value before base64 wrapping; a transport encoding
  // must never turn secret-bearing content into an accepted public event.
  const accepted = assertSecretSafe(payload, Object.freeze({ runId, type, kind: "fullText" }));
  if (accepted === false || accepted?.then) throw failure("RUN_EVENT_SECRET_REJECTED");
  const transferId = randomUUID(), sha256 = hash(bytes), count = Math.ceil(bytes.length / CHUNK_BYTES);
  for (let index = 0; index < count; index += 1) stream.append("text.fragment", {
    version: 1, transferId, type, index, count, byteLength: bytes.length, sha256,
    data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
  });
}

function consumeChatTextFragment(state, event) {
  if (event.type !== "text.fragment") return event;
  const p = event.payload;
  if (!p || Object.keys(p).sort().join(",") !== "byteLength,count,data,index,sha256,transferId,type,version"
    || p.version !== 1 || !["text", "text.delta"].includes(p.type)
    || typeof p.transferId !== "string" || !/^[a-f0-9-]{36}$/u.test(p.transferId)
    || !Number.isSafeInteger(p.byteLength) || p.byteLength <= 40 * 1024 || p.byteLength > MAX_TEXT_BYTES
    || !Number.isSafeInteger(p.count) || p.count !== Math.ceil(p.byteLength / CHUNK_BYTES)
    || !Number.isSafeInteger(p.index) || p.index < 0 || p.index >= p.count
    || typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(p.sha256)
    || typeof p.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(p.data)) throw failure("CHAT_HISTORY_FRAGMENT_INVALID");
  const data = Buffer.from(p.data, "base64");
  if (data.toString("base64") !== p.data || data.length !== Math.min(CHUNK_BYTES, p.byteLength - p.index * CHUNK_BYTES))
    throw failure("CHAT_HISTORY_FRAGMENT_CORRUPT");
  if (p.index === 0) state.textFragment = { ...p, pieces: [], next: 0, lastSeq: event.seq - 1 };
  const pending = state.textFragment;
  if (!pending) { state.historyRequired = true; return null; }
  if (pending.transferId !== p.transferId || pending.type !== p.type || pending.sha256 !== p.sha256
    || pending.count !== p.count || pending.byteLength !== p.byteLength || pending.next !== p.index
    || event.seq !== pending.lastSeq + 1) throw failure("CHAT_HISTORY_FRAGMENT_INCOMPLETE");
  pending.pieces.push(data); pending.next += 1; pending.lastSeq = event.seq;
  if (pending.next < pending.count) return null;
  state.textFragment = null;
  const bytes = Buffer.concat(pending.pieces);
  if (bytes.length !== p.byteLength || hash(bytes) !== p.sha256) throw failure("CHAT_HISTORY_FRAGMENT_CORRUPT");
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw failure("CHAT_HISTORY_FRAGMENT_CORRUPT"); }
  const text = payload?.[p.type === "text" ? "text" : "delta"];
  if (typeof text !== "string" || !text.isWellFormed()) throw failure("CHAT_HISTORY_FRAGMENT_INVALID");
  return { ...event, type: p.type, payload };
}
module.exports = { appendChatText, consumeChatTextFragment, MAX_TEXT_BYTES };
