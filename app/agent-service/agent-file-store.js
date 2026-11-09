"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, lstatIfExists } = require("./security");
const { fsyncPrivateParent, readPrivateFile, recoverInterruptedPrivateFile, writeFully } = require("./private-file");
const { isAgentHomeWorkspace } = require("./chat-workspace");
const fileProtocol = require("./agent-file-protocol");

const { FILE_ID, PROFILE_ID, UPLOAD_ID, MAX_FILE_BYTES, fail, filename, validateFile } = fileProtocol;
const RECORD = ".shoggoth-file.json";
const STAGING = /^\.stage-[a-f0-9]{64}-[A-Za-z0-9]{6}$/u;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_FILES = 2048;
const MAX_WRITES = 4;
const IMPORT_SOURCE = Object.freeze({ kind: "import", runId: null, sourceId: null, sessionKey: null });
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const owns = (stat) => typeof process.getuid !== "function" || stat.uid === process.getuid();
const regular = (stat) => !!stat?.isFile() && stat.nlink === 1 && owns(stat);
const privateRegular = (stat) => regular(stat) && (stat.mode & 0o077) === 0;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function filesRoot(paths, profileId) {
  if (typeof profileId !== "string" || !PROFILE_ID.test(profileId)) fail("AGENT_FILE_INVALID");
  return path.join(paths.agentsDir, profileId, "files");
}

function payloadPath(paths, profileId, fileId, name) {
  if (typeof fileId !== "string" || !FILE_ID.test(fileId)) fail("AGENT_FILE_INVALID");
  return path.join(filesRoot(paths, profileId), fileId, filename(name));
}

function importPath(paths, uploadId) {
  if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) fail("AGENT_FILE_INVALID");
  return path.join(paths.cacheDir, "agent-file-imports", uploadId);
}

function fileIdFor(profileId, operationId) {
  return sha256(JSON.stringify(["agent-file-v1", profileId, operationId]));
}

function fileIdFromStorageKey(key) {
  if (typeof key !== "string" || !key.startsWith("agent-files/")) return null;
  const fileId = key.slice("agent-files/".length);
  return FILE_ID.test(fileId) ? fileId : null;
}

async function readBoundedFile(target, { privateFile = false } = {}) {
  const valid = privateFile ? privateRegular : regular;
  let handle;
  try {
    const before = await fs.promises.lstat(target);
    if (!valid(before) || await fs.promises.realpath(target) !== target) fail("AGENT_FILE_INVALID");
    if (before.size > MAX_FILE_BYTES) fail("AGENT_FILE_TOO_LARGE");
    handle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!valid(opened) || !sameFile(before, opened)) fail("AGENT_FILE_SOURCE_CHANGED");
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail("AGENT_FILE_SOURCE_CHANGED");
      offset += bytesRead;
    }
    const after = await handle.stat();
    const installed = await fs.promises.lstat(target);
    if (!valid(after) || !valid(installed) || !sameFile(opened, after) || !sameFile(opened, installed)) {
      fail("AGENT_FILE_SOURCE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error?.code === "ENOENT") fail("AGENT_FILE_MISSING", error);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readWorkspaceOutput(paths, { profileId, workspace, relativePath }) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || typeof relativePath !== "string"
    || relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    fail("AGENT_FILE_INVALID");
  }
  const root = await fs.promises.realpath(workspace);
  if (root !== path.resolve(workspace)) fail("AGENT_FILE_INVALID");
  const target = path.join(root, relativePath);
  const forbidden = [paths.cacheDir, paths.profileDir, paths.runtimeDir, path.join(paths.userDataRoot, "credentials"),
    path.join(paths.userDataRoot, "config.json"),
    ...[".codex", ".claude", ".pi", ".openclaw", ".hermes", ".config/opencode", "Library/Keychains"]
      .map(dir => path.join(paths.homeDir, dir))];
  if (forbidden.some(dir => inside(dir, target))
    || (inside(paths.stateDir, target) && !isAgentHomeWorkspace(paths, profileId, root))) fail("AGENT_FILE_INVALID");
  return readBoundedFile(target);
}

function checkDirectory(dir) {
  assertPrivateDirectory(dir);
  if (fs.realpathSync(dir) !== dir) fail("AGENT_FILE_INVALID");
}

class AgentFileStore {
  #profiles = new Map();
  #pending = new Map();
  #stages = new Set();
  #open = false;

  constructor({ paths, productStore, now = Date.now }) {
    this.paths = paths;
    this.productStore = productStore;
    this.now = now;
  }

  open() { this.#open = true; }

  async close() {
    this.#open = false;
    await Promise.allSettled([...this.#pending.values()].map(item => item.promise));
    this.#profiles.clear();
  }

  ensureProfile(profileId) {
    const root = filesRoot(this.paths, profileId);
    ensurePrivateDirectoryTree(root, this.paths.trustedRoot);
    return root;
  }

  forgetProfile(profileId) { this.#profiles.delete(profileId); }

  #assertActive(profileId) {
    if (!this.#open) fail("AGENT_FILE_UNAVAILABLE");
    if (this.productStore.getAgentProfile(profileId)?.enabled !== true) fail("AGENT_FILE_NOT_FOUND");
  }

  #directory(record) { return path.join(filesRoot(this.paths, record.file.profileId), record.file.fileId); }

  #write(directory, record) {
    checkDirectory(directory);
    const target = path.join(directory, RECORD);
    const prior = lstatIfExists(target);
    if (prior && !privateRegular(prior)) fail("AGENT_FILE_CONFLICT");
    const temp = `${target}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      writeFully(fs, fd, JSON.stringify(record) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // The published record is the recovery authority. An interrupted write
    // either leaves it intact or installs the complete new intent.
    fs.renameSync(temp, target);
    try { fsyncPrivateParent(directory); }
    catch (error) { fail("AGENT_FILE_COMMIT_UNCERTAIN", error); }
  }

  #read(directory, profileId, fileId) {
    checkDirectory(directory);
    const target = path.join(directory, RECORD);
    const recovery = recoverInterruptedPrivateFile(target, { trustedRoot: this.paths.trustedRoot });
    if (recovery === "uncertain") fail("AGENT_FILE_COMMIT_UNCERTAIN");
    const record = JSON.parse(readPrivateFile(target, { trustedRoot: this.paths.trustedRoot, maxBytes: MAX_RECORD_BYTES }));
    if (record.version !== 1 || !FILE_ID.test(record.intent) || record.file?.fileId !== fileId
      || (record.pendingName !== null && filename(record.pendingName) !== record.pendingName)) fail("AGENT_FILE_INVALID");
    validateFile(record.file, profileId);
    if (record.file.status === "missing" || (record.file.status === "deleted" && record.pendingName !== null)) fail("AGENT_FILE_INVALID");
    return record;
  }

  #payload(record, name = record.file.name) {
    return payloadPath(this.paths, record.file.profileId, record.file.fileId, name);
  }

  #finishRename(record) {
    const dir = this.#directory(record);
    checkDirectory(dir);
    const original = this.#payload(record);
    const destination = this.#payload(record, record.pendingName);
    const before = lstatIfExists(original);
    const after = lstatIfExists(destination);
    if (before) {
      if (!privateRegular(before) || before.size !== record.file.sizeBytes
        || fs.realpathSync(original) !== original
        || (after && (!privateRegular(after) || !sameInode(before, after)))) fail("AGENT_FILE_CONFLICT");
      fs.renameSync(original, destination);
      fsyncPrivateParent(dir);
    } else if (after) {
      if (!privateRegular(after) || sha256(readPrivateFile(destination, {
        trustedRoot: this.paths.trustedRoot, maxBytes: MAX_FILE_BYTES,
      })) !== record.file.sha256) fail("AGENT_FILE_CONFLICT");
    }
    const file = { ...record.file, name: record.pendingName, revision: record.file.revision + 1,
      updatedAt: Math.max(this.now(), record.file.updatedAt + 1) };
    const settled = { ...record, pendingName: null, file };
    this.#write(dir, settled);
    return settled;
  }

  #erase(record) {
    const target = this.#payload(record);
    const stat = lstatIfExists(target);
    if (!stat) return;
    if (!privateRegular(stat) || fs.realpathSync(target) !== target) fail("AGENT_FILE_CONFLICT");
    fs.unlinkSync(target);
    fsyncPrivateParent(path.dirname(target));
  }

  #entries(profileId) {
    this.#assertActive(profileId);
    const previous = this.#profiles.get(profileId);
    if (previous) return previous;
    const root = this.ensureProfile(profileId);
    const entries = new Map();
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (STAGING.test(name) && !this.#stages.has(dir)) {
        checkDirectory(dir);
        fs.rmSync(dir, { recursive: true });
      }
      if (!FILE_ID.test(name)) continue;
      let record = this.#read(dir, profileId, name);
      if (record.pendingName !== null) record = this.#finishRename(record);
      if (record.file.status === "deleted") this.#erase(record);
      entries.set(name, record);
    }
    this.#profiles.set(profileId, entries);
    return entries;
  }

  #view(record) {
    const { file } = record;
    if (file.status === "deleted") return { file, path: null };
    const target = this.#payload(record);
    const stat = lstatIfExists(target);
    if (privateRegular(stat) && stat.size === file.sizeBytes) {
      try {
        if (fs.realpathSync(target) === target) return { file, path: target };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return { file: { ...file, status: "missing" }, path: null };
  }

  list({ profileId, runId, sessionKey, cursor, limit, includeMissing }) {
    const records = [...this.#entries(profileId).values()]
      .filter(({ file }) => file.status !== "deleted" && (!runId || file.source.runId === runId)
        && (!sessionKey || file.source.sessionKey === sessionKey))
      .sort((left, right) => right.file.updatedAt - left.file.updatedAt || left.file.fileId.localeCompare(right.file.fileId));
    const items = [];
    let index = 0;
    for (const record of records) {
      const { file } = this.#view(record);
      if (!includeMissing && file.status !== "available") continue;
      if (index++ < cursor) continue;
      if (items.length === limit) return { items, nextCursor: cursor + limit };
      items.push(file);
    }
    return { items, nextCursor: null };
  }

  get({ profileId, fileId }) {
    const record = this.#entries(profileId).get(fileId);
    if (!record) fail("AGENT_FILE_NOT_FOUND");
    return this.#view(record);
  }

  import(input) {
    return this.save({ ...input, source: IMPORT_SOURCE,
      read: () => readBoundedFile(importPath(this.paths, input.uploadId), { privateFile: true }) });
  }

  save({ profileId, operationId, name, mimeType, source, sizeBytes, sha256: digest, read, assertCurrent = () => {} }) {
    assertCurrent();
    const id = fileIdFor(profileId, operationId);
    const now = this.now();
    const file = validateFile({ fileId: id, profileId, name: filename(name), mimeType, source, sizeBytes,
      sha256: digest, createdAt: now, updatedAt: now, revision: 1, status: "available" }, profileId);
    const intent = sha256(JSON.stringify([file.name, mimeType, source.kind, source.runId,
      source.sourceId, source.sessionKey, sizeBytes, digest]));
    const previous = this.#entries(profileId).get(id);
    if (previous) {
      if (previous.intent !== intent) fail("AGENT_FILE_CONFLICT");
      return Promise.resolve({ file: this.#view(previous).file });
    }
    const pending = this.#pending.get(id);
    if (pending) {
      if (pending.intent !== intent) fail("AGENT_FILE_CONFLICT");
      return pending.promise;
    }
    if (this.#pending.size >= MAX_WRITES) fail("AGENT_FILE_UNAVAILABLE");
    const record = { version: 1, intent, pendingName: null, file };
    const promise = this.#install(record, read, assertCurrent).finally(() => this.#pending.delete(id));
    this.#pending.set(id, { intent, promise });
    return promise;
  }

  async #install(record, read, assertCurrent) {
    const { file } = record;
    const { profileId, fileId } = file;
    const bytes = await read();
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) {
      fail("AGENT_FILE_SOURCE_CHANGED");
    }
    assertCurrent();
    this.#assertActive(profileId);
    const root = this.ensureProfile(profileId);
    const stage = fs.mkdtempSync(path.join(root, `.stage-${fileId}-`));
    this.#stages.add(stage);
    try {
      const handle = await fs.promises.open(path.join(stage, file.name), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      this.#write(stage, record);
      assertCurrent();
      const entries = this.#entries(profileId);
      const count = [...entries.values()].filter(entry => entry.file.status !== "deleted").length;
      if (count >= MAX_FILES) fail("AGENT_FILE_CAPACITY");
      const directory = this.#directory(record);
      if (lstatIfExists(directory)) fail("AGENT_FILE_CONFLICT");
      fs.renameSync(stage, directory);
      try { fsyncPrivateParent(root); }
      catch (error) {
        this.forgetProfile(profileId);
        fail("AGENT_FILE_COMMIT_UNCERTAIN", error);
      }
      entries.set(fileId, record);
      return { file };
    } finally {
      this.#stages.delete(stage);
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  rename({ profileId, fileId, name, expectedRevision }) {
    const entries = this.#entries(profileId);
    const record = entries.get(fileId);
    if (!record) fail("AGENT_FILE_NOT_FOUND");
    const nextName = filename(name);
    const view = this.#view(record);
    if (view.file.status !== "available") fail(view.file.status === "deleted" ? "AGENT_FILE_DELETED" : "AGENT_FILE_MISSING");
    if (nextName === record.file.name
      && [expectedRevision, expectedRevision + 1].includes(record.file.revision)) return { file: record.file };
    if (record.file.revision !== expectedRevision) fail("AGENT_FILE_CONFLICT");
    const directory = this.#directory(record);
    checkDirectory(directory);
    const target = lstatIfExists(this.#payload(record, nextName));
    if (target && (!privateRegular(target) || !sameInode(target, fs.lstatSync(view.path)))) fail("AGENT_FILE_CONFLICT");
    try {
      const pending = { ...record, pendingName: nextName };
      this.#write(directory, pending);
      const saved = this.#finishRename(pending);
      entries.set(fileId, saved);
      return { file: saved.file };
    } catch (error) {
      this.forgetProfile(profileId);
      throw error;
    }
  }

  delete({ profileId, fileId, expectedRevision }) {
    const entries = this.#entries(profileId);
    const record = entries.get(fileId);
    if (!record) fail("AGENT_FILE_NOT_FOUND");
    const directory = this.#directory(record);
    checkDirectory(directory);
    if (record.file.status === "deleted") {
      this.#erase(record);
      return { file: record.file };
    }
    if (record.file.revision !== expectedRevision) fail("AGENT_FILE_CONFLICT");
    const stat = lstatIfExists(this.#payload(record));
    if (stat && !privateRegular(stat)) fail("AGENT_FILE_CONFLICT");
    const file = { ...record.file, status: "deleted", revision: record.file.revision + 1,
      updatedAt: Math.max(this.now(), record.file.updatedAt + 1) };
    const tombstone = { ...record, file };
    try {
      this.#write(directory, tombstone);
      entries.set(fileId, tombstone);
      this.#erase(tombstone);
      return { file };
    } catch (error) {
      this.forgetProfile(profileId);
      throw error;
    }
  }
}

module.exports = { AgentFileStore, fileIdFor, fileIdFromStorageKey, filesRoot, payloadPath,
  importPath, readBoundedFile, readWorkspaceOutput, sha256 };
