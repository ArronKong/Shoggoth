"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const p = require("./group-runtime-host-protocol");
const { ExternalInspirationRunner } = require("./external-inspiration-runner");
const { EXTERNAL_TERMINAL, validExternalSnapshot, validateGroupExecutionReceiptResult } = require("./external-inspiration-protocol");
const { GroupTaskWorkspaces } = require("./agent-service/group-task-workspaces");
const { openDatabase, transaction } = require("./agent-service/inspiration-database");
const { acquirePrivateWriterLease } = require("./agent-service/private-writer-lease");
const { preparePrivateParent, atomicWritePrivateFile, readPrivateFile } = require("./agent-service/private-file");
const { validateGroupMcpArguments } = require("./agent-service/group-mcp-tools");
const { resultPage } = require("./group-result-content");

const LEASE_MS = 30_000;
const ARTIFACT_PAGE = 16 * 1024;
const MAX_ARTIFACT = 64 * 1024 * 1024;
const boundFields = ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"];
const same = (a, b, fields) => fields.every(key => a?.[key] === b?.[key]);
function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** A paired execution host. It never owns the public group log or issues new group authority. */
class GroupRuntimeHost {
  constructor({ paths, registry, agent, ownerToken, runtimeToken, runner = null, workspaces = null, now = Date.now,
    tls = null, localWorkspace = null, worktreeSupported = false, readTerminalReceipt = null }) {
    if (!paths?.stateDir || !paths.trustedRoot || !p.exact(agent, ["backendId", "agentId"])
      || !["hermes", "openclaw"].includes(agent.backendId) || !p.id(agent.agentId)
      || !/^[A-Za-z0-9_-]{43,128}$/u.test(ownerToken ?? "") || !/^[A-Za-z0-9_-]{43,128}$/u.test(runtimeToken ?? "")
      || ownerToken === runtimeToken) p.fail("GROUP_HOST_CONFIG_INVALID");
    this.paths = paths; this.agent = agent; this.ownerToken = ownerToken; this.runtimeToken = runtimeToken;
    this.now = now; this.tls = tls; this.localWorkspace = localWorkspace; this.worktreeSupported = worktreeSupported;
    this.registry = registry; this.runner = runner; this.workspaces = workspaces || new GroupTaskWorkspaces({ root: path.join(paths.stateDir, "worktrees") });
    this.verifiedArtifacts = new Map(); this.sealing = new Map(); this.operations = new Map(); this.toolWaiters = new Map(); this.closed = false; this.pumping = false;
    this.runtimeRegistrations = new Map(); this.server = null; this.db = null; this.lease = null;
    this.readTerminalReceipt = readTerminalReceipt; this.receiptReads = new Map();
    this.groupCancellations = new Map();
  }
  open() {
    const file = path.join(this.paths.stateDir, "group-host.sqlite");
    preparePrivateParent(file, this.paths.trustedRoot);
    this.lease = acquirePrivateWriterLease({ lockPath: `${file}.writer.lock`, trustedRoot: this.paths.trustedRoot });
    try {
      this.db = openDatabase(file);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version !== 0 && version !== 1) p.fail("GROUP_HOST_STORE_INVALID");
      if (version === 0) transaction(this.db, () => this.db.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE owners(group_id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE executions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE calls(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE roles(digest TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE artifacts(execution_id TEXT NOT NULL,path TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,
          PRIMARY KEY(execution_id,path,digest)); PRAGMA user_version=1;`));
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") p.fail("GROUP_HOST_STORE_INVALID");
      this.hostId = this.db.prepare("SELECT value FROM meta WHERE key='hostId'").get()?.value;
      if (!this.hostId) {
        this.hostId = crypto.randomUUID(); this.db.prepare("INSERT INTO meta(key,value) VALUES('hostId',?)").run(this.hostId);
      }
      if (!p.uuid(this.hostId)) p.fail("GROUP_HOST_STORE_INVALID");
      if (!this.runner) this.runner = new ExternalInspirationRunner({ registry: this.registry,
        adapterOptions: { sessionPurpose: "group", prepareWorkspace: input => this.#prepareWorkspace(input) }, now: this.now,
        onSnapshot: (identity, snapshot) => this.#capture(identity, snapshot) });
      this.closed = false;
      return this;
    } catch (error) { this.db?.close(); this.db = null; this.lease.release(); this.lease = null; throw error; }
  }
  async #prepareWorkspace({ sessionId, workspace }) {
    const record = this.#execution(sessionId);
    if (!record || record.kind !== "task" || record.isolation || this.agent.backendId !== "hermes") return workspace;
    const repoRoot = await this.workspaces.repoRoot(workspace);
    if (!repoRoot) return workspace;
    record.isolation = await this.workspaces.create({ repoRoot, workspace, taskId: record.taskId });
    if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
    this.#writeExecution(record);
    return record.isolation.workspace;
  }
  #row(table, key, id) {
    const value = this.db.prepare(`SELECT data FROM ${table} WHERE ${key}=?`).get(id)?.data;
    return value ? JSON.parse(value) : null;
  }
  #put(table, key, id, value) {
    this.db.prepare(`INSERT INTO ${table}(${key},data) VALUES(?,?) ON CONFLICT(${key}) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(value));
  }
  #deviceIdentity() {
    const saved = this.db.prepare("SELECT value FROM meta WHERE key='deviceIdentity'").get()?.value;
    if (saved) return saved;
    let identity = "unknown-device";
    try {
      if (process.platform === "linux") identity = fs.readFileSync("/etc/machine-id", "utf8").trim();
      else if (process.platform === "darwin") identity = /"IOPlatformUUID" = "([A-F0-9-]+)"/u.exec(execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"],
        { timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8" }))?.[1] ?? identity;
    } catch { /* Unknown devices share conservative filesystem keys instead of gaining extra parallel writers. */ }
    const digest = crypto.createHash("sha256").update(identity).digest("hex");
    this.db.prepare("INSERT INTO meta(key,value) VALUES('deviceIdentity',?)").run(digest); return digest;
  }
  async #resource(record) {
    try {
      const workspace = record.isolation?.repoRoot ?? record.binding.workspace;
      const repository = await this.workspaces.repoRoot(workspace), root = fs.realpathSync(repository ?? workspace), stat = fs.statSync(root);
      const key = crypto.createHash("sha256").update(JSON.stringify([this.#deviceIdentity(), process.getuid?.() ?? null, stat.dev, stat.ino, root])).digest("hex");
      return { key, isolation: record.identity.backendId === "hermes" && Boolean(repository) };
    } catch { return null; }
  }
  #execution(id) { return this.#row("executions", "id", id); }
  #writeExecution(value) {
    const prior = this.#execution(value.identity.executionId);
    // Async content/seal/transport reads can finish after a terminal callback.
    if (EXTERNAL_TERMINAL.has(prior?.snapshot?.status)) value.snapshot = prior.snapshot;
    if (Object.hasOwn(prior ?? {}, "responseMetadata")) value.responseMetadata = prior.responseMetadata;
    this.#put("executions", "id", value.identity.executionId, value);
  }
  #owner(authority, renew = true) {
    if (!p.validAuthority(authority)) p.fail("GROUP_HOST_AUTHORITY_INVALID");
    const prior = this.#row("owners", "group_id", authority.groupId);
    if (prior && (prior.ownerId !== authority.ownerId || authority.epoch < prior.epoch)) p.fail("GROUP_HOST_OWNER_CHANGED");
    if (prior && !renew && (prior.epoch !== authority.epoch || prior.until <= this.now())) p.fail("GROUP_HOST_LEASE_EXPIRED");
    const next = { ...authority, ...(prior?.stopped ? { stopped: true } : {}), until: renew ? this.now() + LEASE_MS : prior?.until };
    if (renew) this.#put("owners", "group_id", authority.groupId, next);
    return next;
  }
  #current(record) {
    const owner = this.#row("owners", "group_id", record.groupId);
    if (!owner || owner.until <= this.now()) p.fail("GROUP_HOST_LEASE_EXPIRED");
    return owner;
  }
  #record(params, authority) {
    const record = this.#execution(params.executionId);
    if (!record || record.groupId !== authority.groupId || !same(record.identity, params, ["executionId", "runId", "backendId", "agentId"])
      || !same(record.binding, params, ["sessionKey", "workspace", "mode"])) p.fail("GROUP_HOST_BINDING_INVALID");
    return record;
  }
  #snapshot(record, value) {
    if (!record || !validExternalSnapshot(value) || !same(this.#bound(record), value, boundFields)) return false;
    record.snapshot = structuredClone(value);
    this.#writeExecution(record);
    return true;
  }
  #capture(identity, snapshot) {
    if (this.closed || !this.db) return;
    const record = this.#execution(identity.executionId);
    if (!record || !record.binding || !same(record.identity, identity, ["executionId", "runId", "backendId", "agentId"])) return;
    if (!this.#snapshot(record, snapshot)) return;
    snapshot = record.snapshot;
    if (snapshot.status === "completed") void this.#cacheResult(record).catch(() => {});
    if (EXTERNAL_TERMINAL.has(snapshot.status)) void this.#cacheMetadata(record).catch(() => {});
    if (EXTERNAL_TERMINAL.has(snapshot.status)) void this.#cacheResult(record, "progress").catch(() => {});
    if (EXTERNAL_TERMINAL.has(snapshot.status)) void this.#seal(record).catch(() => {});
    if (EXTERNAL_TERMINAL.has(snapshot.status)) void this.#pump().catch(() => {});
  }
  #bound(record) { return { ...record.identity, ...record.binding, hostId: record.runnerHostId }; }
  #stopGroupExecutions(groupId) {
    const records = this.db.prepare("SELECT data FROM executions").all().map(row => JSON.parse(row.data))
      .filter(record => record.groupId === groupId);
    for (const record of records) {
      if (EXTERNAL_TERMINAL.has(record.snapshot?.status)) {
        if (record.isolation && !record.isolation.sealed) void this.#seal(record).catch(() => {});
        continue;
      }
      if (!record.dispatchPossible) continue;
      const key = record.identity.executionId;
      if (!record.binding || this.groupCancellations.has(key)) continue;
      record.runnerHostId = this.runner.hostId; this.#writeExecution(record);
      const pending = Promise.resolve().then(() => this.runner.cancel({ ...this.#bound(record),
        operationId: `delete-${key}` }, { groupDeleted: true })).then(value => {
        if (this.closed) return;
        this.#snapshot(this.#execution(key), value.snapshot); void this.#pump();
      }).catch(() => {}).finally(() => this.groupCancellations.delete(key));
      this.groupCancellations.set(key, pending);
    }
    return records.filter(record => record.dispatchPossible && !EXTERNAL_TERMINAL.has(record.snapshot?.status)
      || record.isolation && !record.isolation.sealed).length;
  }
  async #recoverTerminal(record) {
    if (!this.readTerminalReceipt || !record.dispatchPossible || EXTERNAL_TERMINAL.has(record.snapshot?.status)
      || this.runner.records?.has(record.identity.executionId) && record.snapshot?.status !== "unknown") return;
    const key = record.identity.executionId, previous = this.receiptReads.get(key);
    if (previous?.pending) return previous.pending;
    if (previous?.after > this.now()) return;
    const owner = this.#row("owners", "group_id", record.groupId);
    if (!owner) return;
    const query = { groupId: record.groupId, ownerId: owner.ownerId, hostId: this.hostId, execution: this.#bound(record) };
    const state = { after: this.now() + 10_000, pending: null };
    state.pending = (async () => {
      let timer;
      try {
        const result = await Promise.race([Promise.resolve().then(() => this.readTerminalReceipt(query)), new Promise(resolve => {
          timer = setTimeout(() => resolve(null), 1500); timer.unref?.();
        })]);
        if (this.closed || !this.db || !validateGroupExecutionReceiptResult(result, query) || !result.receipt) return;
        const current = this.#execution(key), currentOwner = this.#row("owners", "group_id", record.groupId);
        if (!current || current.groupId !== record.groupId || !same(this.#bound(current), query.execution, boundFields)
          || currentOwner?.ownerId !== owner.ownerId || currentOwner.epoch !== owner.epoch
          || result.receipt.authority.epoch < currentOwner.epoch) return;
        this.#snapshot(current, { ...result.receipt.snapshot,
          sequence: Math.max(current.snapshot?.sequence ?? 0, result.receipt.snapshot.sequence) + 1 });
      } catch { /* No authoritative terminal receipt: keep the workspace occupied. */ }
      finally { clearTimeout(timer); state.pending = null; }
    })();
    this.receiptReads.set(key, state);
    return state.pending;
  }
  async #cacheResult(record, part = "answer") {
    const digestKey = part === "progress" ? "progressDigest" : "resultDigest";
    if (record[digestKey]) return;
    let offset = 0, digest = null, total = null; const chunks = [];
    do {
      const { page } = await this.runner.result({ ...this.#bound(record), offset, digest, ...(part === "progress" ? { part } : {}) });
      if (this.closed || !page || page.offset !== offset || (digest !== null && page.digest !== digest)
        || page.totalBytes > 32 * 1024 * 1024 || (total !== null && page.totalBytes !== total)) return;
      digest = page.digest; total = page.totalBytes; chunks.push(page.text); offset = page.nextOffset;
    } while (offset !== null);
    const text = chunks.join("");
    if (Buffer.byteLength(text) !== total || crypto.createHash("sha256").update(text).digest("hex") !== digest) return;
    const file = path.join(this.paths.stateDir, "results", digest);
    preparePrivateParent(file, this.paths.trustedRoot);
    if (!fs.existsSync(file)) atomicWritePrivateFile(file, text, { trustedRoot: this.paths.trustedRoot });
    if (this.closed) return;
    record = this.#execution(record.identity.executionId);
    record[digestKey] = digest; this.#writeExecution(record);
  }
  async #cacheMetadata(record) {
    if (Object.hasOwn(record, "responseMetadata") || !EXTERNAL_TERMINAL.has(record.snapshot?.status)) return;
    const result = await this.runner.metadata?.(this.#bound(record));
    if (this.closed || !result || result.hostId !== record.runnerHostId
      || !require("./external-inspiration-protocol").validateGroupExternalMetadataResult(result)) return;
    record = this.#execution(record.identity.executionId);
    if (!record || Object.hasOwn(record, "responseMetadata")) return;
    record.responseMetadata = structuredClone(result.responseMetadata); this.#writeExecution(record);
  }
  async #seal(record) {
    const key = record.identity.executionId;
    if (this.sealing.has(key)) return this.sealing.get(key);
    const operation = this.#sealOnce(record); this.sealing.set(key, operation);
    try { await operation; } finally { this.sealing.delete(key); }
  }
  async #sealOnce(record) {
    if (!record.isolation || record.isolation.sealed || this.closed) return;
    const sealed = await this.workspaces.seal(record.isolation, { memberName: record.identity.agentId, handle: record.identity.agentId,
      objective: `Group task ${record.taskId}` });
    if (this.closed) return;
    const current = this.#execution(record.identity.executionId);
    if (current?.isolation) { current.isolation = { ...current.isolation, sealed: true, ...sealed }; this.#writeExecution(current); }
  }
  async #prepare(params, authority, kind = "turn", taskId = null) {
    if (this.#current({ groupId: authority.groupId }).stopped) p.fail("GROUP_HOST_GROUP_STOPPED");
    if (params.backendId !== this.agent.backendId || params.agentId !== this.agent.agentId) p.fail("GROUP_HOST_AGENT_INVALID");
    const prior = this.#execution(params.executionId);
    const preparationFingerprint = p.fingerprint({ params, kind, taskId });
    if (prior) {
      if (prior.preparationFingerprint !== preparationFingerprint || prior.groupId !== authority.groupId) p.fail("GROUP_HOST_OPERATION_CONFLICT");
      if (!prior.binding) p.fail("GROUP_HOST_PREPARATION_PENDING");
      return { hostId: prior.runnerHostId, binding: prior.binding, isolation: prior.isolation ?? null, resource: prior.resource ?? null };
    }
    if (this.db.prepare("SELECT COUNT(*) AS n FROM executions").get().n >= 8192) p.fail("GROUP_HOST_CAPACITY");
    const record = { identity: Object.fromEntries(["executionId", "runId", "backendId", "agentId"].map(key => [key, params[key]])),
      groupId: authority.groupId, preparationFingerprint, binding: null, runnerHostId: null, kind, taskId,
      ...(Object.hasOwn(params, "modelSelection") ? { modelSelection: params.modelSelection } : {}),
      dispatchPossible: false, queued: false, snapshot: null, isolation: null, createdAt: this.now() };
    this.#writeExecution(record); // Preparation ambiguity is durable; a lost response cannot mint a second session.
    let execution = params;
    if (kind === "task" && this.localWorkspace && this.agent.backendId === "hermes") {
      const repoRoot = await this.workspaces.repoRoot(this.localWorkspace);
      if (repoRoot) {
        record.isolation = await this.workspaces.create({ repoRoot, workspace: this.localWorkspace, taskId });
        execution = { ...params, sessionKey: null, workspace: record.isolation.workspace };
        this.#writeExecution(record);
      }
    }
    const prepared = await this.runner.prepare(execution);
    if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
    record.isolation = this.#execution(params.executionId)?.isolation ?? record.isolation;
    record.binding = prepared.binding; record.runnerHostId = prepared.hostId;
    record.resource = await this.#resource(record);
    if (this.#current(record).stopped) {
      record.cancelRequested = true; record.queued = false;
      record.snapshot = { ...record.identity, ...record.binding, status: "canceled", sequence: 1,
        resultSummary: null, errorCode: null, finishedAt: this.now(), attention: null };
    }
    this.#writeExecution(record);
    return { ...prepared, isolation: record.isolation, resource: record.resource };
  }
  async #pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      let records = this.db.prepare("SELECT data FROM executions ORDER BY rowid").all().map(row => JSON.parse(row.data));
      const workspace = record => record.isolation?.workspace ?? record.binding?.workspace;
      const waiting = new Set(records.filter(record => record.queued && !record.dispatchPossible).map(workspace));
      const blocked = records.filter(record => waiting.has(workspace(record)) && record.dispatchPossible
        && !EXTERNAL_TERMINAL.has(record.snapshot?.status)
        && (!this.runner.records?.has(record.identity.executionId) || record.snapshot?.status === "unknown")
        && !(this.receiptReads.get(record.identity.executionId)?.after > this.now()));
      await Promise.all(blocked.slice(0, 16).map(record => this.#recoverTerminal(record)));
      if (this.closed) return;
      records = this.db.prepare("SELECT data FROM executions ORDER BY rowid").all().map(row => JSON.parse(row.data));
      const held = new Set(records.filter(record => record.dispatchPossible && !EXTERNAL_TERMINAL.has(record.snapshot?.status))
        .map(record => record.isolation ? record.isolation.workspace : record.binding?.workspace));
      for (let record of records.filter(record => record.queued && !record.dispatchPossible)) {
        let owner;
        try { owner = this.#current(record); } catch { continue; }
        if (owner.stopped || record.cancelRequested) continue;
        const key = record.isolation ? record.isolation.workspace : record.binding.workspace;
        if (held.has(key)) continue;
        if (this.runner.records && !this.runner.records.has(record.identity.executionId)) {
          try {
            const prepared = await this.runner.prepare({ ...record.identity, sessionKey: record.binding.sessionKey, workspace: record.binding.workspace,
              ...(Object.hasOwn(record, "modelSelection") ? { modelSelection: record.modelSelection } : {}),
              operationId: `recover-${record.identity.executionId}` });
            if (this.closed) return;
            record = this.#execution(record.identity.executionId);
            const currentOwner = this.#current(record);
            if (!record.queued || record.dispatchPossible || record.cancelRequested || currentOwner.stopped
              || currentOwner.ownerId !== owner.ownerId || currentOwner.epoch !== owner.epoch) continue;
            record.runnerHostId = prepared.hostId; record.startInput.hostId = prepared.hostId;
          } catch { continue; }
        }
        record.dispatchPossible = true; record.queued = false; this.#writeExecution(record);
        held.add(key);
        try {
          const result = await this.runner.start(record.startInput);
          if (this.closed) return;
          this.#snapshot(this.#execution(record.identity.executionId), result.snapshot);
        } catch { /* The persisted dispatch intent must be reconciled; never replay after a transport error. */ }
      }
    } finally { this.pumping = false; }
  }
  async #get(params, authority) {
    let record = this.#record(params, authority);
    if (!record.dispatchPossible) {
      await this.#pump();
      if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
      record = this.#record(params, authority);
    }
    if (!record.dispatchPossible) return { hostId: record.runnerHostId, snapshot: { ...record.identity, ...record.binding,
      status: "queued", ...(record.queued ? { dispatchState: "queued" } : {}), sequence: 0,
      resultSummary: null, errorCode: null, finishedAt: null, attention: null }, isolation: record.isolation, resource: record.resource ?? null };
    await this.#recoverTerminal(record);
    if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
    record = this.#record(params, authority);
    if (!EXTERNAL_TERMINAL.has(record.snapshot?.status)) {
      const result = await this.runner.get(this.#bound(record));
      if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
      record.runnerHostId = result.hostId; this.#snapshot(record, result.snapshot);
      record = this.#execution(params.executionId);
    }
    if (record.snapshot?.status === "completed") await this.#cacheResult(record);
    if (EXTERNAL_TERMINAL.has(record.snapshot?.status)) {
      await this.#cacheResult(record, "progress").catch(() => {});
      await this.#cacheMetadata(record).catch(() => {});
      await this.#seal(record); void this.#pump();
    }
    record = this.#execution(params.executionId);
    return { hostId: record.runnerHostId, snapshot: record.snapshot, isolation: record.isolation, resource: record.resource ?? null };
  }
  async #artifact(params, authority) {
    const record = this.#record(params.execution, authority);
    if (params.digest === null && params.offset !== 0) p.fail("GROUP_HOST_ARTIFACT_INVALID");
    let artifact = params.digest ? this.db.prepare("SELECT * FROM artifacts WHERE execution_id=? AND path=? AND digest=?")
      .get(record.identity.executionId, params.path, params.digest) : null;
    if (!artifact && params.digest !== null) return { artifact: null };
    if (!artifact) {
      let content, relative;
      const syntax = path;
      if (!p.text(params.path, 1024) || path.isAbsolute(params.path) || params.path.split(/[\\/]/u).some(part => part === "..")) p.fail("GROUP_HOST_ARTIFACT_INVALID");
      if (record.isolation?.sealed) {
        relative = params.path;
        content = await this.workspaces.readFile(record.isolation, relative);
      } else {
        const root = fs.realpathSync(record.binding.workspace);
        const target = fs.realpathSync(path.resolve(root, params.path));
        if (target === root || !target.startsWith(`${root}${syntax.sep}`)) p.fail("GROUP_HOST_ARTIFACT_INVALID");
        const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const before = fs.fstatSync(fd);
          if (!before.isFile() || before.size > MAX_ARTIFACT) p.fail("GROUP_HOST_ARTIFACT_INVALID");
          content = fs.readFileSync(fd);
          const after = fs.fstatSync(fd);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) p.fail("GROUP_HOST_ARTIFACT_CHANGED");
        } finally { fs.closeSync(fd); }
        relative = path.relative(root, target);
      }
      if (!content || content.length > MAX_ARTIFACT) return { artifact: null };
      const digest = crypto.createHash("sha256").update(content).digest("hex");
      const file = path.join(this.paths.stateDir, "artifacts", digest);
      preparePrivateParent(file, this.paths.trustedRoot);
      if (!fs.existsSync(file)) atomicWritePrivateFile(file, content, { trustedRoot: this.paths.trustedRoot });
      this.db.prepare("INSERT OR IGNORE INTO artifacts(execution_id,path,digest,bytes) VALUES(?,?,?,?)")
        .run(record.identity.executionId, relative, digest, content.length);
      artifact = { path: relative, digest, bytes: content.length };
    }
    if (params.offset > artifact.bytes) p.fail("GROUP_HOST_ARTIFACT_INVALID");
    const blob = path.join(this.paths.stateDir, "artifacts", artifact.digest);
    const stat = fs.lstatSync(blob), signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (this.verifiedArtifacts.get(artifact.digest) !== signature) {
      const content = readPrivateFile(blob, { maxBytes: MAX_ARTIFACT });
      if (content.length !== artifact.bytes || crypto.createHash("sha256").update(content).digest("hex") !== artifact.digest) p.fail("GROUP_HOST_ARTIFACT_CHANGED");
      if (this.verifiedArtifacts.size >= 128) this.verifiedArtifacts.delete(this.verifiedArtifacts.keys().next().value);
      this.verifiedArtifacts.set(artifact.digest, signature);
    }
    const end = Math.min(artifact.bytes, params.offset + ARTIFACT_PAGE), content = Buffer.alloc(end - params.offset);
    const fd = fs.openSync(blob, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || [opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs].join(":") !== signature) p.fail("GROUP_HOST_ARTIFACT_CHANGED");
      if (fs.readSync(fd, content, 0, content.length, params.offset) !== content.length) p.fail("GROUP_HOST_ARTIFACT_CHANGED");
      const after = fs.fstatSync(fd);
      if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":") !== signature) p.fail("GROUP_HOST_ARTIFACT_CHANGED");
    } finally { fs.closeSync(fd); }
    return { artifact: { path: artifact.path, digest: artifact.digest, bytes: artifact.bytes, offset: params.offset,
      nextOffset: end === artifact.bytes ? null : end, content: content.toString("base64") } };
  }
  async dispatch(frame) {
    if (this.closed || !this.db) p.fail("GROUP_HOST_UNAVAILABLE");
    if (!p.validHostRequest(frame)) p.fail("GROUP_HOST_REQUEST_INVALID");
    if (frame.hostId !== this.hostId) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
    const { method, params, authority } = frame;
    if (method === "host.models") {
      if (params.backendId !== this.agent.backendId || params.agentId !== this.agent.agentId) p.fail("GROUP_HOST_AGENT_INVALID");
      const catalog = await this.registry.getBackend(this.agent.backendId).getGroupMemberModels(this.agent.agentId);
      if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
      return require("./group-member-model").assertModelCatalog(catalog);
    }
    if (method === "host.member") {
      if (params.backendId !== this.agent.backendId || params.agentId !== this.agent.agentId) p.fail("GROUP_HOST_AGENT_INVALID");
      const backend = this.registry.getBackend(this.agent.backendId);
      const agent = await backend.getAgent(this.agent.agentId);
      const read = async file => { const value = await backend.getAgentFile(this.agent.agentId, file); return value?.missing ? null : value?.content ?? null; };
      const [identity, soul] = await Promise.all([this.agent.backendId === "hermes" ? Promise.resolve(null) : read("IDENTITY.md"), read("SOUL.md")]);
      const body = JSON.stringify({ identity, soul });
      if (Buffer.byteLength(body) > 16 * 1024 * 1024 || this.closed) p.fail("GROUP_HOST_RESPONSE_INVALID");
      const digest = crypto.createHash("sha256").update(body).digest("hex");
      const rows = this.db.prepare("SELECT SUM(length(CAST(body AS BLOB))) AS bytes FROM roles").get().bytes ?? 0;
      if (rows > 64 * 1024 * 1024) this.db.prepare("DELETE FROM roles WHERE digest IN (SELECT digest FROM roles ORDER BY rowid LIMIT 16)").run();
      this.db.prepare("INSERT OR IGNORE INTO roles(digest,body) VALUES(?,?)").run(digest, body);
      return { agent: { id: this.agent.agentId, name: agent.name || this.agent.agentId, model: agent.model ?? null }, document: { digest, bytes: Buffer.byteLength(body) } };
    }
    if (method === "host.role") {
      const body = this.db.prepare("SELECT body FROM roles WHERE digest=?").get(params.digest)?.body;
      if (!body) p.fail("GROUP_HOST_ROLE_EXPIRED");
      return { page: resultPage(body, { offset: params.offset, digest: params.digest }) };
    }
    if (method === "host.capabilities") {
      if (params.backendId !== this.agent.backendId || params.agentId !== this.agent.agentId) p.fail("GROUP_HOST_AGENT_INVALID");
      const registrations = [...this.runtimeRegistrations.values()].filter(value => value.until > this.now());
      const groupTools = registrations.length > 0;
      const collaborationActions = registrations.some(value => value.protocolVersion === 2 && value.tools.includes("group_collaborate"));
      const base = await this.runner.capabilities?.(params) ?? {};
      const capabilities = require("./agent-service/group-capabilities").groupCapabilities({ ...base,
        groupTools, collaborationActions, protocolVersion: 2, artifacts: true,
        formalTasks: base.formalTasks === true && groupTools });
      return { version: frame.version, hostId: this.hostId, ...this.agent, groupTools,
        workspaces: capabilities.workspaces, artifacts: true, ...(frame.version === p.VERSION ? { capabilities } : {}) };
    }
    const owner = this.#owner(authority);
    if (method === "host.group.stop") {
      // Persist the group fence and every queued cancellation together. A
      // terminal callback may wake other groups, but cannot dispatch this one.
      transaction(this.db, () => {
        this.#put("owners", "group_id", authority.groupId, { ...owner, stopped: true });
        for (const row of this.db.prepare("SELECT data FROM executions").all()) {
          const record = JSON.parse(row.data);
          if (record.groupId !== authority.groupId || EXTERNAL_TERMINAL.has(record.snapshot?.status)) continue;
          record.cancelRequested = true; record.queued = false; record.grantDigest = null;
          if (!record.dispatchPossible && record.binding) {
            record.dispatchPossible = true;
            record.snapshot = { ...record.identity, ...record.binding, status: "canceled", sequence: 1,
              resultSummary: null, errorCode: null, finishedAt: this.now(), attention: null };
          }
          this.#writeExecution(record);
        }
      });
      return { stopped: true, pending: this.#stopGroupExecutions(authority.groupId) };
    }
    if (owner.stopped && ["host.prepare", "group.external.prepare", "group.external.start", "host.authority.transfer"].includes(method)) {
      p.fail("GROUP_HOST_GROUP_STOPPED");
    }
    if (method === "host.authority.transfer") {
      this.#put("owners", "group_id", authority.groupId, { groupId: authority.groupId, ownerId: params.ownerId, epoch: params.epoch, until: this.now() + LEASE_MS });
      return { transferred: true };
    }
    if (method === "host.prepare") return this.#prepare(params.execution, authority, params.kind, params.taskId);
    if (method === "host.tools.next") {
      if (owner.stopped) return { calls: [] };
      const calls = this.db.prepare("SELECT data FROM calls ORDER BY rowid").all().map(row => JSON.parse(row.data))
        .filter(call => call.groupId === authority.groupId && !call.result).slice(0, 8);
      return { calls: calls.map(({ groupId: _g, result: _r, ...call }) => call) };
    }
    if (method === "host.tools.result") {
      const call = this.#row("calls", "id", params.callId);
      if (!call || call.groupId !== authority.groupId || call.fingerprint !== params.fingerprint) p.fail("GROUP_HOST_BINDING_INVALID");
      if (call.result && p.fingerprint(call.result) !== p.fingerprint(params.result)) p.fail("GROUP_HOST_OPERATION_CONFLICT");
      call.result = params.result; this.#put("calls", "id", call.callId, call); this.toolWaiters.get(call.callId)?.();
      return { accepted: true };
    }
    if (method === "host.artifact") return this.#artifact(params, authority);
    if (method === "group.external.prepare") {
      const value = await this.#prepare(params, authority); const { isolation: _i, resource: _r, ...plain } = value; return plain;
    }
    let record = this.#record(params, authority);
    if (method === "group.external.start") {
      const fingerprint = p.fingerprint({ ...params, hostId: null });
      if (record.startFingerprint && record.startFingerprint !== fingerprint) p.fail("GROUP_HOST_OPERATION_CONFLICT");
      if (!record.startFingerprint) {
        const token = /gt1\.[tk]\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/u.exec(params.prompt)?.[0];
        record.grantDigest = token ? p.fingerprint(token) : null;
        record.startFingerprint = fingerprint; record.startInput = { ...params, hostId: record.runnerHostId };
        record.queued = true; this.#writeExecution(record); void this.#pump();
      }
      const value = await this.#get(params, authority); const { isolation: _i, resource: _r, ...plain } = value; return plain;
    }
    if (method === "group.external.get") {
      void this.#pump(); const value = await this.#get(params, authority); const { isolation: _i, resource: _r, ...plain } = value; return plain;
    }
    if (method === "host.execution") return this.#get(params, authority);
    if (method === "group.external.metadata") {
      await this.#cacheMetadata(record).catch(() => {});
      record = this.#record(params, authority);
      return { hostId: record.runnerHostId, responseMetadata: record.responseMetadata ?? null };
    }
    const resultDigest = params.part === "progress" ? record.progressDigest : record.resultDigest;
    if (method === "group.external.result" && resultDigest) {
      const text = readPrivateFile(path.join(this.paths.stateDir, "results", resultDigest), { maxBytes: 32 * 1024 * 1024 }).toString("utf8");
      if (crypto.createHash("sha256").update(text).digest("hex") !== resultDigest) p.fail("GROUP_HOST_STORE_INVALID");
      return { hostId: record.runnerHostId, page: resultPage(text, params) };
    }
    if (method === "group.external.cancel" && !record.dispatchPossible) {
      record.queued = false; record.dispatchPossible = true;
      record.snapshot = { ...record.identity, ...record.binding, status: "canceled", sequence: 1, resultSummary: null,
        errorCode: null, finishedAt: this.now(), attention: null }; this.#writeExecution(record);
      await this.#seal(record); void this.#pump(); return { hostId: record.runnerHostId, snapshot: record.snapshot };
    }
    if (method === "group.external.cancel" && EXTERNAL_TERMINAL.has(record.snapshot?.status)) {
      void this.#pump(); return { hostId: record.runnerHostId, snapshot: record.snapshot };
    }
    if (method === "group.external.cancel" && owner.stopped && this.groupCancellations.has(record.identity.executionId)) {
      await this.groupCancellations.get(record.identity.executionId);
      record = this.#execution(record.identity.executionId);
      return { hostId: record.runnerHostId, snapshot: record.snapshot };
    }
    const action = method.split(".").at(-1);
    const value = await this.runner[action]({ ...params, hostId: record.runnerHostId },
      method === "group.external.cancel" ? { groupDeleted: owner.stopped === true } : undefined);
    if (method === "group.external.result") return { ...value, hostId: record.runnerHostId };
    if (value.snapshot) this.#snapshot(record, value.snapshot);
    return value;
  }
  /** Only the separate runtime credential can enqueue an MCP call. It cannot prepare, start or acquire authority. */
  async runtimeCall({ agentId, callId, name, arguments: args }) {
    if (agentId !== this.agent.agentId || !p.id(callId) || !validateGroupMcpArguments(name, args)
      || !Object.hasOwn(args, "groupToken")) p.fail("GROUP_HOST_TOOL_INVALID");
    if (name === "group_collaborate" && ![...this.runtimeRegistrations.values()].some(value => value.until > this.now()
      && value.protocolVersion === 2 && value.tools.includes(name))) p.fail("GROUP_HOST_TOOL_UNSUPPORTED");
    const records = this.db.prepare("SELECT data FROM executions").all().map(row => JSON.parse(row.data));
    const record = records.find(value => value.grantDigest === p.fingerprint(args.groupToken));
    if (!record || !record.dispatchPossible || EXTERNAL_TERMINAL.has(record.snapshot?.status)) p.fail("GROUP_HOST_GRANT_REVOKED");
    if (this.#current(record).stopped) p.fail("GROUP_HOST_GRANT_REVOKED");
    const scopedId = crypto.createHash("sha256").update(`${record.identity.executionId}\0${callId}`).digest("hex");
    const call = { callId: scopedId, execution: this.#bound(record), name, arguments: args };
    call.fingerprint = p.fingerprint({ ...call, execution: { ...call.execution, hostId: null } });
    const prior = this.#row("calls", "id", scopedId);
    if (prior && prior.fingerprint !== call.fingerprint) p.fail("GROUP_HOST_OPERATION_CONFLICT");
    if (!prior && this.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n >= 32_768) p.fail("GROUP_HOST_CAPACITY");
    if (!prior) this.#put("calls", "id", scopedId, { ...call, groupId: record.groupId, result: null });
    const started = this.now();
    while (!this.closed && this.now() - started < 60_000) {
      if (this.#current(record).stopped) p.fail("GROUP_HOST_GRANT_REVOKED");
      const current = this.#row("calls", "id", scopedId);
      if (current.result) { this.toolWaiters.delete(scopedId); return structuredClone(current.result); }
      await new Promise(resolve => { const timer = setTimeout(resolve, 500); this.toolWaiters.set(scopedId, () => { clearTimeout(timer); resolve(); }); });
    }
    p.fail("GROUP_HOST_TOOL_PENDING");
  }
  async listen({ host = "127.0.0.1", port = 0 } = {}) {
    if (this.server || (!this.tls && !["127.0.0.1", "::1"].includes(host))) p.fail("GROUP_HOST_LISTEN_INVALID");
    const handle = async (req, res) => {
      const rpc = req.url === "/group-host/rpc";
      const mcp = req.url === "/group-host/runtime";
      if (req.method !== "POST" || (!rpc && !mcp) || !equalSecret(req.headers.authorization,
        `Bearer ${rpc ? this.ownerToken : this.runtimeToken}`)) { res.writeHead(401); res.end(); return; }
      let size = 0; const chunks = [];
      try {
        for await (const chunk of req) { size += chunk.length; if (size > p.FRAME_BYTES) p.fail("GROUP_HOST_REQUEST_INVALID"); chunks.push(chunk); }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let result;
        if (rpc) result = await this.dispatch(value);
        else if ((p.exact(value, ["agentId", "register", "instanceId"]) || p.exact(value, ["agentId", "register", "instanceId", "protocolVersion", "tools"])
          && value.protocolVersion === 2 && Array.isArray(value.tools) && value.tools.length <= 16
          && value.tools.every(name => typeof name === "string" && require("./agent-service/group-mcp-tools").isGroupMcpTool(name)))
          && value.agentId === this.agent.agentId && typeof value.register === "boolean" && p.uuid(value.instanceId)) {
          if (value.register) {
            for (const [key, registration] of this.runtimeRegistrations) if (registration.until <= this.now()) this.runtimeRegistrations.delete(key);
            if (this.runtimeRegistrations.size >= 128) p.fail("GROUP_HOST_CAPACITY");
            this.runtimeRegistrations.set(value.instanceId, { until: this.now() + 150_000,
              protocolVersion: value.protocolVersion ?? 1, tools: value.tools ?? [] });
          } else this.runtimeRegistrations.delete(value.instanceId);
          result = { registered: value.register, hostId: this.hostId, ...(value.protocolVersion === 2
            ? { protocolVersion: 2, tools: value.tools } : {}) };
        } else result = await this.runtimeCall(value);
        const reply = rpc ? { version: value.version, id: value.id, hostId: this.hostId, ok: true, result } : { ok: true, result };
        const body = JSON.stringify(reply);
        if (Buffer.byteLength(body) > p.FRAME_BYTES) p.fail("GROUP_HOST_RESPONSE_INVALID");
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(body);
      } catch (error) {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const code = /^GROUP_HOST_[A-Z_]+$/u.test(error?.code ?? "") || require("./group-member-model").isModelError(error?.code)
          ? error.code : "GROUP_HOST_UNAVAILABLE";
        const reply = rpc ? { version: [1, p.VERSION].includes(value?.version) ? value.version : p.VERSION,
          id: value?.id ?? null, hostId: this.hostId, ok: false, error: { code } } : { ok: false, error: { code } };
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(reply));
      }
    };
    this.server = this.tls ? https.createServer(this.tls, handle) : http.createServer(handle);
    this.server.requestTimeout = 90_000; this.server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, resolve); });
    return { hostId: this.hostId, port: this.server.address().port };
  }
  async close() {
    this.closed = true;
    this.runner?.reset?.();
    for (const wake of this.toolWaiters.values()) wake(); this.toolWaiters.clear();
    if (this.server) { const server = this.server; this.server = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try { this.db?.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db?.close(); this.db = null; this.lease?.release(); this.lease = null; }
  }
}

module.exports = { GroupRuntimeHost, LEASE_MS, ARTIFACT_PAGE };
