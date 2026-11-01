"use strict";
// A signed, controlled ACP executable. It never opens a network connection;
// its only child is the exact product-issued stdio MCP Helper descriptor.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const readline = require("node:readline"), { spawn } = require("node:child_process");
const audit = path.resolve(__dirname, "../../../acp-worker-audit.jsonl");
const note = value => fs.appendFileSync(audit, JSON.stringify({ at: Date.now(), pid: process.pid, ...value }) + "\n", { mode: 0o600 });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const sessions = new Map(), requests = new Map(), helpers = new Set(); let nextId = 10000;
note({ kind: "started", ppid: process.ppid, home: process.env.HOME });
function ask(method, params) {
  return new Promise((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => { requests.delete(id); reject(Error("permission timeout")); }, 15000);
    requests.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject }); send({ id, method, params }); });
}
function startHelper(descriptor) {
  assert(descriptor && typeof descriptor.command === "string" && Array.isArray(descriptor.args) && Array.isArray(descriptor.env));
  const child = spawn(descriptor.command, descriptor.args, { shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...Object.fromEntries(descriptor.env.map(item => [item.name, item.value])) } });
  helpers.add(child); note({ kind: "helper-started", helperPid: child.pid });
  const pending = new Map(); let id = 0;
  readline.createInterface({ input: child.stdout }).on("line", line => {
    try { const frame = JSON.parse(line); if (frame.id !== undefined) { pending.get(frame.id)?.(frame); pending.delete(frame.id); } } catch {}
  });
  child.stderr.on("data", () => {});
  child.once("close", () => { helpers.delete(child); note({ kind: "helper-closed", helperPid: child.pid }); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(Error("helper timeout")); }, 10000);
    pending.set(requestId, frame => { clearTimeout(timer); frame.error ? reject(Error("helper rejected")) : resolve(frame.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  return { child, request, ready: request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "generic-acp-controlled", version: "1" } }) };
}
async function handle(frame) {
  if (!frame.method) { const request = requests.get(frame.id); requests.delete(frame.id); if (frame.error) request?.reject(Error("permission rejected")); else request?.resolve(frame.result); return; }
  let result;
  if (frame.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {}, mcpCapabilities: { http: false, sse: false } } };
  else if (frame.method === "session/new" || frame.method === "session/load") {
    const sessionId = frame.params.sessionId || crypto.randomUUID();
    const descriptor = frame.params.mcpServers?.find(item => item.name === "shoggoth") || frame.params.mcpServers?.[0];
    const helper = descriptor ? startHelper(descriptor) : null; if (helper) await helper.ready;
    sessions.set(sessionId, { helper }); note({ kind: frame.method, sessionId, helper: !!helper });
    if (frame.method === "session/load") send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP replay-only marker" } } } });
    result = { ...(frame.method === "session/new" ? { sessionId } : {}) };
  } else if (frame.method === "session/prompt") {
    const sessionId = frame.params.sessionId, session = sessions.get(sessionId); assert(session);
    session.prompt = frame; session.responded = false; session.canceled = false;
    const text = (frame.params.prompt || []).filter(item => item.type === "text").map(item => item.text).join("\n");
    const probe = [...text.matchAll(/\[ACP_PROBE:([a-z0-9-]+)\]/gu)].at(-1);
    const token = probe?.[1] || "untagged", control = probe ? text.slice(probe.index) : "";
    note({ kind: "prompt", sessionId, token });
    if (token === "secret-ui") {
      assert(!text.includes("764219")); assert(text.includes("{{SHOGGOTH_SECRET_"));
      note({ kind: "secret-projection", sessionId, token });
    }
    if (session.helper) {
      const called = await session.helper.request("tools/call", { name: "app_capabilities", arguments: {} });
      assert.notEqual(called.isError, true); assert(called.content?.length); note({ kind: "mcp-call", sessionId, token, ok: true });
    } else if (control.includes("[ACP_REQUIRE_MCP]")) throw Error("product Helper missing");
    if (control.includes("[ACP_CRASH]")) { note({ kind: "crash-after-write", sessionId, token }); process.exit(23); }
    if (control.includes("[ACP_APPROVAL]")) {
      // This is deliberately the first ACP event/request of this prompt. A
      // prepared local attempt must authorize it before any accepted terminal.
      const approved = await ask("session/request_permission", { sessionId,
        toolCall: { toolCallId: `controlled-${token}`, title: "Run the isolated ACP probe", kind: "execute", status: "pending",
          rawInput: { command: "printf acp-probe" }, locations: [] },
        options: [{ optionId: "controlled-allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "controlled-reject-once", name: "Deny", kind: "reject_once" }] });
      note({ kind: "approval", sessionId, token, outcome: approved.outcome?.outcome, optionId: approved.outcome?.optionId || null });
      if (session.canceled || approved.outcome?.outcome === "cancelled") {
        if (!session.responded) { session.responded = true; send({ id: frame.id, result: { stopReason: "cancelled" } }); }
        return;
      }
      assert.equal(approved.outcome?.outcome, "selected"); assert.equal(approved.outcome?.optionId, "controlled-allow-once");
    }
    const answer = `ACP answer ${token} session=${sessionId}`;
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    session.responded = true; result = { stopReason: "end_turn" }; note({ kind: "completed", sessionId, token });
  } else if (frame.method === "session/cancel") {
    const session = sessions.get(frame.params.sessionId); if (session) {
      session.canceled = true;
      if (session.prompt && !session.responded) { session.responded = true; send({ id: session.prompt.id, result: { stopReason: "cancelled" } }); }
    }
    note({ kind: "cancel", sessionId: frame.params.sessionId }); return;
  }
  else { send({ id: frame.id, error: { code: -32601, message: "Unsupported controlled operation" } }); return; }
  send({ id: frame.id, result });
}
const inputLines = readline.createInterface({ input: process.stdin });
inputLines.on("line", line => {
  let frame; try { frame = JSON.parse(line); } catch { process.exitCode = 1; return; }
  Promise.resolve(handle(frame)).catch(() => { note({ kind: "failure", method: frame.method || "response" });
    if (frame.id !== undefined) send({ id: frame.id, error: { code: -32603, message: "Controlled ACP operation failed" } }); });
});
let stopping = false;
const stopWorker = kind => {
  if (stopping) return; stopping = true;
  for (const child of helpers) child.stdin.end();
  note({ kind }); setTimeout(() => process.exit(0), 30);
};
inputLines.once("close", () => stopWorker("stdin-closed"));
process.on("SIGTERM", () => stopWorker("stopped"));
