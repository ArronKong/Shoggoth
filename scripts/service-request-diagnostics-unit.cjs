"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { requestService } = require("../app/agent-service/client");
const { recordServiceRequestTimeout } = require("../app/agent-service/service-request-diagnostics");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-rq-")));
  fs.chmodSync(root, 0o700);
  const runtimeDir = path.join(root, "run");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const paths = { trustedRoot: root, runtimeDir, socketPath: path.join(runtimeDir, "s") };
  const target = path.join(runtimeDir, "service-request-diagnostics.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths, target };
}

const timeoutError = (patch = {}) => Object.assign(new Error("PRIVATE_ERROR /private/secret"), {
  code: "REQUEST_TIMEOUT", serviceRequestDiagnostic: {
    phase: "response", timeoutMs: 5000, elapsedMs: 5010, responseBytes: 4, ...patch,
  },
});

test("real IPC timeout records its phase and duration while preserving the failure and single send", async t => {
  const f = fixture(t), clients = new Set();
  let requests = 0;
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.once("data", () => { requests += 1; socket.write("PRIVATE_PARTIAL_RESPONSE"); });
  });
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.paths.socketPath, resolve); });
  fs.chmodSync(f.paths.socketPath, 0o600);
  const backend = Object.assign(Object.create(ShoggothBackend.prototype), {
    paths: f.paths, readToken: () => "PRIVATE_TOKEN", randomUUID,
    requestService: (paths, request) => requestService(paths, request, { timeoutMs: 80 }),
  });
  await assert.rejects(backend._call("chat.send", { prompt: "PRIVATE_PROMPT", sessionKey: "PRIVATE_SESSION" }), error => {
    assert.equal(error.code, "REQUEST_TIMEOUT");
    assert.equal(error.admissionAccepted, undefined, "an unconfirmed send must not become a retryable rejection");
    assert.equal(error.serviceRequestDiagnostic, undefined, "transport details are not a public error payload");
    return true;
  });
  assert.equal(requests, 1, "observing a timeout never retries or replays the send");
  assert.equal(fs.existsSync(f.target), false, "support-file writes must not delay the original rejection");
  await new Promise(setImmediate);
  const text = fs.readFileSync(f.target, "utf8"), record = JSON.parse(text).records[0];
  assert.deepEqual(Object.keys(record).sort(), ["timeMs", "method", "code", "phase", "elapsedMs", "timeoutMs", "responseBytes"].sort());
  assert.equal(record.method, "chat.send");
  assert.equal(record.phase, "response");
  assert.equal(record.timeoutMs, 80);
  assert.ok(record.elapsedMs >= 79);
  assert.equal(record.responseBytes, Buffer.byteLength("PRIVATE_PARTIAL_RESPONSE"));
  assert.doesNotMatch(text, /PRIVATE_|\/private\//u);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
});

test("support history retains at most 32 records and only the closed vocabulary", t => {
  const f = fixture(t);
  for (let index = 0; index < 40; index++) assert.equal(recordServiceRequestTimeout({ paths: f.paths,
    method: index === 39 ? "PRIVATE_METHOD /Users/private" : "chat.session.runtime.state",
    error: timeoutError({ elapsedMs: 5000 + index, secret: "PRIVATE_SECRET", response: "PRIVATE_RESPONSE" }),
  }), true);
  const text = fs.readFileSync(f.target, "utf8"), history = JSON.parse(text);
  assert.equal(history.version, 1);
  assert.equal(history.records.length, 32);
  assert.equal(history.records[0].elapsedMs, 5008);
  assert.equal(history.records.at(-1).method, "other");
  assert.doesNotMatch(text, /PRIVATE_|\/Users\//u);
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
});

test("group timeout diagnostics distinguish metadata, paging, model selection and send without storing arguments", t => {
  const f = fixture(t);
  const methods = ["group.get", "group.list", "group.history", "group.response.read", "group.member.models",
    "group.members.model", "group.send"];
  for (const method of methods) assert.equal(recordServiceRequestTimeout({ paths: f.paths, method,
    error: Object.assign(timeoutError(), { groupId: "PRIVATE_GROUP", params: { body: "PRIVATE_PROMPT" } }) }), true);
  assert.equal(recordServiceRequestTimeout({ paths: f.paths, method: "group.PRIVATE_METHOD", error: timeoutError() }), true);
  const text = fs.readFileSync(f.target, "utf8"), records = JSON.parse(text).records;
  assert.deepEqual(records.map(record => record.method), [...methods, "other"]);
  assert.doesNotMatch(text, /PRIVATE_|params|groupId/u);
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
});

test("unsafe, corrupt or unavailable diagnostic storage leaves the original request error untouched", t => {
  const f = fixture(t), sentinel = path.join(f.root, "keep");
  fs.writeFileSync(sentinel, "retain", { mode: 0o600 });
  fs.symlinkSync(sentinel, f.target);
  const error = timeoutError();
  assert.equal(recordServiceRequestTimeout({ paths: f.paths, method: "service.status", error }), false);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "retain");
  fs.unlinkSync(f.target);
  fs.writeFileSync(f.target, "invalid previous record", { mode: 0o600 });
  assert.equal(recordServiceRequestTimeout({ paths: f.paths, method: "service.status", error }), false);
  assert.equal(fs.readFileSync(f.target, "utf8"), "invalid previous record");
  assert.equal(error.code, "REQUEST_TIMEOUT");
  assert.equal(recordServiceRequestTimeout({ paths: {}, method: "service.status", error }), false);
});

test("non-local timeouts, invalid timing and arbitrary phases produce no support record", t => {
  const f = fixture(t);
  const rejected = [Object.assign(new Error("remote timeout"), { code: "REQUEST_TIMEOUT" }),
    Object.assign(timeoutError(), { code: "AUTH_FAILED" }), timeoutError({ phase: "PRIVATE_PHASE" }),
    timeoutError({ elapsedMs: NaN }), timeoutError({ timeoutMs: 0 }), timeoutError({ responseBytes: -1 })];
  for (const error of rejected) assert.equal(recordServiceRequestTimeout({ paths: f.paths, method: "service.status", error }), false);
  assert.equal(fs.existsSync(f.target), false);
});
