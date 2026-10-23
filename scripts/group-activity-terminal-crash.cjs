"use strict";
// §417. Only owned children are SIGKILLed. The kill boundaries surround actual
// ProductStore terminal persistence and GroupChatStore terminal SQLite commit.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process"), crypto = require("node:crypto");
const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
const { JsonlProductStore } = require("../app/agent-service/product-store");
const { GroupChatStore } = require("../app/agent-service/group-chat-store");
const { GroupActivityProjection } = require("../app/agent-service/group-activity");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { FakeHost } = require("./shoggoth-work-run-coordinator-unit.cjs");
const POINTS = ["before-run-terminal", "after-run-terminal", "after-group-terminal"];
const ANSWER = "synthetic fixed group terminal result";
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const waitFor = async (predicate, label) => { const until = Date.now() + 15000; while (Date.now() < until) {
  const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20));
} throw Error(`timed out: ${label}`); };
function privateRoot(root) { const s = fs.lstatSync(root); assert.ok(root.startsWith("/private/tmp/gact-crash-"));
  assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077)); assert.equal(fs.realpathSync(root), root); }
async function child(root, point) {
  privateRoot(root); const f = await openHandoffFixture({ root });
  const store = f.service.groupChatStore, driver = f.service.groupChatDriver;
  const { groupId } = store.createGroup({ operationId: "synthetic-create", name: "synthetic activity crash", purpose: "one answer", mode: "independent",
    members: [0, 1].map(index => ({ backendId: "shoggoth", profileId: index ? "unused-synthetic-profile" : f.profile.id,
      agentId: index ? "unused-synthetic-agent" : f.profile.id, displayName: `Synthetic ${index}` })) });
  const member = store.getGroup(groupId).members[0];
  const input = { groupId, clientMessageId: "original-group-operation", body: "synthetic bounded answer", mentionMemberIds: [member.id], requestMode: "new" };
  const sent = store.appendUserMessage(input), fence = store.getDriverFence();
  const claim = store.claimNext(groupId, fence); assert.ok(claim); assert.equal(claim.member.id, member.id);
  const sessionKey = await driver.executor.ensureSession(claim.binding);
  store.bindSession({ groupId, memberId: member.id, sessionKey, fence });
  const run = await driver.executor.start({ sessionKey, operationId: claim.opportunity.operationId, prompt: "Return the fixed synthetic answer." });
  await f.service.workRunCoordinator.waitForIdle(run.id);
  store.recordRun({ opportunityId: claim.opportunity.id, runId: run.id, sessionKey, fence });
  const running = f.service.workRunCoordinator.getRun(run.id); assert.equal(running.status, "running");
  driver.drafts.watch(claim.opportunity.id);
  const raw = f.transport.hosts.get("codex");
  assert.equal(raw.turnStartCalls, 1, "exactly one initial controlled Runtime start is observed");
  const originalPut = f.service.productStore.putWorkRun.bind(f.service.productStore);
  const originalComplete = store.completeTurn.bind(store);
  let observedBeforeTerminal = null;
  const kill = boundary => {
    const saved = { point, boundary, pid: process.pid, paths: f.paths, groupId, discussionId: sent.discussionId,
      opportunityId: claim.opportunity.id, operationId: claim.opportunity.operationId, sessionKey, runId: run.id,
      memberId: member.id, profileId: member.profileId, originalInput: input, runtimeThreads: raw.threads,
      loadedThreads: [...raw.loadedThreads], binding: { runtime: running.runtimeSessionRef.runtime,
        runtimeProfileId: running.runtimeSessionRef.runtimeProfileId, runtimeAccountId: running.runtimeSessionRef.runtimeAccountId },
      controlledRuntimeStarts: raw.turnStartCalls, observedActivity: observedBeforeTerminal, persistedRunStatus: f.service.productStore.getWorkRun(run.id).status,
      persistedGroupState: store.getOpportunity(claim.opportunity.id).state };
    fs.writeFileSync(path.join(root, "checkpoint.json"), JSON.stringify(saved), { mode: 0o600 });
    process.kill(process.pid, "SIGKILL"); throw Error("SIGKILL did not terminate owned child");
  };
  f.service.productStore.putWorkRun = value => {
    if (value.id === run.id && value.status === "completed" && point === "before-run-terminal") kill("ProductStore.putWorkRun before append+fsync");
    const result = originalPut(value);
    if (value.id === run.id && value.status === "completed" && point === "after-run-terminal") kill("ProductStore.putWorkRun returned after append+fsync");
    return result;
  };
  store.completeTurn = value => { const result = originalComplete(value);
    if (value.opportunityId === claim.opportunity.id && result.changed && point === "after-group-terminal") kill("GroupChatStore.completeTurn returned after SQLite COMMIT"); return result; };
  raw.emit({ known: true, type: "tool_start", threadId: running.runtimeSessionRef.sessionId, turnId: running.runtimeTurnRef.turnId,
    toolCallId: "synthetic-progress-before-terminal", tool: { name: "read_file", input: { path: "synthetic.txt" } } });
  await waitFor(() => driver.drafts.activityFor(claim.opportunity.id)?.phase === "tool", "real group observer saw bound tool before terminal");
  assert.equal(driver.drafts.activityFor(claim.opportunity.id).runId, run.id);
  observedBeforeTerminal = { phase: driver.drafts.activityFor(claim.opportunity.id).phase, runId: run.id };
  await f.complete(running, ANSWER);
  await waitFor(() => store.getOpportunity(claim.opportunity.id).state === "replied", "group terminal callback");
  throw Error(`kill boundary not reached: ${point}`);
}
async function verify(root, saved, rawDir) {
  // Inspect raw disk authority before any recovery worker runs. The before
  // boundary is still running/unknown, even if the controlled host has finished.
  const product = new JsonlProductStore({ paths: saved.paths }).open();
  const groups = new GroupChatStore({ paths: saved.paths }).open();
  let diskRun, diskOpportunity;
  try {
    diskRun = product.getWorkRun(saved.runId); diskOpportunity = groups.getOpportunity(saved.opportunityId);
    fs.writeFileSync(path.join(rawDir, "disk-before-recovery.json"), JSON.stringify({ run: diskRun, opportunity: diskOpportunity,
      messages: groups.listMessages({ groupId: saved.groupId, limit: 200 }).messages }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    assert.equal(diskRun.id, saved.runId); assert.equal(diskOpportunity.runId, saved.runId);
    assert.equal(diskOpportunity.operationId, saved.operationId); assert.equal(diskOpportunity.sessionKey, saved.sessionKey);
    assert.equal(diskRun.status, saved.point === "before-run-terminal" ? "running" : "completed");
    assert.equal(diskOpportunity.state, saved.point === "after-group-terminal" ? "replied" : "running");
    assert.equal(groups.listMessages({ groupId: saved.groupId, limit: 200 }).messages.filter(m => m.body === ANSWER).length,
      saved.point === "after-group-terminal" ? 1 : 0);
    assert.equal(groups.claimNext(saved.groupId, groups.getDriverFence()), null, "accepted original run cannot be replayed before reconciliation");
  } finally { groups.close(); product.close(); }
  fs.copyFileSync(path.join(saved.paths.stateDir, "group-chats.sqlite"), path.join(rawDir, "group-before-recovery.sqlite"), fs.constants.COPYFILE_EXCL);
  const raw = new FakeHost([]); raw.threads = saved.runtimeThreads; raw.loadedThreads = new Set(saved.loadedThreads);
  assert.equal(raw.turnStartCalls, 0, "fresh recovery host has observed no starts");
  raw.stop = async () => raw.termination.resolve(); raw.subscribeAccountAuth = () => () => {};
  const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => raw, stop: async () => {}, stopAll: async () => {} } });
  const handle = await adapter.acquire(saved.binding);
  const transport = { hosts: new Map([["codex", raw]]), handles: new Map([[JSON.stringify(saved.binding), handle]]), acquisitions: [] };
  const f = await openHandoffFixture({ root, transport });
  try {
    const store = f.service.groupChatStore, coordinator = f.service.workRunCoordinator;
    await waitFor(() => coordinator.getRun(saved.runId)?.status === "completed", "same run reconciled from exact controlled host");
    await f.service.groupChatDriver.reconcile(saved.opportunityId);
    await waitFor(() => store.getOpportunity(saved.opportunityId).state === "replied", "original group terminal reconciled");
    const final = store.getOpportunity(saved.opportunityId), run = coordinator.getRun(saved.runId);
    assert.equal(final.runId, saved.runId); assert.equal(final.operationId, saved.operationId); assert.equal(final.sessionKey, saved.sessionKey);
    assert.equal(run.runtimeSessionRef.sessionId, diskRun.runtimeSessionRef.sessionId);
    assert.equal(run.runtimeTurnRef.turnId, diskRun.runtimeTurnRef.turnId);
    const projection = new GroupActivityProjection({ groupId: saved.groupId, discussionId: saved.discussionId,
      memberId: saved.memberId, opportunityId: saved.opportunityId, runId: saved.runId,
      executionGeneration: [final.fence, final.sessionKey, final.runId, final.external?.executionId ?? ""].join(":") });
    const page = await f.service.groupChatDriver.executor.readEvents({ runId: saved.runId, streamId: null, afterSeq: 0 });
    projection.observeEvents(page.events, page.streamId); projection.observeStatus(run.status, { at: run.finishedAt });
    assert.equal(projection.snapshot().phase, "completed");
    const progressAt = projection.snapshot().lastProgressAt;
    const late = { seq: page.latestSeq + 100, runId: saved.runId, streamId: page.streamId, type: "tool.start",
      createdAt: Date.now(), payload: { toolCallId: "late-old-progress", tool: { name: "read_file" } } };
    projection.observeEvents([late], page.streamId);
    assert.equal(projection.snapshot().phase, "completed"); assert.equal(projection.snapshot().lastProgressAt, progressAt);
    const lateEvents = [];
    const subscription = coordinator.subscribeRun(saved.runId, { streamId: page.streamId, afterSeq: page.latestSeq }, event => lateEvents.push(event));
    raw.emit({ known: true, type: "tool_start", threadId: run.runtimeSessionRef.sessionId, turnId: run.runtimeTurnRef.turnId,
      toolCallId: "late-real-host-progress", tool: { name: "read_file" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateEvents.filter(event => event.type === "tool.start").length, 0, "retired real host cannot append progress to terminal stream");
    subscription.unsubscribe?.();
    assert.equal(coordinator.getRun(saved.runId).status, "completed"); assert.equal(store.getOpportunity(saved.opportunityId).state, "replied");
    assert.equal(f.service.groupChatDriver.drafts.activityFor(saved.opportunityId), null, "terminal observer cannot revive");
    assert.equal(store.listMessages({ groupId: saved.groupId, limit: 200 }).messages.filter(m => m.body === ANSWER).length, 1);
    assert.equal(store.appendUserMessage(saved.originalInput).duplicate, true);
    assert.equal(store.claimNext(saved.groupId, store.getDriverFence()), null);
    assert.equal(raw.turnStartCalls, 0, "recovery reconciles original execution; it never starts another turn");
    fs.writeFileSync(path.join(rawDir, "disk-after-recovery.json"), JSON.stringify({ run, opportunity: final,
      messages: store.listMessages({ groupId: saved.groupId, limit: 200 }).messages }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return { passed: true, point: saved.point, boundary: saved.boundary, childPid: saved.pid,
      persistedBeforeRecovery: { runStatus: diskRun.status, opportunityState: diskOpportunity.state },
      originalRunId: saved.runId, originalOperationId: saved.operationId, originalSessionKey: saved.sessionKey,
      originalRuntimeSessionId: run.runtimeSessionRef.sessionId, originalRuntimeTurnId: run.runtimeTurnRef.turnId,
      controlledRuntimeStarts: saved.controlledRuntimeStarts, recoveryRuntimeStarts: raw.turnStartCalls, observedBeforeKill: saved.observedActivity, publicResults: 1, duplicateTerminalResults: 0,
      terminalNotRevivedByLateProgress: true, beforeTerminalWasNotAssumedComplete: true };
  } finally { await f.close({ remove: false });
    fs.copyFileSync(path.join(saved.paths.stateDir, "group-chats.sqlite"), path.join(rawDir, "group-after-recovery.sqlite"), fs.constants.COPYFILE_EXCL); }
}
async function main() {
  const args = process.argv.slice(2); assert.ok(args.length === 0 || args.length === 2 && args[0] === "--report");
  const reportPath = path.resolve(args[1] ?? path.join(".artifacts", `activity-terminal-crash-${Date.now()}-${process.pid}.json`));
  assert.ok(!fs.existsSync(reportPath), "never overwrite an earlier proof");
  const rawRoot = `${reportPath}.raw`; fs.mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const reports = [];
  for (const point of POINTS) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gact-crash-"))); fs.chmodSync(root, 0o700);
    const rawDir = path.join(rawRoot, point); fs.mkdirSync(rawDir, { mode: 0o700 });
    try {
      const child = spawnSync(process.execPath, [__filename, "--child", root, point], { env: { ...process.env, TMPDIR: "/private/tmp" },
        encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024 });
      fs.writeFileSync(path.join(rawDir, "child-process.json"), JSON.stringify({ pid: child.pid, status: child.status, signal: child.signal, error: child.error?.code ?? null }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(rawDir, "child-stdout.log"), child.stdout ?? "", { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(rawDir, "child-stderr.log"), child.stderr ?? "", { mode: 0o600, flag: "wx" });
      assert.equal(child.signal, "SIGKILL", `owned child did not reach ${point}: ${child.stderr}`);
      const saved = JSON.parse(fs.readFileSync(path.join(root, "checkpoint.json")));
      assert.equal(saved.pid, child.pid);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "killed owned worker is no longer live");
      const result = await verify(root, saved, rawDir); reports.push({ ...result, childSignal: child.signal, childExitStatus: child.status, childProcessClosed: true,
        childStderr: child.stderr.slice(0, 4000), checkpointSha256: digest(path.join(root, "checkpoint.json")) });
      process.stdout.write(`PASS ${point}\n`);
    } finally {
      const checkpoint = path.join(root, "checkpoint.json");
      if (fs.existsSync(checkpoint)) fs.copyFileSync(checkpoint, path.join(rawDir, "checkpoint.json"), fs.constants.COPYFILE_EXCL);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const report = { version: 1, passed: true, processCrashPoints: reports.length, realProviderStarts: 0,
    personalConfigOrAuthReads: 0, reports, rawEvidence: POINTS.map(point => ({ point, files: fs.readdirSync(path.join(rawRoot, point)).map(name => ({ path: path.join(rawRoot, point, name), sha256: digest(path.join(rawRoot, point, name)) })) })), boundary: "Real isolated Service/ProductStore/GroupChatStore/Coordinator paths; only Runtime transport is controlled. No production Service or authority touched." };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(JSON.stringify(report) + "\n");
}
const args = process.argv.slice(2);
Promise.resolve(args[0] === "--child" ? child(args[1], args[2]) : main()).catch(error => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
