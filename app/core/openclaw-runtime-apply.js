"use strict";

// OpenClaw 模型运行态收敛控制器。它只依赖 backend、进程内 admission gate 与
// 外部 supervisor 契约，不反向 import openclaw-host，避免组合根循环依赖。

const TASK_PROBE_LIMIT = 201;

/** 运行态能力、忙碌或 supervisor 失败的稳定阻断错误。 */
class OpenClawRuntimeApplyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpenClawRuntimeApplyError";
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

/** 等待指定毫秒；测试可注入无副作用 sleep。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将 backend 当前版本、URL 与连接代际编码为能力缓存键。 */
function runtimeIdentityKey(identity) {
  return JSON.stringify([
    String(identity?.gatewayVersion || ""),
    String(identity?.upstreamUrl || ""),
    Number.isSafeInteger(identity?.connectionGeneration) ? identity.connectionGeneration : 0,
  ]);
}

/** 读取 backend 明确公开的运行态身份，不从本机 CLI 版本猜远程 gateway。 */
function readRuntimeIdentity(backend) {
  if (typeof backend?.getModelRuntimeIdentity === "function") {
    const value = backend.getModelRuntimeIdentity();
    return value && typeof value === "object" ? value : {};
  }
  return {};
}

/** 把 supervisor capability 固定为四个布尔值，缺失一律 false。 */
function supervisorCapabilities(supervisor) {
  const capabilities = supervisor?.capabilities || {};
  return {
    drain: capabilities.drain === true,
    recoverDrain: capabilities.recoverDrain === true,
    restartPaused: capabilities.restartPaused === true,
    waitHealthy: capabilities.waitHealthy === true,
  };
}

/**
 * 创建 runtime apply controller。hot/restart 缓存只对当前 gateway identity 有效；
 * 连接代际或版本变化立即回到 unknown。
 */
function createOpenClawRuntimeApply({
  backend,
  admissionGate,
  supervisor = null,
  now = Date.now,
  sleep = defaultSleep,
  hotWaitMs = 5_000,
  healthWaitMs = 30_000,
  pollMs = 100,
  drainTtlMs = 30_000,
  admissionIdleMs = 5_000,
} = {}) {
  if (!backend || typeof backend !== "object") throw new TypeError("backend 必须是对象");
  if (!admissionGate || typeof admissionGate.beginDrain !== "function") {
    throw new TypeError("admissionGate 必须提供 beginDrain");
  }
  if (typeof now !== "function" || typeof sleep !== "function") throw new TypeError("now/sleep 必须是函数");
  const modeCache = new Map();
  let lastIdentityKey = null;

  /** gateway identity 改变时清空旧 allowlist，防止把旧版本的 hot 结论带到新连接。 */
  const currentIdentity = () => {
    const identity = readRuntimeIdentity(backend);
    const key = runtimeIdentityKey(identity);
    if (lastIdentityKey !== null && key !== lastIdentityKey) modeCache.clear();
    lastIdentityKey = key;
    return { identity, key };
  };

  /** 只接受明确 capability 或本控制器真实验证过的 mode。 */
  const inspect = async () => {
    const { identity, key } = currentIdentity();
    const cached = modeCache.get(key);
    if (cached) return { mode: cached, safeApply: true, identity, topology: supervisor?.topology || "unknown" };
    let declared = {};
    if (typeof backend.getModelRuntimeApplyCapabilities === "function") {
      declared = await backend.getModelRuntimeApplyCapabilities();
    }
    let mode = "unknown";
    if (declared?.mode === "hot" && declared?.verified === true) mode = "hot";
    else if (declared?.mode === "restart-required") mode = "restart-required";
    const capabilities = supervisorCapabilities(supervisor);
    const safeApply = mode === "hot" || (
      capabilities.drain
      && capabilities.restartPaused
      && capabilities.waitHealthy
      && typeof supervisor?.acquireDrain === "function"
      && typeof supervisor?.restartPaused === "function"
      && typeof supervisor?.waitHealthy === "function"
    );
    return { mode, safeApply, identity, topology: supervisor?.topology || "unknown" };
  };

  /** 把当前 identity 的真实 apply 结果写入 allowlist。 */
  const cacheMode = (mode) => {
    if (mode !== "hot" && mode !== "restart-required") return;
    const { key } = currentIdentity();
    modeCache.set(key, mode);
  };

  /** restart/unknown 路径必须具备完整 drain + paused restart + health 契约。 */
  const requireSupervisor = (mode) => {
    if (mode === "hot") return;
    const capabilities = supervisorCapabilities(supervisor);
    const restartCallable = typeof supervisor?.restartPaused === "function"
      && typeof supervisor?.waitHealthy === "function";
    if (supervisor?.topology === "remote"
      && (!capabilities.restartPaused || !capabilities.waitHealthy || !restartCallable)) {
      throw new OpenClawRuntimeApplyError(
        "runtime_restart_unavailable",
        "远程 OpenClaw 未配置认证 restart/health controller",
      );
    }
    if (!capabilities.drain
      || !capabilities.restartPaused
      || !capabilities.waitHealthy
      || typeof supervisor?.acquireDrain !== "function"
      || !restartCallable) {
      throw new OpenClawRuntimeApplyError(
        "runtime_drain_unsupported",
        "OpenClaw 缺少安全 drain/paused restart/health 能力",
      );
    }
  };

  /** supervisor lease 归一化；token/renew/release 任一缺失都不允许继续。 */
  const normalizeSupervisorLease = (lease, operationId) => {
    if (!lease
      || typeof lease.token !== "string"
      || !lease.token
      || typeof lease.renew !== "function"
      || typeof lease.release !== "function") {
      throw new OpenClawRuntimeApplyError(
        "runtime_drain_unsupported",
        "supervisor drain lease 契约不完整",
        { operationId },
      );
    }
    return {
      token: lease.token,
      operationId: lease.operationId || operationId,
      expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : now() + drainTtlMs,
      renew: () => lease.renew(),
      release: () => lease.release(),
    };
  };

  /** tasks.list 必须显式 supported、完整且为空；limit 命中也不猜测末页。 */
  const assertRuntimeIdle = async () => {
    let result;
    try {
      if (typeof backend.listModelRuntimeTasks === "function") {
        result = await backend.listModelRuntimeTasks({ limit: TASK_PROBE_LIMIT });
      } else if (typeof backend.request === "function") {
        result = await backend.request("tasks.list", { limit: TASK_PROBE_LIMIT });
      }
    } catch (error) {
      throw new OpenClawRuntimeApplyError(
        "runtime_drain_unsupported",
        "tasks.list 探测失败",
        { reason: error?.message || String(error) },
      );
    }
    const tasks = Array.isArray(result?.tasks) ? result.tasks : null;
    if (result?.supported !== true
      || tasks === null
      || result?.truncated === true
      || result?.hasMore === true
      || tasks.length >= TASK_PROBE_LIMIT) {
      throw new OpenClawRuntimeApplyError(
        "runtime_drain_unsupported",
        "tasks.list 未证明完整且受支持",
      );
    }
    if (tasks.length > 0) {
      throw new OpenClawRuntimeApplyError(
        "runtime_busy",
        "OpenClaw 仍有运行中任务",
        { tasks: tasks.map((task) => task?.id || task?.key || "unknown").slice(0, 20) },
      );
    }
  };

  /** 默认回读 config.get + models.list；测试/新网关可提供更严格的 backend verifier。 */
  const verifyTargetOnce = async (safeSpec, expectedConfig) => {
    if (typeof backend.verifyModelTarget === "function") {
      return (await backend.verifyModelTarget(safeSpec, expectedConfig)) === true;
    }
    if (typeof expectedConfig?.verify === "function") {
      return (await expectedConfig.verify()) === true;
    }
    if (typeof backend.request !== "function") return false;
    try {
      const [config, runtime] = await Promise.all([
        backend.request("config.get", {}),
        backend.request("models.list", {}),
      ]);
      const providerKey = String(safeSpec?.providerKey || "");
      const targetId = String(safeSpec?.model?.id || "");
      /** 比较请求中明确给出的普通字段，避免同 ID 旧内容被误判为已收敛。 */
      const matchesContent = (model) => {
        if (!model || typeof model !== "object") return false;
        for (const field of ["name", "contextWindow", "maxTokens", "reasoning"]) {
          if (Object.prototype.hasOwnProperty.call(safeSpec?.model || {}, field)
            && model[field] !== safeSpec.model[field]) return false;
        }
        return true;
      };
      const configured = Array.isArray(config?.parsed?.models?.providers?.[providerKey]?.models)
        && config.parsed.models.providers[providerKey].models.some((model) => (
          model?.id === targetId && matchesContent(model)
        ));
      const runtimeReady = Array.isArray(runtime?.models)
        && runtime.models.some((model) => {
          const identityMatches = (model?.provider === providerKey && model?.id === targetId)
            || model?.id === `${providerKey}/${targetId}`;
          return identityMatches && matchesContent(model);
        });
      return configured && runtimeReady;
    } catch {
      return false;
    }
  };

  /** 在限定窗口轮询目标配置与运行目录是否同时收敛。 */
  const waitForTarget = async (safeSpec, expectedConfig, timeoutMs, checkpoint) => {
    const deadline = now() + Math.max(0, timeoutMs);
    do {
      checkpoint?.();
      if (await verifyTargetOnce(safeSpec, expectedConfig)) return true;
      if (now() >= deadline) return false;
      await sleep(Math.max(1, Math.min(pollMs, deadline - now())));
    } while (now() <= deadline);
    return false;
  };

  /** 创建持有本地 gate 与可选 supervisor lease 的 apply handle。 */
  const createApplyHandle = ({ mode, operationId, localDrain, supervisorLease }) => {
    let released = false;
    let heartbeatError = null;
    let renewalTail = Promise.resolve();
    let timer = null;

    if (supervisorLease) {
      timer = setInterval(() => {
        renewalTail = renewalTail
          .then(() => supervisorLease.renew())
          .then((renewed) => {
            supervisorLease.expiresAt = Number.isFinite(renewed?.expiresAt)
              ? renewed.expiresAt
              : now() + drainTtlMs;
          })
          .catch((error) => {
            heartbeatError ||= new OpenClawRuntimeApplyError(
              "runtime_drain_lost",
              "supervisor drain lease 续租失败",
              { reason: error?.message || String(error) },
            );
          });
      }, Math.max(5, Math.floor(drainTtlMs / 3)));
      if (typeof timer.unref === "function") timer.unref();
    }

    /** 每个写入、重启、健康检查前调用，续租失败后立即停止后续动作。 */
    const checkpoint = () => {
      if (released) throw new OpenClawRuntimeApplyError("runtime_drain_lost", "runtime lease 已释放");
      if (heartbeatError) throw heartbeatError;
    };

    /** 在同一 lease 内完成 hot 探测或 paused restart，并缓存真实 mode。 */
    const verifyTarget = async (safeSpec, expectedConfig) => {
      checkpoint();
      if (mode === "hot") {
        if (await waitForTarget(safeSpec, expectedConfig, hotWaitMs, checkpoint)) return true;
        throw new OpenClawRuntimeApplyError("runtime_target_not_ready", "hot apply 后运行目录未收敛");
      }
      if (mode === "unknown"
        && await waitForTarget(safeSpec, expectedConfig, hotWaitMs, checkpoint)) {
        cacheMode("hot");
        return true;
      }
      checkpoint();
      try {
        await supervisor.restartPaused({
          token: supervisorLease.token,
          operationId,
          expiresAt: supervisorLease.expiresAt,
        });
      } catch (error) {
        throw new OpenClawRuntimeApplyError(
          "runtime_restart_failed",
          "OpenClaw paused restart 失败",
          { reason: error?.message || String(error) },
        );
      }
      checkpoint();
      let healthy;
      try {
        healthy = await supervisor.waitHealthy({
          token: supervisorLease.token,
          operationId,
          timeoutMs: healthWaitMs,
        });
      } catch (error) {
        throw new OpenClawRuntimeApplyError(
          "runtime_health_failed",
          "OpenClaw restart 后健康检查失败",
          { reason: error?.message || String(error) },
        );
      }
      if (healthy !== true) {
        throw new OpenClawRuntimeApplyError("runtime_health_failed", "OpenClaw restart 后未恢复健康");
      }
      checkpoint();
      if (!await waitForTarget(safeSpec, expectedConfig, healthWaitMs, checkpoint)) {
        throw new OpenClawRuntimeApplyError("runtime_target_not_ready", "restart 后目标模型未进入运行目录");
      }
      cacheMode("restart-required");
      return true;
    };

    /** source retire 后收敛运行目录；backend 可提供删除残影的专用 verifier。 */
    const convergeAfterRetire = async (safeSpec) => {
      checkpoint();
      if (typeof backend.convergeModelRuntimeAfterRetire === "function") {
        return backend.convergeModelRuntimeAfterRetire(safeSpec, {
          token: supervisorLease?.token || null,
          checkpoint,
        });
      }
      return true;
    };

    /** 等待在途 renew 后先释放 supervisor，再打开本地工作入口。 */
    const release = async () => {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      let releaseError = null;
      try {
        await renewalTail;
        await supervisorLease?.release();
      } catch (error) {
        releaseError = error;
      } finally {
        localDrain.release();
      }
      if (releaseError) {
        throw new OpenClawRuntimeApplyError(
          "runtime_drain_release_failed",
          "runtime drain lease 释放失败",
          { reason: releaseError?.message || String(releaseError) },
        );
      }
    };

    return Object.freeze({
      mode,
      token: supervisorLease?.token || localDrain.token,
      operationId,
      checkpoint,
      verifyTarget,
      convergeAfterRetire,
      release,
    });
  };

  /** 取得本地 gate；restart/unknown 再取得 supervisor lease 并证明 tasks idle。 */
  const acquireForApply = async (runtimeRequirement = {}) => {
    const inspected = await inspect();
    const mode = ["hot", "restart-required", "unknown"].includes(runtimeRequirement?.mode)
      ? runtimeRequirement.mode
      : inspected.mode;
    const operationId = String(runtimeRequirement?.operationId || "").trim();
    if (!operationId) throw new OpenClawRuntimeApplyError("runtime_operation_required", "operationId 不能为空");
    requireSupervisor(mode);
    const localDrain = admissionGate.beginDrain("openclaw", `model-apply:${operationId}`);
    let supervisorLease = null;
    let applyHandle = null;
    try {
      if (!await localDrain.waitForIdle(admissionIdleMs)) {
        throw new OpenClawRuntimeApplyError("runtime_busy", "本地工作入口未在时限内退出");
      }
      if (mode !== "hot") {
        const rawLease = await supervisor.acquireDrain({ operationId, ttlMs: drainTtlMs });
        try {
          supervisorLease = normalizeSupervisorLease(rawLease, operationId);
        } catch (error) {
          try { await rawLease?.release?.(); } catch { /* 保留契约错误 */ }
          throw error;
        }
        // lease 一取得就开始 TTL/3 续租；tasks.list 可能很慢，不能等探测后才启动心跳。
        applyHandle = createApplyHandle({ mode, operationId, localDrain, supervisorLease });
        await assertRuntimeIdle();
      }
      return applyHandle || createApplyHandle({ mode, operationId, localDrain, supervisorLease });
    } catch (error) {
      if (applyHandle) {
        try { await applyHandle.release(); } catch { /* 保留原始阻断原因 */ }
      } else {
        try { await supervisorLease?.release(); } catch { /* 保留原始阻断原因 */ }
        localDrain.release();
      }
      throw error;
    }
  };

  /** journal 恢复优先恢复同 operationId lease，失败再原子取得新 lease。 */
  const recoverLease = async (operationIdValue, runtimeRequirement = {}) => {
    const operationId = String(operationIdValue || "").trim();
    if (!operationId) throw new OpenClawRuntimeApplyError("runtime_operation_required", "operationId 不能为空");
    const inspected = await inspect();
    const mode = ["hot", "restart-required", "unknown"].includes(runtimeRequirement?.mode)
      ? runtimeRequirement.mode
      : inspected.mode;
    requireSupervisor(mode);
    if (mode === "hot") return acquireForApply({ operationId, mode });
    const localDrain = admissionGate.beginDrain("openclaw", `model-recover:${operationId}`);
    let supervisorLease = null;
    let applyHandle = null;
    try {
      if (!await localDrain.waitForIdle(admissionIdleMs)) {
        throw new OpenClawRuntimeApplyError("runtime_busy", "恢复时本地工作入口未退出");
      }
      let recovered = null;
      if (supervisorCapabilities(supervisor).recoverDrain && typeof supervisor.recoverDrain === "function") {
        try { recovered = await supervisor.recoverDrain({ operationId, ttlMs: drainTtlMs }); } catch { /* 尝试重新取得 */ }
      }
      if (!recovered) {
        try {
          recovered = await supervisor.acquireDrain({ operationId, ttlMs: drainTtlMs });
        } catch (error) {
          throw new OpenClawRuntimeApplyError(
            "runtime_drain_unsupported",
            "无法恢复或重新取得 supervisor drain lease",
            { reason: error?.message || String(error) },
          );
        }
      }
      try {
        supervisorLease = normalizeSupervisorLease(recovered, operationId);
      } catch (error) {
        try { await recovered?.release?.(); } catch { /* 保留契约错误 */ }
        throw error;
      }
      applyHandle = createApplyHandle({ mode, operationId, localDrain, supervisorLease });
      await assertRuntimeIdle();
      return applyHandle;
    } catch (error) {
      if (applyHandle) {
        try { await applyHandle.release(); } catch { /* 保留原始恢复错误 */ }
      } else {
        try { await supervisorLease?.release(); } catch { /* 保留原始恢复错误 */ }
        localDrain.release();
      }
      throw error;
    }
  };

  /** 无 lease 的公开 verifier 只做回读，不允许隐式重启。 */
  const verifyTarget = async (safeSpec, expectedConfig) => verifyTargetOnce(safeSpec, expectedConfig);

  /** 无 lease 的收敛接口只委托纯回读/缓存收敛，不触发 restart。 */
  const convergeAfterRetire = async (safeSpec) => {
    if (typeof backend.convergeModelRuntimeAfterRetire === "function") {
      return backend.convergeModelRuntimeAfterRetire(safeSpec, { token: null, checkpoint() {} });
    }
    return true;
  };

  /** backend 连接回调主动调用时立即清空全部 mode allowlist。 */
  const invalidateConnectionGeneration = () => {
    modeCache.clear();
    lastIdentityKey = null;
  };

  return Object.freeze({
    inspect,
    acquireForApply,
    recoverLease,
    verifyTarget,
    convergeAfterRetire,
    invalidateConnectionGeneration,
  });
}

module.exports = { OpenClawRuntimeApplyError, createOpenClawRuntimeApply };
