#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startProxyGateway } = require("../app/core/proxy-gateway");
const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth");
const { startStaticServer } = require("../app/static-server");
const {
  authenticateMcpSession,
  createMcpStdioHandler,
  runMcpStdioSession,
} = require("../app/shoggoth-mcp-helper");

const rounds = Number(process.env.SHOGGOTH_VERTICAL_ROUNDS || 50);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) {
  throw new TypeError("SHOGGOTH_VERTICAL_ROUNDS must be an integer from 1 to 50");
}
assert.equal(
  fs.existsSync(path.join(ROOT, "app", "manage-ui", "dist", "index.html")),
  true,
  "真实 UI bundle 不存在；请先运行 npm run build:manage",
);

function safeStorageFixture() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8"),
  };
}

function resolveElectronBinary() {
  try {
    const resolved = require("electron");
    if (typeof resolved === "string" && path.isAbsolute(resolved)) return resolved;
  } catch {}
  const commonGitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  return require(path.join(path.dirname(path.resolve(ROOT, commonGitDir)), "node_modules", "electron"));
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(`${label} timed out`));
      setTimeout(poll, 10);
    };
    void poll();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function browserPageAction(command, phase) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (predicate, label, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await delay(20);
    }
    const selectors = [
      ".chat-composer__input",
      ".chat-view",
      ".chat-empty",
      ".loading-state",
      ".error-state",
      ".app-shell",
      ".chat-queue__chip",
      ".chat-queue__pending",
      ".chat-banner",
    ];
    const counts = Object.fromEntries(selectors.map((selector) => [
      selector,
      document.querySelectorAll(selector).length,
    ]));
    const composer = document.querySelector(".chat-composer__input");
    const sendButton = document.querySelector(".chat-send:not(.chat-stop)");
    throw new Error(`${label} timed out: ${JSON.stringify({
      href: location.href,
      readyState: document.readyState,
      bodyClass: document.body?.className || "",
      bodyChildren: document.body?.children.length || 0,
      counts,
      composerLength: typeof composer?.value === "string" ? composer.value.length : null,
      sendDisabled: sendButton ? sendButton.disabled : null,
      toastKind: document.querySelector(".chat-toast")?.className || null,
      bannerKind: document.querySelector(".chat-banner")?.className || null,
      bannerText: document.querySelector(".chat-banner")?.textContent || null,
    })}`);
  };
  const openSession = async (key, tail) => {
    // Electron's did-finish-load can precede ChatPage's useEffect listener, and
    // another session may already have bootstrapped a composer. Retry the
    // idempotent navigation until the menu proves the exact target was consumed.
    await wait(() => document.querySelector(".chat-session-select"), `session switcher ${tail}`);
    const deadline = Date.now() + 15_000;
    let selected = false;
    while (!selected && Date.now() < deadline) {
      window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
      await delay(80);
      const switcher = document.querySelector(".chat-session-select");
      switcher.click();
      const active = await wait(
        () => document.querySelector(".session-menu .model-menu__item.is-active"),
        `active session ${tail}`,
        1_000,
      );
      selected = active.getAttribute("title") === key;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (!selected) await delay(170);
    }
    if (!selected) throw new Error(`target session ${tail} was not selected`);
    await wait(() => document.querySelector(".chat-composer__input"), `composer ${tail}`);
    await wait(() => !document.querySelector(".chat-banner"), `chat transport ${tail}`);
    await delay(100);
    await wait(() => !document.querySelector(".chat-banner"), `stable chat transport ${tail}`);
  };
  const send = async () => {
    await openSession(command.sessionA, command.sessionATail);
    const textarea = await wait(
      () => document.querySelector(".chat-composer__input"),
      "chat composer",
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, command.prompt);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const button = await wait(
      () => {
        const value = document.querySelector(".chat-send:not(.chat-stop)");
        return value && !value.disabled ? value : null;
      },
      "enabled send button",
    );
    button.click();
    return wait(() => document.querySelector(".chat-prompt"), "interactive prompt");
  };
  const inspect = (card) => {
    const text = card.textContent || "";
    for (const label of command.answerLabels) {
      if (!text.includes(label)) throw new Error(`missing option label ${label}`);
    }
    for (const description of command.descriptions) {
      if (!text.includes(description)) throw new Error(`missing option description ${description}`);
    }
    return text;
  };
  const respond = async () => {
    await openSession(command.sessionA, command.sessionATail);
    const card = await wait(() => document.querySelector(".chat-prompt"), "restored prompt");
    const promptText = inspect(card);
    if (command.mode === "cancel") {
      const cancel = card.querySelector("button.is-deny");
      if (!cancel) throw new Error("cancel button missing");
      cancel.click();
    } else {
      for (const label of command.answerLabels) {
        const currentCard = document.querySelector(".chat-prompt");
        const option = [...currentCard.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === label);
        if (!option) throw new Error(`option button missing: ${label}`);
        option.click();
        await delay(20);
      }
      const submit = await wait(() => [...document.querySelectorAll(".chat-prompt button.is-primary")]
        .find((button) => button.getAttribute("aria-pressed") === null && !button.disabled),
      "enabled prompt submit");
      submit.click();
      if (command.doubleClick) submit.click();
    }
    await wait(() => !document.querySelector(".chat-prompt"), "prompt removal");
    await wait(() => document.querySelector(".chat-send:not(.chat-stop)"), "turn completion");
    return { promptText };
  };

  return (async () => {
    if (phase === "prepare") {
      const card = await send();
      const promptText = inspect(card);
      await openSession(command.sessionB, command.sessionBTail);
      if (document.querySelector(".chat-prompt")) throw new Error("prompt leaked into another session");
      await openSession(command.sessionA, command.sessionATail);
      if (!document.querySelector(".chat-prompt")) throw new Error("prompt was not restored after session switch");
      return { promptText };
    }
    if (phase === "respond") return respond();
    await send();
    return respond();
  })();
}

function createBrowserFixture(root, url, sessionA, sessionB) {
  const fixturePath = path.join(root, "vertical-browser-fixture.cjs");
  const source = `
"use strict";
const readline = require("node:readline");
const { app, BrowserWindow } = require("electron");
const PAGE_ACTION = ${browserPageAction.toString()};
const URL_VALUE = ${JSON.stringify(url)};
const USER_DATA_VALUE = ${JSON.stringify(path.join(root, "electron-user-data"))};
app.setPath("userData", USER_DATA_VALUE);
let windowValue;
function emit(value) { process.stdout.write("VERTICAL:" + JSON.stringify(value) + "\\n"); }
function loaded(window) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser load timed out")), 15000);
    window.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    window.webContents.once("did-fail-load", (_event, code) => { clearTimeout(timer); reject(new Error("browser load failed " + code)); });
  });
}
async function execute(command, phase) {
  const expression = "(" + PAGE_ACTION.toString() + ")(" + JSON.stringify(command) + "," + JSON.stringify(phase) + ")";
  return windowValue.webContents.executeJavaScript(expression, true);
}
app.whenReady().then(async () => {
  windowValue = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const firstLoad = loaded(windowValue);
  await windowValue.loadURL(URL_VALUE);
  await firstLoad;
  emit({ type: "ready" });
  const input = readline.createInterface({ input: process.stdin });
  let tail = Promise.resolve();
  input.on("line", (line) => {
    tail = tail.then(async () => {
      const message = JSON.parse(line);
      if (message.type === "quit") {
        emit({ id: message.id, ok: true });
        windowValue.destroy();
        app.quit();
        return;
      }
      try {
        let result;
        if (message.phase === "prepare") {
          result = await execute(message.command, "prepare");
        } else if (message.phase === "respond") {
          if (message.command.refresh) {
            const reload = loaded(windowValue);
            windowValue.webContents.reloadIgnoringCache();
            await reload;
          }
          result = await execute(message.command, "respond");
        } else if (message.command.refresh) {
          const before = await execute(message.command, "prepare");
          const reload = loaded(windowValue);
          windowValue.webContents.reloadIgnoringCache();
          await reload;
          const after = await execute(message.command, "respond");
          result = { before, after };
        } else {
          result = await execute(message.command, "full");
        }
        emit({ id: message.id, ok: true, result });
      } catch (error) {
        emit({ id: message.id, ok: false, error: String(error && error.stack || error) });
      }
    });
  });
}).catch((error) => { emit({ type: "fatal", error: String(error && error.stack || error) }); app.exit(1); });
`;
  fs.writeFileSync(fixturePath, source, { mode: 0o600 });
  const child = spawn(resolveElectronBinary(), [fixturePath], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  lines.on("line", (line) => {
    if (!line.startsWith("VERTICAL:")) return;
    const message = JSON.parse(line.slice("VERTICAL:".length));
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const wait = (match, label, timeoutMs = 30_000) => {
    const index = messages.findIndex(match);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out\n${stderr}`)), timeoutMs);
      waiters.push({ match, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  let sequence = 0;
  return {
    child,
    wait,
    ready: () => wait((message) => message.type === "ready", "browser ready"),
    async command(command, phase = null) {
      const id = `command-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type: "command", command, phase })}\n`);
      const response = await wait((message) => message.id === id, id);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
    async close() {
      if (child.exitCode !== null) return;
      const id = `quit-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type: "quit" })}\n`);
      await wait((message) => message.id === id, id, 5_000).catch(() => {});
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
    sessionA,
    sessionB,
  };
}

function createLineReader(stream) {
  let buffered = "";
  const messages = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else messages.push(message);
    }
  });
  return (match, label, timeoutMs = 10_000) => {
    const index = messages.findIndex(match);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      waiters.push({ match, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
}

function questionSet(index) {
  if (index === 1) {
    return [{
      header: "Region", id: "region", question: "Choose region",
      options: [{ label: "North", description: "Northern cluster" }, { label: "South", description: "Southern cluster" }],
    }, {
      header: "Tier", id: "tier", question: "Choose tier",
      options: [{ label: "Basic", description: "Lower cost" }, { label: "Pro", description: "Higher capacity" }],
    }, {
      header: "Mode", id: "mode", question: "Choose mode",
      options: [{ label: "Safe", description: "Conservative" }, { label: "Fast", description: "Faster" }],
    }];
  }
  return [{
    header: "Choice", id: "choice", question: `Choose one ${index}`,
    options: [{ label: "Alpha", description: "First" }, { label: "Beta", description: "Second" }],
  }];
}

function createCapabilityAdapters() {
  const stats = {
    systemSearches: 0,
    systemLaunches: 0,
    computerActions: [],
    federationRuns: [],
  };
  const application = {
    name: "Fixture App",
    bundleId: "com.shoggoth.Fixture",
    path: "/Applications/Fixture.app",
  };
  const computerSessions = new Map();
  let computerSequence = 0;
  const computerUseController = {
    async open() {},
    async close() { computerSessions.clear(); },
    status(profileId) {
      return {
        available: true,
        driverVersion: "fixture",
        contractVersion: "fixture",
        permissions: { accessibility: true, screenRecording: true },
        sessions: [...computerSessions.values()]
          .filter((session) => session.profileId === profileId).map((session) => structuredClone(session)),
      };
    },
    list(profileId) {
      return [...computerSessions.values()].filter((session) => session.profileId === profileId)
        .map((session) => structuredClone(session));
    },
    create(input) {
      const session = {
        id: `computer-fixture-${++computerSequence}`,
        profileId: input.profileId,
        workRunId: input.workRunId,
        allowedApplications: [...input.allowedApplications],
        status: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + (input.expiresInSeconds * 1_000),
        pauseReason: null,
      };
      computerSessions.set(session.id, session);
      stats.computerActions.push(["open", session.id]);
      return structuredClone(session);
    },
    resume(input) {
      const session = computerSessions.get(input.sessionId);
      if (!session || session.profileId !== input.profileId
        || session.workRunId !== input.workRunId) {
        throw Object.assign(new Error("computer ownership mismatch"), { code: "COMPUTER_SESSION_NOT_FOUND" });
      }
      session.status = "ready";
      session.pauseReason = null;
      return structuredClone(session);
    },
    applicationList(input) {
      return {
        sessionId: input.sessionId,
        applications: [{ bundleId: "com.shoggoth.Fixture", name: "Fixture App", pid: 42 }],
      };
    },
    windowList(input) {
      return {
        sessionId: input.sessionId,
        windows: [{ bundleId: "com.shoggoth.Fixture", pid: 42, windowId: 7, title: "Fixture" }],
      };
    },
    focus(input) {
      return { sessionId: input.sessionId, requiresFreshSnapshot: true };
    },
    snapshot(input) {
      const session = computerSessions.get(input.sessionId);
      if (!session || session.profileId !== input.profileId
        || session.workRunId !== input.workRunId) {
        throw Object.assign(new Error("computer ownership mismatch"), { code: "COMPUTER_SESSION_NOT_FOUND" });
      }
      stats.computerActions.push(["snapshot", session.id]);
      return {
        sessionId: session.id,
        snapshotRevision: "revision-1",
        pid: input.pid,
        windowId: input.windowId,
        tree: "button Save; textbox Document",
        elements: [{ ref: "c1", role: "button", name: "Save", secure: false }],
        degraded: false,
        image: null,
      };
    },
    action(input) {
      const session = computerSessions.get(input.sessionId);
      if (!session || session.profileId !== input.profileId
        || session.workRunId !== input.workRunId) {
        throw Object.assign(new Error("computer ownership mismatch"), { code: "COMPUTER_SESSION_NOT_FOUND" });
      }
      stats.computerActions.push([input.action, session.id]);
      return {
        sessionId: session.id,
        action: input.action,
        attempted: true,
        requiresFreshSnapshot: true,
      };
    },
    async closeSession(input) {
      const session = computerSessions.get(input.sessionId);
      if (!session || session.profileId !== input.profileId
        || session.workRunId !== input.workRunId) {
        throw Object.assign(new Error("computer ownership mismatch"), { code: "COMPUTER_SESSION_NOT_FOUND" });
      }
      computerSessions.delete(input.sessionId);
      stats.computerActions.push(["close", input.sessionId]);
      return { sessionId: input.sessionId, closed: true };
    },
    async closeForWorkRun(profileId, workRunId) {
      for (const [sessionId, session] of computerSessions) {
        if (session.profileId === profileId && session.workRunId === workRunId) {
          computerSessions.delete(sessionId);
        }
      }
    },
    async closeForProfile(profileId) {
      for (const [sessionId, session] of computerSessions) {
        if (session.profileId === profileId) computerSessions.delete(sessionId);
      }
    },
  };

  const federationHostClient = {
    async request(method, params) {
      if (method === "backend.status") return { backends: [
        { id: "openclaw", connected: true, disabled: false },
        { id: "hermes", connected: true, disabled: false },
      ] };
      if (method === "backend.require") {
        return { backend: { id: params.backendId, connected: true } };
      }
      if (method === "agent.list") {
        return { backendId: params.backendId, agents: [{
          id: "fixture-agent", backendId: params.backendId, name: "Fixture Agent",
        }] };
      }
      if (method === "agent.get") return { agent: {
        id: params.agentId, backendId: params.backendId, name: "Fixture Agent",
      } };
      if (method === "federation.run") {
        stats.federationRuns.push(params.backendId);
        return {
          task: {
            taskId: `fixture-task-${params.backendId}-${stats.federationRuns.length}`,
            sessionKey: `fixture-${params.backendId}`,
            status: "completed",
            turn: 1,
            result: `delegated ${params.backendId}`,
            errorCode: null,
          },
        };
      }
      if (method === "cron.list") {
        return { backendId: params.backendId, total: 0, jobs: [] };
      }
      throw new Error(`unexpected federation method: ${method}`);
    },
  };

  const systemHostController = {
    search() {
      stats.systemSearches += 1;
      return { applications: [application] };
    },
    launch() {
      stats.systemLaunches += 1;
      return { application, launched: true };
    },
    openUrl(input) { return { url: input.url, opened: true }; },
    openFolder() { return { path: "/tmp", selected: null, opened: true }; },
  };

  return {
    stats,
    systemHostController,
    computerUseController,
    federationHostClient,
    residualSessions: () => computerSessions.size,
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agent-vertical-"));
fs.chmodSync(root, 0o700);
const paths = resolveServicePaths({
  trustedRoot: root,
  stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"),
  cacheRoot: path.join(root, "cache"),
});
const responsePath = path.join(root, "codex-elicitation-responses.jsonl");
const schemaPath = path.join(root, "codex-elicitation-schema.json");
let service = null;
let backend = null;
let proxy = null;
let staticServer = null;
let upstreamHttp = null;
let upstreamWss = null;
let browser = null;
let helperSession = null;
let helperHandler = null;
let helperServiceSession = null;
const helperInput = new PassThrough();
const helperOutput = new PassThrough();
const capabilityAdapters = createCapabilityAdapters();

try {
  const safeStorage = safeStorageFixture();
  const runtimePool = new CodexRuntimePool({
    paths,
    failureThreshold: 100,
    hostFactory: (options) => new CodexRuntimeHost({
      ...options,
      repoRoot: ROOT,
      packageVersion: "0.8.41",
      probeBinary: async () => {},
      spawnEnv: {
        CODEX_FAKE_BEHAVIOR: "mcp-elicitation",
        // Codex thread/turn IDs are protocol identities, not runtime profile
        // secrets. Keep the fixture IDs independent so event routing is tested
        // after the production redaction boundary.
        CODEX_FAKE_PROFILE: "vertical-runtime",
        CODEX_FAKE_ELICITATION_MODE: "valid",
        CODEX_FAKE_ELICITATION_RESPONSE_PATH: responsePath,
        CODEX_FAKE_ELICITATION_SCHEMA_PATH: schemaPath,
        CODEX_FAKE_ELICITATION_REPEAT: "1",
        CODEX_FAKE_COMPLETE_AFTER_ELICITATION: "1",
        CODEX_FAKE_INDEPENDENT_IDS: "1",
        CODEX_FAKE_AUTOCOMPLETE_DOMAIN: "1",
      },
      spawnProcess(_command, _args, spawnOptions) {
        return spawn(process.execPath, [path.join(ROOT, "scripts", "fixtures", "codex-app-server-fake.cjs")], spawnOptions);
      },
      requestTimeoutMs: 2_000,
      initializeTimeoutMs: 2_000,
      serverRequestTimeoutMs: 20_000,
      shutdownGraceMs: 100,
      killGraceMs: 100,
    }),
  });
  service = createAgentService({
    paths,
    version: "vertical-e2e",
    safeStorage,
    runtimePool,
    randomUUID: crypto.randomUUID,
    systemHostController: capabilityAdapters.systemHostController,
    computerUseController: capabilityAdapters.computerUseController,
    federationHostClient: capabilityAdapters.federationHostClient,
  });
  await service.start();
  const serviceProfile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  helperServiceSession = await authenticateMcpSession({
    paths,
    runtimeProfileId: serviceProfile.runtimeProfileId,
    runtimeAccountId: serviceProfile.runtimeAccountId,
    safeStorage,
  });
  const token = readClientToken(paths);
  const ipc = (method, params, id = crypto.randomUUID()) => requestService(paths, {
    id, token, version: PROTOCOL_VERSION, method, params,
  });
  const listed = await ipc("chat.session.list", {
    profileId: DEFAULT_AGENT_PROFILE_ID, cursor: null, limit: 10, includeArchived: false,
  });
  assert.equal(listed.sessions.length, 1);
  const sessionAValue = listed.sessions[0];
  const created = await ipc("chat.session.create", {
    operationId: "vertical-create-second",
    profileId: DEFAULT_AGENT_PROFILE_ID,
    workspace: null,
    createdAt: Date.now(),
  });
  const sessionBValue = created.session;

  let inputResponses = 0;
  backend = new ShoggothBackend({
    paths,
    pollIntervalMs: 5,
    readinessIntervalMs: 5,
    readinessTimeoutMs: 5_000,
    requestService: async (targetPaths, request, options) => {
      if (request.method === "run.input.respond") inputResponses += 1;
      return requestService(targetPaths, request, options);
    },
  });
  const registry = new BackendRegistry();
  registry.register(backend);
  assert.equal(await backend.start(), true);

  upstreamHttp = http.createServer();
  upstreamWss = new WebSocketServer({ server: upstreamHttp });
  upstreamWss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "vertical" } }));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type !== "req") return;
      let payload = {};
      if (frame.method === "connect") payload = {
        type: "hello-ok",
        protocol: 1,
        server: { version: "2026.8.1" },
        features: { methods: [], events: [] },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 64 * 1024, maxBufferedBytes: 256 * 1024 },
      };
      else if (frame.method === "agents.list") payload = { agents: [{ id: "main", name: "Main" }] };
      else if (frame.method === "models.list") payload = { models: [] };
      else if (frame.method === "sessions.list") payload = {
        ts: Date.now(), path: "/", count: 1, defaults: {},
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
      };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  await listen(upstreamHttp);
  proxy = await startProxyGateway({
    port: 0,
    getUpstreamUrl: () => `ws://127.0.0.1:${upstreamHttp.address().port}`,
    registry,
    workAdmissionGate: createWorkAdmissionGate(),
  });
  const chatIdentity = generateIdentity();
  staticServer = await startStaticServer(0, {
    registry,
    chatUpstreamUrl: proxy.url,
    chatOrigin: "http://127.0.0.1",
    authResolver: {
      resolveConnectAuth: () => ({
        ...chatIdentity,
        token: "vertical-fixture-token",
        scopes: DEFAULT_OPERATOR_SCOPES,
      }),
      storeDeviceToken: () => {},
    },
  });

  const profile = service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const skillState = service.nativeSkillStore.list(profile.id);
  const builtinSkill = skillState.items.find((skill) => skill.source === "builtin");
  assert.ok(builtinSkill, "vertical fixture requires one built-in native Skill");
  service.nativeSkillStore.setProfileSkill({
    profileId: profile.id,
    skillId: builtinSkill.id,
    source: builtinSkill.source,
    version: builtinSkill.version,
    enabled: true,
    expectedRevision: skillState.profileRevision,
  });
  const sessionA = `agent:${profile.agentId}:${sessionAValue.sessionKey}`;
  const sessionB = `agent:${profile.agentId}:${sessionBValue.sessionKey}`;
  browser = createBrowserFixture(root, `${staticServer.url}/chat`, sessionA, sessionB);
  await browser.ready();

  helperHandler = createMcpStdioHandler({
    paths,
    runtimeProfileId: profile.runtimeProfileId,
    runtimeAccountId: profile.runtimeAccountId,
    sessionToken: helperServiceSession.token,
    requestService,
  });
  helperSession = runMcpStdioSession({
    input: helperInput,
    output: helperOutput,
    handler: helperHandler,
    clientRequestTimeoutMs: 30_000,
  });
  const nextHelperLine = createLineReader(helperOutput);
  helperInput.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "vertical-fake-codex", version: "0.149.0" },
    },
  })}\n`);
  assert.equal((await nextHelperLine((message) => message.id === 1, "helper initialize"))
    .result.protocolVersion, "2025-06-18");

  let productToolSequence = 10_000;
  let productConfirmationCount = 0;
  const callProductTool = async (name, args, options = {}) => {
    const id = ++productToolSequence;
    helperInput.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    })}\n`);
    if (options.confirm === true) {
      const elicitation = await nextHelperLine(
        (message) => message.method === "elicitation/create",
        `${name} product confirmation`,
      );
      assert.deepEqual(elicitation.params.requestedSchema.properties.confirm_product_action.enum,
        ["确认执行", "取消"]);
      productConfirmationCount += 1;
      helperInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: elicitation.id,
        result: { action: "accept", content: { confirm_product_action: "确认执行" } },
      })}\n`);
    }
    const response = await nextHelperLine((message) => message.id === id, `${name} response`, 20_000);
    assert.equal(Object.hasOwn(response, "error"), false, `${name}: ${JSON.stringify(response.error)}`);
    assert.equal(response.result.isError, false, `${name}: ${JSON.stringify(response.result)}`);
    assert.ok(response.result.structuredContent && typeof response.result.structuredContent === "object");
    return response.result.structuredContent;
  };

  const executeActiveCapabilityMatrix = async (index) => {
    const source = { source: "chat", sourceId: sessionAValue.sessionKey };

    const catalog = await callProductTool("skill_catalog", { cursor: 0, limit: 10 });
    const selectedSkill = catalog.items.find((item) => item.name === builtinSkill.name);
    assert.ok(selectedSkill);
    const skill = await callProductTool("skill_read", {
      name: selectedSkill.name,
      contentHash: selectedSkill.contentHash,
      cursor: 0,
      maxBytes: 32 * 1024,
    });
    assert.match(skill.content, /Shoggoth/u);

    const searched = await callProductTool("system_application_search", {
      query: "Fixture", limit: 10,
    });
    assert.equal(searched.applications[0].bundleId, "com.shoggoth.Fixture");
    const launched = await callProductTool("system_application_launch", {
      bundleId: searched.applications[0].bundleId,
    });
    assert.equal(launched.launched, true);
    const readBack = await callProductTool("system_application_search", { query: "Fixture" });
    assert.equal(readBack.applications[0].path, "/Applications/Fixture.app");

    assert.equal((await callProductTool("computer_status", {})).available, true);
    const openedComputer = await callProductTool("computer_session_open", {
      ...source,
      allowedApplications: ["com.shoggoth.Fixture"],
      expiresInSeconds: 120,
    }, { confirm: true });
    const computerBase = {
      ...source,
      sessionId: openedComputer.id,
      pid: 42,
      windowId: 7,
    };
    const computerSnapshot1 = await callProductTool("computer_snapshot", computerBase);
    assert.equal((await callProductTool("computer_click", {
      ...computerBase,
      snapshotRevision: computerSnapshot1.snapshotRevision,
      ref: "c1",
      x: null,
      y: null,
    })).action, "click");
    const computerSnapshot2 = await callProductTool("computer_snapshot", computerBase);
    assert.equal((await callProductTool("computer_type", {
      ...computerBase,
      snapshotRevision: computerSnapshot2.snapshotRevision,
      ref: "c1",
      text: `vertical ${index}`,
    })).action, "type");
    assert.equal((await callProductTool("computer_session_close", {
      ...source, sessionId: openedComputer.id,
    })).closed, true);

    const boardResult = await callProductTool("kanban_board_create", {
      slug: `vertical-${index}`,
      name: `Vertical ${index}`,
      description: "vertical capability matrix",
    });
    const boardId = boardResult.board.id;
    const cardResult = await callProductTool("kanban_card_create", {
      boardId,
      title: `Card ${index}`,
      body: "created by vertical matrix",
      position: 0,
    });
    const cardId = cardResult.card.id;
    await callProductTool("kanban_card_update", {
      cardId, patch: { title: `Card ${index} updated` },
    });
    await callProductTool("kanban_add_comment", { cardId, body: `comment ${index}` });
    const cardRead = await callProductTool("kanban_get", {
      cardId, cursor: null, maxBytes: 32 * 1024,
    });
    assert.equal(cardRead.card.title, `Card ${index} updated`);

    const federation = await callProductTool("backend_status", {});
    assert.equal(federation.backends.every((item) => item.connected), true);
    const agents = await callProductTool("federation_agent_list", {});
    for (const backendId of ["openclaw", "hermes"]) {
      assert.equal(agents.agents.some((agent) => (
        agent.backendId === backendId && agent.agentId === "fixture-agent"
      )), true);
      const delegated = await callProductTool("federation_agent_run", {
        backendId,
        agentId: "fixture-agent",
        prompt: `vertical delegation ${index}`,
        timeoutMs: 5_000,
      });
      assert.equal(delegated.task.result, `delegated ${backendId}`);
      assert.equal(delegated.task.status, "completed");
      assert.equal(typeof delegated.handle, "string");
    }
  };

  const executeCronMatrix = async (index) => {
    const created = await callProductTool("cron_create", {
      name: `Vertical cron ${index}`,
      prompt: `vertical cron prompt ${index}`,
      workspace: null,
      schedule: { kind: "every", everyMs: 86_400_000, anchorMs: Date.now() },
      enabled: false,
      misfirePolicy: "latest",
      maxCatchUp: 1,
      overlapPolicy: "skip",
      threadPolicy: "new",
      threadId: null,
    });
    const jobId = created.job.id;
    const triggered = await callProductTool("cron_run_now", { jobId });
    const runId = triggered.run.id;
    const terminal = await waitFor(async () => {
      const listed = await callProductTool("cron_run_list", {
        jobId, status: null, cursor: null, limit: 10,
      });
      return listed.runs.find((entry) => entry.run.id === runId
        && ["completed", "failed", "canceled", "interrupted", "skipped"].includes(entry.run.status))?.run;
    }, 10_000, `cron run ${index} terminal`);
    assert.equal(terminal.status, "completed");
    const listedJobs = await callProductTool("cron_list", {
      enabled: null, cursor: null, limit: 100,
    });
    assert.equal(listedJobs.jobs.some((job) => job.id === jobId), true);
    assert.equal((await callProductTool("cron_delete", { jobId }, { confirm: true })).deleted, true);
  };

  let consumedResponses = 0;
  for (let index = 0; index < rounds; index += 1) {
    const questions = questionSet(index);
    const toolCallId = index + 100;
    helperInput.write(`${JSON.stringify({
      jsonrpc: "2.0", id: toolCallId, method: "tools/call", params: {
        name: "request_user_input", arguments: { questions },
      },
    })}\n`);
    const outbound = await nextHelperLine(
      (message) => message.method === "elicitation/create",
      `helper elicitation ${index}`,
    );
    fs.writeFileSync(schemaPath, `${JSON.stringify(outbound.params)}\n`, { mode: 0o600 });
    const cancel = index === 2;
    const answerLabels = cancel ? [] : questions.map((question) => question.options[1].label);
    const descriptions = questions.flatMap((question) => question.options.map((option) => option.description));
    const browserCommand = {
      prompt: `vertical prompt ${index}`,
      mode: cancel ? "cancel" : "submit",
      answerLabels,
      descriptions,
      doubleClick: index === 0,
      refresh: index === 0,
      sessionA,
      sessionATail: sessionAValue.sessionKey,
      sessionB,
      sessionBTail: sessionBValue.sessionKey,
    };
    await browser.command(browserCommand, "prepare");
    await executeActiveCapabilityMatrix(index);
    await browser.command(browserCommand, "respond");
    const response = await waitFor(() => {
      if (!fs.existsSync(responsePath)) return null;
      const lines = fs.readFileSync(responsePath, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length <= consumedResponses) return null;
      return JSON.parse(lines[consumedResponses]);
    }, 10_000, `Codex elicitation response ${index}`);
    consumedResponses += 1;
    helperInput.write(`${JSON.stringify({
      jsonrpc: "2.0", id: outbound.id, result: response.result,
    })}\n`);
    const toolResponse = await nextHelperLine(
      (message) => message.id === toolCallId,
      `helper tool response ${index}`,
    );
    assert.equal(toolResponse.result.isError, false);
    const expectedAnswers = cancel ? {} : Object.fromEntries(
      questions.map((question) => [question.id, { answers: [question.options[1].label] }]),
    );
    assert.deepEqual(toolResponse.result.structuredContent, { answers: expectedAnswers });
    await waitFor(
      () => service.productStore.listWorkRuns({ source: "chat" })
        .filter((run) => run.sourceId === sessionAValue.sessionKey).length === index + 1
        && service.productStore.listWorkRuns({ source: "chat" })
          .filter((run) => run.sourceId === sessionAValue.sessionKey)
          .every((run) => run.status === "completed"),
      10_000,
      `chat run ${index} terminal`,
    );
    await executeCronMatrix(index);
  }

  try {
    await waitFor(
      () => service.productStore.listWorkRuns().filter((run) => run.source === "chat").length === rounds
        && service.productStore.listWorkRuns().filter((run) => run.source === "chat")
          .every((run) => run.status === "completed"),
      10_000,
      "all vertical WorkRuns terminal",
    );
  } catch (error) {
    const failedRuns = service.productStore.listWorkRuns();
    console.error("vertical WorkRuns:", failedRuns);
    for (const run of failedRuns) {
      const replay = service.workRunCoordinator.subscribeRun(
        run.id,
        { streamId: null, afterSeq: 0 },
        () => {},
      );
      replay.unsubscribe();
      console.error("vertical run events:", replay.events);
    }
    console.error("vertical last errors:", [...service.workRunCoordinator.lastErrors.entries()]);
    console.error("vertical run contexts:", [...service.workRunCoordinator.runContexts.entries()]);
    console.error("vertical host observers:", JSON.stringify(
      [...service.workRunCoordinator.hostObservers.values()].map((observer) => ({
        runtimeProfileId: observer.runtimeProfileId,
        pendingEvents: observer.pendingEvents,
      })),
      null,
      2,
    ));
    console.error("vertical runtime entries:", [...runtimePool.entries.entries()].map(([key, entry]) => ({
      key,
      state: entry.host?.state,
      stderr: entry.host?.rpc?.stderrDiagnostic?.(),
      pendingRequests: entry.host?.rpc?.pending?.size,
      activeServerRequests: entry.host?.rpc?.activeServerRequestIds?.size,
    })));
    throw error;
  }
  assert.equal(inputResponses, rounds, "双击或刷新不得重复 run.input.respond");
  assert.equal(consumedResponses, rounds);
  assert.equal(runtimePool.entries.size, 1, "50 轮应复用同一 warm Runtime");
  assert.equal(productConfirmationCount, rounds * 2,
    "每轮只能有 Computer open 与 Cron delete 两次产品确认");
  assert.equal(capabilityAdapters.residualSessions(), 0);
  assert.equal(capabilityAdapters.stats.systemLaunches, rounds);
  assert.equal(capabilityAdapters.stats.federationRuns.length, rounds * 2);
  assert.equal(service.nativeSkillStore.usage(profile.id).skills[builtinSkill.name][profile.id], rounds);
  console.log(`PASS Shoggoth Agent vertical E2E ${rounds}/${rounds}; full capability matrix; UI responses=${inputResponses}; product confirmations=${productConfirmationCount}`);
} finally {
  helperInput.end();
  if (helperSession) await helperSession.catch(() => {});
  helperHandler?.close?.();
  if (browser) await browser.close().catch(() => {});
  if (staticServer) await staticServer.close().catch(() => {});
  if (proxy) await proxy.close().catch(() => {});
  if (upstreamWss) {
    for (const socket of upstreamWss.clients) socket.terminate();
    await new Promise((resolve) => upstreamWss.close(() => resolve())).catch(() => {});
  }
  if (upstreamHttp) await new Promise((resolve) => upstreamHttp.close(() => resolve())).catch(() => {});
  if (backend) await backend.stop().catch(() => {});
  if (service) await service.stop({ notify: false }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
