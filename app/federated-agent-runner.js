"use strict";

const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const {
  FEDERATION_AGENT_MESSAGE_SOURCE_TOOL,
  FEDERATION_AGENT_RUN_SOURCE_TOOL,
  createFederationInputProvenance,
} = require("./federation-chat-provenance");

function runnerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function terminalText(payload) {
  const content = payload?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function brokerUrl(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/__chatws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function runFederatedAgentViaBroker(options = {}) {
  if (typeof options.origin !== "string" || !options.origin
    || typeof options.agentId !== "string" || !options.agentId
    || typeof options.prompt !== "string" || !options.prompt
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 5_000
    || options.timeoutMs > 120_000) {
    return Promise.reject(runnerError("AGENT_OPERATION_FAILED"));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(brokerUrl(options.origin), { origin: options.origin });
    const pending = new Map();
    let seq = 0;
    let sessionKey = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of pending.values()) entry.reject(runnerError("AGENT_OPERATION_FAILED"));
      pending.clear();
      try { ws.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(runnerError("AGENT_RUN_TIMEOUT")), options.timeoutMs);
    const send = (method, params) => new Promise((resolveRpc, rejectRpc) => {
      const id = `federation-${++seq}`;
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc });
      try { ws.send(JSON.stringify({ type: "req", id, method, params })); } catch {
        pending.delete(id);
        rejectRpc(runnerError("AGENT_OPERATION_FAILED"));
      }
    });
    ws.on("open", async () => {
      try {
        const created = await send("sessions.create", { agentId: options.agentId });
        sessionKey = created?.payload?.key;
        if (typeof sessionKey !== "string" || !sessionKey) throw runnerError("AGENT_OPERATION_FAILED");
        await send("chat.send", {
          sessionKey,
          message: options.prompt,
          idempotencyKey: crypto.randomUUID(),
          systemInputProvenance: createFederationInputProvenance(
            FEDERATION_AGENT_RUN_SOURCE_TOOL,
          ),
        });
      } catch (error) { finish(error?.code ? error : runnerError("AGENT_OPERATION_FAILED")); }
    });
    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (frame?.type === "res" && frame.id != null) {
        const entry = pending.get(String(frame.id));
        if (!entry) return;
        pending.delete(String(frame.id));
        if (frame.ok === false) entry.reject(runnerError("AGENT_OPERATION_FAILED"));
        else entry.resolve(frame);
        return;
      }
      if (frame?.type !== "event" || frame.event !== "chat"
        || frame.payload?.sessionKey !== sessionKey) return;
      if (frame.payload.state === "final") {
        finish(null, { sessionKey, text: terminalText(frame.payload) });
      } else if (frame.payload.state === "error") {
        finish(runnerError("AGENT_OPERATION_FAILED"));
      } else if (frame.payload.state === "prompt") {
        // 联邦委派没有可靠的嵌套确认通道；需要交互时严格失败，不替用户作答。
        finish(runnerError("AGENT_OPERATION_FAILED"));
      }
    });
    ws.on("error", () => finish(runnerError("APP_HOST_UNAVAILABLE")));
    ws.on("close", () => {
      if (!settled) finish(runnerError("APP_HOST_UNAVAILABLE"));
    });
  });
}

const TASK_TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const MAX_TASKS = 128;
const CONTROL_RPC_TIMEOUT_MS = 4_000;

function boundedOutput(value, maxBytes = 32 * 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch {}
  }
  return "";
}

class FederatedAgentTaskRunner {
  constructor(options = {}) {
    if (typeof options.origin !== "string" || !options.origin
      || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")
      || (options.WebSocket !== undefined && typeof options.WebSocket !== "function")) {
      throw new TypeError("FederatedAgentTaskRunner 配置无效");
    }
    this.origin = options.origin;
    this.WebSocket = options.WebSocket || WebSocket;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.tasks = new Map();
    this.closed = false;
  }

  async run(input) {
    if (this.closed || !this.#validRun(input)) throw runnerError("AGENT_OPERATION_FAILED");
    this.#reserveCapacity();
    let taskId;
    try { taskId = `federation-${this.randomUUID()}`; } catch {
      throw runnerError("AGENT_OPERATION_FAILED");
    }
    const task = {
      taskId,
      backendId: input.backendId,
      agentId: input.agentId,
      initialPrompt: input.prompt,
      sessionKey: null,
      status: "starting",
      turn: 1,
      result: null,
      errorCode: null,
      timeoutMs: input.timeoutMs,
      timer: null,
      socket: null,
      sequence: 0,
      pending: new Map(),
      startSettled: false,
      resolveStart: null,
      rejectStart: null,
    };
    this.tasks.set(taskId, task);
    const started = new Promise((resolve, reject) => {
      task.resolveStart = resolve;
      task.rejectStart = reject;
    });
    this.#arm(task);
    try {
      task.socket = new this.WebSocket(brokerUrl(this.origin), { origin: this.origin });
      this.#bind(task);
    } catch {
      this.#fail(task, "APP_HOST_UNAVAILABLE");
    }
    return started;
  }

  async message(input) {
    const task = this.#task(input);
    if (!Number.isSafeInteger(input.expectedTurn) || input.expectedTurn !== task.turn) {
      throw runnerError("FEDERATION_TASK_STATE_CONFLICT");
    }
    if (!TASK_TERMINAL_STATUSES.has(task.status)) {
      throw runnerError("FEDERATION_TASK_STATE_CONFLICT");
    }
    if (!task.socket || task.socket.readyState !== this.WebSocket.OPEN) {
      throw runnerError("APP_HOST_UNAVAILABLE");
    }
    task.turn += 1;
    task.status = "running";
    task.result = null;
    task.errorCode = null;
    task.timeoutMs = input.timeoutMs;
    this.#arm(task);
    try {
      await this.#rpc(task, "chat.send", {
        sessionKey: task.sessionKey,
        message: input.prompt,
        idempotencyKey: this.randomUUID(),
        systemInputProvenance: createFederationInputProvenance(
          FEDERATION_AGENT_MESSAGE_SOURCE_TOOL,
        ),
      });
    } catch (error) {
      this.#fail(task, error?.code || "AGENT_OPERATION_FAILED");
      throw error?.code ? error : runnerError("AGENT_OPERATION_FAILED");
    }
    return this.#public(task);
  }

  get(input) {
    return this.#public(this.#task(input));
  }

  async cancel(input) {
    const task = this.#task(input);
    if (TASK_TERMINAL_STATUSES.has(task.status)) return this.#public(task);
    if (!task.socket || task.socket.readyState !== this.WebSocket.OPEN || !task.sessionKey) {
      throw runnerError("APP_HOST_UNAVAILABLE");
    }
    await this.#rpc(task, "chat.abort", {
      sessionKey: task.sessionKey,
    }, CONTROL_RPC_TIMEOUT_MS);
    this.#finish(task, "canceled", null, null);
    return this.#public(task);
  }

  close() {
    if (this.closed) return;
    this.reset();
    this.closed = true;
  }

  reset() {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (!TASK_TERMINAL_STATUSES.has(task.status)) {
        this.#fail(task, "APP_HOST_UNAVAILABLE");
      }
      for (const pending of task.pending.values()) {
        pending.reject(runnerError("APP_HOST_UNAVAILABLE"));
      }
      task.pending.clear();
      try { task.socket?.close(); } catch {}
    }
    this.tasks.clear();
  }

  #validRun(input) {
    return input && typeof input === "object"
      && ["openclaw", "hermes"].includes(input.backendId)
      && typeof input.agentId === "string" && input.agentId.length > 0
      && typeof input.prompt === "string" && input.prompt.length > 0
      && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 5_000
      && input.timeoutMs <= 120_000;
  }

  #task(input) {
    if (this.closed || !input || typeof input.taskId !== "string") {
      throw runnerError("FEDERATION_TASK_NOT_FOUND");
    }
    const task = this.tasks.get(input.taskId);
    if (!task || task.backendId !== input.backendId || task.agentId !== input.agentId) {
      throw runnerError("FEDERATION_TASK_NOT_FOUND");
    }
    return task;
  }

  #reserveCapacity() {
    if (this.tasks.size < MAX_TASKS) return;
    const evictable = [...this.tasks.values()].find((task) => TASK_TERMINAL_STATUSES.has(task.status));
    if (!evictable) throw runnerError("APP_HOST_UNAVAILABLE");
    this.tasks.delete(evictable.taskId);
    try { evictable.socket?.close(); } catch {}
  }

  #bind(task) {
    task.socket.on("open", async () => {
      try {
        const created = await this.#rpc(task, "sessions.create", { agentId: task.agentId });
        task.sessionKey = created?.payload?.key;
        if (typeof task.sessionKey !== "string" || !task.sessionKey) {
          throw runnerError("AGENT_OPERATION_FAILED");
        }
        task.status = "running";
        await this.#rpc(task, "chat.send", {
          sessionKey: task.sessionKey,
          message: task.initialPrompt,
          idempotencyKey: this.randomUUID(),
          systemInputProvenance: createFederationInputProvenance(
            FEDERATION_AGENT_RUN_SOURCE_TOOL,
          ),
        });
        this.#resolveStart(task);
      } catch (error) {
        this.#fail(task, error?.code || "AGENT_OPERATION_FAILED");
      }
    });
    task.socket.on("message", (raw) => this.#onMessage(task, raw));
    task.socket.on("error", () => this.#fail(task,
      task.startSettled ? "AGENT_OPERATION_FAILED" : "APP_HOST_UNAVAILABLE"));
    task.socket.on("close", () => {
      if (!TASK_TERMINAL_STATUSES.has(task.status)) this.#fail(task, "APP_HOST_UNAVAILABLE");
    });
  }

  #onMessage(task, raw) {
    let frame;
    try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (frame?.type === "res" && frame.id != null) {
      const pending = task.pending.get(String(frame.id));
      if (!pending) return;
      task.pending.delete(String(frame.id));
      if (frame.ok === false) pending.reject(runnerError("AGENT_OPERATION_FAILED"));
      else pending.resolve(frame);
      return;
    }
    if (frame?.type !== "event" || frame.event !== "chat"
      || frame.payload?.sessionKey !== task.sessionKey) return;
    if (frame.payload.state === "final") {
      this.#finish(task, "completed", boundedOutput(terminalText(frame.payload)), null);
    } else if (frame.payload.state === "error") {
      this.#fail(task, "AGENT_OPERATION_FAILED");
    } else if (frame.payload.state === "prompt") {
      clearTimeout(task.timer);
      task.timer = null;
      task.status = "waiting_input";
      this.#resolveStart(task);
    }
  }

  #rpc(task, method, params, timeoutMs = null) {
    return new Promise((resolve, reject) => {
      if (!task.socket || task.socket.readyState !== this.WebSocket.OPEN) {
        reject(runnerError("APP_HOST_UNAVAILABLE"));
        return;
      }
      const id = `federation-task-${++task.sequence}`;
      let timer = null;
      const settle = (action, value) => {
        clearTimeout(timer);
        action(value);
      };
      const record = {
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      };
      task.pending.set(id, record);
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          if (task.pending.get(id) !== record) return;
          task.pending.delete(id);
          record.reject(runnerError("APP_HOST_UNAVAILABLE"));
        }, timeoutMs);
      }
      try { task.socket.send(JSON.stringify({ type: "req", id, method, params })); } catch {
        task.pending.delete(id);
        record.reject(runnerError("AGENT_OPERATION_FAILED"));
      }
    });
  }

  #arm(task) {
    clearTimeout(task.timer);
    task.timer = setTimeout(() => {
      if (task.sessionKey && task.socket?.readyState === this.WebSocket.OPEN) {
        void this.#rpc(task, "chat.abort", { sessionKey: task.sessionKey }).catch(() => {});
      }
      this.#fail(task, "AGENT_RUN_TIMEOUT");
    }, task.timeoutMs);
  }

  #resolveStart(task) {
    if (task.startSettled) return;
    task.startSettled = true;
    task.resolveStart(this.#public(task));
  }

  #finish(task, status, result, errorCode) {
    clearTimeout(task.timer);
    task.timer = null;
    task.status = status;
    task.result = result;
    task.errorCode = errorCode;
    this.#resolveStart(task);
  }

  #fail(task, code) {
    if (TASK_TERMINAL_STATUSES.has(task.status)) return;
    clearTimeout(task.timer);
    task.timer = null;
    task.status = "failed";
    task.result = null;
    task.errorCode = code;
    if (!task.sessionKey) {
      try { task.socket?.close(); } catch {}
    }
    if (!task.startSettled) {
      task.startSettled = true;
      task.rejectStart(runnerError(code));
    }
    for (const pending of task.pending.values()) pending.reject(runnerError(code));
    task.pending.clear();
  }

  #public(task) {
    return {
      taskId: task.taskId,
      sessionKey: task.sessionKey,
      status: task.status,
      turn: task.turn,
      waitingFor: task.status === "waiting_input" ? "input" : null,
      result: task.result,
      errorCode: task.errorCode,
    };
  }
}

function createFederatedAgentTaskRunner(options) {
  return new FederatedAgentTaskRunner(options);
}

module.exports = {
  FederatedAgentTaskRunner,
  brokerUrl,
  createFederatedAgentTaskRunner,
  runFederatedAgentViaBroker,
};
