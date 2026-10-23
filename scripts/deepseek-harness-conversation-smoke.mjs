#!/usr/bin/env node
// Real installed DSH agent loop, prompt registry, persistence and JSONL bridge.
// Only the model adapter is a fixture; no native credentials or network are used.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { DeepSeekHarnessProcess } = require("../app/agent-service/deepseek-harness-process");
const { prepareDeepSeekHarnessHome, resolveDeepSeekHarnessBinary, resolveDeepSeekHarnessLaunch } =
  require("../app/agent-service/deepseek-harness-runtime-paths");
const binary = resolveDeepSeekHarnessBinary({ parentEnv: process.env });
const launch = resolveDeepSeekHarnessLaunch(binary, { parentEnv: process.env });
const nativeLlm = createRequire(pathToFileURL(binary)).resolve("@deepseek-ai/dsh-llm");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dsh-conversation-")));
fs.chmodSync(root, 0o700);
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { mode: 0o700 });
const failureSession = crypto.randomUUID();
const captureFile = path.join(root, "requests.jsonl");
const plugin = path.join(root, "bridge-fixture.mjs");
fs.writeFileSync(plugin, `
import fs from "node:fs";
import { LlmAdapter, isAgentLoopRequest } from ${JSON.stringify(pathToFileURL(nativeLlm).href)};
import { apply as bridgeApply, inject } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "resources/deepseek-harness/shoggoth-dsh-bridge.mjs")).href)};
export { inject };
export const name = "shoggoth-conversation-fixture";
export function apply(ctx) {
  globalThis.fetch = () => { throw new Error("UNEXPECTED_EXTERNAL_NETWORK"); };
  ctx.llm.registerAdapter(["shoggoth-fixture"], new class extends LlmAdapter {
    listModels(provider) { return Promise.resolve([{ provider, id: "echo", name: "Fixture echo" }]); }
    async *stream(options) {
      const users = options.messages.filter(message => message.role === "user" && message.source?.kind === "user")
        .map(message => message.content.filter(block => block.type === "text").map(block => block.text).join(""));
      fs.appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ primary: isAgentLoopRequest(options), system: options.system, users }) + "\\n", { mode: 0o600 });
      yield { type: "text-delta", index: 0, text: "fixture answer: " + users.at(-1) };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  });
  ctx.systemPrompt.section({ name: "fixture:early-failure", order: 1000, text(context) {
    if (context.agent?.session.id === ${JSON.stringify(failureSession)}) throw new Error("fixture native startup failure");
    return "";
  } });
  bridgeApply(ctx);
}
`, { mode: 0o600 });
const home = prepareDeepSeekHarnessHome({ trustedRoot: root, stateDir: path.join(root, "state") },
  "conversation-smoke", { bridgePath: plugin });
fs.writeFileSync(path.join(home, ".credentials.yaml"), "version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-only\n", { mode: 0o600 });
const clients = [];
const bounded = async (promise, label, timeoutMs = 10000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};
const readRequests = () => fs.existsSync(captureFile)
  ? fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter(request => request.primary) : [];
async function connect() {
  const events = [];
  const child = spawn(launch.command, [...launch.argsPrefix, "--profile", "shoggoth"], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(), LANG: process.env.LANG || "en_US.UTF-8",
      DSH_HOME: home, DSH_PERMISSION_MODE: "workspace-write", SHOGGOTH_DSH_APPROVAL_POLICY: "ask",
      SHOGGOTH_DSH_CONTROL_INSTANCE: "0", SHOGGOTH_DSH_ENTRYPOINT: launch.argsPrefix[0] || "",
      SHOGGOTH_DSH_MCP_CONFIG: JSON.stringify({
        transport: "stdio", serverName: "shoggoth", command: process.execPath,
        args: [path.join(ROOT, "scripts/deepseek-harness-official-smoke.mjs"), "--fake-mcp"],
        env: {}, cwd: workspace, toolCallTimeoutMs: 5000, failOnStartupError: true,
      }),
      DSH_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new DeepSeekHarnessProcess({ child, requestTimeoutMs: 5000, onEvent: event => events.push(event) });
  clients.push(client);
  await bounded(client.ready, "native startup");
  return { client, events };
}
async function close({ client }) {
  await client.request("shutdown");
  client.endInput();
  const result = await bounded(client.closedPromise, "native shutdown");
  assert.equal(result.code, 0, client.stderr);
}
async function terminal(connection, turnId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const event = connection.events.find(event => event.type === "complete" && event.turnId === turnId);
    if (event) return event;
    if (connection.client.failure) throw connection.client.failure;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`terminal event timed out: ${turnId}`);
}
const sessionParams = id => ({
  remoteSessionId: id, cwd: workspace, developerInstructions: "STABLE_POLICY",
  model: "shoggoth-fixture/echo", permissionMode: "workspace-write",
});
async function turn(connection, id, index, instructions = `RUN_${index}`) {
  const turnId = `turn-${index}`;
  const reply = await connection.client.request("turn/start", {
    remoteSessionId: id, sessionId: id, turnId, operationId: `operation-${index}`,
    prompt: `user-${index}`, turnDeveloperInstructions: instructions,
  });
  const event = await terminal(connection, turnId);
  return { reply, event };
}
try {
  const original = await connect();
  const id = crypto.randomUUID();
  await original.client.request("session/start", sessionParams(id));
  for (let index = 1; index <= 8; index++) {
    const result = await turn(original, id, index, index === 8 ? "" : `RUN_${index}`);
    assert.equal(result.event.status, "completed", JSON.stringify(result));
    const expected = index === 8 ? "STABLE_POLICY" : `STABLE_POLICY\n\nRUN_${index}`;
    assert.equal(readRequests().at(-1).system, expected);
    assert.equal(readRequests().at(-1).users.length, index);
    const catalog = await original.client.request("models/list");
    assert.ok(catalog.models.some(model => model.model === "shoggoth-fixture/echo"));
  }
  const replay = await turn(original, id, 8, "");
  assert.equal(replay.reply.replayed, true);
  assert.equal(readRequests().length, 8, "reading a completed operation must not call the model again");
  await original.client.request("session/start", sessionParams(failureSession));
  const failedAt = Date.now();
  const failed = await turn(original, failureSession, "early-failure");
  assert.equal(failed.event.status, "failed");
  assert.equal(readRequests().length, 8, "native startup failure happens before model dispatch");
  assert.ok(Date.now() - failedAt < 5000, "native failure returns before the RPC timeout");
  assert.equal((await turn(original, id, 9)).event.status, "completed");
  await close(original);
  const resumed = await connect();
  await resumed.client.request("session/resume", sessionParams(id));
  assert.equal((await turn(resumed, id, 10)).event.status, "completed");
  assert.equal(readRequests().at(-1).system, "STABLE_POLICY\n\nRUN_10");
  assert.equal(readRequests().at(-1).users.length, 10, "native history survives a real CLI restart");
  assert.equal(readRequests().length, 10);
  assert.equal((await resumed.client.request("session/read", { remoteSessionId: id })).remoteSessionId, id);
  await close(resumed);
  console.log("PASS official DSH: 10 normal turns, per-turn prompt replacement/clear, native early failure, next turn, replay without model dispatch, repeated catalogs, process restart and persisted history; fixture model only");
} finally {
  for (const client of clients) {
    if (!client.closed) {
      client.kill("SIGKILL");
      await bounded(client.closedPromise, "fixture cleanup").catch(() => {});
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
