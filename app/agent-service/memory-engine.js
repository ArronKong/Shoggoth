"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");
const { VIEW_HEADERS, EMPTY_VIEW_MESSAGES } = require("./agent-definition-defaults");

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*[^\s]{8,}/iu,
  /\b\d{6}\b.*(?:验证码|verification code|otp)|(?:验证码|verification code|otp).*\b\d{6}\b/iu,
]);
const PII_PATTERNS = Object.freeze([
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
]);
const CLASSIFICATIONS = new Set(["explicit", "imported"]);
const SENSITIVITY_RANK = Object.freeze({ normal: 0, private: 1, restricted: 2 });

function engineError(code, message) { return serviceError(code, message); }
function normalizeContent(value) { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(); }
function contentHash(value) { return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex"); }
function lexicalTerms(value) {
  const normalized = normalizeContent(value);
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = cjk.length <= 1 ? cjk : cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`);
  return new Set([...words, ...bigrams]);
}
function hasSecret(value) { return SECRET_PATTERNS.some((pattern) => pattern.test(value)); }
function hasPii(value) { return PII_PATTERNS.some((pattern) => pattern.test(value)); }
function workspaceMemoryRef(workspace) {
  return `workspace:${crypto.createHash("sha256").update(workspace || "").digest("hex")}`;
}
function boundedView(kind, items, render, maxBytes) {
  const header = VIEW_HEADERS[kind];
  if (items.length === 0) return header + EMPTY_VIEW_MESSAGES[kind];
  const omission = (count) => `\n[${count} additional records are stored; use memory_search to retrieve them.]\n`;
  // Reserve the footer before choosing whole entries. Never slice a UTF-8 note
  // or delete authoritative records merely because the Markdown view is full.
  let remaining = maxBytes - Buffer.byteLength(header + omission(items.length), "utf8");
  const lines = [];
  for (const item of items) {
    const line = `${render(item)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (size > remaining) continue;
    lines.push(line); remaining -= size;
  }
  return header + lines.join("") + (lines.length < items.length ? omission(items.length - lines.length) : "");
}

class MemoryEngine {
  constructor(options) {
    this.store = options.store;
    this.definitionStore = options.definitionStore || null;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.opened = false;
    this.viewsStale = new Set();
  }
  _assertOpen() { if (!this.opened) throw engineError("MEMORY_ENGINE_CLOSED", "Memory Engine 未打开"); }
  open(profileIds = []) {
    this.opened = true;
    for (const profileId of profileIds) {
      this.store.ensureProfile(profileId);
      this._rebuildViews(profileId);
    }
  }
  close() { this.opened = false; this.viewsStale.clear(); }
  _afterCommit(profileId) {
    try { this._rebuildViews(profileId); this.viewsStale.delete(profileId); }
    catch { this.viewsStale.add(profileId); }
  }
  _rebuildViews(profileId) {
    if (!this.definitionStore) return;
    const now = this.now();
    const active = this.store.list(profileId, { status: "active" })
      .filter((item) => item.validFrom <= now && (item.validUntil === null || item.validUntil > now));
    const revision = this.store.getRevision(profileId);
    const maxBytes = this.definitionStore.maxDocumentBytes ?? 32 * 1024;
    const memoryContent = boundedView("MEMORY", active, (item) => (
      `- [${item.scope}/${item.type}; confidence=${item.confidence.toFixed(2)}] ${item.content}`
    ), maxBytes);
    this.definitionStore.writeGeneratedView({
      profileId, kind: "MEMORY", revision, content: memoryContent,
    });
    const definition = this.definitionStore.get(profileId);
    if (!definition) return;
    const userItems = active.filter((item) => item.scope === "user" && item.sensitivity !== "restricted");
    const userContent = boundedView("USER", userItems, (item) => `- ${item.content}`, maxBytes);
    if (definition.documents.USER !== userContent) {
      this.definitionStore.update({
        profileId,
        expectedRevision: definition.manifest.revision,
        actor: "memory-engine",
        documents: { USER: userContent },
        reason: `memory-revision:${revision}`,
      });
    }
  }
  rebuildViews(profileId) { this._assertOpen(); this._rebuildViews(profileId); this.viewsStale.delete(profileId); }
  viewStatus(profileId) { return { stale: this.viewsStale.has(profileId), revision: this.store.getRevision(profileId) }; }

  propose(input) {
    this._assertOpen();
    if (!CLASSIFICATIONS.has(input?.classification)) throw engineError("MEMORY_INVALID", "Memory classification 无效");
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw engineError("MEMORY_INVALID", "Memory content 无效");
    }
    if (hasSecret(input.content)) throw engineError("MEMORY_SECRET_REJECTED", "Memory 拒绝保存 secret/验证码");
    const now = this.now();
    const sensitivity = hasPii(input.content) && (!input.sensitivity || input.sensitivity === "normal")
      ? "private" : input.sensitivity || "normal";
    if (!Object.hasOwn(SENSITIVITY_RANK, sensitivity)) throw engineError("MEMORY_INVALID", "Memory sensitivity 无效");
    if (sensitivity === "restricted") throw engineError("MEMORY_RESTRICTED", "Restricted Memory 不可保存");
    const status = "active";
    const duplicate = this.store.list(input.profileId).find((item) => (
      item.status === "active" && item.scope === input.scope && item.type === input.type
      && item.validUntil === (input.validUntil ?? null)
      && item.sensitivity === sensitivity
      && (!input.supersedes || item.supersedes === input.supersedes)
      && JSON.stringify(item.sourceRefs.filter((ref) => ref.startsWith("workspace:")))
        === JSON.stringify((input.sourceRefs || []).filter((ref) => ref.startsWith("workspace:")))
      && contentHash(item.content) === contentHash(input.content)
    ));
    if (duplicate) return duplicate;
    const item = {
      id: input.id || this.randomUUID(),
      profileId: input.profileId,
      scope: input.scope,
      type: input.type,
      content: input.content.trim(),
      sourceRefs: [...new Set(input.sourceRefs || [])],
      confidence: input.confidence ?? (input.classification === "explicit" ? 1 : 0.5),
      sensitivity,
      status,
      validFrom: input.validFrom ?? now,
      validUntil: input.validUntil ?? null,
      supersedes: input.supersedes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (item.sourceRefs.length === 0) throw engineError("MEMORY_SOURCE_REQUIRED", "Memory 必须有来源");
    if (item.supersedes !== null) {
      const prior = this.store.get(input.profileId, item.supersedes);
      if (!prior || prior.status !== "active" || prior.scope !== item.scope) {
        throw engineError("MEMORY_CONFLICT_INVALID", "supersedes 目标无效");
      }
      const superseded = { ...prior, status: "superseded", updatedAt: now };
      const [created] = this.store.upsertMany([item, superseded]);
      this._afterCommit(input.profileId);
      return created;
    }
    const created = this.store.upsert(item);
    this._afterCommit(input.profileId);
    return created;
  }

  update(input) {
    this._assertOpen();
    const item = this.store.get(input.profileId, input.id);
    if (!item || item.status === "deleted") throw engineError("MEMORY_NOT_FOUND", "Memory 不存在");
    const content = input.content ?? item.content;
    if (typeof content !== "string" || !content.trim()) throw engineError("MEMORY_INVALID", "Memory content 无效");
    if (hasSecret(content)) throw engineError("MEMORY_SECRET_REJECTED", "Memory 拒绝保存 secret/验证码");
    const updated = this.store.upsert({
      ...item,
      content,
      sourceRefs: input.sourceRef && item.sourceRefs.length < 64
        ? [...new Set([...item.sourceRefs, input.sourceRef])] : item.sourceRefs,
      sensitivity: hasPii(content) && item.sensitivity === "normal" ? "private" : item.sensitivity,
      confidence: input.confidence ?? item.confidence,
      validUntil: input.validUntil === undefined ? item.validUntil : input.validUntil,
      updatedAt: this.now(),
    });
    this._afterCommit(input.profileId);
    return updated;
  }

  delete(input) {
    this._assertOpen();
    const item = this.store.get(input.profileId, input.id);
    if (!item) return null;
    if (item.status === "deleted") return item;
    const deleted = this.store.upsert({ ...item, status: "deleted", updatedAt: this.now() });
    this._afterCommit(input.profileId);
    return deleted;
  }

  search(input) {
    this._assertOpen();
    const now = input.now ?? this.now();
    const queryTerms = lexicalTerms(input.query || "");
    const maxSensitivity = input.maxSensitivity || "normal";
    const allowedRank = SENSITIVITY_RANK[maxSensitivity];
    if (allowedRank === undefined) throw engineError("MEMORY_INVALID", "Memory search sensitivity 无效");
    const scopes = new Set(input.scopes || ["user", "agent", "project", "workspace"]);
    const maxItems = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const maxBytes = Math.min(Math.max(input.maxBytes ?? 16 * 1024, 256), 128 * 1024);
    const statuses = new Set(input.statuses || ["active"]);
    const scored = this.store.list(input.profileId)
      .filter((item) => statuses.has(item.status))
      .filter((item) => scopes.has(item.scope))
      .filter((item) => SENSITIVITY_RANK[item.sensitivity] <= allowedRank)
      .filter((item) => item.validFrom <= now)
      .filter((item) => item.validUntil === null || item.validUntil > now)
      .filter((item) => input.workspace === undefined || !["project", "workspace"].includes(item.scope)
        || item.sourceRefs.includes(workspaceMemoryRef(input.workspace)))
      .map((item) => {
        const terms = lexicalTerms(item.content);
        const overlap = [...queryTerms].filter((term) => terms.has(term)).length;
        const relevance = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
        const ageDays = Math.max(0, now - item.updatedAt) / 86_400_000;
        const recency = 1 / (1 + ageDays / 30);
        return { item, overlap, score: relevance * 0.7 + item.confidence * 0.2 + recency * 0.1 };
      })
      .filter((entry) => queryTerms.size === 0 || entry.overlap > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id));
    const results = [];
    let bytes = 0;
    for (const entry of scored) {
      const projected = { ...entry.item, score: Number(entry.score.toFixed(6)) };
      const size = Buffer.byteLength(JSON.stringify(projected), "utf8");
      if (results.length >= maxItems) break;
      if (bytes + size > maxBytes) continue;
      results.push(projected); bytes += size;
    }
    return { revision: this.store.getRevision(input.profileId), items: results, truncated: results.length < scored.length };
  }

  extractTranscript(input) {
    this._assertOpen();
    const proposals = [];
    for (const event of input.events || []) {
      if (event.kind !== "user" || event.contextExcluded || typeof event.content?.text !== "string") continue;
      const text = event.content.text.trim();
      const explicit = text.match(/^(?:请记住|记住)\s*[:：]?\s*(.+)$/u);
      if (!explicit?.[1]) continue;
      proposals.push(this.propose({
        profileId: input.profileId,
        scope: "user",
        type: "semantic",
        content: explicit[1].trim(),
        sourceRefs: [event.id],
        classification: "explicit",
        confidence: 1,
      }));
    }
    return proposals;
  }

  consolidate(profileId) {
    this._assertOpen();
    const now = this.now();
    const changes = [];
    for (const item of this.store.list(profileId, { status: "active" })) {
      if (item.validUntil !== null && item.validUntil <= now) {
        changes.push({ ...item, status: "deleted", updatedAt: now });
      }
    }
    if (changes.length > 0) this.store.upsertMany(changes);
    this._afterCommit(profileId);
    return changes.length;
  }

  importCodexNative(input) {
    this._assertOpen();
    const root = path.resolve(input.root);
    let stat;
    try { stat = fs.lstatSync(root); } catch (error) { if (error.code === "ENOENT") return { imported: 0 }; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw engineError("MEMORY_IMPORT_UNSAFE", "Codex memory root 不安全");
    const files = fs.readdirSync(root).filter((name) => /\.(?:md|txt|json)$/iu.test(name)).sort().slice(0, 1_000);
    let imported = 0;
    for (const name of files) {
      const target = path.join(root, name);
      const fileStat = fs.lstatSync(target);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 1024 * 1024) continue;
      const content = fs.readFileSync(target, "utf8").trim();
      if (!content || hasSecret(content)) continue;
      const before = this.store.list(input.profileId).length;
      this.propose({
        profileId: input.profileId,
        scope: "agent",
        type: "semantic",
        content: content.slice(0, 8 * 1024),
        sourceRefs: [`codex-memory:${contentHash(`${name}\0${content}`).slice(0, 32)}`],
        classification: "imported",
        confidence: 0.5,
      });
      if (this.store.list(input.profileId).length > before) imported += 1;
    }
    return { imported };
  }
}

module.exports = { MemoryEngine, contentHash, hasPii, hasSecret, lexicalTerms, workspaceMemoryRef };
