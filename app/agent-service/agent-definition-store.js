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
const { DEFAULT_DOCUMENTS, DEFAULT_TEMPLATE_VERSION,
  createDefaultDocuments } = require("./agent-definition-defaults");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");

const DEFINITION_SCHEMA_VERSION = 1;
const DEFINITION_EXPORT_FORMAT = "shoggoth-agent-definition-v1";
const DOCUMENT_KINDS = Object.freeze(["IDENTITY", "SOUL", "USER", "AGENTS"]);
const GENERATED_VIEW_KINDS = Object.freeze(["TOOLS", "MEMORY"]);
const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024;
const DEFAULT_MAX_EXPORT_BYTES = 256 * 1024;
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
  if (!exactKeys(manifest, fields) || manifest.schemaVersion !== DEFINITION_SCHEMA_VERSION
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
    if (!exactKeys(ref, ["kind", "path", "contentHash", "byteLength", "revision"])
      || ref.kind !== kind || ref.path !== `definition/revisions/${manifest.revision}/${kind}.md`
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
    return path.join(this._profileDir(profileId), "definition", "revisions", String(revision));
  }

  _ensureProfileDirectories(profileId) {
    const profileDir = this._profileDir(profileId);
    ensurePrivateDirectoryTree(profileDir, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(path.join(profileDir, "definition", "revisions"), this.paths.trustedRoot);
    ensurePrivateDirectoryTree(path.join(profileDir, "generated"), this.paths.trustedRoot);
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
      const rootManifest = lstatIfExists(this._rootManifestPath(profileId));
      const current = rootManifest ? this._readCurrent(profileId) : null;
      const revisionsRoot = path.join(definitionRoot, "revisions");
      const revisionsStat = lstatIfExists(revisionsRoot);
      if (revisionsStat?.isDirectory()) {
        const committedRevision = current?.manifest.revision || 0;
        for (const name of this.fs.readdirSync(revisionsRoot)) {
          if (!/^[1-9][0-9]*$/u.test(name) || Number(name) <= committedRevision) continue;
          removeReservedTree(path.join(revisionsRoot, name), this.fs);
        }
      }
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
      defaults.IDENTITY += `\n## 用户指定的身份与职责\n\n${input.initialIdentity}\n`;
    }
    const existing = lstatIfExists(this._rootManifestPath(profileId));
    if (existing) {
      const current = this.get(profileId);
      if (input.initialIdentity !== undefined) {
        if (current.documents.IDENTITY === defaults.IDENTITY) return current;
        // Startup may bootstrap the default after a crash between Profile
        // creation and definition initialization. Complete only an untouched
        // default; never overwrite a user's intervening identity edit/restore.
        if (current.documents.IDENTITY !== defaultIdentity || this.history(profileId).some(revision =>
          revision.documents.IDENTITY.contentHash !== sha256(defaultIdentity)
          || ["import", "restore"].includes(revision.actor))) {
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
          && this.history(profileId).every((revision) => (
            revision.documents.IDENTITY.contentHash === identityHash
            && !["import", "restore"].includes(revision.actor)
          ))) {
          return this._commit({ profileId, expectedRevision: current.manifest.revision,
            documents: { IDENTITY: current.documents.IDENTITY.replace(/^- Name: DeepSeek Harness$/mu,
              `- Name: ${DEEPSEEK_BUILTIN_PROFILE.name}`) },
            actor: "bootstrap", reason: "builtin-deepseek-name" });
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
    const manifest = this._readManifestAt(this._rootManifestPath(profileId), profileId);
    return { manifest, documents: this._readDocuments(manifest) };
  }

  get(profileId) {
    this._assertOpen();
    assertProfileId(profileId);
    if (!lstatIfExists(this._rootManifestPath(profileId))) return null;
    return clone(this._readCurrent(profileId));
  }

  history(profileId) {
    this._assertOpen();
    const current = this.get(profileId);
    if (!current) return [];
    const revisionsRoot = path.join(this._profileDir(profileId), "definition", "revisions");
    return this.fs.readdirSync(revisionsRoot)
      .filter((name) => /^[1-9][0-9]*$/u.test(name))
      .map((name) => this._readManifestAt(path.join(revisionsRoot, name, "manifest.json"), profileId))
      .sort((a, b) => b.revision - a.revision)
      .map(clone);
  }

  readRevision(profileId, revision) {
    this._assertOpen();
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw definitionError("DEFINITION_REVISION_INVALID", "Definition revision 无效");
    }
    const target = path.join(this._revisionDir(profileId, revision), "manifest.json");
    if (!lstatIfExists(target)) return null;
    const manifest = this._readManifestAt(target, profileId);
    return clone({ manifest, documents: this._readDocuments(manifest) });
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

  _commit(input) {
    const profileId = assertProfileId(input.profileId);
    const profileDir = this._ensureProfileDirectories(profileId);
    const current = lstatIfExists(this._rootManifestPath(profileId))
      ? this._readCurrent(profileId) : null;
    const currentRevision = current?.manifest.revision || 0;
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== currentRevision) {
      const error = definitionError("DEFINITION_REVISION_CONFLICT", "Agent Definition revision 已变化");
      error.currentRevision = currentRevision;
      throw error;
    }
    const documents = validateDocuments({
      ...(current?.documents || {}),
      ...input.documents,
    }, this.maxDocumentBytes);
    const revision = currentRevision + 1;
    const createdAt = current?.manifest.createdAt ?? input.createdAt ?? this.now();
    const updatedAt = Math.max(this.now(), current?.manifest.updatedAt ?? 0);
    const definitionRoot = path.join(profileDir, "definition");
    const staging = path.join(definitionRoot, `.staging-${this.randomUUID()}`);
    ensurePrivateDirectoryTree(staging, this.paths.trustedRoot);
    const refs = {};
    try {
      for (const kind of DOCUMENT_KINDS) {
        const content = documents[kind];
        const byteLength = Buffer.byteLength(content, "utf8");
        atomicWritePrivateFile(path.join(staging, `${kind}.md`), content, {
          fs: this.fs,
          trustedRoot: this.paths.trustedRoot,
        });
        refs[kind] = {
          kind,
          path: `definition/revisions/${revision}/${kind}.md`,
          contentHash: sha256(content),
          byteLength,
          revision,
        };
      }
      const manifest = {
        schemaVersion: DEFINITION_SCHEMA_VERSION,
        profileId,
        revision,
        documents: refs,
        actor: input.actor,
        reason: input.reason ?? null,
        createdAt,
        updatedAt,
      };
      manifest.checksum = manifestChecksum(manifest);
      atomicWritePrivateFile(path.join(staging, "manifest.json"), `${stableJson(manifest)}\n`, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      fsyncDirectory(staging, this.fs);
      this._checkpoint("revision-ready");
      const revisionDir = this._revisionDir(profileId, revision);
      if (lstatIfExists(revisionDir)) {
        throw definitionError("DEFINITION_REVISION_EXISTS", "Definition revision 目录已存在");
      }
      this.fs.renameSync(staging, revisionDir);
      fsyncDirectory(path.dirname(revisionDir), this.fs);
      this._checkpoint("revision-installed");
      atomicWritePrivateFile(this._rootManifestPath(profileId), `${stableJson(manifest)}\n`, {
        fs: this.fs,
        trustedRoot: this.paths.trustedRoot,
      });
      this._checkpoint("manifest-committed");
      return clone({ manifest, documents });
    } catch (error) {
      if (lstatIfExists(staging)) removeReservedTree(staging, this.fs);
      throw error;
    }
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
    const generatedDir = path.join(this._profileDir(profileId), "generated");
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
    const generatedDir = path.join(this._profileDir(profileId), "generated");
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
