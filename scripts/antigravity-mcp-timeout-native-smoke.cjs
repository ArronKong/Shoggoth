#!/usr/bin/env node
"use strict";

// Opt-in, offline acceptance of the actual Google harness MCP timeout. No ACP
// sign-in, credentials, saved sessions, model downloads, or external Provider.
//
// node scripts/antigravity-mcp-timeout-native-smoke.cjs --offline \
//   --harness /absolute/localharness_external --sdk-source-dir /private/tmp/extracted-sdk --short
// Add --long --bootstrap /absolute/harness-bootstrap for the parallel 190s
// default-180s versus compatibility-1800s acceptance. The compatibility parent
// is this Node fixture, not the signed PAR; its process-chain proof is separate.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");

const flag = (name) => process.argv.includes(name);
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();
let interrupted = false;
const groupAlive = (child) => {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
function terminateChild(child) {
  if (!child?.pid) return Promise.resolve({ childExited: true, processGroupGone: true });
  if (child.cleanupPromise) return child.cleanupPromise;
  child.cleanupPromise = (async () => {
    child.stdin?.end();
    const signal = (value) => { try { process.kill(-child.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    if (groupAlive(child)) signal("SIGTERM");
    let deadline = Date.now() + (child.fixtureDriver ? 5000 : 300);
    while (groupAlive(child) && Date.now() < deadline) await sleep(25);
    if (groupAlive(child)) signal("SIGKILL");
    deadline = Date.now() + 4000;
    while ((groupAlive(child) || (child.exitCode === null && child.signalCode === null)) && Date.now() < deadline) await sleep(25);
    const result = { childExited: child.exitCode !== null || child.signalCode !== null, processGroupGone: !groupAlive(child) };
    if (result.processGroupGone) children.delete(child);
    return result;
  })();
  return child.cleanupPromise;
}
if (!flag("--fake-mcp")) {
  for (const [name, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(name, () => {
    interrupted = true;
    void Promise.allSettled([...children].map(terminateChild)).finally(() => process.exit(code));
  });
  process.once("exit", () => {
    for (const child of children) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  });
}

function fakeMcp() {
  const log = process.env.SHOGGOTH_SMOKE_MCP_LOG;
  const delayMs = Number(process.env.SHOGGOTH_SMOKE_MCP_DELAY_MS);
  assert.ok(log && Number.isSafeInteger(delayMs) && delayMs > 0);
  const record = (event) => fs.appendFileSync(log, `${JSON.stringify({ event, at: Date.now() })}\n`, { mode: 0o600 });
  const pending = new Map();
  const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      record("initialized");
      reply(request.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "offline-timeout-fixture", version: "1" } });
    } else if (request.method === "tools/list") {
      reply(request.id, { tools: [{ name: "delayed_echo", description: "Return a fixed offline fixture receipt after a delay.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    } else if (request.method === "tools/call") {
      assert.equal(request.params.name, "delayed_echo");
      record("called");
      pending.set(request.id, setTimeout(() => {
        pending.delete(request.id);
        record("completed");
        reply(request.id, { content: [{ type: "text", text: "TOOL_DELAY_COMPLETE" }] });
      }, delayMs));
    } else if (request.method === "notifications/cancelled") {
      record("cancelled");
      clearTimeout(pending.get(request.params.requestId));
      pending.delete(request.params.requestId);
    } else if (request.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32601, message: "Unsupported fixture method" } })}\n`);
    }
  }).on("close", () => {
    for (const timer of pending.values()) clearTimeout(timer);
    process.exit(0);
  });
}

function encodeVarint(value) {
  const bytes = [];
  do { const digit = value % 128; value = Math.floor(value / 128); bytes.push(digit | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function protoString(tag, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([encodeVarint(tag * 8 + 2), encodeVarint(bytes.length), bytes]);
}
function inputConfig(root) {
  // Verified against the explicitly supplied original descriptor below.
  return Buffer.concat([protoString(1, path.join(root, "storage")), protoString(3, "127.0.0.1")]);
}
function outputConfig(bytes) {
  let offset = 0;
  const readVarint = () => {
    let result = 0;
    let factor = 1;
    for (let n = 0; n < 10 && offset < bytes.length; n++) {
      const byte = bytes[offset++];
      result += (byte & 127) * factor;
      if (!(byte & 128)) { assert.ok(Number.isSafeInteger(result)); return result; }
      factor *= 128;
    }
    throw new Error("Invalid fixture OutputConfig varint");
  };
  const seen = new Set();
  let port, apiKey;
  while (offset < bytes.length) {
    const key = readVarint();
    const tag = Math.floor(key / 8), wire = key % 8;
    assert.ok(!seen.has(tag), "Duplicate fixture OutputConfig field");
    seen.add(tag);
    if (tag === 1 && wire === 0) port = readVarint();
    else if (tag === 2 && wire === 2) {
      const length = readVarint();
      assert.ok(length > 0 && offset + length <= bytes.length);
      apiKey = bytes.subarray(offset, offset + length).toString("utf8");
      offset += length;
    } else throw new Error("Unexpected fixture OutputConfig field");
  }
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && apiKey);
  return { port, apiKey };
}

function verifySdkShape(directory, environment) {
  assert.ok(path.isAbsolute(directory), "--sdk-source-dir must be explicit and absolute");
  const source = path.join(directory, "localharness_pb2.py");
  const code = `import ast,json,sys,hashlib\nfrom pathlib import Path\nfrom google.protobuf import descriptor_pb2\np=Path(sys.argv[1]); tree=ast.parse(p.read_text())\nraw=next(ast.literal_eval(n.args[0]) for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='AddSerializedFile')\nf=descriptor_pb2.FileDescriptorProto.FromString(raw)\nexpected={'InputConfig':{'storage_directory':(1,9),'bind_address':(3,9)},'OutputConfig':{'port':(1,5),'api_key':(2,9)},'InitializeConversationEvent':{'config':(1,11)},'HarnessConfig':{'mcp_servers':(14,11)},'McpServerConfig':{'timeout_seconds':(7,5)}}\nfor name,fields in expected.items():\n m=next(m for m in f.message_type if m.name==name)\n for name,(tag,kind) in fields.items():\n  x=next(x for x in m.field if x.name==name); assert (x.number,x.type)==(tag,kind)\nprint(json.dumps({'descriptorSha256':hashlib.sha256(raw).hexdigest(),'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest()}))\n`;
  const result = spawnSync(option("--python") || "python3", ["-B", "-c", code, source], {
    encoding: "utf8", timeout: 10_000,
    env: { ...environment, PATH: "/opt/homebrew/bin:/usr/bin:/bin", PYTHONNOUSERSITE: "1" },
  });
  assert.equal(result.status, 0, "Explicit extracted SDK descriptor verification failed");
  return JSON.parse(result.stdout);
}

function isolatedEnvironment(root) {
  for (const name of ["home", "tmp", "storage", "app-data"]) fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    LANG: "en_US.UTF-8", NO_PROXY: "127.0.0.1,localhost" };
}

function sandboxProfile(root, harness, bootstrap) {
  const quote = (value) => JSON.stringify(value);
  const allow = [root, path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    path.join(__dirname, "..", "node_modules"), path.join(__dirname, "..", "app", "agent-service")];
  const literals = [fs.realpathSync(__filename), path.join(__dirname, "..", "package.json"), harness, ...(bootstrap ? [bootstrap] : [])];
  return `(version 1)\n(allow default)\n(deny file-read* (subpath ${quote(os.homedir())}))\n` +
    allow.map((item) => `(allow file-read* (subpath ${quote(item)}))\n`).join("") +
    literals.map((item) => `(allow file-read* (literal ${quote(item)}))\n`).join("") +
    `(allow file-read-metadata)\n(deny file-write*)\n(allow file-write* (subpath ${quote(root)}))\n(deny network*)\n` +
    `(allow network-bind (local ip "localhost:*"))\n` +
    `(allow network-inbound (local ip "localhost:*"))\n` +
    `(allow network-outbound (remote ip "localhost:*"))\n` +
    `(allow network* (subpath ${quote(root)}))\n`;
}

async function readFramedConfig(stream) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timeout = setTimeout(() => done(new Error("Harness handshake timed out")), 20_000);
    const done = (error, value) => {
      clearTimeout(timeout); stream.off("data", data); stream.off("end", ended); stream.off("error", failed);
      error ? reject(error) : resolve(value);
    };
    const data = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32LE(0);
      if (!length || length > 65536) return done(new Error("Invalid harness handshake frame"));
      if (bytes.length >= length + 4) done(null, outputConfig(bytes.subarray(4, length + 4)));
    };
    const ended = () => done(new Error("Harness exited during handshake"));
    const failed = () => done(new Error("Harness stdout failed"));
    stream.on("data", data); stream.once("end", ended); stream.once("error", failed);
  });
}

async function fakeModel() {
  const observation = { requests: 0, toolOffered: false, toolReceiptObserved: false, timeoutObserved: false };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 2_000_000) request.destroy(); });
    request.on("end", () => {
      try {
        const input = JSON.parse(body);
        observation.requests++;
        const offered = (input.tools || []).find((tool) => tool.function?.name?.includes("delayed_echo"));
        observation.toolOffered ||= !!offered;
        const messages = JSON.stringify(input.messages || []);
        observation.toolReceiptObserved ||= messages.includes("TOOL_DELAY_COMPLETE");
        observation.timeoutObserved ||= /timed out|deadline exceeded/i.test(messages);
        const first = observation.requests === 1;
        assert.ok(!first || offered, "Fake model did not receive the fixture MCP tool");
        const message = first ? { role: "assistant", content: null, tool_calls: [{ id: "offline-call-1", type: "function",
          function: { name: offered.function.name, arguments: "{}" } }] } : { role: "assistant", content: "Offline fixture finished." };
        const finish = first ? "tool_calls" : "stop";
        const common = { id: "offline-completion", model: "offline-fixture", created: 1 };
        if (input.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const delta = first ? { role: "assistant", tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) } : message;
          for (const [value, reason] of [[delta, null], [{}, finish]]) response.write(`data: ${JSON.stringify({ ...common,
            object: "chat.completion.chunk", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
          response.end("data: [DONE]\n\n");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      } catch {
        observation.fixtureError = true;
        response.writeHead(500); response.end("Offline fixture protocol error");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, observation, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function disconnectLikeSdk(ws, child, root) {
  const closed = new Promise((resolve) => ws.once("close", resolve));
  ws.close();
  await Promise.race([closed, sleep(1000).then(() => { throw new Error("SDK-like WebSocket close timed out"); })]);
  child.stdin.end();
  const ended = child.exitCode !== null || child.signalCode !== null ? null :
    new Promise((resolve) => child.once("exit", resolve));
  if (ended) await Promise.race([ended, sleep(4000).then(() => { throw new Error("SDK-like harness shutdown timed out"); })]);
  const result = { exitCode: child.exitCode, signalCode: child.signalCode };
  fs.writeFileSync(path.join(root, "sdk-disconnect.json"), JSON.stringify(result) + "\n", { mode: 0o600 });
  assert.equal(child.exitCode, 0, "SDK-like graceful disconnect caused a nonzero harness exit");
  return result;
}

async function probeCase({ root, harness, bootstrap, name, timeoutSeconds, delayMs, compat, harnessSandbox, catalogOnly }) {
  const WebSocket = require("ws");
  fs.mkdirSync(root, { mode: 0o700 });
  const environment = isolatedEnvironment(root);
  const log = path.join(root, "mcp-events.jsonl");
  const descriptor = { name: "shoggoth", command: fs.realpathSync(process.execPath), args: [fs.realpathSync(__filename), "--fake-mcp"],
    env: [{ name: "SHOGGOTH_SMOKE_MCP_LOG", value: log }, { name: "SHOGGOTH_SMOKE_MCP_DELAY_MS", value: String(delayMs) }] };
  const model = await fakeModel();
  let bridge, child, ws, unregister;
  let caseResult;
  let bridgeSourceSha256 = null, bootstrapSha256 = null;
  let bridgeFatal = null;
  let stderr = "";
  const events = [];
  const startedAt = Date.now();
  try {
    let extraEnvironment = {};
    if (compat) {
      const bridgePath = require.resolve("../app/agent-service/antigravity-mcp-timeout-bridge");
      const { AntigravityMcpTimeoutBridge } = require(bridgePath);
      bridgeSourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(bridgePath)).digest("hex");
      bootstrapSha256 = crypto.createHash("sha256").update(fs.readFileSync(bootstrap)).digest("hex");
      bridge = new AntigravityMcpTimeoutBridge({ paths: { trustedRoot: root, stateDir: path.join(root, "state"), runtimeDir: path.join(root, "runtime") },
        server: { version: "1.4.3", serverPath: fs.realpathSync(process.execPath), harnessPath: harness }, bootstrapPath: bootstrap,
        getAcpPid: () => process.pid, onFatal: (error) => { bridgeFatal = error.code || "BRIDGE_FATAL"; } });
      extraEnvironment = { ...await bridge.start(), ANTIGRAVITY_HARNESS_PATH: bootstrap };
      if (!catalogOnly) unregister = bridge.registerMcpServer(descriptor);
    }
    child = spawn(harnessSandbox ? "/usr/bin/sandbox-exec" : compat ? bootstrap : harness,
      harnessSandbox ? ["-f", harnessSandbox, compat ? bootstrap : harness] : [], { cwd: root, env: { ...environment, ...extraEnvironment },
      stdio: ["pipe", "pipe", "pipe"], detached: true });
    children.add(child);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
    const configPromise = readFramedConfig(child.stdout);
    const bytes = inputConfig(root), length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([length, bytes]));
    const output = await configPromise;
    ws = new WebSocket(`ws://127.0.0.1:${output.port}/`, { headers: { "x-goog-api-key": output.apiKey }, maxPayload: 4_000_000 });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.stepUpdate) {
        const step = event.stepUpdate;
        events.push({ kind: "step", state: step.state, mcp: !!step.mcpTool, error: !!step.errorMessage || !!step.error,
          timeout: /timed out|deadline exceeded/i.test(step.errorMessage || step.error?.errorMessage || "") });
        if (step.toolConfirmationRequest) {
          assert.equal(step.mcpTool?.serverName, "shoggoth", "Only the synthetic MCP tool may be confirmed");
          ws.send(JSON.stringify({ toolConfirmation: { trajectoryId: step.trajectoryId, stepIndex: step.stepIndex, accepted: true } }));
        }
      }
      if (event.trajectoryStateUpdate) events.push({ kind: "trajectory", state: event.trajectoryStateUpdate.state,
        timeout: /timed out|deadline exceeded/i.test(event.trajectoryStateUpdate.error || "") });
      if (event.initializeConversationResponse) events.push({ kind: "initialized" });
    });
    const envMap = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
    ws.send(JSON.stringify({ config: { appDataDir: path.join(root, "app-data"),
      models: [{ name: "offline-fixture", types: ["MODEL_TYPE_TEXT"], gemmaEndpoint: { baseUrl: model.baseUrl } }],
      ...(!catalogOnly ? { mcpServers: [{ name: descriptor.name, stdio: { command: descriptor.command, args: descriptor.args, env: envMap },
        ...(timeoutSeconds ? { timeoutSeconds } : {}), forceAllToolsEager: true }] } : {}),
      policyConfig: { rules: [{ tool: "*", decision: "POLICY_DECISION_DENY" },
        { tool: "delayed_echo", serverName: "shoggoth", decision: "POLICY_DECISION_ALLOW" }] } } }));
    const deadline = Date.now() + delayMs + 60_000;
    while (!events.some((event) => event.kind === "initialized")) {
      assert.ok(!interrupted && Date.now() < deadline && child.exitCode === null && !bridgeFatal, "Harness initialization failed");
      await sleep(25);
    }
    if (catalogOnly) {
      const sdkDisconnect = await disconnectLikeSdk(ws, child, root);
      assert.equal(model.observation.requests, 0, "Catalog initialization must not call even the fake model");
      assert.equal(fs.existsSync(log), false, "Catalog initialization must not spawn the fake MCP server");
      caseResult = { name, actualHarness: true, compatibility: true, signedParParent: false, catalogOnly: true,
        modelRequests: 0, mcpSpawned: false, sdkDisconnect, bridgeSourceSha256, bootstrapSha256, productionProcessObservers: true };
      return caseResult;
    }
    ws.send(JSON.stringify({ userInput: { parts: [{ text: "Invoke the sole delayed_echo fixture tool once, then finish." }] } }));
    while (!(model.observation.requests >= 2 && events.findLast((event) => event.kind === "trajectory")?.state === "STATE_FULLY_IDLE")) {
      assert.ok(!interrupted && Date.now() < deadline && child.exitCode === null && !bridgeFatal && !model.observation.fixtureError, "Offline harness probe did not finish");
      await sleep(50);
    }
    const records = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const called = records.find((event) => event.event === "called");
    const completed = records.find((event) => event.event === "completed");
    const cancelled = records.find((event) => event.event === "cancelled");
    assert.ok(called, "Real harness did not call the synthetic MCP server");
    assert.equal(records.filter((event) => event.event === "called").length, 1, "The fixture tool must execute exactly once");
    const expectSuccess = compat || (timeoutSeconds === 0 ? 180 : timeoutSeconds) > delayMs / 1000;
    assert.equal(model.observation.toolReceiptObserved, expectSuccess, "Harness tool receipt did not match timeout expectation");
    if (expectSuccess) {
      assert.ok(completed && !cancelled, "A successful receipt requires completed MCP execution without cancellation");
      assert.equal(records.filter((event) => event.event === "completed").length, 1);
      assert.ok(completed.at - called.at >= delayMs - 50, "The fixture completed before the requested delay");
    } else {
      assert.ok(!completed && cancelled, "A timeout must cancel the actual pending MCP request");
      assert.ok(model.observation.timeoutObserved || events.some((event) => event.timeout), "Missing authoritative timeout evidence");
      const expectedMs = (timeoutSeconds === 0 ? 180 : timeoutSeconds) * 1000;
      assert.ok(cancelled.at - called.at >= expectedMs - 250 && cancelled.at - called.at <= expectedMs + 5000,
        "MCP cancellation did not occur at the configured deadline");
    }
    let sdkDisconnect = null;
    if (flag("--sdk-disconnect")) sdkDisconnect = await disconnectLikeSdk(ws, child, root);
    caseResult = { name, actualHarness: true, compatibility: !!compat, signedParParent: false, timeoutSeconds: compat ? 1800 : timeoutSeconds,
      delayMs, elapsedMs: Date.now() - startedAt, toolReceiptObserved: model.observation.toolReceiptObserved,
      timeoutObserved: model.observation.timeoutObserved || events.some((event) => event.timeout),
      completedAfterMs: completed ? completed.at - called.at : null, cancelledAfterMs: cancelled ? cancelled.at - called.at : null,
      modelRequests: model.observation.requests, bridgeSourceSha256, bootstrapSha256,
      productionProcessObservers: !!compat, sdkDisconnect };
    return caseResult;
  } catch (error) {
    // All inputs are synthetic; retain only bounded diagnostic text in the
    // isolated directory, never stdout or application logs.
    await sleep(50);
    fs.writeFileSync(path.join(root, "failure.txt"), `${error.message}\n${JSON.stringify({ bridgeFatal,
      exitCode: child?.exitCode, signalCode: child?.signalCode })}\n${stderr}\n${JSON.stringify(events)}\n`, { mode: 0o600 });
    throw new Error(`${name}: offline fixture failed; see isolated failure.txt`);
  } finally {
    ws?.terminate();
    const settled = await Promise.allSettled([
      terminateChild(child),
      Promise.resolve().then(async () => { unregister?.(); await bridge?.close(); }),
      Promise.resolve().then(async () => {
        model.server.closeAllConnections();
        await new Promise((resolve) => model.server.close(resolve));
      }),
    ]);
    const cleanup = settled[0].status === "fulfilled" ? settled[0].value : null;
    if (caseResult) caseResult.cleanup = cleanup;
    assert.ok(settled.every((item) => item.status === "fulfilled") && cleanup?.childExited && cleanup?.processGroupGone,
      "Offline fixture cleanup did not confirm process-group exit");
  }
}

async function inside() {
  const root = option("--root");
  const harness = fs.realpathSync(option("--harness"));
  const bootstrap = option("--bootstrap") ? fs.realpathSync(option("--bootstrap")) : null;
  const harnessSandbox = option("--harness-sandbox");
  let blocked;
  if (harnessSandbox) {
    // macOS forbids executing setuid /bin/ps from inside a sandbox. The Service
    // and its real process observer therefore stay outside, just as production;
    // sandbox-exec execs the C/harness at the same PID with this Node parent.
    const guard = `const n=require('node:net');const s=n.connect({host:'192.0.2.1',port:1});s.once('error',e=>{s.destroy();process.exit(['EPERM','EACCES'].includes(e.code)?0:2)});s.setTimeout(1000,()=>{s.destroy();process.exit(3)});`;
    const check = spawnSync("/usr/bin/sandbox-exec", ["-f", harnessSandbox, fs.realpathSync(process.execPath), "-e", guard], {
      cwd: root, env: isolatedEnvironment(root), timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    });
    blocked = check.status === 0;
  } else {
    blocked = await new Promise((resolve) => {
      const socket = net.connect({ host: "192.0.2.1", port: 1 });
      socket.once("error", (error) => { socket.destroy(); resolve(["EPERM", "EACCES"].includes(error.code)); });
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
  }
  assert.equal(blocked, true, "The sandbox must reject non-loopback network before harness startup");
  const cases = (flag("--long") ? [
    { name: "default-180s", timeoutSeconds: 0, delayMs: 190_000, compat: false },
    { name: "compatibility-1800s", timeoutSeconds: 0, delayMs: 190_000, compat: true },
  ] : [
    { name: "default-short", timeoutSeconds: 0, delayMs: 3500, compat: false },
    { name: "explicit-2s", timeoutSeconds: 2, delayMs: 3500, compat: false },
    { name: "explicit-5s", timeoutSeconds: 5, delayMs: 3500, compat: false },
    ...(bootstrap ? [{ name: "compatibility-short", timeoutSeconds: 0, delayMs: 3500, compat: true }] : []),
    ...(bootstrap ? [{ name: "catalog-empty", timeoutSeconds: 0, delayMs: 0, compat: true, catalogOnly: true }] : []),
  ]).filter((entry) => !option("--only") || entry.name === option("--only"));
  assert.ok(cases.length > 0, "--only must name one of the selected suite cases");
  const results = await Promise.all(cases.map((entry) => probeCase({ ...entry, root: path.join(root, entry.name), harness, bootstrap, harnessSandbox })));
  return { offline: true, noProvider: true, noProviderCredentials: true, network: "sandbox-loopback-only",
    sandboxBoundary: harnessSandbox ? "harness-and-descendants; real Service observer outside" : "entire fixture", results };
}

async function main() {
  assert.ok(flag("--offline"), "Pass --offline to opt in; this script never uses a real Provider");
  assert.equal(process.platform, "darwin", "The offline proof requires macOS sandbox-exec");
  if (flag("--inside-sandbox")) return inside();
  assert.ok(flag("--short") !== flag("--long"), "Choose exactly one of --short or --long");
  assert.ok(option("--harness") && option("--sdk-source-dir"), "Explicit --harness and --sdk-source-dir are required");
  if ((flag("--long") && option("--only") !== "default-180s") || option("--only")?.startsWith("compatibility")) {
    assert.ok(option("--bootstrap"), "The long compatibility case requires --bootstrap");
  }
  const harness = fs.realpathSync(option("--harness"));
  const bootstrap = option("--bootstrap") ? fs.realpathSync(option("--bootstrap")) : null;
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-agy-mcp-timeout-offline-"));
  fs.chmodSync(root, 0o700);
  const reserve = path.join(root, "evidence-reserve.bin");
  fs.writeFileSync(reserve, Buffer.alloc(1024 * 1024), { mode: 0o600 });
  const descriptor = verifySdkShape(option("--sdk-source-dir"), isolatedEnvironment(root));
  const profile = path.join(root, "offline.sb");
  fs.writeFileSync(profile, sandboxProfile(root, harness, bootstrap), { mode: 0o600 });
  const args = process.argv.slice(2).filter((value) => value !== "--inside-sandbox");
  const compat = (flag("--long") && option("--only") !== "default-180s") || !!bootstrap;
  const child = spawn(compat ? fs.realpathSync(process.execPath) : "/usr/bin/sandbox-exec",
    [...(compat ? [] : ["-f", profile, fs.realpathSync(process.execPath)]), fs.realpathSync(__filename),
      ...args, "--inside-sandbox", "--root", root, ...(compat ? ["--harness-sandbox", profile] : [])],
    { cwd: root, env: isolatedEnvironment(root), stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.fixtureDriver = true;
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const driverCleanup = await terminateChild(child);
  assert.ok(driverCleanup.childExited && driverCleanup.processGroupGone, "Offline fixture driver cleanup failed");
  if (status !== 0) {
    fs.rmSync(reserve, { force: true });
    fs.writeFileSync(path.join(root, "driver-failure.txt"), stderr.slice(-16384), { mode: 0o600 });
    throw new Error(`Offline sandbox probe failed; isolated evidence: ${root}`);
  }
  const result = { ...JSON.parse(stdout), descriptor, harnessSha256: crypto.createHash("sha256").update(fs.readFileSync(harness)).digest("hex"),
    evidenceRoot: root, evidencePersisted: true, driverCleanup };
  fs.unlinkSync(reserve);
  try { fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); }
  catch (error) {
    result.evidencePersisted = false;
    result.evidencePersistenceError = error.code || "WRITE_FAILED";
    process.exitCode = 1;
  }
  return result;
}

if (flag("--fake-mcp")) fakeMcp();
else main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
