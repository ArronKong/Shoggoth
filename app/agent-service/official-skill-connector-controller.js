"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { assertPrivateDirectory, ensurePrivateDirectoryTree, lstatIfExists, serviceError } = require("./security");
const { scanPackage } = require("./native-skill-store");
const { OFFICIAL_SKILL_IDS, OFFICIAL_SKILL_PUBLIC_MESSAGES, validateOfficialSkillParams,
  validateOfficialSkillStatus, validateOfficialAccountResult, officialSkillPublicError } = require("../core/official-skill-connector-dto");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DEADLINE_MS = 90 * 60 * 1000;
// Retired identities are accepted only in old ownership records, never by the
// public API or executable bridge. Keep them until owned cleanup succeeds.
const RETIRED_SKILL_IDS = ["netease-music"];
const STORED_SKILL_IDS = [...OFFICIAL_SKILL_IDS, ...RETIRED_SKILL_IDS];
const fail = code => { throw serviceError(code, OFFICIAL_SKILL_PUBLIC_MESSAGES[code]); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const initial = id => ({ id, revision: 0, state: "notInstalled", stage: null, installation: null, errorCode: null });
const relative = value => typeof value === "string" && value.length <= 1024 && !path.isAbsolute(value)
  && !/[\\\0]/u.test(value) && value.split("/").every(part => part && part !== "." && part !== "..")
  && value.split("/")[0] !== "home";
function validRecord(record) {
  if (!record || !STORED_SKILL_IDS.includes(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !["notInstalled", "installing", "installed", "removing", "failed"].includes(record.state)
    || ![null, "download", "verify", "installSkills", "registerMcp"].includes(record.stage)
    || record.errorCode !== null && !Object.hasOwn(OFFICIAL_SKILL_PUBLIC_MESSAGES, record.errorCode)
      && !(record.id === "netease-music" && record.errorCode === "OFFICIAL_SKILL_NETEASE_COMMAND_UNAVAILABLE")) return false;
  const item = record.installation;
  if (item === null) return ["notInstalled", "failed"].includes(record.state);
  return item && UUID.test(item.id) && typeof item.version === "string" && item.version.length <= 128
    && ID.test(item.serverId) && (item.transport === null || validStoredTransport(record.id, item))
    && Array.isArray(item.files) && item.files.length <= 4096
    && item.files.every(file => relative(file.path) && HASH.test(file.sha256))
    && new Set(item.files.map(file => file.path)).size === item.files.length
    && Array.isArray(item.skills) && item.skills.length <= 64
    && new Set(item.skills.map(skill => skill.id)).size === item.skills.length
    && item.skills.every(skill => ID.test(skill.id) && VERSION.test(skill.version) && HASH.test(skill.contentHash));
}
function validStoredTransport(id, item) {
  const transport = item.transport, args = transport?.args;
  return transport && Object.keys(transport).sort().join(",") === "args,command,cwd,kind"
    && transport.kind === "stdio-command" && typeof transport.command === "string" && path.isAbsolute(transport.command)
    && Array.isArray(args) && args.length === 7 && args.every(value => typeof value === "string" && value.length <= 4096 && !value.includes("\0"))
    && path.isAbsolute(args[0]) && path.basename(args[0]) === "official-skill-mcp-bridge.js"
    && path.basename(path.dirname(args[0])) === "agent-service" && args[1] === "--provider" && args[2] === id
    && args[3] === "--root" && path.isAbsolute(args[4])
    && args[4].endsWith(`/runtime-bin/official-skills/${id}/${item.id}`)
    && args[5] === "--home" && args[6] === path.join(args[4], "home") && transport.cwd === args[4];
}

// This record is the sole authority for installation removal. A matching name,
// third-party registration, or independently imported Skill never grants it.
class OfficialSkillConnectorController {
  constructor({ paths, skillStore, mcpController, providers, prepare, env = process.env, assertSecretSafe = () => {} } = {}) {
    this.paths = paths; this.skillStore = skillStore; this.mcp = mcpController;
    this.providers = providers || require("./official-skill-providers").PROVIDERS;
    this.prepare = prepare || require("./official-skill-installer").prepareOfficialSkill;
    this.env = env; this.assertSecretSafe = assertSecretSafe;
    this.recordPath = path.join(paths.stateDir, "official-skill-connectors.json");
    this.runtimeRoot = path.join(paths.stateDir, "runtime-bin", "official-skills");
    this.records = new Map(OFFICIAL_SKILL_IDS.map(id => [id, initial(id)]));
    this.pending = new Map(); this.aborts = new Map(); this.stamps = new Map();
    this.closed = true; this.blocked = false;
  }
  open() {
    this.closed = false; this.blocked = false;
    try {
      if (recoverInterruptedPrivateFile(this.recordPath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") throw new Error();
      if (lstatIfExists(this.recordPath)) {
        const stored = JSON.parse(readPrivateFile(this.recordPath, { maxBytes: 2 * 1024 * 1024 }));
        const previousIds = STORED_SKILL_IDS.filter(id => !["rollinggo-hotel", "baidu-maps"].includes(id));
        const baseIds = previousIds.filter(id => !["shop", "doordash"].includes(id));
        // Quark was added after Shop and DoorDash. Preserve the accepted catalogs
        // and also recognize each release's complete pre-Quark ownership record.
        const acceptedCatalogs = [baseIds, [...baseIds, "shop"], previousIds]
          .flatMap(ids => [ids, ids.filter(id => id !== "quark-drive")]);
        acceptedCatalogs.push(STORED_SKILL_IDS.filter(id => id !== "baidu-maps"), STORED_SKILL_IDS, OFFICIAL_SKILL_IDS);
        if (stored?.schemaVersion !== 1 || !Array.isArray(stored.items)
          || new Set(stored.items.map(item => item.id)).size !== stored.items.length || !stored.items.every(validRecord)
          || !acceptedCatalogs.some(ids => ids.length === stored.items.length && ids.every(id => stored.items.some(item => item.id === id)))) throw new Error();
        // Add newly introduced, uninstalled providers in memory. Preserve every existing
        // ownership record and persist the expanded catalog only on a mutation.
        this.records = new Map(OFFICIAL_SKILL_IDS.map(id => [id, stored.items.find(record => record.id === id) || initial(id)]));
        for (const record of stored.items) if (RETIRED_SKILL_IDS.includes(record.id)) this.records.set(record.id, record);
        for (const record of this.records.values()) {
          if (["installing", "removing"].includes(record.state)) this._write(record.id, { state: "failed", stage: null, errorCode: "OFFICIAL_SKILL_INTERRUPTED" });
        }
      }
    } catch { this.blocked = true; }
  }
  async retireRemovedProviders() {
    if (this.closed || this.blocked) return;
    for (const id of RETIRED_SKILL_IDS) {
      const item = this.records.get(id)?.installation;
      if (!item) continue;
      try {
        // Revoke the exact owned registration before validating removable files.
        // Modified payloads remain on disk, but cannot remain ready for Agents.
        await this.mcp.mutate(async () => {
          const server = this._ownedServer(id, item);
          this.mcp.invalidate(item.serverId); this.mcp.revokeRuns(item.serverId);
          if (server?.enabled) this.mcp.store.update({ id: item.serverId, expectedRevision: this.mcp.store.revision,
            patch: { enabled: false, status: "disabled", lastCheck: null } });
          await this.mcp.manager.closeServer(item.serverId);
        });
        await this._remove(id);
      } catch (error) {
        // A retired or damaged component must not block unrelated connectors.
        if (!this.blocked) this._write(id, { state: "failed", stage: null,
          errorCode: officialSkillPublicError(error, "OFFICIAL_SKILL_REMOVE_FAILED").code });
      }
    }
  }
  stopAdmission() { this.closed = true; for (const abort of this.aborts.values()) abort.abort(); }
  async close() {
    this.stopAdmission();
    // A capability probe has its own transport deadline; close its process now
    // so shutdown does not wait for that deadline before joining our work.
    await Promise.allSettled([...this.pending.keys()].map(id => {
      const serverId = this.records.get(id).installation?.serverId;
      return serverId ? this.mcp.manager.closeServer(serverId) : undefined;
    }));
    await Promise.allSettled([...this.pending.values()]);
  }
  _provider(id) { const provider = this.providers[id]; if (!provider) fail("OFFICIAL_SKILL_INVALID_ARGUMENT"); return provider; }
  _root(id, item = this.records.get(id)?.installation) {
    if (!STORED_SKILL_IDS.includes(id) || !item || !UUID.test(item.id)) fail("OFFICIAL_SKILL_STATE_UNAVAILABLE");
    return path.join(this.runtimeRoot, id, item.id);
  }
  _fixedTransport(id, item) {
    const root = this._root(id, item);
    return { kind: "stdio-command", command: process.execPath, args: [path.join(__dirname, "official-skill-mcp-bridge.js"), "--provider", id, "--root", root, "--home", path.join(root, "home")], cwd: root };
  }
  _assertFixedTransport(id, item) {
    if (!same(item.transport, this._fixedTransport(id, item))) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
  }
  _write(id, patch) {
    if (this.blocked) fail("OFFICIAL_SKILL_STATE_UNAVAILABLE");
    const next = { ...this.records.get(id), ...patch, revision: this.records.get(id).revision + 1 };
    if (!validRecord(next)) fail("OFFICIAL_SKILL_STATE_UNAVAILABLE");
    const items = [...this.records.keys()].map(key => key === id ? next : this.records.get(key))
      .filter(record => !RETIRED_SKILL_IDS.includes(record.id) || record.installation);
    try { atomicWritePrivateFile(this.recordPath, JSON.stringify({ schemaVersion: 1, items }), { trustedRoot: this.paths.trustedRoot }); }
    catch { this.blocked = true; fail("OFFICIAL_SKILL_STATE_UNAVAILABLE"); }
    this.records.set(id, next);
  }
  _matching(skill) { return this.skillStore.registry?.packages.find(item => item.id === skill.id && item.version === skill.version); }
  _checkFiles(id, item, { allowMissing = false } = {}) {
    const root = this._root(id, item);
    if (!lstatIfExists(root)) { if (allowMissing) return; fail("OFFICIAL_SKILL_INCOMPLETE"); }
    for (const dir of [path.join(this.paths.stateDir, "runtime-bin"), this.runtimeRoot, path.join(this.runtimeRoot, id), root]) assertPrivateDirectory(dir);
    for (const file of item.files) {
      const target = path.join(root, file.path), stat = lstatIfExists(target);
      if (!stat && allowMissing) continue;
      if (!stat) fail("OFFICIAL_SKILL_INCOMPLETE");
      let parent = path.dirname(target);
      while (parent !== root) { assertPrivateDirectory(parent); parent = path.dirname(parent); }
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
      const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
      if (this.stamps.get(target) !== stamp) {
        if (hash(fs.readFileSync(target)) !== file.sha256) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
        this.stamps.set(target, stamp);
      }
    }
  }
  _ownedServer(id, item) {
    const server = this.mcp.store.getPrivate(item.serverId);
    if (server && (!item.transport || server.source.kind !== "custom" || !same(server.transport, item.transport))) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
    return server;
  }
  status(id) {
    const record = this.records.get(id), provider = this._provider(id);
    let { state, stage, errorCode } = record;
    const item = this.blocked ? null : record.installation;
    const skillCount = item?.skills.filter(skill => this._matching(skill)?.contentHash === skill.contentHash).length || 0;
    if (item && state === "installed") {
      try {
        if (!same(item.transport, this._fixedTransport(id, item))) fail("OFFICIAL_SKILL_INCOMPLETE");
        this._checkFiles(id, item);
        if (!item.files.length || !item.skills.length || skillCount !== item.skills.length || !this._ownedServer(id, item)) throw new Error();
      } catch (error) { state = "failed"; errorCode = error.code === "OFFICIAL_SKILL_OWNERSHIP_CONFLICT" ? error.code : "OFFICIAL_SKILL_INCOMPLETE"; }
    }
    if (this.blocked) { state = "failed"; stage = null; errorCode = "OFFICIAL_SKILL_STATE_UNAVAILABLE"; }
    return validateOfficialSkillStatus({ id, revision: record.revision, state, stage, version: provider.version,
      installedVersion: item?.version || null, skillCount, serverId: item?.serverId || null,
      canRemove: Boolean(item), errorCode });
  }
  handle(method, params) {
    validateOfficialSkillParams(method, params);
    if (this.closed) fail("OFFICIAL_SKILL_UNAVAILABLE");
    if (method === "connector.official.status") return { items: OFFICIAL_SKILL_IDS.map(id => this.status(id)) };
    if (this.blocked) fail("OFFICIAL_SKILL_STATE_UNAVAILABLE");
    const { id } = params;
    if (this.pending.has(id)) fail("OFFICIAL_SKILL_BUSY");
    if (params.expectedRevision !== this.records.get(id).revision) fail("OFFICIAL_SKILL_REVISION_CONFLICT");
    const abort = new AbortController(); this.aborts.set(id, abort);
    const timer = setTimeout(() => abort.abort(), method === "connector.official.account" ? 125_000 : DEADLINE_MS); timer.unref?.();
    const work = Promise.resolve().then(() => method === "connector.official.account" ? this._account(params, abort.signal) : this._mutate(method, id, abort.signal))
      .finally(() => { clearTimeout(timer); this.pending.delete(id); this.aborts.delete(id); });
    this.pending.set(id, work); return work;
  }
  async _account(params, signal) {
    const item = this.records.get(params.id).installation;
    if (!item || this.status(params.id).state !== "installed") fail("OFFICIAL_SKILL_NOT_INSTALLED");
    this._ownedServer(params.id, item);
    try {
      const response = await this.mcp.manager.callTool(item.serverId, `account_${params.action}`,
        params.action === "bind" && params.code !== undefined ? { code: params.code } : {},
        { signal, assertCurrent: () => { if (this.closed || signal.aborted) fail("OFFICIAL_SKILL_AUTH_CANCELLED"); this._ownedServer(params.id, item); } });
      if (response?.isError || !Array.isArray(response?.content) || response.content.length !== 1
        || response.content[0]?.type !== "text" || typeof response.content[0].text !== "string" || response.content[0].text.length > 160 * 1024) fail("OFFICIAL_SKILL_AUTH_FAILED");
      const parsed = JSON.parse(response.content[0].text);
      const result = validateOfficialAccountResult({ ...parsed, id: params.id });
      this.assertSecretSafe(JSON.stringify(result));
      return result;
    } catch (error) {
      if (signal.aborted || this.closed) fail("OFFICIAL_SKILL_AUTH_CANCELLED");
      fail(officialSkillPublicError(error, params.action === "status" ? "OFFICIAL_SKILL_AUTH_STATUS_FAILED" : "OFFICIAL_SKILL_AUTH_FAILED").code);
    }
  }
  async _mutate(method, id, signal) {
    try {
      signal.throwIfAborted(); if (this.closed) fail("OFFICIAL_SKILL_INTERRUPTED");
      if (method === "connector.official.remove") { await this._remove(id, signal); return this.status(id); }
      if (this.status(id).state === "installed") {
        const installed = this.records.get(id).installation;
        const server = this._ownedServer(id, installed);
        if (!server.enabled) {
          // Explicit Install/Repair may reconnect a restored or disabled item;
          // passive status/startup must never restore access on its own.
          await this.mcp.mutate(() => {
            signal.throwIfAborted(); this._ownedServer(id, installed);
            const configured = server.setup.requiredFields.every(field => server.setup.configuredFields.includes(field));
            this.mcp.store.update({ id: installed.serverId, expectedRevision: this.mcp.store.revision,
              patch: { enabled: true, status: configured ? "checking" : "needsSetup", lastCheck: null } });
            this.mcp.invalidate(installed.serverId);
          });
          this._write(id, { state: "installed", stage: null, errorCode: null });
          if (this.mcp.store.getPrivate(installed.serverId).status === "checking") await this.mcp.verify(installed.serverId);
        }
        return this.status(id);
      }
      let item = this.records.get(id).installation;
      const previousTransport = item?.transport || null;
      if (item) await this._clearPayload(id, item, true, signal);
      else item = { id: crypto.randomUUID(), version: this._provider(id).version,
        serverId: `official-${id}-${crypto.randomBytes(4).toString("hex")}`, transport: null, files: [], skills: [] };
      this._write(id, { state: "installing", stage: "download", installation: item, errorCode: null });
      const root = this._root(id, item);
      ensurePrivateDirectoryTree(root, this.paths.trustedRoot);
      ensurePrivateDirectoryTree(path.join(root, "home"), this.paths.trustedRoot);
      const prepared = await this.prepare({ providerId: id, root, homeDir: path.join(root, "home"), signal,
        serverId: item.serverId, env: this.env, onStage: stage => { signal.throwIfAborted(); this._write(id, { stage }); } });
      signal.throwIfAborted(); if (this.closed) fail("OFFICIAL_SKILL_INTERRUPTED");
      if (!prepared || !Array.isArray(prepared.skills) || !prepared.skills.length || !Array.isArray(prepared.files) || !prepared.files.length) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      for (const skill of prepared.skills) {
        const source = path.resolve(skill.sourcePath || ""), adapterRoot = path.join(root, "adapters");
        if (!source.startsWith(`${adapterRoot}${path.sep}`)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
        const scan = scanPackage(source);
        if (scan.manifest.id !== skill.id || scan.manifest.version !== skill.version || scan.contentHash !== skill.contentHash) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      }
      if (prepared.skills.some(skill => [...(this.skillStore.registry?.packages || []), ...(this.skillStore.builtins || [])].some(existing => existing.id === skill.id))) fail("OFFICIAL_SKILL_CONFLICT");
      item = { ...item, version: this._provider(id).version, transport: prepared.transport,
        files: prepared.files.map(({ path: relativePath, sha256 }) => ({ path: relativePath, sha256 })),
        skills: prepared.skills.map(({ id: skillId, version, contentHash }) => ({ id: skillId, version, contentHash })) };
      if (!validRecord({ ...this.records.get(id), installation: item })) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      this._assertFixedTransport(id, item); this._checkFiles(id, item);
      // Durable intent precedes both authority writes; a restart can remove the
      // exact package/server even if the next state write never completed.
      this._write(id, { stage: "installSkills", installation: item });
      this.skillStore.installBatchFromDirectories({ operationId: `official-${item.id}`, expectedRevision: this.skillStore.revision,
        items: prepared.skills.map(skill => ({ sourcePath: skill.sourcePath, globalEnabled: true })) });
      this._write(id, { stage: "registerMcp" });
      await this.mcp.mutate(() => {
        signal.throwIfAborted(); if (this.closed) fail("OFFICIAL_SKILL_INTERRUPTED");
        const old = this._ownedServer(id, { ...item, transport: previousTransport || item.transport }), requiredFields = this._provider(id).requiredFields || [];
        const configuredFields = old?.setup.configuredFields || [];
        const readyToCheck = requiredFields.every(field => configuredFields.includes(field));
        this.mcp.store.register({ expectedRevision: this.mcp.store.revision, server: {
          id: item.serverId, name: this._provider(id).name, source: { kind: "custom" }, transport: item.transport,
          enabled: true, auth: { kind: "none" }, secretRef: old?.secretRef || null,
          setup: { requiredFields, configuredFields }, status: readyToCheck ? "checking" : "needsSetup",
          lastCheck: null, disabledProfileIds: old?.disabledProfileIds || [],
        } });
        this.mcp.invalidate(item.serverId);
      });
      this._write(id, { state: "installed", stage: null, errorCode: null });
      const server = this.mcp.store.getPrivate(item.serverId);
      if (server.enabled && server.status === "checking") await this.mcp.verify(item.serverId);
      signal.throwIfAborted(); return this.status(id);
    } catch (error) {
      const code = signal.aborted || this.closed ? "OFFICIAL_SKILL_INTERRUPTED"
        : officialSkillPublicError(error, method === "connector.official.remove" ? "OFFICIAL_SKILL_REMOVE_FAILED" : "OFFICIAL_SKILL_INSTALL_FAILED").code;
      if (!this.blocked) this._write(id, { state: "failed", stage: null, errorCode: code });
      fail(this.blocked ? "OFFICIAL_SKILL_STATE_UNAVAILABLE" : code);
    }
  }
  _validateOwnedSkills(item) {
    for (const skill of item.skills) {
      const existing = this._matching(skill);
      if (existing && (existing.contentHash !== skill.contentHash
        || scanPackage(path.join(this.paths.skillPackagesDir, skill.id, skill.version)).contentHash !== skill.contentHash)) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
    }
  }
  async _clearPayload(id, item, preserveHome, signal) {
    this._validateOwnedSkills(item); this._checkFiles(id, item, { allowMissing: true });
    this._ownedServer(id, item);
    const root = this._root(id, item);
    if (lstatIfExists(root)) assertRemovableTree(root);
    // Revoke every frozen Run before touching executable files or Skills.
    await this.mcp.mutate(async () => {
      this._ownedServer(id, item); this.mcp.invalidate(item.serverId); this.mcp.revokeRuns(item.serverId);
      const server = this.mcp.store.getPrivate(item.serverId);
      if (server?.enabled) this.mcp.store.setStatus(item.serverId, "needsSetup", null);
      await this.mcp.manager.closeServer(item.serverId);
    });
    signal?.throwIfAborted(); if (this.closed) fail("OFFICIAL_SKILL_INTERRUPTED");
    for (const skill of item.skills) {
      if (!this._matching(skill)) continue;
      for (const [profileId, manifest] of this.skillStore.profileManifests) {
        if (manifest.selections.some(selection => selection.skillId === skill.id && selection.source === "user" && selection.version === skill.version)) {
          this.skillStore.setProfileSkill({ profileId, skillId: skill.id, source: "user", version: skill.version,
            enabled: false, expectedRevision: manifest.revision });
        }
      }
      this.skillStore.uninstall({ skillId: skill.id, source: "user", version: skill.version, expectedRevision: this.skillStore.revision });
    }
    if (lstatIfExists(root)) {
      if (preserveHome) for (const name of fs.readdirSync(root)) { if (name !== "home") removeOwnedTree(path.join(root, name)); }
      else removeOwnedTree(root);
    }
  }
  async _remove(id, signal) {
    const item = this.records.get(id).installation;
    if (!item) { this._write(id, { state: "notInstalled", stage: null, errorCode: null }); return; }
    this._validateOwnedSkills(item); this._checkFiles(id, item, { allowMissing: true }); this._ownedServer(id, item);
    this._write(id, { state: "removing", stage: null, errorCode: null });
    await this._clearPayload(id, item, false, signal);
    await this.mcp.mutate(async () => {
      const server = this._ownedServer(id, item);
      if (server) this.mcp.store.remove({ id: item.serverId, expectedRevision: this.mcp.store.revision });
      this.mcp.invalidate(item.serverId); this.mcp.revokeRuns(item.serverId);
      await this.mcp.oauth?.cancelServer?.(item.serverId);
      await this.mcp.secrets.remove(item.serverId);
    });
    this._write(id, { state: "notInstalled", stage: null, installation: null, errorCode: null });
  }
}
function assertRemovableTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("OFFICIAL_SKILL_OWNERSHIP_CONFLICT");
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) assertRemovableTree(path.join(target, name));
}
function removeOwnedTree(target) {
  assertRemovableTree(target);
  if (fs.lstatSync(target).isDirectory()) { for (const name of fs.readdirSync(target)) removeOwnedTree(path.join(target, name)); fs.rmdirSync(target); }
  else fs.unlinkSync(target);
}
module.exports = { OfficialSkillConnectorController, DEADLINE_MS };
