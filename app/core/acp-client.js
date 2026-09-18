"use strict";

// Minimal Agent Client Protocol (ACP) client over stdio.
//
// ACP uses newline-delimited JSON-RPC 2.0. We implement what the proxy needs
// to drive a Hermes chat: initialize, session/new, session/prompt, plus
// streamed `session/update` notifications. Requests the agent makes BACK to
// us (fs/*, permission/*, etc.) are refused with a method-not-found error so
// the agent can fall back to a text-only reply for a v1 demo.
//
// Confirmed shapes (live against `hermes acp` v0.14.0):
//   <- initialize result: { protocolVersion, agentInfo, agentCapabilities, authMethods }
//   <- session/new result: { sessionId }
//   <- session/update notif: { sessionId, update: { sessionUpdate: "agent_message_chunk",
//                                                    content: { type: "text", text } } }
//   <- session/prompt result: { stopReason }

const { spawn } = require("node:child_process");

// Session-setup ceilings. Real timings: initialize ≈0.5s, session/new ≈5s (loads
// config + builds the model client), session/load also replays history. A wedged
// child that answers neither must surface as an error, not an eternal "Thinking".
const INIT_TIMEOUT_MS = 30_000;
const SESSION_SETUP_TIMEOUT_MS = 90_000;

class AcpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.bin="hermes"] Hermes binary
   * @param {string[]} [opts.args=["acp"]] argv (e.g. ["--profile","bull","acp"])
   * @param {string} [opts.cwd] working directory for the spawned process
   * @param {(line:string)=>void} [opts.onStderr] optional stderr observer
   */
  constructor({ bin = "hermes", args = ["acp"], cwd, onStderr, onExit } = {}) {
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();           // id → { resolve, reject }
    this.updateHandlers = new Map();    // acpSessionId → (update) => void
    this.buf = "";
    this.initPromise = null;
    this.agentCapabilities = null; // from the initialize result (promptCapabilities etc.)
    // Ring buffer of recent stderr lines. The agent prints model/auth failures
    // (e.g. HTTP 401 invalid key) here, so when a prompt yields no text the
    // backend can surface the real reason instead of a generic "no text".
    this.stderrTail = [];
  }

  /** Spawn the process and send `initialize`. Resolves once initialize completes. */
  start() {
    if (this.initPromise) {
      return this.initPromise;
    }
    return this._startFresh();
  }

  _startFresh() {
    this.buf = "";
    const proc = spawn(this.bin, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    // 按进程身份门控：被 kill 的 child 迟到的字节不得进入新 child 的行缓冲，
    // 否则会拼进它的首条消息导致 JSON 解析失败、initialize 响应被当噪声丢弃。
    proc.stdout.on("data", (chunk) => { if (this.proc === proc) this._onStdout(chunk); });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this._recordStderr(text);
      if (this.onStderr) {
        this.onStderr(text);
      }
    });
    proc.on("exit", (code) => {
      this._terminateProcess(proc, new Error(`acp process exited (${code})`), code);
    });
    proc.on("error", (err) => {
      // spawn 失败不保证随后一定有 exit，error 本身就是一次完整终止。
      this._terminateProcess(proc, err, null);
    });
    this.initPromise = this._request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      INIT_TIMEOUT_MS,
    ).then(
      (result) => {
        // Remember what the agent can accept in prompts (e.g. promptCapabilities.image)
        // so callers can refuse unsupported content honestly instead of dropping it.
        this.agentCapabilities = result?.agentCapabilities ?? null;
        return result;
      },
      (err) => {
        // A failed/timed-out initialize must not stay cached: this.initPromise
        // would keep rejecting every later send with the stale error while the
        // (possibly wedged) child lives on. Kill the child and clear state so the
        // next send re-spawns cleanly. Guard on identity — stop() only if this
        // attempt still owns the client.
        if (this.proc === proc) this.stop();
        throw err;
      },
    );
    return this.initPromise;
  }

  /** True once initialize reported the agent accepts image content blocks in prompts. */
  supportsImages() {
    return this.agentCapabilities?.promptCapabilities?.image === true;
  }

  /** Create an ACP session; returns its server-assigned id. */
  async newSession(cwd) {
    await this.start();
    const result = await this._request("session/new", { cwd, mcpServers: [] }, SESSION_SETUP_TIMEOUT_MS);
    return result?.sessionId;
  }

  /**
   * Resume an existing Hermes session in ACP. Hermes advertises
   * agentCapabilities.loadSession=true on initialize, so passing its dashboard
   * session id (e.g. `cron_xxx_…` or a uuid) brings the session's full history
   * into the ACP context — subsequent prompts continue it.
   */
  async loadSession(sessionId, cwd) {
    await this.start();
    await this._request("session/load", { sessionId, cwd, mcpServers: [] }, SESSION_SETUP_TIMEOUT_MS);
    return sessionId;
  }

  /** Switch one live ACP session without changing the profile default. */
  async setSessionModel(sessionId, modelId) {
    await this.start();
    return this._request(
      "session/set_model",
      { sessionId, modelId },
      SESSION_SETUP_TIMEOUT_MS,
    );
  }

  /**
   * Send a prompt and stream `session/update` notifications via onUpdate until
   * the agent responds to the request (end_turn / refusal / cancelled).
   * `content` is either a plain string (wrapped as one text block) or a ready
   * ACP content-block array (e.g. text + image blocks for attachments).
   */
  async prompt(sessionId, content, onUpdate) {
    await this.start();
    this.updateHandlers.set(sessionId, onUpdate || (() => {}));
    try {
      return await this._request("session/prompt", {
        sessionId,
        prompt: Array.isArray(content) ? content : [{ type: "text", text: content }],
      });
    } finally {
      this.updateHandlers.delete(sessionId);
    }
  }

  cancel(sessionId) {
    this._notify("session/cancel", { sessionId });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already exited */
      }
      this.proc = null;
    }
    this._rejectAllPending(new Error("acp client stopped"));
    this.initPromise = null;
    // 被杀 child 的 exit 迟到且被 _terminateProcess 的身份守卫挡掉，半行残留在这里清。
    this.buf = "";
  }

  // ---- internals ----

  // timeoutMs (optional): session-setup RPCs must not hang forever — a wedged
  // `hermes acp` child otherwise leaves the UI "Thinking" indefinitely with no
  // error (2026-07-14 incident). prompt() passes none: long agent turns are legal.
  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`acp ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      if (!this._write({ jsonrpc: "2.0", id, method, params })) {
        // Couldn't write (dead/closing process) — fail fast instead of hanging
        // forever waiting for a response that can never arrive.
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error("acp process not writable"));
      }
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _write(obj) {
    if (!this.proc?.stdin?.writable) {
      return false;
    }
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      return false; // EPIPE 等同步抛出：交给调用方走「不可写」清理路径
    }
    return true;
  }

  _recordStderr(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) this.stderrTail.push(line);
    }
    if (this.stderrTail.length > 40) {
      this.stderrTail.splice(0, this.stderrTail.length - 40);
    }
  }

  // 统一收口 spawn error / exit：复位状态并 exactly-once 通知上层清理 session 映射。
  // 以进程身份守卫，避免同一 child 的重复事件或旧 child 的迟到事件污染新 child。
  _terminateProcess(proc, err, code) {
    if (this.proc !== proc) return false;
    this._rejectAllPending(err);
    this.proc = null;
    this.initPromise = null;
    this.updateHandlers.clear();
    this.agentCapabilities = null;
    this.buf = "";
    try {
      this.onExit?.(code);
    } catch {
      /* 上层清理异常不能破坏 ACP 自身的终止复位 */
    }
    return true;
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let index;
    while ((index = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON banner
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        // Hermes puts the actionable cause in error.data.details ("Provider 'xai'
        // is set in config.yaml but no API key was found…") while error.message is
        // a bare "Internal error" — surface both or the user can't self-serve.
        const base = msg.error.message || `acp error ${msg.error.code}`;
        const data = msg.error.data;
        const detail =
          data && typeof data === "object"
            ? String(data.details ?? data.detail ?? "").trim()
            : typeof data === "string"
              ? data.trim()
              : "";
        pending.reject(new Error(detail ? `${base}: ${detail}` : base));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Notification from the agent (streaming updates etc).
    if (msg.method === "session/update" && msg.params) {
      const handler = this.updateHandlers.get(msg.params.sessionId);
      if (handler) {
        try {
          handler(msg.params.update);
        } catch {
          /* swallow per-update errors */
        }
      }
      return;
    }
    // Agent calling a method on us (fs/*, permissions, terminal, etc.).
    // Refuse minimally so it doesn't hang; the agent falls back to text-only.
    if (msg.method && msg.id !== undefined) {
      this._write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `client method not supported: ${msg.method}` },
      });
    }
  }

  _rejectAllPending(err) {
    for (const [, p] of this.pending) {
      try {
        p.reject(err);
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
  }
}

module.exports = { AcpClient };
