"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  atomicWritePrivateFile,
  readPrivateFile,
} = require("./private-file");
const {
  ensurePrivateDirectoryTree,
  lstatIfExists,
  serviceError,
} = require("./security");
const { DEFAULT_DOCUMENTS, DEFAULT_TEMPLATE_VERSION, V3_DEFAULT_AGENTS,
  createDefaultDocuments } = require("./agent-definition-defaults");
const { createLegacyV4Identity, LEGACY_INITIAL_IDENTITY_HEADING } = require("./agent-definition-legacy-defaults");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const { advanceProvenance } = require("./agent-definition-provenance");

const DEFINITION_SCHEMA_VERSION = 1;
const DEFINITION_EXPORT_FORMAT = "shoggoth-agent-definition-v1";
const DOCUMENT_KINDS = Object.freeze(["IDENTITY", "SOUL", "USER", "AGENTS"]);
const GENERATED_VIEW_KINDS = Object.freeze(["TOOLS", "MEMORY"]);
const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024;
const DEFAULT_MAX_EXPORT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_BACKUPS = 3;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEEPSEEK_BUILTIN_PROFILE = BUILTIN_CLI_AGENT_PROFILES.find(
  (profile) => profile.runtime === "deepseek-harness",
);
const PREVIOUS_DEEPSEEK_NAME = "DeepSeek Harness";

function definitionError(code, message) {
  return serviceError(code, message);
}

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertProfileId(profileId) {
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)
    || profileId === "." || profileId === "..") {
    throw definitionError("DEFINITION_PROFILE_INVALID", "Agent Definition profileId 无效");
  }
  return profileId;
}

function assertContent(content, kind, maxDocumentBytes) {
  if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0")) {
    throw definitionError("DEFINITION_DOCUMENT_INVALID", `${kind}.md 必须是有效 UTF-8 文本`);
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > maxDocumentBytes) {
    throw definitionError("DEFINITION_DOCUMENT_TOO_LARGE", `${kind}.md 超过字节上限`);
  }
  return byteLength;
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validateDocuments(documents, maxDocumentBytes, { partial = false } = {}) {
  if (!documents || typeof documents !== "object" || Array.isArray(documents)
    || Object.getPrototypeOf(documents) !== Object.prototype) {
    throw definitionError("DEFINITION_DOCUMENT_INVALID", "Definition documents 必须是对象");
  }
  const keys = Object.keys(documents);
  if ((!partial && keys.length !== DOCUMENT_KINDS.length)
    || keys.some((kind) => !DOCUMENT_KINDS.includes(kind))) {
    throw definitionError("DEFINITION_DOCUMENT_INVALID", "Definition documents 字段无效");
  }
  if (!partial && DOCUMENT_KINDS.some((kind) => !Object.hasOwn(documents, kind))) {
    throw definitionError("DEFINITION_DOCUMENT_INVALID", "Definition documents 不完整");
  }
  const result = {};
  for (const kind of keys) {
    assertContent(documents[kind], kind, maxDocumentBytes);
    result[kind] = documents[kind];
  }
  return result;
}

function manifestChecksum(manifest) {
  const copy = { ...manifest };
  delete copy.checksum;
  return sha256(stableJson(copy));
}

function validateManifest(manifest, expectedProfileId = null) {
  const fields = [
    "schemaVersion", "profileId", "revision", "documents", "actor", "reason",
    "createdAt", "updatedAt", "checksum",
  ];
  if (manifest?.schemaVersion === 2) fields.push("storage");
  if (!exactKeys(manifest, fields) || ![1, 2].includes(manifest.schemaVersion)
    || (manifest.schemaVersion === 2 && !["workspace", "backup"].includes(manifest.storage))
    || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1
    || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0
    || !Number.isSafeInteger(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt
    || typeof manifest.actor !== "string" || manifest.actor.length === 0
    || (manifest.reason !== null && typeof manifest.reason !== "string")
    || !HASH_PATTERN.test(manifest.checksum)) {
    throw definitionError("DEFINITION_MANIFEST_INVALID", "Agent Definition manifest 无效");
  }
  assertProfileId(manifest.profileId);
  if (expectedProfileId !== null && manifest.profileId !== expectedProfileId) {
    throw definitionError("DEFINITION_MANIFEST_INVALID", "Agent Definition profileId 不匹配");
  }
  if (!exactKeys(manifest.documents, DOCUMENT_KINDS)) {
    throw definitionError("DEFINITION_MANIFEST_INVALID", "Agent Definition document refs 不完整");
  }
  for (const kind of DOCUMENT_KINDS) {
    const ref = manifest.documents[kind];
    const expectedPath = manifest.schemaVersion === 1 ? `definition/revisions/${manifest.revision}/${kind}.md`
      : manifest.storage === "backup" ? `definition/backups/${manifest.revision}/${kind}.md`
        : kind === "USER" ? "definition/USER.md" : `${kind}.md`;
    if (!exactKeys(ref, ["kind", "path", "contentHash", "byteLength", "revision"])
      || ref.kind !== kind || ref.path !== expectedPath
      || !HASH_PATTERN.test(ref.contentHash)
      || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0
      || ref.revision !== manifest.revision) {
      throw definitionError("DEFINITION_MANIFEST_INVALID", `${kind} document ref 无效`);
    }
  }
  if (manifestChecksum(manifest) !== manifest.checksum) {
    throw definitionError("DEFINITION_MANIFEST_INVALID", "Agent Definition manifest checksum 不匹配");
  }
  return manifest;
}

function fsyncDirectory(target, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  const directoryOnly = fileSystem.constants.O_DIRECTORY || 0;
  const fd = fileSystem.openSync(target, fileSystem.constants.O_RDONLY | noFollow | directoryOnly);
  try { fileSystem.fsyncSync(fd); } finally { fileSystem.closeSync(fd); }
}

function removeReservedTree(target, fileSystem = fs) {
  const stat = fileSystem.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fileSystem.unlinkSync(target);
    return;
  }
  if (!stat.isDirectory()) {
    fileSystem.unlinkSync(target);
    return;
  }
  for (const name of fileSystem.readdirSync(target)) {
    removeReservedTree(path.join(target, name), fileSystem);
  }
  fileSystem.rmdirSync(target);
}

class AgentDefinitionStore {
  constructor(options) {
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.maxExportBytes = options.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
    this.faultInjector = options.faultInjector || null;
    this.opened = false;
  }

  _checkpoint(name) {
    if (typeof this.faultInjector === "function") this.faultInjector(name);
  }

  _assertOpen() {
    if (!this.opened) throw definitionError("DEFINITION_STORE_CLOSED", "Agent Definition Store 未打开");
  }

  _profileDir(profileId) {
    return path.join(this.paths.agentsDir, assertProfileId(profileId));
  }

  _rootManifestPath(profileId) {
    return path.join(this._profileDir(profileId), "manifest.json");
  }

  _revisionDir(profileId, revision) {
    return path.join(this._profileDir(profileId), "definition", "backups", String(revision));
  }

  _generatedDir(profileId) {
    return path.join(this._profileDir(profileId), "generated");
  }

  documentDirectory(profileId, kind, revision) {
    if (GENERATED_VIEW_KINDS.includes(kind)) return this._generatedDir(profileId);
    const current = this.get(profileId);
    return current?.manifest.revision === revision
      ? path.dirname(path.join(this._profileDir(profileId), current.manifest.documents[kind].path))
      : this._revisionDir(profileId, revision);
  }

  _ensureProfileDirectories(profileId) {
    const profileDir = this._profileDir(profileId);
    ensurePrivateDirectoryTree(profileDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(path.join(profileDir, "definition", "backups"), this.paths.trustedRoot);
    ensurePrivateDirectoryTree(this._generatedDir(profileId), this.paths.trustedRoot);
    ensurePrivateDirectoryTree(path.join(profileDir, "proposals"), this.paths.trustedRoot);
    return profileDir;
  }

  open() {
    if (this.opened) return;
    ensurePrivateDirectoryTree(this.paths.agentsDir, this.paths.trustedRoot);
    for (const profileId of this.fs.readdirSync(this.paths.agentsDir)) {
      if (!PROFILE_ID_PATTERN.test(profileId)) continue;
      const definitionRoot = path.join(this.paths.agentsDir, profileId, "definition");
      const stat = lstatIfExists(definitionRoot);
      if (!stat?.isDirectory()) continue;
      for (const name of this.fs.readdirSync(definitionRoot)) {
        if (!name.startsWith(".staging-")) continue;
        removeReservedTree(path.join(definitionRoot, name), this.fs);
      }
      this._recover(profileId);
      if (lstatIfExists(this._rootManifestPath(profileId))) this._loadState(profileId);
    }
    this.opened = true;
  }

  close() {
    this.opened = false;
  }

  ensureProfile(input) {
    this._assertOpen();
    const profileId = assertProfileId(input?.profileId);
    const defaults = createDefaultDocuments(input.profileName);
    const defaultIdentity = defaults.IDENTITY;
    if (input.initialIdentity !== undefined) {
      if (typeof input.initialIdentity !== "string" || !input.initialIdentity.trim()
        || !input.initialIdentity.isWellFormed() || input.initialIdentity.includes("\0")
        || Buffer.byteLength(input.initialIdentity, "utf8") > 8192) {
        throw definitionError("DEFINITION_DOCUMENT_INVALID", "Initial Agent identity is invalid");
      }
      defaults.IDENTITY += `\n## User-provided identity and responsibilities\n\n${input.initialIdentity}\n`;
    }
    const existing = lstatIfExists(this._rootManifestPath(profileId));
    if (existing) {
      const current = this.get(profileId);
      if (input.initialIdentity !== undefined) {
        const legacyIdentity = createLegacyV4Identity(input.profileName);
        if (current.documents.IDENTITY === defaults.IDENTITY
          || current.documents.IDENTITY === legacyIdentity + LEGACY_INITIAL_IDENTITY_HEADING + input.initialIdentity + "\n") return current;
        // Startup may bootstrap the default after a crash between Profile
        // creation and definition initialization. Complete only an untouched
        // default; never overwrite a user's intervening identity edit/restore.
        const untouchedDefault = [defaultIdentity, legacyIdentity].find(value => value === current.documents.IDENTITY);
        if (!untouchedDefault || !this._wasUntouched(profileId, "IDENTITY", sha256(untouchedDefault))) {
          throw definitionError("DEFINITION_REVISION_CONFLICT", "Initial Agent identity conflicts with saved changes");
        }
        return this._commit({ profileId, expectedRevision: current.manifest.revision,
          documents: { IDENTITY: defaults.IDENTITY }, actor: "bootstrap", reason: "agent-create-identity" });
      }
      if (profileId === DEEPSEEK_BUILTIN_PROFILE.id && input.profileName === DEEPSEEK_BUILTIN_PROFILE.name) {
        const previousNameLine = `- Name: ${PREVIOUS_DEEPSEEK_NAME}`;
        const nameLines = current.documents.IDENTITY.split("\n").filter((line) => line.startsWith("- Name: "));
        const identityHash = sha256(current.documents.IDENTITY);
        if (nameLines.length === 1 && nameLines[0] === previousNameLine
          && this._wasUntouched(profileId, "IDENTITY", identityHash)) {
          return this._commit({ profileId, expectedRevision: current.manifest.revision,
            documents: { IDENTITY: current.documents.IDENTITY.replace(/^- Name: DeepSeek Harness$/mu,
              `- Name: ${DEEPSEEK_BUILTIN_PROFILE.name}`) },
            actor: "bootstrap", reason: "builtin-deepseek-name" });
        }
      }
      if (current.documents.AGENTS === V3_DEFAULT_AGENTS) {
        const defaultHash = sha256(V3_DEFAULT_AGENTS);
        // A matching current body alone is insufficient: the user may have
        // edited and later restored the old default intentionally.
        const untouched = this._wasUntouched(profileId, "AGENTS", defaultHash);
        if (untouched) {
          return this._commit({ profileId, expectedRevision: current.manifest.revision,
            documents: { AGENTS: defaults.AGENTS }, actor: "bootstrap",
            reason: `default-template:v${DEFAULT_TEMPLATE_VERSION}` });
        }
      }
      return current;
    }
    return this._commit({
      profileId,
      expectedRevision: 0,
      documents: defaults,
      actor: "bootstrap",
      reason: `default-profile:v${DEFAULT_TEMPLATE_VERSION}`,
      createdAt: this.now(),
    });
  }

  _readJson(target, maxBytes = this.maxExportBytes) {
    let value;
    try { value = JSON.parse(readPrivateFile(target, { fs: this.fs, maxBytes }).toString("utf8")); } catch (error) {
      if (error?.code) throw error;
      throw definitionError("DEFINITION_MANIFEST_INVALID", "Agent Definition JSON 无效");
    }
    return value;
  }

  _readManifestAt(target, profileId) {
    return validateManifest(this._readJson(target), profileId);
  }

  _readDocuments(manifest) {
    const profileDir = this._profileDir(manifest.profileId);
    const documents = {};
    for (const kind of DOCUMENT_KINDS) {
      const ref = manifest.documents[kind];
      const target = path.resolve(profileDir, ref.path);
      if (path.relative(profileDir, target).startsWith("..")) {
        throw definitionError("DEFINITION_MANIFEST_INVALID", "Definition document path 逃逸");
      }
      const content = readPrivateFile(target, {
        fs: this.fs,
        maxBytes: this.maxDocumentBytes,
      }).toString("utf8");
      const bytes = assertContent(content, kind, this.maxDocumentBytes);
      if (bytes !== ref.byteLength || sha256(content) !== ref.contentHash) {
        throw definitionError("DEFINITION_DOCUMENT_CORRUPT", `${kind}.md 与 manifest 不一致`);
      }
      documents[kind] = content;
    }
    return documents;
  }

  _readCurrent(profileId) {
    const state = this._loadState(profileId);
    const files = this._captureFiles(state.current.manifest);
    const documents = Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, files[kind].content]));
    if (this._sameDocuments(documents, state.current.documents)) return state.current;
    // The fixed Markdown files are editable authority. Adopt an external edit
    // before checking an App draft's revision, preserving the old saved image.
    return this._save(profileId, state, documents, "user", "external-file-edit", files);
  }

  get(profileId) {
    this._assertOpen();
    assertProfileId(profileId);
    this._recover(profileId);
    if (!lstatIfExists(this._rootManifestPath(profileId))) return null;
    return clone(this._readCurrent(profileId));
  }

  history(profileId) {
    this._assertOpen();
    const current = this.get(profileId);
    if (!current) return [];
    const revisionsRoot = path.join(this._profileDir(profileId), "definition", "backups");
    return [current.manifest, ...this.fs.readdirSync(revisionsRoot)
      .filter((name) => /^[1-9][0-9]*$/u.test(name))
      .map((name) => this._readManifestAt(path.join(revisionsRoot, name, "manifest.json"), profileId))]
      .sort((a, b) => b.revision - a.revision)
      .map(clone);
  }

  readRevision(profileId, revision) {
    this._assertOpen();
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw definitionError("DEFINITION_REVISION_INVALID", "Definition revision 无效");
    }
    const current = this.get(profileId);
    if (current?.manifest.revision === revision) return current;
    const target = path.join(this._revisionDir(profileId, revision), "manifest.json");
    if (!lstatIfExists(target)) return null;
    const manifest = this._readManifestAt(target, profileId);
    return clone({ manifest, documents: this._readDocuments(manifest) });
  }

  readReceipt(profileId, revision) {
    this.get(profileId);
    return clone(this._loadState(profileId).provenance.receipts[revision] || null);
  }

  ruleProvenance(profileId) {
    this.get(profileId);
    return clone(this._loadState(profileId).provenance.lineBirth);
  }

  _wasUntouched(profileId, kind, hash) {
    const original = this._loadState(profileId).provenance.templates[kind];
    return original?.unchanged === true && original.hash === hash;
  }

  _sameDocuments(left, right) {
    return DOCUMENT_KINDS.every(kind => left[kind] === right[kind]);
  }

  _write(target, value) {
    atomicWritePrivateFile(target, value, { fs: this.fs, trustedRoot: this.paths.trustedRoot });
  }

  _seal(state) {
    state.checksum = manifestChecksum(state);
    if (Buffer.byteLength(stableJson(state)) > MAX_STATE_BYTES
      || Object.keys(state.provenance.receipts).length > 50_000) {
      throw definitionError("DEFINITION_RECEIPTS_FULL", "设定来源凭据已满，原文件保持不变");
    }
    return state;
  }

  _validateState(state, profileId) {
    if (!exactKeys(state, ["schemaVersion", "current", "provenance", "legacyRevision", "checksum"])
      || state.schemaVersion !== 2 || state.checksum !== manifestChecksum(state)
      || !Number.isSafeInteger(state.legacyRevision) || state.legacyRevision < 0
      || !exactKeys(state.current, ["manifest", "documents"])) {
      throw definitionError("DEFINITION_MANIFEST_INVALID", "设定保存状态无效");
    }
    const { manifest, documents } = state.current;
    validateManifest(manifest, profileId);
    validateDocuments(documents, this.maxDocumentBytes);
    if (manifest.schemaVersion !== 2 || manifest.storage !== "workspace"
      || DOCUMENT_KINDS.some(kind => sha256(documents[kind]) !== manifest.documents[kind].contentHash
        || Buffer.byteLength(documents[kind]) !== manifest.documents[kind].byteLength)) {
      throw definitionError("DEFINITION_DOCUMENT_CORRUPT", "设定保存映像与 manifest 不一致");
    }
    const p = state.provenance;
    if (!exactKeys(p, ["templates", "lineBirth", "receipts"]) || !exactKeys(p.templates, DOCUMENT_KINDS)
      || !p.lineBirth || !p.receipts || Array.isArray(p.lineBirth) || Array.isArray(p.receipts)
      || Object.keys(p.receipts).length > 50_000
      || Object.values(p.templates).some(value => !HASH_PATTERN.test(value?.hash) || typeof value?.unchanged !== "boolean")
      || Object.entries(p.lineBirth).some(([hash, revision]) => !HASH_PATTERN.test(hash)
        || !Number.isSafeInteger(revision) || revision < 1 || revision > manifest.revision)) {
      throw definitionError("DEFINITION_MANIFEST_INVALID", "设定来源凭据无效");
    }
    for (const [revision, receipt] of Object.entries(p.receipts)) {
      validateManifest(receipt?.manifest, profileId);
      if (String(receipt.manifest.revision) !== revision || Number(revision) > manifest.revision
        || !Array.isArray(receipt.rules) || receipt.rules.some(rule => !HASH_PATTERN.test(rule?.hash)
          || !Array.isArray(rule.priorCoverage) || rule.priorCoverage.some(span => !Array.isArray(span) || span.length !== 2
            || !span.every(Number.isSafeInteger) || span[0] < 0 || span[1] <= span[0] || span[1] > this.maxDocumentBytes))) {
        throw definitionError("DEFINITION_MANIFEST_INVALID", "设定操作凭据无效");
      }
    }
    state.current.documents = Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, documents[kind]]));
    return state;
  }

  _relocate(snapshot, storage) {
    const manifest = { ...snapshot.manifest, schemaVersion: 2, storage,
      documents: Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, {
        ...snapshot.manifest.documents[kind],
        path: storage === "backup" ? `definition/backups/${snapshot.manifest.revision}/${kind}.md`
          : kind === "USER" ? "definition/USER.md" : `${kind}.md`,
      }])) };
    manifest.checksum = manifestChecksum(manifest);
    return { manifest, documents: snapshot.documents };
  }

  _loadState(profileId) {
    this._recover(profileId);
    this._ensureProfileDirectories(profileId);
    const root = this._readJson(this._rootManifestPath(profileId), MAX_STATE_BYTES);
    const state = root.schemaVersion === 1 ? this._migrate(profileId, root) : this._validateState(root, profileId);
    this._prune(profileId, state);
    return state;
  }

  _captureFiles(manifest, allowMissing = false) {
    const files = {};
    for (const kind of DOCUMENT_KINDS) {
      const target = path.join(this._profileDir(manifest.profileId), manifest.documents[kind].path);
      let stat;
      try { stat = this.fs.lstatSync(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!allowMissing) throw definitionError("DEFINITION_DOCUMENT_MISSING", `${kind}.md 已移走，请恢复文件或使用备份恢复`);
        files[kind] = { content: null, identity: null }; continue;
      }
      // Editors may replace a 0600 file with a normal 0644 file. The Agent
      // directory remains private; tighten only this owned, unaliased inode.
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw definitionError("UNSAFE_PATH", `${kind}.md 必须是当前用户的普通文件`);
      }
      if ((stat.mode & 0o077) !== 0) {
        const fd = this.fs.openSync(target, this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = this.fs.fstatSync(fd);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) {
            throw definitionError("DEFINITION_REVISION_CONFLICT", `${kind}.md 已变化`);
          }
          this.fs.fchmodSync(fd, 0o600);
        } finally { this.fs.closeSync(fd); }
      }
      const raw = readPrivateFile(target, { fs: this.fs, maxBytes: this.maxDocumentBytes });
      let content;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
      catch { throw definitionError("DEFINITION_DOCUMENT_INVALID", `${kind}.md 必须是有效 UTF-8 文本`); }
      assertContent(content, kind, this.maxDocumentBytes);
      const after = this.fs.lstatSync(target);
      if (["dev", "ino", "size", "mtimeMs"].some(key => after[key] !== stat[key])) {
        throw definitionError("DEFINITION_REVISION_CONFLICT", `${kind}.md 读取期间已变化`);
      }
      files[kind] = { content, identity: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs } };
    }
    return files;
  }

  _backup(snapshot) {
    const saved = this._relocate(snapshot, "backup"), { profileId, revision } = saved.manifest;
    const target = this._revisionDir(profileId, revision);
    if (lstatIfExists(target)) {
      const existing = this._readManifestAt(path.join(target, "manifest.json"), profileId);
      if (existing.checksum !== saved.manifest.checksum || !this._sameDocuments(this._readDocuments(existing), saved.documents)) {
        throw definitionError("DEFINITION_DOCUMENT_CORRUPT", "已有设定备份不匹配");
      }
      return;
    }
    const staging = path.join(this._profileDir(profileId), "definition", `.staging-${this.randomUUID()}`);
    ensurePrivateDirectoryTree(staging, this.paths.trustedRoot);
    try {
      for (const kind of DOCUMENT_KINDS) this._write(path.join(staging, `${kind}.md`), saved.documents[kind]);
      this._write(path.join(staging, "manifest.json"), `${stableJson(saved.manifest)}\n`);
      fsyncDirectory(staging, this.fs);
      this.fs.renameSync(staging, target);
      fsyncDirectory(path.dirname(target), this.fs);
    } finally { if (lstatIfExists(staging)) removeReservedTree(staging, this.fs); }
  }

  _prune(profileId, state) {
    const root = path.join(this._profileDir(profileId), "definition", "backups");
    const revisions = this.fs.readdirSync(root).filter(name => /^[1-9][0-9]*$/u.test(name)).map(Number).sort((a, b) => b - a);
    const retained = revisions.filter(revision => revision < state.current.manifest.revision).slice(0, MAX_BACKUPS);
    for (const revision of revisions) {
      if (retained.includes(revision)) continue;
      removeReservedTree(this._revisionDir(profileId, revision), this.fs);
    }
    const legacy = path.join(this._profileDir(profileId), "definition", "revisions");
    if (state.legacyRevision && lstatIfExists(legacy)) {
      // This namespace belonged exclusively to the old store. Never remove an
      // unexpected user entry while retiring it.
      this._legacyRevisionNames(legacy);
      removeReservedTree(legacy, this.fs);
      fsyncDirectory(path.dirname(legacy), this.fs);
    }
  }

  _legacyRevisionNames(root) {
    ensurePrivateDirectoryTree(root, this.paths.trustedRoot);
    const names = this.fs.readdirSync(root);
    if (names.some(name => name !== ".DS_Store" && !/^[1-9][0-9]*$/u.test(name))) {
      throw definitionError("DEFINITION_MIGRATION_CONFLICT", "旧版本目录中有额外文件，原文件均保留");
    }
    const revisions = names.filter(name => /^[1-9][0-9]*$/u.test(name));
    for (const revision of revisions) {
      const directory = path.join(root, revision);
      ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
      if (this.fs.readdirSync(directory).some(name => !["manifest.json", ".DS_Store", ...DOCUMENT_KINDS.map(kind => `${kind}.md`)].includes(name))) {
        throw definitionError("DEFINITION_MIGRATION_CONFLICT", "旧版本包含额外文件，原文件均保留");
      }
    }
    return revisions;
  }

  _pendingPath(profileId) { return path.join(this._profileDir(profileId), "definition", "pending.json"); }

  _publish(profileId, before, after, files) {
    const journal = { schemaVersion: 1, before, after,
      files: Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, files[kind].content])) };
    journal.checksum = manifestChecksum(journal);
    this._write(this._pendingPath(profileId), `${stableJson(journal)}\n`);
    this._checkpoint("revision-ready");
    for (const kind of DOCUMENT_KINDS) {
      if (files[kind].content !== after.current.documents[kind]) {
        const target = path.join(this._profileDir(profileId), after.current.manifest.documents[kind].path);
        if (files[kind].identity === null && lstatIfExists(target)) {
          throw definitionError("DEFINITION_REVISION_CONFLICT", `${kind}.md 保存前已出现`);
        }
        atomicWritePrivateFile(target, after.current.documents[kind], {
          fs: this.fs, trustedRoot: this.paths.trustedRoot, expectedIdentity: files[kind].identity,
        });
      }
      this._checkpoint(`document-written:${kind}`);
    }
    this._checkpoint("revision-installed");
    // Commit only after the entire new set is durable. This single saved image
    // is also the baseline needed to back up edits made by an external editor.
    this._write(this._rootManifestPath(profileId), `${stableJson(after)}\n`);
    this._checkpoint("manifest-committed");
    this.fs.unlinkSync(this._pendingPath(profileId));
    fsyncDirectory(path.dirname(this._pendingPath(profileId)), this.fs);
    this._prune(profileId, after);
  }

  _recover(profileId) {
    const target = this._pendingPath(profileId);
    if (!lstatIfExists(target)) return;
    const journal = this._readJson(target, MAX_STATE_BYTES * 3);
    if (!exactKeys(journal, ["schemaVersion", "before", "after", "files", "checksum"])
      || journal.schemaVersion !== 1 || journal.checksum !== manifestChecksum(journal)
      || !exactKeys(journal.files, DOCUMENT_KINDS)) {
      throw definitionError("DEFINITION_MANIFEST_INVALID", "设定恢复记录无效");
    }
    this._validateState(journal.after, profileId);
    if (journal.before?.schemaVersion === 1) validateManifest(journal.before, profileId);
    else if (journal.before) this._validateState(journal.before, profileId);
    for (const kind of DOCUMENT_KINDS) if (journal.files[kind] !== null) assertContent(journal.files[kind], kind, this.maxDocumentBytes);
    const root = lstatIfExists(this._rootManifestPath(profileId))
      ? this._readJson(this._rootManifestPath(profileId), MAX_STATE_BYTES) : null;
    const committed = root?.checksum === journal.after.checksum;
    if (!committed && (root?.checksum ?? null) !== (journal.before?.checksum ?? null)) {
      throw definitionError("DEFINITION_RECOVERY_CONFLICT", "设定恢复时当前版本已变化，文件均保留");
    }
    if (!committed) {
      const files = this._captureFiles(journal.after.current.manifest, true);
      for (const kind of DOCUMENT_KINDS) {
        if (files[kind].content !== journal.files[kind] && files[kind].content !== journal.after.current.documents[kind]) {
          throw definitionError("DEFINITION_RECOVERY_CONFLICT", `${kind}.md 在中断后有其他修改，文件均保留`);
        }
      }
      for (const kind of DOCUMENT_KINDS) {
        if (files[kind].content === journal.files[kind]) continue;
        const file = path.join(this._profileDir(profileId), journal.after.current.manifest.documents[kind].path);
        if (journal.files[kind] === null) { this.fs.unlinkSync(file); fsyncDirectory(path.dirname(file), this.fs); }
        else this._write(file, journal.files[kind]);
      }
    }
    this.fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target), this.fs);
  }

  _migrate(profileId, legacyManifest) {
    validateManifest(legacyManifest, profileId);
    const current = { manifest: legacyManifest, documents: this._readDocuments(legacyManifest) };
    const root = path.join(this._profileDir(profileId), "definition", "revisions");
    const revisions = this._legacyRevisionNames(root)
      .map(Number).filter(revision => revision <= legacyManifest.revision).sort((a, b) => a - b);
    let previous = null, provenance = null;
    const backups = [];
    for (const revision of revisions) {
      if (revision !== (previous?.manifest.revision || 0) + 1) {
        throw definitionError("DEFINITION_MIGRATION_CONFLICT", "旧设定历史不完整，原文件均保留");
      }
      const manifest = this._readManifestAt(path.join(root, String(revision), "manifest.json"), profileId);
      const snapshot = this._relocate({ manifest, documents: this._readDocuments(manifest) }, "workspace");
      provenance = advanceProvenance(provenance, previous, snapshot);
      previous = snapshot;
      if (revision < current.manifest.revision) { backups.push(snapshot); if (backups.length > MAX_BACKUPS) backups.shift(); }
    }
    const active = this._relocate(current, "workspace");
    if (!previous || previous.manifest.checksum !== active.manifest.checksum) {
      throw definitionError("DEFINITION_MIGRATION_CONFLICT", "旧设定当前版本不匹配，原文件均保留");
    }
    const files = this._captureFiles(active.manifest, true);
    if (DOCUMENT_KINDS.some(kind => files[kind].content !== null && files[kind].content !== active.documents[kind])) {
      throw definitionError("DEFINITION_MIGRATION_CONFLICT", "Agent 工作区已有不同的设定文件，双方内容均保留");
    }
    const state = this._seal({ schemaVersion: 2, current: active, provenance, legacyRevision: legacyManifest.revision });
    for (const snapshot of backups) this._backup(snapshot);
    this._checkpoint("migration-ready");
    this._publish(profileId, legacyManifest, state, files);
    return state;
  }

  update(input) {
    this._assertOpen();
    if (!["user", "import", "restore", "memory-engine"].includes(input?.actor)) {
      throw definitionError("DEFINITION_WRITE_FORBIDDEN", "Definition 只能由授权写入者提交");
    }
    const changes = validateDocuments(input.documents, this.maxDocumentBytes, { partial: true });
    if (input.actor === "memory-engine" && Object.keys(changes).some((kind) => kind !== "USER")) {
      throw definitionError("DEFINITION_WRITE_FORBIDDEN", "Memory Engine 只能更新 USER.md");
    }
    return this._commit({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      documents: changes,
      actor: input.actor,
      reason: input.reason ?? null,
    });
  }

  restore(input) {
    const prior = this.readRevision(input.profileId, input.revision);
    if (!prior) throw definitionError("DEFINITION_REVISION_NOT_FOUND", "Definition revision 不存在");
    return this.update({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      documents: prior.documents,
      actor: "restore",
      reason: `restore:${input.revision}`,
    });
  }

  propose(input) {
    this._assertOpen();
    const profileId = assertProfileId(input?.profileId);
    if (input?.actor !== "agent") {
      throw definitionError("DEFINITION_PROPOSAL_FORBIDDEN", "只有 Agent 可提交 Definition proposal");
    }
    const current = this.get(profileId);
    if (!current) throw definitionError("DEFINITION_NOT_FOUND", "Agent Definition 不存在");
    const documents = validateDocuments(input.documents, this.maxDocumentBytes, { partial: true });
    const proposal = {
      schemaVersion: 1,
      id: this.randomUUID(),
      profileId,
      baseRevision: current.manifest.revision,
      documents,
      reason: typeof input.reason === "string" ? input.reason : null,
      createdAt: this.now(),
      status: "candidate",
    };
    const target = path.join(this._profileDir(profileId), "proposals", `${proposal.id}.json`);
    atomicWritePrivateFile(target, `${stableJson(proposal)}\n`, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    return clone(proposal);
  }

  _save(profileId, state, documents, actor, reason, files, createdAt) {
    const previous = state?.current || null;
    const revision = (previous?.manifest.revision || 0) + 1;
    const manifest = {
      schemaVersion: 2, storage: "workspace", profileId, revision,
      documents: Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, {
        kind, path: kind === "USER" ? "definition/USER.md" : `${kind}.md`,
        contentHash: sha256(documents[kind]), byteLength: Buffer.byteLength(documents[kind]), revision,
      }])), actor, reason: reason ?? null,
      createdAt: previous?.manifest.createdAt ?? createdAt ?? this.now(),
      updatedAt: Math.max(this.now(), previous?.manifest.updatedAt ?? 0),
    };
    manifest.updatedAt = Math.max(manifest.updatedAt, manifest.createdAt);
    manifest.checksum = manifestChecksum(manifest);
    const current = { manifest, documents };
    const next = this._seal({ schemaVersion: 2, current,
      provenance: advanceProvenance(state?.provenance, previous, current), legacyRevision: state?.legacyRevision || 0 });
    files ||= this._captureFiles(manifest, !previous);
    if (previous) this._backup(previous);
    this._publish(profileId, state, next, files);
    return clone(current);
  }

  _commit(input) {
    const profileId = assertProfileId(input.profileId);
    this._ensureProfileDirectories(profileId);
    const current = this.get(profileId);
    const currentRevision = current?.manifest.revision || 0;
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== currentRevision) {
      const error = definitionError("DEFINITION_REVISION_CONFLICT", "Agent Definition revision 已变化");
      error.currentRevision = currentRevision;
      throw error;
    }
    const documents = validateDocuments({ ...(current?.documents || {}), ...input.documents }, this.maxDocumentBytes);
    const state = current ? this._loadState(profileId) : null;
    if (current && this._sameDocuments(documents, current.documents)) {
      // An explicit import/restore still protects an intentionally retained
      // default from future template upgrades, without creating a fake backup.
      if (["import", "restore"].includes(input.actor)) {
        for (const value of Object.values(state.provenance.templates)) value.unchanged = false;
        this._write(this._rootManifestPath(profileId), `${stableJson(this._seal(state))}\n`);
      }
      return current;
    }
    const files = this._captureFiles(this._relocate({
      manifest: current?.manifest || { profileId, documents: Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, {}])) }, documents,
    }, "workspace").manifest, !current);
    if (!current && DOCUMENT_KINDS.some(kind => files[kind].content !== null && files[kind].content !== documents[kind])) {
      throw definitionError("DEFINITION_MIGRATION_CONFLICT", "Agent 工作区已有设定，拒绝用默认内容覆盖");
    }
    // Capture once more after composing the saved image. A concurrent editor
    // must not have its bytes silently replaced by an already-open App draft.
    if (current && !this._sameDocuments(Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, files[kind].content])), current.documents)) {
      throw definitionError("DEFINITION_REVISION_CONFLICT", "设定保存前已被外部编辑");
    }
    return this._save(profileId, state, documents, input.actor, input.reason, files, input.createdAt);
  }

  export(profileId) {
    const current = this.get(profileId);
    if (!current) throw definitionError("DEFINITION_NOT_FOUND", "Agent Definition 不存在");
    return {
      format: DEFINITION_EXPORT_FORMAT,
      schemaVersion: DEFINITION_SCHEMA_VERSION,
      profileId,
      revision: current.manifest.revision,
      documents: current.documents,
    };
  }

  previewImport(input) {
    this._assertOpen();
    const profileId = assertProfileId(input?.profileId);
    const bundle = input?.bundle;
    if (!exactKeys(bundle, ["format", "schemaVersion", "profileId", "revision", "documents"])
      || bundle.format !== DEFINITION_EXPORT_FORMAT
      || bundle.schemaVersion !== DEFINITION_SCHEMA_VERSION
      || !Number.isSafeInteger(bundle.revision) || bundle.revision < 1) {
      throw definitionError("DEFINITION_IMPORT_INVALID", "Agent Definition 导入包无效");
    }
    const bytes = Buffer.byteLength(stableJson(bundle), "utf8");
    if (bytes > this.maxExportBytes) {
      throw definitionError("DEFINITION_IMPORT_TOO_LARGE", "Agent Definition 导入包超过上限");
    }
    const documents = validateDocuments(bundle.documents, this.maxDocumentBytes);
    const current = this.get(profileId);
    if (!current) throw definitionError("DEFINITION_NOT_FOUND", "Agent Definition 不存在");
    return {
      sourceProfileId: bundle.profileId,
      baseRevision: current.manifest.revision,
      changes: DOCUMENT_KINDS.map((kind) => ({
        kind,
        changed: current.documents[kind] !== documents[kind],
        beforeHash: current.manifest.documents[kind].contentHash,
        afterHash: sha256(documents[kind]),
      })),
      documents,
    };
  }

  import(input) {
    const preview = this.previewImport(input);
    if (preview.baseRevision !== input.expectedRevision) {
      const error = definitionError("DEFINITION_REVISION_CONFLICT", "Agent Definition revision 已变化");
      error.currentRevision = preview.baseRevision;
      throw error;
    }
    return this.update({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      documents: preview.documents,
      actor: "import",
      reason: "definition-import",
    });
  }

  writeGeneratedView(input) {
    this._assertOpen();
    const profileId = assertProfileId(input?.profileId);
    if (!GENERATED_VIEW_KINDS.includes(input?.kind)) {
      throw definitionError("GENERATED_VIEW_KIND_INVALID", "Generated view kind 无效");
    }
    if ((!Number.isSafeInteger(input.revision) || input.revision < 0)
      && !(typeof input.revision === "string" && /^[a-f0-9]{64}$/u.test(input.revision))) {
      throw definitionError("GENERATED_VIEW_REVISION_INVALID", "Generated view revision 无效");
    }
    const byteLength = assertContent(input.content, input.kind, this.maxDocumentBytes);
    if (!this.get(profileId)) throw definitionError("DEFINITION_NOT_FOUND", "Agent Definition 不存在");
    const generatedDir = this._generatedDir(profileId);
    const contentHash = sha256(input.content);
    atomicWritePrivateFile(path.join(generatedDir, `${input.kind}.md`), input.content, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    atomicWritePrivateFile(path.join(generatedDir, `${input.kind}.json`), `${stableJson({
      schemaVersion: 1,
      kind: input.kind,
      revision: input.revision,
      contentHash,
      byteLength,
      generatedAt: this.now(),
    })}\n`, {
      fs: this.fs,
      trustedRoot: this.paths.trustedRoot,
    });
    return { kind: input.kind, revision: input.revision, contentHash, byteLength };
  }

  readGeneratedView(profileId, kind) {
    this._assertOpen();
    assertProfileId(profileId);
    if (!GENERATED_VIEW_KINDS.includes(kind)) {
      throw definitionError("GENERATED_VIEW_KIND_INVALID", "Generated view kind 无效");
    }
    const generatedDir = this._generatedDir(profileId);
    const metaPath = path.join(generatedDir, `${kind}.json`);
    const contentPath = path.join(generatedDir, `${kind}.md`);
    if (!lstatIfExists(metaPath) || !lstatIfExists(contentPath)) return null;
    const meta = this._readJson(metaPath, 4096);
    const content = readPrivateFile(contentPath, {
      fs: this.fs,
      maxBytes: this.maxDocumentBytes,
    }).toString("utf8");
    if (meta.kind !== kind || meta.contentHash !== sha256(content)
      || meta.byteLength !== Buffer.byteLength(content, "utf8")) {
      throw definitionError("GENERATED_VIEW_CORRUPT", "Generated view 与 metadata 不一致");
    }
    return clone({ ...meta, content });
  }
}

module.exports = {
  AgentDefinitionStore,
  DEFAULT_DOCUMENTS,
  DEFINITION_EXPORT_FORMAT,
  DEFINITION_SCHEMA_VERSION,
  DOCUMENT_KINDS,
  GENERATED_VIEW_KINDS,
  manifestChecksum,
  validateManifest,
};
