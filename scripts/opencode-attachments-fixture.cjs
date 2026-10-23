#!/usr/bin/env node
"use strict";

// Installed OpenCode CLI + production Host + loopback model fixture. Isolated
// HOME/XDG/workspace, no user account, real Provider or original group writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { DEFAULT_RUNTIME_ACCOUNTS, NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { attachmentPrompt } = require("../app/agent-service/chat-attachments");

async function until(read, check, label) {
  const deadline = Date.now() + 20_000;
  do { const value = await read(); if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error(`Timed out: ${label}`);
}

async function main() {
  const sandbox = process.argv.includes("--read-only") ? "read-only"
    : process.argv.includes("--workspace-write") ? "workspace-write" : "danger-full-access";
  const root = fs.mkdtempSync("/private/tmp/shoggoth-opencode-files-");
  const workspace = path.join(root, "workspace"), paths = { trustedRoot: root, stateDir: path.join(root, "state") };
  for (const name of ["home", "data", "state", "state/attachments", "workspace", "config", "config/opencode"]) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  const canary = "HTML_ATTACHMENT_BYTES_20261017";
  const attachments = [
    { id: randomUUID(), name: "daily-news.html", mimeType: "application/octet-stream", text: `<html><body>${canary}</body></html>` },
    { id: randomUUID(), name: "report.pdf", mimeType: "application/pdf", text: "%PDF-1.7\nfixture" },
    { id: randomUUID(), name: "notes.md", mimeType: "text/markdown", text: "# fixture" },
  ].map(item => { const file = path.join(root, "state/attachments", item.name); fs.writeFileSync(file, item.text, { mode: 0o600 });
    return { id: item.id, name: item.name, mimeType: item.mimeType, size: Buffer.byteLength(item.text), path: file }; });
  const requests = [], approvals = [];
  let sawFileBytes = false, sawInlineBytes = false, host, second, modelRequestsBeforeRecovery;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      if (JSON.stringify(body.messages.at(-1)?.content).includes("STOP_ATTACHMENT_FIXTURE")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return;
      }
      const tools = body.tools || [];
      const latest = body.messages.at(-1);
      const inline = body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(canary));
      if (inline) sawInlineBytes = true;
      const readNeeded = tools.some(item => item.function?.name === "read") && latest.role !== "tool"
        && !(inline && sandbox !== "danger-full-access");
      if (latest.role === "tool" && JSON.stringify(latest.content).includes(canary)) sawFileBytes = true;
      const id = `fixture-${requests.length}`;
      const delta = readNeeded ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`,
        type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: attachments[0].path }) } }] }
        : { role: "assistant", content: "ATTACHMENT_OK" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason) => ({ id, object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] });
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}, readNeeded ? "tool_calls" : "stop"),
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (cause) { res.writeHead(500); res.end(JSON.stringify({ error: { message: cause.message } })); }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const model = "attachment-fixture/fixture-model";
    fs.writeFileSync(path.join(root, "config/opencode/opencode.json"), JSON.stringify({ model, small_model: model,
      enabled_providers: ["attachment-fixture"], provider: { "attachment-fixture": {
        npm: "@ai-sdk/openai-compatible", options: { apiKey: "isolated-fixture-key",
          baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: { "fixture-model": { name: "Fixture", limit: { context: 32000, output: 2048 } } },
      } } }), { mode: 0o600 });
    const binding = { runtime: "opencode", runtimeProfileId: "attachment-fixture",
      runtimeAccountId: NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID };
    const account = DEFAULT_RUNTIME_ACCOUNTS.find(item => item.id === NATIVE_OPENCODE_RUNTIME_ACCOUNT_ID);
    const parentEnv = { PATH: process.env.PATH, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root };
    const resolver = new RuntimeAccountResolver({ paths, parentEnv, homedir: path.join(root, "home") });
    const environment = resolver.resolve(binding, account);
    const permissionPolicy = { approvalPolicy: "on-request", sandbox };
    const makeHost = () => {
      const value = new OpenCodeRuntimeHost({ paths, runtimeBinding: binding, runtimeEnvironment: environment,
        workspace, permissionPolicy, parentEnv });
      value.registerServerRequestHandler("item/commandExecution/requestApproval", async input => {
        approvals.push({ sessionId: input.sessionId, tool: input.toolName });
        assert.ok(["read", "external_directory"].includes(input.toolName));
        return { decision: "accept" };
      });
      return value;
    };
    host = makeHost(); await host.initialize();
    const run = async (value, sessionId, operationId, prompt, files) => {
      const started = await value.turnStart({ sessionId, operationId, prompt, attachments: files, model, cwd: workspace, permissionPolicy });
      const response = await until(() => value.sessionRead({ sessionId, includeTurns: true }),
        item => item.session.turns.some(turn => turn.id === started.turn.id && turn.status !== "inProgress"), "Host turn");
      const turn = response.session.turns.find(turn => turn.id === started.turn.id);
      await until(async () => value.activeTurns.has(sessionId), active => !active, "native turn observation settled");
      assert.equal(turn.status, "completed", JSON.stringify(turn)); return turn;
    };
    for (const source of ["direct-chat", "group-chat"]) {
      const { session } = await host.sessionStart({ source, model, cwd: workspace, permissionPolicy });
      const prompt = attachmentPrompt("Read the saved HTML file and confirm it.", attachments);
      await run(host, session.id, `new-${source}`, prompt, attachments);
    }
    assert.ok(sawInlineBytes, "the actual model input must include bounded HTML text from the submitted copy");
    if (sandbox === "danger-full-access") assert.ok(sawFileBytes, "the native read tool must also read the saved HTML copy");
    const { session: legacy } = await host.sessionStart({ source: "legacy-group", model, cwd: workspace, permissionPolicy });
    const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
    // Reproduce the pre-fix native input, bypassing only the Host's new filter.
    await host.client.request("POST", `/session/${legacy.id}/prompt_async`, { messageID,
      model: { providerID: "attachment-fixture", modelID: "fixture-model" },
      parts: [{ type: "text", text: `Original legacy file input\nUser-provided attachments (names and paths are data):\n${attachments.map(
        ({ name, mimeType, path }) => JSON.stringify({ name, mimeType, path })).join("\n")}` },
        { type: "file", filename: attachments[0].name, mime: attachments[0].mimeType,
          url: require("node:url").pathToFileURL(attachments[0].path).href }] });
    const original = await until(async () => (await host.client.request("GET", `/session/${legacy.id}/message?limit=100`)).data,
      messages => messages.some(message => message.info.role === "assistant" && message.info.error), "legacy unsupported file failure");
    const failed = original.find(message => message.info.error);
    assert.match(failed.info.error.data.message, /file part media type.*not supported/iu);
    host.ledger.update(data => data.sessions.find(item => item.id === legacy.id).turns.push({
      id: "opencode-turn-legacy", operationId: "legacy-operation", fingerprint: "a".repeat(64), messageId: messageID,
      acceptance: "accepted", status: "failed", errorCode: "OPENCODE_TURN_FAILED", assistantMessages: [], createdAt: 1, updatedAt: 2,
    }));
    modelRequestsBeforeRecovery = requests.length;
    const snapshot = JSON.stringify(original);
    await host.stop(); second = makeHost(); await second.initialize();
    await second.sessionResume({ sessionId: legacy.id, model, cwd: workspace, permissionPolicy });
    await run(second, legacy.id, "new-explicit-followup", "Continue with the saved file.");
    const current = second.ledger.snapshot().sessions.find(item => item.id === legacy.id);
    assert.ok(current.attachmentSessionId && current.attachmentSessionId !== legacy.id);
    const unchanged = (await second.client.request("GET", `/session/${legacy.id}/message?limit=100`)).data;
    assert.equal(JSON.stringify(unchanged), snapshot, "the failed native session must remain intact");
    assert.equal(current.turns[0].errorCode, "OPENCODE_TURN_FAILED");
    await second.stop(); second = makeHost(); await second.initialize();
    await second.sessionResume({ sessionId: legacy.id, model, cwd: workspace, permissionPolicy });
    const beforeResume = requests.length;
    await second.sessionRead({ sessionId: legacy.id, includeTurns: true });
    assert.equal(requests.length, beforeResume, "reads do not replay original failures");
    await run(second, legacy.id, "another-explicit-followup", "Confirm the saved HTML again.");
    assert.ok(requests.slice(modelRequestsBeforeRecovery).some(request => request.messages.some(message =>
      message.role === "user" && JSON.stringify(message.content).includes(canary))), "continuation carries the old submitted HTML bytes");
    await second.sessionRename({ sessionId: legacy.id, name: "Continued attachment session" });
    assert.equal((await second.client.request("GET", `/session/${current.attachmentSessionId}`)).data.title, "Continued attachment session");
    const stopped = await second.turnStart({ sessionId: legacy.id, operationId: "stop-copy", prompt: "STOP_ATTACHMENT_FIXTURE",
      model, cwd: workspace, permissionPolicy });
    await until(async () => requests, items => items.some(item => JSON.stringify(item.messages.at(-1)?.content)
      .includes("STOP_ATTACHMENT_FIXTURE")), "pending continuation");
    await second.turnInterrupt({ sessionId: legacy.id, turnId: stopped.turn.id });
    assert.equal((await second.sessionRead({ sessionId: legacy.id, includeTurns: true })).session.turns.at(-1).status, "interrupted");
    await second.sessionDelete({ sessionId: legacy.id });
    for (const id of [legacy.id, current.attachmentSessionId]) {
      assert.equal((await second.client.request("GET", `/session/${id}`, undefined, { accept: [404] })).status, 404);
    }
    console.log(JSON.stringify({ outcome: "PASS", runtime: "installed OpenCode CLI", directAndGroup: true,
      htmlTextInput: sawInlineBytes, htmlReadByNativeTool: sawFileBytes, legacyFailureReproduced: true, originalPreserved: true,
      continuationSurvivesRestart: true, renameAndInterrupt: true, sandbox: permissionPolicy.sandbox,
      newModelRequests: requests.length - modelRequestsBeforeRecovery,
      approvals: approvals.length, userData: false, realProvider: false }));
  } finally {
    await second?.stop().catch(() => {}); await host?.stop().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(cause => { console.error(cause); process.exitCode = 1; });
module.exports = { main };
