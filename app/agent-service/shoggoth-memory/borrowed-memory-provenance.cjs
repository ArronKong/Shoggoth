"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("../security");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const KINDS = new Set(["user", "long_term", "daily", "reflection_report"]);
const MAX_REFS = 256;
const FIELDS = ["version", "requesterProfileId", "ownerProfileId", "ownerDisplayName",
  "canonicalRelativePath", "documentKind", "startLine", "endLine", "sourceHash", "sourceRevision", "sourceOriginHash", "policyRevision"];
const ownValue = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
function invalid() { throw serviceError("BORROWED_MEMORY_PROVENANCE_INVALID", "借阅记忆来源元数据无效"); }
function normalizeBorrowedMemoryRefs(input = []) {
  if (!Array.isArray(input) || input.length > MAX_REFS) invalid();
  const refs = new Map();
  for (const value of input) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    if (Object.getOwnPropertyNames(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) invalid();
    const row = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, ownValue(value, key)]));
    const relative = row.canonicalRelativePath;
    if (row.version !== 1 || typeof row.requesterProfileId !== "string" || !ID.test(row.requesterProfileId)
      || typeof row.ownerProfileId !== "string" || !ID.test(row.ownerProfileId)
      || typeof relative !== "string" || !relative || relative.length > 1024 || relative.includes("\\")
      || relative.includes("\0") || relative.startsWith("/") || relative.split("/").some(part => !part || [".", ".."].includes(part))
      || !KINDS.has(row.documentKind) || !Number.isSafeInteger(row.startLine) || row.startLine < 1
      || !Number.isSafeInteger(row.endLine) || row.endLine < row.startLine || row.endLine - row.startLine > 1000
      || !HASH.test(row.sourceHash) || row.sourceRevision !== `sha256:${row.sourceHash}`
      || (row.sourceOriginHash !== undefined && !HASH.test(row.sourceOriginHash))
      || !Number.isSafeInteger(row.policyRevision) || row.policyRevision < 0
      || (row.ownerDisplayName !== undefined && (typeof row.ownerDisplayName !== "string" || !row.ownerDisplayName.isWellFormed()
        || row.ownerDisplayName.includes("\0") || row.ownerDisplayName.length > 512))) invalid();
    refs.set(JSON.stringify([row.requesterProfileId, row.ownerProfileId, relative, row.startLine, row.endLine, row.sourceHash, row.sourceOriginHash ?? null]), row);
  }
  return [...refs.values()];
}
function mergeBorrowedMemoryRefs(...groups) {
  const refs = groups.flatMap(group => normalizeBorrowedMemoryRefs(group || []));
  const unique = new Map(refs.map(ref => [JSON.stringify([ref.requesterProfileId, ref.ownerProfileId,
    ref.canonicalRelativePath, ref.startLine, ref.endLine, ref.sourceHash, ref.sourceOriginHash ?? null]), ref]));
  if (unique.size > MAX_REFS) throw serviceError("BORROWED_MEMORY_PROVENANCE_LIMIT", "借阅来源超过会话容量，需要新建会话");
  return [...unique.values()];
}
function extractBorrowedMemoryRefs(value) {
  const groups = [], seen = new Set();
  const walk = (item, depth) => {
    if (!item || typeof item !== "object" || depth > 8 || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item.slice(0, 512)) walk(child, depth + 1); return; }
    const descriptor = Object.getOwnPropertyDescriptor(item, "borrowedMemoryRefs");
    if (descriptor && !Object.hasOwn(descriptor, "value")) invalid();
    if (descriptor) groups.push(normalizeBorrowedMemoryRefs(descriptor.value));
    for (const key of ["content", "contextContent", "tool", "output", "result", "results", "items", "item", "provenance"]) {
      const child = Object.getOwnPropertyDescriptor(item, key);
      if (child && !Object.hasOwn(child, "value")) invalid();
      if (child) walk(child.value, depth + 1);
    }
  };
  walk(value, 0); return mergeBorrowedMemoryRefs(...groups);
}
function refsFromEvents(events, { throughSeq = Infinity } = {}) {
  return mergeBorrowedMemoryRefs(...events.filter(event => event.seq <= throughSeq).map(extractBorrowedMemoryRefs));
}
function isBorrowedMemoryDerived(event) {
  return event?.borrowedMemoryDerived === true || event?.content?.borrowedMemoryDerived === true
    || (event?.kind !== "user" && extractBorrowedMemoryRefs(event).length > 0);
}
function isReferentialMemoryRequest(text) {
  if (typeof text !== "string") return false;
  // "Do you remember ...?" asks for recall. Mask only that verb so a later
  // "save the above" clause still inherits its borrowed dependencies.
  const request = text.replace(/\b(?:do|did)\s+you\s+(?:still\s+)?remember\b/giu,
    match => match.replace(/remember$/iu, "        "));
  return /(?:记住|保存|存下|记录|\b(?:remember|save|memorize)\b)[\s\S]{0,64}(?:上面|上述|刚才|这个|这些|那条|以上|前面|\b(?:above|previous|that|this|those)\b)|(?:上面|上述|刚才|以上|\b(?:above|previous)\b)[\s\S]{0,64}(?:记住|保存|\b(?:remember|save|memorize)\b)/iu.test(request);
}
function citation(ref) {
  return `${ref.ownerDisplayName || ref.ownerProfileId} · ${ref.canonicalRelativePath}#L${ref.startLine}-L${ref.endLine}`;
}
function borrowedMemoryPlaceholder(refs, state = "reference_only") {
  const normalized = normalizeBorrowedMemoryRefs(refs);
  return `[借阅记忆${state === "invalid" ? "来源已变化或撤回，请重新检索" : "仅保留来源引用；需要正文时请重新检索"}: ${normalized.map(citation).join("；")}]`;
}
function sanitizeBorrowedToolContent(content, refs = extractBorrowedMemoryRefs(content)) {
  const normalized = normalizeBorrowedMemoryRefs(refs);
  if (!normalized.length) return structuredClone(content);
  const toolName = content?.tool?.name || content?.toolName || content?.name;
  const name = typeof toolName === "string" && /^[A-Za-z0-9_.:-]{1,256}$/u.test(toolName) ? toolName : "memory_read";
  return { borrowedMemoryRefs: normalized, borrowedMemoryDerived: true, persistPolicy: "reference_only",
    resultSummary: borrowedMemoryPlaceholder(normalized),
    tool: { name, output: { borrowedMemoryRefs: normalized, persistPolicy: "reference_only" } } };
}
function assertNoBorrowedMemoryWrite(...values) {
  for (const value of values) {
    if (!value) continue;
    const refs = extractBorrowedMemoryRefs(value);
    if (refs.length || value.borrowed === true || value.borrowedMemoryDerived === true
      || value.persistPolicy === "reference_only"
      || (Array.isArray(value.sourceRefs) && value.sourceRefs.some(ref => typeof ref === "string"
        && /^(?:shared\/|borrowed:|dependency:)/u.test(ref)))) {
      throw serviceError("MEMORY_BORROWED_READ_ONLY", "借阅记忆不能保存为当前助理的记忆；请在来源助理中维护原文");
    }
  }
}
function borrowedMemoryFingerprint(refs) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeBorrowedMemoryRefs(refs))).digest("hex");
}
module.exports = { normalizeBorrowedMemoryRefs, mergeBorrowedMemoryRefs, extractBorrowedMemoryRefs,
  refsFromEvents, isBorrowedMemoryDerived, isReferentialMemoryRequest, borrowedMemoryPlaceholder,
  sanitizeBorrowedToolContent, assertNoBorrowedMemoryWrite, borrowedMemoryFingerprint };
