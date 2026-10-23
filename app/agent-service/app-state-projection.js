"use strict";

const crypto = require("node:crypto");
const { APP_STATE_PAGE_BYTES, APP_STATE_SOURCE_CODES } = require("./app-state-contract");

function stateError(code) { return Object.assign(new Error(code), { code }); }
function text(value, maxBytes = 256) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return null;
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  for (let end = maxBytes; end > maxBytes - 4; end -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)); } catch {}
  }
  return null;
}
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function timestamp(value) {
  if (typeof value === "string") value = Date.parse(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function fields(value, names, kind = "text") {
  return Object.fromEntries(names.map(name => [name, kind === "number" ? number(value?.[name])
    : kind === "timestamp" ? timestamp(value?.[name]) : text(value?.[name], 512)]));
}
function sourceUnavailable(source, code = "APP_STATE_SOURCE_UNAVAILABLE") {
  return { source: text(source, 128) || "unknown",
    code: APP_STATE_SOURCE_CODES.includes(code) ? code : "APP_STATE_SOURCE_UNAVAILABLE" };
}
function counts(items, field) {
  const result = {};
  for (const item of items) {
    const key = text(item[field], 128) || "unknown";
    if (!Object.hasOwn(result, key) && Object.keys(result).length >= 32) {
      result.other = (result.other || 0) + 1;
    } else Object.defineProperty(result, key, { value: (Object.hasOwn(result, key) ? result[key] : 0) + 1, enumerable: true,
      configurable: true, writable: true });
  }
  return result;
}
function sectionSummary(section, items) {
  const rows = items.filter(item => item.type !== "board" && item.type !== "provider"
    && item.type !== "binding" && item.type !== "connection");
  if (section === "agents") return { configured: rows.length,
    connected: rows.filter(row => row.connected === true).length,
    connectionUnknown: rows.filter(row => row.connected === null).length,
    native: rows.filter(row => row.kind === "native").length, external: rows.filter(row => row.kind === "external").length };
  if (section === "cron") return { enabled: rows.filter(row => row.enabled).length,
    disabled: rows.filter(row => !row.enabled).length, byStatus: counts(rows, "status") };
  if (section === "inspiration") {
    const active = rows.filter(row => !row.archived);
    return { unarchived: active.length, archived: rows.length - active.length,
      favorite: active.filter(row => row.favorite).length,
      unassigned: active.filter(row => !row.assigned).length,
      unassignedIncludingArchived: rows.filter(row => !row.assigned).length,
      byStatus: counts(active, "status") };
  }
  if (section === "kanban") return { boards: items.filter(row => row.type === "board").length,
    cards: rows.length, archived: rows.filter(row => row.archived).length,
    byStatus: counts(rows.filter(row => !row.archived), "status") };
  if (section === "runs" || section === "sessions") return { byStatus: counts(rows, "status") };
  if (section === "models") return { models: rows.length, providers: items.filter(row => row.type === "provider").length };
  if (section === "skills") return { enabled: rows.filter(row => row.enabled).length,
    globalEnabled: rows.filter(row => row.globalEnabled).length };
  if (section === "plugins") return { installations: items.filter(row => row.type === "installation").length,
    library: items.filter(row => row.type === "library").length,
    bindings: items.filter(row => row.type === "binding").length,
    connections: items.filter(row => row.type === "connection").length, byState: counts(rows, "desiredState") };
  return {};
}
function snapshot(section, items, unavailableSources = [], summary = {}, now = Date.now()) {
  const unique = [...new Map(unavailableSources.map(row => [`${row.source}:${row.code}`, row])).values()];
  const complete = unique.length === 0;
  return { section, sampledAt: now, scope: "app", available: items.length > 0 || complete,
    complete, total: complete ? items.length : null, knownTotal: items.length,
    summary: { ...sectionSummary(section, items), ...summary }, unavailableSources: unique, items };
}

function resourceRevision(kind, value) {
  const keys = kind === "cron" ? ["id", "profileId", "agentId", "name", "description", "enabled", "prompt", "workspace", "workdir",
    "schedule", "model", "provider", "payload", "delivery", "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId", "skills", "script"]
    : kind === "board" ? ["id", "profileId", "slug", "name", "description"]
      : ["id", "profileId", "boardId", "title", "body", "bodyMeta", "position", "status", "column", "assignee", "agentId", "priority", "priorityLevel", "archived", "archivedAt", "updatedAt"];
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(canonical({ ...Object.fromEntries(keys
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])),
    ...(kind === "card" && value.wb ? { workboardNotes: value.wb.notes ?? null, workboardArchived: value.wb.archived === true } : {}) }))).digest("hex");
}

// Cache a bounded, immutable metadata snapshot while a caller follows its
// cursor. A fresh cursor=null read observes live state. Cursors never authorize
// mutations and are bound to the section and the calling principal.
class AppStatePager {
  constructor({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    this.now = now; this.randomBytes = randomBytes; this.pages = new Map();
  }
  get(cursor, section, principal) {
    const [id, rawOffset] = cursor.split(":");
    const cached = this.pages.get(id);
    if (!cached || cached.expiresAt <= this.now()) {
      this.pages.delete(id); throw stateError("APP_STATE_CURSOR_EXPIRED");
    }
    if (cached.value.section !== section || cached.principal !== principal) throw stateError("APP_STATE_CURSOR_INVALID");
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 1 || offset >= cached.value.items.length
      || !cached.offsets.has(offset)) throw stateError("APP_STATE_CURSOR_INVALID");
    return { ...cached, id, offset };
  }
  page(value, { cursor, limit }, principal = "app") {
    let id = null, offset = 0;
    if (cursor !== null) ({ value, id, offset } = this.get(cursor, value.section, principal));
    const { items, ...metadata } = value;
    if (Buffer.byteLength(JSON.stringify({ ...metadata, items: [], nextCursor: null, hasMore: false })) > APP_STATE_PAGE_BYTES)
      throw stateError("APP_STATE_RESPONSE_TOO_LARGE");
    const page = [];
    for (const item of items.slice(offset, offset + limit)) {
      if (Buffer.byteLength(JSON.stringify({ ...metadata, items: [...page, item], nextCursor: "0".repeat(48), hasMore: true })) > APP_STATE_PAGE_BYTES) break;
      page.push(item);
    }
    if (!page.length && offset < items.length) throw stateError("APP_STATE_RESPONSE_TOO_LARGE");
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < items.length;
    if (hasMore && id === null) {
      for (const [key, cached] of this.pages) if (cached.expiresAt <= this.now()) this.pages.delete(key);
      // Bound both retained snapshots and their memory. Never silently truncate.
      if (items.length > 100_000 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw stateError("APP_STATE_RESPONSE_TOO_LARGE");
      const snapshotBytes = Buffer.byteLength(JSON.stringify(value));
      while (this.pages.size >= 16 || [...this.pages.values()].reduce((sum, entry) => sum + entry.bytes, 0) + snapshotBytes > 32 * 1024 * 1024)
        this.pages.delete(this.pages.keys().next().value);
      id = this.randomBytes(16).toString("hex");
      this.pages.set(id, { value: structuredClone(value), principal, expiresAt: this.now() + 120_000, bytes: snapshotBytes, offsets: new Set() });
    }
    if (hasMore) this.pages.get(id).offsets.add(nextOffset);
    return { ...metadata, items: page, nextCursor: hasMore ? `${id}:${nextOffset}` : null, hasMore };
  }
}

module.exports = { AppStatePager, snapshot, sectionSummary, counts, sourceUnavailable,
  fields, text, number, timestamp, stateError, resourceRevision };
