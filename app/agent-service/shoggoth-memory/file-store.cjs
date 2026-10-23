"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile } = require("../private-file");
const { serviceError } = require("../security");
const { transaction } = require("../inspiration-database");
const { renderMemoryEntry, sha256 } = require("./migration.cjs");
const { core } = require("./host.cjs");
const { canonicalSharedPath, documentKind } = require("./shared-document.cjs");
const { databaseChangeStamp } = require("../turn-memo");

const ENTRY = /<!-- shoggoth-memory-entry:([A-Za-z0-9][A-Za-z0-9._:-]{0,255}) -->\n([\s\S]*?)\n<!-- \/shoggoth-memory-entry -->/g;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_file_profiles (profile_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_records (profile_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,id)) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_pending (profile_id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_history (profile_id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
CREATE TABLE IF NOT EXISTS memory_report_evidence (profile_id TEXT NOT NULL,path TEXT NOT NULL,line INTEGER NOT NULL,source_hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(profile_id,path,line)) STRICT;
CREATE TABLE IF NOT EXISTS memory_file_invalidation (profile_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,files TEXT NOT NULL CHECK(json_valid(files))) STRICT;
`;

function sourceDigests(files) {
  return files.map(file => {
    const text = file.content.trimEnd();
    return { path: file.path, length: text.length, hash: sha256(text) };
  });
}
// True when every earlier source still exists and only had text appended.
// Any edit, removal or deleted file may withdraw a fact a native session holds.
function sourcesOnlyAppended(previous, files) {
  const current = new Map(files.map(file => [file.path, file.content.trimEnd()]));
  return Array.isArray(previous) && previous.every(entry => {
    const text = current.get(entry?.path);
    return typeof text === "string" && Number.isSafeInteger(entry.length) && text.length >= entry.length
      && sha256(text.slice(0, entry.length)) === entry.hash;
  });
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
    output.push({ id: match[1], content: textContent(match[2]), start: match.index, end: expression.lastIndex,
      startLine, endLine: startLine + match[0].split("\n").length - 1 });
  }
  return output;
}

// Metadata carries provenance, revocation and compatibility IDs. Every active
// fact's content is read from the Markdown source, never from the metadata row.
class FileMemoryStore {
  constructor({ paths, database, migration, initialization = null, getHost, now = Date.now }) {
    this.paths = paths; this.database = database; this.migration = migration; this.initialization = initialization; this.getHost = getHost; this.now = now;
    this.opened = false; this.ready = new Set(); this.snapshots = new Map();
  }
  open() { if (this.opened) return; this.database.open(); this.database.db.exec(SCHEMA); this.opened = true; }
  close() { this.opened = false; this.ready.clear(); this.snapshots.clear(); }
  assertOpen() { if (!this.opened) throw serviceError("MEMORY_STORE_CLOSED", "记忆存储未打开"); }
  workspace(profileId) { if (!ID.test(profileId)) throw new Error("Invalid memory Profile"); return (this.initialization || this.migration).locations(profileId).workspace; }

  ensureProfile(profileId) {
    this.assertOpen();
    if (!this.ready.has(profileId)) {
      if (this.initialization) {
        this.initialization.run(profileId); this.recover(profileId); this.ready.add(profileId);
        return this.getRevision(profileId);
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
    return this.getRevision(profileId);
  }

  _check(profileId) {
    this.assertOpen();
    if (!this.ready.has(profileId)) throw serviceError("MEMORY_MIGRATION_REQUIRED", "记忆迁移尚未完成");
    this.initialization?.assertOwned(profileId);
    if (this.database.db.prepare("SELECT 1 FROM memory_file_pending WHERE profile_id=?").get(profileId)) {
      throw serviceError("MEMORY_TRANSACTION_UNSETTLED", "记忆写入等待恢复");
    }
  }
  _read(profileId, relative) {
    if (relative !== "USER.md" && !core.isMemoryPath(relative)) throw serviceError("MEMORY_PATH_NOT_ALLOWED", "不是记忆文件");
    const root = this.workspace(profileId), target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep) || fs.realpathSync.native(root) !== root) throw new Error("Memory workspace alias is unsafe");
    try {
      if (fs.realpathSync.native(target) !== target) throw new Error("Memory source symlink is unsafe");
      return readPrivateFile(target, { maxBytes: 256 * 1024 * 1024 }).toString("utf8");
    } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  }
  _files(profileId) {
    const files = ["USER.md", "MEMORY.md"], root = this.workspace(profileId);
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
        if (child.isSymbolicLink()) throw new Error("Memory source symlink is unsafe");
        const name = path.posix.join(relative, child.name);
        if (child.isDirectory() && !child.name.startsWith(".")) walk(name);
        else if (child.isFile() && child.name.endsWith(".md")) files.push(name);
      }
    };
    walk("memory");
    return files.sort().map(relative => ({ path: relative, content: this._read(profileId, relative) }));
  }
  _metadata(profileId) {
    return new Map(this.database.db.prepare("SELECT id,data FROM memory_file_records WHERE profile_id=?").all(profileId)
      .map(row => [row.id, JSON.parse(row.data)]));
  }
  // Every recall check reads the revision. Reuse the projection while every
  // source file and directory entry has the same identity, size and times and
  // the database is unchanged; any writer, in this process or not, changes one.
  _sourceStamp(profileId) {
    const root = this.workspace(profileId), parts = [databaseChangeStamp(this.database.db)];
    const stat = target => {
      try {
        const value = fs.lstatSync(target, { bigint: true });
        return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
      } catch (error) { if (error.code === "ENOENT") return "-"; throw error; }
    };
    parts.push(stat(root));
    for (const name of ["USER.md", "MEMORY.md", "DREAMS.md", "dreams.md"]) parts.push(name, stat(path.join(root, name)));
    const walk = relative => {
      const directory = path.join(root, relative);
      parts.push(relative, stat(directory));
      let children;
      try { children = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return; throw error; }
      for (const child of children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
        const name = path.posix.join(relative, child.name);
        if (child.isDirectory() && !child.name.startsWith(".")) walk(name);
        else if (child.isSymbolicLink() || (child.isFile() && child.name.endsWith(".md"))) parts.push(name, stat(path.join(root, name)));
      }
    };
    walk("memory");
    return parts.join("|");
  }
  _snapshot(profileId) {
    this._check(profileId);
    const stamp = this._sourceStamp(profileId), cached = this.snapshots.get(profileId);
    if (cached?.stamp === stamp) return cached.value;
    const value = this._readSnapshot(profileId);
    // Reuse only a read that saw a stable source. Publishing a new fingerprint
    // or a concurrent change is simply read again on the next call.
    if (this._sourceStamp(profileId) === stamp) this.snapshots.set(profileId, { stamp, value });
    else this.snapshots.delete(profileId);
    return value;
  }
  _readSnapshot(profileId) {
    const files = this._files(profileId), metadata = this._metadata(profileId), items = [], ids = new Set();
    for (const file of files) {
      const entries = splitEntries(file.content);
      for (const entry of entries) {
        if (ids.has(entry.id)) throw serviceError("MEMORY_DUPLICATE_ID", "记忆文件含重复标识");
        ids.add(entry.id);
        const previous = metadata.get(entry.id), unchanged = previous?.contentHash === sha256(entry.content);
        items.push({ ...(unchanged ? previous : this._newItem(profileId, entry.id, entry.content, file.path)),
          id: entry.id, content: entry.content, status: "active", memoryPath: file.path,
          startLine: entry.startLine, endLine: entry.endLine, fileHash: sha256(file.content),
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
        items.push({ ...this._newItem(profileId, id, chunk.text, file.path), authorityText,
          startLine: chunk.startLine, endLine: chunk.endLine, fileHash: sha256(file.content), projection: true,
          documentKind: documentKind(file.path, file.content, chunk.startLine, chunk.endLine) });
      }
    }
    const fingerprint = sha256(JSON.stringify(files));
    const current = this.database.db.prepare("SELECT * FROM memory_file_profiles WHERE profile_id=?").get(profileId);
    if (current.fingerprint !== fingerprint) {
      this.database.db.prepare("UPDATE memory_file_profiles SET fingerprint=?,revision=revision+1 WHERE profile_id=?").run(fingerprint, profileId);
    }
    const revision = current.revision + Number(current.fingerprint !== fingerprint);
    return { items, metadata, revision, invalidationRevision: this._invalidationRevision(profileId, files, fingerprint, revision) };
  }
  // The last revision that changed or removed existing memory text. This row
  // tracks its own fingerprint, so an interrupted update is evaluated again.
  _invalidationRevision(profileId, files, fingerprint, revision) {
    const db = this.database.db;
    const tracked = db.prepare("SELECT fingerprint,revision,files FROM memory_file_invalidation WHERE profile_id=?").get(profileId);
    if (tracked?.fingerprint === fingerprint && tracked.revision <= revision) return tracked.revision;
    let previous = null;
    try { previous = tracked ? JSON.parse(tracked.files) : null; } catch { previous = null; }
    // No usable record, or one from another revision sequence, counts as a change now.
    const appended = tracked && tracked.revision <= revision && sourcesOnlyAppended(previous, files);
    const invalidationRevision = appended ? tracked.revision : revision;
    const digests = JSON.stringify(sourceDigests(files));
    if (tracked) {
      db.prepare("UPDATE memory_file_invalidation SET fingerprint=?,revision=?,files=? WHERE profile_id=? AND fingerprint=?")
        .run(fingerprint, invalidationRevision, digests, profileId, tracked.fingerprint);
    } else {
      db.prepare("INSERT OR IGNORE INTO memory_file_invalidation VALUES (?,?,?,?)").run(profileId, fingerprint, invalidationRevision, digests);
    }
    return invalidationRevision;
  }
  _newItem(profileId, id, content, memoryPath) {
    return { id, profileId, scope: memoryPath === "USER.md" ? "user" : "agent", type: "semantic", content,
      sourceRefs: [`user-edit:${sha256(content)}`], confidence: 1, sensitivity: "normal", status: "active",
      validFrom: 0, validUntil: null, supersedes: null, createdAt: 0, updatedAt: 0,
      contentHash: sha256(content), memoryPath };
  }
  getRevision(profileId) { return this._snapshot(profileId).revision; }
  getRevisions(profileId) {
    const { revision, invalidationRevision } = this._snapshot(profileId);
    return { revision, invalidationRevision };
  }
  list(profileId, filter = {}) {
    const { items, metadata } = this._snapshot(profileId);
    const activeIds = new Set(items.map(item => item.id));
    const rows = [...items, ...[...metadata.values()].filter(item => !activeIds.has(item.id)).map(item => ({ ...item, status: item.status === "active" ? "deleted" : item.status }))];
    return rows.filter(item => (!filter.status || item.status === filter.status) && (!filter.scope || item.scope === filter.scope) && (!filter.type || item.type === filter.type)).map(item => structuredClone(item));
  }
  get(profileId, id) { return this.list(profileId).find(item => item.id === id) || null; }
  getContentRevision(profileId, id, expectedHash) {
    const item = this.get(profileId, id);
    return item && (expectedHash == null || sha256(item.content) === expectedHash) ? item.contentRevision ?? this.getRevision(profileId) : null;
  }
  getItemWriteProof(profileId, id) { const item = this.get(profileId, id); return item ? { contentHash: sha256(item.content), revision: this.getRevision(profileId) } : null; }
  listHistoricalSourceItems(profileId) {
    const row = this.database.db.prepare("SELECT data FROM memory_file_history WHERE profile_id=?").get(profileId);
    return [...(row ? JSON.parse(row.data) : []), ...this.list(profileId).filter(item => item.status !== "active" || item.validUntil !== null)
      .map(item => ({ ...item, sourceBindingVerified: true }))];
  }
  forgetProfile(profileId) {
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
  reportEvidence(profileId, relative, startLine, endLine) {
    this._check(profileId);
    const text = this.getHost(profileId).searchIndex.sourceFiles.read(relative).text, lines = text.split("\n"), sources = new Map(), proofs = [];
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

  async upsertMany(records, options = {}) {
    const { expectedRevision = null, assertCurrent = () => {} } = options;
    const { assertNoBorrowedMemoryWrite } = require("./borrowed-memory-provenance.cjs");
    for (const record of records) assertNoBorrowedMemoryWrite(record, options);
    if (!records.length) return [];
    const profileId = records[0].profileId, host = this.getHost(profileId);
    return host.run(() => core.withMemoryWorkspaceLock(this.workspace(profileId), async () => {
      this._check(profileId); assertCurrent();
      const snapshot = this._snapshot(profileId);
      if (expectedRevision !== null && snapshot.revision !== expectedRevision) throw serviceError("MEMORY_REVISION_CONFLICT", "Memory revision 已变化");
      if (new Set(records.map(item => item.id)).size !== records.length || records.some(item => item.profileId !== profileId || !ID.test(item.id))) throw new Error("Invalid memory transaction records");
      const writes = new Map(), newRecords = [];
      let invalidating = false;
      const contentFor = relative => {
        if (!writes.has(relative)) { const before = this._read(profileId, relative); writes.set(relative, { path: relative, beforeHash: sha256(before), after: before }); }
        return writes.get(relative);
      };
      for (const input of records) {
        const old = snapshot.items.find(item => item.id === input.id) || snapshot.metadata.get(input.id);
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
        if (entry.status === "active") file.after = file.after.trimEnd() + "\n\n" + renderMemoryEntry(entry);
        newRecords.push(entry);
      }
      const plan = { schemaVersion: 1, profileId, files: [...writes.values()], records: newRecords, invalidating };
      assertCurrent(); host.assertCurrent();
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
      return records.map(item => this.get(profileId, item.id));
    }));
  }
  async upsert(item, options) { return (await this.upsertMany([item], options))[0]; }
}

module.exports = { FileMemoryStore, splitEntries };
