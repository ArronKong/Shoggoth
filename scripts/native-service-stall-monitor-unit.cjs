"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServiceStallMonitor, recordServiceStall } = require("../app/agent-service/service-stall-monitor");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken } = require("../app/agent-service/client");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = ms => { const end = performance.now() + ms; while (performance.now() < end) { /* hold the loop */ } };

test("a blocked Service loop is recorded with the methods that ran before it", async () => {
  const records = [];
  const monitor = createServiceStallMonitor({ paths: {}, thresholdMs: 100, intervalMs: 20,
    record: ({ record }) => records.push(record) });
  monitor.start();
  try {
    await delay(60);
    assert.deepEqual(records, [], "an idle loop records nothing");
    monitor.noteMethod("service.status");
    monitor.noteMethod("chat.send");
    monitor.noteMethod("bad method with spaces");
    block(250);
    await delay(80);
    assert.equal(records.length, 1);
    assert.ok(records[0].blockedMs >= 200, `blocked ${records[0].blockedMs}ms`);
    assert.deepEqual(records[0].recentMethods, ["service.status", "chat.send", "other"]);
  } finally { monitor.stop(); }
});

test("stall diagnostics stay bounded and keep only protocol method names", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-stall-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { trustedRoot: root, runtimeDir: path.join(root, "run") };
  fs.mkdirSync(paths.runtimeDir, { mode: 0o700 });
  for (let i = 0; i < 40; i += 1) {
    assert.equal(recordServiceStall({ paths, record: { timeMs: i, blockedMs: 1_000 + i, recentMethods: ["chat.send"] } }), true);
  }
  assert.equal(recordServiceStall({ paths, record: { timeMs: 1, blockedMs: 1, recentMethods: ["/Users/secret path"] } }), false);
  const saved = JSON.parse(fs.readFileSync(path.join(paths.runtimeDir, "service-stall-diagnostics.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.records.length, 32);
  assert.equal(saved.records.at(-1).blockedMs, 1_039);
  assert.equal(fs.statSync(path.join(paths.runtimeDir, "service-stall-diagnostics.json")).mode & 0o777, 0o600);
});

// A blocked turn runs expired timers before it reads sockets. The request bytes
// arrived in time; they must be served rather than rejected as FRAME_TIMEOUT.
test("a request received during a blocked turn is served instead of timing out its frame", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-frame-block-")));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache") });
  const service = createAgentService({ paths, version: "test", frameTimeoutMs: 50 });
  await service.start();
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const token = readClientToken(paths);
  const body = await new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    let text = "";
    socket.setEncoding("utf8");
    // Let the Service accept and arm its frame timer, then hold the loop past the
    // deadline outside the timers phase, as a long I/O or immediate callback does.
    socket.on("connect", () => setTimeout(() => setImmediate(() => {
      socket.write(`${JSON.stringify({ id: "blocked-turn", token, version: PROTOCOL_VERSION, method: "service.status" })}\n`);
      block(200);
    }), 20));
    socket.on("data", (chunk) => { text += chunk; if (text.includes("\n")) { socket.end(); resolve(text); } });
    socket.on("error", reject);
  });
  assert.doesNotMatch(body, /FRAME_TIMEOUT/);
  assert.equal(JSON.parse(body).ok, true);
});
