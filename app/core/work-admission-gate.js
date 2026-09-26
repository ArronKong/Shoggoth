"use strict";

const { randomUUID } = require("node:crypto");

/** 模型变更 drain 期间拒绝新工作入口的稳定错误。 */
class WorkAdmissionError extends Error {
  constructor(backendId, kind) {
    super(`后端 ${backendId} 正在切换模型，暂时不能启动 ${kind}`);
    this.name = "WorkAdmissionError";
    this.code = "gateway_draining";
    this.status = 409;
    this.backendId = backendId;
    this.kind = kind;
  }
}

/** 校验 gate 的 backend/kind/reason 标识，避免空键共享同一个状态桶。 */
function requiredLabel(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

/**
 * 创建进程内工作准入闸门。它只覆盖一次请求的转发窗口；后台任务是否仍在运行
 * 由后续 runtime supervisor 的权威状态判断，不能用 activeAdmissions 代替。
 */
function createWorkAdmissionGate() {
  const states = new Map();

  /** 读取或创建某个 backend 的独立状态，所有 token 操作都在同一事件循环内原子完成。 */
  const stateFor = (backendId) => {
    let state = states.get(backendId);
    if (!state) {
      state = { active: 0, drains: new Map(), waiters: new Set() };
      states.set(backendId, state);
    }
    return state;
  };

  /** 无活动、无 drain、无等待者时清理空桶，避免长期运行积累 backend ID。 */
  const cleanup = (backendId, state) => {
    if (state.active === 0 && state.drains.size === 0 && state.waiters.size === 0) {
      states.delete(backendId);
    }
  };

  /** active 归零时一次性唤醒全部 idle 等待者。 */
  const notifyIdle = (backendId, state) => {
    if (state.active !== 0) return;
    for (const waiter of [...state.waiters]) {
      state.waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    cleanup(backendId, state);
  };

  /**
   * 尝试进入一个短工作入口。drain token 先于此检查写入，因此 beginDrain 与 enter
   * 不存在“检查为空后才关闭”的竞态。成功时返回幂等 leave。
   */
  const enter = (backendIdValue, kindValue) => {
    const backendId = requiredLabel(backendIdValue, "backendId");
    const kind = requiredLabel(kindValue, "kind");
    const state = stateFor(backendId);
    if (state.drains.size > 0) throw new WorkAdmissionError(backendId, kind);
    state.active += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      state.active = Math.max(0, state.active - 1);
      notifyIdle(backendId, state);
    };
  };

  /**
   * 原子关闭 backend 新入口并返回独立 drain lease。多个调用方并发 drain 时，只有
   * 最后一个 token release 后才会重新开放。
   */
  const beginDrain = (backendIdValue, reasonValue) => {
    const backendId = requiredLabel(backendIdValue, "backendId");
    const reason = requiredLabel(reasonValue, "reason");
    const state = stateFor(backendId);
    const token = randomUUID();
    state.drains.set(token, reason);
    let released = false;

    /** 等待 beginDrain 前已进入的短 admission 退出；超时返回 false，不抛异常。 */
    const waitForIdle = (timeoutMs = 0) => {
      if (state.active === 0) return Promise.resolve(true);
      const timeout = Number(timeoutMs);
      if (!Number.isFinite(timeout) || timeout <= 0) return Promise.resolve(false);
      return new Promise((resolve) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          if (!state.waiters.delete(waiter)) return;
          resolve(false);
          cleanup(backendId, state);
        }, timeout);
        state.waiters.add(waiter);
      });
    };

    /** 只释放当前 lease，重复调用无副作用。 */
    const release = () => {
      if (released) return;
      released = true;
      state.drains.delete(token);
      cleanup(backendId, state);
    };

    return Object.freeze({ token, waitForIdle, release });
  };

  /** 返回不含可变集合引用的诊断快照。 */
  const snapshot = (backendIdValue) => {
    const backendId = requiredLabel(backendIdValue, "backendId");
    const state = states.get(backendId);
    return {
      backendId,
      activeAdmissions: state?.active ?? 0,
      draining: Boolean(state && state.drains.size > 0),
      drainCount: state?.drains.size ?? 0,
      reasons: state ? [...state.drains.values()] : [],
    };
  };

  return Object.freeze({ enter, beginDrain, snapshot });
}

module.exports = { WorkAdmissionError, createWorkAdmissionGate };
