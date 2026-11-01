#!/usr/bin/env node
"use strict";

// Opt-in real Grok ACP handshake. Never sends session/prompt or business tools.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const repo = process.env.SHOGGOTH_MCP_PROBE_SOURCE || path.resolve(__dirname, "..");
const { resolveCanonicalServicePaths } = require(path.join(repo, "app/agent-service/paths"));
const { RuntimeMcpGateIssuer } = require(path.join(repo, "app/agent-service/runtime-mcp-gate"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(repo, "app/agent-service/service-protocol-version"));

const binary = fs.realpathSync(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync("/private/tmp/sgmcp-");
const paths = resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) });
const helper = path.join(root, "helper.cjs");
const helperOutput = path.join(root, "helper-result.json");
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
fs.writeFileSync(helper, `"use strict";
const fs = require("node:fs"), cp = require("node:child_process"), net = require("node:net");
const result = { pid: process.pid, parentPid: process.ppid };
const output = ${JSON.stringify(helperOutput)};
try { result.parentExecutable = cp.execFileSync("/bin/ps", ["-p", String(process.ppid), "-o", "comm="],
  {encoding:"utf8",timeout:1000,stdio:["ignore","pipe","pipe"]}).trim(); }
catch(e) { result.parentInspection = {code:e.code || null,status:e.status,stderr:String(e.stderr || "").slice(0,500)}; }
try { const fd = fs.openSync(process.env.SHOGGOTH_RUNTIME_MCP_GATE_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd); result.gateReadable = fs.readFileSync(fd).length > 0 && stat.nlink === 1 && (stat.mode & 0o077) === 0;
  fs.closeSync(fd); } catch(e) {result.gateReadError=e.code;}
const socket = net.createConnection(${JSON.stringify(paths.socketPath)});
const connected = new Promise(resolve => { socket.once("connect",()=>{result.lazySocketConnected=true;socket.destroy();resolve();});
  socket.once("error",e=>{result.lazySocketError=e.code;resolve();}); });
(async()=>{await connected;fs.writeFileSync(output,JSON.stringify(result,null,2));
  await require(${JSON.stringify(path.join(repo, "app/bootstrap-role"))}).main(process.argv.slice(1),process.env,
    {userInfo:()=>({homedir:${JSON.stringify(root)}})});
})().catch(e=>{result.bootstrapError={code:e.code || null,cause:e.cause?.code || null};
  fs.writeFileSync(output,JSON.stringify(result,null,2));process.exitCode=1;});
`, { mode: 0o600 });

async function run(mode) {
  const workspace = path.join(root, mode);
  const home = path.join(root, `grok-${mode}`);
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.rmSync(helperOutput, { force: true });
  const issuer = new RuntimeMcpGateIssuer({ paths,
    mcpHelperLaunch: { command: process.execPath, argsPrefix: [] }, bootstrapPath: helper }).open();
  const connections = new Set();
  const record = { mode, modelTurns: 0, businessToolCalls: 0, bridgeOpened: false, mcpMethods: [] };
  const server = net.createServer(socket => {
    connections.add(socket); socket.once("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let bridged = false;
    const lines = readline.createInterface({ input: socket });
    lines.on("line", line => {
      try {
        const request = JSON.parse(line);
        if (!bridged) {
          assert.equal(request.version, SERVICE_PROTOCOL_VERSION);
          assert.equal(request.method, "mcp.runtime.bridge.open");
          assert.equal(issuer.consume(request.params).consumed, true);
          bridged = true; record.bridgeOpened = true;
          socket.write('{"ok":true,"result":{"bridged":true}}\n');
          return;
        }
        record.mcpMethods.push(request.method);
        assert(["initialize", "notifications/initialized", "tools/list", "ping"].includes(request.method),
          "The probe must not dispatch model or business tool requests");
        if (request.id === undefined) return;
        const result = request.method === "initialize"
          ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: "shoggoth-isolated-authorized-bridge", version: "1" } }
          : request.method === "tools/list" ? { tools: [] } : {};
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      } catch (error) { record.bridgeError = error.code || error.name; socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(paths.socketPath, resolve); });
  fs.chmodSync(paths.socketPath, 0o600);
  const child = spawn(binary, ["--sandbox", mode, "agent", "--no-leader", "stdio"], {
    cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, GROK_HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp", DO_NOT_TRACK: "1",
      XAI_API_KEY: "xai-shoggoth-inert-probe-invalid" },
  });
  record.childPid = child.pid;
  let stderrBytes = 0;
  child.stderr.on("data", data => { stderrBytes += data.length; });
  const pending = new Map();
  let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(Object.assign(new Error("ACP rejected probe"), { code: message.error.code }))
      : entry.resolve(message.result);
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    record.exit = { code, signal };
    for (const entry of pending.values()) entry.reject(new Error("Probe CLI exited"));
    resolve();
  }));
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); },
      reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request("initialize", { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "shoggoth-mcp-sandbox-probe", version: "1" } });
    const descriptor = issuer.createMcpServer({ runtimeProfileId: "runtime-grok-sandbox-probe",
      runtimeAccountId: "runtime-grok-sandbox-probe-account", parentPid: child.pid, parentExecutable: binary });
    const session = await request("session/new", { cwd: workspace, mcpServers: [descriptor] });
    record.sessionId = session.sessionId;
    for (let i = 0; i < 50 && !record.mcpMethods.includes("tools/list"); i++) await delay(100);
    if (fs.existsSync(helperOutput)) record.helper = JSON.parse(fs.readFileSync(helperOutput, "utf8"));
    assert.equal(record.helper?.parentPid, child.pid, "real CLI must directly spawn relay");
    assert.equal(record.helper?.gateReadable, true);
    assert.equal(record.helper?.lazySocketConnected, true);
    assert.equal(record.bridgeOpened, true, "real gate, bootstrap and relay must open authorized bridge");
    assert(record.mcpMethods.includes("initialize"));
    assert(record.mcpMethods.includes("tools/list"));
    record.passed = true;
  } catch (error) {
    record.error = { code: error.code || error.name, message: error.message };
  } finally {
    child.stdin.end();
    for (const socket of connections) socket.end();
    await Promise.race([exited, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) {
      record.cleanupSignal = "SIGTERM";
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([exited, delay(10000)]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      record.cleanupSignal = "SIGKILL";
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      await exited;
    }
    record.naturalExit = record.exit?.code === 0 && record.exit?.signal === null && !record.cleanupSignal;
    if (!record.naturalExit) record.passed = false;
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    issuer.close();
    record.stderrBytes = stderrBytes;
    fs.writeFileSync(path.join(evidence, `${mode}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
  }
  return record;
}

(async () => {
  const records = [];
  try { for (const mode of ["off", "workspace"]) records.push(await run(mode)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ binary, modelTurns: 0, businessToolCalls: 0,
    results: records.map(({ mode, passed, error }) => ({ mode, passed: passed === true, error })) }, null, 2));
  assert(records.every(record => record.passed), "Both sandbox modes must complete the real MCP chain");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
