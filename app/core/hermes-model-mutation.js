"use strict";

// Hermes 模型 mutation gate：统一条件写能力判定、per-profile 串行和 Provider
// coordinator 授权。不可伪造 capability 只存在于本模块闭包与 AsyncLocalStorage。

const { AsyncLocalStorage } = require("node:async_hooks");

/** Hermes 条件写/授权错误，公开稳定 code/status 且不携带响应正文。 */
class HermesModelMutationError extends Error {
  constructor(code, message, { status = 409, store, profile } = {}) {
    super(message);
    this.name = "HermesModelMutationError";
    this.code = code;
    this.status = status;
    this.store = store;
    this.profile = profile;
  }
}

/** 把 Profile 输入归一为排序、去重、非空的稳定锁顺序。 */
function normalizeProfiles(profiles) {
  const result = [...new Set(
    (Array.isArray(profiles) ? profiles : [profiles])
      .map((profile) => String(profile || "").trim())
      .filter(Boolean),
  )].sort();
  if (result.length === 0) {
    throw new HermesModelMutationError("hermes_profile_required", "Hermes mutation 缺少 Profile");
  }
  return result;
}

/** 创建单例 gate；一个 backend 生命周期内必须始终复用同一实例。 */
function createHermesModelMutationGate({ now = Date.now } = {}) {
  if (typeof now !== "function") throw new TypeError("now 必须是函数");
  const tails = new Map();
  const profileContext = new AsyncLocalStorage();
  const coordinatorContext = new AsyncLocalStorage();
  const capability = Symbol("hermes-model-change-coordinator");

  /** 为单个 Profile 进入 FIFO；finally 必须推进并清理尾链。 */
  const withOneProfile = async (profile, run) => {
    const previous = tails.get(profile) || Promise.resolve();
    const ready = previous.catch(() => undefined);
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = ready.then(() => current);
    tails.set(profile, tail);
    await ready;
    try {
      return await run();
    } finally {
      release();
      if (tails.get(profile) === tail) tails.delete(profile);
    }
  };

  /** 同操作重入已持有的 Profile 时直接执行，避免公共 mutator 包装造成自锁。 */
  const withProfiles = async (profiles, operationId, run) => {
    if (typeof run !== "function") throw new TypeError("run 必须是函数");
    const ordered = normalizeProfiles(profiles);
    const active = profileContext.getStore();
    if (active && ordered.every((profile) => active.profiles.has(profile))) return run(active);
    const acquire = (index) => {
      if (index >= ordered.length) {
        const context = Object.freeze({
          operationId: String(operationId || "mutation"),
          profiles: new Set(ordered),
          acquiredAt: now(),
        });
        return profileContext.run(context, () => run(context));
      }
      return withOneProfile(ordered[index], () => acquire(index + 1));
    };
    return acquire(0);
  };

  /** 从白名单响应头建立 store 条件快照；缺任一证明字段都 fail-closed。 */
  const inspectStore = (response, store) => {
    const headers = response?.headers && typeof response.headers === "object" ? response.headers : {};
    const etag = typeof headers.etag === "string" ? headers.etag.trim() : "";
    const declaration = typeof headers["x-hermes-conditional-write"] === "string"
      ? headers["x-hermes-conditional-write"].trim().toLowerCase()
      : "";
    return Object.freeze({
      store: String(store || "unknown"),
      etag,
      declaration,
      mutationVersion: String(headers["x-hermes-mutation-version"] || ""),
      supported: Boolean(etag) && declaration === "if-match",
      inspectedAt: now(),
    });
  };

  /** 为已证明的 snapshot 生成唯一 If-Match header。 */
  const conditionalHeaders = (snapshot) => {
    if (!snapshot?.supported || typeof snapshot.etag !== "string" || !snapshot.etag) {
      throw new HermesModelMutationError(
        "hermes_conditional_write_unsupported",
        "Hermes dashboard 未声明安全条件写能力",
        { store: snapshot?.store },
      );
    }
    return { "If-Match": snapshot.etag };
  };

  /** 验证条件写响应；412/428 是并发冲突，其它失败使用不含正文的稳定错误。 */
  const assertConditionalSuccess = (response, snapshot) => {
    const status = Number(response?.status) || 0;
    if (status === 412 || status === 428) {
      throw new HermesModelMutationError(
        "hermes_write_conflict",
        "Hermes 配置已被其它写入更新，请重新加载",
        { store: snapshot?.store },
      );
    }
    if (status < 200 || status >= 300) {
      throw new HermesModelMutationError(
        "hermes_conditional_write_failed",
        "Hermes 条件写失败",
        { status: 502, store: snapshot?.store },
      );
    }
    return true;
  };

  /** 在 coordinator 闭包内绑定不可伪造 capability；异步子调用自动继承。 */
  const withCoordinatorContext = async (operationId, run) => {
    if (typeof run !== "function") throw new TypeError("run 必须是函数");
    const context = Object.freeze({
      capability,
      operationId: String(operationId || "").trim(),
      enteredAt: now(),
    });
    if (!context.operationId) {
      throw new HermesModelMutationError("invalid_operation_id", "Hermes coordinator operationId 不能为空");
    }
    return coordinatorContext.run(context, () => run(context));
  };

  /** Provider CRUD 在首次读取前调用；闭包外一律零 I/O 拒绝。 */
  const assertCoordinatorContext = () => {
    const context = coordinatorContext.getStore();
    if (!context || context.capability !== capability) {
      throw new HermesModelMutationError(
        "model_change_coordinator_required",
        "模型变更必须由 ModelChangeCoordinator 执行",
      );
    }
    return { operationId: context.operationId, enteredAt: context.enteredAt };
  };

  return Object.freeze({
    inspectStore,
    withProfiles,
    conditionalHeaders,
    assertConditionalSuccess,
    withCoordinatorContext,
    assertCoordinatorContext,
  });
}

module.exports = {
  HermesModelMutationError,
  createHermesModelMutationGate,
};
