"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");
const { VIEW_HEADERS, EMPTY_VIEW_MESSAGES } = require("./agent-definition-defaults");
const { RecallPolicyStore } = require("./recall-policy-store");

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b\d{6}\b.*(?:验证码|verification code|otp)|(?:验证码|verification code|otp).*\b\d{6}\b/iu,
]);
const ASSIGNED_SECRET = /\b(?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*([^\r\n]{8,})/giu;
const ENV_NAME = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+')`;
const ENV_LOOKUP = String.raw`(?:os\.environ\[${ENV_NAME}\]|os\.environ\.get\(${ENV_NAME}\)|os\.getenv\(${ENV_NAME}\)|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[${ENV_NAME}\])|Deno\.env\.get\(${ENV_NAME}\)|System\.getenv\(${ENV_NAME}\)|getenv\(${ENV_NAME}\))`;
const ENV_REFERENCE = new RegExp(
  String.raw`^${ENV_LOOKUP}(?:\s*(?:\bor\b|\|\||\?\?)\s*${ENV_LOOKUP})*(?:;)?$`,
  "u",
);
const ARG_REFERENCE = /^(?:argv|process\.argv)\[[A-Za-z_][A-Za-z0-9_]*\];?$/u;
// The one audited frozen GWAS helper derives this token from a response row.
// Pin the entire file so a different script cannot use the same expression to
// conceal an embedded credential through an alias or fallback.
const GWAS_EFFECT_TOKEN = /^token\s*=\s*str\(effect\[0\]\)$/iu;
const FROZEN_GWAS_HELPER_SHA256 = "9844fcad187346a045712ef2975691f20028308349c9f772b5c13065248cb543";
function isAuditedGwasEffectToken(value, match) {
  return GWAS_EFFECT_TOKEN.test(match[0].trim())
    && crypto.createHash("sha256").update(value).digest("hex") === FROZEN_GWAS_HELPER_SHA256;
}
// A plugin's `${secret:NAME}` reference names a credential and is never a value;
// documentation placeholders such as `Bearer <token>` cannot carry one either.
// The assignment pattern consumes the rest of the line, so whatever follows a
// placeholder is checked again rather than exempted with it.
const SECRET_REFERENCE_TAIL = /^secret:[A-Z][A-Z0-9_]{0,63}\}/u;
const PLACEHOLDER_VALUE = /^["'`]?(?:Bearer\s+)?(?:\$\{secret:[A-Z][A-Z0-9_]{0,63}\}|<[A-Za-z][A-Za-z _-]{0,40}>|\*{3,}|x{3,}(?:\.{2,}y{3,})?|X{3,})["'`]?(?=$|[\s,;)，。、；：）])/u;
function placeholderRest(value, match) {
  if (value.slice(Math.max(0, match.index - 2), match.index) === "${") {
    const tail = SECRET_REFERENCE_TAIL.exec(value.slice(match.index));
    if (tail) return match[0].slice(tail[0].length);
  }
  const assigned = match[1].trimStart();
  const placeholder = PLACEHOLDER_VALUE.exec(assigned);
  return placeholder ? assigned.slice(placeholder[0].length) : null;
}
function isRegexKeyAlternative(value, match) {
  // `/...token=|.../` matches a query-string key, not an assigned value.
  // Only skip an empty regex alternative; a literal after `token=` remains
  // subject to the ordinary secret-assignment check.
  const lineStart = value.lastIndexOf("\n", match.index) + 1;
  return /\/\(\?:[^/]*$/u.test(value.slice(lineStart, match.index))
    && match[1].trimStart().startsWith("|");
}
const PII_PATTERNS = Object.freeze([
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
]);
const CLASSIFICATIONS = new Set(["explicit", "imported"]);
const SENSITIVITY_RANK = Object.freeze({ normal: 0, private: 1, restricted: 2 });
// Facts about the user and their projects are shared by every Agent of the
// same owner; "agent" scope stays private to the Agent that saved it.
const SHARED_SCOPES = new Set(["user", "project", "workspace"]);
const REVIEWED_MEMORY_ID = /^reviewed-(mc-[a-f0-9]{64})$/u;

function engineError(code, message) { return serviceError(code, message); }
function normalizeContent(value) { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(); }
function boundedImportContent(value, maxBytes = 8 * 1024) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character; bytes += size;
  }
  return result.trim();
}
function contentHash(value) { return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex"); }
function lexicalTerms(value) {
  const normalized = normalizeContent(value);
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = cjk.length <= 1 ? cjk : cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`);
  return new Set([...words, ...bigrams]);
}
const HOT_PREFERENCE_PATTERN = /偏好|喜欢|希望|习惯|称呼|回复风格|prefer|preference|usually|always/iu;
const HOT_AGREEMENT_PATTERN = /约定|决定|现阶段|必须|规则|agreement|decision|must/iu;
// Importance the user stated in the fact itself.
const HOT_IMPORTANCE_PATTERN = /重要|务必|一定要|千万|切记|important|critical|never forget/iu;
function hotPriorityFlags(item) {
  // This ordering is used only by ContextCompiler's empty-query candidate
  // search. It must happen before the result cap, or an older durable fact can
  // be displaced by newer episodic records before context ranking sees it.
  return (HOT_IMPORTANCE_PATTERN.test(item.content) ? 8 : 0)
    + (item.scope === "user" && HOT_PREFERENCE_PATTERN.test(item.content) ? 4 : 0)
    + (HOT_AGREEMENT_PATTERN.test(item.content) || item.type === "procedural" ? 2 : 0)
    + (["project", "workspace"].includes(item.scope) ? 1 : 0);
}
// A fact that applies only under a stated condition ("写提交信息时，…",
// "When reviewing …") is recalled when the request matches it, not on every turn.
const CONDITIONAL_PATTERN = /^(?:用户)?(?:如果|假如|每当|当(?!前).{0,40}?(?:的时候|时))|(?:的时候|时)[，,、]|^(?:the user,?\s+)?(?:when|whenever|if)\b/iu;
function isConditionalMemory(item) { return CONDITIONAL_PATTERN.test(item.content); }
const TRUST_RANK = Object.freeze({ owner: 3, system: 2, agent: 1, untrusted: 0 });
function hasSecret(value) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // A helper that reads an environment variable or a CLI argument does not
  // embed its runtime value. Keep rejecting literal/fallback assignments while
  // allowing verified Skill scripts to name external credential inputs.
  return [...value.matchAll(ASSIGNED_SECRET)].some((match) => {
    const assigned = match[1].trim();
    if (isRegexKeyAlternative(value, match) || ENV_REFERENCE.test(assigned) || ARG_REFERENCE.test(assigned)
      || isAuditedGwasEffectToken(value, match)) return false;
    const rest = placeholderRest(value, match);
    return rest === null || hasSecret(rest);
  });
}
function hasPii(value) { return PII_PATTERNS.some((pattern) => pattern.test(value)); }
// Trust tier of a stored fact, derived only from source refs the Service sets.
// owner: written or confirmed by the user; system: imported, or consolidated
// by Shoggoth in the background from the user's own words; agent: saved by an
// Agent in a direct conversation; untrusted: kept for the user to confirm, and
// never recalled by Agents, injected or shared.
const UNTRUSTED_REF_PREFIX = "untrusted:";
const CONSOLIDATED_REF = "consolidated:auto";
function memoryTrust(item) {
  const refs = item.sourceRefs;
  if (refs.some((ref) => ref.startsWith(UNTRUSTED_REF_PREFIX))) return "untrusted";
  if (refs.includes(CONSOLIDATED_REF)) return "system";
  if (REVIEWED_MEMORY_ID.test(item.id) || refs.some((ref) => ref.startsWith("user-edit:"))) return "owner";
  if (refs.some((ref) => ref.startsWith("codex-memory:"))) return "system";
  return "agent";
}
// An Agent's saved fact must reuse at least one word of the user's quoted
// message; otherwise the quote does not support it. English words also match
// by a shared stem of four or more letters ("prefer" ~ "prefers").
function quoteSupportsContent(quote, content) {
  const quoted = [...lexicalTerms(quote)];
  return [...lexicalTerms(content)].some((term) => quoted.some((word) => word === term
    || (/^[a-z]{4,}$/u.test(word) && /^[a-z]{4,}$/u.test(term) && (word.startsWith(term) || term.startsWith(word)))));
}
function workspaceMemoryRef(workspace) {
  return `workspace:${crypto.createHash("sha256").update(workspace || "").digest("hex")}`;
}
// A project is the git repository a workspace belongs to, so every worktree
// and subdirectory of one clone shares its project memory. The key is the
// repository's common git directory; a directory outside git has none.
const repositoryKeys = new Map();
function repositoryKey(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return null;
  if (repositoryKeys.has(workspace)) return repositoryKeys.get(workspace);
  let key = null;
  try {
    for (let dir = workspace; ; dir = path.dirname(dir)) {
      const marker = path.join(dir, ".git");
      const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
      if (stat?.isDirectory()) { key = fs.realpathSync(marker); break; }
      if (stat?.isFile()) {
        const gitdir = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(marker, "utf8"))?.[1]?.trim();
        if (!gitdir) break;
        const resolved = path.resolve(dir, gitdir);
        const common = fs.readFileSync(path.join(resolved, "commondir"), { encoding: "utf8", flag: "r" }).trim();
        key = fs.realpathSync(path.resolve(resolved, common));
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch { key = null; }
  if (repositoryKeys.size >= 256) repositoryKeys.clear();
  repositoryKeys.set(workspace, key);
  return key;
}
// Refs a new fact of this scope carries: a project fact also names its
// repository; a workspace fact stays with its exact directory.
function workspaceMemoryRefs(workspace, scope) {
  const key = scope === "project" ? repositoryKey(workspace) : null;
  return [workspaceMemoryRef(workspace), ...(key ? [workspaceMemoryRef(`git:${key}`)] : [])];
}
// A project/workspace fact belongs to the current workspace when it carries
// the directory's ref or, for older and newer facts alike, its repository's.
function matchesWorkspace(item, workspace) {
  return workspaceMemoryRefs(workspace, "project").some((ref) => item.sourceRefs.includes(ref));
}
// The same fact held by two Agents: scope, normalized content and workspace.
function sameFactKey(item) {
  return JSON.stringify([item.scope, contentHash(item.content),
    item.sourceRefs.filter((ref) => ref.startsWith("workspace:")).sort()]);
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
    this.transcriptStore = options.transcriptStore || null;
    this.chatSessionStore = options.chatSessionStore || null;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.recallPolicy = options.recallPolicy || new RecallPolicyStore({
      paths: this.store.paths, memoryStore: this.store, now: this.now, randomUUID: this.randomUUID,
      transcriptStore: options.transcriptStore, chatSessionStore: options.chatSessionStore,
      strictSourceResolution: options.strictSourceResolution,
    });
    this.opened = false;
    this.viewsStale = new Set();
    this.searchViews = new Map();
    this.reviewReceiptStore = options.reviewReceiptStore || null;
    this.reviewSourceVerifier = null;
    this.provenanceService = options.provenanceService || null;
    // Returns every Agent profile id that shares memory with the others.
    this.sharedProfiles = typeof options.sharedProfiles === "function" ? options.sharedProfiles : null;
    this.sharedViews = new Map();
    this.combinedViews = new Map();
  }
  _assertOpen() { if (!this.opened) throw engineError("MEMORY_ENGINE_CLOSED", "Memory Engine 未打开"); }
  setReviewReceiptStore(store) {
    if (!store || typeof store.get !== "function") throw new TypeError("Memory review receipt store 无效");
    this.reviewReceiptStore = store;
    this.searchViews.clear();
  }
  setReviewSourceVerifier(verify) {
    if (typeof verify !== "function") throw new TypeError("Memory review source verifier 无效");
    this.reviewSourceVerifier = verify;
  }
  setProvenanceService(service) {
    if (!service || typeof service.recordImport !== "function") {
      throw new TypeError("Memory provenance service 无效");
    }
    this.provenanceService = service;
  }
  _reviewState(profileId) {
    try { return this.reviewReceiptStore?.get(profileId) ?? null; }
    catch { return null; }
  }
  _reviewCommitted(item, reviewState) {
    const match = REVIEWED_MEMORY_ID.exec(item.id);
    if (!match) return true;
    const candidate = reviewState?.candidates?.[match[1]];
    if (!candidate || candidate.profileId !== item.profileId
      || candidate.status !== "accepted" || candidate.acceptedMemoryId !== item.id
      || candidate.content !== item.content || candidate.scope !== item.scope
      || candidate.sensitivity !== item.sensitivity
      || !item.sourceRefs.includes(candidate.source.eventId)
      || !item.sourceRefs.includes(candidate.source.runId)) return false;
    if (["project", "workspace"].includes(item.scope)
      && !item.sourceRefs.includes(workspaceMemoryRef(candidate.source.workspace))) return false;
    return true;
  }
  _reviewSourceCurrent(profileId, item, reviewState = null) {
    const match = REVIEWED_MEMORY_ID.exec(item.id);
    if (!match) return true;
    const state = reviewState ?? this._reviewState(profileId);
    if (!this._reviewCommitted(item, state) || !this.reviewSourceVerifier) return false;
    try { return this.reviewSourceVerifier(profileId, state.candidates[match[1]]) === true; }
    catch { return false; }
  }
  _quarantineUnreceiptedReviewed(profileId) {
    const receipt = this._reviewState(profileId);
    const exposed = this.store.list(profileId, { status: "active" })
      .filter((item) => REVIEWED_MEMORY_ID.test(item.id) && !this._reviewCommitted(item, receipt));
    for (let offset = 0; offset < exposed.length; offset += 128) {
      this.store.upsertMany(exposed.slice(offset, offset + 128).map((item) => ({
        ...item, status: "candidate", updatedAt: Math.max(item.updatedAt, this.now()),
      })));
    }
    if (exposed.length) this.searchViews.delete(profileId);
  }
  isReviewCommitted(profileId, item) {
    if (!item || item.profileId !== profileId) return false;
    return this._reviewSourceCurrent(profileId, item);
  }
  isReviewReceipted(profileId, item) {
    if (!item || item.profileId !== profileId) return false;
    return this._reviewCommitted(item, this._reviewState(profileId));
  }
  quarantineInvalidReviewed(profileId) {
    this._assertOpen();
    const state = this._reviewState(profileId);
    const invalid = this.store.list(profileId, { status: "active" })
      .filter((item) => REVIEWED_MEMORY_ID.test(item.id)
        && !this._reviewSourceCurrent(profileId, item, state));
    for (let offset = 0; offset < invalid.length; offset += 128) {
      this.store.upsertMany(invalid.slice(offset, offset + 128).map((item) => ({
        ...item, status: "candidate", updatedAt: Math.max(item.updatedAt, this.now()),
      })));
    }
    if (invalid.length) this._afterCommit(profileId);
    return invalid.length;
  }
  open(profileIds = []) {
    this.opened = true;
    try {
      this.recallPolicy.open(profileIds);
      for (const profileId of profileIds) {
        this.store.ensureProfile(profileId);
        this._quarantineUnreceiptedReviewed(profileId);
        try { this._rebuildViews(profileId); }
        catch (error) {
          if (error.code !== "RECALL_POLICY_UNAVAILABLE") throw error;
          this.viewsStale.add(profileId);
        }
      }
    } catch (error) { this.recallPolicy.close(); this.opened = false; throw error; }
  }
  close() {
    this.opened = false;
    this.viewsStale.clear();
    this.searchViews.clear();
    this.sharedViews.clear();
    this.combinedViews.clear();
    this.recallPolicy.close();
  }
  forgetProfile(profileId) {
    // Retention may finish a previously journaled purge while the Service is
    // running. Drop cached plaintext alongside the Profile's persistent data.
    this.viewsStale.delete(profileId);
    this.searchViews.delete(profileId);
    this.sharedViews.clear();
    this.combinedViews.clear();
    this.semanticSearch?.forgetProfile(profileId);
  }
  setSemanticSearchService(service) { this.semanticSearch = service; }
  _afterCommit(profileId) {
    this.searchViews.delete(profileId);
    try { this._rebuildViews(profileId); this.viewsStale.delete(profileId); }
    catch { this.viewsStale.add(profileId); }
    // Peers' generated USER/MEMORY views include this Agent's shared items.
    for (const peer of this._peers(profileId)) {
      try { this._rebuildViews(peer); this.viewsStale.delete(peer); }
      catch { this.viewsStale.add(peer); }
    }
    try { this.semanticSearch?.scheduleMemory(profileId); } catch {}
  }
  _activeView(profileId) {
    const revision = this.store.getRevision(profileId);
    const cached = this.searchViews.get(profileId);
    const priorReviewState = cached?.hasReviewed ? this._reviewState(profileId) : null;
    if (cached?.revision === revision && (!cached.hasReviewed
      || cached.reviewChecksum === (priorReviewState?.checksum ?? null))) return cached;
    const active = this.store.list(profileId, { status: "active" });
    const hasReviewed = active.some((item) => REVIEWED_MEMORY_ID.test(item.id));
    const reviewState = hasReviewed ? priorReviewState ?? this._reviewState(profileId) : null;
    const documents = active.filter((item) => this._reviewCommitted(item, reviewState)
      && memoryTrust(item) !== "untrusted").map((item) => ({
      item, terms: lexicalTerms(item.content), normalized: normalizeContent(item.content),
    }));
    const postings = new Map();
    for (let index = 0; index < documents.length; index += 1) {
      for (const term of documents[index].terms) {
        if (!postings.has(term)) postings.set(term, []);
        postings.get(term).push(index);
      }
    }
    const view = { revision, reviewChecksum: reviewState?.checksum ?? null,
      hasReviewed, documents, postings, positions: new Map(documents.map((entry, index) => [entry.item.id, index])) };
    this.searchViews.set(profileId, view);
    return view;
  }
  _peers(profileId) {
    if (!this.sharedProfiles) return [];
    let ids;
    try { ids = this.sharedProfiles(); } catch { return []; }
    return [...new Set(Array.isArray(ids) ? ids : [])]
      .filter((id) => typeof id === "string" && id !== profileId).sort();
  }
  // Shared-scope active items of the other Agents, each checked against its own
  // Agent's recall policy and review receipt. The viewer's policy is applied by
  // callers so content forgotten through this Agent never reappears via a peer.
  // A damaged peer is skipped; it never breaks this Agent's own memory.
  _peerEntries(profileId) {
    const peers = [];
    for (const home of this._peers(profileId)) {
      try {
        const view = this._activeView(home);
        peers.push({ home, view, key: [home, view.revision, view.reviewChecksum,
          this.recallPolicy.getRevision(home), this.recallPolicy.getHistoricalVisibilityRevision?.(home) ?? null] });
      } catch {}
    }
    const key = JSON.stringify(peers.map((peer) => peer.key));
    const cached = this.sharedViews.get(profileId);
    if (cached?.key === key) return cached.entries;
    const entries = [];
    for (const { home, view } of peers) {
      try {
        const policy = this.recallPolicy.snapshot(home);
        const reviewState = view.hasReviewed ? this._reviewState(home) : null;
        for (const entry of view.documents) {
          if (SHARED_SCOPES.has(entry.item.scope) && policy.isMemoryVisible(entry.item)
            && this._reviewSourceCurrent(home, entry.item, reviewState)) entries.push({ ...entry, home });
        }
      } catch {}
    }
    this.sharedViews.set(profileId, { key, entries });
    return entries;
  }
  // Own active documents first, then peer documents whose scope and content do
  // not duplicate an earlier one. Peers stay invisible when sharing is off.
  _visibleDocuments(profileId, policy) {
    const own = this._activeView(profileId).documents.map((entry) => ({ ...entry, home: profileId }));
    const seen = new Set(own.map(({ item }) => `${item.scope}\0${contentHash(item.content)}`));
    const shared = [];
    for (const entry of this._peerEntries(profileId)) {
      const key = `${entry.item.scope}\0${contentHash(entry.item.content)}`;
      if (seen.has(key) || !policy.isForeignMemoryVisible(entry.item)) continue;
      seen.add(key); shared.push(entry);
    }
    return { own, shared };
  }
  // Search view over own documents (unchanged indices) plus peers' shared ones.
  _searchView(profileId, policy) {
    const own = this._activeView(profileId);
    if (this._peerEntries(profileId).length === 0) return own;
    const key = JSON.stringify([own.revision, own.reviewChecksum, this.sharedViews.get(profileId)?.key ?? null,
      this.recallPolicy.getRevision(profileId), this.recallPolicy.getHistoricalVisibilityRevision?.(profileId) ?? null]);
    const cached = this.combinedViews.get(profileId);
    if (cached?.key === key) return cached.view;
    const { shared } = this._visibleDocuments(profileId, policy);
    const documents = [...own.documents, ...shared];
    const postings = new Map();
    for (let index = 0; index < documents.length; index += 1) {
      for (const term of documents[index].terms) {
        if (!postings.has(term)) postings.set(term, []);
        postings.get(term).push(index);
      }
    }
    const view = { ...own, documents, postings };
    this.combinedViews.set(profileId, { key, view });
    return view;
  }
  // A peer's shared item as this Agent may read it, or null.
  findSharedItem(profileId, id) {
    this._assertOpen();
    const policy = this.recallPolicy.snapshot(profileId);
    const entry = this._peerEntries(profileId).find(({ item }) => item.id === id);
    return entry && policy.isForeignMemoryVisible(entry.item) ? { home: entry.home, item: structuredClone(entry.item) } : null;
  }
  // A shared fact this Agent already sees with the same scope, content, expiry
  // and workspace. Restating it to this Agent must not store a second copy
  // that would outlive a forget of the first.
  findSharedDuplicate(profileId, { scope, content, validUntil = null, sourceRefs = [] }) {
    this._assertOpen();
    const workspaceRefs = (refs) => JSON.stringify(refs.filter((ref) => ref.startsWith("workspace:")));
    const hash = contentHash(content), workspace = workspaceRefs(sourceRefs);
    const { shared } = this._visibleDocuments(profileId, this.recallPolicy.snapshot(profileId));
    const entry = shared.find(({ item }) => item.scope === scope && item.validUntil === validUntil
      && contentHash(item.content) === hash && workspaceRefs(item.sourceRefs) === workspace);
    return entry ? structuredClone(entry.item) : null;
  }
  // Recheck of an item already shown to this Agent: its own items need this
  // Agent's review receipt; another Agent's item must still be shared with it
  // and still be committed at its home Agent.
  isRecallCommitted(profileId, item) {
    if (!item || typeof item.profileId !== "string" || !Array.isArray(item.sourceRefs)
      || memoryTrust(item) === "untrusted") return false;
    if (item.profileId === profileId) return this.isReviewCommitted(profileId, item);
    const shared = this.findSharedItem(profileId, item.id);
    return shared?.home === item.profileId && shared.item.content === item.content
      && this.isReviewCommitted(shared.home, shared.item);
  }
  listShared(profileId, { limit = 500 } = {}) {
    this._assertOpen();
    const { shared } = this._visibleDocuments(profileId, this.recallPolicy.snapshot(profileId));
    // The editor writes a shared item through its home Agent at that revision.
    const rows = shared.map(({ item, home }) => ({ item: structuredClone(item), homeProfileId: home,
      homeRevision: this.store.getRevision(home) }))
      .sort((a, b) => b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id));
    return { items: rows.slice(0, limit), truncated: rows.length > limit };
  }
  semanticStamp(profileId) {
    this._assertOpen(); this.recallPolicy.assertReady(profileId);
    const view = this._activeView(profileId);
    return crypto.createHash("sha256").update(JSON.stringify([view.revision, view.reviewChecksum,
      this.recallPolicy.getRevision(profileId), this.recallPolicy.getHistoricalVisibilityRevision?.(profileId) ?? null,
      this.transcriptStore?.getChangeRevision?.(profileId) ?? null,
      this.chatSessionStore?.getRevision?.() ?? null])).digest("hex");
  }
  semanticDocuments(profileId) {
    this._assertOpen();
    const policy = this.recallPolicy.snapshot(profileId);
    const view = this._activeView(profileId);
    const reviewState = view.hasReviewed ? this._reviewState(profileId) : null;
    return view.documents.filter(({ item }) => policy.isMemoryVisible(item)
      && this._reviewSourceCurrent(profileId, item, reviewState)
      && item.sensitivity !== "restricted" && !hasSecret(item.content)).map(({ item }) => ({
      id: crypto.createHash("sha256").update(`memory\0${item.id}`).digest("hex"),
      text: item.content, contentHash: crypto.createHash("sha256").update(item.content).digest("hex"),
      source: { sourceId: item.id, language: require("./memory-semantic-ranking").sourceLanguage(item.content),
        scope: item.scope, sensitivity: item.sensitivity === "private" ? 1 : 0,
        validFrom: item.validFrom, validUntil: item.validUntil, workspace: null,
        workspaceRefs: item.sourceRefs.filter(ref => ref.startsWith("workspace:")), occurredAt: item.updatedAt },
    }));
  }
  _rebuildViews(profileId) {
    if (!this.definitionStore) return;
    const now = this.now();
    const policy = this.recallPolicy.snapshot(profileId);
    const { own, shared } = this._visibleDocuments(profileId, policy);
    const active = [...own.map((entry) => entry.item)
      .filter((item) => this._reviewSourceCurrent(profileId, item))
      .filter((item) => policy.isMemoryVisible(item)), ...shared.map((entry) => entry.item)]
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
    this.recallPolicy.assertReady(input.profileId);
    if (!this.recallPolicy.isSourceVisible(input.profileId, input.sourceRefs || [])) {
      throw engineError("MEMORY_SOURCE_REVOKED", "已撤回的来源不能重新保存为记忆");
    }
    if (!CLASSIFICATIONS.has(input?.classification)) throw engineError("MEMORY_INVALID", "Memory classification 无效");
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw engineError("MEMORY_INVALID", "Memory content 无效");
    }
    if (input.classification === "imported"
      && this.recallPolicy.hasRevokedContent(input.profileId, input.content)) {
      throw engineError("MEMORY_SOURCE_REVOKED", "已撤回的内容不能从导入资料重新提炼");
    }
    if (hasSecret(input.content)) throw engineError("MEMORY_SECRET_REJECTED", "Memory 拒绝保存 secret/验证码");
    const now = this.now();
    const sensitivity = hasPii(input.content) && (!input.sensitivity || input.sensitivity === "normal")
      ? "private" : input.sensitivity || "normal";
    if (!Object.hasOwn(SENSITIVITY_RANK, sensitivity)) throw engineError("MEMORY_INVALID", "Memory sensitivity 无效");
    if (sensitivity === "restricted") throw engineError("MEMORY_RESTRICTED", "Restricted Memory 不可保存");
    const status = "active";
    const untrustedInput = (input.sourceRefs || []).some((ref) => ref.startsWith(UNTRUSTED_REF_PREFIX));
    const duplicate = this.store.list(input.profileId).find((item) => (
      item.status === "active" && this.recallPolicy.isMemoryVisible(input.profileId, item)
      && (untrustedInput || memoryTrust(item) !== "untrusted")
      && this._reviewSourceCurrent(input.profileId, item)
      && item.scope === input.scope && item.type === input.type
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
      if (!prior || prior.status !== "active" || prior.scope !== item.scope
        || !this.recallPolicy.isMemoryVisible(input.profileId, prior)) {
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

  // Review-only batch: persist a non-visible intent before the review receipt.
  proposeReviewedBatch({ profileId, proposals, expectedRevision }) {
    this._assertOpen();
    if (!this.reviewReceiptStore) {
      throw engineError("MEMORY_REVIEW_RECEIPT_UNAVAILABLE", "审核回执不可用，不能激活候选记忆");
    }
    if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > 100
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || new Set(proposals.map((proposal) => proposal?.id)).size !== proposals.length) {
      throw engineError("MEMORY_INVALID", "批量审核记忆参数无效");
    }
    this.recallPolicy.assertReady(profileId);
    if (this.store.getRevision(profileId) !== expectedRevision) {
      throw engineError("MEMORY_REVISION_CONFLICT", "记忆已变化，请重新审阅候选");
    }
    const existing = this.store.list(profileId, { status: "active" });
    const now = this.now();
    const prepared = [];
    const duplicateKey = (item) => JSON.stringify([item.scope, contentHash(item.content)]);
    const duplicateKeys = new Set(existing.filter((item) => this.recallPolicy.isMemoryVisible(profileId, item))
      .map(duplicateKey));
    const replaced = new Set();
    for (const proposal of proposals) {
      if (!proposal || proposal.profileId !== profileId || proposal.classification !== "imported"
        || proposal.type !== "semantic"
        || (proposal.supersedes !== undefined && proposal.supersedes !== null && typeof proposal.supersedes !== "string")
        || proposal.validFrom !== undefined || proposal.validUntil !== undefined
        || typeof proposal.content !== "string" || !proposal.content.trim()
        || !Array.isArray(proposal.sourceRefs) || proposal.sourceRefs.length === 0
        || !["user", "project", "workspace"].includes(proposal.scope)) {
        throw engineError("MEMORY_INVALID", "批量审核记忆内容无效");
      }
      if (!this.recallPolicy.isSourceVisible(profileId, proposal.sourceRefs)
        || this.recallPolicy.hasRevokedContent(profileId, proposal.content)) {
        throw engineError("MEMORY_SOURCE_REVOKED", "已撤回的来源不能重新保存为记忆");
      }
      if (hasSecret(proposal.content)) throw engineError("MEMORY_SECRET_REJECTED", "Memory 拒绝保存 secret/验证码");
      const sensitivity = hasPii(proposal.content) && (!proposal.sensitivity || proposal.sensitivity === "normal")
        ? "private" : proposal.sensitivity || "normal";
      if (!Object.hasOwn(SENSITIVITY_RANK, sensitivity)) throw engineError("MEMORY_INVALID", "Memory sensitivity 无效");
      if (sensitivity === "restricted") throw engineError("MEMORY_RESTRICTED", "Restricted Memory 不可保存");
      if (this.store.get(profileId, proposal.id)) throw engineError("MEMORY_CONFLICT_INVALID", "记忆 ID 已存在");
      // A consolidated fact may replace one of this Agent's own active facts of
      // the same scope; activation retires it in the same journal batch.
      if (proposal.supersedes) {
        const target = this.store.get(profileId, proposal.supersedes);
        if (!target || target.status !== "active" || target.scope !== proposal.scope
          || memoryTrust(target) === "untrusted" || replaced.has(target.id)
          || !this.recallPolicy.isMemoryVisible(profileId, target)) {
          throw engineError("MEMORY_CONFLICT_INVALID", "supersedes 目标无效");
        }
        replaced.add(target.id);
      }
      const item = {
        id: proposal.id, profileId, scope: proposal.scope, type: "semantic",
        content: proposal.content.trim(), sourceRefs: [...new Set(proposal.sourceRefs)],
        confidence: 0.5, sensitivity, status: "candidate",
        validFrom: now, validUntil: null, supersedes: proposal.supersedes || null,
        createdAt: now, updatedAt: now,
      };
      const key = duplicateKey(item);
      if (duplicateKeys.has(key)) throw engineError("MEMORY_CONFLICT_INVALID", "已有同内容的 active 记忆");
      duplicateKeys.add(key);
      prepared.push(item);
    }
    const created = this.store.upsertMany(prepared, { expectedRevision });
    // Candidate status is invisible even to older App versions. The accepted
    // review receipt authorizes a second journal batch that activates it.
    this.searchViews.delete(profileId);
    this.viewsStale.add(profileId);
    return created;
  }

  publishReviewedCommit(profileId) {
    this._assertOpen();
    this._afterCommit(profileId);
    return this.viewStatus(profileId);
  }

  activateReviewedBatch({ profileId, memoryIds, expectedRevision, verifySources }) {
    this._assertOpen();
    if (!Array.isArray(memoryIds) || memoryIds.length < 1 || memoryIds.length > 100
      || new Set(memoryIds).size !== memoryIds.length
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || typeof verifySources !== "function") {
      throw engineError("MEMORY_INVALID", "候选记忆激活参数无效");
    }
    this.recallPolicy.assertReady(profileId);
    if (this.store.getRevision(profileId) !== expectedRevision) {
      throw engineError("MEMORY_REVISION_CONFLICT", "记忆已变化，请重新审阅候选");
    }
    const receipt = this._reviewState(profileId);
    const items = memoryIds.map((id) => this.store.get(profileId, id));
    if (items.some((item) => !item || !this._reviewCommitted(item, receipt)
      || !this.recallPolicy.isSourceVisible(profileId, item.sourceRefs)
      || this.recallPolicy.hasRevokedContent(profileId, item.content))) {
      throw engineError("MEMORY_SOURCE_REVOKED", "候选审核来源或回执已失效");
    }
    if (items.every((item) => item.status === "active")) {
      if (this.viewsStale.has(profileId)) this._afterCommit(profileId);
      return items;
    }
    if (items.some((item) => item.status !== "candidate")) {
      throw engineError("MEMORY_CONFLICT_INVALID", "候选记忆状态不一致");
    }
    const duplicateKey = (item) => JSON.stringify([item.scope, contentHash(item.content)]);
    const activeKeys = new Set(this.store.list(profileId, { status: "active" })
      .filter((item) => this.recallPolicy.isMemoryVisible(profileId, item))
      .map(duplicateKey));
    if (items.some((item) => activeKeys.has(duplicateKey(item)))) {
      throw engineError("MEMORY_CONFLICT_INVALID", "已有同内容的 active 记忆");
    }
    // The accepted receipt is written before activation so a crash can be
    // reconciled. Recheck the original events at the actual active commit
    // boundary: an earlier review check may have read a journal that has since
    // disappeared or been revoked.
    try {
      if (verifySources(items) !== true) {
        throw engineError("MEMORY_SOURCE_REVOKED", "候选审核来源或回执已失效");
      }
    } catch {
      throw engineError("MEMORY_SOURCE_REVOKED", "候选审核来源或回执已失效");
    }
    const now = this.now();
    // A replaced fact is retired in the same journal batch. If it changed in
    // the meantime, the new fact stands alone and keeps no lineage link, so
    // forgetting it can never reach the user's later edit of the older fact.
    const retired = items.flatMap((item) => {
      const target = item.supersedes ? this.store.get(profileId, item.supersedes) : null;
      return target?.status === "active" && target.scope === item.scope
        && this.recallPolicy.isMemoryVisible(profileId, target)
        ? [{ ...target, status: "superseded", updatedAt: Math.max(target.updatedAt, now) }] : [];
    });
    const retiredIds = new Set(retired.map((item) => item.id));
    const active = this.store.upsertMany([...items.map((item) => ({
      ...item, status: "active", updatedAt: Math.max(item.updatedAt, now),
      supersedes: retiredIds.has(item.supersedes) ? item.supersedes : null,
    })), ...retired], { expectedRevision }).slice(0, items.length);
    this._afterCommit(profileId);
    return active;
  }

  // Facts imported from another app's memory file. Each item passes the same
  // checks as an imported propose(); the batch commits once and rebuilds the
  // generated views once.
  importBatch({ profileId, items, expectedRevision }) {
    this._assertOpen();
    if (!Array.isArray(items) || items.length < 1 || items.length > 128
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || new Set(items.map((item) => item?.id)).size !== items.length) {
      throw engineError("MEMORY_INVALID", "导入记忆参数无效");
    }
    this.recallPolicy.assertReady(profileId);
    if (this.store.getRevision(profileId) !== expectedRevision) {
      throw engineError("MEMORY_REVISION_CONFLICT", "记忆已变化，请重新导入");
    }
    const now = this.now();
    const duplicateKey = (item) => JSON.stringify([item.scope, contentHash(item.content)]);
    const keys = new Set(this.store.list(profileId, { status: "active" })
      .filter((item) => this.recallPolicy.isMemoryVisible(profileId, item)).map(duplicateKey));
    const prepared = items.map((input) => {
      if (!input || typeof input.id !== "string" || !["user", "agent"].includes(input.scope)
        || !["semantic", "procedural"].includes(input.type)
        || typeof input.content !== "string" || !input.content.trim()
        || !Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0
        || input.sourceRefs.some((ref) => typeof ref !== "string" || !/^codex-memory:[a-f0-9]{32}$/u.test(ref))) {
        throw engineError("MEMORY_INVALID", "导入记忆内容无效");
      }
      if (!this.recallPolicy.isSourceVisible(profileId, input.sourceRefs)
        || this.recallPolicy.hasRevokedContent(profileId, input.content)) {
        throw engineError("MEMORY_SOURCE_REVOKED", "已撤回的内容不能从导入资料重新保存");
      }
      if (hasSecret(input.content)) throw engineError("MEMORY_SECRET_REJECTED", "Memory 拒绝保存 secret/验证码");
      if (this.store.get(profileId, input.id)) throw engineError("MEMORY_CONFLICT_INVALID", "记忆 ID 已存在");
      const item = {
        id: input.id, profileId, scope: input.scope, type: input.type,
        content: input.content.trim(), sourceRefs: [...new Set(input.sourceRefs)], confidence: 0.5,
        sensitivity: hasPii(input.content) ? "private" : "normal", status: "active",
        validFrom: now, validUntil: null, supersedes: null, createdAt: now, updatedAt: now,
      };
      if (keys.has(duplicateKey(item))) throw engineError("MEMORY_CONFLICT_INVALID", "已有同内容的 active 记忆");
      keys.add(duplicateKey(item));
      return item;
    });
    const created = this.store.upsertMany(prepared, { expectedRevision });
    this._afterCommit(profileId);
    return created;
  }

  update(input) {
    this._assertOpen();
    this.recallPolicy.assertReady(input.profileId);
    const item = this.store.get(input.profileId, input.id);
    if (!item || item.status === "deleted" || !this.recallPolicy.isMemoryVisible(input.profileId, item)) {
      throw engineError("MEMORY_NOT_FOUND", "Memory 不存在");
    }
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
    this.recallPolicy.assertReady(input.profileId);
    const item = this.store.get(input.profileId, input.id);
    if (!item) return null;
    const reason = input.reason || "user_deleted";
    const all = this.store.list(input.profileId);
    const byId = new Map(all.map((record) => [record.id, record]));
    const children = new Map();
    for (const record of all) if (record.supersedes && byId.has(record.supersedes)) {
      if (!children.has(record.supersedes)) children.set(record.supersedes, []);
      children.get(record.supersedes).push(record.id);
    }
    const lineageIds = new Set();
    const queue = [item.id];
    while (queue.length) {
      const id = queue.pop();
      if (lineageIds.has(id)) continue;
      lineageIds.add(id);
      const record = byId.get(id);
      if (record?.supersedes && byId.has(record.supersedes)) queue.push(record.supersedes);
      queue.push(...(children.get(id) || []));
    }
    const lineage = [...lineageIds].map((id) => byId.get(id));
    this.recallPolicy.recordReason({ profileId: input.profileId, item,
      relatedItems: lineage.filter((record) => record.id !== item.id), reason,
      revocationSourceRefs: input.revocationSourceRefs || [],
      ...(input.operationId ? { operationId: input.operationId } : {}) });
    const changes = lineage.filter((record) => record.status !== "deleted")
      .map((record) => ({ ...record, status: "deleted", updatedAt: Math.max(record.updatedAt, this.now()) }));
    try {
      for (let offset = 0; offset < changes.length; offset += 128) this.store.upsertMany(changes.slice(offset, offset + 128));
    }
    catch (error) { this._afterCommit(input.profileId); throw error; }
    this._afterCommit(input.profileId);
    return this.store.get(input.profileId, item.id);
  }

  // A forgotten user/project/workspace fact is forgotten for every Agent: it is
  // deleted at its home, and each copy with the same scope, content and
  // workspace that another Agent holds is deleted at that Agent. A peer that
  // cannot be read is skipped, as it is when its facts are shared.
  forgetEverywhere({ profileId, id, reason = "user_deleted", operationId = null, revocationSourceRefs = [] }) {
    this._assertOpen();
    const item = this.store.get(profileId, id);
    if (!item) return null;
    const deleted = this.delete({ profileId, id, reason, revocationSourceRefs,
      ...(operationId ? { operationId } : {}) });
    if (!SHARED_SCOPES.has(item.scope)) return deleted;
    const key = sameFactKey(item);
    for (const home of [profileId, ...this._peers(profileId)]) {
      let copies = [];
      try { copies = this.store.list(home, { status: "active" }).filter((copy) => sameFactKey(copy) === key); }
      catch { continue; }
      for (const copy of copies) {
        const copyOperation = `forget-copy-${crypto.createHash("sha256")
          .update(`${operationId ?? id}\0${home}\0${copy.id}`).digest("hex")}`;
        try { this.delete({ profileId: home, id: copy.id, reason, operationId: copyOperation }); } catch {}
      }
    }
    return deleted;
  }
  // Every active fact of this Agent learned from the given transcript events or
  // Runs, forgotten everywhere. Returns how many facts were forgotten.
  forgetSources({ profileId, sourceRefs, reason = "user_deleted", operationId }) {
    this._assertOpen();
    this.recallPolicy.assertReady(profileId);
    let forgotten = 0;
    for (const item of this.store.list(profileId, { status: "active" })
      .filter((entry) => entry.sourceRefs.some((ref) => sourceRefs.has(ref)))) {
      if (this.store.get(profileId, item.id)?.status !== "active") continue;
      this.forgetEverywhere({ profileId, id: item.id, reason,
        operationId: `forget-source-${crypto.createHash("sha256").update(`${operationId}\0${item.id}`).digest("hex")}` });
      forgotten++;
    }
    return forgotten;
  }
  // Undo one background consolidation: the consolidated fact is deleted and the
  // older fact it replaced, if still retired, becomes active again in the same
  // journal batch. The replaced fact's own source is not revoked.
  undoConsolidation({ profileId, id, operationId }) {
    this._assertOpen();
    this.recallPolicy.assertReady(profileId);
    const item = this.store.get(profileId, id);
    if (!item || item.status !== "active" || !item.sourceRefs.includes(CONSOLIDATED_REF)) {
      throw engineError("MEMORY_NOT_FOUND", "没有可撤销的整理记录");
    }
    const prior = item.supersedes ? this.store.get(profileId, item.supersedes) : null;
    const restore = prior?.status === "superseded" && prior.scope === item.scope ? prior : null;
    this.recallPolicy.recordReason({ profileId, item, reason: "user_deleted", operationId });
    const now = this.now();
    try {
      this.store.upsertMany([{ ...item, status: "deleted", updatedAt: Math.max(item.updatedAt, now) },
        ...(restore ? [{ ...restore, status: "active", updatedAt: Math.max(restore.updatedAt, now) }] : [])]);
    } catch (error) { this._afterCommit(profileId); throw error; }
    this._afterCommit(profileId);
    return { item: this.store.get(profileId, id), restored: restore ? this.store.get(profileId, restore.id) : null };
  }
  // Background consolidation never re-learns content forgotten through any
  // Agent that shares memory with this one.
  hasRevokedContentAnywhere(profileId, content) {
    return this.recallPolicy.hasRevokedContent(profileId, content) || this._peers(profileId).some((home) => {
      try { return this.recallPolicy.hasRevokedContent(home, content); } catch { return false; }
    });
  }
  // Another Agent's shared-scope fact in any status, to settle a write this
  // Agent made through that Agent.
  findPeerItem(profileId, id) {
    for (const home of this._peers(profileId)) {
      try {
        const item = this.store.get(home, id);
        if (item && SHARED_SCOPES.has(item.scope)) return structuredClone(item);
      } catch {}
    }
    return null;
  }

  search(input) {
    this._assertOpen();
    const policy = this.recallPolicy.snapshot(input.profileId);
    const now = input.now ?? this.now();
    const queryTerms = lexicalTerms(input.query || "");
    const maxSensitivity = input.maxSensitivity || "normal";
    const allowedRank = SENSITIVITY_RANK[maxSensitivity];
    if (allowedRank === undefined) throw engineError("MEMORY_INVALID", "Memory search sensitivity 无效");
    const scopes = new Set(input.scopes || ["user", "agent", "project", "workspace"]);
    const maxItems = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const maxBytes = Math.min(Math.max(input.maxBytes ?? 16 * 1024, 256), 128 * 1024);
    const scopeLimits = input.scopeLimits ?? null;
    if (scopeLimits !== null && (!scopeLimits || typeof scopeLimits !== "object"
      || Array.isArray(scopeLimits) || Object.getPrototypeOf(scopeLimits) !== Object.prototype
      || Object.keys(scopeLimits).some((scope) => !["user", "agent", "project", "workspace"].includes(scope)
        || !scopeLimits[scope] || typeof scopeLimits[scope] !== "object"
        || Array.isArray(scopeLimits[scope]) || Object.getPrototypeOf(scopeLimits[scope]) !== Object.prototype
        || Object.keys(scopeLimits[scope]).length !== 2
        || !Object.hasOwn(scopeLimits[scope], "count") || !Object.hasOwn(scopeLimits[scope], "bytes")
        || !Number.isSafeInteger(scopeLimits[scope].count) || scopeLimits[scope].count < 0
        || scopeLimits[scope].count > 100 || !Number.isSafeInteger(scopeLimits[scope].bytes)
        || scopeLimits[scope].bytes < 0 || scopeLimits[scope].bytes > 128 * 1024))) {
      throw engineError("MEMORY_INVALID", "Memory search scopeLimits 无效");
    }
    const statuses = new Set(input.statuses || ["active"]);
    const activeOnly = statuses.size === 1 && statuses.has("active");
    const prioritizeHot = input.hotPriority === true && activeOnly && queryTerms.size === 0;
    const view = activeOnly ? this._searchView(input.profileId, policy) : null;
    const reviewState = view?.hasReviewed ? this._reviewState(input.profileId) : null;
    const documents = view ? view.documents : this.store.list(input.profileId)
      .filter((item) => statuses.has(item.status))
      .map((item) => ({ item, terms: lexicalTerms(item.content), normalized: normalizeContent(item.content) }));
    const postings = view?.postings || (() => {
      const index = new Map();
      for (let position = 0; position < documents.length; position += 1) {
        for (const term of documents[position].terms) {
          if (!index.has(term)) index.set(term, []);
          index.get(term).push(position);
        }
      }
      return index;
    })();
    const semanticCandidates = activeOnly && queryTerms.size > 0 && Array.isArray(input.semanticCandidates)
      ? input.semanticCandidates : null;
    if (semanticCandidates && (semanticCandidates.length > 100 || semanticCandidates.some(entry =>
      typeof entry?.id !== "string" || !Number.isFinite(entry.score) || entry.score < -1 || entry.score > 1
      || (entry.rankScore !== undefined && (!Number.isFinite(entry.rankScore) || entry.rankScore < -1 || entry.rankScore > 1))))) {
      throw engineError("MEMORY_INVALID", "语义候选无效");
    }
    const semanticScores = semanticCandidates ? new Map(semanticCandidates.map(entry => [entry.id, entry.score])) : null;
    const semanticRanks = semanticCandidates ? new Map(semanticCandidates.map(entry => [entry.id, entry.rankScore])) : null;
    const candidateIndices = queryTerms.size === 0
      ? documents.map((_, index) => index)
      : [...new Set([...queryTerms].flatMap((term) => postings.get(term) || [])
        .concat(semanticCandidates ? semanticCandidates.map(entry => view.positions.get(entry.id))
          .filter(index => index !== undefined) : []))];
    const totalWeight = [...queryTerms].reduce((sum, term) => sum
      + Math.log1p((documents.length + 1) / ((postings.get(term)?.length || 0) + 1)), 0);
    const hasWorkspace = input.workspace !== undefined;
    const normalizedQuery = normalizeContent(input.query || "");
    // The empty-query hot search already visits every eligible active item
    // before result limits. Count durable *signals* here so the context report
    // has an uncapped denominator without another MemoryStore scan. A project
    // or workspace scope alone is a ranking hint, not a durable fact.
    const hotDurableEligibleByScope = prioritizeHot
      ? { user: 0, agent: 0, project: 0, workspace: 0 } : null;
    const scored = candidateIndices.map((index) => documents[index])
      // Peer entries were already checked against both Agents' policies.
      .filter(({ item, home }) => (home !== undefined && home !== input.profileId) || policy.isMemoryVisible(item))
      .filter(({ item, home }) => (home !== undefined && home !== input.profileId)
        || this._reviewSourceCurrent(input.profileId, item, reviewState))
      .filter(({ item }) => scopes.has(item.scope))
      .filter(({ item }) => SENSITIVITY_RANK[item.sensitivity] <= allowedRank)
      .filter(({ item }) => item.validFrom <= now)
      .filter(({ item }) => item.validUntil === null || item.validUntil > now)
      .filter(({ item }) => !hasWorkspace || !["project", "workspace"].includes(item.scope)
        || matchesWorkspace(item, input.workspace))
      .filter(({ item }) => !prioritizeHot || !isConditionalMemory(item))
      .map(({ item, terms, normalized }) => {
        const overlap = [...queryTerms].filter((term) => terms.has(term));
        const weight = overlap.reduce((sum, term) => sum
          + Math.log1p((documents.length + 1) / ((postings.get(term)?.length || 0) + 1)), 0);
        const relevance = totalWeight === 0 ? 0 : weight / totalWeight;
        const ageDays = Math.max(0, now - item.updatedAt) / 86_400_000;
        const recency = 1 / (1 + ageDays / 30);
        const exact = normalizedQuery && normalized.includes(normalizedQuery) ? 0.1 : 0;
        const hotPriority = prioritizeHot ? hotPriorityFlags(item) : 0;
        if (hotDurableEligibleByScope && (hotPriority & 6)) hotDurableEligibleByScope[item.scope] += 1;
        const lexicalScore = relevance * 0.7 + item.confidence * 0.2 + recency * 0.1 + exact;
        const semantic = semanticScores ? require("./memory-semantic-ranking").hybridScore(
          input.query, item.content, lexicalScore, semanticScores.get(item.id), semanticRanks.get(item.id)) : null;
        return { item, score: semantic?.score ?? lexicalScore, ...(semantic || {}), hotPriority };
      })
      // Among equally prioritized hot facts, those the user wrote or confirmed
      // come before consolidated ones, and those before an Agent's saves.
      .sort((a, b) => b.hotPriority - a.hotPriority
        || (prioritizeHot ? TRUST_RANK[memoryTrust(b.item)] - TRUST_RANK[memoryTrust(a.item)] : 0)
        || b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id));
    const results = [];
    let bytes = 0;
    const usedScopeCounts = new Map();
    const usedScopeBytes = new Map();
    for (const entry of scored) {
      const scopeLimit = scopeLimits?.[entry.item.scope];
      if (scopeLimit && (usedScopeCounts.get(entry.item.scope) ?? 0) >= scopeLimit.count) continue;
      const projected = { ...entry.item, score: Number(entry.score.toFixed(6)),
        ...(entry.scoreBasis ? { scoreBasis: entry.scoreBasis } : {}),
        ...(entry.semanticScore === undefined ? {} : { semanticScore: Number(entry.semanticScore.toFixed(6)) }) };
      const size = Buffer.byteLength(JSON.stringify(projected), "utf8");
      if (results.length >= maxItems) break;
      if (scopeLimit && (usedScopeBytes.get(entry.item.scope) ?? 0) + size > scopeLimit.bytes) continue;
      if (bytes + size > maxBytes) continue;
      results.push(structuredClone(projected)); bytes += size;
      usedScopeCounts.set(entry.item.scope, (usedScopeCounts.get(entry.item.scope) ?? 0) + 1);
      usedScopeBytes.set(entry.item.scope, (usedScopeBytes.get(entry.item.scope) ?? 0) + size);
    }
    return { revision: this.store.getRevision(input.profileId), items: results,
      truncated: results.length < scored.length,
      ...(hotDurableEligibleByScope ? { hotDurableEligibleByScope } : {}) };
  }

  consolidate(profileId) {
    this._assertOpen();
    this.recallPolicy.assertReady(profileId);
    const now = this.now();
    const changes = [];
    for (const item of this.store.list(profileId, { status: "active" })) {
      if (item.validUntil !== null && item.validUntil <= now) {
        changes.push({ ...item, status: "deleted", updatedAt: now });
      }
    }
    const expiryOperationId = (item) => `expired-${item.id}-${item.validUntil}`;
    for (const item of changes) this.recallPolicy.recordReason({ profileId, item,
      reason: "expired", operationId: expiryOperationId(item) });
    try {
      for (let offset = 0; offset < changes.length; offset += 128) {
        this.store.upsertMany(changes.slice(offset, offset + 128));
      }
      for (const item of changes) this.recallPolicy.recordExpiryCommit({ profileId, item,
        operationId: expiryOperationId(item) });
    } catch (error) { this._afterCommit(profileId); throw error; }
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
      const initialStat = fs.lstatSync(target);
      if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.size > 1024 * 1024) continue;
      let bytes;
      let fd;
      try { fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
      catch (error) {
        if (["ELOOP", "ENOENT"].includes(error.code)) continue;
        throw error;
      }
      try {
        const fileStat = fs.fstatSync(fd);
        if (!fileStat.isFile() || fileStat.size > 1024 * 1024) continue;
        bytes = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
      const content = bytes.toString("utf8").trim();
      if (!content || hasSecret(content)) continue;
      const importedContent = boundedImportContent(content);
      const sourceRef = `codex-memory:${contentHash(`${name}\0${content}`).slice(0, 32)}`;
      const beforeRevision = this.store.getRevision(input.profileId);
      const item = this.propose({
        profileId: input.profileId,
        scope: "agent",
        type: "semantic",
        content: importedContent,
        sourceRefs: [sourceRef],
        classification: "imported",
        confidence: 0.5,
      });
      const created = this.store.getRevision(input.profileId) !== beforeRevision;
      if (created) imported += 1;
      // A failed provenance append can be retried after a successful memory
      // commit, but another file that deduplicates to this item is not its source.
      if (this.provenanceService && item.content === importedContent
        && (created || item.sourceRefs.includes(sourceRef))) {
        this.provenanceService.recordImport({ profileId: input.profileId, item,
          sourceRef, fileName: name,
          fileHash: crypto.createHash("sha256").update(bytes).digest("hex") });
      }
    }
    return { imported };
  }
}

module.exports = { MemoryEngine, contentHash, hasPii, hasSecret, hotPriorityFlags,
  isConditionalMemory, lexicalTerms, matchesWorkspace, memoryTrust, quoteSupportsContent, CONSOLIDATED_REF,
  UNTRUSTED_REF_PREFIX, workspaceMemoryRef, workspaceMemoryRefs };
