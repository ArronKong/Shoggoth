#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.149.0\n");
  process.exit(0);
}

function forkDescendant() {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore",
  });
  fs.writeFileSync(process.env.CODEX_FAKE_PID_PATH, `${descendant.pid}\n`, { mode: 0o600 });
  descendant.unref();
}

const elicitationBehavior = process.env.CODEX_FAKE_BEHAVIOR === "mcp-elicitation";
const elicitationProfile = process.env.CODEX_FAKE_PROFILE || "runtime-default";
const elicitationMode = process.env.CODEX_FAKE_ELICITATION_MODE || "valid";
const elicitationResponsePath = process.env.CODEX_FAKE_ELICITATION_RESPONSE_PATH || "";
const elicitationSchemaPath = process.env.CODEX_FAKE_ELICITATION_SCHEMA_PATH || "";
const elicitationRepeat = process.env.CODEX_FAKE_ELICITATION_REPEAT === "1";
const completeAfterElicitation = process.env.CODEX_FAKE_COMPLETE_AFTER_ELICITATION === "1";
const independentProtocolIds = process.env.CODEX_FAKE_INDEPENDENT_IDS === "1";
// RuntimeHost treats spawn environment values as secrets. Derive a namespace
// so fake protocol IDs are distinct without embedding a redacted env value.
const independentIdPrefix = process.env.CODEX_FAKE_ID_NAMESPACE
  ? `${crypto.createHash("sha256").update(process.env.CODEX_FAKE_ID_NAMESPACE).digest("hex").slice(0, 10)}-` : "";
const autocompleteDomain = process.env.CODEX_FAKE_AUTOCOMPLETE_DOMAIN === "1";
const elicitationThreadId = process.env.CODEX_FAKE_ELICITATION_THREAD_ID || "";
const elicitationTurnId = process.env.CODEX_FAKE_ELICITATION_TURN_ID || "";
const allowedElicitationModes = new Set([
  "valid",
  "wrong-thread",
  "wrong-turn",
  "cross-profile",
  "unknown-response",
]);
const validOverrideId = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
const elicitationEnabled = elicitationBehavior
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(elicitationProfile)
  && allowedElicitationModes.has(elicitationMode)
  && path.isAbsolute(elicitationResponsePath)
  && (elicitationMode !== "cross-profile"
    || (validOverrideId(elicitationThreadId) && validOverrideId(elicitationTurnId)));
const threads = new Map();
let pendingServerRequestId = null;
let pendingTurn = null;
let elicitationSent = false;
let turnSequence = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function thread(id, threadSource = null) {
  const existing = threads.get(id);
  if (existing) return existing;
  const created = {
    id,
    preview: "",
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    ephemeral: true,
    turns: [],
    cwd: process.cwd(),
    cliVersion: "0.149.0",
    source: "appServer",
    sessionId: `session-${id}`,
    projectId: null,
    threadSource,
  };
  threads.set(id, created);
  return created;
}

function threadConfigResponse(value) {
  return {
    thread: value,
    model: "fake-model",
    modelProvider: "fake",
    serviceTier: null,
    cwd: process.cwd(),
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort: null,
  };
}

function emitElicitation(threadId, turnId) {
  if (!elicitationEnabled || elicitationSent) return;
  elicitationSent = true;
  if (elicitationMode === "unknown-response") {
    setTimeout(() => send({ id: 999999, result: {} }), 20);
    return;
  }
  const requestThreadId = elicitationMode === "wrong-thread"
    ? `${threadId}-wrong`
    : elicitationMode === "cross-profile" ? elicitationThreadId : threadId;
  const requestTurnId = elicitationMode === "wrong-turn"
    ? `${turnId}-wrong`
    : elicitationMode === "cross-profile" ? elicitationTurnId : turnId;
  let fixture = null;
  if (path.isAbsolute(elicitationSchemaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(elicitationSchemaPath, "utf8"));
      if (parsed && typeof parsed.message === "string"
        && parsed.requestedSchema && typeof parsed.requestedSchema === "object") fixture = parsed;
    } catch {}
  }
  pendingServerRequestId = `fake-elicitation-${elicitationProfile}-${turnSequence}`;
  pendingTurn = { threadId, turnId };
  if (process.env.CODEX_FAKE_INSPIRATION_APPROVALS === "1" && turnSequence % 2 === 0) {
    setTimeout(() => send({
      id: pendingServerRequestId, method: "item/commandExecution/requestApproval",
      params: { threadId: requestThreadId, turnId: requestTurnId, itemId: `command-${turnSequence}`,
        startedAtMs: Date.now(), environmentId: null,
        command: "mkdir -p inspiration-demo", cwd: process.cwd(), reason: "Create the demo directory" },
    }), 20);
    return;
  }
  setTimeout(() => send({
    id: pendingServerRequestId,
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "shoggoth",
      threadId: requestThreadId,
      turnId: requestTurnId,
      mode: "form",
      message: fixture?.message || "Choose one",
      requestedSchema: fixture?.requestedSchema || {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Choice",
            description: "Choose one\nAlpha: First\nBeta: Second",
            enum: ["Alpha", "Beta"],
            enumNames: ["Alpha", "Beta"],
          },
        },
        required: ["choice"],
      },
    },
  }), 20);
}

function completeTurn(threadId, turnId) {
  const current = thread(threadId);
  const turn = current.turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.status === "completed") return;
  const item = {
    type: "agentMessage",
    id: `answer-${turn.id}`,
    text: `completed ${turn.id}`,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
  };
  turn.status = "completed";
  turn.itemsView = "full";
  turn.items.push(item);
  turn.completedAt = Math.floor(Date.now() / 1_000);
  turn.durationMs = 1;
  turn.error = null;
  send({ method: "item/completed", params: {
    threadId: current.id,
    turnId: turn.id,
    item,
    completedAtMs: Date.now(),
  } });
  send({ method: "turn/completed", params: { threadId: current.id, turn } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      if (message.id === pendingServerRequestId && elicitationEnabled) {
        fs.writeFileSync(
          elicitationResponsePath,
          `${JSON.stringify(message)}\n`,
          { mode: 0o600, flag: elicitationRepeat ? "a" : "w" },
        );
        if (completeAfterElicitation && pendingTurn) {
          completeTurn(pendingTurn.threadId, pendingTurn.turnId);
        }
        pendingServerRequestId = null;
        pendingTurn = null;
        if (elicitationRepeat) elicitationSent = false;
      }
    } else if (message.method === "initialize") {
      send({
        id: message.id,
        result: {
          userAgent: "codex/0.149.0",
          codexHome: process.env.CODEX_HOME,
          platformFamily: "unix",
          platformOs: process.platform === "darwin" ? "macos" : process.platform,
        },
      });
    } else if (message.method === "initialized"
      && process.env.CODEX_FAKE_BEHAVIOR === "fork-descendant") {
      forkDescendant();
    } else if (message.method === "account/read") {
      send({ id: message.id, result: {
        account: { type: "chatgpt", email: null, planType: "plus" },
        requiresOpenaiAuth: true,
      } });
    } else if (elicitationEnabled && message.method === "thread/resume") {
      send({ id: message.id, result: threadConfigResponse(thread(message.params.threadId)) });
    } else if (elicitationEnabled && message.method === "thread/inject_items") {
      thread(message.params.threadId);
      send({ id: message.id, result: {} });
    } else if (elicitationEnabled && message.method === "thread/read") {
      send({ id: message.id, result: { thread: thread(message.params.threadId) } });
    } else if (elicitationEnabled && message.method === "thread/list") {
      send({ id: message.id, result: {
        data: [...threads.values()], nextCursor: null, backwardsCursor: null,
      } });
    } else if (elicitationEnabled && message.method === "thread/start") {
      const created = thread(
        independentProtocolIds ? `thread-fixture-${independentIdPrefix}${threads.size + 1}` : `thread-${elicitationProfile}`,
        message.params.threadSource ?? null,
      );
      send({ id: message.id, result: threadConfigResponse(created) });
    } else if (elicitationEnabled && message.method === "turn/start") {
      const current = thread(message.params.threadId);
      turnSequence += 1;
      const turn = {
        id: independentProtocolIds
          ? `turn-fixture-${independentIdPrefix}${turnSequence}`
          : `turn-${elicitationProfile}-${turnSequence}`,
        status: "inProgress",
        itemsView: "full",
        items: [{
          type: "userMessage",
          id: `user-${turnSequence}`,
          content: message.params.input,
          clientId: message.params.clientUserMessageId ?? null,
        }],
        startedAt: Math.floor(Date.now() / 1_000),
        completedAt: null,
        durationMs: null,
        error: null,
      };
      current.turns.push(turn);
      send({ id: message.id, result: { turn } });
      if (autocompleteDomain && typeof current.threadSource === "string"
        && (current.threadSource.startsWith("shoggoth:work:")
          || current.threadSource.startsWith("shoggoth:cron:"))) {
        setTimeout(() => completeTurn(current.id, turn.id), 20);
      } else {
        emitElicitation(current.id, turn.id);
      }
    } else if (elicitationEnabled && message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
    }
  }
});
