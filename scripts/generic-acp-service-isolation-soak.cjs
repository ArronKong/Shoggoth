#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { createFixture, sourceFingerprint, fileHash, until } = require("./fixtures/generic-acp-service-fixture.cjs");
const { installRuntimeObserver } = require("./fixtures/generic-acp-service-observer.cjs");
const minimumInteractions = 1000, requiredAgents = 2;
function options(argv) {
  const result = { interactions: minimumInteractions, agents: requiredAgents, preflight: false,
    output: path.resolve(__dirname, "../.artifacts/acp-foundation-completion-20261026/generic-acp-service-isolation") };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]; if (arg === "--preflight") { result.preflight = true; continue; }
    const match = /^--(interactions|agents|output)(?:=(.*))?$/u.exec(arg);
    if (!match) throw Error(`Unsupported argument: ${arg}`);
    const value = match[2] === undefined ? argv[++index] : match[2]; if (value === undefined || value.startsWith("--")) throw Error(`Missing ${match[1]}`);
    result[match[1]] = match[1] === "output" ? path.resolve(value) : Number(value);
  }
  assert.equal(result.agents, requiredAgents, "This acceptance keeps the required two independent Agents");
  assert(Number.isSafeInteger(result.interactions) && result.interactions > 0 && result.interactions % result.agents === 0);
  if (!result.preflight) assert(result.interactions >= minimumInteractions, "Formal acceptance requires at least 1000 interactions");
  return result;
}
const opts = options(process.argv.slice(2)), nonce = crypto.randomBytes(6).toString("hex"), startedAt = new Date().toISOString();
const output = path.join(opts.output, `${opts.preflight ? "preflight" : "acceptance"}-${Date.now()}-${nonce}`);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const reportPath = path.join(output, "summary.json"), receiptsPath = path.join(output, "interactions.jsonl");
fs.writeFileSync(receiptsPath, "", { mode: 0o600, flag: "wx" });
const report = { version: 1, mode: opts.preflight ? "preflight" : "acceptance", startedAt, completed: false, acceptancePassed: false,
  requested: { interactions: opts.interactions, agents: opts.agents, concurrency: opts.agents }, minimum: { interactions: minimumInteractions, agents: requiredAgents },
  boundary: "Actual private Service IPC, Product/Transcript/Memory stores, Generic ACP Adapter, signed controlled Node peer and per-Run OS processes. No external Provider or Helper invocation; separate full App acceptance covers real MCP Helper.",
  output, receiptsPath, runtimeObservations: [], completedInteractions: 0, perAgent: Array.from({ length: opts.agents }, (_, index) => ({ index, interactions: 0 })), checkpoints: [], errors: [] };
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const harnessFingerprint = () => [__filename, require.resolve("./fixtures/generic-acp-service-fixture.cjs"),
  require.resolve("./fixtures/generic-acp-service-peer.cjs"), require.resolve("./fixtures/generic-acp-service-observer.cjs")].map(file => ({ path: path.relative(path.resolve(__dirname, ".."), file), sha256: fileHash(file) }));
const sameBinding = (ref, profile) => ["runtime", "runtimeProfileId", "runtimeAccountId"].every(key => ref?.[key] === profile[key]);
function checkIdle(snapshot) {
  assert.equal(snapshot.nativeAcquireAttempts, 0);
  assert(snapshot.registry.hosts <= 16, `Bounded Generic pool exceeded 16 live hosts: ${snapshot.registry.hosts}`);
  for (const key of ["runContexts", "runExecutionContracts", "runHostAssignments", "pendingRequests", "terminalWaiters"])
    assert.equal(snapshot.coordinator[key], 0, `Settled Runs retain ${key}`);
}
async function checkPhysicalRetirement(hosts) {
  await until(() => hosts.every(host => [host.child?.stdin, host.child?.stdout, host.child?.stderr].every(stream => !stream || stream.closed === true)),
    "all owned ACP streams physically closed", 5000);
  await new Promise(setImmediate);
  const observations = [];
  for (const host of hosts) {
    const child = host.child; assert.equal(host.state, "stopped"); assert.equal(host.cleanupIncomplete, false);
    assert.equal(host.rpc.pending.size, 0); assert.equal(host.rpc.activeServerRequestIds.size, 0);
    const listeners = { childError: child.listenerCount("error"), stdinError: child.stdin.listenerCount("error"),
      stdoutError: child.stdout.listenerCount("error"), stdoutData: child.stdout.listenerCount("data"),
      stderrError: child.stderr.listenerCount("error"), stderrData: child.stderr.listenerCount("data") };
    assert(Object.values(listeners).every(count => count === 0), "ACP retirement must release its process/pipe listeners after physical close");
    observations.push({ pid: child.pid, state: host.state, streamsClosed: true, pending: 0, activeServerRequests: 0, listeners });
  }
  return observations;
}
async function main() {
  let fixture, closed = false;
  const observer = installRuntimeObserver(value => report.runtimeObservations.push(value));
  const runIds = new Set(), turnIds = new Set(), attemptIds = new Set(), ownership = new Map(), sessions = new Map();
  try {
    report.sourceBefore = sourceFingerprint(); report.harnessBefore = harnessFingerprint(); save(); fixture = await createFixture({ agents: opts.agents }); report.fixtureRoot = fixture.root;
    observer.observeRegistry(fixture.service.runtimeManager);
    report.fixtureMetadata = fixture.metadata; report.peerSha256 = fileHash(fixture.script); report.node = fixture.commandNode;
    assert.notEqual(fixture.profiles[0].id, fixture.profiles[1].id);
    assert.notEqual(fixture.profiles[0].runtimeAccountId, fixture.profiles[1].runtimeAccountId);
    assert.notEqual(fixture.profiles[0].runtimeProfileId, fixture.profiles[1].runtimeProfileId);
    assert.notEqual(fixture.chats[0].sessionKey, fixture.chats[1].sessionKey);
    assert.notEqual(fixture.chats[0].workspace, fixture.chats[1].workspace);
    report.before = fixture.resourceSnapshot(); const perAgent = opts.interactions / opts.agents;
    for (let round = 0; round < perAgent; round++) {
      const tokens = fixture.profiles.map((_, index) => `isolation-${nonce}-agent-${index}-round-${String(round).padStart(4, "0")}`);
      const outcomes = await Promise.allSettled(tokens.map((token, index) => fixture.send(index, token)));
      // Inspect both branches even when one fails; cleanup must own every child.
      const failures = outcomes.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Concurrent Generic ACP interaction failed");
      for (let index = 0; index < opts.agents; index++) {
        const { run, input } = outcomes[index].value, profile = fixture.profiles[index], chat = fixture.chats[index], token = tokens[index];
        assert.equal(run.status, "completed", `${token}: ${run.errorCode || run.status}`);
        assert.equal(run.profileId, profile.id); assert.equal(run.source, "chat"); assert.equal(run.sourceId, chat.sessionKey);
        assert.equal(run.workspace, chat.workspace); assert.equal(run.waitingRequestId, null); assert.equal(run.errorCode, null);
        assert(sameBinding(run.runtimeSessionRef, profile)); assert(sameBinding(run.runtimeTurnRef, profile)); assert(sameBinding(run.runtimeAttemptRef, profile));
        assert.equal(run.runtimeAttemptRef.dispatchState, "write_attempted"); assert.equal(run.runtimeAttemptRef.operationId, input.operationId);
        assert.equal(run.runtimeSessionRef.sessionId, run.runtimeTurnRef.sessionId); assert.equal(run.runtimeSessionRef.sessionId, run.runtimeAttemptRef.sessionId);
        assert.equal(run.runtimeTurnRef.turnId, run.runtimeAttemptRef.turnId);
        assert(!runIds.has(run.id)); assert(!turnIds.has(run.runtimeTurnRef.turnId)); assert(!attemptIds.has(run.runtimeAttemptRef.attemptId));
        runIds.add(run.id); turnIds.add(run.runtimeTurnRef.turnId); attemptIds.add(run.runtimeAttemptRef.attemptId);
        if (sessions.has(index)) assert.equal(run.runtimeSessionRef.sessionId, sessions.get(index), "Same Agent chat must resume its own native session");
        else sessions.set(index, run.runtimeSessionRef.sessionId);
        assert.notEqual(sessions.get(0), sessions.get(1));
        const events = fixture.service.transcriptStore.listEvents(profile.id, chat.id);
        const assistant = events.filter(event => event.kind === "assistant" && event.runId === run.id);
        assert.equal(assistant.length, 1, "One controlled ACP message must have one canonical assistant event");
        assert.equal(assistant[0].content.text, `ACP answer ${token} session=${run.runtimeSessionRef.sessionId}`);
        assert.equal(assistant[0].sessionId, chat.id);
        if (assistant[0].runtimeRef !== null) { assert(sameBinding(assistant[0].runtimeRef, profile)); assert.equal(assistant[0].runtimeRef.turnId, run.runtimeTurnRef.turnId); }
        const terminal = events.filter(event => event.kind === "status" && event.runId === run.id && event.content.transcriptType === "terminal");
        assert.equal(terminal.length, 1); assert.deepEqual(terminal[0].runtimeRef, run.runtimeTurnRef);
        const user = events.filter(event => event.kind === "user" && event.content.operationId === input.operationId);
        assert.equal(user.length, 1, "Each operation owns one canonical user event");
        const receipt = { ordinal: report.completedInteractions + 1, agentIndex: index, round, token, operationId: input.operationId,
          runId: run.id, profileId: profile.id, chatSessionKey: chat.sessionKey, workspace: run.workspace,
          runtimeSessionRef: run.runtimeSessionRef, runtimeTurnRef: run.runtimeTurnRef, runtimeAttemptRef: run.runtimeAttemptRef,
          userEventId: user[0].id, assistantEventId: assistant[0].id, terminalEventId: terminal[0].id };
        ownership.set(token, receipt); fs.appendFileSync(receiptsPath, JSON.stringify(receipt) + "\n");
        report.completedInteractions++; report.perAgent[index].interactions++;
      }
      const snapshot = await until(() => { const value = fixture.resourceSnapshot();
        return ["runContexts", "runExecutionContracts", "runHostAssignments", "pendingRequests", "terminalWaiters"].every(key => value.coordinator[key] === 0) && value;
      }, "completed Run ownership released", 5000); checkIdle(snapshot);
      if (round === 0 || (round + 1) % 25 === 0 || round + 1 === perAgent) {
        report.checkpoints.push({ interactions: report.completedInteractions, at: new Date().toISOString(), ...snapshot }); save();
        console.log("ACP_ISOLATION_PROGRESS " + JSON.stringify({ interactions: report.completedInteractions, target: opts.interactions,
          liveHosts: snapshot.registry.hosts, retiredHosts: snapshot.registry.retiredHosts, ownedHosts: snapshot.ownedHosts }));
      }
    }
    assert.equal(report.completedInteractions, opts.interactions); report.perAgent.forEach(agent => assert.equal(agent.interactions, opts.interactions / opts.agents));
    const processStarts = new Map(), executionProcesses = new Set(), peerPrompts = new Set(), audit = fixture.auditRows();
    for (let rowIndex = 0; rowIndex < audit.length; rowIndex++) {
      const row = audit[rowIndex];
      if (row.kind === "started") { processStarts.set(row.pid, { ...row, rowIndex }); continue; }
      if (row.kind !== "prompt") continue;
      const expected = ownership.get(row.token); assert(expected, "No unrelated or repeated input may be dispatched");
      assert(!peerPrompts.has(row.token), "Each operation may dispatch only once"); peerPrompts.add(row.token);
      assert.equal(row.sessionId, expected.runtimeSessionRef.sessionId); assert.equal(row.ppid, process.pid);
      assert(Number.isSafeInteger(row.bytes) && row.bytes > 0); assert.match(row.fingerprint, /^[a-f0-9]{64}$/u);
      const start = processStarts.get(row.pid); assert(start && start.rowIndex < rowIndex);
      assert.equal(start.home, path.join(fixture.paths.stateDir, "runtime-extension-homes", expected.runtimeSessionRef.runtime, expected.runtimeSessionRef.runtimeAccountId));
      const executionProcess = `${row.pid}:${start.rowIndex}`;
      assert(!executionProcesses.has(executionProcess), "Distinct Product Runs must use distinct Generic ACP processes"); executionProcesses.add(executionProcess);
    }
    assert.equal(peerPrompts.size, opts.interactions); assert.equal(executionProcesses.size, opts.interactions);
    for (let index = 0; index < opts.agents; index++) {
      const events = fixture.service.transcriptStore.listEvents(fixture.profiles[index].id, fixture.chats[index].id);
      const answers = events.filter(event => event.kind === "assistant"); assert.equal(answers.length, opts.interactions / opts.agents);
      const eventIds = new Set();
      for (const event of answers) {
        assert(!eventIds.has(event.id)); eventIds.add(event.id);
        if (event.runtimeRef !== null) assert(sameBinding(event.runtimeRef, fixture.profiles[index]));
        const match = /^ACP answer ([a-z0-9-]+) session=(.+)$/u.exec(event.content.text); assert(match);
        const expected = ownership.get(match[1]); assert(expected && expected.agentIndex === index, "A foreign Agent's response must never enter this Transcript");
        assert.equal(event.runId, expected.runId); assert.equal(event.sessionId, fixture.chats[index].id);
        if (event.runtimeRef !== null) assert.equal(event.runtimeRef.turnId, expected.runtimeTurnRef.turnId);
        assert.equal(match[2], expected.runtimeSessionRef.sessionId);
      }
    }
    report.beforeClose = fixture.resourceSnapshot(); checkIdle(report.beforeClose);
    report.afterClose = await fixture.closeAndObserve(); closed = true;
    report.retirement = await checkPhysicalRetirement([...fixture.ownedHosts]);
    report.auditSha256 = fileHash(path.join(fixture.root, "peer-audit.jsonl")); report.receiptsSha256 = fileHash(receiptsPath);
    assert.equal(report.runtimeObservations.filter(row => row.outcome === "fault").length, 0, "The diagnostic observer must remain reliable");
    report.harnessAfter = harnessFingerprint(); assert.deepEqual(report.harnessAfter, report.harnessBefore, "The acceptance runner and controlled peer must remain frozen");
    report.sourceAfter = sourceFingerprint(); assert.equal(report.sourceAfter.digest, report.sourceBefore.digest, "Production source must remain frozen throughout this proof");
    report.completed = true; report.acceptancePassed = !opts.preflight && report.completedInteractions >= minimumInteractions;
    report.finishedAt = new Date().toISOString(); save();
    console.log("GENERIC_ACP_ISOLATION_OK " + JSON.stringify({ mode: report.mode, interactions: report.completedInteractions, agents: opts.agents,
      perAgent: report.perAgent.map(agent => agent.interactions), acceptancePassed: report.acceptancePassed, report: reportPath }));
  } catch (error) {
    report.errors.push({ code: error.code || "ACP_ISOLATION_FAILED", message: error.message, stack: error.stack });
    if (fixture) {
      try { report.failureResources = fixture.resourceSnapshot(); } catch (diagnostic) { report.errors.push({ message: diagnostic.message }); }
      if (!closed) try { report.afterFailureClose = await fixture.closeAndObserve(); } catch (cleanup) { report.errors.push({ code: cleanup.code, message: cleanup.message }); }
    }
    report.finishedAt = new Date().toISOString(); save(); throw error;
  } finally { observer.uninstall(); }
}
main().catch(error => { console.error("GENERIC_ACP_ISOLATION_FAILED " + JSON.stringify({ message: error.message, report: reportPath })); process.exitCode = 1; });
