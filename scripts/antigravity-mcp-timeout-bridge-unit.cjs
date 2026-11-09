"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { test } = require("node:test");
const WebSocket = require("ws");
const { AntigravityMcpTimeoutBridge } = require("../app/agent-service/antigravity-mcp-timeout-bridge");

const CODE = "ANTIGRAVITY_MCP_TIMEOUT_";
const varint = (input) => {
  const bytes = [];
  do { let byte = input & 127; input = Math.floor(input / 128); if (input) byte |= 128; bytes.push(byte); } while (input);
  return Buffer.from(bytes);
};
const output = (port, key) => Buffer.concat([Buffer.from([8]), varint(port), Buffer.from([18]), varint(Buffer.byteLength(key)), Buffer.from(key)]);
const framed = (bytes) => { const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); };

function readOutput(bytes) {
  let at = 0;
  const read = () => { let n = 0, shift = 0, b; do { b = bytes[at++]; n += (b & 127) * (2 ** shift); shift += 7; } while (b & 128); return n; };
  assert.equal(read(), 8);
  const port = read();
  assert.equal(read(), 18);
  const size = read(), key = bytes.subarray(at, at + size).toString();
  assert.equal(at + size, bytes.length);
  return { port, key };
}

function event(target) {
  return { config: { mcpServers: [target], workspace: { rootPath: "/synthetic/workspace" } },
    opaqueFixture: { keep: [true, null, "unchanged"] } };
}

function frameRead(socket, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("fixture frame timeout")), timeoutMs);
    const closed = () => finish(new Error("fixture socket closed"));
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("close", closed);
      if (error) reject(error); else resolve(value);
    };
    const data = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE()) finish(null, bytes.subarray(4, 4 + bytes.readUInt32LE()));
    };
    socket.on("data", data);
    socket.once("close", closed);
  });
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync("/private/tmp/agy-t-");
  fs.chmodSync(root, 0o700);
  const harnessPath = path.join(root, "harness"), bootstrapPath = path.join(root, "bootstrap"), serverPath = path.join(root, "server");
  for (const target of [harnessPath, bootstrapPath, serverPath]) fs.writeFileSync(target, "synthetic executable, never launched", { mode: 0o755 });
  const identities = new Map([[10001, "acp-start"], [10002, "harness-start"], [10003, "relay-start"]]);
  const links = new Map([[10001, { ppid: 10000, executable: serverPath, command: "server" }],
    [10002, { ppid: 10001, executable: harnessPath, command: "harness" }],
    [10003, { ppid: 10002, executable: bootstrapPath, command: "bootstrap --relay" }]]);
  const fatals = [];
  let wakeFatal;
  const fatal = new Promise((resolve) => { wakeFatal = resolve; });
  const bridge = new AntigravityMcpTimeoutBridge({
    paths: { trustedRoot: root, runtimeDir: path.join(root, "run") },
    server: { version: "nightly", harnessPath, serverPath, contracts: { mcpTimeout: 1 } }, bootstrapPath,
    getAcpPid: () => 10001,
    onFatal: (error) => { fatals.push(error); wakeFatal(error); },
    readProcessIdentity: (target) => identities.get(target) || "",
    readProcessLink: (target) => links.get(target),
    ...options,
  });
  const env = await bridge.start();
  const originalKey = crypto.randomBytes(24).toString("hex");
  const fakeHarness = http.createServer();
  const wss = new WebSocket.WebSocketServer({ server: fakeHarness, maxPayload: 20 * 1024 * 1024 });
  const received = [], incoming = [], sockets = new Set();
  wss.on("connection", (ws, request) => {
    sockets.add(ws);
    incoming.push(request.headers["x-goog-api-key"]);
    ws.on("message", (data, binary) => {
      received.push({ data: Buffer.from(data), binary });
      if (received.length > 1) ws.send(data, { binary });
    });
  });
  await new Promise((resolve) => fakeHarness.listen(0, "127.0.0.1", resolve));
  const acp = { name: "shoggoth", command: "/exact/mcp-helper", args: ["--native", "unchanged"],
    env: [{ name: "GATE", value: "synthetic-gate" }, { name: "ACCOUNT", value: "synthetic-account" }] };
  const wire = { name: "shoggoth", stdio: { command: acp.command, args: [...acp.args], env: { ACCOUNT: "synthetic-account", GATE: "synthetic-gate" } } };
  bridge.registerMcpServer(acp);
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => fakeHarness.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const connectControl = async (hello = {}, bytes = output(fakeHarness.address().port, originalKey), delayOutputMs = 0) => {
    const control = net.connect(env.SHOGGOTH_AGY_TIMEOUT_SOCKET);
    control.on("error", () => {});
    await once(control, "connect");
    const response = frameRead(control, delayOutputMs + 2500);
    response.catch(() => {});
    const metadata = framed(Buffer.from(JSON.stringify({ version: 1, token: env.SHOGGOTH_AGY_TIMEOUT_TOKEN,
      harnessPid: 10002, relayPid: 10003, ...hello })));
    if (delayOutputMs) {
      control.write(metadata);
      await new Promise((resolve) => setTimeout(resolve, delayOutputMs));
      control.write(framed(bytes));
    } else control.write(Buffer.concat([metadata, framed(bytes)]));
    return { control, config: readOutput(await response) };
  };
  const connectWs = async (config, key = config.key) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/`, { headers: { "x-goog-api-key": key }, perMessageDeflate: false });
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  };
  return { root, bridge, env, identities, links, fatals, fatal, received, incoming, sockets,
    acp, wire, connectControl, connectWs, originalKey };
}

async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    assert.ok(Date.now() < deadline, "fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("version pin and private bootstrap/control environment are enforced", async (t) => {
  assert.throws(() => new AntigravityMcpTimeoutBridge({ server: { version: "1.4.3" } }), { code: CODE + "CONTRACT_UNSUPPORTED" });
  const f = await fixture(t);
  assert.equal(fs.statSync(path.dirname(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET).mode & 0o777, 0o600);
  assert.match(f.env.SHOGGOTH_AGY_TIMEOUT_TOKEN, /^[a-f0-9]{64}$/u);
  assert.ok(Buffer.byteLength(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET) <= 103);
  assert.equal(f.bridge.getBootstrapEnv(), f.env);
  await assert.rejects(f.bridge.start(), { code: CODE + "CLOSED" });
  assert.throws(() => f.bridge.registerMcpServer({ ...f.acp, env: [...f.acp.env, f.acp.env[0]] }), { code: CODE + "DESCRIPTOR_INVALID" });
});

test("only the exact registered MCP identity gets the portable MCP limit, other fields and subsequent text/binary survive", async (t) => {
  const f = await fixture(t);
  const { control, config } = await f.connectControl();
  assert.notEqual(config.key, f.originalKey);
  const ws = await f.connectWs(config);
  const initial = event(f.wire);
  initial.config.mcpServers.unshift({ name: "unrelated", stdio: { command: "/elsewhere", env: { untouched: "yes" } }, timeoutSeconds: 17 });
  ws.send(JSON.stringify(initial));
  await until(() => f.received.length === 1);
  const expected = structuredClone(initial);
  expected.config.mcpServers[1].timeoutSeconds = 2147000;
  assert.deepEqual(JSON.parse(f.received[0].data), expected);
  assert.deepEqual(f.incoming, [f.originalKey]);
  assert.equal(f.received[0].binary, false);
  const reply1 = once(ws, "message");
  ws.send("transparent text");
  const [text, isBinary] = await reply1;
  assert.equal(text.toString(), "transparent text");
  assert.equal(isBinary, false);
  const reply2 = once(ws, "message");
  ws.send(Buffer.from([0, 255, 3, 10]));
  const [binary, binaryFlag] = await reply2;
  assert.deepEqual(binary, Buffer.from([0, 255, 3, 10]));
  assert.equal(binaryFlag, true);
  const controlClosed = once(control, "close"), clientClosed = once(ws, "close");
  const socketPath = f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET;
  await f.bridge.close();
  await Promise.all([controlClosed, clientClosed]);
  assert.equal(fs.existsSync(path.dirname(socketPath)), false);
  assert.equal(f.fatals.length, 0);
  await f.bridge.close();
});

test("protobuf-default empty args/env match only an equally empty registered identity", async (t) => {
  const f = await fixture(t);
  f.bridge.registerMcpServer({ name: "shoggoth", command: "/empty" });
  const { config } = await f.connectControl();
  const ws = await f.connectWs(config);
  ws.send(JSON.stringify(event({ name: "shoggoth", stdio: { command: "/empty" } })));
  await until(() => f.received.length === 1);
  assert.equal(JSON.parse(f.received[0].data).config.mcpServers[0].timeoutSeconds, 2147000);
});

test("descriptor mismatch, duplicates, malformed and binary initial events fail before reaching the harness", async (t) => {
  const cases = [
    ["command", (value) => { value.config.mcpServers[0].stdio.command += "-other"; }],
    ["argument order", (value) => { value.config.mcpServers[0].stdio.args.reverse(); }],
    ["extra env", (value) => { value.config.mcpServers[0].stdio.env.EXTRA = "x"; }],
    ["changed env", (value) => { value.config.mcpServers[0].stdio.env.GATE = "different"; }],
    ["missing env", (value) => { delete value.config.mcpServers[0].stdio.env.GATE; }],
    ["duplicate target", (value) => { value.config.mcpServers.push(structuredClone(value.config.mcpServers[0])); }],
    ["transport ambiguity", (value) => { value.config.mcpServers[0].http = { url: "http://127.0.0.1" }; }],
    ["egress transport", (value) => { value.config.mcpServers[0].egressRpc = {}; }],
    ["timeout alias", (value) => { value.config.mcpServers[0].timeout_seconds = -1; }],
    ["server list alias", (value) => { value.config.mcp_servers = structuredClone(value.config.mcpServers); }],
    ["null env", (value) => { value.config.mcpServers[0].stdio.env = null; }],
    ["unknown stdio field", (value) => { value.config.mcpServers[0].stdio.other = true; }],
    ["invalid JSON", () => "{bad json"],
    ["binary", () => Buffer.from("{}")],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (child) => {
    const f = await fixture(child);
    const { config } = await f.connectControl();
    const ws = await f.connectWs(config);
    const value = event(f.wire), replacement = mutate(value);
    ws.send(replacement || JSON.stringify(value));
    const error = await f.fatal;
    assert.match(error.code, /^ANTIGRAVITY_MCP_TIMEOUT_(DESCRIPTOR_MISMATCH|DESCRIPTOR_INVALID|INITIAL_INVALID)$/u);
    assert.equal(error.message, error.code);
    assert.equal(f.received.length, 0);
    assert.equal(f.incoming.length, 0);
  });
});

test("catalog config without Shoggoth MCP passes unchanged without acquiring a scope", async (t) => {
  for (const mode of ["omitted list", "empty list", "other servers only"]) await t.test(mode, async (child) => {
    const f = await fixture(child), { config } = await f.connectControl(), ws = await f.connectWs(config);
    const initial = { config: { modelCatalog: { fixture: true } }, opaqueFixture: ["preserve", 3] };
    if (mode === "empty list") initial.config.mcpServers = [];
    else if (mode === "other servers only") initial.config.mcpServers = [
      { name: "shoggoth-copy", stdio: { command: f.acp.command, args: [...f.acp.args], env: f.wire.stdio.env }, timeoutSeconds: 9 },
      { name: "unrelated", http: { url: "http://127.0.0.1/synthetic" } },
    ];
    const bytes = JSON.stringify(initial, null, 3);
    ws.send(bytes);
    await until(() => f.received.length === 1);
    assert.equal(f.received[0].data.toString(), bytes, "non-target config is byte-for-byte transparent");
    assert.equal(f.bridge.sessions.get(10002).fingerprint, undefined);
    assert.equal(f.fatals.length, 0);
  });
});

test("unauthenticated control and WebSocket clients cannot consume the legitimate connection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.connectControl({ token: "0".repeat(64) }), /socket closed/u);
  assert.equal(f.fatals.length, 0);
  const { config } = await f.connectControl();
  await assert.rejects(f.connectWs(config, "wrong"));
  await assert.rejects(f.connectWs(config, "é".repeat(64)));
  assert.equal(f.fatals.length, 0);
  const ws = await f.connectWs(config);
  await assert.rejects(f.connectWs(config));
  ws.send(JSON.stringify(event(f.wire)));
  await until(() => f.received.length === 1);
  assert.equal(f.incoming.length, 1);
  assert.equal(f.fatals.length, 0);
});

test("native handshake rejects oversize framing, ambiguous protobufs and trailing control data", async (t) => {
  await t.test("oversize anonymous frame", async (child) => {
    const f = await fixture(child), socket = net.connect(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET);
    socket.on("error", () => {});
    await once(socket, "connect");
    const done = once(socket, "close"), header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff);
    socket.write(header);
    await done;
    assert.equal(f.fatals.length, 0);
  });
  for (const [name, bytes] of [
    ["duplicate port", Buffer.concat([output(123, "key"), Buffer.from([8, 12])])],
    ["unknown field", Buffer.concat([output(123, "key"), Buffer.from([24, 1])])],
    ["invalid port", output(0, "key")],
    ["invalid UTF8", Buffer.from([8, 123, 18, 1, 255])],
  ]) await t.test(name, async (child) => {
    const f = await fixture(child);
    await assert.rejects(f.connectControl({}, bytes));
    assert.equal((await f.fatal).code, CODE + "CONTROL_INVALID");
    assert.equal(f.incoming.length, 0);
  });
  await t.test("data after handshake", async (child) => {
    const f = await fixture(child), { control } = await f.connectControl();
    control.write(Buffer.from([0]));
    assert.equal((await f.fatal).code, CODE + "CONTROL_INVALID");
  });
});

test("process ancestry, executable and start identities are checked before any provider connection", async (t) => {
  for (const [name, mutate] of [
    ["wrong ACP executable", (f) => { f.links.get(10001).executable = "/untrusted/server"; }],
    ["wrong harness parent", (f) => { f.links.get(10002).ppid = 9999; }],
    ["wrong relay executable", (f) => { f.links.get(10003).executable = "/untrusted/bootstrap"; }],
    ["missing identity", (f) => { f.identities.delete(10002); }],
  ]) await t.test(name, async (child) => {
    const f = await fixture(child);
    mutate(f);
    await assert.rejects(f.connectControl());
    assert.equal(f.incoming.length, 0);
  });
  await t.test("PID reused after proxy handoff", async (child) => {
    const f = await fixture(child), { config } = await f.connectControl();
    const ws = await f.connectWs(config);
    f.identities.set(10002, "reused-pid");
    ws.send(JSON.stringify(event(f.wire)));
    assert.equal((await f.fatal).code, CODE + "PROCESS_CHANGED");
    assert.equal(f.incoming.length, 0);
  });
});

test("control loss cancels authenticated forwarding; unregister cancels its exact scope without fatal", async (t) => {
  await t.test("control cancellation", async (child) => {
    const f = await fixture(child), { control, config } = await f.connectControl();
    const ws = await f.connectWs(config);
    ws.send(JSON.stringify(event(f.wire)));
    await until(() => f.received.length === 1);
    control.destroy();
    await until(() => ws.readyState === WebSocket.CLOSED);
    assert.equal(f.fatals.length, 0);
  });
  await t.test("registration disposal", async (child) => {
    const f = await fixture(child);
    const other = { name: "shoggoth", command: "/other-scope", args: [], env: [] };
    const unregister = f.bridge.registerMcpServer(other);
    const { config } = await f.connectControl(), ws = await f.connectWs(config);
    ws.send(JSON.stringify(event({ name: "shoggoth", stdio: { command: other.command } })));
    await until(() => f.received.length === 1);
    unregister();
    unregister();
    await until(() => ws.readyState === WebSocket.CLOSED);
    assert.equal(f.fatals.length, 0);
    assert.equal(f.bridge.registrations.size, 1);
  });
});

test("normal SDK harness teardown permits a replacement harness in the same Host", async (t) => {
  const f = await fixture(t), { control, config } = await f.connectControl(), ws = await f.connectWs(config);
  ws.send(JSON.stringify(event(f.wire)));
  await until(() => f.received.length === 1);
  ws.close(1000);
  await until(() => ws.readyState === WebSocket.CLOSED);
  assert.equal(f.bridge.sessions.get(10002)?.retiring, true);
  assert.equal(control.destroyed, false, "SDK must close stdin before the relay is cancelled");
  control.end();
  await until(() => f.bridge.sessions.size === 0);
  f.links.set(10004, { ...f.links.get(10002) });
  f.links.set(10005, { ...f.links.get(10003), ppid: 10004 });
  f.identities.set(10004, "new-harness-start");
  f.identities.set(10005, "new-relay-start");
  const replacement = await f.connectControl({ harnessPid: 10004, relayPid: 10005 });
  const next = await f.connectWs(replacement.config);
  next.send(JSON.stringify(event(f.wire)));
  await until(() => f.received.length === 2);
  assert.equal(JSON.parse(f.received[1].data).config.mcpServers[0].timeoutSeconds, 2147000);
  assert.equal(f.fatals.length, 0);
});

test("SDK retirement remains cancellable by Host close and has a bounded grace", async (t) => {
  for (const mode of ["host close", "scope unregister", "grace expiry"]) await t.test(mode, async (child) => {
    const f = await fixture(child);
    const scope = { name: "shoggoth", command: "/retirement-scope", args: [], env: [] };
    const unregister = f.bridge.registerMcpServer(scope);
    const { control, config } = await f.connectControl(), ws = await f.connectWs(config);
    ws.send(JSON.stringify(event({ name: "shoggoth", stdio: { command: scope.command } })));
    await until(() => f.received.length === 1);
    ws.close(1000);
    await until(() => ws.readyState === WebSocket.CLOSED);
    const session = f.bridge.sessions.get(10002);
    assert.equal(session?.retiring, true);
    assert.equal(control.destroyed, false);
    assert.equal(session.retirementTimer._idleTimeout, 180_000, "matches the pinned SDK disconnect wait");
    const stopped = once(control, "close");
    if (mode === "host close") await f.bridge.close();
    else if (mode === "scope unregister") unregister();
    // Exercise the production callback without spending the SDK's three-minute
    // shutdown budget; no public timeout override is needed.
    else session.retirementTimer._onTimeout();
    await stopped;
    assert.equal(f.bridge.sessions.size, 0);
    assert.equal(f.fatals.length, 0);
  });
});

test("initial config uses the finite payload cap and errors disclose no content", async (t) => {
  const f = await fixture(t), { config } = await f.connectControl(), ws = await f.connectWs(config);
  const initial = { ...event(f.wire), developerInstructions: "s".repeat(1024 * 1024 + 1024) };
  ws.send(JSON.stringify(initial));
  await until(() => f.received.length === 1);
  assert.equal(JSON.parse(f.received[0].data).developerInstructions.length, initial.developerInstructions.length);
  ws.send(Buffer.alloc(16 * 1024 * 1024 + 1));
  const error = await f.fatal;
  assert.equal(error.code, CODE + "CLIENT_FAILED");
  assert.equal(error.message, error.code);
  assert.equal(error.stack.includes("synthetic-gate"), false);
  assert.equal(f.received.length, 1);
});

test("anonymous control clients are count bounded and close() drains them", async (t) => {
  const f = await fixture(t);
  const sockets = await Promise.all(Array.from({ length: 32 }, async () => {
    const socket = net.connect(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET);
    socket.on("error", () => {});
    await once(socket, "connect");
    return socket;
  }));
  await until(() => f.bridge.connections.size === 32);
  const extra = net.connect(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET);
  extra.on("error", () => {});
  await once(extra, "close");
  assert.equal(f.bridge.connections.size, 32);
  const done = sockets.map((socket) => once(socket, "close"));
  await f.bridge.close();
  await Promise.all(done);
  assert.equal(f.bridge.connections.size, 0);
  assert.equal(f.fatals.length, 0);
});

test("anonymous slow control client has a fixed handshake deadline", { timeout: 8000 }, async (t) => {
  const f = await fixture(t), socket = net.connect(f.env.SHOGGOTH_AGY_TIMEOUT_SOCKET);
  socket.on("error", () => {});
  await once(socket, "connect");
  const started = Date.now();
  socket.write(Buffer.from([1]));
  await once(socket, "close");
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7500);
  assert.equal(f.fatals.length, 0);
});

test("authenticated native cold start can exceed the anonymous five-second deadline", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), started = Date.now();
  const { config } = await f.connectControl({}, undefined, 5200);
  assert.ok(Date.now() - started >= 5000);
  const ws = await f.connectWs(config);
  ws.send(JSON.stringify(event(f.wire)));
  await until(() => f.received.length === 1);
  assert.equal(JSON.parse(f.received[0].data).config.mcpServers[0].timeoutSeconds, 2147000);
  assert.equal(f.fatals.length, 0);
});

test("valid large history payload survives backpressure and the frame cap remains finite", async (t) => {
  const f = await fixture(t), { config } = await f.connectControl(), ws = await f.connectWs(config);
  ws.send(JSON.stringify(event(f.wire)));
  await until(() => f.received.length === 1);
  const message = "h".repeat(8 * 1024 * 1024 + 1024);
  const reply = once(ws, "message");
  ws.send(message);
  const [bytes, binary] = await reply;
  assert.equal(bytes.length, message.length);
  assert.equal(bytes.toString(), message);
  assert.equal(binary, false);
  assert.equal(f.fatals.length, 0);
  ws.send(Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.equal((await f.fatal).code, CODE + "CLIENT_FAILED");
  assert.equal(f.received.length, 2, "oversize frame never reaches harness");
});

test("a start identity changing during ancestry inspection is rejected", async (t) => {
  let calls = 0;
  const f = await fixture(t, { readProcessIdentity: () => (++calls > 3 ? "changed" : "original") });
  await assert.rejects(f.connectControl());
  assert.equal((await f.fatal).code, CODE + "PROCESS_CHANGED");
  assert.equal(f.incoming.length, 0);
});
