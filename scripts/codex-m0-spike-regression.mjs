#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "build", "codex-runtime-manifest.json");
const TIMEOUT_MS = 15_000;
const REAL_TIMEOUT_MS = 30_000;
// 与 Codex provider 默认 SSE idle timeout 对齐，避免在其内部重试完成前抢先终止 turn。
const AUTH_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 256 * 1024;
const POLL_MS = 25;
const IS_POSIX = process.platform !== "win32";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function terminatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(IS_POSIX ? -pid : pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(POLL_MS);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function atomicWriteJson(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function spawnCaptured(args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      detached: IS_POSIX,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = (message) => {
      try { terminatePid(child.pid); } catch {}
      finish(new Error(message));
    };
    const append = (name, previous, chunk) => {
      const next = previous + chunk.toString("utf8");
      if (Buffer.byteLength(next) > OUTPUT_LIMIT) abort(`${name} exceeded ${OUTPUT_LIMIT} bytes`);
      return next;
    };
    const timer = setTimeout(() => abort(`child timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout = append("stdout", stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append("stderr", stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      // group leader 已退出时仍需清掉同组的 app-server 后代。
      try { terminatePid(child.pid); } catch (error) { return finish(error); }
      finish(undefined, { code, signal, stdout, stderr });
    });
  });
}

function captureCommand(command, args, { cwd, env, timeoutMs = 5_000, limit = 8 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: IS_POSIX, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (name, previous, chunk) => {
      const next = previous + chunk.toString("utf8");
      if (Buffer.byteLength(next) > limit) {
        try { terminatePid(child.pid); } catch {}
        finish(new Error(`${name} exceeded ${limit} bytes`));
      }
      return next;
    };
    const timer = setTimeout(() => {
      try { terminatePid(child.pid); } catch {}
      finish(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout = append("stdout", stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append("stderr", stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      try { terminatePid(child.pid); } catch (error) { return finish(error); }
      finish(undefined, { code, signal, stdout, stderr });
    });
  });
}

class JsonlRpcClient {
  constructor(child, timeoutMs) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.waiters = new Map();
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.buffer = "";
    this.stderr = "";
    this.fatalError = null;
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > OUTPUT_LIMIT) this.fail(new Error("app-server stderr limit exceeded"));
      else this.stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => this.fail(error));
    this.closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        if (this.buffer.trim()) {
          this.fail(new Error("app-server closed with a malformed JSONL tail"));
        } else if (this.pending.size > 0 || this.waiters.size > 0) {
          this.fail(new Error(`app-server closed before protocol completion (${code ?? signal})`));
        }
        resolve();
      });
    });
  }

  consume(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > OUTPUT_LIMIT) return this.fail(new Error("app-server stdout limit exceeded"));
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error("app-server emitted malformed JSONL")); }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return this.fail(new Error("app-server message must be an object"));
    }
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const pending = this.pending.get(message.id);
      if (!pending) return this.fail(new Error(`unexpected response id ${String(message.id)}`));
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(safeRpcError(message.error)));
      else if (!Object.hasOwn(message, "result")) pending.reject(new Error("response missing result"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return this.fail(new Error("protocol message missing method"));
    if (Object.hasOwn(message, "id")) {
      const validId = (typeof message.id === "string" && message.id.length > 0)
        || (typeof message.id === "number" && Number.isSafeInteger(message.id));
      if (!validId) return this.fail(new Error("server request has invalid id"));
      this.serverRequests.push(message.method);
      this.send({ id: message.id, error: { code: -32601, message: "unsupported in M0 spike" } });
      return;
    }
    this.notifications.push(message);
    const waiters = this.waiters.get(message.method) ?? [];
    this.waiters.delete(message.method);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  send(message) {
    if (this.fatalError) throw this.fatalError;
    if (!this.child.stdin.writable) throw new Error("app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  request(method, params) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  waitFor(method) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const existing = this.notifications.find((message) => message.method === method);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const remaining = (this.waiters.get(method) ?? []).filter((item) => item.resolve !== resolve);
        if (remaining.length) this.waiters.set(method, remaining);
        else this.waiters.delete(method);
        reject(new Error(`${method} notification timed out`));
      }, this.timeoutMs);
      timer.unref();
      const waiters = this.waiters.get(method) ?? [];
      waiters.push({ resolve, reject, timer });
      this.waiters.set(method, waiters);
    });
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    try { this.child.kill("SIGKILL"); } catch {}
  }

  assertProtocolClean() {
    if (this.buffer.trim()) this.fail(new Error("app-server has a malformed JSONL tail"));
    if (this.fatalError) throw this.fatalError;
  }

  async closeAndValidate(timeoutMs = 2_000) {
    this.child.stdin.end();
    let closed = await Promise.race([
      this.closePromise.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
    if (!closed) {
      try { this.child.kill("SIGKILL"); } catch {}
      closed = await Promise.race([
        this.closePromise.then(() => true),
        delay(timeoutMs).then(() => false),
      ]);
    }
    if (!closed) throw new Error("app-server did not close after protocol completion");
    this.assertProtocolClean();
  }
}

function safeRpcError(error) {
  const code = Number.isInteger(error?.code) ? error.code : "unknown";
  return `RPC ${code}`;
}

function requireNoAuthToken(auth) {
  if (auth?.authToken != null) {
    throw new Error("authenticated smoke received an unexpected token");
  }
}

function safeServiceFailure(service) {
  const stderr = String(service.stderr ?? "");
  const knownFailures = [
    ["reasoning smoke emitted no reasoning event", "reasoning-events"],
    ["reasoning smoke did not return the expected answer", "reasoning-answer"],
    ["reasoning smoke must not execute tools", "reasoning-tool"],
    ["text smoke marker is missing", "text-marker"],
    ["text smoke must not execute tools", "text-tool"],
    ["tool smoke final marker is missing", "tool-marker"],
    ["tool smoke did not observe codex-code-mode-host", "code-mode-host"],
    ["Code Mode host reported unavailable", "code-mode-unavailable"],
    ["app-server did not close after protocol completion", "protocol-close"],
    ["malformed JSONL tail", "protocol-tail"],
    ["authenticated turn failed", "turn-failed"],
  ];
  const category = knownFailures.find(([message]) => stderr.includes(message))?.[1] ?? "unknown";
  return `authenticated service exited unsuccessfully (code=${service.code ?? "none"}, signal=${service.signal ?? "none"}, stderrBytes=${Buffer.byteLength(stderr)}, category=${category})`;
}

function collectTurnEvidence(notifications, turnId) {
  const relevant = notifications.filter((event) => event.params?.turnId === turnId);
  const agentMessages = new Map();
  for (const event of relevant.filter((entry) => entry.method === "item/agentMessage/delta")) {
    const itemId = event.params?.itemId;
    if (typeof itemId !== "string" || typeof event.params?.delta !== "string") continue;
    agentMessages.set(itemId, `${agentMessages.get(itemId) ?? ""}${event.params.delta}`);
  }
  return {
    agentMessages,
    reasoningEvents: relevant.filter((event) => event.method.startsWith("item/reasoning/")),
    commandEvents: relevant.filter(
      (event) => (event.method === "item/started" || event.method === "item/completed")
        && event.params?.item?.type === "commandExecution",
    ),
  };
}

function authFailureSummary(rpc, scenario, turnAcknowledged) {
  const categories = {
    streaming: 0,
    reasoning: 0,
    command: 0,
    warning: 0,
    error: 0,
    other: 0,
  };
  for (const event of rpc.notifications) {
    if (event.method === "item/agentMessage/delta") categories.streaming += 1;
    else if (event.method.startsWith("item/reasoning/")) categories.reasoning += 1;
    else if ((event.method === "item/started" || event.method === "item/completed") && event.params?.item?.type === "commandExecution") categories.command += 1;
    else if (event.method === "warning") categories.warning += 1;
    else if (event.method === "error") categories.error += 1;
    else categories.other += 1;
  }
  return JSON.stringify({
    scenario: ["text-only", "reasoning", "tool"].includes(scenario) ? scenario : "unknown",
    turnAcknowledged: Boolean(turnAcknowledged),
    serverRequestCount: rpc.serverRequests.length,
    categories,
  });
}

async function hasDescendantProcessNamed(rootPid, executableName) {
  const ps = await captureCommand("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
    cwd: REPO_ROOT,
    env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
    timeoutMs: 2_000,
    limit: 512 * 1024,
  });
  if (ps.code !== 0) return false;
  const children = new Map();
  const names = new Map();
  for (const line of ps.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    names.set(pid, path.basename(match[3]));
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (names.get(pid) === executableName) return true;
    pending.push(...(children.get(pid) ?? []));
  }
  return false;
}

function spawnAppServer(mode, scratchPath, runtimePath, behavior, authHome) {
  const args = mode === "fake"
    ? [SCRIPT_PATH, "--fake-app-server", behavior ?? "", scratchPath]
    : ["app-server", "--stdio"];
  const command = mode === "fake" ? process.execPath : runtimePath;
  const env = mode === "fake"
    ? { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() }
    : mode === "authenticated"
      ? { CODEX_HOME: authHome, HOME: process.env.HOME ?? path.dirname(authHome), PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() }
      : { CODEX_HOME: path.join(scratchPath, "codex-home"), HOME: scratchPath, PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() };
  // app-server 与 Service 共用进程组：外层回归杀 Service 组时不会遗留孤儿进程。
  return spawn(command, args, { cwd: REPO_ROOT, detached: false, env, stdio: ["pipe", "pipe", "pipe"] });
}

async function runService(mode, scratchPath, resultPath, runtimePath, controllerPid, behavior, authHome, authScenario) {
  let child;
  try {
    if (mode === "real") {
      const homePath = path.join(scratchPath, "codex-home");
      await rm(homePath, { recursive: true, force: true });
      await mkdir(homePath, { mode: 0o700 });
      await chmod(homePath, 0o700);
    }
    child = spawnAppServer(mode, scratchPath, runtimePath, behavior, authHome);
    await writeFile(path.join(scratchPath, "app-server.pid"), `${child.pid}\n`, { flag: "wx", mode: 0o600 });
    const rpc = new JsonlRpcClient(child, behavior ? 400 : mode === "authenticated" ? AUTH_TIMEOUT_MS : mode === "real" ? REAL_TIMEOUT_MS : TIMEOUT_MS);
    const methods = ["initialize"];
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "shoggoth-m0-spike", title: "Shoggoth M0 Spike", version: "0.0.0" },
      capabilities: null,
    });
    methods.push("initialized");
    rpc.notify("initialized");

    if (mode === "real") {
      const auth = await rpc.request("getAuthStatus", { includeToken: false, refreshToken: false });
      methods.push("thread/start");
      let threadStart;
      let threadStartError;
      try {
        threadStart = await rpc.request("thread/start", { cwd: REPO_ROOT, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
      } catch (error) {
        threadStartError = error.message.slice(0, 320).replaceAll(scratchPath, "<scratch>");
      }
      await rpc.closeAndValidate();
      await atomicWriteJson(resultPath, {
        mode,
        protocol: { methods, initialized: Boolean(initialized) },
        auth: { authMethod: auth?.authMethod ?? null, requiresOpenaiAuth: auth?.requiresOpenaiAuth ?? null, tokenReturned: auth?.authToken != null },
        threadStart: { observed: true, accepted: Boolean(threadStart?.thread?.id), error: threadStartError ?? null },
      });
      return;
    }

    if (mode === "authenticated") {
      const auth = await rpc.request("getAuthStatus", { includeToken: false, refreshToken: true });
      if (auth?.authMethod !== "chatgpt") throw new Error("authenticated smoke requires existing ChatGPT login");
      requireNoAuthToken(auth);
      const models = await rpc.request("model/list", { limit: 100, includeHidden: false });
      const defaultModel = models?.data?.find((model) => model.isDefault) ?? models?.data?.[0];
      assert.equal(typeof defaultModel?.model, "string", "authenticated smoke requires an available model");
      methods.push("thread/start");
      const thread = await rpc.request("thread/start", {
        model: defaultModel.model,
        modelProvider: "openai",
        cwd: REPO_ROOT,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      });
      assert.equal(thread?.modelProvider, "openai");
      methods.push("turn/start");
      const completedPromise = rpc.waitFor("turn/completed");
      let turnAcknowledged = false;
      const textOnly = authScenario === "text-only";
      const reasoningScenario = authScenario === "reasoning";
      const backgroundScenario = authScenario === "background";
      const toolScenario = !textOnly && !reasoningScenario;
      let completedBeforeControllerExit = false;
      const completedOutcomePromise = completedPromise.then(
        (value) => {
          completedBeforeControllerExit = true;
          return { value };
        },
        (error) => ({ error }),
      );
      const turnPromise = rpc.request("turn/start", {
        threadId: thread.thread.id,
        input: [{
          type: "text",
          text: reasoningScenario
            ? "请进行多步推理并独立验算 12345 × 6789，最后只回复 SHOGGOTH_REASONING_OK=83810205。不要调用任何工具。"
            : textOnly
              ? "只回复 SHOGGOTH_M0_TEXT_OK，不调用任何工具。"
              : backgroundScenario
                ? "请调用 shell 工具执行只读命令 /bin/sleep 3; printf SHOGGOTH_BACKGROUND_TOOL_OK，确认输出后只回复 SHOGGOTH_BACKGROUND_OK。不得读写文件、不得访问网络。"
                : "请调用 shell 工具执行只读命令 printf SHOGGOTH_TOOL_OK，确认输出后只回复 SHOGGOTH_M0_AUTH_OK。不得读写文件、不得访问网络。",
          text_elements: [],
        }],
        effort: reasoningScenario ? "high" : "low",
        summary: reasoningScenario ? "detailed" : "concise",
      }).then((response) => {
        turnAcknowledged = true;
        return response;
      });
      let turn;
      let completed;
      try {
        turn = await turnPromise;
        if (backgroundScenario) {
          assert.equal(Number.isSafeInteger(controllerPid) && controllerPid > 1, true, "background auth service requires controller PID");
          await writeFile(path.join(scratchPath, "turn-started"), `${turn?.turn?.id ?? "unknown"}\n`, { flag: "wx", mode: 0o600 });
          await waitUntil(() => !isAlive(controllerPid), 5_000, "authenticated controller exit observation");
          assert.equal(completedBeforeControllerExit, false, "authenticated turn completed before controller exited");
        }
        const completedOutcome = await completedOutcomePromise;
        if (completedOutcome.error) throw completedOutcome.error;
        completed = completedOutcome.value;
      } catch (error) {
        throw new Error(`authenticated turn failed: ${authFailureSummary(rpc, authScenario, turnAcknowledged)}`);
      }
      assert.equal(typeof turn?.turn?.id, "string");
      assert.equal(completed.params?.turn?.status, "completed");
      const turnId = turn.turn.id;
      const evidence = collectTurnEvidence(rpc.notifications, turnId);
      const agentText = [...evidence.agentMessages.values()].join("\n");
      const commandStarted = evidence.commandEvents.find((event) => event.method === "item/started");
      const commandCompleted = evidence.commandEvents.find((event) => event.method === "item/completed");
      assert.equal(evidence.agentMessages.size > 0, true, "authenticated turn emitted no streaming delta");
      if (reasoningScenario) {
        assert.equal(evidence.reasoningEvents.length > 0, true, "reasoning smoke emitted no reasoning event");
        assert.equal(agentText.includes("SHOGGOTH_REASONING_OK=83810205"), true, "reasoning smoke did not return the expected answer");
        assert.equal(evidence.commandEvents.length, 0, "reasoning smoke must not execute tools");
      } else if (textOnly) {
        assert.equal(agentText.includes("SHOGGOTH_M0_TEXT_OK"), true, "text smoke marker is missing");
        assert.equal(evidence.commandEvents.length, 0, "text smoke must not execute tools");
      }
      let codeModeHostObserved = false;
      if (toolScenario) {
        assert.equal(Boolean(commandStarted), true, "authenticated turn emitted no command tool call");
        assert.equal(commandCompleted?.params?.item?.status, "completed");
        assert.equal(commandCompleted?.params?.item?.exitCode, 0);
        const expectedToolMarker = backgroundScenario ? "SHOGGOTH_BACKGROUND_TOOL_OK" : "SHOGGOTH_TOOL_OK";
        const expectedFinalMarker = backgroundScenario ? "SHOGGOTH_BACKGROUND_OK" : "SHOGGOTH_M0_AUTH_OK";
        assert.equal(commandCompleted?.params?.item?.aggregatedOutput?.includes(expectedToolMarker), true);
        assert.equal(agentText.includes(expectedFinalMarker), true, "tool smoke final marker is missing");
        const unavailableWarnings = rpc.notifications.filter(
          (event) => event.method === "warning" && String(event.params?.message ?? "").includes("Code Mode is unavailable"),
        );
        assert.equal(unavailableWarnings.length, 0, "Code Mode host reported unavailable");
        codeModeHostObserved = await hasDescendantProcessNamed(child.pid, "codex-code-mode-host");
        assert.equal(codeModeHostObserved, true, "tool smoke did not observe codex-code-mode-host");
      }
      await rpc.closeAndValidate();
      await atomicWriteJson(resultPath, {
        mode,
        protocol: { methods },
        auth: { authMethod: auth.authMethod, tokenReturned: false },
        model: { id: defaultModel.model, provider: thread.modelProvider },
        evidence: {
          streaming: true,
          reasoning: evidence.reasoningEvents.length > 0,
          toolCall: toolScenario,
          toolResult: toolScenario,
          codeModeHostObserved,
          controllerExitObserved: backgroundScenario,
          turnStatus: completed.params.turn.status,
        },
      });
      return;
    }

    methods.push("thread/start");
    const thread = await rpc.request("thread/start", { cwd: REPO_ROOT, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    assert.equal(typeof thread?.thread?.id, "string");
    assert.equal(Number.isSafeInteger(controllerPid) && controllerPid > 1, true, "fake service requires controller PID");
    methods.push("turn/start");
    const completedPromise = rpc.waitFor("turn/completed");
    let completedBeforeControllerExit = false;
    const completedOutcomePromise = completedPromise.then(
      (value) => {
        completedBeforeControllerExit = true;
        return { value };
      },
      (error) => ({ error }),
    );
    const turnPromise = rpc.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "M0 background continuation", text_elements: [] }],
    });
    const turn = await turnPromise;
    assert.equal(typeof turn?.turn?.id, "string");
    await writeFile(path.join(scratchPath, "turn-started"), `${turn.turn.id}\n`, { flag: "wx", mode: 0o600 });
    await waitUntil(() => !isAlive(controllerPid), 5_000, "controller exit observation");
    assert.equal(completedBeforeControllerExit, false, "fake turn completed before controller exited");
    const completedOutcome = await completedOutcomePromise;
    if (completedOutcome.error) throw completedOutcome.error;
    const completed = completedOutcome.value;
    const delta = rpc.notifications.find((event) => event.method === "item/agentMessage/delta");
    const toolCall = rpc.notifications.find((event) => event.method === "item/started" && event.params?.item?.type === "commandExecution");
    const toolResult = rpc.notifications.find((event) => event.method === "item/completed" && event.params?.item?.type === "commandExecution");
    assert.equal(delta?.params?.delta, "background-complete");
    assert.equal(toolCall?.params?.item?.status, "inProgress");
    assert.equal(toolResult?.params?.item?.status, "completed");
    assert.equal(toolResult?.params?.item?.aggregatedOutput, "spike-tool-result");
    assert.equal(completed.params?.turn?.status, "completed");
    await rpc.closeAndValidate();
    await atomicWriteJson(resultPath, {
      mode,
      servicePid: process.pid,
      appServerPid: child.pid,
      protocol: { methods },
      evidence: { controllerExitObserved: true, streamingDelta: delta.params.delta, toolCall: toolCall.params.item.command, toolResult: toolResult.params.item.aggregatedOutput, turnStatus: completed.params.turn.status },
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([once(child, "close"), delay(2_000)]).catch(() => {});
    }
  }
}

const writeJsonLine = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function runFakeAppServer(behavior, scratchPath) {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > OUTPUT_LIMIT) throw new Error("fake app-server input limit exceeded");
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        if (behavior === "fork-descendant") {
          const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            detached: false,
            stdio: "ignore",
          });
          await writeFile(path.join(scratchPath, "grandchild.pid"), `${descendant.pid}\n`, { flag: "wx", mode: 0o600 });
          descendant.unref();
          continue;
        }
        if (behavior === "timeout") continue;
        if (behavior === "malformed") {
          process.stdout.write("{malformed-json\n");
          continue;
        }
        if (behavior === "stdout-limit") {
          process.stdout.write("x".repeat(OUTPUT_LIMIT + 1));
          continue;
        }
        if (behavior === "stderr-limit") {
          process.stderr.write("x".repeat(OUTPUT_LIMIT + 1));
          continue;
        }
        if (behavior === "wrong-id") {
          writeJsonLine({ id: request.id + 100, result: {} });
          continue;
        }
        if (behavior === "bad-server-request") {
          writeJsonLine({ id: null, method: "item/commandExecution/requestApproval", params: {} });
          continue;
        }
        if (behavior === "fractional-server-request") {
          writeJsonLine({ id: 1.5, method: "item/commandExecution/requestApproval", params: {} });
          continue;
        }
        writeJsonLine({ id: request.id, result: { userAgent: "codex-m0-fake/0.149.0" } });
      } else if (request.method === "initialized") {
        if (Object.hasOwn(request, "id")) throw new Error("initialized must be a notification");
      } else if (request.method === "thread/start") {
        writeJsonLine({ id: request.id, result: { thread: { id: "thread-m0" }, model: "fake", modelProvider: "fake" } });
      } else if (request.method === "turn/start") {
        if (behavior === "turn-timeout") continue;
        writeJsonLine({ id: request.id, result: { turn: { id: "turn-m0", status: "inProgress" } } });
        await delay(behavior === "trailing-malformed" ? 10 : 450);
        const base = { threadId: "thread-m0", turnId: "turn-m0" };
        writeJsonLine({ method: "item/agentMessage/delta", params: { ...base, itemId: "message-m0", delta: "background-complete" } });
        writeJsonLine({ method: "item/started", params: { ...base, item: { id: "tool-m0", type: "commandExecution", command: "printf spike", status: "inProgress" } } });
        writeJsonLine({ method: "item/completed", params: { ...base, item: { id: "tool-m0", type: "commandExecution", command: "printf spike", status: "completed", aggregatedOutput: "spike-tool-result", exitCode: 0 } } });
        writeJsonLine({ method: "turn/completed", params: { threadId: "thread-m0", turn: { id: "turn-m0", status: "completed", items: [] } } });
        if (behavior === "trailing-malformed") {
          process.stdout.write("{unterminated-json");
          return;
        }
      } else {
        throw new Error(`unexpected fake app-server method: ${String(request.method)}`);
      }
    }
  }
}

async function runController(scratchPath, resultPath, behavior = "", handshakeTimeoutMs = 5_000) {
  const pidPath = path.join(scratchPath, "service.pid");
  const child = spawn(process.execPath, [SCRIPT_PATH, "--service", "fake", scratchPath, resultPath, "", String(process.pid), behavior], {
    cwd: REPO_ROOT,
    detached: true,
    env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
    stdio: "ignore",
  });
  let handedOff = false;
  try {
    await writeFile(pidPath, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
    child.unref();
    await waitUntil(
      async () => {
        await access(path.join(scratchPath, "turn-started"));
        return true;
      },
      handshakeTimeoutMs,
      "service turn start handshake",
    );
    let completed = true;
    try { await access(resultPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      completed = false;
    }
    process.stdout.write(`${JSON.stringify({ servicePid: child.pid, turnStartedBeforeControllerExit: true, completedBeforeControllerExit: completed })}\n`);
    handedOff = true;
  } finally {
    if (!handedOff) {
      terminatePid(child.pid);
      await waitUntil(() => !isAlive(child.pid), 5_000, "controller Service cleanup");
      await cleanupService(scratchPath);
    }
  }
}

async function runAuthenticatedController(scratchPath, resultPath, runtimePath, authHome) {
  const child = spawn(
    process.execPath,
    [SCRIPT_PATH, "--service", "authenticated", scratchPath, resultPath, runtimePath, String(process.pid), "", authHome, "background"],
    {
      cwd: REPO_ROOT,
      detached: true,
      env: { HOME: process.env.HOME ?? path.dirname(authHome), PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
      stdio: "ignore",
    },
  );
  let handedOff = false;
  try {
    await writeFile(path.join(scratchPath, "service.pid"), `${child.pid}\n`, { flag: "wx", mode: 0o600 });
    child.unref();
    await waitUntil(
      async () => {
        await access(path.join(scratchPath, "turn-started"));
        return true;
      },
      30_000,
      "authenticated turn start handshake",
    );
    let completedBeforeControllerExit = true;
    try { await access(resultPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      completedBeforeControllerExit = false;
    }
    process.stdout.write(`${JSON.stringify({ servicePid: child.pid, turnStartedBeforeControllerExit: true, completedBeforeControllerExit })}\n`);
    handedOff = true;
  } finally {
    if (!handedOff) {
      terminatePid(child.pid);
      await waitUntil(() => !isAlive(child.pid), 5_000, "authenticated controller Service cleanup");
      await cleanupService(scratchPath);
    }
  }
}

async function cleanupService(scratchPath) {
  try {
    const pid = Number((await readFile(path.join(scratchPath, "service.pid"), "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      terminatePid(pid);
      await waitUntil(() => !isAlive(pid), 5_000, "Service cleanup");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function verifyControllerFailureCleanup() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-controller-failure-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  try {
    const controller = await spawnCaptured(["--test-controller-failure", scratchPath, resultPath], 5_000);
    assert.notEqual(controller.code, 0, "controller handshake failure must fail closed");
    const servicePid = Number((await readFile(path.join(scratchPath, "service.pid"), "utf8")).trim());
    assert.equal(isAlive(servicePid), false, "failed controller must stop its detached Service");
    await assert.rejects(access(resultPath), { code: "ENOENT" });
  } finally {
    await cleanupService(scratchPath);
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function verifyForcedGroupCleanup() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-spike-abort-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  let appServerPid;
  let servicePid;
  try {
    const controller = await spawnCaptured(["--test-controller", scratchPath, resultPath]);
    assert.equal(controller.code, 0, `abort controller failed: ${controller.stderr}`);
    servicePid = JSON.parse(controller.stdout.trim()).servicePid;
    appServerPid = await waitUntil(
      async () => Number((await readFile(path.join(scratchPath, "app-server.pid"), "utf8")).trim()),
      2_000,
      "app-server pid",
    );
    assert.equal(isAlive(servicePid), true);
    assert.equal(isAlive(appServerPid), true);
    terminatePid(servicePid);
    await waitUntil(() => !isAlive(servicePid) && !isAlive(appServerPid), 5_000, "forced process-group cleanup");
    await assert.rejects(access(resultPath), { code: "ENOENT" });
  } finally {
    if (isAlive(servicePid)) terminatePid(servicePid);
    if (isAlive(appServerPid)) {
      try { process.kill(appServerPid, "SIGKILL"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await rm(scratchPath, { recursive: true, force: true });
  }
}

async function verifyProtocolFailures() {
  for (const behavior of ["timeout", "malformed", "stdout-limit", "stderr-limit", "wrong-id", "bad-server-request", "fractional-server-request", "fork-descendant", "turn-timeout", "trailing-malformed"]) {
    const scratchPath = await mkdtemp(path.join(tmpdir(), `shoggoth-codex-spike-${behavior}-`));
    await chmod(scratchPath, 0o700);
    const resultPath = path.join(scratchPath, "result.json");
    try {
      const service = await spawnCaptured(
        ["--service", "fake", scratchPath, resultPath, "", ["turn-timeout", "trailing-malformed"].includes(behavior) ? "2147483647" : "", behavior],
        5_000,
      );
      assert.notEqual(service.code, 0, `${behavior} must fail the service`);
      const appServerPid = Number((await readFile(path.join(scratchPath, "app-server.pid"), "utf8")).trim());
      await waitUntil(() => !isAlive(appServerPid), 2_000, `${behavior} app-server cleanup`);
      if (behavior === "fork-descendant") {
        const descendantPid = Number((await readFile(path.join(scratchPath, "grandchild.pid"), "utf8")).trim());
        await waitUntil(() => !isAlive(descendantPid), 2_000, "forked app-server descendant cleanup");
      }
      await assert.rejects(access(resultPath), { code: "ENOENT" });
      assert.equal((await readdir(scratchPath)).some((name) => name.startsWith("result.json.tmp-")), false);
    } finally {
      await cleanupService(scratchPath);
      await rm(scratchPath, { recursive: true, force: true });
    }
  }
}

function verifySafetyHelpers() {
  const opaqueToken = "opaque-secret-value-that-must-never-escape";
  assert.throws(
    () => requireNoAuthToken({ authToken: opaqueToken }),
    (error) => error.message === "authenticated smoke received an unexpected token"
      && !error.message.includes(opaqueToken),
  );
  assert.equal(safeRpcError({ code: 500, message: opaqueToken }).includes(opaqueToken), false);
  assert.equal(
    safeServiceFailure({ code: 1, signal: null, stderr: opaqueToken }).includes(opaqueToken),
    false,
  );
  assert.equal(
    safeServiceFailure({ code: 1, signal: null, stderr: "reasoning smoke did not return the expected answer" }).includes("category=reasoning-answer"),
    true,
  );

  const turnId = "turn-target";
  const evidence = collectTurnEvidence([
    { method: "item/agentMessage/delta", params: { turnId: "other", itemId: "message-other", delta: "ignore" } },
    { method: "item/agentMessage/delta", params: { turnId, itemId: "message-a", delta: "SHOGGOTH_" } },
    { method: "item/agentMessage/delta", params: { turnId, itemId: "message-a", delta: "M0_TEXT_OK" } },
    { method: "item/reasoning/textDelta", params: { turnId, itemId: "reasoning-a", delta: "753" } },
    { method: "item/started", params: { turnId, item: { id: "command-a", type: "commandExecution" } } },
  ], turnId);
  assert.deepEqual(evidence.agentMessages, new Map([["message-a", "SHOGGOTH_M0_TEXT_OK"]]));
  assert.equal(evidence.reasoningEvents.length, 1);
  assert.equal(evidence.commandEvents.length, 1);
}

async function runOfflineRegression() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-spike-test-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  try {
    const controller = await spawnCaptured(["--test-controller", scratchPath, resultPath]);
    assert.equal(controller.code, 0, `controller failed: ${controller.stderr}`);
    const handoff = JSON.parse(controller.stdout.trim());
    assert.equal(handoff.turnStartedBeforeControllerExit, true);
    assert.equal(handoff.completedBeforeControllerExit, false);
    assert.equal(isAlive(handoff.servicePid), true, "service must outlive controller");
    const persisted = await waitUntil(async () => JSON.parse(await readFile(resultPath, "utf8")), TIMEOUT_MS, "background result");
    assert.deepEqual(persisted.protocol.methods, ["initialize", "initialized", "thread/start", "turn/start"]);
    assert.deepEqual(persisted.evidence, { controllerExitObserved: true, streamingDelta: "background-complete", toolCall: "printf spike", toolResult: "spike-tool-result", turnStatus: "completed" });
    await waitUntil(() => !isAlive(handoff.servicePid), 5_000, "service exit");
    assert.equal(isAlive(persisted.appServerPid), false, "app-server must exit with service");
    await verifyForcedGroupCleanup();
    await verifyControllerFailureCleanup();
    await verifyProtocolFailures();
    verifySafetyHelpers();
    return { ok: true, mode: "offline-regression", controllerExitedBeforeCompletion: true, ...persisted.evidence };
  } finally {
    await cleanupService(scratchPath);
    await rm(scratchPath, { recursive: true, force: true });
    await assert.rejects(access(scratchPath), { code: "ENOENT" });
  }
}

async function runtimeForCurrentPlatform(scratchPath) {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.runtime?.version, "0.149.0", "M0 real smoke must stay pinned to Codex 0.149.0");
  const platform = process.platform === "darwin"
    ? process.arch === "arm64" ? "darwin-arm64" : process.arch === "x64" ? "darwin-x64" : null
    : null;
  if (!platform || !manifest.platforms?.[platform]) throw new Error("real smoke only supports pinned macOS platforms");
  const expectedDestination = process.arch === "arm64"
    ? ".vendor/codex/arm64/package/bin/codex"
    : ".vendor/codex/x64/package/bin/codex";
  assert.equal(manifest.platforms[platform].destination, expectedDestination);
  const runtimePath = path.resolve(REPO_ROOT, manifest.platforms[platform].destination);
  const runtimeLinkStat = await lstat(runtimePath);
  assert.equal(runtimeLinkStat.isSymbolicLink(), false, "runtime must not be a symlink");
  const repoRealPath = await realpath(REPO_ROOT);
  const runtimeRealPath = await realpath(runtimePath);
  const runtimeRelativePath = path.relative(repoRealPath, runtimeRealPath);
  assert.equal(runtimeRelativePath.startsWith("..") || path.isAbsolute(runtimeRelativePath), false, "runtime escaped repository");
  const runtimeStat = await stat(runtimeRealPath);
  assert.equal(runtimeStat.isFile(), true);
  assert.equal((runtimeStat.mode & 0o111) !== 0, true);
  const hostPath = path.resolve(REPO_ROOT, manifest.platforms[platform].hostDestination);
  assert.equal(hostPath, path.join(path.dirname(runtimeRealPath), "codex-code-mode-host"));
  const hostLinkStat = await lstat(hostPath);
  assert.equal(hostLinkStat.isSymbolicLink(), false, "Code Mode host must not be a symlink");
  const hostRealPath = await realpath(hostPath);
  const hostRelativePath = path.relative(repoRealPath, hostRealPath);
  assert.equal(hostRelativePath.startsWith("..") || path.isAbsolute(hostRelativePath), false, "Code Mode host escaped repository");
  const hostStat = await stat(hostRealPath);
  assert.equal(hostStat.isFile(), true, "Code Mode host must be a regular file");
  assert.equal((hostStat.mode & 0o111) !== 0, true, "Code Mode host must be executable");
  const versionHome = path.join(scratchPath, "version-home");
  await mkdir(versionHome, { mode: 0o700 });
  await chmod(versionHome, 0o700);
  const checked = await captureCommand(runtimeRealPath, ["--version"], {
    cwd: REPO_ROOT,
    env: { CODEX_HOME: versionHome, HOME: scratchPath, PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() },
  });
  assert.equal(checked.code, 0, "runtime version check failed");
  const version = checked.stdout.trim();
  assert.equal(version, `codex-cli ${manifest.runtime.version}`);
  return { runtimePath: runtimeRealPath, hostPath: hostRealPath, version };
}

async function validateChatGptAuthHome() {
  const authHome = path.resolve(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"));
  const authHomeStat = await lstat(authHome);
  assert.equal(authHomeStat.isDirectory(), true, "CODEX_HOME must be a directory");
  assert.equal(authHomeStat.isSymbolicLink(), false, "CODEX_HOME must not be a symlink");
  const authFileStat = await lstat(path.join(authHome, "auth.json"));
  assert.equal(authFileStat.isFile(), true, "ChatGPT auth file is unavailable");
  assert.equal(authFileStat.isSymbolicLink(), false, "ChatGPT auth file must not be a symlink");
  assert.equal((authFileStat.mode & 0o077) === 0, true, "ChatGPT auth file permissions are too broad");
  return authHome;
}

async function runRealSmoke() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-real-smoke-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  try {
    const { runtimePath, version } = await runtimeForCurrentPlatform(scratchPath);
    const service = await spawnCaptured(["--service", "real", scratchPath, resultPath, runtimePath], REAL_TIMEOUT_MS);
    assert.equal(service.code, 0, `real service failed: ${service.stderr.slice(0, 500).replaceAll(scratchPath, "<scratch>")}`);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.protocol.initialized, true);
    assert.equal(result.auth.tokenReturned, false);
    assert.equal(result.threadStart.observed, true);
    assert.equal(result.threadStart.accepted, true, result.threadStart.error ?? "real thread/start was not accepted");
    return { ok: true, mode: "real-smoke", runtime: version, ...result.auth, threadStart: result.threadStart };
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
    await assert.rejects(access(scratchPath), { code: "ENOENT" });
  }
}

async function runAuthenticatedSmoke(authScenario = "tool") {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-auth-smoke-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  try {
    const authHome = await validateChatGptAuthHome();
    const { runtimePath, version } = await runtimeForCurrentPlatform(scratchPath);
    const service = await spawnCaptured(
      ["--service", "authenticated", scratchPath, resultPath, runtimePath, "", "", authHome, authScenario],
      AUTH_TIMEOUT_MS + 15_000,
    );
    if (service.code !== 0) throw new Error(safeServiceFailure(service));
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.evidence.streaming, true);
    assert.equal(typeof result.evidence.reasoning, "boolean");
    assert.equal(result.evidence.toolCall, authScenario === "tool");
    assert.equal(result.evidence.toolResult, authScenario === "tool");
    assert.equal(result.evidence.codeModeHostObserved, authScenario === "tool");
    if (authScenario === "reasoning") assert.equal(result.evidence.reasoning, true);
    assert.equal(result.evidence.turnStatus, "completed");
    return {
      ok: true,
      mode: authScenario === "text-only"
        ? "authenticated-text-smoke"
        : authScenario === "reasoning"
          ? "authenticated-reasoning-smoke"
          : "authenticated-smoke",
      runtime: version,
      authMethod: result.auth.authMethod,
      model: result.model,
      ...result.evidence,
    };
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
    await assert.rejects(access(scratchPath), { code: "ENOENT" });
  }
}

async function runAuthenticatedBackgroundSmoke() {
  const scratchPath = await mkdtemp(path.join(tmpdir(), "shoggoth-codex-auth-background-"));
  await chmod(scratchPath, 0o700);
  const resultPath = path.join(scratchPath, "result.json");
  let servicePid;
  try {
    const authHome = await validateChatGptAuthHome();
    const { runtimePath, version } = await runtimeForCurrentPlatform(scratchPath);
    const controller = await spawnCaptured(
      ["--test-auth-controller", scratchPath, resultPath, runtimePath, authHome],
      45_000,
    );
    assert.equal(controller.code, 0, "authenticated controller failed");
    const handoff = JSON.parse(controller.stdout.trim());
    servicePid = handoff.servicePid;
    assert.equal(handoff.turnStartedBeforeControllerExit, true);
    assert.equal(handoff.completedBeforeControllerExit, false);
    assert.equal(isAlive(servicePid), true, "authenticated Service must outlive its controller");
    const result = await waitUntil(
      async () => JSON.parse(await readFile(resultPath, "utf8")),
      AUTH_TIMEOUT_MS,
      "authenticated background result",
    );
    assert.equal(result.evidence.controllerExitObserved, true);
    assert.equal(result.evidence.streaming, true);
    assert.equal(result.evidence.toolCall, true);
    assert.equal(result.evidence.toolResult, true);
    assert.equal(result.evidence.codeModeHostObserved, true);
    assert.equal(result.evidence.turnStatus, "completed");
    await waitUntil(() => !isAlive(servicePid), 10_000, "authenticated background Service exit");
    return {
      ok: true,
      mode: "authenticated-background-smoke",
      runtime: version,
      controllerExitedBeforeCompletion: true,
      ...result.evidence,
    };
  } finally {
    await cleanupService(scratchPath);
    await rm(scratchPath, { recursive: true, force: true });
    await assert.rejects(access(scratchPath), { code: "ENOENT" });
  }
}

const [role, ...args] = process.argv.slice(2);
if (role === "--fake-app-server") {
  await runFakeAppServer(args[0], args[1]);
} else if (role === "--service") {
  const [mode, scratchPath, resultPath, runtimePath, controllerPidRaw, behavior, authHome, authScenario] = args;
  if (!["fake", "real", "authenticated"].includes(mode) || !path.isAbsolute(scratchPath) || !path.isAbsolute(resultPath)) throw new Error("invalid service arguments");
  const controllerPid = controllerPidRaw ? Number(controllerPidRaw) : undefined;
  await runService(mode, scratchPath, resultPath, runtimePath, controllerPid, behavior, authHome, authScenario);
} else if (role === "--test-controller") {
  const [scratchPath, resultPath] = args;
  if (!path.isAbsolute(scratchPath) || !path.isAbsolute(resultPath)) throw new Error("invalid controller arguments");
  await runController(scratchPath, resultPath);
} else if (role === "--test-controller-failure") {
  const [scratchPath, resultPath] = args;
  if (!path.isAbsolute(scratchPath) || !path.isAbsolute(resultPath)) throw new Error("invalid controller arguments");
  await runController(scratchPath, resultPath, "timeout", 100);
} else if (role === "--test-auth-controller") {
  const [scratchPath, resultPath, runtimePath, authHome] = args;
  if (![scratchPath, resultPath, runtimePath, authHome].every(path.isAbsolute)) throw new Error("invalid authenticated controller arguments");
  await runAuthenticatedController(scratchPath, resultPath, runtimePath, authHome);
} else if (role === "--real-smoke") {
  console.log(JSON.stringify(await runRealSmoke()));
} else if (role === "--authenticated-smoke") {
  console.log(JSON.stringify(await runAuthenticatedSmoke()));
} else if (role === "--authenticated-text-smoke") {
  console.log(JSON.stringify(await runAuthenticatedSmoke("text-only")));
} else if (role === "--authenticated-reasoning-smoke") {
  console.log(JSON.stringify(await runAuthenticatedSmoke("reasoning")));
} else if (role === "--authenticated-background-smoke") {
  console.log(JSON.stringify(await runAuthenticatedBackgroundSmoke()));
} else if (role) {
  throw new Error(`unknown argument: ${role}`);
} else {
  console.log(JSON.stringify(await runOfflineRegression()));
}
