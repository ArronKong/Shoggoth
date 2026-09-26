"use strict";

// ModelChangeCoordinator 统一承接模型变更的预检、单次令牌、幂等、跨进程互斥与最终目录确认。
// 凭证只能作为 applyModelChange 的第三参数短暂存在，禁止进入 token、journal 或 backend context。
const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require("node:crypto");
const {
  ModelChangeError,
  modelIdentityKey,
  normalizeModelChangeRequest,
  normalizeModelDeleteSpec,
  modelChangeRequestDigest,
} = require("./model-change-validation");
const { createEntry, isNonTerminalStatus } = require("./model-change-journal");

const PREVIEW_TOKEN_VERSION = 1;
const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESULT_STATUSES = new Set([
  "in_progress", "partial", "blocked", "needs_secret", "cleanup_pending",
  "applied", "failed", "compensated",
]);
const TERMINAL_STATUSES = new Set(["applied", "failed", "compensated"]);
const SECRET_KEYS = new Set([
  "apikey", "xapikey", "token", "accesstoken", "refreshtoken", "authorization",
  "clientsecret", "secret", "password", "credential", "credentials",
]);

/** 判断值是否为没有自定义原型的普通对象。 */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 递归稳定排序对象键，用于比较 preview 快照而不受插入顺序影响。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 判断字段名是否是凭证别名；digest/hash/fingerprint/checksum 明确允许。 */
function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[\s_-]/g, "");
  if (/(?:digest|hash|fingerprint|checksum)/.test(normalized)) return false;
  return SECRET_KEYS.has(normalized);
}

/** 拒绝 URL userinfo、Authorization 及常见 token 赋值，防止凭证藏入公开文本。 */
function containsCredentialText(value) {
  if (typeof value !== "string") return false;
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const candidate of urls) {
    try {
      const parsed = new URL(candidate);
      if (parsed.username || parsed.password) return true;
    } catch {
      // 普通非 URL 文本继续交给下方凭证模式检查。
    }
  }
  return /\b(?:bearer|basic)\s+[^\s,;\]}]+/i.test(value)
    || /\b(?:(?:x[\s_-]?)?api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|token|password|credentials?)\b\s*(?:provided\s*)?[:=]\s*["']?[^\s"',;\]}]+/i.test(value)
    || /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|xoxb-[A-Za-z0-9_-]+|AKIA[0-9A-Z]+|AIza[0-9A-Za-z_-]+)/.test(value);
}

/**
 * 生成只含安全 JSON 数据的隔离副本。preview/backend 返回的公开信息先过此门，
 * 避免 toJSON、自定义原型、循环引用或凭证文本进入 token 与 journal。
 */
function cloneSafeJson(value, label = "value", seen = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (containsCredentialText(value)) {
      throw new ModelChangeError("secret_in_public_data", `${label} 包含禁止的凭证文本`, { status: 500 });
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ModelChangeError("invalid_backend_data", `${label} 包含非有限数字`, { status: 500 });
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new ModelChangeError("invalid_backend_data", `${label} 包含不可序列化值`, { status: 500 });
  }
  if (seen.has(value)) {
    throw new ModelChangeError("invalid_backend_data", `${label} 包含循环引用`, { status: 500 });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneSafeJson(item, `${label}[${index}]`, seen));
    }
    if (!isPlainObject(value)) {
      throw new ModelChangeError("invalid_backend_data", `${label} 必须由普通对象组成`, { status: 500 });
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretKey(key) || containsCredentialText(key)) {
        throw new ModelChangeError("secret_in_public_data", `${label} 包含禁止的凭证字段`, { status: 500 });
      }
      result[key] = cloneSafeJson(child, `${label}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** 将 base64url 文本严格解码，非法输入统一返回 token 错误。 */
function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ModelChangeError("preview_invalid", "preview token 格式不合法", { status: 400 });
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new ModelChangeError("preview_invalid", "preview token 格式不合法", { status: 400 });
  }
}

/** 校验并归一化 operationId，确保可安全用于 journal owner 与日志定位。 */
function normalizeOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    throw new ModelChangeError("invalid_operation_id", "operationId 格式不合法", {
      field: "operationId",
      status: 400,
    });
  }
  return value;
}

// 顶层 code 选「对用户最有信息量」的 blocker:硬拦截(重名/源不存在等,用户可
// 直接行动)优先于环境类警告(枚举不完整/运行时不支持,通常可被 bypass)。
// 否则 blockers[0] 常是扫描期的枚举警告,UI 只能显示笼统文案(R187 真机教训)。
const BLOCKER_CODE_PRIORITY = [
  "target_conflict", "source_not_found", "provider_not_found", "provider_conflict",
  "provider_base_url_required", "references_exist", "primary_model_in_use",
];

/** 由 blocker 数组生成固定、无写入的 blocked 响应。 */
function blockedResult(blockers, fallbackCode = "blocked") {
  const safeBlockers = cloneSafeJson(Array.isArray(blockers) ? blockers : [], "blockers");
  const ranked = [...safeBlockers].sort((a, b) => {
    const rank = (x) => {
      const i = BLOCKER_CODE_PRIORITY.indexOf(isPlainObject(x) ? x.code : "");
      return i === -1 ? BLOCKER_CODE_PRIORITY.length : i;
    };
    return rank(a) - rank(b);
  });
  const first = ranked[0];
  return {
    status: "blocked",
    code: isPlainObject(first) && typeof first.code === "string" ? first.code : fallbackCode,
    stage: isPlainObject(first) && typeof first.stage === "string" ? first.stage : "preflight",
    blockers: safeBlockers,
  };
}

/** 只把模型公开字段写入 modelDiff，显式排除 baseUrl/api 等 Provider 配置。 */
function publicModelSnapshot(model, providerKey, backendId) {
  const result = { id: model.id };
  for (const field of ["name", "contextWindow", "maxTokens", "reasoning"]) {
    if (Object.prototype.hasOwnProperty.call(model, field)) result[field] = model[field];
  }
  result.provider = providerKey;
  result.backendId = backendId;
  return result;
}

/** Coordinator 负责模型变更从 preview 到最终目录 revision 的单一写入协议。 */
class ModelChangeCoordinator {
  constructor({
    registry,
    journal,
    now = Date.now,
    tokenSecret = randomBytes(32),
    previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
    workAdmissionGate = null,
  } = {}) {
    if (!registry || typeof registry._activeGet !== "function" || typeof registry.listModelsSnapshot !== "function") {
      throw new TypeError("registry 必须提供 active backend 与 strict catalog 能力");
    }
    if (!journal || typeof journal.withExclusiveLock !== "function" || typeof journal.withProviderLock !== "function") {
      throw new TypeError("journal 必须提供全局锁与 Provider 锁");
    }
    if (typeof now !== "function") throw new TypeError("now 必须是函数");
    const secret = Buffer.isBuffer(tokenSecret) ? Buffer.from(tokenSecret) : Buffer.from(String(tokenSecret || ""));
    if (secret.length < 32) throw new TypeError("tokenSecret 至少需要 32 字节");
    if (!Number.isFinite(previewTtlMs) || previewTtlMs <= 0) throw new TypeError("previewTtlMs 必须是正数");
    if (workAdmissionGate !== null
      && (typeof workAdmissionGate.enter !== "function" || typeof workAdmissionGate.beginDrain !== "function")) {
      throw new TypeError("workAdmissionGate 必须提供 enter 与 beginDrain");
    }

    this.registry = registry;
    this.journal = journal;
    this.now = now;
    this.tokenSecret = secret;
    this.previewTtlMs = previewTtlMs;
    // Task 9 的 runtime apply 从 coordinator 组合关系取得同一实例，禁止另建 gate 造成漏拦截。
    this.workAdmissionGate = workAdmissionGate;
    this.ready = false;
    this.keyedTails = new Map();
    this.consumedTokenDigests = new Set();
  }

  /** 返回启动恢复是否已经完成；写路由在 Task 5 以此建立 readiness 门。 */
  isReady() {
    return this.ready;
  }

  /** 写入口统一调用的 readiness 门；恢复未完成时只允许只读请求继续。 */
  requireReady() {
    if (!this.ready) {
      throw new ModelChangeError("model_change_recovering", "模型变更恢复尚未完成", {
        stage: "recovery",
        status: 503,
      });
    }
  }

  /** 仅在启动恢复成功后由主进程调用。 */
  markReady() {
    this.ready = true;
  }

  /**
   * 公开当前 backend 的非终态操作最小投影，供客户端重启后续提同一 operationId。
   * journal 中的 fingerprints/diff/steps 均不返回，避免把内部恢复细节暴露给 UI。
   */
  listPending(backendId) {
    return this.journal.listPending()
      .filter((entry) => !backendId || entry.backendId === backendId)
      .map((entry) => ({
        operationId: entry.operationId,
        backendId: entry.backendId,
        providerKey: entry.providerKey,
        kind: entry.kind,
        status: entry.status,
        stage: entry.stage,
        source: entry.source,
        target: entry.target,
      }));
  }

  /** 获取已激活 backend；未知 ID 不允许静默降级。 */
  _backend(backendId) {
    if (typeof backendId !== "string" || backendId.trim() === "") {
      throw new ModelChangeError("unknown_backend", "backendId 不能为空", { field: "backendId", status: 404 });
    }
    const backend = this.registry._activeGet(backendId);
    if (!backend) throw new ModelChangeError("unknown_backend", "未找到已激活的 backend", { status: 404 });
    return backend;
  }

  /** 为同 backend+provider 建立进程内 FIFO；不同 key 不共享等待链。 */
  async _withKeyedMutex(key, run) {
    const previous = this.keyedTails.get(key) || Promise.resolve();
    const ready = previous.catch(() => undefined);
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = ready.then(() => current);
    this.keyedTails.set(key, tail);
    await ready;
    try {
      return await run();
    } finally {
      release();
      if (this.keyedTails.get(key) === tail) this.keyedTails.delete(key);
    }
  }

  /** 对固定 payload 签名；token 本身不包含任何凭证。 */
  _signPreviewPayload(payload) {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.tokenSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  /** 验证 HMAC、固定 payload schema 与过期时间，可为已落 journal 的幂等重放忽略 TTL。 */
  _verifyPreviewToken(token, { allowExpired = false } = {}) {
    if (typeof token !== "string") {
      throw new ModelChangeError("preview_required", "缺少 preview token", { field: "previewToken", status: 400 });
    }
    const pieces = token.split(".");
    if (pieces.length !== 2) {
      throw new ModelChangeError("preview_invalid", "preview token 格式不合法", { status: 400 });
    }
    const [encoded, suppliedText] = pieces;
    decodeBase64Url(encoded);
    const supplied = decodeBase64Url(suppliedText);
    const expected = createHmac("sha256", this.tokenSecret).update(encoded).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ModelChangeError("preview_invalid", "preview token 签名无效", { status: 400 });
    }

    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new ModelChangeError("preview_invalid", "preview token payload 无效", { status: 400 });
    }
    const expectedKeys = [
      "backendId", "expiresAt", "fingerprints", "nonce", "providerKey",
      "requestDigest", "sourceKey", "targetKey", "version",
    ];
    if (!isPlainObject(payload)
      || Object.keys(payload).sort().join("\0") !== expectedKeys.sort().join("\0")
      || payload.version !== PREVIEW_TOKEN_VERSION
      || typeof payload.nonce !== "string"
      || typeof payload.backendId !== "string"
      || typeof payload.providerKey !== "string"
      || typeof payload.requestDigest !== "string"
      || !isPlainObject(payload.fingerprints)
      || !Number.isFinite(payload.expiresAt)) {
      throw new ModelChangeError("preview_invalid", "preview token payload 不符合协议", { status: 400 });
    }
    const safePayload = cloneSafeJson(payload, "previewToken");
    if (!allowExpired && this.now() > safePayload.expiresAt) {
      throw new ModelChangeError("preview_expired", "preview token 已过期，请重新预检", { status: 409 });
    }
    return safePayload;
  }

  /** 校验 token 与本次 safeSpec 的 backend、Provider、身份和摘要完全一致。 */
  _assertTokenMatches(payload, backendId, safeSpec, requestDigest) {
    const matches = payload.backendId === backendId
      && payload.providerKey === safeSpec.providerKey
      && payload.sourceKey === (safeSpec.sourceKey ?? null)
      && payload.targetKey === (safeSpec.targetKey ?? null)
      && payload.requestDigest === requestDigest;
    if (!matches) {
      throw new ModelChangeError("preview_mismatch", "preview token 与当前请求不匹配", { status: 409 });
    }
  }

  /** 将 backend preview 输出归一化为固定公开字段，并拒绝任何凭证数据。 */
  _normalizePreviewOutput(rawPreview) {
    const preview = isPlainObject(rawPreview) ? rawPreview : {};
    return {
      references: cloneSafeJson(Array.isArray(preview.references) ? preview.references : [], "preview.references"),
      blockers: cloneSafeJson(Array.isArray(preview.blockers) ? preview.blockers : [], "preview.blockers"),
      runtimeApply: typeof preview.runtimeApply === "string" ? preview.runtimeApply : "unsupported",
      fingerprints: cloneSafeJson(isPlainObject(preview.fingerprints) ? preview.fingerprints : {}, "preview.fingerprints"),
      ...(Number.isSafeInteger(preview.scannerVersion) && preview.scannerVersion > 0
        ? { scannerVersion: preview.scannerVersion }
        : {}),
      ...(isPlainObject(preview.stores)
        ? { stores: cloneSafeJson(preview.stores, "preview.stores") }
        : {}),
      ...(isPlainObject(preview.sourceSnapshot)
        ? { sourceSnapshot: cloneSafeJson(preview.sourceSnapshot, "preview.sourceSnapshot") }
        : {}),
      ...(Array.isArray(preview.modelProfiles)
        ? { modelProfiles: cloneSafeJson(preview.modelProfiles, "preview.modelProfiles") }
        : {}),
      ...(isPlainObject(preview.providerDiff)
        ? { providerDiff: cloneSafeJson(preview.providerDiff, "preview.providerDiff") }
        : {}),
    };
  }

  /** 对已经无凭证的 safeSpec 执行 backend preview，并生成进程签名的短期 token。 */
  async _previewSafe(backendId, safeSpec) {
    const backend = this._backend(backendId);
    if (typeof backend.getModelChangeCapabilities !== "function" || typeof backend.previewModelChange !== "function") {
      throw new ModelChangeError("unsupported", "backend 不支持模型变更", { status: 409 });
    }
    const requestDigest = modelChangeRequestDigest(safeSpec);
    const capabilities = cloneSafeJson(await backend.getModelChangeCapabilities(), "capabilities");
    const preview = this._normalizePreviewOutput(await backend.previewModelChange(safeSpec));
    const payload = {
      version: PREVIEW_TOKEN_VERSION,
      nonce: randomBytes(18).toString("base64url"),
      backendId,
      providerKey: safeSpec.providerKey,
      sourceKey: safeSpec.sourceKey ?? null,
      targetKey: safeSpec.targetKey ?? null,
      requestDigest,
      fingerprints: preview.fingerprints,
      expiresAt: this.now() + this.previewTtlMs,
    };
    return {
      previewToken: this._signPreviewPayload(payload),
      capabilities,
      references: preview.references,
      blockers: preview.blockers,
      runtimeApply: preview.runtimeApply,
      fingerprints: preview.fingerprints,
      ...(preview.scannerVersion ? { scannerVersion: preview.scannerVersion } : {}),
      ...(preview.stores ? { stores: preview.stores } : {}),
    };
  }

  /** 公开 preview 入口立即丢弃 normalize 产出的 secretEnvelope。 */
  async preview(backendId, rawSpec) {
    const { safeSpec } = normalizeModelChangeRequest(rawSpec);
    return this._previewSafe(backendId, safeSpec);
  }

  /**
   * 判断被完整链路 blocker 挡住的请求能否降级为 config-only 写：backend 必须声明
   * 支持该 kind，且每个 blocker 的 code 都在 backend 自报的 bypassBlockerCodes 里
   * （即纯能力类阻断）。冲突类 blocker（target_conflict 等）永远不可绕过；
   * rename 不在映射表内，天然不降级。
   */
  async _configOnlyEligible(backendId, safeSpec, blockers, { forced = false } = {}) {
    const kindField = {
      create: "create",
      update: "update",
      // 模型 rename 默认不降级(引用迁移复杂);仅当后端显式声明 renameCatalogModel
      // (allowlist 驱动的目录模型:搬键+引用改写是原子 patch)才允许 config-only。
      rename: "renameCatalogModel",
      "delete-model": "delete",
      "delete-provider": "delete",
      "update-provider": "updateProvider",
    }[safeSpec.kind];
    if (!kindField) return null;
    const backend = this._backend(backendId);
    if (typeof backend.getModelConfigWriteCapabilities !== "function") return null;
    let caps;
    try {
      caps = cloneSafeJson(await backend.getModelConfigWriteCapabilities(), "configWriteCapabilities");
    } catch {
      return null;
    }
    if (!isPlainObject(caps) || caps.supported !== true || caps[kindField] !== true) return null;
    if (safeSpec.kind === "update-provider" && safeSpec.patch?.renameTo && caps.renameProvider !== true) return null;
    // bypassBlockerCodes 两种形状：数组 = 全 kind 通用；map = "*" 通用 + 按 safeSpec.kind
    // 追加（如 update-provider 可绕过枚举不完整）。force 删除（用户已在确认框知情）
    // 再叠加 `<kind>:forced` 键——backend 借此声明仅在显式确认后才可绕过的 blocker。
    const rawBypass = caps.bypassBlockerCodes;
    const bypass = new Set(
      Array.isArray(rawBypass)
        ? rawBypass
        : isPlainObject(rawBypass)
          ? [...(Array.isArray(rawBypass["*"]) ? rawBypass["*"] : []),
             ...(Array.isArray(rawBypass[safeSpec.kind]) ? rawBypass[safeSpec.kind] : []),
             ...(forced && Array.isArray(rawBypass[`${safeSpec.kind}:forced`])
               ? rawBypass[`${safeSpec.kind}:forced`]
               : [])]
          : [],
    );
    if (bypass.size === 0) return null;
    const allBypassable = blockers.every((item) => (
      isPlainObject(item) && typeof item.code === "string" && bypass.has(item.code)
    ));
    return allBypassable ? caps : null;
  }

  /** 为 journal 构造固定、可恢复且仅含公开模型字段的 operation entry。 */
  _createJournalEntry({
    backendId,
    safeSpec,
    operationId,
    requestDigest,
    previewTokenDigest,
    fingerprints,
    sourceSnapshot,
    modelProfiles,
    providerDiff,
    hasSecret,
    mode,
  }) {
    const source = safeSpec.sourceModelId
      ? { provider: safeSpec.providerKey, modelId: safeSpec.sourceModelId }
      : null;
    let target = null;
    let modelDiff = null;
    if (["create", "update", "rename"].includes(safeSpec.kind)) {
      target = { provider: safeSpec.providerKey, modelId: safeSpec.model.id };
      modelDiff = {
        before: safeSpec.sourceModelId
          ? publicModelSnapshot(sourceSnapshot || { id: safeSpec.sourceModelId }, safeSpec.providerKey, backendId)
          : null,
        after: publicModelSnapshot(safeSpec.model, safeSpec.providerKey, backendId),
        ...(Array.isArray(modelProfiles) ? {
          profiles: modelProfiles.map((row) => ({
            profile: row.profile,
            before: row.before
              ? publicModelSnapshot(row.before, safeSpec.providerKey, backendId)
              : null,
            after: row.after
              ? publicModelSnapshot(row.after, safeSpec.providerKey, backendId)
              : null,
          })),
        } : {}),
      };
    } else if (safeSpec.kind === "update-provider") {
      target = { provider: safeSpec.patch?.renameTo || safeSpec.providerKey };
    } else if (safeSpec.kind === "delete-model") {
      modelDiff = {
        before: publicModelSnapshot(sourceSnapshot || { id: safeSpec.sourceModelId }, safeSpec.providerKey, backendId),
        after: null,
      };
    }
    return createEntry({
      operationId,
      requestDigest,
      previewTokenDigest,
      backendId,
      providerKey: safeSpec.providerKey,
      kind: safeSpec.kind,
      mode,
      source,
      target,
      fingerprints,
      modelDiff,
      // preview 可以合法地不带 providerDiff（OpenClaw 的 auth-only 内置 provider 在
      // config 里没有条目可摘要；Hermes provider 枚举不完整降级 config-only）。必须
      // 归一成 null——journal 的 assertSafeJson 把 undefined 当不可序列化值 fail-closed。
      providerDiff: safeSpec.kind === "update-provider" ? (providerDiff ?? null) : null,
      createdProvider: safeSpec.kind === "create" && safeSpec.providerMode === "new",
      secretStep: hasSecret ? "pending" : "not_required",
    }, this.now());
  }

  /** 通过 journal 全局锁执行一次短原子更新，owner 只使用受限 operationId。 */
  async _withJournalLock(operationId, purpose, run) {
    // 同一 journal 实例的全局锁是 fail-closed 的；先在进程内排队，避免不同 Provider
    // 同时执行短 journal 更新时把正常竞争误报为 journal_locked。
    return this._withKeyedMutex("\0journal-global", () => (
      this.journal.withExclusiveLock(`coordinator:${operationId}:${purpose}`, run)
    ));
  }

  /** 每个 backend context hook 前后都 checkpoint Provider lease，失锁即停止后续写入。 */
  async _guardedJournalMutation(guard, operationId, purpose, run) {
    guard.assertActive();
    const result = await this._withJournalLock(operationId, purpose, run);
    guard.assertActive();
    return result;
  }

  /** 构造不含凭证的 backend context；Provider fencing 字段供 adapter 在每次外部写前检查。 */
  _createBackendContext({ guard, operationId, requestDigest, journalEntry, recoveryMode, forwardOnly = false }) {
    const context = {
      operationId,
      requestDigest,
      journalEntry,
      providerLeaseToken: guard.token,
      providerLeaseSignal: guard.signal,
      assertProviderLease: guard.assertActive,
      recordStage: async (stage, patch = {}) => this._guardedJournalMutation(
        guard,
        operationId,
        "stage",
        () => this.journal.setStage(operationId, stage, patch),
      ),
      recordStep: async (step) => this._guardedJournalMutation(
        guard,
        operationId,
        "step",
        () => this.journal.recordStep(operationId, step),
      ),
      markCommitting: async (patch = {}) => this._guardedJournalMutation(
        guard,
        operationId,
        "committing",
        () => this.journal.setStage(operationId, "commit", { ...patch, commitState: "committing" }),
      ),
      markCommitted: async (patch = {}) => this._guardedJournalMutation(
        guard,
        operationId,
        "committed",
        () => this.journal.setStage(operationId, "commit", { ...patch, commitState: "committed" }),
      ),
    };
    // 恢复上下文显式区分提交点前/提交判定/只向前；普通 apply 不暴露这些字段。
    if (recoveryMode) {
      context.recoveryMode = recoveryMode;
      context.forwardOnly = forwardOnly === true;
    }
    return Object.freeze(context);
  }

  /** 将 backend 结果约束为 journal 支持的固定状态和安全 JSON。 */
  _normalizeApplyResult(rawResult) {
    if (!isPlainObject(rawResult) || !RESULT_STATUSES.has(rawResult.status)) {
      return { status: "failed", code: "invalid_backend_result", stage: "apply", retryable: false };
    }
    const result = cloneSafeJson(rawResult, "applyResult");
    // backend 无权自行声明最终目录；applied 也必须由 coordinator 的 strict fresh
    // snapshot 覆盖，其他状态则永远不携带 catalog。
    delete result.catalog;
    return result;
  }

  /** backend 抛错时只记录稳定 code/stage，不回显可能含凭证的原始 message。 */
  _safeFailureResult(error) {
    return {
      status: "failed",
      code: typeof error?.code === "string" ? error.code : "apply_failed",
      stage: typeof error?.stage === "string" ? error.stage : "apply",
      retryable: error?.retryable !== false,
    };
  }

  /** applied 必须先取得 strict fresh catalog；失败降级为可恢复 partial 且不携带伪目录。 */
  async _attachStrictCatalog(backendId, result) {
    if (result.status !== "applied") return result;
    try {
      const snapshot = await this.registry.listModelsSnapshot(backendId, { fresh: true });
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.models) || typeof snapshot.catalogRevision !== "string") {
        throw new Error("strict catalog shape invalid");
      }
      return cloneSafeJson({
        ...result,
        catalog: {
          models: snapshot.models,
          catalogRevision: snapshot.catalogRevision,
        },
      }, "finalResult");
    } catch {
      return {
        status: "partial",
        code: "catalog_pending",
        stage: "catalog",
        retryable: true,
        ...(result.restartRequired === true ? { restartRequired: true, activation: result.activation ?? null } : {}),
      };
    }
  }

  /**
   * 检查已有 operation 的摘要。journal 建立后由 operationId+requestDigest 作为恢复凭据，
   * 不依赖上个进程的 HMAC secret；若调用方仍提交 token，则必须与 journal 摘要一致。
   */
  _existingOperation(operationId, requestDigest, previewToken) {
    const existing = this.journal.get(operationId);
    if (!existing) return null;
    if (existing.requestDigest !== requestDigest) {
      throw new ModelChangeError("operation_reused", "operationId 已绑定不同请求", { status: 409 });
    }
    if (previewToken !== undefined && previewToken !== null && previewToken !== "") {
      if (typeof previewToken !== "string") {
        throw new ModelChangeError("preview_invalid", "preview token 格式不合法", { status: 400 });
      }
      const suppliedDigest = createHash("sha256").update(previewToken).digest("hex");
      if (existing.previewTokenDigest !== suppliedDigest) {
        throw new ModelChangeError("preview_mismatch", "operationId 与 preview token 不匹配", { status: 409 });
      }
    }
    this.consumedTokenDigests.add(existing.previewTokenDigest);
    return { existing, payload: null, tokenDigest: existing.previewTokenDigest };
  }

  /**
   * 已归一化 apply 核心：进程 mutex → Provider lease → 重做 preview → journal.begin → backend → strict catalog。
   */
  async _applySafe(backendId, safeSpec, secretEnvelope, {
    previewToken,
    operationId,
    resumeByOperationId = false,
    configOnly = false,
    force = false,
  }) {
    operationId = normalizeOperationId(operationId);
    const requestDigest = modelChangeRequestDigest(safeSpec);
    // 兼容 REST 的续提凭据是 operationId；已有 journal 时不再要求客户端持有内部 preview token。
    const submittedToken = resumeByOperationId ? undefined : previewToken;
    const known = this._existingOperation(operationId, requestDigest, submittedToken);
    if (known && TERMINAL_STATUSES.has(known.existing.status)) return known.existing.result;

    // A completed config write can be left pending only because the immediate
    // catalog refresh failed. Recover that receipt before starting a later edit;
    // never bypass unresolved writes, missing secrets or reference cleanup.
    const catalogPending = this.journal.listPending().filter((entry) => (
      entry.operationId !== operationId && entry.backendId === backendId
      && entry.providerKey === safeSpec.providerKey && entry.mode === "config-only"
      && entry.kind === "update-provider" && entry.stage === "config-write"
      && entry.secretStep !== "pending" && entry.result?.code === "catalog_pending"
    ));
    for (const entry of catalogPending) await this._recoverEntry(entry);

    const mutexKey = `${backendId}\0${safeSpec.providerKey}`;
    return this._withKeyedMutex(mutexKey, async () => {
      const afterWait = this._existingOperation(operationId, requestDigest, submittedToken);
      if (afterWait && TERMINAL_STATUSES.has(afterWait.existing.status)) return afterWait.existing.result;

      let tokenDigest = afterWait?.tokenDigest || null;
      let payload = null;
      if (!afterWait) {
        const candidateDigest = typeof previewToken === "string"
          ? createHash("sha256").update(previewToken).digest("hex")
          : null;
        payload = this._verifyPreviewToken(previewToken, {
          // 已消费 token 即使过期也继续到 journal.begin，由持久唯一约束稳定返回 preview_reused。
          allowExpired: Boolean(candidateDigest && this.consumedTokenDigests.has(candidateDigest)),
        });
        this._assertTokenMatches(payload, backendId, safeSpec, requestDigest);
        tokenDigest = candidateDigest;
      }
      const backend = this._backend(backendId);
      const providerScope = `${backendId}:${safeSpec.providerKey}`;

      return this.journal.withProviderLock(providerScope, operationId, async (guard) => {
        guard.assertActive();
        const lockedExisting = this._existingOperation(operationId, requestDigest, submittedToken);
        if (lockedExisting && TERMINAL_STATUSES.has(lockedExisting.existing.status)) {
          guard.assertActive();
          return lockedExisting.existing.result;
        }
        const otherPending = this.journal.listPending().find((entry) => (
          entry.operationId !== operationId
          && entry.backendId === backendId
          && [entry.providerKey, entry.target?.provider].some(provider => provider &&
            (provider === safeSpec.providerKey || provider === safeSpec.patch?.renameTo))
        ));
        if (otherPending) {
          throw new ModelChangeError("provider_change_pending", "该 Provider 存在未完成的模型变更", {
            stage: "recovery",
            status: 409,
          });
        }

        // journal 明确记录 secret 尚未完成时，空凭证重试/自动恢复绝不能把公开字段收敛误报成功。
        if (lockedExisting?.existing.secretStep === "pending" && !secretEnvelope?.apiKey) {
          const needsSecret = {
            status: "needs_secret",
            code: "recovery_input_required",
            stage: lockedExisting.existing.stage,
            operationId,
          };
          const pendingEntry = await this._guardedJournalMutation(
            guard,
            operationId,
            "retry-needs-secret",
            () => this.journal.finish(operationId, "needs_secret", needsSecret),
          );
          return pendingEntry.result;
        }

        // 响应可能在网关写入后的重连窗口丢失。先读回 journal 的精确目标，
        // 已落盘时只收敛 fresh catalog，不能再 preview create 而撞 target_conflict。
        let verifiedConfigOnlyTarget = false;
        if (lockedExisting?.existing.mode === "config-only") {
          let recovered;
          try {
            recovered = this._normalizeApplyResult(await backend.recoverModelChangeConfigOnly(lockedExisting.existing));
          } catch (error) {
            if (String(error?.code || "").startsWith("journal_")) throw error;
            recovered = { status: "partial", code: "recovery_failed", stage: "recovery", retryable: true };
          }
          guard.assertActive();
          if (recovered.status === "failed" && recovered.retryable !== false) recovered.status = "partial";
          verifiedConfigOnlyTarget = recovered.status === "applied";
          // A remote config write may have carried an uncheckpointed secret. With
          // a resupplied key, replay its exact verified target before claiming success.
          const mustReapplySecret = verifiedConfigOnlyTarget && lockedExisting.existing.secretStep === "pending";
          if (recovered.code !== "config_write_not_applied" && !mustReapplySecret) {
            if (recovered.status === "applied" || lockedExisting.existing.fingerprints?.configOnlyRestartRequired === true) {
              const caps = await backend.getModelConfigWriteCapabilities();
              if (lockedExisting.existing.fingerprints?.configOnlyRestartRequired === true) recovered.restartRequired = true;
              recovered.activation = recovered.restartRequired === false ? null : (caps?.activation ?? null);
            }
            recovered = await this._attachStrictCatalog(backendId, recovered);
            recovered = { ...recovered, operationId };
            const recoveredEntry = await this._guardedJournalMutation(guard, operationId, "retry-config-recover", () => (
              this.journal.finish(operationId, recovered.status, recovered)
            ));
            return recoveredEntry.result;
          }
        }

        // 已有非终态 operation 的重试必须走持久恢复语义，不能重新 preview 后把
        // cleanup_pending 覆盖成 source_not_found/target_conflict。needs_secret 例外，
        // 它需要本次请求重新提供短生命周期凭证后继续普通 apply。config-only 例外：
        // 单次配置写天然幂等，带完整 spec 的重试直接重放而不是走 full 恢复状态机。
        if (lockedExisting
          && isNonTerminalStatus(lockedExisting.existing.status)
          && lockedExisting.existing.status !== "needs_secret"
          && lockedExisting.existing.secretStep !== "pending"
          && lockedExisting.existing.mode !== "config-only") {
          const mode = this._recoveryMode(lockedExisting.existing);
          const recoveryContext = this._createBackendContext({
            guard,
            operationId,
            requestDigest,
            journalEntry: lockedExisting.existing,
            ...mode,
          });
          let recovered = this._normalizeApplyResult(
            await backend.recoverModelChange(lockedExisting.existing, recoveryContext),
          );
          recovered = await this._attachStrictCatalog(backendId, recovered);
          recovered = { ...recovered, operationId };
          const recoveredEntry = await this._guardedJournalMutation(
            guard,
            operationId,
            "retry-recover",
            () => this.journal.finish(operationId, recovered.status, recovered),
          );
          return recoveredEntry.result;
        }

        guard.assertActive();
        const currentPreview = this._normalizePreviewOutput(await backend.previewModelChange(safeSpec));
        guard.assertActive();
        // journal 建立前，token 快照必须严格匹配；journal 建立后的 partial/needs_secret
        // 重试则以持久状态为真值，因为前一轮写入本来就可能已经改变存储指纹。
        const resumesJournal = Boolean(lockedExisting && isNonTerminalStatus(lockedExisting.existing.status));
        if (!resumesJournal && stableJson(currentPreview.fingerprints) !== stableJson(payload.fingerprints)) {
          throw new ModelChangeError("preview_stale", "配置已变化，请重新预检", { status: 409, stage: "preflight" });
        }
        // 任何入口（新 PUT、兼容 POST、config-only journal 的续提）在锁内统一决定
        // 是否降级：blocker 全部落在 backend 自报的 bypass 集合内且 kind 允许时走
        // config-only 写；冲突类 blocker 或能力消失都保持零写返回。
        let configOnlyContext = configOnly || lockedExisting?.existing.mode === "config-only";
        let configWriteCaps = null;
        if (configOnlyContext || currentPreview.blockers.length > 0) {
          const resumingProviderRename = lockedExisting?.existing.mode === "config-only"
            && lockedExisting.existing.fingerprints?.providerRename;
          const blockers = resumingProviderRename
            ? currentPreview.blockers.filter((blocker) => !["provider_not_found", "source_not_found", "provider_exists"].includes(blocker.code))
            : verifiedConfigOnlyTarget
            ? currentPreview.blockers.filter((blocker) => !["target_conflict", "provider_conflict"].includes(blocker.code))
            : currentPreview.blockers;
          configWriteCaps = await this._configOnlyEligible(backendId, safeSpec, blockers, { forced: force });
          if (!configWriteCaps) {
            return blockedResult(
              currentPreview.blockers.length > 0
                ? currentPreview.blockers
                : [{ code: "config_write_unsupported", stage: "preflight", message: "config-only 写能力不可用" }],
            );
          }
          configOnlyContext = true;
        }

        const candidate = this._createJournalEntry({
          backendId,
          safeSpec,
          operationId,
          requestDigest,
          previewTokenDigest: tokenDigest,
          fingerprints: currentPreview.fingerprints,
          sourceSnapshot: currentPreview.sourceSnapshot,
          modelProfiles: currentPreview.modelProfiles,
          providerDiff: currentPreview.providerDiff,
          hasSecret: Boolean(secretEnvelope),
          mode: configOnlyContext ? "config-only" : "full",
        });
        const journalEntry = await this._guardedJournalMutation(
          guard,
          operationId,
          "begin",
          () => this.journal.begin(candidate),
        );
        this.consumedTokenDigests.add(tokenDigest);
        if (TERMINAL_STATUSES.has(journalEntry.status)) return journalEntry.result;

        const context = this._createBackendContext({ guard, operationId, requestDigest, journalEntry });
        const effectiveSecret = journalEntry.secretStep === "applied" ? null : secretEnvelope;
        // journal 持久的 mode 是唯一真值：跨进程/重启重试即使调用方忘传 configOnly，
        // 也绝不能把 config-only operation 误发给完整 apply 状态机（反之亦然）。
        const useConfigOnly = journalEntry.mode === "config-only";
        let result;
        try {
          guard.assertActive();
          result = this._normalizeApplyResult(useConfigOnly
            ? await backend.applyModelChangeConfigOnly(safeSpec, context, effectiveSecret)
            : await backend.applyModelChange(safeSpec, context, effectiveSecret));
          guard.assertActive();
          if (useConfigOnly && result.status === "failed" && result.retryable !== false) result.status = "partial";
          if (result.status === "applied" && useConfigOnly) {
            if (effectiveSecret?.apiKey && this.journal.get(operationId)?.secretStep !== "applied") {
              await context.recordStage(result.stage || "config-write", { secretStep: "applied" });
            }
            // restartRequired=false（backend 按网关 reload 规则判定本次写热生效）
            // → 不附 activation，UI 不弹「重启生效」横幅；缺席/true 保持原行为。
            result.activation = result.restartRequired === false
              ? null
              : (configWriteCaps?.activation ?? null);
          }
          result = await this._attachStrictCatalog(backendId, result);
          guard.assertActive();
        } catch (error) {
          // fencing/journal 错误必须原样上抛，失锁后绝不尝试继续写 journal 或返回成功。
          if (String(error?.code || "").startsWith("journal_")) {
            throw error;
          }
          result = this._safeFailureResult(error);
          if (useConfigOnly) {
            result.status = "partial";
            result.retryable = true;
            if (safeSpec.kind === "update-provider" && safeSpec.patch?.renameTo && error.providerRenameNotStarted === true) {
              result.status = "failed";
              result.stage = "preflight";
              result.retryable = false;
            }
            // Some gateways explicitly acknowledge a persisted, active write in
            // an error receipt while requiring a recovery restart. Verify once;
            // never repeat the write or infer success from that receipt alone.
            if (error?.configPersisted === true && error?.restartRequired === true) {
              const current = this.journal.get(operationId);
              const checkpoint = await context.recordStage("config-restart-pending", {
                fingerprints: { ...current.fingerprints, configOnlyRestartRequired: true },
                ...(effectiveSecret?.apiKey ? { secretStep: "applied" } : {}),
              });
              const restart = { restartRequired: true, activation: configWriteCaps?.activation ?? null };
              result = { ...result, ...restart };
              try {
                const recovered = this._normalizeApplyResult(await backend.recoverModelChangeConfigOnly(checkpoint));
                guard.assertActive();
                if (recovered.status === "applied") {
                  result = await this._attachStrictCatalog(backendId, { ...recovered, ...restart });
                }
              } catch (readbackError) {
                if (String(readbackError?.code || "").startsWith("journal_")) throw readbackError;
                // Keep the actionable restart result when confirmation is unavailable.
              }
            }
          }
        }

        // 公开终态始终回传请求绑定的 operationId，前端 partial/failed 重试据此保持幂等。
        result = { ...result, operationId };

        const finalEntry = await this._guardedJournalMutation(
          guard,
          operationId,
          "finish",
          () => this.journal.finish(operationId, result.status, result),
        );
        return finalEntry.result;
      });
    });
  }

  /** 公开 apply 入口重新 normalize，以确保 secret 只进入第三参数。 */
  async apply(backendId, rawSpec, options = {}) {
    const { safeSpec, secretEnvelope } = normalizeModelChangeRequest(rawSpec);
    return this._applySafe(backendId, safeSpec, secretEnvelope, options);
  }

  /** 兼容旧 POST：内部 preview，blocker 零写；通过后仍走同一 token + journal 协议。 */
  async applyCompat(backendId, rawSpec, { operationId = randomUUID() } = {}) {
    const { safeSpec, secretEnvelope } = normalizeModelChangeRequest(rawSpec);
    // 幂等续提：journal 已有同 id+digest 的 operation（含终态）时直接按 operationId
    // 恢复，不重新 preview——否则响应丢失后的重试会撞 preview_mismatch/target_conflict。
    const existing = this._existingOperation(
      normalizeOperationId(operationId),
      modelChangeRequestDigest(safeSpec),
    );
    if (existing) {
      return this._applySafe(backendId, safeSpec, secretEnvelope, {
        operationId,
        resumeByOperationId: true,
      });
    }
    const preview = await this._previewSafe(backendId, safeSpec);
    if (preview.blockers.length > 0) {
      const configWrite = await this._configOnlyEligible(backendId, safeSpec, preview.blockers);
      if (!configWrite) return blockedResult(preview.blockers);
      return this._applySafe(backendId, safeSpec, secretEnvelope, {
        previewToken: preview.previewToken,
        operationId,
        configOnly: true,
      });
    }
    return this._applySafe(backendId, safeSpec, secretEnvelope, {
      previewToken: preview.previewToken,
      operationId,
    });
  }

  /**
   * 兼容 mutation 共用的幂等续提入口：journal 已存在时按 operationId 恢复，
   * 不重新 preview；首次请求才生成一次内部 token 并建立 journal。
   */
  async _applyCompatSafe(backendId, safeSpec, secretEnvelope, operationId) {
    operationId = normalizeOperationId(operationId);
    const requestDigest = modelChangeRequestDigest(safeSpec);
    const existing = this._existingOperation(operationId, requestDigest);
    if (existing) {
      return this._applySafe(backendId, safeSpec, secretEnvelope, {
        operationId,
        resumeByOperationId: true,
      });
    }
    const preview = await this._previewSafe(backendId, safeSpec);
    if (preview.blockers.length > 0) {
      const configWrite = await this._configOnlyEligible(backendId, safeSpec, preview.blockers);
      if (!configWrite) return blockedResult(preview.blockers);
      return this._applySafe(backendId, safeSpec, secretEnvelope, {
        previewToken: preview.previewToken,
        operationId,
        resumeByOperationId: true,
        configOnly: true,
      });
    }
    return this._applySafe(backendId, safeSpec, secretEnvelope, {
      previewToken: preview.previewToken,
      operationId,
      // 跨进程并发时另一请求可能已先建立 journal；此时仍按同 ID 续提。
      resumeByOperationId: true,
    });
  }

  /** Provider PUT 兼容入口：公开 patch 与 apiKey 信封拆分后复用协调器协议。 */
  async updateProviderCompat(backendId, providerKey, patch = {}, { operationId = randomUUID() } = {}) {
    if (typeof providerKey !== "string" || !PROVIDER_KEY_RE.test(providerKey)) {
      throw new ModelChangeError("invalid_provider", "providerKey 格式不合法", { field: "providerKey" });
    }
    if (!isPlainObject(patch)) {
      throw new ModelChangeError("invalid_input", "Provider patch 必须是普通对象", { field: "patch" });
    }
    for (const key of Object.keys(patch)) {
      if (!["baseUrl", "api", "apiKey", "clearBaseUrl", "clearApiKey", "renameTo"].includes(key)) {
        throw new ModelChangeError("unknown_field", "Provider patch 包含未知字段", { field: key });
      }
    }
    if (patch.clearBaseUrl !== undefined && typeof patch.clearBaseUrl !== "boolean") {
      throw new ModelChangeError("invalid_boolean", "clearBaseUrl 必须是布尔值", { field: "clearBaseUrl" });
    }
    if (patch.clearBaseUrl === true && patch.baseUrl) {
      throw new ModelChangeError("conflicting_fields", "clearBaseUrl 与 baseUrl 不能同时提交", { field: "baseUrl" });
    }
    if (patch.clearApiKey !== undefined && typeof patch.clearApiKey !== "boolean") {
      throw new ModelChangeError("invalid_boolean", "clearApiKey 必须是布尔值", { field: "clearApiKey" });
    }
    if (patch.clearApiKey === true && patch.apiKey) {
      throw new ModelChangeError("conflicting_fields", "clearApiKey 与 apiKey 不能同时提交", { field: "apiKey" });
    }
    const safePatch = {};
    if (patch.clearBaseUrl === true) safePatch.clearBaseUrl = true;
    if (patch.clearApiKey === true) safePatch.clearApiKey = true;
    if (patch.baseUrl !== undefined && patch.baseUrl !== null && patch.baseUrl !== "") {
      if (typeof patch.baseUrl !== "string") {
        throw new ModelChangeError("invalid_url", "baseUrl 必须是字符串", { field: "baseUrl" });
      }
      try {
        const parsed = new URL(patch.baseUrl.trim());
        if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
          throw new Error("invalid");
        }
        safePatch.baseUrl = patch.baseUrl.trim();
      } catch {
        throw new ModelChangeError("invalid_url", "baseUrl 必须是不含凭证的 HTTP(S) URL", { field: "baseUrl" });
      }
    }
    if (patch.api !== undefined && patch.api !== null && patch.api !== "") {
      if (typeof patch.api !== "string") {
        throw new ModelChangeError("invalid_string", "api 必须是字符串", { field: "api" });
      }
      safePatch.api = patch.api.trim();
    }
    if (patch.renameTo !== undefined && patch.renameTo !== null && patch.renameTo !== "") {
      if (typeof patch.renameTo !== "string" || !PROVIDER_KEY_RE.test(patch.renameTo.trim())) {
        throw new ModelChangeError("invalid_provider", "renameTo 格式不合法", { field: "renameTo" });
      }
      const renamed = patch.renameTo.trim();
      // 与原名相同视为未改名,不进 safeSpec(保持既有请求摘要稳定)
      if (renamed !== providerKey) safePatch.renameTo = renamed;
    }
    const safeSpec = Object.freeze({
      kind: "update-provider",
      providerKey,
      sourceModelId: null,
      sourceKey: modelIdentityKey(providerKey, "*"),
      targetKey: modelIdentityKey(safePatch.renameTo || providerKey, "*"),
      target: null,
      patch: Object.freeze(safePatch),
    });
    const secretEnvelope = typeof patch.apiKey === "string" && patch.apiKey
      ? Object.freeze({ apiKey: patch.apiKey })
      : null;
    return this._applyCompatSafe(backendId, safeSpec, secretEnvelope, operationId);
  }

  /**
   * 批量兼容入口:N 个「无凭证」变更(delete / 目录 rename / 目录 create)合并为
   * 后端的【一次】配置写(网关控制面 3 次/60s 限流按请求数计)。整批原子:
   * 单 patch 要么全落要么全不落;子项冲突抛错并在文案里标注第几项。
   * 不进 journal 状态机(每个子项幂等,失败由 UI 保留草稿整批重试)。
   */
  async batchCompat(backendId, items, { operationId = randomUUID(), confirmReferences = false, force = false, preservePrimaryRefs = false } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ModelChangeError("invalid_input", "批量项不能为空", { field: "items" });
    }
    if (items.length > 100) {
      throw new ModelChangeError("invalid_input", "批量项过多(上限 100)", { field: "items" });
    }
    const specs = items.map((item, index) => {
      try {
        if (!isPlainObject(item)) {
          throw new ModelChangeError("invalid_input", "批量项必须是对象", { field: `items[${index}]` });
        }
        if (item.op === "delete") {
          const spec = normalizeModelDeleteSpec({ providerKey: item.providerKey, modelId: item.modelId });
          if (spec.kind !== "delete-model") {
            throw new ModelChangeError("invalid_input", "批量删除必须带 modelId", { field: `items[${index}]` });
          }
          return spec;
        }
        const { safeSpec, secretEnvelope } = normalizeModelChangeRequest({
          providerKey: item.providerKey,
          providerMode: "existing",
          sourceModelId: item.sourceModelId,
          model: item.model,
        });
        if (secretEnvelope) {
          throw new ModelChangeError("invalid_input", "批量不支持携带凭证", { field: `items[${index}]` });
        }
        return safeSpec;
      } catch (err) {
        if (err instanceof ModelChangeError) throw err;
        throw new ModelChangeError("invalid_input", `第 ${index + 1} 项不合法: ${err?.message || err}`, { field: `items[${index}]` });
      }
    });
    const backend = this._backend(backendId);
    let caps = null;
    try {
      caps = cloneSafeJson(await backend.getModelConfigWriteCapabilities(), "configWriteCapabilities");
    } catch { /* caps 不可读按不支持 */ }
    if (!isPlainObject(caps) || caps.supported !== true || caps.batch !== true) {
      throw new ModelChangeError("batch_unsupported", "该后端不支持批量配置写", { status: 409 });
    }
    // Endpoint selection may remove a definition while leaving Agent bindings
    // alone. This opt-in does not apply to provider deletion or ordinary batches.
    const canPreservePrimaryRefs = preservePrimaryRefs === true
      && confirmReferences === true && caps.preservePrimaryRefs === true;
    const opId = normalizeOperationId(operationId);
    return this._withJournalLock(opId, "batch", async () => {
      if (confirmReferences) {
        // Endpoint reselection is one atomic patch. Inspect every removal before
        // writing anything. Primary bindings can only remain after confirmation.
        const references = new Map();
        const blockers = [];
        let canForce = true;
        let canApply = true;
        for (const spec of specs.filter((item) => item.kind === "delete-model")) {
          const preview = this._normalizePreviewOutput(await backend.previewModelChange(spec));
          // A lost response may be retried after the entire patch already landed.
          // An absent source is an idempotent no-op in the batch writer.
          const currentBlockers = preview.blockers.filter((item) => item.code !== "source_not_found");
          blockers.push(...currentBlockers);
          for (const reference of preview.references) {
            references.set(stableJson(reference), reference);
          }
          const eligibleBlockers = canPreservePrimaryRefs
            ? currentBlockers.filter((item) => item.code !== "primary_model_in_use") : currentBlockers;
          const eligible = await this._configOnlyEligible(backendId, spec, eligibleBlockers, { forced: force });
          canApply = canApply && Boolean(eligible);
          if (!eligible) {
            canForce = canForce && Boolean(await this._configOnlyEligible(backendId, spec, eligibleBlockers, { forced: true }));
          }
        }
        if (!canApply || (!force && references.size > 0)) {
          const uniqueBlockers = [...new Map(blockers.map((item) => [stableJson(item), item])).values()];
          return {
            operationId: opId, status: "blocked", stage: "preflight",
            code: uniqueBlockers.some((item) => item.code === "primary_model_in_use")
              ? "primary_model_in_use" : references.size > 0 ? "references_exist"
                : uniqueBlockers[0]?.code || "config_write_unsupported",
            canForce,
            references: [...references.values()], blockers: uniqueBlockers,
          };
        }
      }
      let raw;
      try {
        raw = await backend.applyModelChangeConfigOnlyBatch(specs, {
          preservePrimaryRefs: canPreservePrimaryRefs && force === true,
        });
      } catch (err) {
        if (err instanceof ModelChangeError) throw err;
        const index = Number.isInteger(err?.batchIndex) ? err.batchIndex : null;
        // 子项定位进文案(details 白名单可能滤掉自定义字段,message 最可靠)
        const prefix = index === null ? "" : `第 ${index + 1} 项失败: `;
        throw new ModelChangeError(
          typeof err?.code === "string" ? err.code : "batch_failed",
          `${prefix}${err?.message || err}`,
          { status: Number.isInteger(err?.status) ? err.status : 500, stage: "apply" },
        );
      }
      const normalized = this._normalizeApplyResult(raw);
      normalized.operationId = opId;
      // restartRequired=false ⇒ 本批写全部热生效，不附 activation（同 _applySafe 的判定）
      if (normalized.status === "applied" && isPlainObject(caps.activation) && normalized.restartRequired !== false) {
        normalized.activation = caps.activation;
      }
      return this._attachStrictCatalog(backendId, normalized);
    });
  }

  /** 模型/Provider DELETE 兼容入口：引用或 blocker 存在时必须在 journal.begin 前停止。 */
  async deleteCompat(backendId, ref, { operationId = randomUUID(), force = false } = {}) {
    const safeSpec = normalizeModelDeleteSpec(ref);
    const existing = this._existingOperation(
      normalizeOperationId(operationId),
      modelChangeRequestDigest(safeSpec),
    );
    if (existing) {
      return this._applySafe(backendId, safeSpec, null, {
        operationId,
        resumeByOperationId: true,
        force,
      });
    }
    const preview = await this._previewSafe(backendId, safeSpec);
    // 引用存在默认零写返回，供 UI 弹知情确认；force = 用户已确认引用将失效，照删。
    if (!force && preview.references.length > 0) {
      // Only the backend knows which capability blockers its confirmed delete
      // path can handle. Publish that decision instead of making the UI guess.
      const canForce = preview.blockers.length === 0
        || Boolean(await this._configOnlyEligible(backendId, safeSpec, preview.blockers, { forced: true }));
      return {
        status: "blocked",
        code: preview.blockers.some((item) => item.code === "primary_model_in_use")
          ? "primary_model_in_use" : "references_exist",
        stage: "preflight",
        canForce,
        references: preview.references,
        blockers: preview.blockers,
      };
    }
    if (preview.blockers.length > 0) {
      const configWrite = await this._configOnlyEligible(backendId, safeSpec, preview.blockers, { forced: force });
      if (!configWrite) return blockedResult(preview.blockers);
      return this._applySafe(backendId, safeSpec, null, {
        previewToken: preview.previewToken,
        operationId,
        resumeByOperationId: true,
        configOnly: true,
        force,
      });
    }
    return this._applySafe(backendId, safeSpec, null, {
      previewToken: preview.previewToken,
      operationId,
      resumeByOperationId: true,
      force,
    });
  }

  /** 根据持久提交点选择恢复权限；committed/cleanup_pending 永远只允许向前收敛。 */
  _recoveryMode(entry) {
    if (entry.commitState === "committed" || entry.status === "cleanup_pending") {
      return { recoveryMode: "forward-only", forwardOnly: true };
    }
    if (entry.commitState === "committing") {
      return { recoveryMode: "resolve-commit", forwardOnly: false };
    }
    return { recoveryMode: "precommit", forwardOnly: false };
  }

  /** 在与正常 apply 完全相同的进程锁和 Provider fencing 下恢复一条 journal。 */
  async _recoverEntry(entry) {
    const mutexKey = `${entry.backendId}\0${entry.providerKey}`;
    return this._withKeyedMutex(mutexKey, async () => {
      const providerScope = `${entry.backendId}:${entry.providerKey}`;
      return this.journal.withProviderLock(providerScope, entry.operationId, async (guard) => {
        guard.assertActive();
        const current = this.journal.get(entry.operationId);
        if (!current || TERMINAL_STATUSES.has(current.status)) return current?.result || null;
        if (current.status === "needs_secret") {
          return { status: "needs_secret", stage: current.stage };
        }
        if (current.secretStep === "pending") {
          const needsSecret = {
            status: "needs_secret",
            code: "recovery_input_required",
            stage: current.stage,
            operationId: current.operationId,
          };
          const updated = await this._guardedJournalMutation(
            guard,
            current.operationId,
            "recover-needs-secret",
            () => this.journal.finish(current.operationId, "needs_secret", needsSecret),
          );
          return updated.result;
        }

        const backend = this._backend(current.backendId);
        const mode = this._recoveryMode(current);
        const context = this._createBackendContext({
          guard,
          operationId: current.operationId,
          requestDigest: current.requestDigest,
          journalEntry: current,
          ...mode,
        });
        let result;
        try {
          guard.assertActive();
          // config-only 条目缺完整原始请求（baseUrl/api 不入 journal），启动恢复只做
          // 读回验证收敛；未写入的留给用户带完整表单重试。full 条目走后端恢复状态机。
          result = this._normalizeApplyResult(current.mode === "config-only"
            ? await backend.recoverModelChangeConfigOnly(current)
            : await backend.recoverModelChange(current, context));
          if (current.mode === "config-only" && result.status === "failed" && result.retryable !== false) {
            result.status = "partial";
          }
          if (result.code === "invalid_backend_result") {
            result = {
              status: "partial",
              code: "recovery_invalid_result",
              stage: "recovery",
              retryable: true,
            };
          }
          guard.assertActive();
          if (current.mode === "config-only" && current.fingerprints?.configOnlyRestartRequired === true) {
            const caps = await backend.getModelConfigWriteCapabilities();
            result = { ...result, restartRequired: true, activation: caps?.activation ?? null };
          }
          result = await this._attachStrictCatalog(current.backendId, result);
          guard.assertActive();
        } catch (error) {
          // journal/fencing 故障意味着无法证明独占权，禁止继续写任何恢复结论。
          if (String(error?.code || "").startsWith("journal_")) throw error;
          result = {
            status: "partial",
            code: "recovery_failed",
            stage: "recovery",
            retryable: true,
          };
        }
        const finalEntry = await this._guardedJournalMutation(
          guard,
          current.operationId,
          "recover-finish",
          () => this.journal.finish(current.operationId, result.status, result),
        );
        return finalEntry.result;
      });
    });
  }

  /**
   * 启动时扫描全部非终态 operation。needs_secret 留给用户续提；其它条目尽力收敛。
   * 单条未收敛 journal 仍会由 Provider pending 门禁隔离，不得把其它 Provider
   * 的 mutation readiness 永久关闭。Journal 根文件无法读取时 listPending 仍会 fail-closed。
   */
  async recoverPending() {
    this.ready = false;
    const pending = this.journal.listPending();
    const results = [];
    for (const entry of pending) {
      if (entry.status === "needs_secret") {
        results.push({ operationId: entry.operationId, status: "needs_secret" });
        continue;
      }
      try {
        const result = await this._recoverEntry(entry);
        results.push({ operationId: entry.operationId, result });
      } catch (error) {
        results.push({
          operationId: entry.operationId,
          error: {
            code: typeof error?.code === "string" ? error.code : "recovery_failed",
          },
        });
      }
    }
    return results;
  }
}

module.exports = { ModelChangeCoordinator };
