#!/usr/bin/env node
"use strict";

// Local protocol fixture: one process, multiple threads and pending requests.
const fs = require("node:fs");
const readline = require("node:readline");
const threads = new Map();
const pending = new Map();
let sequence = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const makeThread = (id, source = null) => {
  if (!threads.has(id)) threads.set(id, { id, preview: "", modelProvider: "fake",
    createdAt: 1, updatedAt: 1, status: { type: "idle" }, ephemeral: true, turns: [],
    cwd: process.cwd(), cliVersion: "0.149.0", source: "appServer", sessionId: `session-${id}`,
    projectId: null, threadSource: source });
  return threads.get(id);
};
const config = thread => ({ thread, model: "fake-model", modelProvider: "fake",
  serviceTier: null, cwd: process.cwd(), instructionSources: [], approvalPolicy: "on-request",
  approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null });

readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const { method, params = {}, id } = message;
  if (!method) {
    if (pending.has(id)) {
      fs.appendFileSync(process.env.CODEX_FAKE_ELICITATION_RESPONSE_PATH,
        `${JSON.stringify({ ...message, ...pending.get(id) })}\n`, { mode: 0o600 });
      pending.delete(id);
    }
    return;
  }
  if (method === "initialize") send({ id, result: { userAgent: "codex/0.149.0",
    codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" } });
  else if (method === "account/read") send({ id, result: {
    account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } });
  else if (method === "thread/list") send({ id, result: {
    data: [...threads.values()], nextCursor: null, backwardsCursor: null } });
  else if (method === "thread/start") send({ id,
    result: config(makeThread(`isolated-thread-${threads.size + 1}`, params.threadSource)) });
  else if (method === "thread/resume") send({ id, result: config(makeThread(params.threadId)) });
  else if (method === "thread/read") send({ id, result: { thread: makeThread(params.threadId) } });
  else if (method === "thread/inject_items" || method === "turn/interrupt") send({ id, result: {} });
  else if (method === "turn/start") {
    sequence += 1;
    const turn = { id: `isolated-turn-${sequence}`, status: "inProgress", itemsView: "full",
      items: [{ type: "userMessage", id: `user-${sequence}`, content: params.input,
        clientId: params.clientUserMessageId ?? null }], startedAt: 1,
      completedAt: null, durationMs: null, error: null };
    makeThread(params.threadId).turns.push(turn);
    send({ id, result: { turn } });
    const requestId = `raw-request-${sequence}`;
    const approval = sequence % 2 === 1;
    pending.set(requestId, { threadId: params.threadId, turnId: turn.id });
    const request = approval ? { method: "item/fileChange/requestApproval", params: {
      threadId: params.threadId, turnId: turn.id, itemId: `item-${sequence}`,
      startedAtMs: 1, grantRoot: null, reason: "fixture approval" } }
      : { method: "mcpServer/elicitation/request", params: {
        serverName: "shoggoth", threadId: params.threadId, turnId: turn.id,
        mode: "form", message: "fixture input", requestedSchema: { type: "object",
          properties: { choice: { type: "string", title: "Choice" } }, required: ["choice"] } } };
    setTimeout(() => send({ id: requestId, ...request }), 20);
  }
});
