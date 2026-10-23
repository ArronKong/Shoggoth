"use strict";

const crypto = require("node:crypto");
const { resultPage, validResultPage, sha256 } = require("./group-result-content");

const INLINE_BYTES = 40 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const TTL_MS = 30_000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const scopeOf = params => params.groupId ?? null;

function validEnvelope(value) {
  const ref = value?.groupResponse;
  return value && Object.keys(value).length === 1 && ref && Object.getPrototypeOf(ref) === Object.prototype
    && Object.keys(ref).sort().join(",") === "cursor,groupId,method,page"
    && typeof ref.cursor === "string" && /^[a-f0-9]{48}$/u.test(ref.cursor)
    && typeof ref.method === "string" && ref.method.startsWith("group.")
    && (ref.groupId === null || typeof ref.groupId === "string") && validResultPage(ref.page)
    && ref.page.totalBytes <= MAX_RESPONSE_BYTES;
}

// 大群详情仍是一个逻辑读取。IPC 只传有界页，宿主透明组装固定快照；不截掉成员、审批或任务。
class GroupResponsePages {
  constructor({ now = Date.now } = {}) { this.now = now; this.rows = new Map(); this.bytes = 0; }
  #prune() {
    for (const [key, row] of this.rows) {
      if (row.expires <= this.now()) { this.rows.delete(key); this.bytes -= row.bytes; }
    }
  }
  pack(method, params, result, { ttlMs = TTL_MS } = {}) {
    if (method === "group.response.read") return result;
    const text = JSON.stringify(result);
    const bytes = Buffer.byteLength(text);
    if (bytes <= INLINE_BYTES) return result;
    if (bytes > MAX_RESPONSE_BYTES) fail("GROUP_CHAT_RESPONSE_TOO_LARGE");
    this.#prune();
    while (this.rows.size && this.bytes + bytes > CACHE_BYTES) {
      const [key, row] = this.rows.entries().next().value;
      this.rows.delete(key); this.bytes -= row.bytes;
    }
    const cursor = crypto.randomBytes(24).toString("hex");
    const row = { method, groupId: scopeOf(params), text, bytes, expires: this.now() + ttlMs };
    this.rows.set(cursor, row); this.bytes += bytes;
    return { groupResponse: { cursor, method, groupId: row.groupId, page: resultPage(text) } };
  }
  read({ cursor, method, groupId, offset, digest }) {
    this.#prune();
    const row = this.rows.get(cursor);
    if (!row || row.method !== method || row.groupId !== groupId) fail("GROUP_CHAT_RESPONSE_EXPIRED");
    return { groupResponse: { cursor, method, groupId, page: resultPage(row.text, { offset, digest }) } };
  }
  clear() { this.rows.clear(); this.bytes = 0; }
  deleteGroup(groupId) {
    for (const [key, row] of this.rows) if (row.groupId === groupId) { this.rows.delete(key); this.bytes -= row.bytes; }
  }
}

async function unpackGroupResponse(method, params, first, read) {
  if (!Object.hasOwn(first, "groupResponse")) return first;
  let current = first;
  const parts = [];
  let cursor = null, digest = null, bytes = null, offset = 0;
  for (let pages = 0; pages < 2048; pages++) {
    if (!validEnvelope(current)) fail("GROUP_RESULT_MISMATCH");
    const ref = current.groupResponse;
    if (ref.method !== method || ref.groupId !== scopeOf(params) || ref.page.offset !== offset
      || (cursor !== null && ref.cursor !== cursor) || (digest !== null && ref.page.digest !== digest)
      || (bytes !== null && ref.page.totalBytes !== bytes)) fail("GROUP_RESULT_MISMATCH");
    cursor = ref.cursor; digest = ref.page.digest; bytes = ref.page.totalBytes;
    parts.push(ref.page.text);
    if (ref.page.nextOffset === null) {
      const text = parts.join("");
      if (sha256(text) !== digest) fail("GROUP_RESULT_MISMATCH");
      return JSON.parse(text);
    }
    offset = ref.page.nextOffset;
    current = await read({ cursor, method, groupId: scopeOf(params), offset, digest });
  }
  fail("GROUP_RESULT_MISMATCH");
}

module.exports = { GroupResponsePages, unpackGroupResponse, validEnvelope, MAX_RESPONSE_BYTES };
