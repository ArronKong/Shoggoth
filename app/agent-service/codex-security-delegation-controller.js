"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CodexRuntimeAdapter } = require("./codex-runtime-adapter");
const { CodexRuntimePool } = require("./codex-runtime-pool");
const { CodexRuntimeHost } = require("./codex-runtime-host");
const { CODEX_APP_SERVER_ARGS } = require("./codex-runtime-paths");
const { isCodexSchemaContract, validateSchemaValue } = require("./codex-schema-contract");
const { HostCapabilityIssuer } = require("./host-capability-issuer");
const { CodexSecurityServicePreflight } = require("./codex-security-service-preflight");
const { PluginRuntimeToolService } = require("./plugin-runtime-tool-service");
const { RuntimeSessionOwnershipStore } = require("./runtime-session-ownership-store");
const { runtimeBinding, runtimeSessionRef } = require("./runtime-adapter");
const { ACTIVE_WORK_RUN_STATUSES, canonicalWorkspace } = require("./work-run");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");
const { atomicWritePrivateFile, preparePrivateParent, readPrivateFile,
  recoverInterruptedPrivateFile, statIfExists } = require("./private-file");

const POLICY = Object.freeze({ approvalPolicy: "never", sandbox: "read-only" });
const LIVE_CONTROLLERS = new Map();
const STATES = new Set(["prepared", "starting", "ready", "releasing", "released", "failed", "needs_verification"]);
const MAX_RECORDS = 256;
const MAX_BYTES = 2 * 1024 * 1024;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (code, message) => serviceError(`CODEX_SECURITY_DELEGATION_${code}`, message);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && value.isWellFormed() && !value.includes("\0");
const OWNER_FIELDS = ["runId", "profileId", "bindingId", "runtime", "runtimeProfileId", "runtimeAccountId",
  "attemptId", "workspace", "contextSnapshotId"];
const RECORD_FIELDS = ["operationId", "owner", "targetBinding", "pluginContextDigest", "state", "sessionId", "unsubscribeStatus", "createdAt", "updatedAt"];
const ENV_FIELDS = new Set(["HOME", "PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LANG", "LC_ALL"]);

function contained(root, value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const relative = path.relative(root, value);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Service-only, credentialless lifecycle prerequisite. It deliberately has no
// model/scan/tool API. A genuine native thread is not a genuine native turn.
class CodexSecurityDelegationController {
  #records = new Map();
  #pending = new Map();
  #releases = new Map();
  #fileIdentity = null;
  #handles = new Map();
  #opened = false;
  #closing = false;
  #uncertain = false;
  #revision = 0;

  constructor({ paths, dispatcher, productStore, runtimeManager, ownershipStore,
    capabilityIssuer, pluginRuntimeToolService, targetBindingForOwner, owningAgentAdmission = null, managedHomeRoot, now = Date.now } = {}) {
    if (!paths?.pluginDataDir || !paths.trustedRoot || typeof dispatcher?.getRun !== "function"
      || typeof productStore?.resolveAgentRuntimeProfile !== "function"
      || !(runtimeManager instanceof CodexRuntimeAdapter)
      || !(runtimeManager.runtimePool instanceof CodexRuntimePool)
      || !(ownershipStore instanceof RuntimeSessionOwnershipStore)
      || !(capabilityIssuer instanceof HostCapabilityIssuer)
      || !(pluginRuntimeToolService instanceof PluginRuntimeToolService)
      || (owningAgentAdmission !== null && !(owningAgentAdmission instanceof CodexSecurityServicePreflight))
      || (owningAgentAdmission === null && typeof targetBindingForOwner !== "function")
      || typeof managedHomeRoot !== "string" || !path.isAbsolute(managedHomeRoot)) {
      throw new TypeError("Codex Security delegation requires trusted Service authorities");
    }
    const poolOptions = runtimeManager.runtimePool.options;
    if (poolOptions.nativeAuth || poolOptions.hostOptions?.nativeAuth || poolOptions.hostOptions?.prepareRuntime) {
      throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "生命周期前置不能使用账号认证或 Provider 准备器");
    }
    this.paths = paths; this.dispatcher = dispatcher; this.productStore = productStore;
    this.runtimeManager = runtimeManager; this.ownershipStore = ownershipStore;
    this.capabilityIssuer = capabilityIssuer; this.pluginRuntimeToolService = pluginRuntimeToolService;
    this.owningAgentAdmission = owningAgentAdmission;
    this.targetBindingForOwner = owningAgentAdmission ? owner => owningAgentAdmission.bindingForOwner(owner) : targetBindingForOwner; this.managedHomeRoot = path.resolve(managedHomeRoot);
    this.now = now; this.recordPath = path.join(paths.pluginDataDir, "codex-security-delegation", "lifecycle-v1.json");
  }

  open() {
    if (this.#opened) return this;
    if (LIVE_CONTROLLERS.has(this.recordPath)) throw error("STORE_IN_USE", "同一 Service 只能有一个生命周期 controller");
    preparePrivateParent(this.recordPath, this.paths.trustedRoot);
    ensurePrivateDirectoryTree(this.managedHomeRoot, this.paths.trustedRoot);
    const recovery = recoverInterruptedPrivateFile(this.recordPath, { trustedRoot: this.paths.trustedRoot });
    if (recovery === "uncertain") throw error("STORE_UNCERTAIN", "生命周期记录提交状态不确定");
    if (statIfExists(fs, this.recordPath)) {
      let state;
      try { state = JSON.parse(readPrivateFile(this.recordPath, { maxBytes: MAX_BYTES })); }
      catch (cause) { throw error("STORE_CORRUPT", `生命周期记录无法读取 (${cause.code || "JSON"})`); }
      if (!exact(state, ["version", "revision", "records", "checksum"]) || state.version !== 1
        || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.records)
        || state.records.length > MAX_RECORDS
        || state.checksum !== digest({ version: state.version, revision: state.revision, records: state.records })) {
        throw error("STORE_CORRUPT", "生命周期记录校验失败");
      }
      for (const record of state.records) {
        this.#validateRecord(record);
        if (this.#records.has(record.operationId)) throw error("STORE_CORRUPT", "重复生命周期操作");
        this.#records.set(record.operationId, Object.freeze(structuredClone(record)));
      }
      this.#revision = state.revision;
      this.#fileIdentity = this.#identity(statIfExists(fs, this.recordPath));
    }
    this.#opened = true;
    LIVE_CONTROLLERS.set(this.recordPath, this);
    // A crash may have lost a native ACK. Recovery is observation, never a new
    // thread/start. Even prepared records require a fresh explicit operation.
    for (const record of [...this.#records.values()]) {
      if (["prepared", "starting", "releasing"].includes(record.state)) {
        this.#save({ ...record, state: "needs_verification", updatedAt: this.#time() });
      }
    }
    return this;
  }

  async prepare(request, lease) {
    this.#assertOpen();
    const operationId = this.#operationId(request);
    const owner = this.#owner(lease);
    const run = this.dispatcher.getRun(owner.runId);
    const pluginContextDigest = this.#contextDigest(run);
    const targetBinding = runtimeBinding(this.targetBindingForOwner(owner));
    if (targetBinding.runtime !== "codex" || targetBinding.runtimeProfileId === owner.runtimeProfileId) {
      throw error("TARGET_INVALID", "受管线程需要独立的 Codex Runtime binding");
    }
    const existing = this.#records.get(operationId);
    if (existing) {
      this.#sameOwner(existing, owner);
      if (digest(existing.targetBinding) !== digest(targetBinding)
        || existing.pluginContextDigest !== pluginContextDigest) throw error("CONFLICT", "操作已绑定其他 Runtime 或插件上下文");
      if (this.#pending.has(operationId)) {
        await this.#pending.get(operationId); this.#sameOwner(existing, this.#owner(lease));
        return this.#receipt(this.#records.get(operationId));
      }
      if (existing.state === "ready") return this.inspect(request, lease);
      if (existing.state === "released") return this.#receipt(existing);
      throw error("VERIFICATION_REQUIRED", "原操作未确认，不会再次创建线程");
    }
    if (this.#records.size >= MAX_RECORDS) throw error("CAPACITY", "生命周期记录达到容量限制");
    const time = this.#time();
    const record = this.#save({ operationId, owner, targetBinding, pluginContextDigest,
      state: "prepared", sessionId: null, unsubscribeStatus: null, createdAt: time, updatedAt: time });
    const pending = this.#create(record, lease);
    this.#pending.set(operationId, pending);
    try { return await pending; }
    finally { if (this.#pending.get(operationId) === pending) this.#pending.delete(operationId); }
  }

  async inspect(request, lease) {
    this.#assertOpen();
    const record = this.#recordFor(request, lease);
    if (record.state !== "ready") return this.#receipt(record);
    const handle = await this.#acquire(record);
    this.#sameOwner(record, this.#owner(lease));
    this.#assertOwned(record);
    const response = await handle.sessionRead({ sessionId: record.sessionId, includeTurns: false });
    this.#sameOwner(record, this.#owner(lease));
    this.#assertOwned(record); this.#validateSession(response, record);
    return this.#receipt(record);
  }

  async release(request, lease) {
    this.#assertOpen();
    const record = this.#recordFor(request, lease);
    const pending = this.#pending.get(record.operationId);
    if (pending) await pending;
    this.#sameOwner(record, this.#owner(lease));
    let releasing = this.#releases.get(record.operationId);
    if (!releasing) {
      releasing = this.#release(this.#records.get(record.operationId), () => this.#sameOwner(record, this.#owner(lease)));
      this.#releases.set(record.operationId, releasing);
    }
    try {
      const receipt = await releasing;
      this.#sameOwner(record, this.#owner(lease));
      return receipt;
    } finally { if (this.#releases.get(record.operationId) === releasing) this.#releases.delete(record.operationId); }
  }

  // Only Service shutdown calls this. Cleanup can outlive a revoked lease, but
  // can only unsubscribe the exact thread this controller already owns. It neither
  // turns a model nor stops a RuntimePool shared by other work.
  async close() {
    if (!this.#opened) return;
    this.#closing = true;
    await Promise.allSettled([...this.#pending.values(), ...this.#releases.values()]);
    const results = await Promise.allSettled([...this.#records.values()]
      .filter(record => record.sessionId && record.state !== "released")
      .map(record => this.#release(record)));
    this.#handles.clear(); this.#opened = false;
    if (LIVE_CONTROLLERS.get(this.recordPath) === this) LIVE_CONTROLLERS.delete(this.recordPath);
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "受管线程清理未完全确认");
  }

  #owner(lease) {
    if (this.#closing) throw error("CLOSED", "生命周期前置已关闭");
    const identity = this.capabilityIssuer.assert(lease, { kind: "mcp" });
    const run = this.dispatcher.getRun(identity.runId);
    if (!run || !ACTIVE_WORK_RUN_STATUSES.has(run.status) || run.profileId !== identity.profileId
      || !run.workspace || canonicalWorkspace(run.workspace) !== run.workspace
      || run.workspace !== identity.workspace) throw error("OWNER_INVALID", "执行 Run 或 workspace 归属已失效");
    const profile = this.productStore.resolveAgentRuntimeProfile(identity.profileId, identity.bindingId);
    if (!profile.enabled || profile.runtime !== identity.runtime || profile.runtimeAccountId !== identity.runtimeAccountId) {
      throw error("OWNER_INVALID", "Agent Runtime binding 归属已失效");
    }
    const owner = Object.freeze({ runId: run.id, profileId: run.profileId,
      bindingId: identity.bindingId, runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, attemptId: identity.attemptId,
      workspace: run.workspace, contextSnapshotId: run.contextSnapshotId });
    this.capabilityIssuer.assert(lease, { kind: "mcp", identity: {
      runId: owner.runId, profileId: owner.profileId, bindingId: owner.bindingId,
      runtime: owner.runtime, runtimeAccountId: owner.runtimeAccountId, attemptId: owner.attemptId } });
    this.owningAgentAdmission?.assertOwner(owner, lease);
    return owner;
  }

  #contextDigest(run) {
    // Keep the admitted PluginContext reference, not user prompts or a new
    // tool grant. No frozen scanner tools are added by this lifecycle code.
    return digest({ contextSnapshotId: run.contextSnapshotId,
      admittedTools: this.pluginRuntimeToolService.skillToolProjectionForRun(run) });
  }

  async #acquire(record) {
    let handle = this.#handles.get(record.operationId);
    if (!handle) {
      // Fail before native initialization can load a pre-existing MCP/provider
      // config. Pool/Resolver are trusted Service dependencies; callers cannot
      // provide environments or account identities.
      const pool = this.runtimeManager.runtimePool;
      const environment = pool.runtimeAccountResolver.resolve(record.targetBinding,
        pool.runtimeAccountLookup(record.targetBinding.runtimeAccountId), {
          binaryPath: pool.options.binaryPath, repoRoot: pool.options.repoRoot ?? pool.options.hostOptions?.repoRoot,
          packaged: pool.options.packaged ?? pool.options.hostOptions?.packaged,
          resourcesPath: pool.options.resourcesPath ?? pool.options.hostOptions?.resourcesPath });
      this.#assertEnvironment(environment);
      if (Object.keys(pool.options.parentEnv || {}).some(key => !ENV_FIELDS.has(key))) {
        throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "RuntimePool 不能继承认证环境");
      }
      handle = await this.runtimeManager.acquire(record.targetBinding, { permissionPolicy: POLICY });
      this.#assertCredentialless(handle, record.targetBinding);
      this.#handles.set(record.operationId, handle);
    } else this.#assertCredentialless(handle, record.targetBinding);
    return handle;
  }

  #assertCredentialless(handle, binding) {
    const host = handle.host;
    const environment = host?.runtimeEnvironment;
    if (!(host instanceof CodexRuntimeHost) || digest(host.binding) !== digest(binding)
      || host.nativeAuth || host.options.prepareRuntime || host.options.spawnEnv
      || host.registeredSecrets.length
      || Object.keys(host.options.parentEnv || {}).some(key => !ENV_FIELDS.has(key))
      || Object.entries(host.options.parentEnv || {}).some(([key, value]) => ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)
        && !contained(this.managedHomeRoot, value))) {
      throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "Runtime 必须使用独立空 HOME，不继承认证或 Provider");
    }
    this.#assertEnvironment(environment);
  }

  #assertEnvironment(environment) {
    if (!Object.isFrozen(environment) || environment?.kind !== "shoggoth-managed"
      || environment.nativeHome !== null || environment.integrationRoot !== null
      || !contained(this.managedHomeRoot, environment.home)
      || !contained(this.managedHomeRoot, environment.spawnEnv?.HOME)
      || environment.spawnEnv.CODEX_HOME !== environment.home
      || !Object.isFrozen(environment.spawnEnv)
      || Object.keys(environment.spawnEnv).some(key => !["HOME", "CODEX_HOME"].includes(key))
      || JSON.stringify(environment.launchArgs) !== JSON.stringify(CODEX_APP_SERVER_ARGS)) {
      throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "生命周期 Runtime 必须使用独立固定 HOME 和原生 app-server 参数");
    }
    for (const directory of [environment.home, environment.spawnEnv.HOME]) {
      ensurePrivateDirectoryTree(directory, this.paths.trustedRoot);
      if (fs.realpathSync(directory) !== directory) throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "HOME 路径不是固定私有目录");
      if (statIfExists(fs, path.join(directory, "auth.json"))) throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "生命周期 HOME 不得有认证文件");
    }
    const config = statIfExists(fs, path.join(environment.home, "config.toml"));
    if (config && (!config.isFile() || config.size !== 0)) throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "生命周期 HOME 不得加载已有 MCP 或 Provider 配置");
  }

  async #create(record, lease) {
    let submitted = false;
    try {
      const handle = await this.#acquire(record);
      this.#sameOwner(record, this.#owner(lease));
      const account = await handle.accountRead({ refreshToken: false });
      this.#sameOwner(record, this.#owner(lease));
      if (account?.account !== null || account.requiresOpenaiAuth !== true) {
        throw error("CREDENTIALLESS_RUNTIME_REQUIRED", "生命周期验收需要未认证的真实 Codex Runtime");
      }
      record = this.#save({ ...record, state: "starting", updatedAt: this.#time() });
      submitted = true;
      const response = await handle.sessionStart({ persistent: true, cwd: record.owner.workspace, permissionPolicy: POLICY });
      const sessionId = response?.session?.id;
      if (!text(sessionId)) throw error("NATIVE_RESPONSE_INVALID", "原生线程未返回有效 ID");
      // Persist the native ID before the next await or lease fence. If a caller
      // is canceled now, shutdown can still unsubscribe this exact owning thread.
      record = this.#save({ ...record, sessionId, state: "needs_verification", updatedAt: this.#time() });
      this.#validateSession(response, record);
      this.ownershipStore.claim({ ...record.targetBinding, sessionId, profileId: record.owner.profileId, workspace: record.owner.workspace });
      this.#sameOwner(record, this.#owner(lease));
      this.#assertOwned(record);
      const read = await handle.sessionRead({ sessionId, includeTurns: false });
      this.#sameOwner(record, this.#owner(lease));
      this.#assertOwned(record); this.#validateSession(read, record);
      record = this.#save({ ...record, state: "ready", updatedAt: this.#time() });
      return this.#receipt(record);
    } catch (cause) {
      const current = this.#records.get(record.operationId);
      if (!this.#uncertain) this.#save({ ...current,
        state: submitted ? "needs_verification" : "failed", updatedAt: this.#time() });
      throw cause;
    }
  }

  #validateSession(response, record) {
    const session = response?.session;
    if (session?.id !== record.sessionId || session.cwd !== record.owner.workspace
      || session.ephemeral !== false || !Array.isArray(session.turns) || session.turns.length !== 0) {
      throw error("NATIVE_RESPONSE_INVALID", "真实线程 ID、workspace 或空 turn 状态不符合生命周期边界");
    }
  }

  #assertOwned(record) {
    const ownership = this.ownershipStore.assertOwned({ binding: record.targetBinding,
      profileId: record.owner.profileId, sessionId: record.sessionId, workspace: record.owner.workspace });
    if (ownership.status !== "active") throw error("OWNER_INVALID", "受管线程不再处于当前归属");
  }

  async #release(record, assertCurrent = () => {}) {
    if (record.state === "released") return this.#receipt(record);
    if (!record.sessionId) throw error("VERIFICATION_REQUIRED", "未知原生线程 ID，必须保留观察状态");
    this.#assertOwned(record);
    const handle = await this.#acquire(record);
    assertCurrent(); this.#assertOwned(record);
    record = this.#save({ ...record, state: "releasing", updatedAt: this.#time() });
    try {
      const unsubscribed = await this.#unsubscribe(handle, record.sessionId);
      // Native unsubscribe releases this connection only. The thread remains
      // loaded until Codex idle eviction; it is neither archived nor deleted.
      this.ownershipStore.touch({ binding: record.targetBinding, profileId: record.owner.profileId,
        sessionId: record.sessionId, workspace: record.owner.workspace });
      record = this.#save({ ...record, state: "released", unsubscribeStatus: unsubscribed.status, updatedAt: this.#time() });
    } catch (cause) {
      if (!this.#uncertain) this.#save({ ...record, state: "needs_verification", updatedAt: this.#time() });
      throw cause;
    }
    assertCurrent();
    return this.#receipt(record);
  }

  async #unsubscribe(handle, sessionId) {
    const host = handle.host;
    host._assertReady();
    const contract = host.schemaContract;
    const schema = contract?.v2Schema;
    const method = "thread/unsubscribe";
    const variants = schema?.definitions?.ClientRequest?.oneOf;
    const match = variants?.filter(variant => variant.properties?.method?.enum?.length === 1
      && variant.properties.method.enum[0] === method
      && variant.properties?.params?.$ref === "#/definitions/ThreadUnsubscribeParams");
    const params = Object.freeze({ threadId: sessionId });
    if (!isCodexSchemaContract(contract) || contract.version !== "0.159.2" || match?.length !== 1
      || !schema.definitions.ThreadUnsubscribeParams || !schema.definitions.ThreadUnsubscribeResponse
      || validateSchemaValue(schema.definitions.ThreadUnsubscribeParams, params, schema).length) {
      throw error("NATIVE_SCHEMA_INVALID", "取消订阅必须通过固定官方 schema 校验");
    }
    // This fixed, validated lifecycle extension is isolated here because the
    // existing Host/Adapter operation table does not yet expose unsubscribe.
    // No caller can choose a method, params, metadata, or raw Runtime handle.
    const response = await host.rpc.request(method, params);
    if (!exact(response, ["status"])
      || validateSchemaValue(schema.definitions.ThreadUnsubscribeResponse, response, schema).length) {
      throw error("NATIVE_RESPONSE_INVALID", "取消订阅返回值未通过官方 schema 校验");
    }
    return response;
  }

  #recordFor(request, lease) {
    const operationId = this.#operationId(request);
    const owner = this.#owner(lease);
    const record = this.#records.get(operationId);
    if (!record) throw error("NOT_FOUND", "生命周期操作不存在");
    this.#sameOwner(record, owner);
    return record;
  }
  #sameOwner(record, owner) {
    if (digest(record.owner) !== digest(owner)) throw error("OWNER_INVALID", "生命周期操作属于其他 Agent、Run 或 attempt");
  }
  #operationId(request) {
    if (!exact(request, ["operationId"]) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.operationId)) {
      throw error("INVALID", "生命周期请求只能含固定 operationId");
    }
    return request.operationId;
  }
  #receipt(record) {
    return Object.freeze({ version: 1, kind: "codex-security-owning-thread-lifecycle", operationId: record.operationId,
      state: record.state, owner: Object.freeze(structuredClone(record.owner)),
      runtimeSessionRef: record.sessionId ? runtimeSessionRef(record.targetBinding, record.sessionId) : null,
      runtimeTurnRef: null, pluginContextDigest: record.pluginContextDigest,
      credentialless: true, modelTurnStarted: false, scanStarted: false, fullPluginUsable: false,
      releaseMethod: record.state === "released" ? "thread/unsubscribe" : null,
      unsubscribeStatus: record.unsubscribeStatus, nativeThreadArchived: false, nativeThreadDeleted: false });
  }
  #time() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw error("INVALID", "生命周期时间无效");
    return now;
  }
  #assertOpen() {
    if (!this.#opened || this.#closing) throw error("CLOSED", "生命周期前置未打开");
    if (this.#uncertain) throw error("STORE_UNCERTAIN", "生命周期记录提交状态不确定");
  }
  #validateRecord(record) {
    if (!exact(record, RECORD_FIELDS) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.operationId)
      || !exact(record.owner, OWNER_FIELDS) || OWNER_FIELDS.filter(field => !["workspace", "contextSnapshotId"].includes(field))
        .some(field => !text(record.owner[field])) || !text(record.owner.workspace)
      || !path.isAbsolute(record.owner.workspace) || path.resolve(record.owner.workspace) !== record.owner.workspace
      || (record.owner.contextSnapshotId !== null && !/^ctx-[a-f0-9]{64}$/u.test(record.owner.contextSnapshotId))
      || !/^[a-f0-9]{64}$/u.test(record.pluginContextDigest) || !STATES.has(record.state)
      || (record.sessionId !== null && !text(record.sessionId))
      || (record.unsubscribeStatus !== null && !["unsubscribed", "notSubscribed", "notLoaded"].includes(record.unsubscribeStatus))
      || (record.state === "released" && record.unsubscribeStatus === null)
      || (["ready", "releasing", "released"].includes(record.state) && record.sessionId === null)
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) {
      throw error("STORE_CORRUPT", "生命周期记录字段无效");
    }
    try {
      if (runtimeBinding(record.targetBinding).runtime !== "codex") throw new Error();
      runtimeBinding({ runtime: record.owner.runtime, runtimeProfileId: record.owner.runtimeProfileId, runtimeAccountId: record.owner.runtimeAccountId });
    } catch { throw error("STORE_CORRUPT", "生命周期 Runtime binding 无效"); }
  }
  #identity(stat) {
    return stat ? Object.fromEntries(["dev", "ino", "size", "mtimeMs"].map(key => [key, stat[key]])) : null;
  }
  #save(record) {
    if (this.#uncertain) throw error("STORE_UNCERTAIN", "生命周期记录提交状态不确定");
    this.#validateRecord(record);
    const candidate = new Map(this.#records);
    candidate.set(record.operationId, Object.freeze(structuredClone(record)));
    const body = { version: 1, revision: this.#revision + 1, records: [...candidate.values()] };
    const serialized = `${JSON.stringify({ ...body, checksum: digest(body) })}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw error("CAPACITY", "生命周期记录达到容量限制");
    const currentIdentity = this.#identity(statIfExists(fs, this.recordPath));
    if (digest(currentIdentity) !== digest(this.#fileIdentity)) {
      this.#uncertain = true;
      throw error("STORE_CONFLICT", "生命周期文件已由其他 writer 修改，拒绝执行");
    }
    try { atomicWritePrivateFile(this.recordPath, serialized, {
      trustedRoot: this.paths.trustedRoot, expectedIdentity: this.#fileIdentity }); }
    catch (cause) {
      if (cause.committed || cause.committedUncertain) this.#uncertain = true;
      throw cause;
    }
    this.#records = candidate; this.#revision = body.revision;
    this.#fileIdentity = this.#identity(statIfExists(fs, this.recordPath));
    return candidate.get(record.operationId);
  }
}

module.exports = { CodexSecurityDelegationController };
