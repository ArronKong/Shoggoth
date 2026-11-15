"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { parseArgs } = require("node:util");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { waitUntil } = require("./fixtures/runtime-bridge-harness.cjs");
const { PROTOCOL_VERSION } = require("../app/agent-service/server");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { transcriptEventId } = require("../app/agent-service/transcript-store");
const { MAX_FRAME_BYTES } = require("../app/agent-service/chat-service-protocol");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createLocalFileSafeStorage } = require("../app/agent-service/local-file-safe-storage");
const { InProcessMcpCryptoBroker } = require("../app/agent-service/mcp-crypto-broker");
const { IDEMPOTENCY_WINDOW_MS, MAX_ACTIVE_COMMANDS, MAX_PENDING_COMMAND_FILE_BYTES,
  RECOVERABLE_PENDING_COMMAND_INBOX_VERSION } = require("../app/agent-service/pending-command-inbox");

// Profile/session creation and Service startup happen before the timer.
// The transport never reaches a Runtime. Crypto uses an isolated local store
// or an injected broker. This benchmark excludes external Keychain IPC.

const percent = (items, percentile) => Number(items[Math.ceil(items.length * percentile / 100) - 1].toFixed(2));
const LOOP_TRACE_INTERVAL_MS = 5;
const LOOP_TRACE_THRESHOLD_MS = 100;
const LOOP_TRACE_LIMIT = 8;
const capacityError = "CHAT_SESSION_CAPACITY";

function localCrypto() {
  const key = crypto.randomBytes(32);
  return {
    async open() {}, async close() {},
    encryptedBytes: bytes => bytes + 28,
    async encrypt(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    async decrypt(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    },
  };
}

async function seedInbox(file, scenario, count, encrypt) {
  if (scenario !== "near-count" && scenario !== "near-bytes") return;
  // A v1 command with no matching WorkRun is intentionally left unresolved on
  // recovery. These recovered records occupy real capacity without dispatching.
  const createdAt = Date.now();
  const rowCount = scenario === "near-count" ? MAX_ACTIVE_COMMANDS - count - 1 : 192;
  const prompt = scenario === "near-count" ? "Recovered command" : "x".repeat(61 * 1024);
  const activeCommands = Object.fromEntries(Array.from({ length: rowCount }, () => {
    const operationId = `seed-${crypto.randomUUID()}`;
    return [operationId, { operationId, runId: crypto.randomUUID(), sessionKey: crypto.randomUUID(),
      prompt, createdAt, state: "pending" }];
  }));
  const plaintext = Buffer.from(JSON.stringify({ idempotencyFloorMs: createdAt - IDEMPOTENCY_WINDOW_MS,
    activeCommands, tombstones: {} }));
  const ciphertext = await encrypt(plaintext);
  const serialized = `${JSON.stringify({ version: RECOVERABLE_PENDING_COMMAND_INBOX_VERSION,
    revision: 1, ciphertext: ciphertext.toString("base64") })}\n`;
  assert.ok(Buffer.byteLength(serialized) < MAX_PENDING_COMMAND_FILE_BYTES);
  if (scenario === "near-bytes") assert.ok(Buffer.byteLength(serialized) > MAX_PENDING_COMMAND_FILE_BYTES * 0.95);
  fs.writeFileSync(file, serialized, { mode: 0o600, flag: "wx" });
}

function summarize(values) {
  values.sort((left, right) => left - right);
  return { p50: percent(values, 50), p95: percent(values, 95), p99: percent(values, 99),
    max: Number(values.at(-1).toFixed(2)) };
}

async function run(method, concurrency, count, requestedPayloadBytes, cryptoMode, profilePhases, scenario) {
  const latency = new Map();
  const traceSamples = [], loopGaps = [];
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/shg-ack-benchmark-"));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: `${root}/state`,
    cacheRoot: `${root}/cache`, profileRoot: `${root}/profile` });
  let f;
  const delay = monitorEventLoopDelay({ resolution: 5 });
  let release, releaseWrite, loopTrace;
  try {
    fs.mkdirSync(paths.stateDir, { mode: 0o700 });
    const safeStorage = cryptoMode === "local-file" ? createLocalFileSafeStorage({ paths }) : null;
    const broker = cryptoMode === "local-file" ? new InProcessMcpCryptoBroker({ paths, callerRole: "agent-service",
      safeStorage, ownsSafeStorage: true })
      : cryptoMode === "local-aes-gcm" ? localCrypto() : null;
    const inboxFile = `${paths.stateDir}/pending-commands.json`;
    const encryptSeed = safeStorage ? value => safeStorage.encryptString(value.toString("utf8"))
      : broker ? broker.encrypt : value => value;
    await seedInbox(inboxFile, scenario, count, encryptSeed);
    f = await openHandoffFixture({ root, serviceOptions: { memoryCore: false, durableChatAcceptance: true,
      ...(profilePhases ? { sendLatencyDiagnostics: { async close() {}, record(sample) {
        if (!sample.operationId?.startsWith("probe-")) return;
        const phases = latency.get(sample.operationId) || {};
        phases[sample.stage] = (phases[sample.stage] || 0) + sample.durationMs;
        latency.set(sample.operationId, phases);
      } } } : {}),
      ...(broker ? { cryptoBroker: broker } : {}) } });
    const { service, transport } = f;
    const inbox = service.pendingCommandInbox;
    assert.equal(inbox.filePath, inboxFile);
    const inboxBefore = fs.existsSync(inboxFile) ? fs.statSync(inboxFile).size : 0;
    const activeBefore = inbox.list().length;
    let prepared = 0;
    const gate = new Promise(resolve => { release = resolve; });
    service.contextCompiler.semanticSearch ||= {};
    service.contextCompiler.prepareRelated = async () => { prepared++; await gate; };
    const timing = [], inputs = [], rejected = [], rejectedTiming = [];
    const token = readClientToken(paths);
    const config = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...config, revision: config.revision + 1, maxActive: 32, startupConcurrency: 8,
      flags: { ...config.flags, runtimeAdmissionV1: true } });
    const request = (method, params) => ({ token, version: PROTOCOL_VERSION, method, params, id: crypto.randomUUID() });
    const fetch = (method, params) => requestService(paths, request(method, params),
      { timeoutMs: scenario === "near-bytes" ? 60_000 : 15_000 });
    const sessions = Array.from({ length: count }, () => f.createSession());
    const makeOperation = (session, bytes) => ({ operationId: `probe-${crypto.randomUUID()}`,
      sessionKey: session.sessionKey, prompt: "x".repeat(bytes), createdAt: Date.now() });
    const maxPayload = MAX_FRAME_BYTES - Buffer.byteLength(`${JSON.stringify(request(method, makeOperation(sessions[0], 0)))}\n`);
    const payloadBytes = scenario === "near-bytes" || scenario === "max-payload" ? maxPayload : requestedPayloadBytes;
    const verifyUnadmitted = (session, op) => {
      assert.equal(inbox.get(op.operationId), null);
      assert.equal(service.workRunCoordinator.getChatRunByOperation(op.operationId, session.sessionKey), null);
      assert.equal(service.transcriptStore.listEvents(session.profileId, session.id)
        .some(event => event.content?.operationId === op.operationId), false);
    };

    let fencedInput = null, completedWriteRevision = inbox.revision;
    if (scenario !== "warm") {
      // Hold only the first real worker write. The exact request and RPC
      // remain unresolved while Service is responsive and the file is unchanged.
      const { promise: entered, resolve: markEntered } = Promise.withResolvers();
      const hold = new Promise(resolve => { releaseWrite = resolve; });
      const writer = inbox.fileWriter;
      const realWrite = writer.write.bind(writer);
      let holdFirstWrite = true;
      writer.write = async envelope => {
        if (holdFirstWrite) {
          holdFirstWrite = false;
          markEntered();
          await hold;
        }
        const result = await realWrite(envelope);
        completedWriteRevision = envelope.revision;
        return result;
      };
      const session = f.createSession();
      const op = makeOperation(session, payloadBytes);
      let acknowledged = false;
      const sending = fetch(method, op).then(receipt => { acknowledged = true; return receipt; });
      await Promise.race([entered, sending.then(() => assert.fail("ACK arrived before entering durable write"))]);
      try {
        await fetch("service.status", {});
        assert.equal(acknowledged, false, "ACK arrived before durable write");
        verifyUnadmitted(session, op);
        assert.equal(fs.existsSync(inboxFile) ? fs.statSync(inboxFile).size : 0, inboxBefore);
      } finally { releaseWrite(); }
      const ack = await sending;
      assert.equal(inbox.revision, completedWriteRevision);
      assert.equal(ack.operationId, op.operationId);
      assert.equal(ack.sessionKey, session.sessionKey);
      fencedInput = { session, op, runId: ack.runId };
    }

    delay.enable();
    // The monotonic origin lets an isolated CPU profile be correlated with
    // the exact observed request and event-loop interval.
    const traceOriginUs = profilePhases ? Number(process.hrtime.bigint() / 1000n) : null;
    const traceStart = performance.now();
    if (profilePhases) {
      let previous = traceStart;
      loopTrace = setInterval(() => {
        const current = performance.now();
        const gap = current - previous;
        if (gap >= LOOP_TRACE_THRESHOLD_MS) {
          loopGaps.push({ from: previous - traceStart, to: current - traceStart, gap });
          loopGaps.sort((left, right) => right.gap - left.gap);
          if (loopGaps.length > LOOP_TRACE_LIMIT) loopGaps.pop();
        }
        previous = current;
      }, LOOP_TRACE_INTERVAL_MS);
      loopTrace.unref();
    }
    await fetch("service.status", {});
    for (let start = 0; start < count; start += concurrency) {
      await Promise.all(sessions.slice(start, start + concurrency).map(async (session, index) => {
        const op = makeOperation(session, payloadBytes);
        const started = performance.now();
        let ack;
        try { ack = await fetch(method, op); }
        catch (error) {
          if (scenario !== "near-bytes" || error.code !== capacityError) throw error;
          rejectedTiming.push(performance.now() - started);
          verifyUnadmitted(session, op);
          rejected.push({ session, op });
          return;
        }
        const received = performance.now();
        timing.push(received - started);
        if (profilePhases) traceSamples.push({ sample: start + index + 1, operationId: op.operationId,
          from: started - traceStart, to: received - traceStart, duration: received - started });
        const runId = method === "chat.send.accept" ? ack.runId : ack.run.id;
        if (method === "chat.send.accept") {
          assert.deepEqual(Object.keys(ack).sort(), ["acceptedAt", "operationId", "runId", "sessionKey", "version"]);
          assert.equal(ack.version, 1);
          assert.equal(ack.operationId, op.operationId);
          assert.equal(ack.sessionKey, op.sessionKey);
          assert.ok(Number.isSafeInteger(ack.acceptedAt));
        } else {
          assert.equal(ack.disposition, "queued");
          assert.equal(ack.run.status, "queued");
        }
        const command = inbox.get(op.operationId);
        assert.equal(command?.runId, runId);
        assert.equal(command?.sessionKey, session.sessionKey);
        if (scenario !== "warm") assert.equal(inbox.revision, completedWriteRevision);
        inputs.push({ session, op, runId });
      }));
    }
    delay.disable();
    clearInterval(loopTrace);
    assert.equal(timing.length + rejected.length, count);
    assert.ok(timing.length > 0);
    const ackMs = summarize(timing);
    if (scenario === "near-count" || scenario === "max-payload") {
      const session = f.createSession();
      const op = makeOperation(session, payloadBytes + (scenario === "max-payload" ? 1 : 0));
      const code = scenario === "max-payload" ? "CHAT_SEND_TOO_LARGE" : capacityError;
      await assert.rejects(fetch(method, op), { code });
      verifyUnadmitted(session, op);
      rejected.push({ session, op });
      if (scenario === "near-count") assert.equal(inbox.list().length, MAX_ACTIVE_COMMANDS);
    }
    if (scenario === "near-bytes") {
      assert.ok(rejected.length > 0, "fixture must reach the byte ceiling");
      assert.ok(fs.statSync(inboxFile).size >= MAX_PENDING_COMMAND_FILE_BYTES * 0.99);
    }
    const accepted = fencedInput ? [...inputs, fencedInput] : inputs;
    if (scenario !== "warm") {
      assert.equal(inbox.list().length, activeBefore + accepted.length);
      const { ciphertext } = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
      const encrypted = Buffer.from(ciphertext, "base64");
      const plaintext = broker ? await broker.decrypt(encrypted) : encrypted;
      const { activeCommands } = JSON.parse(plaintext.toString("utf8"));
      for (const { op, runId } of accepted) {
        assert.equal(activeCommands[op.operationId]?.runId, runId);
        assert.equal(activeCommands[op.operationId]?.prompt, op.prompt);
      }
      for (const { op } of rejected) assert.equal(activeCommands[op.operationId], undefined);
    }
    const awaitingProjection = new Set(accepted);
    await waitUntil(() => {
      for (const input of awaitingProjection) {
        const { session, op, runId } = input;
        if (!service.productStore.getWorkRun(runId)) continue;
        const event = service.transcriptStore.getEvent(session.profileId, session.id, transcriptEventId("chat-user", op.operationId));
        if (event?.runId === runId && event.kind === "user" && event.content.operationId === op.operationId) {
          awaitingProjection.delete(input);
        }
      }
      return awaitingProjection.size === 0;
    }, `accepted Runs and user events to project after ${method} level ${concurrency} (ACK ms ${JSON.stringify(ackMs)})`, 15000);
    assert.ok(prepared > 0);
    assert.equal([...transport.handles.values()].reduce((n, h) => n + h.host.turnStartCalls, 0), 0);
    for (const { session, op, runId } of accepted) {
      const run = service.productStore.getWorkRun(runId);
      assert.equal(run.status, "queued");
      const match = service.transcriptStore.listEvents(session.profileId, session.id, { runId: run.id })
        .filter(event => event.kind === "user" && event.content.operationId === op.operationId);
      assert.equal(match.length, 1);
    }
    assert.equal(new Set(accepted.map(item => item.runId)).size, accepted.length);
    for (const { session, op } of rejected) verifyUnadmitted(session, op);
    const selected = inputs[Math.floor(inputs.length / 2)];
    const recovered = await fetch("chat.operation.get", { sessionKey: selected.op.sessionKey, operationId: selected.op.operationId });
    assert.equal(recovered?.run.id, selected.runId);
    const acceptedPhases = inputs.map(({ op }) => latency.get(op.operationId)).filter(Boolean);
    const phaseNames = new Set(acceptedPhases.flatMap(phases => Object.keys(phases)));
    const servicePhaseP95Ms = Object.fromEntries([...phaseNames].map(name => {
      const durations = acceptedPhases.flatMap(phases => Number.isFinite(phases[name]) ? [phases[name]] : [])
        .sort((left, right) => left - right);
      return [name, percent(durations, 95)];
    }));
    const ms = value => Number(value.toFixed(2));
    const slowest = (profilePhases ? traceSamples.slice().sort((left, right) => right.duration - left.duration)
      .slice(0, LOOP_TRACE_LIMIT) : []).map(sample => ({ sample: sample.sample, sentMs: ms(sample.from),
      receivedMs: ms(sample.to), ackMs: ms(sample.duration),
      servicePhasesMs: Object.fromEntries(Object.entries(latency.get(sample.operationId) || {})
        .map(([name, duration]) => [name, ms(duration)])) }));
    const gaps = loopGaps.map(gap => ({ fromMs: ms(gap.from), toMs: ms(gap.to), gapMs: ms(gap.gap),
      overlappingSamples: traceSamples.filter(sample => sample.from < gap.to && sample.to > gap.from)
        .map(sample => sample.sample) }));
    console.log(JSON.stringify({ method, scenario, concurrency, attempts: count, samples: timing.length, payloadBytes,
      ackMs, ...(profilePhases ? { servicePhaseP95Ms, phaseTrace: {
        monotonicOriginUs: traceOriginUs, loopGapThresholdMs: LOOP_TRACE_THRESHOLD_MS, loopGaps: gaps, slowest,
      } } : {}),
      eventLoopMs: { p99: Number((delay.percentile(99) / 1e6).toFixed(2)), max: Number((delay.max / 1e6).toFixed(2)) },
      preparedBeforeRelease: prepared, runtimeStartsBeforeRelease: 0,
      inboxVerifiedAtAck: inputs.length, exactRunAndUserEventVerifiedAfterAck: inputs.length, fixtureSetupTimed: false,
      crypto: cryptoMode, inboxBytesBefore: inboxBefore, inboxBytesAtCompletion: fs.statSync(inboxFile).size,
      ...(scenario === "warm" ? {} : { activeCommandsBefore: activeBefore, activeCommandLimit: MAX_ACTIVE_COMMANDS,
        inboxByteLimit: MAX_PENDING_COMMAND_FILE_BYTES, maxFrameBytes: MAX_FRAME_BYTES, writeFenceVerified: true,
        diskReceiptsVerified: accepted.length, rejectedWithoutDispatch: rejected.length,
        ...(rejectedTiming.length ? { capacityRejectionMs: summarize(rejectedTiming) } : {}) }) }));
  } finally {
    delay.disable();
    clearInterval(loopTrace);
    releaseWrite?.();
    try { if (f) await f.close({ remove: false }).finally(release); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

(async () => {
  const { values } = parseArgs({ options: {
    method: { type: "string" },
    scenario: { type: "string", default: "warm" },
    samples: { type: "string", default: "32" },
    "payload-bytes": { type: "string", default: "972" },
    concurrency: { type: "string" },
    "profile-phases": { type: "boolean", default: false },
    crypto: { type: "string", default: "local-aes-gcm" },
  } });
  const count = Number(values.samples), payloadBytes = Number(values["payload-bytes"]);
  const { scenario } = values;
  const method = values.method ?? (scenario === "warm" ? "chat.send" : "chat.send.accept");
  assert.ok(["warm", "near-count", "near-bytes", "max-payload"].includes(scenario), "unsupported --scenario");
  assert.ok(["chat.send", "chat.send.accept"].includes(method), "unsupported --method");
  assert.ok(scenario === "warm" || method === "chat.send.accept", "stress scenarios require chat.send.accept");
  assert.ok(["mock-safe-storage", "local-aes-gcm", "local-file"].includes(values.crypto), "unsupported --crypto");
  const maxSamples = scenario === "max-payload" ? 128 : scenario === "near-bytes" ? 32 : 200;
  assert.ok(Number.isSafeInteger(count) && count >= 32 && count <= maxSamples,
    `--samples must be between 32 and ${maxSamples} for ${scenario}`);
  assert.ok(Number.isSafeInteger(payloadBytes) && payloadBytes >= 1 && payloadBytes <= 16 * 1024,
    "--payload-bytes must be between 1 and 16384");
  const levels = values.concurrency ? [Number(values.concurrency)] : scenario === "warm" ? [1, 2, 8, 32] : [32];
  assert.ok(levels.every(level => [1, 2, 8, 16, 32].includes(level)), "unsupported --concurrency");
  for (const level of levels) await run(method, level, count, payloadBytes, values.crypto, values["profile-phases"], scenario);
})().catch(error => { console.error(error); process.exitCode = 1; });
