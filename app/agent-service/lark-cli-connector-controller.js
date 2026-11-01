"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { scanPackage } = require("./native-skill-store");
const { RELEASE, DEADLINE_MS, prepareLarkCli, sha256 } = require("./lark-cli-installer");
const { LarkCliSetupController } = require("./lark-cli-setup-controller");
const { LARK_CLI_PUBLIC_MESSAGES, validateLarkCliParams, validateLarkCliResult, larkCliPublicError } = require("../core/lark-cli-contract");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = code => { throw serviceError(code, LARK_CLI_PUBLIC_MESSAGES[code]); };
const initial = () => ({ schemaVersion: 1, revision: 0, state: "notInstalled", stage: null, installation: null, errorCode: null });
function validRecord(record) {
  if (!record || record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !["notInstalled", "installing", "installed", "removing", "failed"].includes(record.state)
    || ![null, "downloadCli", "downloadSkills", "verify", "installSkills"].includes(record.stage)
    || (record.errorCode !== null && !Object.hasOwn(LARK_CLI_PUBLIC_MESSAGES, record.errorCode))) return false;
  const item = record.installation;
  if (item === null) return ["notInstalled", "failed"].includes(record.state);
  return item && UUID.test(item.id) && VERSION.test(item.version)
    && (item.cliSha256 === null || HASH.test(item.cliSha256))
    && Array.isArray(item.skills) && item.skills.length <= 64
    && new Set(item.skills.map(skill => skill.id)).size === item.skills.length
    && item.skills.every(skill => /^lark-[a-z0-9-]{1,58}$/u.test(skill.id)
      && VERSION.test(skill.version) && HASH.test(skill.contentHash));
}

// Only this Service-owned installation record grants removal authority. Existing
// npm/global installations, CLI account data and independently imported skills
// never become owned merely because they have the same name.
class LarkCliConnectorController {
  constructor({ paths, skillStore, release = RELEASE, prepare = prepareLarkCli,
    platform = process.platform, arch = process.arch, env = process.env, setupOptions = {} } = {}) {
    Object.assign(this, { paths, skillStore, release, prepare, platform, arch, env });
    this.recordPath = path.join(paths.stateDir, "lark-cli-connector.json");
    this.runtimeRoot = path.join(paths.stateDir, "runtime-bin", "lark-cli");
    this.record = initial(); this.closed = true; this.blocked = false; this.pending = null; this.abort = null;
    this.setup = new LarkCliSetupController({ paths, env, getInstallation: () => this.status(), ...setupOptions });
  }
  open() {
    this.closed = false; this.blocked = false;
    this.setup.open();
    try {
      if (recoverInterruptedPrivateFile(this.recordPath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw new Error();
      if (lstatIfExists(this.recordPath)) {
        const record = JSON.parse(readPrivateFile(this.recordPath, { maxBytes: 128 * 1024 }));
        if (!validRecord(record)) throw new Error();
        this.record = record;
        if (["installing", "removing"].includes(this.record.state)) this._write({ state: "failed", stage: null, errorCode: "LARK_CLI_INTERRUPTED" });
      }
    } catch { this.blocked = true; }
  }
  stopAdmission() { this.closed = true; this.abort?.abort(); this.setup.stopAdmission(); }
  async close() { this.stopAdmission(); await Promise.allSettled([this.pending, this.setup.close()].filter(Boolean)); }
  _root(item = this.record.installation) {
    if (!item || !UUID.test(item.id)) fail("LARK_CLI_STATE_UNAVAILABLE");
    return path.join(this.runtimeRoot, item.id);
  }
  _write(patch) {
    if (this.blocked) fail("LARK_CLI_STATE_UNAVAILABLE");
    const next = { ...this.record, ...patch, revision: this.record.revision + 1 };
    try { atomicWritePrivateFile(this.recordPath, JSON.stringify(next), { trustedRoot: this.paths.trustedRoot }); }
    catch { this.blocked = true; fail("LARK_CLI_STATE_UNAVAILABLE"); }
    this.record = next;
  }
  _packages() { return this.skillStore.registry?.packages || []; }
  _matching(skill) { return this._packages().find(item => item.id === skill.id && item.version === skill.version); }
  status() {
    let { state, stage, errorCode } = this.record;
    const item = this.blocked ? null : this.record.installation;
    const skillCount = item?.skills.filter(skill => this._matching(skill)?.contentHash === skill.contentHash).length || 0;
    let cliPath = item?.cliSha256 ? path.join(this._root(item), "bin", "lark-cli") : null;
    if (state === "installed" && item) {
      try {
        this._assertPayloadDirectories(item);
        const stat = lstatIfExists(cliPath);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(stat.mode & 0o100)
          || skillCount !== item.skills.length || !skillCount) throw new Error();
        const stamp = [cliPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
        if (this.executableStamp !== stamp) {
          if (sha256(fs.readFileSync(cliPath)) !== item.cliSha256) throw new Error();
          this.executableStamp = stamp;
        }
        assertPrivateDirectory(path.join(this._root(item), "skills"));
        for (const skill of item.skills) {
          const skillRoot = path.join(this._root(item), "skills", skill.id);
          assertPrivateDirectory(skillRoot);
          const entry = lstatIfExists(path.join(skillRoot, "SKILL.md"));
          if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error();
        }
      } catch { state = "failed"; errorCode = "LARK_CLI_INCOMPLETE"; cliPath = null; }
    }
    if (this.blocked) { state = "failed"; stage = null; errorCode = "LARK_CLI_STATE_UNAVAILABLE"; }
    else if (!this.release.archives[`${this.platform}-${this.arch}`] && !item) { state = "failed"; errorCode = "LARK_CLI_UNSUPPORTED"; }
    return validateLarkCliResult("connector.lark.status", { id: "lark-cli", revision: this.record.revision,
      state, stage, version: this.release.version, installedVersion: item?.version || null, skillCount,
      cliPath, canRemove: Boolean(item), errorCode });
  }
  handle(method, params) {
    validateLarkCliParams(method, params);
    if (this.closed) fail("LARK_CLI_UNAVAILABLE");
    if (method === "connector.lark.status") return this.status();
    if (this.blocked) fail("LARK_CLI_STATE_UNAVAILABLE");
    if (this.pending) fail("LARK_CLI_BUSY");
    if (method.startsWith("connector.lark.setup.")) return this.setup.handle(method, params);
    if (this.setup.active) fail("LARK_CLI_BUSY");
    if (params.expectedRevision !== this.record.revision) fail("LARK_CLI_REVISION_CONFLICT");
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), DEADLINE_MS); timer.unref?.();
    this.pending = this._mutate(method).finally(() => { clearTimeout(timer); this.pending = null; this.abort = null; });
    return this.pending;
  }
  async _mutate(method) {
    try {
      if (method === "connector.lark.remove") { this._removeOwned(); return this.status(); }
      if (!this.release.archives[`${this.platform}-${this.arch}`]) fail("LARK_CLI_UNSUPPORTED");
      if (this.status().state === "installed") return this.status();
      if (this.record.installation) this._removeOwned();
      const item = { id: crypto.randomUUID(), version: this.release.version, cliSha256: null, skills: [] };
      this._write({ state: "installing", stage: "downloadCli", installation: item, errorCode: null });
      const root = this._root(item);
      ensurePrivateDirectoryTree(root, this.paths.trustedRoot);
      const prepared = await this.prepare({ root, homeDir: this.paths.homeDir, release: this.release,
        platform: this.platform, arch: this.arch, env: this.env, signal: this.abort.signal,
        onStage: stage => { this.abort.signal.throwIfAborted(); this._write({ stage }); } });
      this.abort.signal.throwIfAborted();
      if (this.closed) fail("LARK_CLI_INTERRUPTED");
      // Recheck after all downloads: another skill import may have completed meanwhile.
      if (prepared.skills.some(skill => [...this._packages(), ...(this.skillStore.builtins || [])].some(existing => existing.id === skill.id))) fail("LARK_CLI_SKILL_CONFLICT");
      const skills = prepared.skills.map(({ id, version, contentHash }) => ({ id, version, contentHash }));
      // Durable intent precedes the atomic skill transaction, so a crash can be
      // reconciled/deleted without adopting unrelated same-name packages.
      this._write({ stage: "installSkills", installation: { ...item, cliSha256: prepared.cliSha256, skills } });
      this.skillStore.installBatchFromDirectories({ operationId: `lark-${item.id}`, expectedRevision: this.skillStore.revision,
        items: prepared.skills.map(skill => ({ sourcePath: skill.sourcePath, globalEnabled: true })) });
      this._write({ state: "installed", stage: null, errorCode: null });
      return this.status();
    } catch (error) {
      const code = this.abort?.signal.aborted ? "LARK_CLI_INTERRUPTED"
        : larkCliPublicError(error, method === "connector.lark.remove" ? "LARK_CLI_REMOVE_FAILED" : "LARK_CLI_INSTALL_FAILED").code;
      if (!this.blocked) this._write({ state: "failed", stage: null, errorCode: code });
      fail(this.blocked ? "LARK_CLI_STATE_UNAVAILABLE" : code);
    }
  }
  _assertPayloadDirectories(item) {
    for (const dir of [path.join(this.paths.stateDir, "runtime-bin"), this.runtimeRoot, this._root(item), path.join(this._root(item), "bin")]) assertPrivateDirectory(dir);
  }
  _removeOwned() {
    const item = this.record.installation;
    if (!item) { this._write({ state: "notInstalled", stage: null, errorCode: null }); return; }
    const root = this._root(item);
    // Validate all claimed packages and the whole owned tree before deleting any.
    for (const skill of item.skills) {
      const existing = this._matching(skill);
      if (existing && (existing.contentHash !== skill.contentHash
        || scanPackage(path.join(this.paths.skillPackagesDir, skill.id, skill.version)).contentHash !== skill.contentHash)) fail("LARK_CLI_OWNERSHIP_CONFLICT");
    }
    if (lstatIfExists(root)) {
      for (const dir of [path.join(this.paths.stateDir, "runtime-bin"), this.runtimeRoot, root]) assertPrivateDirectory(dir);
      assertRemovableTree(root);
    }
    this._write({ state: "removing", stage: null, errorCode: null });
    for (const skill of item.skills) {
      if (!this._matching(skill)) continue;
      // Release only references to this exact owned package/version.
      for (const [profileId, manifest] of this.skillStore.profileManifests) {
        if (manifest.selections.some(selection => selection.skillId === skill.id && selection.source === "user" && selection.version === skill.version)) {
          this.skillStore.setProfileSkill({ profileId, skillId: skill.id, source: "user", version: skill.version,
            enabled: false, expectedRevision: manifest.revision });
        }
      }
      this.skillStore.uninstall({ skillId: skill.id, source: "user", version: skill.version, expectedRevision: this.skillStore.revision });
    }
    if (lstatIfExists(root)) removeOwnedTree(root);
    this._write({ state: "notInstalled", stage: null, installation: null, errorCode: null });
  }
}
function assertRemovableTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())
    || (stat.isFile() && stat.nlink !== 1)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("LARK_CLI_OWNERSHIP_CONFLICT");
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) assertRemovableTree(path.join(target, name));
}
function removeOwnedTree(target) {
  assertRemovableTree(target);
  if (fs.lstatSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) removeOwnedTree(path.join(target, name));
    fs.rmdirSync(target);
  } else fs.unlinkSync(target);
}
module.exports = { LarkCliConnectorController };
