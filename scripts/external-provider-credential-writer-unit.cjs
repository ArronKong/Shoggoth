"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { createExternalProviderWriterVerifier } = require("../app/agent-service/external-provider-credential-writer");
const tests = [], test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const processStart = pid => { const value = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1500 });
  assert.equal(value.status, 0); assert.equal(value.error, undefined); return value.stdout.trim(); };
async function fixture(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sgh-credential-writer-unit-")); fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state"), dataRoot = path.join(stateDir, "external-plugin-host-data", "openclaw", "v1");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const runtimeRoot = path.join(root, "runtime"); fs.mkdirSync(runtimeRoot, { mode: 0o700 }); fs.writeFileSync(path.join(runtimeRoot, "openclaw.mjs"), "// bounded schema fixture\n", { mode: 0o444 });
  const input = { backendId: "openclaw", providerKey: "fixture", baseUrl: "https://model.invalid/v1", api: "openai-completions",
    operationId: "writer-unit-original", requestDigest: "7".repeat(64) };
  const writer = { version: 1, backendId: "openclaw", operationId: input.operationId, requestDigest: input.requestDigest,
    pid: process.pid, startIdentity: processStart(process.pid), nonce: "a".repeat(64), generation: "fixture-generation",
    runtimeRoot, runtimeTreeSha256: "b".repeat(64), dataRoot, interpreterPath: fs.realpathSync(process.execPath),
    entryPath: path.join(runtimeRoot, "openclaw.mjs"), expiresAt: Date.now() + 120000 };
  const state = { current: true, runtimeCurrent: true, runtimeChecks: 0, connects: 0, statusRequests: 0, messages: [],
    proofPatch: {}, beforeStatus: null, statusBarrier: null };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 65536 }); await once(wss, "listening");
  const token = "c".repeat(64), controlToken = "d".repeat(64), port = wss.address().port;
  const write = (name, data) => fs.writeFileSync(path.join(dataRoot, name), JSON.stringify(data) + "\n", { mode: 0o600 });
  const config = { gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } } };
  const publish = () => {
    write("owner-root.json", { version: 1, backendId: "openclaw", rootId: "fixture-owned-root" });
    write("writer.fence", { version: 1, nonce: writer.nonce, operationId: "activation-original", runtimeRoot });
    write("managed-control.json", { version: 1, protocol: "openclaw-managed-v1", backendId: "openclaw", nonce: writer.nonce,
      operationId: "activation-original", runtimeRoot, runtimeTreeSha256: writer.runtimeTreeSha256, dataRoot, controlToken });
    write("openclaw.json", config);
  }; publish();
  wss.on("connection", (socket, request) => {
    assert.equal(request.headers.origin, "http://127.0.0.1");
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture-challenge" } }));
    socket.on("message", async raw => {
      const frame = JSON.parse(raw); state.messages.push(frame.method);
      if (frame.method === "connect") {
        const p = frame.params, publicBytes = Buffer.from(p.device.publicKey, "base64url");
        const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]), format: "der", type: "spki" });
        assert.equal(p.auth.token, token); assert.equal(p.device.nonce, "fixture-challenge");
        assert.equal(p.device.id, crypto.createHash("sha256").update(publicBytes).digest("hex"));
        const payload = ["v2", p.device.id, p.client.id, p.client.mode, p.role, p.scopes.join(","), String(p.device.signedAt), token, p.device.nonce].join("|");
        assert.equal(crypto.verify(null, Buffer.from(payload), key, Buffer.from(p.device.signature, "base64url")), true);
        state.connects++; socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } })); return;
      }
      assert.equal(frame.method, "gateway.shoggoth.managed.status");
      assert.deepEqual(Object.keys(frame.params), ["version", "controlToken", "nonce", "operationId", "deadlineAt", "generation"]);
      assert.equal(frame.params.controlToken, controlToken); assert.equal(frame.params.nonce, writer.nonce);
      assert.equal(frame.params.operationId, input.operationId); assert.equal(frame.params.generation, writer.generation);
      assert(frame.params.deadlineAt > Date.now() && frame.params.deadlineAt <= Date.now() + 60000);
      state.statusRequests++;
      state.beforeStatus?.();
      if (state.statusBarrier) { state.statusBarrier.entered.resolve(); await state.statusBarrier.resume.promise; }
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { version: 1, protocol: "openclaw-managed-v1", backendId: "openclaw",
        pid: writer.pid, nonce: writer.nonce, generation: writer.generation, runtimeRoot, runtimeTreeSha256: writer.runtimeTreeSha256,
        dataRoot, paused: true, operationId: input.operationId, selectionSupported: true, snapshot: { idle: true, counts: { totalActive: 0 } }, ...state.proofPatch } }));
    });
  });
  const verifier = createExternalProviderWriterVerifier({ paths: { stateDir }, resourcesRoot: path.resolve(__dirname, "../resources/external-plugin-host-patches"),
    verifyRuntime: async () => { state.runtimeChecks++; return () => state.runtimeCurrent; }, ...extra });
  const context = phase => ({ scope: input, phase, assertCurrent: () => state.current });
  const verify = (phase = "read", replacement = writer, additional = {}) => verifier.verify(replacement, { ...context(phase), ...additional });
  const close = async () => { state.statusBarrier?.resume.resolve(); await verifier.close();
    for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, stateDir, dataRoot, runtimeRoot, input, writer, state, config, write, publish, verifier, context, verify, close, wss };
}
const reject = (task, code) => assert.rejects(task, error => code === undefined || error.code === code);

test("actual PID/start, executable and listener ownership with signed challenge, fixed control proof and private file roots", async () => {
  const f = await fixture(); try { const guard = await f.verify(); assert.equal(guard(), true); await f.verify("assert");
    assert.equal(f.state.connects, 2); assert.equal(f.state.statusRequests, 2); assert.equal(f.state.runtimeChecks, 2);
    assert.deepEqual(f.state.messages, ["connect", "gateway.shoggoth.managed.status", "connect", "gateway.shoggoth.managed.status"]);
  } finally { await f.close(); }
});

test("a real unrelated PID cannot borrow the actual listener or pinned executable", async () => {
  const f = await fixture(), child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try { await once(child, "spawn"); const startIdentity = processStart(child.pid);
    await reject(f.verify("read", { ...f.writer, pid: child.pid, startIdentity }), "EXTERNAL_PROVIDER_WRITER_SOCKET_UNVERIFIED");
    assert.equal(f.state.statusRequests, 0);
  } finally { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; await f.close(); }
});

test("the declared interpreter must be the process executable", async () => {
  const f = await fixture(); try { await reject(f.verify("read", { ...f.writer, interpreterPath: "/bin/ls" }), "EXTERNAL_PROVIDER_WRITER_EXECUTABLE_CHANGED");
    assert.equal(f.state.statusRequests, 0);
  } finally { await f.close(); }
});

test("physical owner and operation cannot be supplied by malformed/accessor/prototype/extra/path-escaped data", async () => {
  const f = await fixture(); try {
    let accessed = 0; const getter = { ...f.writer }; Object.defineProperty(getter, "pid", { enumerable: true, get() { accessed++; return process.pid; } });
    for (const writer of [getter, Object.create(f.writer), { ...f.writer, capability: "claimed" }, { ...f.writer, pid: "1" },
      { ...f.writer, expiresAt: Date.now() - 1 }, { ...f.writer, entryPath: path.join(f.root, "other.mjs") }]) await reject(f.verify("read", writer));
    await reject(f.verify("read", { ...f.writer, dataRoot: f.root }), "EXTERNAL_PROVIDER_WRITER_SCOPE_MISMATCH");
    await reject(f.verify("read", { ...f.writer, operationId: "foreign-original" }), "EXTERNAL_PROVIDER_WRITER_SCOPE_MISMATCH");
    assert.equal(accessed, 0); assert.equal(f.state.statusRequests, 0);
  } finally { await f.close(); }
});

for (const mode of ["symlink", "hardlink", "permissions", "descriptor-nonce", "fence-root", "gateway-remote", "marker"]) {
  test("canonical private FS rejects " + mode + " before a Gateway request", async () => {
    const f = await fixture(); try {
      const file = path.join(f.dataRoot, "managed-control.json");
      if (mode === "symlink") { fs.renameSync(file, file + ".saved"); fs.symlinkSync(file + ".saved", file); }
      if (mode === "hardlink") fs.linkSync(file, file + ".alias");
      if (mode === "permissions") fs.chmodSync(file, 0o644);
      if (mode === "descriptor-nonce") { const value = JSON.parse(fs.readFileSync(file)); value.nonce = "e".repeat(64); f.write("managed-control.json", value); }
      if (mode === "fence-root") f.write("writer.fence", { version: 1, nonce: f.writer.nonce, operationId: "activation-original", runtimeRoot: f.root });
      if (mode === "gateway-remote") { f.config.gateway.bind = "lan"; f.write("openclaw.json", f.config); }
      if (mode === "marker") f.write("owner-root.json", { version: 1, backendId: "hermes", rootId: "fixture-owned-root" });
      await reject(f.verify()); assert.equal(f.state.statusRequests, 0);
    } finally { await f.close(); }
  });
}

test("exact status identity, pause, idle, operation and provider selection proof rejects spoofed results", async () => {
  const f = await fixture(); try {
    for (const patch of [{ pid: process.pid + 1 }, { nonce: "e".repeat(64) }, { generation: "foreign-generation" },
      { runtimeRoot: f.root }, { runtimeTreeSha256: "f".repeat(64) }, { dataRoot: f.root }, { paused: false },
      { operationId: "foreign-original" }, { selectionSupported: false }, { snapshot: { idle: true, counts: { totalActive: 1 } } }]) {
      f.state.proofPatch = patch; await reject(f.verify());
    }
    assert.equal(f.state.statusRequests, 10);
  } finally { await f.close(); }
});

test("post-await file/root/runtime/current retirement cannot publish a private authority", async () => {
  for (const mode of ["current", "runtime", "descriptor", "data-root"]) {
    const f = await fixture(); try {
      f.state.beforeStatus = () => {
        if (mode === "current") f.state.current = false;
        if (mode === "runtime") f.state.runtimeCurrent = false;
        if (mode === "descriptor") f.write("managed-control.json", { version: 1 });
        if (mode === "data-root") { fs.renameSync(f.dataRoot, f.dataRoot + ".old"); fs.mkdirSync(f.dataRoot, { mode: 0o700 }); }
      };
      await reject(f.verify());
    } finally { await f.close(); }
  }
});

test("a captured guard retires after later private path/config/process authority changes", async () => {
  const f = await fixture(); try {
    const guard = await f.verify(); assert.equal(guard(), true);
    f.config.gateway.port++; f.write("openclaw.json", f.config); assert.throws(guard);
    f.verifier.close(); assert.throws(guard);
  } finally { await f.close(); }
});

test("advancing cannot treat an alive old process as absent; known exact old exit permits only a distinct new paused owner", async () => {
  const f = await fixture(), child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(child, "spawn"); const previous = { ...f.writer, pid: child.pid, startIdentity: processStart(child.pid), nonce: "e".repeat(64), generation: "old-generation" };
    await reject(f.verify("advance", f.writer, { previousWriter: previous }), "EXTERNAL_PROVIDER_PREVIOUS_WRITER_NOT_EXITED");
    assert.equal(f.state.statusRequests, 0);
    const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
    assert.equal((await f.verify("advance", f.writer, { previousWriter: previous }))(), true);
    await reject(f.verify("advance", f.writer, { previousWriter: f.writer }), "EXTERNAL_PROVIDER_WRITER_ADVANCE_INVALID");
  } finally { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; } await f.close(); }
});

test("terminal settle requires resumed exact writer; unknown requires same original paused operation", async () => {
  const f = await fixture(); try {
    await reject(f.verify("settle", f.writer, { outcome: "applied" }), "EXTERNAL_PROVIDER_WRITER_RESUME_UNVERIFIED");
    f.state.proofPatch = { paused: false, operationId: null };
    assert.equal((await f.verify("settle", f.writer, { outcome: "applied" }))(), true);
    await reject(f.verify("settle", f.writer, { outcome: "needs_verification" }), "EXTERNAL_PROVIDER_WRITER_NOT_PAUSED");
  } finally { await f.close(); }
});

test("terminal readonly proof uses signed actual paused or resumed state of the same writer without issuing mutations", async () => {
  const f = await fixture(); try {
    for (const outcome of ["applied", "compensated", "blocked"]) {
      assert.equal((await f.verify("terminal-observe", f.writer, { outcome, writerState: "paused" }))(), true);
      await reject(f.verify("terminal-observe", f.writer, { outcome, writerState: "resumed" }), "EXTERNAL_PROVIDER_WRITER_RESUME_UNVERIFIED");
      f.state.proofPatch = { paused: false, operationId: null };
      assert.equal((await f.verify("terminal-observe", f.writer, { outcome, writerState: "resumed" }))(), true);
      await reject(f.verify("terminal-observe", f.writer, { outcome, writerState: "paused" }), "EXTERNAL_PROVIDER_WRITER_NOT_PAUSED");
      f.state.proofPatch = {};
    }
    for (const extra of [{ outcome: "needs_verification", writerState: "paused" }, { outcome: "applied", writerState: "claimed" },
      { outcome: "applied" }, { writerState: "paused" }]) await reject(f.verify("terminal-observe", f.writer, extra), "EXTERNAL_PROVIDER_WRITER_CONTEXT_INVALID");
    assert.equal(f.state.statusRequests, 12); assert.ok(f.state.messages.every(method =>
      ["connect", "gateway.shoggoth.managed.status"].includes(method)));
  } finally { await f.close(); }
});

test("production code attestation refuses an unsealed runtime; a caller path is not a fixed candidate", async () => {
  const f = await fixture({ verifyRuntime: undefined }); try {
    await reject(f.verify(), "EXTERNAL_PROVIDER_RUNTIME_UNBOUND"); assert.equal(f.state.statusRequests, 0);
  } finally { await f.close(); }
});

async function main() {
  const passed = []; for (const { name, run } of tests) { await run(); passed.push(name); }
  process.stdout.write(JSON.stringify({ status: "PASS", groups: passed.length, cases: passed,
    boundary: "real private FS, OS PID/start/executable/listener and signed loopback WebSocket; runtime positive uses a controlled attestation callback, not an actual OpenClaw Host or model", hostStarts: 0, modelRequests: 0, secretReads: 0 }) + "\n");
}
main().catch(error => { process.stderr.write((error.code || "FIXTURE_ASSERTION_FAILED") + "\n" + error.stack + "\n"); process.exitCode = 1; });
