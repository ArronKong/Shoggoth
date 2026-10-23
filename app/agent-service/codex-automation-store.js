"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const TOML = require("smol-toml");
const { BUILTIN_CLI_AGENT_PROFILES } = require("./builtin-cli-profiles");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("./runtime-account");
const { serviceError } = require("./security");

// The first-generated Codex Agent: the initial owner of the Codex automations.
const OWNER = BUILTIN_CLI_AGENT_PROFILES.find(value => value.runtime === "codex");
const ACCOUNT_ID = DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex;

// A deleted Agent, or one whose default Binding is missing or disabled, does
// not qualify. Any other store failure still throws, so a transient error never
// clears the recorded owner.
function qualifiedOwner(productStore, profileId) {
  const raw = productStore.getAgentProfile(profileId);
  if (raw?.enabled !== true) return null;
  let profile = raw;
  try {
    profile = productStore.resolveAgentRuntimeProfile?.(raw.id) || raw;
  } catch (error) {
    if (error?.code === "AGENT_BINDING_NOT_FOUND" || error?.code === "AGENT_BINDING_DISABLED") return null;
    throw error;
  }
  return profile.enabled === true && profile.backendId === OWNER.backendId && profile.runtime === "codex"
    && profile.runtimeAccountId === ACCOUNT_ID ? profile : null;
}

// Ownership stays with its Agent until that Agent is deleted or no longer runs
// on the local Codex CLI by default. It then moves to the first-generated Codex
// Agent, or else to the earliest-created Agent that does, and stays there. With
// no such Agent the automations are unavailable until one appears.
function resolveCodexAutomationOwner(productStore, ownerState) {
  const recorded = ownerState.codexAutomationOwner();
  let owner = recorded === null ? null : qualifiedOwner(productStore, recorded);
  if (owner) return owner;
  owner = qualifiedOwner(productStore, OWNER.id);
  if (!owner) {
    const profiles = (productStore.listAgentProfiles?.() || []).slice()
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.id.localeCompare(right.id));
    for (const profile of profiles) {
      owner = qualifiedOwner(productStore, profile.id);
      if (owner) break;
    }
  }
  ownerState.setCodexAutomationOwner(owner?.id ?? null);
  return owner;
}
const MAX_FILE_BYTES = 512 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code = "CODEX_AUTOMATION_UNAVAILABLE") => { throw serviceError(code, code); };
const parse = text => TOML.parse(text, { integersAsBigInt: true, unsafeKeyBehaviour: "throw" });
const serialize = value => TOML.stringify(value, { numbersAsFloat: true });
// TOML tables have a null prototype. Compare values and TOML types, while
// allowing an ordinary object supplied by the create endpoint.
function tables(value) {
  if (Array.isArray(value)) return value.map(tables);
  if (value && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tables(item)])));
  }
  return value;
}
const number = value => typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN;

function assertDefinition(value, id) {
  if (value.version !== 1n || value.id !== id || !["cron", "heartbeat"].includes(value.kind)
    || !["ACTIVE", "PAUSED"].includes(value.status) || !ID.test(id)
    || !["name", "prompt", "rrule"].every(key => typeof value[key] === "string" && value[key].trim()
      && value[key].isWellFormed() && !value[key].includes("\0"))
    || value.name.length > 256
    || ["model", "reasoning_effort", "execution_environment", "local_environment_config_path"].some(key =>
      key in value && (typeof value[key] !== "string" || !value[key] || value[key].length > 4096 || value[key].includes("\0")))
    || ("cwds" in value && (!Array.isArray(value.cwds) || value.cwds.length > 64
      || value.cwds.some(item => typeof item !== "string" || !item || item.length > 4096 || item.includes("\0"))))
    || ("target" in value && (!value.target || Array.isArray(value.target) || typeof value.target.type !== "string"))
    || !Number.isSafeInteger(number(value.created_at))
    || !Number.isSafeInteger(number(value.updated_at))
    || (value.kind === "heartbeat" && (typeof value.target_thread_id !== "string" || !value.target_thread_id))) {
    fail("CODEX_AUTOMATION_FORMAT_UNSUPPORTED");
  }
  return value;
}

// Native client data is never written here. Its cache is used only to detect
// account-owned/migrated/deleted tasks and to read native execution receipts.
class CodexAutomationDatabase {
  constructor(home, databaseFactory) {
    this.file = path.join(home, "sqlite", "codex-dev.db");
    this.home = home;
    this.databaseFactory = databaseFactory || (file => {
      const { DatabaseSync } = require("node:sqlite");
      return new DatabaseSync(file, { readOnly: true });
    });
  }
  query(callback) {
    let db;
    try {
      if (!fs.existsSync(this.file)) fail("CODEX_AUTOMATION_STORAGE_UNKNOWN");
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || !fs.realpathSync(this.file).startsWith(this.home + path.sep)) fail();
      db = this.databaseFactory(this.file);
      return callback(db);
    } catch (error) {
      if (String(error.code).startsWith("CODEX_AUTOMATION_")) throw error;
      fail("CODEX_AUTOMATION_STORAGE_UNKNOWN");
    } finally { db?.close(); }
  }
  ownership(id = null) {
    return this.query(db => {
      const columns = new Set(db.prepare("PRAGMA table_info(automations)").all().map(row => row.name));
      if (!["id", "status", "account_id", "user_id", "installation_id"].every(key => columns.has(key))) {
        fail("CODEX_AUTOMATION_STORAGE_UNKNOWN");
      }
      const rows = id === null
        ? db.prepare("SELECT id,status,account_id,user_id,installation_id FROM automations LIMIT 4097").all()
        : db.prepare("SELECT id,status,account_id,user_id,installation_id FROM automations WHERE id = ?").all(id);
      if (rows.length > 4096) fail("CODEX_AUTOMATION_CAPACITY");
      if (rows.some(row => row.account_id || row.user_id || row.installation_id)) fail("CODEX_AUTOMATION_MIGRATED");
      if (id !== null && rows.some(row => !["ACTIVE", "PAUSED"].includes(row.status))) fail("CODEX_AUTOMATION_DELETED");
      return rows[0] || null;
    });
  }
  metadata(id) {
    return this.query(db => db.prepare("SELECT last_run_at,next_run_at,updated_at FROM automations WHERE id = ?").get(id) || null);
  }
  runs(id, offset = 0, limit = 20) {
    this.ownership(id);
    return this.query(db => db.prepare(`SELECT thread_id,status,thread_title,source_cwd,inbox_title,inbox_summary,created_at,updated_at,
      archived_assistant_message,archived_reason FROM automation_runs WHERE automation_id = ?
      ORDER BY created_at DESC,thread_id DESC LIMIT ? OFFSET ?`).all(id, limit + 1, offset));
  }
}

class CodexAutomationStore {
  constructor({ home, now = Date.now, databaseFactory }) {
    this.home = fs.realpathSync(home);
    this.root = path.join(this.home, "automations");
    this.homeIdentity = hash(this.home).slice(0, 24);
    this.now = now;
    this.database = new CodexAutomationDatabase(this.home, databaseFactory);
    this.tails = new Map();
  }
  externalId(id) { return `codex-automation:${this.homeIdentity}:${id}`; }
  localId(id) {
    const prefix = `codex-automation:${this.homeIdentity}:`;
    if (typeof id !== "string" || !id.startsWith(prefix) || !ID.test(id.slice(prefix.length))) fail("CODEX_AUTOMATION_NOT_FOUND");
    return id.slice(prefix.length);
  }
  directory(id, create = false) {
    if (!ID.test(id)) fail("CODEX_AUTOMATION_NOT_FOUND");
    if (create && !fs.existsSync(this.root)) fs.mkdirSync(this.root, { mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink() || !fs.lstatSync(this.root).isDirectory()
      || fs.realpathSync(this.root) !== this.root) fail();
    const directory = path.join(this.root, id);
    if (create) fs.mkdirSync(directory, { mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()
      || fs.realpathSync(directory) !== directory) fail();
    return directory;
  }
  read(id) {
    try {
      const file = path.join(this.directory(id), "automation.toml");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail("CODEX_AUTOMATION_FORMAT_UNSUPPORTED");
        const bytes = fs.readFileSync(fd);
        const current = fs.lstatSync(file);
        if (current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev) fail("CODEX_AUTOMATION_CONFLICT");
        const definition = assertDefinition(parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), id);
        return { definition, revision: hash(bytes), file, mode: stat.mode & 0o777 };
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (String(error.code).startsWith("CODEX_AUTOMATION_")) throw error;
      fail(error.code === "ENOENT" ? "CODEX_AUTOMATION_NOT_FOUND" : "CODEX_AUTOMATION_FORMAT_UNSUPPORTED");
    }
  }
  list() {
    if (!fs.existsSync(this.root)) return { records: [], unavailable: [] };
    if (fs.lstatSync(this.root).isSymbolicLink() || fs.realpathSync(this.root) !== this.root) fail();
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    if (entries.length > 1024) fail("CODEX_AUTOMATION_CAPACITY");
    const records = [], unavailable = [];
    for (const entry of entries) {
      if (!ID.test(entry.name)) continue;
      try { records.push(this.read(entry.name)); }
      catch (error) { unavailable.push({ id: entry.name, reason: error.code }); }
    }
    return { records, unavailable };
  }
  serial(id, work) {
    const prior = this.tails.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.tails.set(id, next);
    void next.finally(() => { if (this.tails.get(id) === next) this.tails.delete(id); }).catch(() => {});
    return next;
  }
  async create(definition) {
    return this.serial("create", () => {
      this.database.ownership(); // Creating a legacy task in a migrated account would duplicate authority.
      assertDefinition(definition, definition.id);
      this.directory(definition.id, true);
      return this.commit(definition, null);
    });
  }
  async update(id, revision, mutate) {
    return this.serial(id, () => {
      const before = this.read(id);
      if (before.revision !== revision) fail("CODEX_AUTOMATION_CONFLICT");
      this.database.ownership(id);
      const next = mutate(parse(fs.readFileSync(before.file, "utf8")));
      next.updated_at = BigInt(this.now());
      assertDefinition(next, id);
      if (next.id !== before.definition.id || next.created_at !== before.definition.created_at || next.kind !== before.definition.kind) fail();
      return this.commit(next, before);
    });
  }
  commit(definition, before) {
    const directory = this.directory(definition.id);
    const file = path.join(directory, "automation.toml");
    const bytes = Buffer.from(serialize(definition));
    if (bytes.length > MAX_FILE_BYTES || !isDeepStrictEqual(parse(bytes.toString()), tables(definition))) fail("CODEX_AUTOMATION_FORMAT_UNSUPPORTED");
    const temporary = path.join(directory, `.shoggoth-${crypto.randomUUID()}.tmp`);
    let replaced = false;
    try {
      const fd = fs.openSync(temporary, "wx", before?.mode ?? 0o600);
      try { fs.fchmodSync(fd, before?.mode ?? 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (before) {
        if (this.read(definition.id).revision !== before.revision) fail("CODEX_AUTOMATION_CONFLICT");
        this.database.ownership(definition.id);
      } else if (fs.existsSync(file)) fail("CODEX_AUTOMATION_CONFLICT");
      // Atomic replacement is not a cross-process compare-and-swap with Codex.
      if (before) fs.renameSync(temporary, file);
      else { fs.linkSync(temporary, file); fs.unlinkSync(temporary); }
      replaced = true;
      const parent = fs.openSync(directory, "r");
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      const saved = this.read(definition.id);
      if (saved.revision !== hash(bytes)) fail("CODEX_AUTOMATION_COMMIT_UNCERTAIN");
      return saved;
    } catch (error) {
      if (replaced) fail("CODEX_AUTOMATION_COMMIT_UNCERTAIN");
      throw error;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

module.exports = { OWNER, ACCOUNT_ID, CodexAutomationStore, CodexAutomationDatabase, assertDefinition, number, hash,
  resolveCodexAutomationOwner };
