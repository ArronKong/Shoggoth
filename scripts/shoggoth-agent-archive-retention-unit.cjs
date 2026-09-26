#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { AgentArchiveRetention, AGENT_ARCHIVE_RETENTION_MS: WEEK,
  AGENT_ARCHIVE_RETRY_DELAY_MS: RETRY } = require("../app/agent-service/agent-archive-retention");

async function testDeadlineScheduler() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sagrt-")));
  fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const profiles = new Map();
  const timers = new Map();
  const errors = [];
  let now = WEEK * 100;
  let scans = 0;
  let failPurge = false;
  let stopProfile = async () => {};
  const retention = new AgentArchiveRetention({
    paths: { trustedRoot: root, stateDir }, now: () => now,
    productStore: {
      listAgentProfiles() { scans += 1; return [...profiles.values()]; },
      getAgentProfile: (id) => profiles.get(id), listWorkRuns: () => [], listMcpToolCalls: () => [],
    },
    stopProfile: (profile) => stopProfile(profile),
    purgeProfile(profile) {
      if (failPurge) throw new Error("scheduled purge failure");
      profiles.delete(profile.id);
    },
    setTimeout(callback, delay) {
      assert.ok(delay > 0 && delay <= 2 ** 31 - 1);
      const timer = { at: now + delay, callback, unref() {} };
      timers.set(timer, timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const start = async () => {
    retention.open();
    retention.start((action) => Promise.resolve().then(action), (error) => errors.push(error));
    await retention.inFlight;
  };
  const archive = (id) => {
    const profile = { id, runtime: "codex", runtimeProfileId: `native-${id}`,
      enabled: false, isDefault: false, updatedAt: now };
    profiles.set(id, profile);
    retention.recordArchive(profile);
    return retention.entries[id].deleteAfter;
  };
  const restore = (id) => {
    profiles.get(id).enabled = true;
    retention.cancel(id);
  };
  const nextTimer = () => [...timers.values()].sort((a, b) => a.at - b.at)[0];
  const advanceTo = async (time) => {
    let calls = 0;
    while (nextTimer()?.at <= time) {
      assert.ok(++calls < 20, "expired archives must not create an immediate retry loop");
      const timer = nextTimer();
      now = timer.at;
      timers.delete(timer);
      timer.callback();
      await retention.inFlight;
      await new Promise(setImmediate);
    }
    now = time;
  };
  try {
    await start();
    assert.equal(scans, 1);
    assert.equal(timers.size, 0);
    await advanceTo(now + WEEK);
    assert.equal(scans, 1, "no archives means no periodic checks");

    const first = archive("first");
    await advanceTo(now + RETRY);
    const second = archive("second");
    assert.equal(timers.size, 1);
    assert.equal(nextTimer().at, first);
    restore("first");
    assert.equal(nextTimer().at, second, "restoring the earliest archive moves the timer");
    restore("second");
    assert.equal(timers.size, 0, "restoring the last archive removes the timer");
    console.log("PASS startup-only idle check and archive/restore deadline rescheduling");

    const firstDue = archive("first");
    await advanceTo(now + RETRY);
    const secondDue = archive("second");
    await advanceTo(firstDue - 1);
    assert.equal(scans, 1, "waiting for expiry does not poll");
    assert.ok(profiles.has("first"));
    await advanceTo(firstDue);
    assert.equal(profiles.has("first"), false);
    assert.ok(profiles.has("second"));
    assert.equal(nextTimer().at, secondDue);
    await advanceTo(secondDue);
    assert.equal(profiles.has("second"), false);
    assert.equal(timers.size, 0);
    console.log("PASS one timer expires each archive at its own seven-day deadline");

    const overdue = archive("overdue");
    await retention.close();
    assert.equal(timers.size, 0);
    now = overdue + 1;
    await start();
    assert.equal(profiles.has("overdue"), false);
    assert.equal(timers.size, 0);
    console.log("PASS restart immediately cleans archives that expired while offline");

    const failedDue = archive("retry");
    failPurge = true;
    await advanceTo(failedDue);
    assert.equal(errors.length, 1);
    assert.ok(profiles.has("retry"));
    assert.equal(nextTimer().at, failedDue + RETRY);
    failPurge = false;
    await advanceTo(failedDue + RETRY);
    assert.equal(profiles.has("retry"), false);
    assert.equal(timers.size, 0);
    console.log("PASS failed expiry retries after a bounded delay without spinning");

    archive("closing");
    now += 1;
    archive("later");
    let entered;
    const stopping = new Promise((resolve) => { entered = resolve; });
    let release;
    stopProfile = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const timer = nextTimer();
    now = timer.at;
    timers.delete(timer);
    timer.callback();
    await stopping;
    const closing = retention.close();
    release();
    await closing;
    assert.equal(timers.size, 0);
    const scansBeforeStaleTimer = scans;
    timer.callback();
    await new Promise(setImmediate);
    assert.equal(scans, scansBeforeStaleTimer);
    assert.ok(profiles.has("later"));
    console.log("PASS shutdown awaits cleanup and prevents stale callbacks or rearming");
  } finally {
    await retention.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sagr-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  let time = Date.now();
  let service;
  let operation = 0;
  const errors = [];
  const start = async () => {
    service = createAgentService({ paths, version: "archive-retention-test", now: () => time,
      onRuntimeError: (error) => errors.push(error) });
    await service.start();
    assert.ok(service.agentArchiveRetention, "production cleanup is wired to all Stores");
    await service.agentArchiveRetention.inFlight;
  };
  const create = async (name) => (await service.agentLifecycleServiceController.handle("agent.create", {
    operationId: `create-${++operation}`, backendId: "shoggoth", name, defaultCwd: null, createdAt: time,
  })).profile;
  const archive = async (profile) => (await service.agentLifecycleServiceController.handle("agent.archive", {
    operationId: `archive-${++operation}`, profileId: profile.id,
    expectedUpdatedAt: service.productStore.getAgentProfile(profile.id).updatedAt, createdAt: time,
  })).profile;
  const restore = async (profile) => service.agentLifecycleServiceController.handle("agent.restore", {
    operationId: `restore-${++operation}`, profileId: profile.id,
    expectedUpdatedAt: service.productStore.getAgentProfile(profile.id).updatedAt, createdAt: time,
  });
  const sweep = () => service.agentLifecycleServiceController.runMaintenance(() => service.agentArchiveRetention.sweep());
  const dir = (profile) => path.join(paths.agentsDir, profile.id);
  const seed = (profile) => {
    const session = service.chatSessionStore.createSession({ operationId: `session-${++operation}`,
      profileId: profile.id, workspace: root, createdAt: time });
    service.transcriptStore.appendEvent({ profileId: profile.id, sessionId: session.id,
      id: `message-${operation}`, kind: "user", content: { text: `private-${profile.name}` }, occurredAt: time });
    const run = service.productStore.putWorkRun({ id: `run-${++operation}`, source: "chat", sourceId: session.sessionKey,
      idempotencyKey: `run-key-${operation}`, profileId: profile.id, workspace: root, status: "completed",
      contextSnapshotId: null, runtimeSessionRef: null, runtimeTurnRef: null, eventSeq: 1,
      waitingRequestId: null, startedAt: time, finishedAt: time, resultSummary: `private-${profile.name}`,
      errorCode: null, retryOf: null });
    service.permissionEngine.setProfileOverride(profile.id, "app_status", "deny");
    const job = service.nativeCronStore.createJob({ operationId: `job-${++operation}`, name: "Keep until expiry",
      enabled: false, profileId: profile.id, prompt: "private cron content", workspace: root,
      schedule: { kind: "every", everyMs: 86400000, anchorMs: time }, misfirePolicy: "latest",
      maxCatchUp: 1, overlapPolicy: "skip", threadPolicy: "new", threadId: null, nextRunAt: null, createdAt: time });
    const board = service.nativeKanbanStore.listBoards().find((item) => item.profileId === profile.id);
    const card = service.nativeKanbanStore.createCard({ operationId: `card-${++operation}`,
      boardId: board.id, profileId: profile.id, title: "Private card", body: "Private instructions",
      status: "backlog", position: 0, createdAt: time });
    const operationHash = crypto.createHash("sha256").update(`artifact-run-${++operation}`).digest("hex");
    const intentHash = crypto.createHash("sha256").update(JSON.stringify([card.id, root, null, time])).digest("hex");
    const artifactRun = service.productStore.putWorkRun({ ...run, id: `artifact-run-${operation}`,
      idempotencyKey: `shoggoth:kanban:v2:${operationHash}:${time}:${intentHash}`, source: "kanban", sourceId: card.id });
    service.nativeKanbanStore.linkCardRun({ operationId: `link-${++operation}`,
      cardId: card.id, runId: artifactRun.id, retryOf: null, createdAt: time });
    const storageKey = `artifacts/${crypto.createHash("sha256").update(profile.id).digest("hex")}`;
    const artifactFile = path.join(paths.stateDir, storageKey);
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(artifactFile, "private artifact", { mode: 0o600 });
    service.nativeKanbanStore.addArtifact({ operationId: `artifact-${++operation}`, cardId: card.id,
      runId: artifactRun.id, name: "result.txt", kind: "file", mimeType: "text/plain", sizeBytes: 16,
      sha256: crypto.createHash("sha256").update("private artifact").digest("hex"), storageKey, createdAt: time });
    service.tokenUsageStore.record({ profileId: profile.id, runId: artifactRun.id, runtime: profile.runtime,
      runtimeAccountId: profile.runtimeAccountId, agentId: profile.agentId, agentName: profile.name,
      source: "chat", sourceId: session.sessionKey, threadId: "fixture-thread", turnId: "fixture-turn",
      responseId: `response-${++operation}`, model: "fixture-model", provider: "fixture-provider",
      usage: { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0,
        outputTokens: 2, reasoningOutputTokens: 0 }, createdAt: time });
    const binding = { runtime: profile.runtime, runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId };
    service.runtimeSessionOwnershipStore.claim({ ...binding, profileId: profile.id, sessionId: `native-${operation}`, workspace: root });
    const computerDir = path.join(paths.computerArtifactsDir, crypto.createHash("sha256").update(profile.id).digest("hex").slice(0, 32));
    const ledgerDir = path.join(paths.stateDir, "runtime-ledgers", profile.runtime, profile.runtimeProfileId);
    for (const target of [computerDir, ledgerDir]) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, "owned-data"), "private data", { mode: 0o600 });
    }
    return { session, run, job, board, card, computerDir, ledgerDir, artifactFile };
  };
  try {
    await start();
    const a = await create("Expire me");
    const b = await create("Keep me");
    assert.equal(service.agentArchiveRetention.timer, null);
    const dataA = seed(a);
    const dataB = seed(b);
    const originalDefinition = fs.readFileSync(path.join(dir(b), "manifest.json"), "utf8");
    const sharedAccount = service.productStore.getRuntimeAccount(a.runtimeAccountId);
    const outside = path.join(root, "workspace-file.txt");
    fs.writeFileSync(outside, "user workspace must survive");
    fs.symlinkSync(outside, path.join(dir(a), "external-link"));
    const idea = service.inspirationStore.create({ operationId: `idea-${++operation}`, body: "Shared user note" });
    const execution = service.inspirationStore.prepareExecution({ operationId: `execute-${++operation}`,
      id: idea.id, expectedRevision: idea.revision, instruction: "Private instruction",
      agentId: a.agentId, backendId: a.backendId, profileId: a.id, workspace: root }, () => true, dataA.session.sessionKey);
    await archive(a);
    assert.ok(service.agentArchiveRetention.timer, "real lifecycle archive schedules the deadline");
    const firstDeadline = service.agentArchiveRetention.entries[a.id].deleteAfter;
    time += WEEK - 1;
    await sweep();
    assert.ok(service.productStore.getAgentProfile(a.id));
    assert.ok(fs.existsSync(dir(a)));
    await restore(a);
    assert.equal(service.agentArchiveRetention.entries[a.id], undefined);
    assert.equal(service.agentArchiveRetention.timer, null, "real lifecycle restore cancels the last timer");
    await archive(a);
    assert.ok(service.agentArchiveRetention.entries[a.id].deleteAfter > firstDeadline);
    console.log("PASS seven-day boundary, restore cancellation and re-archive deadline");

    time = service.agentArchiveRetention.entries[a.id].deleteAfter;
    const purgeInspiration = service.inspirationStore.purgeProfile.bind(service.inspirationStore);
    service.inspirationStore.purgeProfile = () => { throw new Error("injected cleanup failure"); };
    await assert.rejects(sweep, /injected cleanup failure/u);
    assert.equal(service.agentArchiveRetention.entries[a.id].phase, "purging");
    await assert.rejects(() => restore(a), { code: "AGENT_RETENTION_EXPIRED" });
    service.inspirationStore.purgeProfile = purgeInspiration;
    time -= 1000; // A clock correction cannot leave a committed partial purge unfinished.
    await service.stop();
    await start();
    await sweep();
    assert.equal(service.productStore.getAgentProfile(a.id), null);
    assert.equal(fs.existsSync(dir(a)), false);
    assert.equal(fs.existsSync(dataA.computerDir), false);
    assert.equal(fs.existsSync(dataA.ledgerDir), false);
    assert.equal(fs.existsSync(dataA.artifactFile), false);
    assert.equal(fs.readFileSync(dataB.artifactFile, "utf8"), "private artifact");
    assert.equal(service.chatSessionStore.getSession(dataA.session.sessionKey), null);
    assert.equal(service.nativeCronStore.getJob(dataA.job.id), null);
    assert.equal(service.nativeKanbanStore.getBoard(dataA.board.id), null);
    assert.equal(service.nativeKanbanStore.getCard(dataA.card.id), null);
    assert.equal(service.productStore.getWorkRun(dataA.run.id), null);
    assert.equal(service.inspirationStore.executions(idea.id).some((item) => item.id === execution.id), false);
    assert.equal(service.inspirationStore.get(idea.id).body, "Shared user note");
    assert.equal(service.tokenUsageStore.list({ profileId: a.id }).length, 0);
    assert.equal(fs.readFileSync(outside, "utf8"), "user workspace must survive");
    assert.deepEqual(service.productStore.getRuntimeAccount(a.runtimeAccountId), sharedAccount);
    assert.ok(service.chatSessionStore.getSession(dataB.session.sessionKey));
    assert.ok(service.nativeCronStore.getJob(dataB.job.id));
    assert.ok(service.nativeKanbanStore.getCard(dataB.card.id));
    assert.equal(fs.readFileSync(path.join(dir(b), "manifest.json"), "utf8"), originalDefinition);
    assert.equal(service.agentArchiveRetention.entries[a.id], undefined);
    console.log("PASS interrupted cleanup recovery, owned data deletion and other-Agent/shared-data isolation");

    const interruptedFiles = await create("Finish deleting files after restart");
    const interruptedData = seed(interruptedFiles);
    await archive(interruptedFiles);
    time = service.agentArchiveRetention.entries[interruptedFiles.id].deleteAfter;
    service.agentArchiveRetention._removeFiles = () => { throw new Error("injected file cleanup failure"); };
    await assert.rejects(sweep, /injected file cleanup failure/u);
    assert.equal(service.productStore.getAgentProfile(interruptedFiles.id), null);
    assert.ok(fs.existsSync(dir(interruptedFiles)));
    await service.stop();
    await start();
    assert.equal(fs.existsSync(dir(interruptedFiles)), false);
    assert.equal(fs.existsSync(interruptedData.computerDir), false);
    assert.equal(service.agentArchiveRetention.entries[interruptedFiles.id], undefined);
    console.log("PASS file cleanup resumes after the Profile has already been removed");

    const legacy = await create("Existing archive");
    await archive(legacy);
    service.agentArchiveRetention.cancel(legacy.id); // Simulate an archive made before retention existed.
    time += WEEK * 4;
    await sweep();
    assert.equal(service.agentArchiveRetention.entries[legacy.id].deleteAfter, time + WEEK);
    await service.stop();
    await start();
    assert.equal(service.agentArchiveRetention.entries[legacy.id].deleteAfter, time + WEEK);
    assert.equal(service.productStore.getAgentProfile(a.id), null);
    console.log("PASS legacy archive grace period and deadlines surviving restart without resurrection");

    const hostile = await create("Unsafe path");
    await archive(hostile);
    const parked = `${dir(hostile)}-original`;
    fs.renameSync(dir(hostile), parked);
    fs.symlinkSync(dir(b), dir(hostile));
    time = service.agentArchiveRetention.entries[hostile.id].deleteAfter;
    await assert.rejects(sweep);
    assert.ok(service.productStore.getAgentProfile(hostile.id), "path preflight precedes metadata deletion");
    assert.ok(fs.existsSync(path.join(dir(b), "manifest.json")));
    fs.unlinkSync(dir(hostile));
    fs.renameSync(parked, dir(hostile));
    console.log("PASS unsafe target rejection before deletion");
    assert.deepEqual(errors, []);
    console.log("PASS archive retention integration (isolated data only)");
  } finally {
    await service?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
testDeadlineScheduler().then(main).catch((error) => { console.error(error); process.exitCode = 1; });
