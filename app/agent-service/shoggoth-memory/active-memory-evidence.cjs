"use strict";

const { core } = require("./host.cjs");
const { serviceError } = require("../security");
const HASH = /^[a-f0-9]{64}$/u;
const SQLITE_HASH = /^sqlite:(0|[1-9][0-9]*):([a-f0-9]{64})$/u;

function parseSourceHash(source, hash) {
  if (typeof hash !== "string") return null;
  if (source === "memory") return HASH.test(hash) ? { contentHash: hash } : null;
  if (source !== "sessions") return null;
  const match = SQLITE_HASH.exec(hash);
  if (match && Number.isSafeInteger(Number(match[1]))) return { contentHash: match[2], revision: Number(match[1]) };
  return HASH.test(hash) ? { contentHash: hash } : null;
}
function validEvidence(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).every(key => ["path", "source", "hash", "throughSeq", "prefixHash", "throughBytes"].includes(key))
    && typeof item.path === "string" && item.path.length > 0 && item.path.length <= 4096 && !item.path.includes("\0")
    && parseSourceHash(item.source, item.hash)
    && (item.throughSeq === undefined || item.source === "sessions" && Number.isSafeInteger(item.throughSeq) && item.throughSeq > 0)
    // A Markdown prefix proof travels as a pair. Older persisted evidence has
    // neither field and keeps its whole-file comparison.
    && (item.prefixHash === undefined) === (item.throughBytes === undefined)
    && (item.prefixHash === undefined || item.source === "memory" && HASH.test(item.prefixHash)
      && Number.isSafeInteger(item.throughBytes) && item.throughBytes >= 0));
}
// The file store appends entries after trimEnd(), so the proof covers the
// cited version without its trailing whitespace.
function markdownPrefix(text) {
  const prefix = text.trimEnd();
  return { prefixHash: core.hashText(prefix), throughBytes: Buffer.byteLength(prefix) };
}
// True when the current file still begins with the proven bytes and anything
// after them starts a new line, i.e. only entries were appended.
function prefixCurrent(snapshot, evidence) {
  if (typeof snapshot?.text !== "string") return false;
  const bytes = Buffer.from(snapshot.text);
  if (bytes.length < evidence.throughBytes) return false;
  if (core.hashText(bytes.subarray(0, evidence.throughBytes).toString("utf8")) !== evidence.prefixHash) return false;
  const rest = bytes.subarray(evidence.throughBytes).toString("utf8");
  return rest === "" || /^\s/u.test(rest);
}
function captureEvidence(index, path, source, hash) {
  const evidence = { path, source, hash };
  if (!validEvidence(evidence)) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回来源版本无效");
  if (source === "memory") {
    const snapshot = index.readIndexedSource(path, source);
    // Never let a newer file vouch for an older search result.
    if (snapshot.hash !== hash) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回引用的文件已经变化");
    if (typeof snapshot.text !== "string") return evidence;
    const proven = { ...evidence, ...markdownPrefix(snapshot.text) };
    if (!validEvidence(proven)) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回来源版本无效");
    return proven;
  }
  if (source !== "sessions") return evidence;
  const snapshot = index.readIndexedSource(path, source);
  if (snapshot.hash !== hash || !snapshot.lineMap?.length) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回引用的会话已经变化");
  evidence.throughSeq = snapshot.lineMap.at(-1);
  if (!validEvidence(evidence)) throw serviceError("MEMORY_SOURCE_CHANGED", "自动召回会话范围无效");
  return evidence;
}
function evidenceCurrent(index, evidence) {
  if (!validEvidence(evidence)) return false;
  const snapshot = index.readIndexedSource(evidence.path, evidence.source);
  if (evidence.throughSeq === undefined) {
    return snapshot.hash === evidence.hash || evidence.prefixHash !== undefined && prefixCurrent(snapshot, evidence);
  }
  // Product rechecks ownership, visibility, completed turns and provenance on
  // every read. Appending later eligible messages does not change this prefix;
  // edits, removed events, reordered sequences and provenance changes do.
  const lines = snapshot.content.split("\n");
  const count = snapshot.lineMap.findIndex(seq => seq > evidence.throughSeq);
  const end = count < 0 ? snapshot.lineMap.length : count;
  if (!end || snapshot.lineMap[end - 1] !== evidence.throughSeq || lines.length !== snapshot.lineMap.length
    || snapshot.messageTimestampsMs.length !== lines.length || snapshot.lineProvenance.length !== lines.length) return false;
  const hash = core.hashSessionEntrySnapshot({
    content: lines.slice(0, end).join("\n"), lineMap: snapshot.lineMap.slice(0, end),
    messageTimestampsMs: snapshot.messageTimestampsMs.slice(0, end),
    lineProvenance: snapshot.lineProvenance.slice(0, end), resetRecallCutoff: null,
  });
  return hash === parseSourceHash(evidence.source, evidence.hash).contentHash;
}

module.exports = { captureEvidence, evidenceCurrent, validEvidence, parseSourceHash };
