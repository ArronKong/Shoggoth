"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");
const { Terminal } = require("@xterm/headless");
const { readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, serviceError } = require("./security");

const COLS = 160;
const ROWS = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const APPROVAL_RENDER_GRACE_MS = 5_000;
const APPROVAL_FORMAT_TIMEOUT_MS = 30_000;
const APPROVAL_RESPONSE_TIMEOUT_MS = 10 * 60_000;
const APPROVAL_CONSUME_TIMEOUT_MS = 5_000;
const APPROVAL_TITLE = /^(?:File access|Command|Run this command\?|Run command|Tool permission|Permission|MCP|URL access|Web access|Read URL|Allow)(?:\b|$)/iu;
const STATE_ENV = "SHOGGOTH_ANTIGRAVITY_TERMINAL_STATE";
// Each invocation has its own file: a busy CLI must not overwrite an unread
// idle/approval transition. This command only observes state, never grants it.
const STATUS_COMMAND = 'umask 077; if [ -d "$SHOGGOTH_ANTIGRAVITY_TERMINAL_STATE" ]; then '
  + 'f="$SHOGGOTH_ANTIGRAVITY_TERMINAL_STATE/status.$$.tmp"; '
  + '/bin/cat > "$f" && /bin/mv "$f" "${f%.tmp}.json"; fi; /usr/bin/printf "Shoggoth"';

function failure(code, message) { return serviceError(code, message); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function safeText(value, max = 16 * 1024) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && Buffer.byteLength(value) <= max;
}

function terminalPaste(text) {
  if (!safeText(text, MAX_BYTES) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) {
    throw failure("RUNTIME_TURN_PARAMS_INVALID", "Antigravity terminal input contains control characters");
  }
  return `\x1b[200~${text.replace(/\r\n?/gu, "\n")}\x1b[201~\r`;
}

function nativeTurnArgs(args) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    if (["--input-format", "--output-format", "--print-timeout"].includes(args[i])) { i += 1; continue; }
    if (args[i] === "--disable-slash-commands") continue;
    result.push(args[i]);
  }
  return result;
}

function terminalScreen(terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, i) => (
    buffer.getLine(buffer.viewportY + i)?.translateToString(true) || ""
  )).join("\n");
}

function nativeInputRejection(line) {
  // This is the CLI's pre-send rejection, not terminal/model output or the
  // transient auth warnings emitted before Keychain authentication succeeds.
  const match = /^[WE]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ conversation_manager\.go:\d+\] Not sending user message: Eligibility check failed: (.+)$/u.exec(line);
  if (!match) return null;
  const reason = match[1];
  if (/(?:TLS handshake timeout|context deadline exceeded|i\/o timeout|connection (?:reset|refused)|no such host|\bEOF\b)/iu.test(reason)) {
    return failure("ANTIGRAVITY_NETWORK_UNAVAILABLE", "Antigravity could not complete its network eligibility check; no message was sent");
  }
  if (/(?:not logged in|unauthenticated|authentication required|please sign in)/iu.test(reason)) {
    return failure("AUTH_REQUIRED", "Antigravity authentication is required");
  }
  if (/User location is not supported/iu.test(reason)) {
    return failure("ANTIGRAVITY_REGION_UNSUPPORTED", "Antigravity rejected the account location; no message was sent");
  }
  return failure("ANTIGRAVITY_ELIGIBILITY_FAILED", "Antigravity rejected its account eligibility check; no message was sent");
}

function parseNativeApproval(screen) {
  const lines = screen.split("\n");
  const options = [];
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*([>❯]?)\s*(\d+)\.\s+(.+?)\s*$/u.exec(lines[i]);
    if (!match) {
      // Native labels wrap at terminal width. Keep the continuation, including
      // persistence/scope text, instead of presenting a truncated grant.
      if (options.length > 0 && /^\s+\S/u.test(lines[i]) && !/[↑↓]|Navigate|esc to cancel|Shoggoth/u.test(lines[i])) {
        options.at(-1).label += ` ${lines[i].trim()}`;
      }
      continue;
    }
    const label = match[3];
    const deny = /^(?:No[, ]|Deny\b|Reject\b)/iu.test(label);
    const allow = /^(?:Yes[, ]|Allow\b|Approve\b)/iu.test(label);
    if (!deny && !allow) return null;
    if (first < 0) first = i;
    options.push({
      number: Number(match[2]), label, selected: match[1].length > 0,
      kind: deny ? "reject_once" : /\b(?:always|all|session)\b/iu.test(label) ? "allow_always" : "allow_once",
    });
  }
  if (options.length < 2 || options.length > 16 || options.filter((o) => o.selected).length !== 1
    || options.filter((o) => o.kind === "reject_once").length !== 1
    || options.some((o, i) => o.number !== i + 1)) return null;
  for (const option of options) {
    if (option.label.includes("…") || option.label.includes("...")) return null;
    if (option.kind !== "reject_once") option.kind = /\b(?:always|all|session|conversation)\b/iu.test(option.label) ? "allow_always" : "allow_once";
  }
  // Read only the native modal, not earlier assistant/tool output in scrollback.
  let start = first - 1;
  while (start >= 0 && !APPROVAL_TITLE.test(lines[start].trim())) start -= 1;
  if (start < 0) return null;
  // Include file/command details above the question when the modal has a title.
  for (let i = start - 1; i >= Math.max(0, first - 30); i -= 1) {
    if (/^(?:File access|Command|Run this command\?|Run command|Tool permission|Permission|MCP|URL access|Web access|Read URL)$/iu.test(lines[i].trim())) { start = i; break; }
  }
  const reason = lines.slice(start, first).filter((line) => !/^\s*[─━-]{3,}\s*$/u.test(line))
    .map((line) => line.trimEnd()).join("\n").trim();
  if (!reason || reason.length > 16 * 1024) return null;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([reason, options.map((o) => [o.number, o.label])])).digest("hex");
  return { reason, options, fingerprint };
}

function approvalParams(approval, tool, cwd, itemId) {
  return {
    itemId, cwd, toolName: tool?.name || "Antigravity", toolInput: tool?.parameters || {},
    ...(typeof tool?.parameters?.CommandLine === "string" ? { command: tool.parameters.CommandLine } : {}),
    reason: approval.reason,
    sessionApprovalAvailable: false,
    approvalOptions: approval.options.map((option) => ({
      choice: option.kind === "reject_once" ? "deny" : `runtime:antigravity-${option.number}`,
      label: option.label, kind: option.kind,
    })),
  };
}

function approvalKeys(approval, response) {
  const option = response?.approvalChoice === "deny"
    ? approval.options.find((candidate) => candidate.kind === "reject_once")
    : response?.approvalChoice
    ? approval.options.find((candidate) => `runtime:antigravity-${candidate.number}` === response.approvalChoice)
    : ["decline", "cancel"].includes(response?.decision)
      ? approval.options.find((candidate) => candidate.kind === "reject_once") : null;
  if (!option || (response.decision === "accept" && option.kind === "reject_once")
    || (response.decision !== "accept" && option.kind !== "reject_once")) {
    throw failure("RUNTIME_APPROVAL_RESPONSE_INVALID", "Antigravity requires an actual native approval choice");
  }
  const selected = approval.options.find((candidate) => candidate.selected).number;
  return (option.number < selected ? "\x1b[A" : "\x1b[B").repeat(Math.abs(option.number - selected)) + "\r";
}

function decodeTool(call) {
  if (!plain(call) || !safeText(call.name, 256) || !plain(call.args)) return null;
  const parameters = {};
  for (const [key, value] of Object.entries(call.args)) {
    if (typeof value !== "string") { parameters[key] = value; continue; }
    try { parameters[key] = JSON.parse(value); } catch { parameters[key] = value; }
  }
  return { name: call.name, parameters };
}

class AntigravityNativeTerminal extends EventEmitter {
  static async launch(options) {
    const terminal = new AntigravityNativeTerminal(options);
    await terminal._launch();
    return terminal;
  }

  constructor(options) {
    super();
    this.options = options;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = null;
    this.closed = false;
    this.sent = false;
    this.accepted = false;
    this.inputRejected = false;
    this.ready = false;
    this.result = false;
    this.pending = null;
    this.state = null;
    this.offset = null;
    this.fragment = "";
    this.transcriptDecoder = new StringDecoder("utf8");
    this.byteCount = 0;
    this.tools = [];
    this.response = "";
    this.prompt = null;
    this.exitTimer = null;
    this.approvalTimer = null;
    this.approvalWaiting = false;
    this.now = options.now || Date.now;
    this.approvalRenderGraceMs = options.approvalRenderGraceMs ?? APPROVAL_RENDER_GRACE_MS;
    this.approvalFormatTimeoutMs = options.approvalFormatTimeoutMs ?? APPROVAL_FORMAT_TIMEOUT_MS;
    this.approvalResponseTimeoutMs = options.approvalResponseTimeoutMs ?? APPROVAL_RESPONSE_TIMEOUT_MS;
    this.approvalConsumeTimeoutMs = options.approvalConsumeTimeoutMs ?? APPROVAL_CONSUME_TIMEOUT_MS;
    if (![this.approvalRenderGraceMs, this.approvalFormatTimeoutMs, this.approvalResponseTimeoutMs,
      this.approvalConsumeTimeoutMs].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 10 * 60_000)
      || this.approvalRenderGraceMs >= this.approvalFormatTimeoutMs) {
      throw failure("ANTIGRAVITY_HOST_OPTIONS_INVALID", "Antigravity approval timeout is invalid");
    }
    this.lastProgressAt = Date.now();
    this.terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
    this.terminal.onData((data) => { if (this.ready && !this.closed) this.process.write(data); });
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += chunk.toString("utf8");
        callback(Buffer.byteLength(input) > MAX_BYTES ? failure("RUNTIME_TURN_PARAMS_INVALID", "Antigravity input is too large") : null);
      },
      final: (callback) => {
        try {
          const message = JSON.parse(input);
          if (message.event !== "user" || typeof message.message?.content !== "string") throw new Error("invalid input");
          terminalPaste(message.message.content);
          this.prompt = message.message.content.replace(/\r\n?/gu, "\n");
          callback();
        } catch (error) { callback(error); }
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr, new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.ready || chunk.toString() !== "go\n") { callback(new Error("invalid launch barrier")); return; }
        this.ready = true;
        try { this.process.write("go\n"); callback(); } catch (error) { callback(error); }
      },
    })];
  }

  async _launch() {
    const { stateRoot, trustedRoot, env, cwd, binaryPath, args } = this.options;
    ensurePrivateDirectoryTree(stateRoot, trustedRoot);
    this.stateDir = fs.mkdtempSync(path.join(stateRoot, "terminal-"));
    fs.chmodSync(this.stateDir, 0o700);
    this.logPath = path.join(this.stateDir, "native.log");
    fs.writeFileSync(this.logPath, "", { flag: "wx", mode: 0o600 });
    this.logOffset = 0;
    this.logFragment = "";
    this.logDecoder = new StringDecoder("utf8");
    const launcher = 'stty -echo; IFS= read -r _ || exit 125; exec "$@"';
    try {
      this.process = (this.options.spawnPty || require("node-pty").spawn)("/bin/sh", [
        "-c", launcher, "shoggoth-antigravity-terminal", binaryPath, ...nativeTurnArgs(args), "--log-file", this.logPath,
      ], { cwd, env: { ...env, TERM: "xterm-256color", [STATE_ENV]: this.stateDir },
        name: "xterm-256color", cols: COLS, rows: ROWS });
    } catch (error) { this.dispose(); throw error; }
    this.pid = this.process.pid;
    this.process.onData((data) => this._render(data));
    this.process.on?.("error", (error) => this._fail(error));
    this.process.onExit(({ exitCode, signal }) => {
      if (this.interrupted && this.accepted && !this.result && !this.failing) this._emitResult("INTERRUPTED");
      this.closed = true;
      this.dispose();
      this.stdout.end();
      this.stderr.end();
      this.emit("close", this.result ? 0 : exitCode, this.result ? null : signal);
    });
    this.timer = setInterval(() => { try { this._poll(); } catch (error) { this._fail(error); } }, 100);
    this.timer.unref?.();
  }

  _render(data) {
    this.terminal.write(data, () => { if (!this.closed) { try { this._checkApproval(); } catch (error) { this._fail(error); } } });
  }

  _emit(event) { this.stdout.write(`${JSON.stringify(event)}\n`); }
  _step(value) { this._emit({ event: "step_update", step_update: { conversation_id: this.conversationId, ...value } }); }

  _poll() {
    if (!this.ready || this.closed || this.result) return;
    const files = fs.readdirSync(this.stateDir).filter((name) => /^status\.[1-9][0-9]*\.json$/u.test(name));
    if (files.length > 256) throw failure("ANTIGRAVITY_STREAM_EVENT_INVALID", "Antigravity terminal state overflow");
    const states = files.map((name) => {
      const file = path.join(this.stateDir, name);
      const time = fs.statSync(file).mtimeMs;
      const state = JSON.parse(readPrivateFile(file, { maxBytes: 256 * 1024 }).toString("utf8"));
      fs.unlinkSync(file);
      return { state, time };
    }).sort((a, b) => a.time - b.time);
    for (const { state } of states) this._state(state);
    if (this.conversationId && this.sent) this._readTranscript();
    this._readInputRejection();
    this._checkApproval();
    const screen = terminalScreen(this.terminal);
    if (!this.sent && this.prompt !== null && this.state?.agent_state === "idle"
      && this.state.tool_confirmation_pending === false && screen.includes("? for shortcuts")
      && (this.conversationId || !this.options.conversationId)) {
      this.offset = this.transcriptPath ? this._transcriptSize() : 0;
      this.sent = true;
      this.process.write(terminalPaste(this.prompt));
      this.options.onInputSubmitted?.();
    }
    if (this.accepted && this.state?.agent_state === "idle" && !this.state.tool_confirmation_pending
      && this.state.pending_input_count === 0 && this.state.task_count === 0
      && screen.includes("? for shortcuts") && !this.pending && this.tools.length === 0
      && Date.now() - this.lastProgressAt > 300) {
      this._finish();
    }
  }

  _readInputRejection() {
    if (!this.sent || this.accepted) return;
    // Private per-process log, bounded and removed on disposal. Only a safe
    // error code leaves this reader; URLs, account details and prompts do not.
    const data = readPrivateFile(this.logPath, { maxBytes: MAX_BYTES });
    if (data.length < this.logOffset) throw failure("ANTIGRAVITY_DIAGNOSTIC_INVALID", "Antigravity diagnostic log was replaced");
    this.logFragment += this.logDecoder.write(data.subarray(this.logOffset));
    this.logOffset = data.length;
    let newline;
    while ((newline = this.logFragment.indexOf("\n")) >= 0) {
      const line = this.logFragment.slice(0, newline);
      this.logFragment = this.logFragment.slice(newline + 1);
      const error = nativeInputRejection(line);
      if (!error) continue;
      this.inputRejected = true;
      this._diagnostic(error.code);
      throw error;
    }
  }

  _state(state) {
    // Startup snapshots precede authentication and have no conversation yet.
    if (plain(state)) state = { tool_confirmation_pending: false, pending_input_count: 0, task_count: 0, ...state };
    if (plain(state) && state.cwd === this.options.cwd && state.conversation_id === ""
      && ["authenticating", "initializing", "idle"].includes(state.agent_state) && !this.conversationId) {
      this.state = state;
      return;
    }
    if (!plain(state) || state.cwd !== this.options.cwd
      || !/^[a-zA-Z0-9-]{1,128}$/u.test(state.conversation_id || "")
      || typeof state.tool_confirmation_pending !== "boolean"
      || !["idle", "thinking", "working", "tool_use", "initializing"].includes(state.agent_state)) {
      throw failure("ANTIGRAVITY_STREAM_EVENT_INVALID", "Antigravity terminal state is invalid");
    }
    if (this.conversationId && this.conversationId !== state.conversation_id
      || this.options.conversationId && this.options.conversationId !== state.conversation_id) {
      throw failure("RUNTIME_SESSION_CONFLICT", "Antigravity terminal switched conversations");
    }
    if (!this.conversationId) {
      this.conversationId = state.conversation_id;
      // The compact transcript truncates long inputs and responses. Acceptance
      // must compare the complete submitted prompt, including system context.
      this.transcriptPath = path.join(this.options.home, ".gemini", "antigravity-cli", "brain", this.conversationId, ".system_generated", "logs", "transcript_full.jsonl");
      this._emit({ event: "init", conversation_id: this.conversationId, init: {
        cwd: this.options.cwd, tools: [], permission_mode: "native-interactive",
      } });
    }
    if (this.state?.agent_state !== state.agent_state || this.state?.tool_confirmation_pending !== state.tool_confirmation_pending) {
      this.lastProgressAt = Date.now();
    }
    this.state = state;
    if (!state.tool_confirmation_pending) this._clearApproval();
  }

  _transcriptSize() {
    try {
      const data = this._openTranscript();
      fs.closeSync(data.fd);
      return data.size;
    } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  }

  _openTranscript() {
    const relative = path.relative(this.options.home, this.transcriptPath);
    let current = this.options.home;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript directory is unsafe");
    }
    const fd = fs.openSync(this.transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) {
      fs.closeSync(fd);
      throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript is unsafe");
    }
    if (this.transcriptIdentity && this.transcriptIdentity !== `${stat.dev}:${stat.ino}`) {
      fs.closeSync(fd);
      throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript was replaced");
    }
    this.transcriptIdentity = `${stat.dev}:${stat.ino}`;
    return { fd, size: stat.size };
  }

  _readTranscript() {
    let file;
    try { file = this._openTranscript(); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      if (file.size < this.offset) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript was replaced");
      const length = file.size - this.offset;
      if (length === 0) return;
      this.byteCount += length;
      if (this.byteCount > MAX_BYTES) throw failure("ANTIGRAVITY_TURN_OUTPUT_TOO_LARGE", "Antigravity transcript is too large");
      const data = Buffer.alloc(length);
      const count = fs.readSync(file.fd, data, 0, length, this.offset);
      this.offset += count;
      this.fragment += this.transcriptDecoder.write(data.subarray(0, count));
      let newline;
      while ((newline = this.fragment.indexOf("\n")) >= 0) {
        const line = this.fragment.slice(0, newline);
        this.fragment = this.fragment.slice(newline + 1);
        if (line.trim()) this._record(JSON.parse(line));
      }
    } finally { fs.closeSync(file.fd); }
  }

  _record(record) {
    this.lastProgressAt = Date.now();
    if (!plain(record) || !Number.isSafeInteger(record.step_index) || record.step_index < 0) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript step is invalid");
    if (this.lastStepIndex !== undefined && record.step_index <= this.lastStepIndex) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Antigravity transcript step was replayed");
    this.lastStepIndex = record.step_index;
    if (record.type === "USER_INPUT") {
      if (this.accepted || ![this.prompt, this.prompt?.trim()].some((prompt) =>
        record.content?.startsWith(`<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`))) throw failure("RUNTIME_SESSION_CONFLICT", "Antigravity accepted different input");
      this.accepted = true;
      this._step({ step_index: record.step_index, step_type: "user_input", state: "DONE" });
      return;
    }
    if (!this.accepted) throw failure("RUNTIME_SESSION_CONFLICT", "Antigravity emitted output before accepting this prompt");
    if (record.type === "PLANNER_RESPONSE") {
      if (safeText(record.content, MAX_BYTES) && record.content.length > 0) {
        this.response = record.content;
        this._step({ step_index: record.step_index * 64, step_type: "agent_response", state: "DONE", text_delta: record.content });
      }
      if (Array.isArray(record.tool_calls)) {
        if (record.tool_calls.length > 32) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Too many Antigravity tools");
        record.tool_calls.forEach((call, i) => {
          this.response = "";
          const tool = decodeTool(call);
          if (!tool) throw failure("ANTIGRAVITY_TRANSCRIPT_INVALID", "Invalid Antigravity tool");
          const index = record.step_index * 64 + i + 1;
          this.tools.push({ index, tool });
          this._step({ step_index: index, step_type: "tool", state: "ACTIVE", tool_name: tool.name, tool_info: tool });
        });
      }
    } else if (record.type === "GENERIC" && this.tools.length > 0) {
      const { index, tool } = this.tools.shift();
      this._step({ step_index: index, step_type: "tool", state: record.status === "DONE" ? "DONE" : "ERROR", tool_name: tool.name,
        tool_info: { ...tool, ...(record.status === "DONE" ? { output: record.content } : { error: record.content }) } });
    }
  }

  _checkApproval() {
    if (!this.accepted || this.closed || this.result || this.interrupted || this.failing
      || this.state?.tool_confirmation_pending !== true) return;
    if (this.pending && !this.pending.unsupported) return;
    // Native metadata proves a confirmation is pending even while the renderer
    // has not painted its menu. Waiting for that paint is not model execution.
    this._setApprovalWaiting(true);
    const screen = terminalScreen(this.terminal);
    const approval = parseNativeApproval(screen);
    if (this.pending?.unsupported) {
      if (!approval) return;
      // A late paint can recover without replaying the turn. Retire the
      // cancel-only card before issuing a new request with actual grant scope;
      // its late responses are fenced by the pending identity and AbortSignal.
      this._clearApproval();
      this._setApprovalWaiting(true);
      this._diagnostic("ANTIGRAVITY_APPROVAL_RENDER_RECOVERED", screen);
    }
    if (!approval) {
      if (this.unrecognizedApprovalAt == null) {
        this.unrecognizedApprovalAt = this.now();
        this._approvalDeadline(this.approvalFormatTimeoutMs, "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED");
        this._diagnostic("ANTIGRAVITY_APPROVAL_RENDER_WAIT", screen);
      }
      if (this.now() - this.unrecognizedApprovalAt >= this.approvalRenderGraceMs) {
        // An unknown menu has no trustworthy grant scope or key mapping. Offer
        // only cancellation, never a fabricated Allow or a default Enter key.
        const pending = { unsupported: true, controller: new AbortController() };
        this.pending = pending;
        this._diagnostic("ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED", screen);
        this._requestApproval(pending, {
          itemId: `antigravity-terminal-${this.conversationId}-${this.tools[0]?.index || 0}-unsupported`,
          cwd: this.options.cwd,
          toolName: this.tools.length === 1 ? this.tools[0].tool.name : "Antigravity",
          toolInput: {},
          reason: "Antigravity is waiting for permission, but this version's native approval could not be read. No permission has been granted. Cancel this turn to continue safely.",
          sessionApprovalAvailable: false,
          approvalOptions: [{ choice: "deny", label: "Cancel this turn", kind: "reject_once" }],
        });
      }
      return;
    }
    this.unrecognizedApprovalAt = null;
    const matching = this.tools.find(({ tool }) => [tool.parameters.AbsolutePath, tool.parameters.CommandLine, tool.parameters.Url, tool.parameters.URL, tool.parameters.url]
      .some((value) => typeof value === "string" && approval.reason.includes(value)));
    const tool = matching?.tool || (this.tools.length === 1 ? this.tools[0].tool : null);
    const params = approvalParams(approval, tool, this.options.cwd, `antigravity-terminal-${this.conversationId}-${this.tools[0]?.index || 0}`);
    const pending = { ...approval, controller: new AbortController() };
    this.pending = pending;
    this._approvalDeadline(this.approvalResponseTimeoutMs, "ANTIGRAVITY_APPROVAL_TIMEOUT");
    this._requestApproval(pending, params);
  }

  _requestApproval(pending, params) {
    Promise.resolve().then(() => {
      if (pending.controller.signal.aborted) return null;
      return this.options.requestApproval(params, { signal: pending.controller.signal });
    }).then((response) => {
      if (this.pending !== pending || pending.controller.signal.aborted || this.closed || this.result
        || this.interrupted || this.failing) return;
      if (pending.unsupported) {
        if (!["decline", "cancel"].includes(response?.decision)
          || response.approvalChoice !== undefined && response.approvalChoice !== "deny") {
          throw failure("RUNTIME_APPROVAL_RESPONSE_INVALID", "An unreadable Antigravity approval can only be canceled");
        }
        this._diagnostic("ANTIGRAVITY_APPROVAL_CANCELED");
        this.kill("SIGINT");
        return;
      }
      const current = parseNativeApproval(terminalScreen(this.terminal));
      if (this.state?.tool_confirmation_pending !== true || current?.fingerprint !== pending.fingerprint) {
        throw failure("ANTIGRAVITY_APPROVAL_CHANGED", "Antigravity native approval changed before the response");
      }
      const keys = approvalKeys(current, response);
      if (["decline", "cancel"].includes(response.decision)) this.denied = true;
      this.process.write(keys);
      // Hold the request until the CLI consumes the key, so a repaint cannot
      // publish the same native prompt a second time.
      pending.responded = true;
      // Keep the execution clock paused until native metadata acknowledges the
      // choice. A lost key/blocked CLI must not leave a consumed card forever.
      this._approvalDeadline(this.approvalConsumeTimeoutMs, "ANTIGRAVITY_APPROVAL_RESPONSE_UNCONFIRMED");
    }).catch((error) => {
      if (this.pending === pending && !pending.controller.signal.aborted) this._fail(error);
    });
  }

  _setApprovalWaiting(waiting) {
    if (this.approvalWaiting === waiting) return;
    this.approvalWaiting = waiting;
    this.options.onApprovalWaiting?.(waiting);
  }

  _approvalDeadline(ms, code) {
    clearTimeout(this.approvalTimer);
    this.approvalTimer = setTimeout(() => {
      if (!this.closed && !this.result && !this.interrupted && !this.failing) {
        this._diagnostic(code);
        this._fail(failure(code, "Antigravity permission waiting could not complete"));
      }
    }, ms);
    this.approvalTimer.unref?.();
  }

  _clearApproval() {
    clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
    this.pending?.controller.abort();
    this.pending = null;
    this.unrecognizedApprovalAt = null;
    this._setApprovalWaiting(false);
  }

  _diagnostic(code, screen = "") {
    // Never persist a terminal screen, URL, command, path, prompt, or tool
    // parameters. Counts and state are enough to identify protocol drift.
    try { this.options.onDiagnostic?.({ code, transport: "native-terminal",
      confirmationPending: this.state?.tool_confirmation_pending === true,
      screenCharacters: screen.length,
      menuRows: screen.split("\n").filter((line) => /^\s*[>❯]?\s*\d+\.\s+/u.test(line)).length,
      pendingTools: this.tools.length,
    }); } catch {}
  }

  _finish() {
    this._emitResult(this.interrupted ? "INTERRUPTED" : this.response ? "SUCCESS" : this.denied ? "CANCELED" : "ERROR");
    this.process.write("/exit\r");
    this.exitTimer = setTimeout(() => this.kill("SIGTERM"), 1_000);
    this.exitTimer.unref?.();
  }

  _emitResult(status) {
    this.result = true;
    this._clearApproval();
    this._emit({ event: "result", result: {
      conversation_id: this.conversationId, status, response: this.response, num_turns: 1,
      // statusLine's totals are context estimates in CLI 1.2.5, not billing
      // counters. Never publish those as measured conversation usage.
      usage_available: false,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    } });
  }

  _fail(error) {
    if (this.closed || this.failing) return;
    this.failing = true;
    this._clearApproval();
    this.emit("error", error);
    this.kill("SIGKILL");
  }

  kill(signal = "SIGTERM") {
    if (this.closed) return;
    this._clearApproval();
    if (["SIGINT", "SIGTERM"].includes(signal) && !this.result) this.interrupted = true;
    if (!Number.isSafeInteger(this.pid) || this.pid <= 1) return;
    if (this.options.killProcessGroup) this.options.killProcessGroup(this.pid, signal);
    else {
      try { process.kill(-this.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") this.process?.kill(signal); }
    }
    if (this.interrupted && !this.exitTimer) {
      this.exitTimer = setTimeout(() => this.kill("SIGKILL"), 1_000);
      this.exitTimer.unref?.();
    }
  }

  dispose() {
    this._clearApproval();
    clearInterval(this.timer);
    clearTimeout(this.exitTimer);
    this.terminal.dispose();
    if (!this.stateDir) return;
    try {
      for (const name of fs.readdirSync(this.stateDir)) {
        if (name === "native.log" || /^status\.[1-9][0-9]*\.(?:tmp|json)$/u.test(name)) fs.unlinkSync(path.join(this.stateDir, name));
      }
      fs.rmdirSync(this.stateDir);
    } catch {}
  }
}

module.exports = { AntigravityNativeTerminal, STATUS_COMMAND, approvalKeys, approvalParams, nativeInputRejection, nativeTurnArgs, parseNativeApproval, terminalPaste, terminalScreen };
