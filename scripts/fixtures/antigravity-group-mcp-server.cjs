"use strict";

// Controlled ACP process and harness. Only the ACP transport is synthetic;
// descriptors, process ancestry, helper bootstrap, gate and tools are real.
const { fork, spawn } = require("node:child_process");
const readline = require("node:readline");
const crypto = require("node:crypto");
const pending = new Map();
let nextId = 0, helper, harness, prompt, descriptor;
const reply = value => process.send?.(value);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("controlled helper timeout")); }, 10000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
  helper.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
if (process.argv[2] === "harness") {
  process.on("message", async message => {
    try {
      if (message.kind === "launch") {
        descriptor = message.descriptor;
        helper = spawn(descriptor.command, descriptor.args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH,
          ...Object.fromEntries(descriptor.env.map(entry => [entry.name, entry.value])) } });
        readline.createInterface({ input: helper.stdout }).on("line", line => {
          const frame = JSON.parse(line); if (frame.id !== undefined) { pending.get(frame.id)?.resolve(frame); pending.delete(frame.id); }
        });
        helper.stderr.on("data", bytes => reply({ kind: "helper-stderr", text: bytes.toString().slice(0, 1000) }));
        helper.on("close", (code, signal) => reply({ kind: "helper-closed", code, signal }));
        const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "controlled-acp", version: "1" } });
        const inventory = await request("tools/list", {});
        reply({ kind: "ready", initialized, inventory, harnessPid: process.pid, helperPid: helper.pid });
      } else if (message.kind === "replay") {
        const replay = spawn(descriptor.command, descriptor.args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH,
          ...Object.fromEntries(descriptor.env.map(entry => [entry.name, entry.value])) } });
        let stdout = "", stderr = "";
        replay.stdout.on("data", bytes => { stdout += bytes.toString(); }); replay.stderr.on("data", bytes => { stderr += bytes.toString(); });
        replay.on("close", (code, signal) => {
          const diagnostic = stderr.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } })
            .find(item => item?.phase === "start" && item?.errorCode === "BOOTSTRAP_ROLE_REJECTED");
          reply({ kind: "replay-result", code, signal, stdoutEmpty: stdout.length === 0,
            bootstrapRejected: Boolean(diagnostic), diagnosticCode: diagnostic?.errorCode ?? null });
        });
      } else if (message.kind === "call") reply({ kind: "call-result", id: message.id,
        response: await request("tools/call", { name: message.name, arguments: message.arguments }) });
      else if (message.kind === "stop") { helper?.stdin.end(); helper?.kill("SIGTERM"); process.exit(0); }
    } catch (error) { reply({ kind: "fixture-error", message: error.message }); }
  });
} else {
  const sessionId = crypto.randomUUID();
  const configOptions = [{ id: "model", category: "model", name: "Model", type: "select", currentValue: "controlled-model",
    options: [{ value: "controlled-model", name: "Controlled" }] }, { id: "mode", category: "mode", name: "Mode", type: "select", currentValue: "default",
    options: [{ value: "default", name: "Default" }, { value: "yolo", name: "Yolo" }, { value: "auto_edit", name: "Edit" }] }];
  const result = () => ({ sessionId, configOptions });
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    const frame = JSON.parse(line);
    if (frame.method === "initialize") send({ id: frame.id, result: { protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {}, list: {} }, promptCapabilities: {} },
      agentInfo: { name: "antigravity-acp", version: "1.2.1" }, authMethods: [{ id: "oauth-personal", name: "Controlled" }] } });
    else if (frame.method === "authenticate") send({ id: frame.id, result: {} });
    else if (frame.method === "session/new" || frame.method === "session/resume") {
      if (!frame.params.mcpServers?.length) { send({ id: frame.id, result: result() }); return; }
      harness = fork(__filename, ["harness"], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH } });
      harness.on("message", message => {
        reply(message);
        if (message.kind === "ready") send({ id: frame.id, result: result() });
        if (message.kind === "fixture-error") send({ id: frame.id, error: { code: -32603, message: message.message } });
      });
      harness.stderr.on("data", bytes => reply({ kind: "harness-stderr", text: bytes.toString().slice(0, 1000) }));
      harness.send({ kind: "launch", descriptor: frame.params.mcpServers[0] });
    } else if (frame.method === "session/set_config_option") send({ id: frame.id, result: { configOptions } });
    else if (frame.method === "session/prompt") { prompt = frame; reply({ kind: "prompt", sessionId }); }
    else if (frame.method === "session/cancel") { if (prompt) send({ id: prompt.id, result: { stopReason: "cancelled" } }); }
  });
  process.on("message", message => {
    if (message.kind === "finish") {
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.text } } } });
      send({ id: prompt.id, result: { stopReason: "end_turn" } });
    } else harness?.send(message);
  });
  process.on("SIGTERM", () => { harness?.send({ kind: "stop" }); setTimeout(() => process.exit(0), 30); });
}
