"use strict";

// Read only public group messages. No private session, semantic index, or shared memory access.
const crypto = require("node:crypto");
const { fail } = require("./group-chat-protocol");
const { sha256 } = require("../group-result-content");
const keys = new WeakMap();
const SCAN_LIMIT = 500;
const TTL = 30 * 60 * 1000;
const asciiLower = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
const sign = (key, payload) => crypto.createHmac("sha256", key).update(payload).digest("hex");

function searchGroupMessages(store, params) {
  const { groupId, discussionId, authorKind, memberId, limit } = params;
  const query = params.query.trim();
  store.listMessages({ groupId, limit: 1 }); // Existing readiness and group ownership check.
  const db = store.db, now = store.now?.() ?? Date.now();
  if (!keys.has(store)) keys.set(store, crypto.randomBytes(32));
  const key = keys.get(store);
  let discussion = null;
  if (discussionId) {
    const row = db.prepare("SELECT data FROM discussions WHERE id=? AND group_id=?").get(discussionId, groupId);
    if (!row) fail("GROUP_CHAT_REQUEST_NOT_FOUND");
    discussion = JSON.parse(row.data);
  }
  if (memberId && !db.prepare("SELECT id FROM members WHERE id=? AND group_id=?").get(memberId, groupId)) fail("GROUP_CHAT_MEMBER_NOT_FOUND");
  const scope = sha256(JSON.stringify([groupId, query, discussionId, authorKind, memberId, limit]));
  let upperSeq, beforeSeq, expires;
  if (params.cursor) {
    try {
      const [payload, signature, extra] = params.cursor.split(".");
      if (extra !== undefined || !signature || signature.length !== 64
        || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(key, payload)))) throw Error();
      const saved = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (saved.scope !== scope || !Number.isSafeInteger(saved.upperSeq) || saved.upperSeq < 0
        || !Number.isSafeInteger(saved.beforeSeq) || saved.beforeSeq < 1 || saved.beforeSeq > saved.upperSeq
        || !Number.isSafeInteger(saved.expires) || saved.expires <= now) throw Error();
      ({ upperSeq, beforeSeq, expires } = saved);
    } catch { fail("GROUP_CHAT_RESPONSE_EXPIRED"); }
  } else {
    upperSeq = db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE group_id=?").get(groupId).seq;
    beforeSeq = upperSeq + 1; expires = now + TTL;
  }
  const where = ["m.group_id=?", "m.seq<=?", "json_extract(m.data,'$.author.kind') IN ('user','member')"];
  const args = [groupId, upperSeq];
  if (discussion) {
    where.push("(json_extract(m.data,'$.origin.discussionId')=? OR m.id=? OR m.id=?)");
    args.push(discussionId, discussion.rootUserMessageId ?? discussion.causeMessageId, discussion.causeMessageId);
  }
  if (authorKind) { where.push("json_extract(m.data,'$.author.kind')=?"); args.push(authorKind); }
  if (memberId) { where.push("json_extract(m.data,'$.author.memberId')=?"); args.push(memberId); }
  const base = `FROM messages m LEFT JOIN message_results r ON r.message_id=m.id WHERE ${where.join(" AND ")}`;
  const partial = db.prepare(`SELECT COUNT(*) AS count ${base} AND r.message_id IS NULL AND json_extract(m.data,'$.author.kind')='member'`).get(...args).count > 0;
  // Missing-full-text rows must pass the public projection before matching (legacy task paths can be rewritten).
  const rows = db.prepare(`SELECT m.id,m.seq,r.digest,r.bytes,
    CASE WHEN r.message_id IS NULL THEN NULL ELSE instr(lower(r.body),lower(?)) END AS position,
    CASE WHEN r.message_id IS NULL THEN NULL ELSE substr(r.body,max(1,instr(lower(r.body),lower(?))-80),320) END AS excerpt
    ${base} AND m.seq<? AND (r.message_id IS NULL OR instr(lower(r.body),lower(?))>0)
    ORDER BY m.seq DESC LIMIT ?`).all(query, query, ...args, beforeSeq, query, SCAN_LIMIT + 1);
  const hits = [];
  let consumed = 0;
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    consumed++;
    const source = store.getMessage(row.id);
    if (!source || source.groupId !== groupId) fail("GROUP_CHAT_UNAVAILABLE");
    let snippet, digest, bytes, offset, incomplete;
    if (row.excerpt !== null) {
      snippet = row.excerpt; digest = row.digest; bytes = row.bytes;
      offset = Math.max(0, row.position - 1 - 80); incomplete = false;
    } else {
      const index = asciiLower(source.body).indexOf(asciiLower(query));
      if (index < 0) continue;
      const chars = [...source.body]; offset = Math.max(0, [...source.body.slice(0, index)].length - 80);
      snippet = chars.slice(offset, offset + 320).join("");
      digest = sha256(source.body); bytes = Buffer.byteLength(source.body); incomplete = source.author.kind === "member";
    }
    // Construct the minimal public shape; never forward raw origins, internal run IDs or task paths.
    const message = { id: source.id, groupId, seq: source.seq, threadId: source.threadId, author: source.author,
      body: snippet, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: source.createdAt,
      ...(source.replyTo ? { replyTo: source.replyTo } : {}),
      fullResult: { bytes, digest }, ...(source.origin?.discussionId ? { origin: { discussionId: source.origin.discussionId } } : {}) };
    hits.push({ message, snippet, snippetOffset: offset, partial: incomplete });
    if (hits.length === limit) break;
  }
  const hasMore = consumed < rows.length;
  let nextCursor = null;
  if (hasMore) {
    const payload = Buffer.from(JSON.stringify({ scope, upperSeq, beforeSeq: rows[consumed - 1].seq, expires })).toString("base64url");
    nextCursor = `${payload}.${sign(key, payload)}`;
  }
  return { groupId, query, discussionId, authorKind, memberId, upperSeq, hits, partial, hasMore, nextCursor };
}

module.exports = { searchGroupMessages };
