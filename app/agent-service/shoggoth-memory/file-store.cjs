"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile } = require("../private-file");
const { serviceError } = require("../security");
const { transaction } = require("../inspiration-database");
const { renderMemoryEntry, sha256 } = require("./migration.cjs");
const { core } = require("./host.cjs");
const { canonicalSharedPath, documentKind } = require("./shared-document.cjs");
const { databaseChangeStamp } = require("../turn-memo");

// A block body never contains another opening marker (rendered content escapes
// it), so a hand-left unpaired marker cannot swallow the next entry.
const ENTRY = /<!-- shoggoth-memory-entry:([A-Za-z0-9][A-Za-z0-9._:-]{0,255}) -->\n((?:(?!<!-- shoggoth-memory-entry:)[\s\S])*?)\n<!-- \/shoggoth-memory-entry -->/g;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_ROWS = 20_000;
const MAX_SCAN_PROFILES = 2;
const MAX_SCAN_WAITERS = 64;
const SCAN_DEADLINE_MS = 5_000;
const MAX_CACHED_PROFILES = 16;
function memoryPathIdentity(target) {
  try {
    const value = fs.lstatSync(target, { bigint: true });
    return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "-";
    throw error;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_file_profiles (profile_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_records (profile_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,id)) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_pending (profile_id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_history (profile_id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS memory_report_evidence (profile_id TEXT NOT NULL,path TEXT NOT NULL,line INTEGER NOT NULL,source_hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,path,line)) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_invalidation (profile_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,files TEXT NOT NULL CHECK(json_valid(files))) STRICT;
`;

const DREAMS_PATH = /^(?:DREAMS|dreams)\.md$/u;
const DIARY = /^# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n([\s\S]*?)(?<=\n)<!-- openclaw:dreaming:diary:end -->(?:\n|$)/u;
const DEEP_REPORT = /^(## Deep Sleep\n<!-- openclaw:dreaming:deep:start -->\n)([\s\S]*?)\n<!-- openclaw:dreaming:deep:end -->$/mu;
const REPAIR_DETAILS = /^- Repaired recall artifacts: (?:rewrote recall store(?: \(-\d+ (?:invalid|dangling|overflow)(?:, -\d+ (?:invalid|dangling|overflow))*\))?(?:, removed stale promotion lock)?|removed stale promotion lock)\.$/u;
const REJECTION_CATEGORIES = new Set(["age threshold", "already promoted", "candidate changed", "consolidation origin/session",
  "contamination", "memory budget", "origin", "query threshold", "score threshold", "selection limit", "signal threshold",
  "source changed", "source rehydration"]);

function isDeepStatusReport(body) {
  // These lines contain counters from the pinned Dreaming writer. A Deep
  // block with arbitrary prose still has the full invalidation semantics.
  const lines = body.split("\n");
  if (REPAIR_DETAILS.test(lines[0])) lines.shift();
  const rejected = /^- Not promoted: \d+ candidate\(s\) \((.+)\)\.$/u.exec(lines.at(-1));
  if (rejected?.[1].split(", ").every(row => {
    const match = /^([a-z /]+): \d+$/u.exec(row);
    return REJECTION_CATEGORIES.has(match?.[1]);
  })) lines.pop();
  return lines.length === 2 && /^- Ranked \d+ candidate\(s\) for durable promotion\.$/u.test(lines[0])
    && /^- Promoted \d+ candidate\(s\) into MEMORY\.md\.$/u.test(lines[1]);
}

function dreamSource(text) {
  const diary = DIARY.exec(text);
  // Accept the pinned writer's layout. Ambiguous or broken markers leave the
  // complete file subject to the ordinary prefix check.
  const diaryMarkers = text.match(/<!-- openclaw:dreaming:diary:(?:start|end) -->/gu)?.length ?? 0;
  if (diaryMarkers !== (diary ? 2 : 0)) return null;
  const retained = diary ? text.slice(diary[0].length) : text;
  const deep = DEEP_REPORT.exec(retained);
  const sections = { retained: retained.trimEnd(), diary: diary?.[1] ?? null };
  if (deep && isDeepStatusReport(deep[2])) {
    const deepMarkers = text.match(/<!-- openclaw:dreaming:deep:(?:start|end) -->/gu)?.length ?? 0;
    if (deepMarkers !== 2) return null;
    const body = deep.index + deep[1].length;
    sections.statusFree = (retained.slice(0, body) + retained.slice(body + deep[2].length)).trimEnd();
  }
  return sections;
}

const digest = text => ({ length: text.length, hash: sha256(text) });
function matchesPrefix(entry, text) {
  return typeof text === "string" && Number.isSafeInteger(entry?.length) && entry.length >= 0
    && text.length >= entry.length && sha256(text.slice(0, entry.length)) === entry.hash;
}

function sourceDigests(files) {
  return files.map(({ path: relative, text, dreams }) => {
    const entry = { path: relative, ...digest(text) };
    if (DREAMS_PATH.test(relative)) entry.dreams = dreams && {
      retained: digest(dreams.retained),
      diary: dreams.diary === null ? null : digest(dreams.diary),
      ...(dreams.statusFree === undefined ? {} : { statusFree: digest(dreams.statusFree) }),
    };
    return entry;
  });
}
// True when every earlier source still exists and only had text appended.
// Any edit, removal or deleted file may withdraw a fact a native session holds.
function sourcesOnlyAppended(previous, files) {
  const current = new Map(files.map(file => [file.path, file]));
  return Array.isArray(previous) && previous.every(entry => {
    const file = current.get(entry?.path);
    if (!file) return false;
    if (matchesPrefix(entry, file.text)) return true;
    // Only diary insertions that retain its exact old body and updates to the
    // generated Deep Sleep counters preserve authority. The full revision
    // still tracks these bytes for index freshness and in-flight read checks.
    if (!file.dreams || (entry.dreams?.diary && !matchesPrefix(entry.dreams.diary, file.dreams.diary))) return false;
    return matchesPrefix(entry.dreams?.retained ?? entry, file.dreams.retained)
      || (entry.dreams?.statusFree && matchesPrefix(entry.dreams.statusFree, file.dreams.statusFree));
  });
}

function projectInvalidation(tracked, files, fingerprint, revision) {
  const unchanged = tracked?.fingerprint === fingerprint && tracked.revision <= revision;
  if (unchanged && !files.some(file => DREAMS_PATH.test(file.path))) return null;
  let previous = null;
  try { previous = tracked ? JSON.parse(tracked.files) : null; } catch { previous = null; }
  // Older snapshots lacked section digests. Backfill only a byte-verified baseline.
  if (unchanged && Array.isArray(previous)
    && !previous.some(entry => DREAMS_PATH.test(entry?.path) && !Object.hasOwn(entry, "dreams"))) return null;
  const sources = files.map(file => {
    const text = file.content.trimEnd();
    return { path: file.path, text, dreams: DREAMS_PATH.test(file.path) ? dreamSource(text) : null };
  });
  const appended = tracked && tracked.revision <= revision && sourcesOnlyAppended(previous, sources);
  return { revision: appended ? tracked.revision : revision, files: JSON.stringify(sourceDigests(sources)) };
}

function projectionChunks(relative, content, sourceContent) {
  const options = { tokens: 400, overlap: 80, perEntry: /^(MEMORY|USER|DREAMS|dreams)\.md$/u.test(relative) };
  if (!/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(relative)
    || !/<!--\s*openclaw:dreaming:(?:light|rem):start\s*-->/u.test(sourceContent)) return core.chunkMarkdown(content, options);
  // Daily handwritten facts and managed reflection blocks retain separate
  // full authority. The native token index is unchanged; its overlapping
  // candidates are checked against these precise current read projections.
  const lines = content.split("\n"), original = sourceContent.split("\n"), boundaries = new Set([0, lines.length]);
  for (let index = 0; index < original.length; index++) {
    if (/^\s*<!--\s*openclaw:dreaming:(?:light|rem):start\s*-->\s*$/u.test(original[index])) boundaries.add(index);
    if (/^\s*<!--\s*openclaw:dreaming:(?:light|rem):end\s*-->\s*$/u.test(original[index])) boundaries.add(index + 1);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  return ordered.slice(0, -1).flatMap((offset, index) => core.chunkMarkdown(lines.slice(offset, ordered[index + 1]).join("\n"), options).map(chunk => ({ ...chunk,
    startLine: chunk.startLine + offset, endLine: chunk.endLine + offset,
    ...(chunk.entryStartLine !== undefined ? { entryStartLine: chunk.entryStartLine + offset } : {}),
    ...(chunk.entryEndLine !== undefined ? { entryEndLine: chunk.entryEndLine + offset } : {}),
  })));
}
function textContent(body) {
  return body.split("\n").map((line, index) => index === 0
    ? line.replace(/^- /, "").replace(/ <!-- project:[^\n]* -->$/, "")
    : line.replace(/^  /, "")).join("\n");
}
function splitEntries(text) {
  const output = []; let match;
  const expression = new RegExp(ENTRY.source, "g");
  while ((match = expression.exec(text))) {
    const startLine = text.slice(0, match.index).split("\n").length;
    output.push({ id: match[1], content: textContent(match[2]), raw: match[2], start: match.index, end: expression.lastIndex,
      startLine, endLine: startLine + match[0].split("\n").length - 1 });
  }
  return output;
}
// Turn every block with this ID back into its plain text.
function unmarkEntries(text, id) {
  for (const entry of splitEntries(text).filter(value => value.id === id).toReversed()) {
    text = text.slice(0, entry.start) + entry.raw + text.slice(entry.end);
  }
  return text;
}

function snapshotRows(snapshot) {
  if (snapshot.rows) return snapshot.rows;
  const byId = new Map(), byPath = new Map(), historical = [];
  for (const item of snapshot.items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
    const rows = byPath.get(item.memoryPath);
    if (rows) rows.push(item);
    else byPath.set(item.memoryPath, [item]);
  }
  for (const item of snapshot.metadata.values()) {
    if (byId.has(item.id)) continue;
    const row = { ...item, status: item.status === "active" ? "deleted" : item.status };
    historical.push(row);
    byId.set(item.id, row);
  }
  snapshot.rows = { byId, byPath, historical };
  return snapshot.rows;
}

function matchesFilter(item, filter) {
  return (!filter.status || item.status === filter.status) && (!filter.scope || item.scope === filter.scope)
    && (!filter.type || item.type === filter.type);
}

// Metadata carries provenance, revocation and compatibility IDs. Every active
// fact's content is read from the Markdown source, never from the metadata row.
class FileMemoryStore {
  constructor({ paths, database, migration, initialization = null, getHost, now = Date.now, onChanged = () => {} }) {
    this.paths = paths; this.database = database; this.migration = migration; this.initialization = initialization; this.getHost = getHost; this.now = now;
    this.opened = false; this.ready = new Set(); this.snapshots = new Map();
    this.scans = new Map();
    this.scanWorkers = new Set();
    this.scanQueue = new Set();
    this.scanClosing = null;
    this.retiringScanProfiles = new Map();
    this.fileOwnerStatements = new WeakMap();
    this.onChanged = onChanged;
  }
  open() { if (this.opened) return; this.database.open(); this.database.db.exec(SCHEMA); this.opened = true; }
  close() {
    this.opened = false; this.ready.clear(); this.snapshots.clear();
    void this.stopScans();
  }
  stopScans(profileId = null) {
    if (this.scanClosing) return this.scanClosing;
    if (profileId !== null && this.retiringScanProfiles.has(profileId)) return this.retiringScanProfiles.get(profileId);
    const stopping = this._stopScans(profileId).finally(() => {
      if (profileId === null) this.scanClosing = null;
      else this.retiringScanProfiles.delete(profileId);
    });
    if (profileId === null) this.scanClosing = stopping;
    else this.retiringScanProfiles.set(profileId, stopping);
    return stopping;
  }

  async _stopScans(profileId) {
    for (const waiter of this.scanQueue) {
      if (profileId === null || waiter.profileId === profileId) {
        waiter.fail(serviceError("MEMORY_SCOPE_REVOKED", "记忆文件扫描已停止"));
      }
    }
    const scans = [...this.scans].filter(([id]) => profileId === null || id === profileId).map(([, scan]) => scan);
    for (const scan of scans) scan.retired = true;
    const workers = profileId === null ? [...this.scanWorkers] : scans.map(scan => scan.slot);
    await Promise.allSettled(workers.map(slot => this._retireScanWorker(slot)));
    await Promise.allSettled(scans.map(scan => scan.promise));
  }
  assertOpen() { if (!this.opened) throw serviceError("MEMORY_STORE_CLOSED", "记忆存储未打开"); }
  workspace(profileId) { if (!ID.test(profileId)) throw new Error("Invalid memory Profile"); return (this.initialization || this.migration).locations(profileId).workspace; }

  ensureProfile(profileId) {
    this.prepareProfile(profileId);
    return this.getRevision(profileId);
  }

  prepareProfile(profileId) {
    this.assertOpen();
    if (!this.ready.has(profileId)) {
      if (this.initialization) {
        this.initialization.run(profileId); this.recover(profileId); this.ready.add(profileId);
        return;
      }
      const receipt = this.migration.run(profileId);
      const db = this.database.db;
      if (!db.prepare("SELECT 1 FROM memory_file_profiles WHERE profile_id=?").get(profileId)) {
        const snapshot = this.migration.verifyBackups(this.migration.locations(profileId), receipt);
        const visible = new Set(snapshot.visibleIds);
        transaction(db, () => {
          for (const item of snapshot.records) {
            const active = visible.has(item.id) && item.status === "active" && item.validFrom <= this.now() && (item.validUntil === null || item.validUntil > this.now());
            const data = { ...item, status: active ? "active" : item.status === "active" ? "deleted" : item.status,
              memoryPath: item.scope === "user" ? "USER.md" : "MEMORY.md", contentHash: sha256(item.content),
              contentRevision: snapshot.contentRevisions?.[item.id] ?? snapshot.revision, migrated: true };
            db.prepare("INSERT INTO memory_file_records VALUES (?,?,?)").run(profileId, item.id, JSON.stringify(data));
          }
          db.prepare("INSERT INTO memory_file_profiles VALUES (?,?,?)").run(profileId, snapshot.revision, "");
          db.prepare("INSERT INTO memory_file_history VALUES (?,?)").run(profileId, JSON.stringify(snapshot.historicalSourceItems || []));
        });
      }
      this.recover(profileId);
      this.ready.add(profileId);
    }
  }

  _check(profileId) {
    this.assertOpen();
    if (!this.ready.has(profileId)) throw serviceError("MEMORY_MIGRATION_REQUIRED", "记忆迁移尚未完成");
    this.initialization?.assertOwned(profileId);
    if (this.database.db.prepare("SELECT 1 FROM memory_file_pending WHERE profile_id=?").get(profileId)) {
      throw serviceError("MEMORY_TRANSACTION_UNSETTLED", "记忆写入等待恢复");
    }
  }
  _read(profileId, relative, maxBytes = 256 * 1024 * 1024) {
    if (relative !== "USER.md" && !core.isMemoryPath(relative)) throw serviceError("MEMORY_PATH_NOT_ALLOWED", "不是记忆文件");
    const root = this.workspace(profileId), target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep) || fs.realpathSync.native(root) !== root) throw new Error("Memory workspace alias is unsafe");
    try {
      if (fs.realpathSync.native(target) !== target) throw new Error("Memory source symlink is unsafe");
      return readPrivateFile(target, { maxBytes }).toString("utf8");
    } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  }
  _files(profileId, bounded = false) {
    const files = ["USER.md", "MEMORY.md"], root = this.workspace(profileId);
    let visited = 0, bytes = 0;
    for (const name of ["DREAMS.md", "dreams.md"]) {
      const target = path.join(root, name);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) throw new Error("Memory source symlink is unsafe");
        // On a case-insensitive macOS volume, only the actual spelling owns
        // the file. Do not project the same entry again via a case alias.
        if (stat.isFile() && fs.realpathSync.native(target) === target) files.push(name);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const walk = relative => {
      let children;
      try { children = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const child of children) {
        if (bounded && ++visited > MAX_SCAN_ENTRIES) throw serviceError("MEMORY_SCAN_TOO_LARGE", "记忆文件数超过前台扫描上限");
        if (child.isSymbolicLink()) throw new Error("Memory source symlink is unsafe");
        const name = path.posix.join(relative, child.name);
        if (child.isDirectory() && !child.name.startsWith(".")) walk(name);
        else if (child.isFile() && child.name.endsWith(".md")) files.push(name);
      }
    };
    walk("memory");
    return files.sort().map(relative => {
      if (!bounded) return { path: relative, content: this._read(profileId, relative) };
      let content;
      try {
        content = this._read(profileId, relative, MAX_SCAN_BYTES - bytes);
      } catch (error) {
        if (error.code === "PRIVATE_FILE_TOO_LARGE") throw serviceError("MEMORY_SCAN_TOO_LARGE", "记忆文件超过前台扫描容量");
        throw error;
      }
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_SCAN_BYTES) throw serviceError("MEMORY_SCAN_TOO_LARGE", "记忆文件超过前台扫描容量");
      return { path: relative, content };
    });
  }
  _metadata(profileId) {
    return new Map(this.database.db.prepare("SELECT id,data FROM memory_file_records WHERE profile_id=?").all(profileId)
      .map(row => [row.id, JSON.parse(row.data)]));
  }
  // Every recall check reads the revision. Reuse the projection while every
  // source file and directory entry has the same identity, size and times and
  // the database is unchanged; any writer, in this process or not, changes one.
  _filesystemStamp(profileId, bounded = false, identities = null) {
    const root = this.workspace(profileId), parts = [];
    let visited = 0;
    const stat = relative => {
      const identity = memoryPathIdentity(path.join(root, relative));
      identities?.push([relative, identity]);
      return identity;
    };
    parts.push(stat(""));
    for (const name of ["USER.md", "MEMORY.md", "DREAMS.md", "dreams.md"]) parts.push(name, stat(name));
    const walk = relative => {
      const directory = path.join(root, relative);
      parts.push(relative, stat(relative));
      let children;
      try { children = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return; throw error; }
      for (const child of children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
        if (bounded && ++visited > MAX_SCAN_ENTRIES) throw serviceError("MEMORY_SCAN_TOO_LARGE", "记忆文件数超过前台扫描上限");
        const name = path.posix.join(relative, child.name);
        if (child.isDirectory() && !child.name.startsWith(".")) walk(name);
        else if (child.isSymbolicLink() || (child.isFile() && child.name.endsWith(".md"))) parts.push(name, stat(name));
      }
    };
    walk("memory");
    return parts.join("|");
  }
  _fileOwnerStamp(profileId, db = this.database.db) {
    // The file-owner transaction changes the profile row whenever it commits
    // metadata; a pending row also fences an uncommitted file transaction.
    // Index connections can also write to the same SQLite file; their commits
    // do not own these tables. File-store writers always advance the Profile
    // revision transactionally, and the owner revalidates filesystem identity.
    let statement = this.fileOwnerStatements.get(db);
    if (!statement) {
      statement = db.prepare(`SELECT p.revision,p.fingerprint,
        coalesce(i.revision, p.revision) AS invalidation_revision,
        EXISTS(SELECT 1 FROM memory_file_pending w WHERE w.profile_id=p.profile_id) AS pending
        FROM memory_file_profiles p LEFT JOIN memory_file_invalidation i USING (profile_id) WHERE p.profile_id=?`);
      this.fileOwnerStatements.set(db, statement);
    }
    return JSON.stringify(statement.get(profileId) ?? null);
  }
  _sourceStamp(profileId) { return `${databaseChangeStamp(this.database.db)}|${this._filesystemStamp(profileId)}`; }
  _cacheSnapshot(profileId, snapshot) {
    this.snapshots.delete(profileId);
    this.snapshots.set(profileId, snapshot);
    if (this.snapshots.size > MAX_CACHED_PROFILES) this.snapshots.delete(this.snapshots.keys().next().value);
  }
  _snapshot(profileId) {
    this._check(profileId);
    const stamp = this._sourceStamp(profileId), cached = this.snapshots.get(profileId);
    if (cached?.stamp === stamp) {
      this._cacheSnapshot(profileId, cached);
      return cached.value;
    }
    const value = this._readSnapshot(profileId);
    // Reuse only a read that saw a stable source. Publishing a new fingerprint
    // or a concurrent change is simply read again on the next call.
    if (this._sourceStamp(profileId) === stamp) this._cacheSnapshot(profileId, { stamp, value });
    else this.snapshots.delete(profileId);
    return value;
  }
  _projectSnapshot(profileId, files, metadata, bounded = false) {
    const items = [], ids = new Set(), copies = new Map(), fileHashes = new Map();
    let totalBytes = 0;
    const add = item => {
      if (bounded && (items.length >= MAX_SCAN_ROWS || (totalBytes += Buffer.byteLength(JSON.stringify(item))) > MAX_SCAN_BYTES)) {
        throw serviceError("MEMORY_SCAN_TOO_LARGE", "投影后的记忆超过前台扫描容量");
      }
      items.push(item);
    };
    for (const file of files) {
      const fileHash = sha256(file.content);
      fileHashes.set(file.path, fileHash);
      // Files are edited by hand. Only the first block with an ID is that
      // memory; a copied block stays readable as hand-written text below.
      const entries = splitEntries(file.content).filter(entry => {
        if (!ids.has(entry.id)) return ids.add(entry.id);
        copies.set(entry.id, (copies.get(entry.id) || new Set()).add(file.path));
        return false;
      });
      for (const entry of entries) {
        const previous = metadata.get(entry.id), unchanged = previous?.contentHash === sha256(entry.content);
        add({ ...(unchanged ? previous : this._newItem(profileId, entry.id, entry.content, file.path)),
          id: entry.id, content: entry.content, status: "active", memoryPath: file.path,
          startLine: entry.startLine, endLine: entry.endLine, fileHash,
          documentKind: documentKind(file.path, file.content, entry.startLine, entry.endLine) });
      }
      // Upstream promotions and hand-authored sections have no Shoggoth ID.
      // Project their current chunks without rewriting their source format.
      const covered = new Set(entries.flatMap(entry => Array.from({ length: entry.endLine - entry.startLine + 1 }, (_, index) => entry.startLine + index)));
      const remaining = file.content.split("\n").map((line, index) => covered.has(index + 1) ? "" : line).join("\n");
      const sourceLines = remaining.split("\n");
      for (const chunk of projectionChunks(file.path, remaining, file.content)) {
        if (!chunk.text.split("\n").some(line => line.trim() && !/^\s*(?:#|<!--)/.test(line))) continue;
        const id = `file-${sha256(`${file.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`)}`;
        const entryStart = chunk.entryStartLine ?? chunk.startLine, entryEnd = chunk.entryEndLine ?? chunk.endLine;
        const promotionLine = /^\s*<!--\s*openclaw-memory-promotion:[^\n]*-->\s*$/iu;
        // Upstream places a promotion marker BEFORE its bullet. It belongs to
        // that entry, while the marker before the next bullet must not attach
        // backwards to this one. All size fragments inherit the full entry's
        // scope and source annotations even when those are outside the chunk.
        const prefix = sourceLines[entryStart - 2] || "";
        const authorityText = [promotionLine.test(prefix) ? prefix : "",
          ...sourceLines.slice(entryStart - 1, entryEnd).filter(line => !promotionLine.test(line))].join("\n");
        add({ ...this._newItem(profileId, id, chunk.text, file.path), authorityText,
          startLine: chunk.startLine, endLine: chunk.endLine, fileHash, projection: true,
          documentKind: documentKind(file.path, file.content, chunk.startLine, chunk.endLine) });
      }
    }
    return { items, copies, fileHashes };
  }

  _readSnapshot(profileId) {
    const files = this._files(profileId), metadata = this._metadata(profileId);
    const projection = this._projectSnapshot(profileId, files, metadata);
    const fingerprint = sha256(JSON.stringify(files));
    const current = this._snapshotRevision(profileId), tracked = this._trackedInvalidation(profileId);
    const revision = current.revision + Number(current.fingerprint !== fingerprint);
    const revisions = this._commitSnapshotRevision(profileId, current, tracked, fingerprint,
      projectInvalidation(tracked, files, fingerprint, revision));
    return { ...projection, metadata, ...revisions };
  }

  _scanMetadata(profileId, db, collect = false, include = null) {
    const statement = db.prepare("SELECT id,data FROM memory_file_records WHERE profile_id=? ORDER BY id LIMIT ?");
    const hash = createHash("sha256"), rows = [];
    let count = 0, bytes = 0;
    for (const row of statement.iterate(profileId, MAX_SCAN_ROWS + 1)) {
      if (++count > MAX_SCAN_ROWS || (bytes += Buffer.byteLength(row.data)) > MAX_SCAN_BYTES) {
        throw serviceError("MEMORY_SCAN_TOO_LARGE", "记忆元数据超过前台扫描容量");
      }
      if (include && !include.has(row.id)) continue;
      hash.update(row.id).update("\0").update(row.data).update("\0");
      if (collect) rows.push(row);
    }
    return { rows, hash: hash.digest("hex"), stamp: databaseChangeStamp(db) };
  }

  // Scan workers are bounded by total live threads, including any thread
  // still terminating. An idle worker carries no active Profile request.
  _idleScanWorker() {
    for (const slot of this.scanWorkers) {
      if (!slot.active && !slot.termination) return slot;
    }
    if (this.scanWorkers.size >= MAX_SCAN_PROFILES) return null;
    const { Worker } = require("node:worker_threads");
    const worker = new Worker(path.join(__dirname, "file-scan-worker.cjs"), {
      resourceLimits: { maxOldGenerationSizeMb: 144 },
    });
    const slot = { worker, active: false, fail: null, termination: null, jobId: 0 };
    this.scanWorkers.add(slot);
    worker.on("error", () => slot.fail?.());
    worker.once("exit", () => {
      this.scanWorkers.delete(slot);
      slot.fail?.();
    });
    return slot;
  }

  _retireScanWorker(slot) {
    slot.termination ??= slot.worker.terminate();
    return slot.termination;
  }

  _scanSnapshot(profileId, root, snapshotStamp, ownerStamp, slot) {
    const db = this.database.db;
    const { worker } = slot;
    const id = ++slot.jobId;
    const scan = { slot, workRoot: root, snapshotStamp, ownerStamp, metadata: null, promise: null, retired: false };
    slot.active = true;
    worker.ref();
    scan.promise = new Promise((resolve, reject) => {
      const stopped = () => serviceError("MEMORY_SCAN_UNAVAILABLE", "无法完成记忆文件扫描");
      const rejectScan = error => { scan.completed = true; reject(error); };
      slot.fail = () => rejectScan(stopped());
      const timer = setTimeout(slot.fail, SCAN_DEADLINE_MS);
      timer.unref();
      const receive = response => {
        if (response?.id !== id || scan.completed) return;
        if (response?.needsMetadata === true) {
          try {
            if (scan.retired || this.database.db !== db || this._fileOwnerStamp(profileId, db) !== ownerStamp) {
              throw serviceError("MEMORY_REVISION_CONFLICT", "扫描期间记忆或授权已经变化");
            }
            const { rows, ...metadata } = this._scanMetadata(profileId, db, true);
            scan.metadata = metadata;
            scan.current = this._snapshotRevision(profileId);
            scan.tracked = this._trackedInvalidation(profileId);
            worker.postMessage({ id, metadata: { rows, current: scan.current, tracked: scan.tracked } });
          } catch (error) { rejectScan(error); }
        } else {
          scan.completed = true;
          const validError = ["MEMORY_REVISION_CONFLICT", "MEMORY_SCAN_TOO_LARGE", "MEMORY_SCAN_UNAVAILABLE"].includes(response.errorCode);
          const validData = response.errorCode === undefined && typeof response.fileStamp === "string"
            && Array.isArray(response.identities) && (response.unchanged === true || (
              typeof response.fingerprint === "string" && Array.isArray(response.items) && response.metadata instanceof Map
              && response.copies instanceof Map && response.fileHashes instanceof Map && response.sharedDocuments instanceof Map));
          scan.finished = validError || validData;
          if (validError) reject(serviceError(response.errorCode, "记忆文件扫描未能验证来源"));
          else if (scan.finished) resolve(response);
          else reject(stopped());
        }
      };
      scan.detach = () => {
        clearTimeout(timer);
        worker.off("message", receive);
        slot.fail = null;
      };
      worker.on("message", receive);
      try { worker.postMessage({ id, scan: { profileId, root, snapshotStamp } }); }
      catch (error) { rejectScan(error); }
    }).finally(async () => {
      scan.detach();
      try {
        if (scan.retired || !scan.finished) await this._retireScanWorker(slot);
        else worker.unref();
      }
      finally {
        slot.active = false;
        if (this.scans.get(profileId) === scan) this.scans.delete(profileId);
        // Existing readers publish their owner revision before a waiting scan
        // captures the next view. A retired worker keeps its slot until exit.
        if (this.scanQueue.size) setImmediate(() => this._drainScanQueue());
      }
    });
    this.scans.set(profileId, scan);
    return scan;
  }

  _tryReadScan(profileId, joinOnly = false) {
    this._assertScanOpen(profileId);
    this._check(profileId);
    const db = this.database.db, root = this.workspace(profileId), stamp = this._fileOwnerStamp(profileId, db);
    const cached = this.snapshots.get(profileId);
    // A direct metadata edit can leave both the Profile row and filesystem
    // unchanged. Use the worker's unchanged shortcut only when its metadata
    // is also current, including commits from another SQLite connection.
    let cacheStamp = null;
    if (cached?.ownerStamp === stamp) {
      const currentDbStamp = databaseChangeStamp(db);
      if (cached.metadata.stamp === currentDbStamp || cached.metadata.hash === this._scanMetadata(profileId, db).hash) {
        cached.metadata.stamp = currentDbStamp;
        cacheStamp = cached.fileStamp;
      }
    }
    let scan = this.scans.get(profileId);
    if (scan) {
      if (scan.retired || scan.completed || scan.workRoot !== root || scan.snapshotStamp !== cacheStamp || scan.ownerStamp !== stamp) return null;
    } else {
      if (joinOnly || this.scans.size >= MAX_SCAN_PROFILES) return null;
      const slot = this._idleScanWorker();
      if (!slot) return null;
      scan = this._scanSnapshot(profileId, root, cacheStamp, stamp, slot);
    }
    return { db, root, stamp, cached, cacheStamp, scan };
  }

  _assertScanOpen(profileId) {
    if (this.scanClosing || this.retiringScanProfiles.has(profileId)) {
      throw serviceError("MEMORY_SCOPE_REVOKED", "记忆文件扫描已停止");
    }
  }

  _drainScanQueue() {
    for (const waiter of this.scanQueue) {
      try {
        waiter.signal?.throwIfAborted();
        const admission = this._tryReadScan(waiter.profileId);
        if (admission) waiter.admit(admission);
      } catch (error) { waiter.fail(error); }
    }
  }

  _waitForReadScan(profileId, signal) {
    const busy = () => serviceError("MEMORY_SCAN_BUSY", "记忆读取扫描等待已满或超时");
    if (this.scanQueue.size >= MAX_SCAN_WAITERS) throw busy();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.scanQueue.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const waiter = { profileId, signal,
        admit: admission => { done(); resolve(admission); },
        fail: error => { done(); reject(error); } };
      const abort = () => waiter.fail(signal.reason);
      const timer = setTimeout(() => waiter.fail(busy()), SCAN_DEADLINE_MS);
      timer.unref();
      this.scanQueue.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async withAsyncReadView(profileId, signal, read, scanSignal = signal) {
    const waiting = scanSignal && signal && scanSignal !== signal ? AbortSignal.any([scanSignal, signal]) : scanSignal;
    waiting?.throwIfAborted();
    const { db, root, stamp, cached, cacheStamp, scan } = this._tryReadScan(profileId, this.scanQueue.size > 0)
      ?? await this._waitForReadScan(profileId, waiting);
    waiting?.throwIfAborted();
    let onAbort;
    const canceled = waiting && new Promise((_, reject) => {
      onAbort = () => reject(waiting.reason);
      waiting.addEventListener("abort", onAbort, { once: true });
    });
    let result;
    try { result = await (canceled ? Promise.race([scan.promise, canceled]) : scan.promise); }
    finally { if (onAbort) waiting.removeEventListener("abort", onAbort); }
    waiting?.throwIfAborted();
    this._assertScanOpen(profileId);
    this._check(profileId);
    if (scan.retired || db !== this.database.db || this.workspace(profileId) !== root
      || (scan.publishedOwnerStamp ?? stamp) !== this._fileOwnerStamp(profileId, db)) {
      throw serviceError("MEMORY_REVISION_CONFLICT", "扫描期间记忆或授权已经变化");
    }
    let snapshot;
    const currentDbStamp = databaseChangeStamp(db);
    const metadata = result.unchanged ? cached.metadata : scan.metadata;
    // Independent index writers can advance the shared DB stamp while this
    // worker runs. When it changes, compare only this Profile's bounded raw
    // metadata, including direct edits that skipped the public revision.
    if (!metadata || (metadata.stamp !== currentDbStamp && this._scanMetadata(profileId, db).hash !== metadata.hash)) {
      throw serviceError("MEMORY_REVISION_CONFLICT", "扫描期间记忆元数据已经变化");
    }
    if (result.unchanged) {
      if (result.fileStamp !== cacheStamp) {
        throw serviceError("MEMORY_REVISION_CONFLICT", "读取的记忆快照已经变化");
      }
      snapshot = cached.value;
    } else {
      const revisions = scan.revisions ||= transaction(db, () => {
        const tracked = this._trackedInvalidation(profileId);
        if (stamp !== this._fileOwnerStamp(profileId, db) || tracked?.fingerprint !== scan.tracked?.fingerprint
          || tracked?.revision !== scan.tracked?.revision || tracked?.files !== scan.tracked?.files) {
          throw serviceError("MEMORY_REVISION_CONFLICT", "扫描期间记忆失效证据已经变化");
        }
        return this._commitSnapshotRevision(profileId, scan.current, tracked, result.fingerprint, result.invalidation);
      });
      scan.publishedOwnerStamp = this._fileOwnerStamp(profileId, db);
      snapshot = { items: result.items, metadata: result.metadata, copies: result.copies, fileHashes: result.fileHashes,
        sharedDocuments: result.sharedDocuments, ...revisions };
    }
    const publishedDbStamp = databaseChangeStamp(db);
    const publishedOwnerStamp = this._fileOwnerStamp(profileId, db);
    this._cacheSnapshot(profileId, { stamp: `${publishedDbStamp}|${result.fileStamp}`, ownerStamp: publishedOwnerStamp,
      fileStamp: result.fileStamp, metadata: { hash: metadata.hash, stamp: publishedDbStamp }, value: snapshot });
    const fileIdentities = new Map(result.identities);
    const assertSharedDocumentCurrent = relative => {
      const expected = fileIdentities.get(relative);
      if (!expected || this.workspace(profileId) !== root || memoryPathIdentity(path.join(root, relative)) !== expected) {
        throw serviceError("MEMORY_REVISION_CONFLICT", "扫描后借阅文档路径发生变化");
      }
      return expected !== "-";
    };
    const assertFilesCurrent = () => {
      signal?.throwIfAborted();
      if (this.workspace(profileId) !== root || !Array.isArray(result.identities)
        || result.identities.some(([relative, identity]) => memoryPathIdentity(path.join(root, relative)) !== identity)) {
        throw serviceError("MEMORY_REVISION_CONFLICT", "扫描后记忆路径发生变化");
      }
    };
    const retainProof = this._retainReadProof({ profileId, db, snapshot, metadataHash: metadata.hash,
      publishedDbStamp, publishedOwnerStamp, signal, assertFilesCurrent, assertSharedDocumentCurrent });
    return this._useSnapshot(profileId, snapshot, read, assertFilesCurrent, retainProof, assertSharedDocumentCurrent);
  }

  _retainReadProof({ profileId, db, snapshot, metadataHash, publishedDbStamp, publishedOwnerStamp, signal, assertFilesCurrent,
    assertSharedDocumentCurrent }) {
    let proof;
    const retainProof = () => {
      if (proof) return proof;
      let verifiedDbStamp = publishedDbStamp, additiveDbStamp = publishedDbStamp;
      let knownIds;
      const invalidation = this._trackedInvalidation(profileId);
      const assertMetadataCurrent = (allowAdditions = false) => {
        this._check(profileId);
        if (this.database.db !== db) {
          throw serviceError("MEMORY_REVISION_CONFLICT", "记忆扫描版本已变化");
        }
        signal?.throwIfAborted();
        const currentDbStamp = databaseChangeStamp(db);
        if (currentDbStamp !== (allowAdditions ? additiveDbStamp : verifiedDbStamp)) {
          // Additive recall still rejects direct edits to metadata for any
          // old entry, including a handwritten projection that had no row.
          if (allowAdditions) knownIds ||= new Set([...snapshot.metadata.keys(), ...snapshot.items.map(item => item.id)]);
          if (metadataHash !== this._scanMetadata(profileId, db, false, allowAdditions ? knownIds : null).hash) {
            throw serviceError("MEMORY_REVISION_CONFLICT", "记忆扫描元数据已变化");
          }
          additiveDbStamp = currentDbStamp;
          if (!allowAdditions) verifiedDbStamp = currentDbStamp;
        }
      };
      const assertCurrent = () => {
        assertMetadataCurrent();
        const tracked = this._trackedInvalidation(profileId);
        if (this._fileOwnerStamp(profileId, db) !== publishedOwnerStamp || tracked?.revision !== invalidation?.revision
          || tracked?.fingerprint !== invalidation?.fingerprint || tracked?.files !== invalidation?.files) {
          throw serviceError("MEMORY_REVISION_CONFLICT", "记忆扫描版本已变化");
        }
        assertFilesCurrent();
      };
      proof = Object.freeze({
        current() { try { assertCurrent(); return true; } catch { return false; } },
        metadataCurrent({ allowAdditions = false } = {}) {
          try { assertMetadataCurrent(allowAdditions); return true; } catch { return false; }
        },
        read: next => {
          assertCurrent();
          return this._useSnapshot(profileId, snapshot, next, assertFilesCurrent, retainProof, assertSharedDocumentCurrent);
        },
      });
      return proof;
    };
    return retainProof;
  }

  _snapshotRevision(profileId) {
    return this.database.db.prepare("SELECT revision,fingerprint FROM memory_file_profiles WHERE profile_id=?").get(profileId);
  }
  _trackedInvalidation(profileId) {
    return this.database.db.prepare("SELECT fingerprint,revision,files FROM memory_file_invalidation WHERE profile_id=?").get(profileId);
  }
  _commitSnapshotRevision(profileId, current, tracked, fingerprint, invalidation) {
    if (current.fingerprint !== fingerprint) {
      this.database.db.prepare("UPDATE memory_file_profiles SET fingerprint=?,revision=revision+1 WHERE profile_id=?").run(fingerprint, profileId);
    }
    const revision = current.revision + Number(current.fingerprint !== fingerprint);
    if (invalidation) this._publishInvalidation(profileId, tracked, fingerprint, invalidation);
    return { revision, invalidationRevision: invalidation?.revision ?? tracked.revision };
  }
  // The last revision that changed or removed existing memory text. This row
  // tracks its own fingerprint, so an interrupted update is evaluated again.
  _publishInvalidation(profileId, tracked, fingerprint, invalidation) {
    const db = this.database.db;
    if (tracked) {
      db.prepare("UPDATE memory_file_invalidation SET fingerprint=?,revision=?,files=? WHERE profile_id=? AND fingerprint=?")
        .run(fingerprint, invalidation.revision, invalidation.files, profileId, tracked.fingerprint);
    } else {
      db.prepare("INSERT OR IGNORE INTO memory_file_invalidation VALUES (?,?,?,?)")
        .run(profileId, fingerprint, invalidation.revision, invalidation.files);
    }
  }
  _newItem(profileId, id, content, memoryPath) {
    return { id, profileId, scope: memoryPath === "USER.md" ? "user" : "agent", type: "semantic", content,
      sourceRefs: [`user-edit:${sha256(content)}`], confidence: 1, sensitivity: "normal", status: "active",
      validFrom: 0, validUntil: null, supersedes: null, createdAt: 0, updatedAt: 0,
      contentHash: sha256(content), memoryPath };
  }
  _readProjection(profileId) {
    for (let current = this.readScope; current; current = current.previous) {
      if (current.profileId === profileId) { current.check(); return current.snapshot; }
    }
    return this._snapshot(profileId);
  }
  getRevision(profileId) { return this._readProjection(profileId).revision; }
  getRevisions(profileId) {
    const { revision, invalidationRevision } = this._readProjection(profileId);
    return { revision, invalidationRevision };
  }
  list(profileId, filter = {}) {
    const snapshot = this._readProjection(profileId);
    // Legacy duplicate projection IDs retain their ordering in list(). The ID
    // accessor, like the old list().find(), resolves the first effective row.
    return this._listSnapshot(snapshot, filter);
  }
  _listSnapshot(snapshot, filter) {
    const rows = filter.status === "active" ? snapshot.items : [...snapshot.items, ...snapshotRows(snapshot).historical];
    return rows.filter(item => matchesFilter(item, filter)).map(item => structuredClone(item));
  }
  listPage(profileId, filter, { cursor, limit, maxBytes, isVisible }) {
    const snapshot = this._readProjection(profileId);
    const groups = filter.status === "active" ? [snapshot.items]
      : [snapshot.items, snapshotRows(snapshot).historical];
    const items = [];
    let skipped = 0, bytes = 0;
    for (const rows of groups) {
      for (const item of rows) {
        if (!matchesFilter(item, filter) || !isVisible(item)) continue;
        if (skipped < cursor) { skipped += 1; continue; }
        if (items.length === limit) return { items, nextCursor: cursor + items.length, hasMore: true };
        const size = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (items.length && bytes + size > maxBytes) return { items, nextCursor: cursor + items.length, hasMore: true };
        if (size > maxBytes) throw serviceError("HARNESS_RESPONSE_TOO_LARGE", "单条记录超过响应预算");
        items.push(structuredClone(item));
        bytes += size;
      }
    }
    return { items, nextCursor: cursor + items.length, hasMore: false };
  }
  listActiveFile(profileId, relative) {
    const rows = snapshotRows(this._readProjection(profileId)).byPath.get(relative) || [];
    return rows.map(item => structuredClone(item));
  }
  _getSnapshotItem(snapshot, id) {
    const item = snapshotRows(snapshot).byId.get(id);
    return item ? structuredClone(item) : null;
  }
  get(profileId, id) { return this._getSnapshotItem(this._readProjection(profileId), id); }
  getContentRevision(profileId, id, expectedHash) {
    const snapshot = this._readProjection(profileId), item = snapshotRows(snapshot).byId.get(id);
    return item && (expectedHash == null || sha256(item.content) === expectedHash) ? item.contentRevision ?? snapshot.revision : null;
  }
  getItemWriteProof(profileId, id) {
    const snapshot = this._readProjection(profileId), item = snapshotRows(snapshot).byId.get(id);
    return item ? { contentHash: sha256(item.content), revision: snapshot.revision } : null;
  }
  // A view belongs to one synchronous read-only batch. A new public read
  // checks filesystem identity again, even in the same event-loop turn.
  withReadView(profileId, read) {
    return this._useSnapshot(profileId, this._readProjection(profileId), read);
  }
  async withCommittedReadView(profileId, read, signal) {
    let started = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.withAsyncReadView(profileId, signal, view => {
          view.assertFilesCurrent();
          started = true;
          return read(view);
        });
      } catch (error) {
        if (started) throw error;
        signal?.throwIfAborted();
        // A recall-policy subscriber can advance the projection revision
        // during the scan. Retry the read once before using the fallback.
        if (attempt === 0 && ["MEMORY_REVISION_CONFLICT", "MEMORY_READ_VIEW_STALE"].includes(error?.code)) continue;
        // The write committed. If its worker view is unavailable, keep the
        // authoritative synchronous readback used by existing write receipts.
        return this.withReadView(profileId, read);
      }
    }
  }
  _useSnapshot(profileId, snapshot, read, assertFilesCurrent, retainProof, assertSharedDocumentCurrent) {
    const db = this.database.db, stamp = databaseChangeStamp(db);
    let current = true;
    const check = () => {
      if (!current || !this.opened || !this.ready.has(profileId) || this.database.db !== db
        || databaseChangeStamp(db) !== stamp) throw serviceError("MEMORY_READ_VIEW_STALE", "记忆读取快照已失效");
    };
    const view = Object.freeze({
      ...(assertFilesCurrent ? { assertFilesCurrent() { check(); assertFilesCurrent(); } } : {}),
      ...(retainProof ? { retainProof() { check(); return retainProof(); } } : {}),
      ...(assertSharedDocumentCurrent && snapshot.sharedDocuments ? { sharedDocument(relative) {
        check();
        if (!snapshot.sharedDocuments.has(relative)) return undefined;
        if (!assertSharedDocumentCurrent(relative)) throw serviceError("ENOENT", "借阅文档已删除");
        return snapshot.sharedDocuments.get(relative);
      } } : {}),
      get: id => { check(); return this._getSnapshotItem(snapshot, id); },
      list: (filter = {}) => { check(); return this._listSnapshot(snapshot, filter); },
      listActiveFile: relative => {
        check();
        return (snapshotRows(snapshot).byPath.get(relative) || []).map(item => structuredClone(item));
      },
      getRevisions: () => {
        check();
        return { revision: snapshot.revision, invalidationRevision: snapshot.invalidationRevision };
      },
      matchesFile: (relative, contents) => {
        check();
        return snapshot.fileHashes?.get(relative) === sha256(contents)
          || (contents === "" && !snapshot.fileHashes?.has(relative));
      },
    });
    const previous = this.readScope;
    this.readScope = { profileId, snapshot, check, previous };
    try {
      const result = read(view);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw new TypeError("Memory read view requires a synchronous callback");
      }
      check();
      return result;
    } finally { current = false; this.readScope = previous; }
  }
  listHistoricalSourceItems(profileId) {
    const row = this.database.db.prepare("SELECT data FROM memory_file_history WHERE profile_id=?").get(profileId);
    return [...(row ? JSON.parse(row.data) : []), ...this.list(profileId).filter(item => item.status !== "active" || item.validUntil !== null)
      .map(item => ({ ...item, sourceBindingVerified: true }))];
  }
  forgetProfile(profileId) {
    void this.stopScans(profileId);
    this.ready.delete(profileId); this.snapshots.delete(profileId);
    this.database.db.prepare("DELETE FROM memory_report_evidence WHERE profile_id=?").run(profileId);
    for (const table of ["memory_file_profiles", "memory_file_records", "memory_file_pending", "memory_file_history", "memory_file_invalidation"]) {
      this.database.db.prepare(`DELETE FROM ${table} WHERE profile_id=?`).run(profileId);
    }
  }
  readFile(profileId, relative) { this._check(profileId); return this._read(profileId, relative); }

  registerReportEvidence(profileId, { path: relative, startLine, endLine, sources, sourceHash, rangeHash } = {}) {
    this._check(profileId);
    if (!canonicalSharedPath(relative) || !Array.isArray(sources) || !sources.length || sources.length > 200) throw serviceError("MEMORY_REPORT_EVIDENCE_INVALID", "整理报告缺少可验证来源");
    const text = this.getHost(profileId).searchIndex.sourceFiles.read(relative).text, lines = text.split("\n");
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine
      || endLine > lines.length || endLine - startLine > 1000) throw serviceError("MEMORY_REPORT_EVIDENCE_INVALID", "整理报告必须指定被证明的输出范围");
    const outputHash = sha256(lines.slice(startLine - 1, endLine).join("\n"));
    if (sourceHash && sha256(text) !== sourceHash || rangeHash && outputHash !== rangeHash) throw serviceError("MEMORY_SOURCE_CHANGED", "整理报告在登记来源前已变化");
    const evidence = sources.map(source => {
      if (typeof source?.path !== "string" || !Number.isSafeInteger(source.startLine) || source.startLine < 1
        || !Number.isSafeInteger(source.endLine) || source.endLine < source.startLine || source.endLine - source.startLine > 1000
        || !/^[a-f0-9]{64}$/u.test(source.sourceHash || "")) throw serviceError("MEMORY_REPORT_EVIDENCE_INVALID", "整理报告来源范围无效");
      const original = this.getHost(profileId).searchIndex.sourceFiles.read(source.path).text.split("\n");
      if (source.endLine > original.length) throw serviceError("MEMORY_REPORT_EVIDENCE_INVALID", "整理报告原始来源范围无效");
      if (sha256(original.slice(source.startLine - 1, source.endLine).join("\n")) !== source.sourceHash) throw serviceError("MEMORY_SOURCE_CHANGED", "整理报告原始来源已变化");
      return { path: source.path, startLine: source.startLine, endLine: source.endLine, sourceHash: source.sourceHash };
    });
    transaction(this.database.db, () => {
      const write = this.database.db.prepare("INSERT OR REPLACE INTO memory_report_evidence VALUES (?,?,?,?,?)");
      for (let index = startLine - 1; index < endLine; index++) {
        const line = lines[index];
        if (documentKind(relative, text, index + 1, index + 1) !== "reflection_report" || !line.trim() || /^\s*(?:#|<!--)/u.test(line)) continue;
        write.run(profileId, relative, index + 1, sha256(line), JSON.stringify({ version: 1, sources: evidence }));
      }
    });
  }
  reportEvidence(profileId, relative, startLine, endLine, memoryView) {
    this._check(profileId);
    const text = this.getHost(profileId).searchIndex.sourceFiles.read(relative, memoryView).text;
    const lines = text.split("\n"), sources = new Map(), proofs = [];
    const read = this.database.db.prepare("SELECT source_hash,data FROM memory_report_evidence WHERE profile_id=? AND path=? AND line=?");
    let substantive = 0;
    for (let index = startLine - 1; index < Math.min(endLine, lines.length); index++) {
      const line = lines[index];
      if (!line.trim() || /^\s*(?:#|<!--)/u.test(line)) continue;
      substantive++;
      const row = read.get(profileId, relative, index + 1);
      if (!row || row.source_hash !== sha256(line)) return null;
      const proof = JSON.parse(row.data);
      if (proof.version !== 1 || !Array.isArray(proof.sources) || !proof.sources.length || proof.sources.length > 200) return null;
      const direct = [];
      for (const source of proof.sources) {
        if (Object.keys(source || {}).sort().join(",") !== "endLine,path,sourceHash,startLine" || typeof source?.path !== "string" || !source.path || source.path.length > 4096 || source.path.includes("\0")
          || !Number.isSafeInteger(source.startLine) || source.startLine < 1 || !Number.isSafeInteger(source.endLine)
          || source.endLine < source.startLine || source.endLine - source.startLine > 1000 || !/^[a-f0-9]{64}$/u.test(source.sourceHash || "")) return null;
        const ref = { path: source.path, startLine: source.startLine, endLine: source.endLine, sourceHash: source.sourceHash };
        sources.set(`${ref.path}:${ref.startLine}:${ref.endLine}:${ref.sourceHash}`, ref); direct.push(ref);
      }
      proofs.push({ line: index + 1, sourceHash: row.source_hash, sources: direct });
    }
    // These are direct body-free dependencies. The caller must recursively
    // revalidate current origins and its own permission before granting them.
    return substantive && sources.size ? { sources: [...sources.values()], lines: proofs } : null;
  }

  _commitPending(profileId, plan) {
    const db = this.database.db;
    transaction(db, () => {
      const revision = db.prepare("SELECT revision FROM memory_file_profiles WHERE profile_id=?").get(profileId).revision + 1;
      for (const item of plan.records) {
        const previousRow = db.prepare("SELECT data FROM memory_file_records WHERE profile_id=? AND id=?").get(profileId, item.id);
        const previous = previousRow && JSON.parse(previousRow.data);
        const contentRevision = previous?.contentHash === item.contentHash ? previous.contentRevision ?? revision : revision;
        db.prepare("INSERT OR REPLACE INTO memory_file_records VALUES (?,?,?)").run(profileId, item.id, JSON.stringify({ ...item, contentRevision }));
      }
      db.prepare("UPDATE memory_file_profiles SET revision=revision+1,fingerprint='' WHERE profile_id=?").run(profileId);
      // A plan written before this flag existed may have rewritten active items.
      if (plan.invalidating !== false) db.prepare("UPDATE memory_file_invalidation SET revision=? WHERE profile_id=?").run(revision, profileId);
      db.prepare("DELETE FROM memory_file_pending WHERE profile_id=?").run(profileId);
    });
    try { this.onChanged(profileId); } catch {}
  }
  recover(profileId) {
    const row = this.database.db.prepare("SELECT data FROM memory_file_pending WHERE profile_id=?").get(profileId);
    if (!row) return;
    const plan = JSON.parse(row.data);
    const { assertNoBorrowedMemoryWrite } = require("./borrowed-memory-provenance.cjs");
    for (const record of plan.records) assertNoBorrowedMemoryWrite(record, plan);
    for (const file of plan.files) {
      const current = sha256(this._read(profileId, file.path));
      if (current !== file.beforeHash && current !== sha256(file.after)) throw serviceError("MEMORY_RECOVERY_CONFLICT", "记忆文件在恢复前已被修改，保留两份数据");
    }
    for (const file of plan.files) {
      if (sha256(this._read(profileId, file.path)) !== sha256(file.after)) atomicWritePrivateFile(path.join(this.workspace(profileId), file.path), file.after, { trustedRoot: this.paths.trustedRoot });
    }
    this._commitPending(profileId, plan);
  }

  async _readWriteSnapshot(profileId, signal) {
    try {
      return await this.withAsyncReadView(profileId, signal, view => {
        view.assertFilesCurrent();
        return { snapshot: this._readProjection(profileId), proof: view.retainProof() };
      });
    } catch (error) {
      // Existing oversized workspaces can still be edited under the writer
      // lock. A busy, canceled, or uncertain worker never permits a write.
      if (error.code !== "MEMORY_SCAN_TOO_LARGE") throw error;
      signal?.throwIfAborted();
      return { snapshot: this._snapshot(profileId), proof: null };
    }
  }

  async upsertMany(records, options = {}) {
    const { expectedRevision = null, assertCurrent = () => {}, beforeIntent, signal } = options;
    const { assertNoBorrowedMemoryWrite } = require("./borrowed-memory-provenance.cjs");
    for (const record of records) assertNoBorrowedMemoryWrite(record, options);
    if (!records.length) return [];
    const profileId = records[0].profileId, host = this.getHost(profileId);
    return host.run(() => core.withMemoryWorkspaceLock(this.workspace(profileId), async () => {
      host.assertCurrent();
      if (new Set(records.map(item => item.id)).size !== records.length || records.some(item => item.profileId !== profileId || !ID.test(item.id))) throw new Error("Invalid memory transaction records");
      const { snapshot, proof } = await this._readWriteSnapshot(profileId, signal);
      if (expectedRevision !== null && snapshot.revision !== expectedRevision) throw serviceError("MEMORY_REVISION_CONFLICT", "Memory revision 已变化");
      const writes = new Map(), newRecords = [];
      const activeById = snapshotRows(snapshot).byId;
      let invalidating = false;
      const contentFor = relative => {
        if (!writes.has(relative)) { const before = this._read(profileId, relative); writes.set(relative, { path: relative, beforeHash: sha256(before), after: before }); }
        return writes.get(relative);
      };
      for (const input of records) {
        const current = activeById.get(input.id);
        const old = current?.status === "active" ? current : snapshot.metadata.get(input.id);
        // Rewriting an active item can change metadata (expiry, scope) even
        // when its rendered text is identical.
        if (old?.status === "active") invalidating = true;
        if (input.memoryPath !== undefined && !/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(input.memoryPath)
          && input.memoryPath !== old?.memoryPath) throw new Error("Invalid memory append target");
        const relative = old?.memoryPath || input.memoryPath || (input.scope === "user" ? "USER.md" : "MEMORY.md");
        const file = contentFor(relative);
        const oldEntry = splitEntries(file.after).find(entry => entry.id === input.id);
        // Snapshot line bounds/file hash/document kind are read evidence. Only strip values
        // created by this exact locked snapshot, never persisted metadata or a
        // caller's unmatched/unknown semantics. Keep the raw old row for this
        // proof because snapshot.items overlays those read fields.
        const persisted = snapshot.metadata.get(input.id);
        const writeInput = { ...input };
        for (const key of ["startLine", "endLine", "fileHash", "documentKind"]) {
          if (Object.hasOwn(writeInput, key) && old && !Object.hasOwn(persisted || {}, key)
            && Object.hasOwn(old, key) && writeInput[key] === old[key]) delete writeInput[key];
        }
        const entry = { ...writeInput, memoryPath: relative, contentHash: sha256(input.content) };
        if (oldEntry) file.after = file.after.slice(0, oldEntry.start) + file.after.slice(oldEntry.end);
        else if (old?.projection) {
          const lines = file.after.split("\n");
          if (old.fileHash !== sha256(file.after)) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化");
          lines.splice(old.startLine - 1, old.endLine - old.startLine + 1); file.after = lines.join("\n");
        }
        // Once the original block moves, a hand-copied block with the same ID
        // would take over this memory. Keep those copies as hand-written text.
        for (const memoryPath of snapshot.copies.get(input.id) || []) {
          const copy = contentFor(memoryPath);
          copy.after = unmarkEntries(copy.after, input.id);
        }
        if (entry.status === "active") file.after = file.after.trimEnd() + "\n\n" + renderMemoryEntry(entry);
        newRecords.push(entry);
      }
      const plan = { schemaVersion: 1, profileId, files: [...writes.values()], records: newRecords, invalidating };
      const check = view => {
        signal?.throwIfAborted();
        assertCurrent(); host.assertCurrent();
        view?.assertFilesCurrent();
        for (const file of plan.files) {
          if (sha256(this._read(profileId, file.path)) !== file.beforeHash) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化");
        }
        beforeIntent?.();
      };
      if (proof) proof.read(check);
      else check();
      this.database.db.prepare("INSERT INTO memory_file_pending VALUES (?,?)").run(profileId, JSON.stringify(plan));
      // Failure leaves a durable intent and closes reads until recovery settles it.
      for (const file of plan.files) {
        // No await occurs after the last source check and before commit. Source
        // checks may read memory, so do not re-enter them while reads are fenced.
        host.assertCurrent();
        if (sha256(this._read(profileId, file.path)) !== file.beforeHash) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化");
        atomicWritePrivateFile(path.join(this.workspace(profileId), file.path), file.after, { trustedRoot: this.paths.trustedRoot });
      }
      this._commitPending(profileId, plan);
      return this.withCommittedReadView(profileId, view => records.map(item => view.get(item.id)));
    }));
  }
  async upsert(item, options) { return (await this.upsertMany([item], options))[0]; }
  // A whole-file edit of USER.md or MEMORY.md from the settings page or a
  // conversation. Reads accept any hand-edited text; this only serializes the
  // write with memory transactions and checks the expected file hash.
  async writeDocument(profileId, relative, content, expectedHash, assertCurrent) {
    if (!["USER.md", "MEMORY.md"].includes(relative)) throw serviceError("MEMORY_PATH_NOT_ALLOWED", "不是核心记忆文件");
    if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0")
      || Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) throw serviceError("MEMORY_DOCUMENT_INVALID", "记忆文件内容无效或过大");
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash)) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化，请重新读取");
    const host = this.getHost(profileId);
    return host.run(() => core.withMemoryWorkspaceLock(this.workspace(profileId), async () => {
      this._check(profileId); host.assertCurrent();
      if (sha256(this._read(profileId, relative)) !== expectedHash) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化，请重新读取");
      const { snapshot, proof } = await this._readWriteSnapshot(profileId);
      const previous = snapshot.items.filter(item => item.memoryPath === relative);
      const check = view => {
        assertCurrent?.(); host.assertCurrent();
        view?.assertFilesCurrent();
        if (sha256(this._read(profileId, relative)) !== expectedHash) throw serviceError("MEMORY_REVISION_CONFLICT", "记忆文件已变化");
      };
      if (proof) proof.read(check);
      else check();
      atomicWritePrivateFile(path.join(this.workspace(profileId), relative), content, { trustedRoot: this.paths.trustedRoot });
      this.snapshots.delete(profileId);
      try { this.onChanged(profileId); } catch {}
      return { content, revision: sha256(content), previous };
    }));
  }
}

module.exports = { FileMemoryStore, projectInvalidation, splitEntries };
