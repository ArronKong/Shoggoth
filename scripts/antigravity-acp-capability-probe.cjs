#!/usr/bin/env node
"use strict";

// Explicit standalone probe of the official ACP executable. It never sends a
// prompt, starts OAuth, imports credentials, reads native history, or installs a
// runtime. All server state and the MCP fixture stay in a private temporary HOME.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");

const MAX_FRAME = 1024 * 1024;
const METHODS = new Set(["initialize", "session/new", "session/load", "session/list"]);

function probeClient(child, timeoutMs = 30_000) {
  const pending = new Map(), decoder = new TextDecoder("utf8", { fatal: true });
  let buffer = Buffer.alloc(0), sequence = 0, ended = false;
  const metadata = { stdoutBytes: 0, stderrBytes: 0, notifications: {}, reverseRequests: {} };
  function fail(code) {
    ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error(code), { code })); }
    pending.clear();
  }
  child.stdin.on("error", () => fail("ACP_INPUT_CLOSED"));
  child.stderr.on("data", (chunk) => { metadata.stderrBytes += chunk.length; });
  child.on("error", () => fail("ACP_PROCESS_FAILED"));
  child.on("close", () => fail("ACP_PROCESS_CLOSED"));
  child.stdout.on("data", (chunk) => {
    try {
      metadata.stdoutBytes += chunk.length;
      if (metadata.stdoutBytes > MAX_FRAME * 8) throw new Error("output budget");
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline > MAX_FRAME) throw new Error("frame budget");
        const line = decoder.decode(buffer.subarray(0, newline));
        buffer = buffer.subarray(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.jsonrpc !== "2.0") throw new Error("jsonrpc");
        if (typeof message.method === "string") {
          const method = /^[A-Za-z/_]{1,100}$/u.test(message.method) ? message.method : "unknown";
          if (message.id === undefined) metadata.notifications[method] = (metadata.notifications[method] || 0) + 1;
          else {
            metadata.reverseRequests[method] = (metadata.reverseRequests[method] || 0) + 1;
            child.stdin.write(JSON.stringify(message.method === "session/request_permission"
              ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Read-only capability probe" } }) + "\n");
          }
          continue;
        }
        const entry = pending.get(message.id);
        if (!entry) throw new Error("unknown response");
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.resolve({ error: {
          code: Number.isSafeInteger(message.error.code) ? message.error.code : null,
          // Error prose can contain credentials or local paths. Record only
          // classifications needed to decide whether migration is supported.
          authRequired: /auth|log.?in|credential/iu.test(String(message.error.message)),
          unsupported: message.error.code === -32601,
        } });
        else entry.resolve({ result: message.result });
      }
      if (buffer.length > MAX_FRAME) throw new Error("frame budget");
    } catch { fail("ACP_PROTOCOL_INVALID"); }
  });
  return {
    metadata,
    request(method, params) {
      assert.ok(METHODS.has(method), "Probe cannot send prompts, authentication, or mutations");
      if (ended) return Promise.reject(Object.assign(new Error("ACP_PROCESS_CLOSED"), { code: "ACP_PROCESS_CLOSED" }));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("ACP_REQUEST_TIMEOUT"), { code: "ACP_REQUEST_TIMEOUT" })); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() { fail("ACP_PROBE_CLOSED"); child.stdin.end(); },
  };
}

function capabilitySummary(initialized) {
  const capabilities = initialized?.agentCapabilities || {};
  return {
    protocolVersion: initialized?.protocolVersion ?? null,
    agentName: typeof initialized?.agentInfo?.name === "string" ? initialized.agentInfo.name.slice(0, 100) : null,
    agentVersion: typeof initialized?.agentInfo?.version === "string" ? initialized.agentInfo.version.slice(0, 100) : null,
    loadSession: capabilities.loadSession === true,
    sessionList: !!capabilities.sessionCapabilities?.list,
    mcpHttp: capabilities.mcpCapabilities?.http === true,
    mcpSse: capabilities.mcpCapabilities?.sse === true,
    authMethods: (initialized?.authMethods || []).map((method) => String(method.id).slice(0, 100)),
  };
}

async function main() {
  const binaryIndex = process.argv.indexOf("--binary");
  const binary = process.argv[binaryIndex + 1];
  assert.ok(binaryIndex > 0 && typeof binary === "string" && path.isAbsolute(binary), "Pass --binary /absolute/path/to/official/agy_acp_server.par");
  const executable = fs.realpathSync(binary);
  assert.ok(fs.statSync(executable).isFile());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-capability-")));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), tmp = path.join(root, "tmp");
  for (const dir of [home, workspace, tmp]) fs.mkdirSync(dir, { mode: 0o700 });
  const helper = path.join(root, "empty-mcp.cjs");
  fs.writeFileSync(helper, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolated-probe',version:'1'}}:{tools:[]}}));});`, { mode: 0o600 });
  const child = spawn(executable, [], { cwd: workspace, detached: true,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), TMPDIR: tmp,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  const client = probeClient(child);
  const report = { scope: "isolated-no-auth-no-prompt", executableSha256: crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
    checks: {}, metadata: client.metadata, productionReady: false,
    unverified: ["native-auth-reuse", "existing-cli-history", "MCP-owner-binding", "permission-roundtrip", "model-selection", "prompt-cancel"] };
  try {
    const init = await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "shoggoth-capability-probe", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    report.checks.initialize = init.error ? init : capabilitySummary(init.result);
    if (init.result) {
      for (const [name, method, params] of [
        ["sessionNew", "session/new", { cwd: workspace, mcpServers: [{ name: "isolated-probe", command: process.execPath, args: [helper], env: [] }] }],
        ["sessionLoad", "session/load", { cwd: workspace, sessionId: "00000000-0000-4000-8000-000000000000", mcpServers: [] }],
        ["sessionList", "session/list", {}],
      ]) {
        const reply = await client.request(method, params);
        report.checks[name] = reply.error ? reply : { success: true, keys: Object.keys(reply.result || {}).sort(),
          ...(name === "sessionNew" ? { modes: (reply.result?.modes?.availableModes || []).map((entry) => entry.id),
            modelCount: reply.result?.models?.availableModels?.length ?? null } : {}) };
      }
    }
  } catch (error) { report.error = { code: error.code || "ACP_PROBE_FAILED" }; }
  finally {
    client.close();
    if (Number.isSafeInteger(child.pid)) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ report: path.join(root, "result.json"), ...report }, null, 2));
  }
}

if (require.main === module) main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { probeClient, capabilitySummary };
