"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { McpCryptoBroker } = require("../app/agent-service/mcp-crypto-broker");
const { SendLatencyDiagnostics } = require("../app/agent-service/send-latency-diagnostics");
const { NativeChatPreparation } = require("../app/agent-service/native-chat-preparation");
function fixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "send-latency-"));
  const paths = { trustedRoot: root, stateDir: root, mcpAuthPath: path.join(root, "mcp-auth.json"),
    profileDir: path.join(root, "profile"), cacheDir: path.join(root, "cache"), runtimeDir: root };
  const children = [];
  const broker = new McpCryptoBroker({ paths, persistent: true, callerRole: "agent-service",
    executablePath: process.execPath, appRoot: path.resolve(__dirname, ".."), parentEnv: {},
    requestTimeoutMs: mode === "hang" ? 150 : 2000, termGraceMs: 10, killConfirmMs: 1000,
    spawn(_executable, _args, options) {
      const child = spawn(process.execPath, [path.join(__dirname, "fixtures/persistent-crypto-worker.cjs"), ...(mode ? [mode] : [])], options);
      children.push(child); return child;
    },
  }).open({ generation: 1 });
  return { root, paths, children, broker, async close() { await broker.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
test("persistent encryption reuses one real isolated process, remains FIFO and rotates after 128 requests", async () => {
  const f = fixture();
  try {
    const inputs = Array.from({ length: 65 }, (_, i) => `message-${i}`);
    const encrypted = await Promise.all(inputs.map(value => f.broker.encrypt(Buffer.from(value))));
    assert.equal(f.children.length, 1);
    for (let i = 0; i < inputs.length; i++) assert.equal((await f.broker.decrypt(encrypted[i])).toString(), inputs[i]);
    assert.equal(f.children.length, 2);
    assert.equal(f.broker.bufferedPayloadBytes, 0);
    await assert.rejects(f.broker.encrypt(Buffer.from("old"), { generation: 2 }));
  } finally { await f.close(); }
  assert.ok(f.children.every(child => child.exitCode !== null || child.signalCode !== null));
});
for (const mode of ["nonce", "hang"]) test(`persistent worker ${mode} failure blocks queued requests and physically terminates`, async () => {
  const f = fixture(mode);
  try {
    const results = await Promise.allSettled([f.broker.encrypt(Buffer.from("one")), f.broker.encrypt(Buffer.from("two"))]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(f.children.length, 1);
    assert.equal(f.broker.bufferedPayloadBytes, 0);
  } finally { await f.close(); }
});
test("durable timing records correlate spans while omitting input, errors and raw identities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latency-record-"));
  const runtimeDir = path.join(root, "run");
  const log = new SendLatencyDiagnostics({ paths: { runtimeDir, trustedRoot: root } });
  try {
    log.record({ stage: "admission_context", outcome: "success", durationMs: 12.4,
      startedAt: 100, finishedAt: 112, operationId: "private-operation", runId: "private-run", prompt: "PRIVATE USER TEXT" });
    log.record({ stage: "model_secret_local_rejection", outcome: "error", at: 120, durationMs: 15.4, bytes: 256,
      error: "PRIVATE UPSTREAM ERROR", response: "PRIVATE MODEL RESPONSE" });
    await log.close();
    const body = fs.readFileSync(path.join(runtimeDir, "send-latency.json"), "utf8");
    assert.doesNotMatch(body, /private-operation|private-run|PRIVATE USER TEXT|PRIVATE UPSTREAM ERROR|PRIVATE MODEL RESPONSE/u);
    const [row, { generation, version, ...modelFailure }] = JSON.parse(body).records;
    assert.match(row.operationIdHash, /^[a-f0-9]{64}$/); assert.equal(row.startedAt, 100); assert.equal(row.durationMs, 12);
    assert.deepEqual(modelFailure, { stage: "model_secret_local_rejection", outcome: "error", at: 120, durationMs: 15, bytes: 256 });
    log.open(); log.record({ stage: "second", outcome: "success", durationMs: 1 }); await log.close();
    const restarted = JSON.parse(fs.readFileSync(path.join(runtimeDir, "send-latency.json"))).records;
    assert.equal(restarted.length, 3);
    assert.deepEqual(restarted[1], { ...modelFailure, generation, version });
  } finally { await log.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("preparation coalesces, never starts a session/turn and avoids retaining per-Run hosts", async () => {
  let acquired = 0, warmed = 0, memory = 0, valid = true;
  const host = { accountRead: async () => ({ account: {}, requiresOpenaiAuth: true }), modelsList: async () => ({ data: [] }),
    sessionStart() { assert.fail("prewarm created a session"); }, turnStart() { assert.fail("prewarm sent model input"); } };
  const preparation = new NativeChatPreparation({
    resolve: input => ({ profileId: "profile", binding: { runtime: input.runtime || "codex", runtimeProfileId: "native", runtimeAccountId: "account" },
      identity: 1, options: {}, assertCurrent() { if (!valid) throw new Error(); } }),
    warmMemory: () => memory++, runtimeManager: { acquire: async () => { acquired++; return host; }, keepWarm: () => warmed++ },
  });
  const result = await Promise.all([preparation.prepare({ sessionKey: "session" }), preparation.prepare({ sessionKey: "session" })]);
  assert.ok(result.every(row => row.state === "ready")); assert.equal(acquired, 1); assert.equal(warmed, 1);
  await preparation.prepare({ sessionKey: "session", runtime: "pi" }); assert.equal(acquired, 1); assert.equal(memory, 3);
  await preparation.close(); preparation.open(); valid = false;
  assert.equal((await preparation.prepare({ sessionKey: "session" })).state, "unavailable");
  assert.equal(acquired, 1); await preparation.close();
});

test("late prewarm cannot survive account changes or Service restart, and capacity failures do not authorize a turn", async () => {
  for (const change of ["account", "restart", "capacity"]) {
    let release, acquired = 0, warmed = 0, valid = true;
    const gate = new Promise(resolve => { release = resolve; });
    const prep = new NativeChatPreparation({ resolve: () => ({ profileId: "p", binding: { runtime: "codex" },
      assertCurrent() { if (!valid) throw Error("changed"); } }), runtimeManager: {
      acquire: async () => {
        acquired++;
        if (change === "capacity") throw Object.assign(Error(), { code: "RUNTIME_HOST_CAPACITY" });
        return { accountRead: async () => { await gate; return { account: {}, requiresOpenaiAuth: true }; },
          modelsList() { assert.fail("expired preparation read models"); } };
      }, keepWarm: () => warmed++,
    } });
    const result = prep.prepare({ sessionKey: "s" });
    await new Promise(resolve => setImmediate(resolve));
    if (change === "account") valid = false;
    if (change === "restart") { prep.close(); prep.open(); }
    release();
    assert.equal((await result).state, "unavailable");
    assert.equal(acquired, 1); assert.equal(warmed, 0); prep.close(); await prep.drain();
  }
});

test("prewarm has at most two in-flight acquisitions", async () => {
  let release, acquired = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const prep = new NativeChatPreparation({ resolve: input => ({ binding: { runtime: "codex", runtimeProfileId: input.sessionKey },
    assertCurrent() {} }), runtimeManager: { acquire: async () => { acquired++; await gate; throw Error("fixture cleanup"); } } });
  const pending = [prep.prepare({ sessionKey: "a" }), prep.prepare({ sessionKey: "b" })];
  assert.equal((await prep.prepare({ sessionKey: "c" })).state, "busy"); assert.equal(acquired, 2);
  release(); await Promise.all(pending); prep.close();
});

test("V8 samples synchronous Service work, keeping only relative shipped source coordinates", async () => {
  const { createStallSampler, projectSamples } = require("../app/agent-service/service-stall-sampler");
  const sampler = createStallSampler();
  try {
    await sampler.start();
    const { normalize } = require("../app/agent-service/send-latency-diagnostics");
    const end = performance.now() + 350;
    while (performance.now() < end) normalize({ stage: "private", outcome: "success", durationMs: 1, operationId: "never persisted" });
    const samples = await sampler.capture(400);
    assert.ok(samples.some(sample => sample.frames.some(frame => frame.file === "agent-service/send-latency-diagnostics.js")));
    assert.ok(!JSON.stringify(samples).includes("never persisted"));
    const privateProfile = { startTime: 0, endTime: 1000, samples: [1], timeDeltas: [500],
      nodes: [{ id: 1, callFrame: { url: "/Users/private/secret.js", functionName: "SECRET", lineNumber: 0, columnNumber: 0 } }] };
    assert.deepEqual(projectSamples(privateProfile, { durationMs: 10 }), []);
  } finally { sampler.stop(); }
});

test("a recent preparation hit is correlated to the current chat and never reuses a retired host", async () => {
  let acquired = 0, live = true;
  const events = [], host = { accountRead: async () => ({ account: {}, requiresOpenaiAuth: true }), modelsList: async () => ({ data: [] }) };
  const prep = new NativeChatPreparation({ resolve: () => ({ binding: { runtime: "codex" }, identity: 1, assertCurrent() {} }),
    telemetry: { record: (_name, event) => events.push(event) }, runtimeManager: {
      acquireObserved: async () => { acquired++; live = true; return { handle: host, hostState: "created" }; }, peek: () => live ? host : null,
    } });
  await prep.prepare({ sessionKey: "one" }); await prep.prepare({ sessionKey: "two" });
  assert.equal(events[0].hostState, "created");
  assert.equal(acquired, 1); assert.equal(events.at(-1).sessionKey, "two"); assert.equal(events.at(-1).hostState, "reused");
  live = false; await prep.prepare({ sessionKey: "three" }); assert.equal(acquired, 2);
  prep.close();
});

test("persistent pipe frames survive fragmentation and reject invalid sizes without retaining payload", () => {
  const { FrameReader, frame, MAX_FRAME } = require("../app/agent-service/crypto-worker-channel");
  let failures = 0; const seen = [], bodies = [];
  const reader = new FrameReader(body => { seen.push(body.toString()); bodies.push(body); }, () => failures++);
  const encoded = frame(Buffer.from("synthetic frame"));
  for (let offset = 0; offset < encoded.length; offset += 3) reader.push(encoded.subarray(offset, offset + 3));
  assert.deepEqual(seen, ["synthetic frame"]); assert.ok(bodies[0].every(byte => byte === 0));
  const invalid = Buffer.alloc(4); invalid.writeUInt32BE(MAX_FRAME + 1); reader.push(invalid);
  assert.equal(failures, 1); assert.equal(reader.bytes.length, 0);
  reader.push(encoded); assert.equal(seen.length, 1);
});

test("send-path spans survive tool loops and fold into one compact row per send", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "latency-turns-"));
  const runtimeDir = path.join(root, "run");
  const read = name => JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"));
  const log = new SendLatencyDiagnostics({ paths: { runtimeDir, trustedRoot: root } });
  const T = Date.now() - 60_000; // Absolute times inside the 14-day window.
  try {
    log.record({ stage: "controller", outcome: "success", durationMs: 0, startedAt: T + 1000, finishedAt: T + 1000, operationId: "op-1", sessionKey: "s" });
    for (let i = 0; i < 3; i++) log.record({ stage: "admission_context", outcome: "success", durationMs: 1500,
      startedAt: T + 1100 + i * 2600, finishedAt: T + 2600 + i * 2600, operationId: "op-1", runId: "run-1" });
    log.record({ stage: "admission_queued", outcome: "success", durationMs: 0, startedAt: T + 2600, finishedAt: T + 2600, runId: "run-1", code: "WORKSPACE_WRITE_BUSY" });
    log.record({ stage: "admission_queued", outcome: "success", durationMs: 0, startedAt: T + 2700, finishedAt: T + 2700, runId: "run-1", code: "PRIVATE_FREE_FORM" });
    log.record({ stage: "memory_recall_cache", outcome: "success", durationMs: 0, startedAt: T + 2800, finishedAt: T + 2800, runId: "run-1", code: "HIT" });
    log.record({ stage: "runtime_host", outcome: "success", durationMs: 0, startedAt: T + 9000, finishedAt: T + 9000, runId: "run-1",
      operationId: "op-1", source: "codex", hostState: "created" });
    for (let i = 0; i < 3000; i++) log.record({ stage: "tool_execution", outcome: "success", durationMs: 1, runId: "run-1", operationId: "op-1" });
    log.record({ stage: "crypto_encrypt", outcome: "success", durationMs: 2 });
    await log.close();
    const records = read("send-latency.json").records;
    assert.ok(records.every(row => !/^(?:tool_execution|crypto_)/u.test(row.stage)));
    assert.equal(records.filter(row => row.stage === "admission_context").length, 3);
    assert.deepEqual(records.filter(row => row.stage === "admission_queued").map(row => row.code), ["WORKSPACE_WRITE_BUSY", "OTHER"]);
    const activity = read("send-latency-activity.json").records;
    assert.ok(activity.length > 0 && activity.length <= 1024);
    assert.ok(activity.every(row => /^(?:tool_execution|crypto_)/u.test(row.stage)));
    let turns = read("send-latency-turns.json").turns;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].startedAt, T + 1000); assert.equal(turns[0].hostState, "created"); assert.equal(turns[0].source, "codex");
    assert.match(turns[0].operationIdHash, /^[a-f0-9]{64}$/u); assert.match(turns[0].runIdHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(turns[0].stages.admission_context, [100, 4500, 3, 6800]);
    assert.deepEqual(turns[0].stages.admission_queued, [1600, 0, 2, 1700, null, ["WORKSPACE_WRITE_BUSY", "OTHER"]]);
    assert.deepEqual(turns[0].stages.memory_recall_cache, [1800, 0, 1, 1800, null, ["HIT"]]);
    assert.equal(turns[0].stages.tool_execution, undefined);
    const body = ["send-latency.json", "send-latency-turns.json", "send-latency-activity.json"]
      .map(name => fs.readFileSync(path.join(runtimeDir, name), "utf8")).join("\n");
    assert.doesNotMatch(body, /op-1|run-1|PRIVATE_FREE_FORM/u);
    // A restarted writer resumes the same row; an earlier span re-bases offsets.
    log.open();
    log.record({ stage: "first_text", outcome: "success", durationMs: 4000, startedAt: T + 900, finishedAt: T + 13_000, operationId: "op-1" });
    await log.close();
    turns = read("send-latency-turns.json").turns;
    assert.equal(turns.length, 1); assert.equal(turns[0].startedAt, T + 900);
    assert.deepEqual(turns[0].stages.admission_context, [200, 4500, 3, 6900]);
    assert.deepEqual(turns[0].stages.first_text, [0, 4000, 1, 12_100]);
  } finally { await log.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("turn summaries keep 14 days and a bounded count, and reloads accept only the closed shape", () => {
  const { foldTurns, sanitizeTurn, TURN_MAX, TURN_MAX_AGE_MS } = require("../app/agent-service/send-latency-diagnostics");
  const crypto = require("node:crypto");
  const generation = crypto.randomUUID(), now = 100 * 86_400_000;
  const stale = { operationIdHash: "a".repeat(64), startedAt: 1, updatedAt: now - TURN_MAX_AGE_MS - 1, generation, version: "v", stages: {} };
  const rows = Array.from({ length: TURN_MAX + 5 }, (_, index) => ({ stage: "controller", outcome: "success", durationMs: 0,
    startedAt: now - 1000, generation, version: "v", operationIdHash: crypto.createHash("sha256").update(String(index)).digest("hex") }));
  const turns = foldTurns([stale], rows, now);
  assert.equal(turns.length, TURN_MAX);
  assert.ok(!turns.includes(stale));
  assert.equal(sanitizeTurn({ ...stale, operationIdHash: "raw-operation-id" }), null);
  assert.deepEqual(sanitizeTurn({ ...stale, stages: { admission_queued: [1, 2, 3, 4, "error", ["WORKSPACE_WRITE_BUSY", "PRIVATE"]],
    "bad stage": [1, 2, 3, 4], negative: [-1, 2, 3, 4] } }).stages, { admission_queued: [1, 2, 3, 4, "error", ["WORKSPACE_WRITE_BUSY"]] });
});

test("chat prewarm derives the same Codex host options as turn execution", () => {
  const { codexHostAcquireOptions, routeModelProvider } = require("../app/agent-service/codex-session-provider");
  const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
  const providers = { "provider-chatgpt": { id: "provider-chatgpt", kind: "chatgpt" } };
  const productStore = { getModelProvider: id => providers[id] || null, getAgentProfile: () => ({ providerRef: null }) };
  const bundled = { runtime: "codex", runtimeAccountId: SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, profileId: "p",
    provider: { providerRef: "provider-chatgpt" } };
  // The prewarm contract only carries the frozen route, Binding and Profile;
  // the turn contract has many more fields but the same route.
  const turnContract = { ...bundled, permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" }, workspace: "/w" };
  const secrets = {};
  assert.deepEqual(codexHostAcquireOptions({ productStore, temporarySecrets: secrets, contract: bundled }), { modelSecretProviderKind: "chatgpt" });
  assert.deepEqual(codexHostAcquireOptions({ productStore, temporarySecrets: secrets, contract: bundled }),
    codexHostAcquireOptions({ productStore, temporarySecrets: secrets, contract: turnContract }));
  assert.deepEqual(codexHostAcquireOptions({ productStore, temporarySecrets: null, contract: bundled }), {});
  assert.deepEqual(codexHostAcquireOptions({ productStore, temporarySecrets: secrets,
    contract: { ...bundled, runtimeAccountId: "native-codex-default-v1" } }), {});
  assert.equal(routeModelProvider(productStore, { ...bundled, provider: undefined }).kind, "chatgpt");
  assert.equal(routeModelProvider(productStore, { ...bundled, runtime: "pi" }), undefined);
});
