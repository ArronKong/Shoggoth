"use strict";

// Real Service, Cron scheduler, Coordinator, IPC and chat projection. Only the
// Runtime transport/report is synthetic. Memory write-back is owned by the
// separate shared-memory change and is deliberately not simulated as accepted.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID: PROFILE } = require("../app/agent-service/product-store");
const { readCodexMemorySource } = require("../app/agent-service/codex-memory-source");
const { TASK_PROMPT, RETRY_DELAY_MS, RESULT_OK, RESULT_FAILED } = require("../app/agent-service/codex-memory-import-service");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { InspirationRuntime } = require("./fixtures/inspiration-runtime.cjs");

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("import task condition timed out");
}
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgi-cron-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const file = path.join(root, ".codex", "memories", "MEMORY.md");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "# Fixture\n- 回答使用中文。\n");
  let clock = Date.now();
  const host = new InspirationRuntime(), prompts = [];
  const originalStart = host.turnStart.bind(host);
  host.turnStart = (params) => { prompts.push(structuredClone(params)); return originalStart(params); };
  const options = { paths, now: () => clock,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    runtimePool: { async get() { return host; }, async stopAll() {} },
    setCronTimer: () => 1, clearCronTimer() {},
    readCodexMemorySource: (name) => readCodexMemorySource(name, { hostHome: root }),
    codexMemoryImport: true, codexMemoryImportDelayMs: 5 };
  let service = createAgentService(options);
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  await service.start();
  const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths),
    version: PROTOCOL_VERSION, method, params });
  await until(() => service.nativeCronStore.listJobs().length === 1);
  const job = service.nativeCronStore.listJobs()[0];
  clock += 5; await service.nativeCronScheduler.tick();
  const runs = () => service.workDispatcher.listRuns({ source: "cron", sourceId: job.id });
  await until(() => runs()[0]?.status === "running");
  return { root, paths, file, host, prompts, job, ipc, runs, get service() { return service; },
    advance(ms) { clock += ms; },
    async complete(text, status = "completed") {
      const run = runs().at(-1);
      host.complete(run, text);
      await until(() => ["completed", "failed"].includes(service.workDispatcher.getRun(run.id).status));
      assert.equal(service.workDispatcher.getRun(run.id).status, status);
      return service.codexMemoryImportService.run();
    },
    async restart() { await service.stop({ notify: false }); service = createAgentService(options); await service.start();
      await new Promise((resolve) => setTimeout(resolve, 35)); return service.codexMemoryImportService.run(); },
  };
}

test("startup creates one protected system task and a real visible Cron chat", async (t) => {
  const f = await fixture(t);
  assert.equal(f.job.profileId, PROFILE); assert.equal(f.job.schedule.kind, "at");
  assert.ok(f.job.prompt.startsWith(TASK_PROMPT));
  assert.ok(JSON.stringify(f.prompts[0]).includes("Codex Memory Import"));
  assert.ok(!JSON.stringify(f.prompts[0]).includes('"isolatedGeneration":true'));
  const detail = await f.ipc("cron.job.get", { jobId: f.job.id });
  assert.equal(detail.job.systemManaged, true);
  const backend = new ShoggothBackend({ paths: f.paths });
  backend._state = "started"; await backend._refreshManagedProfiles();
  const projected = await backend.getCronJob(`shoggoth:${f.job.id}`);
  assert.deepEqual(projected.actions, { edit: false, toggle: false, delete: false, run: false, reason: "system-managed" });
  const session = (await f.ipc("chat.session.list", { profileId: PROFILE, includeArchived: false, cursor: null, limit: 100 })).sessions
    .find((item) => item.cronJobId === f.job.id);
  assert.ok(session); assert.deepEqual(session.cronRunIds, [f.runs()[0].id]);
  const report = `${RESULT_OK}\nFixture task report. This transport test does not claim a real memory commit.`;
  const result = await f.complete(report);
  assert.equal(result.state, "completed"); assert.equal(result.task.attempts, 1);
  assert.equal(result.imported, 0, "the scheduler never invents imported record counts");
  const history = await f.ipc("chat.history", { sessionKey: session.sessionKey, cursor: null, limit: 100 });
  assert.ok(history.messages.some((message) => JSON.stringify(message).includes(JSON.stringify(report).slice(1, -1))));
  assert.equal(f.service.memoryStore.list(PROFILE).length, 0, "no separate importer writes to memory");
  const restarted = await f.restart(); assert.equal(restarted.state, "completed");
  assert.equal(f.host.turnStarts, 1); assert.equal(f.service.nativeCronStore.listJobs().length, 1);
});

test("ordinary Cron management cannot edit, delete, toggle, manually rerun or retry this system task", async (t) => {
  const f = await fixture(t);
  for (const [method, extra] of [
    ["cron.job.update", { patch: { prompt: "replace" } }], ["cron.job.delete", {}],
    ["cron.job.enabled.set", { enabled: false }], ["cron.run.trigger", {}],
    ["cron.run.retry", { retryOf: f.runs()[0].id }],
  ]) await assert.rejects(f.ipc(method, { operationId: crypto.randomUUID(), jobId: f.job.id, createdAt: Date.now(), ...extra }),
    (error) => error.code === "STATE_CONFLICT", method);
  assert.equal(f.service.nativeCronStore.getJob(f.job.id).prompt, f.job.prompt);
  assert.equal(f.runs().length, 1);
  await f.complete(RESULT_OK);
});

test("Agent-reported write failure becomes a failed WorkRun; exactly one retry shares its chat", async (t) => {
  const f = await fixture(t);
  let status = await f.complete(`${RESULT_FAILED}\nNative MEMORY.md write-back is not available yet.`, "failed");
  assert.equal(status.state, "deferred"); assert.equal(f.runs()[0].errorCode, "MEMORY_IMPORT_TASK_FAILED");
  f.advance(RETRY_DELAY_MS - 1); await f.service.codexMemoryImportService.run(); assert.equal(f.runs().length, 1);
  f.advance(1); await f.service.codexMemoryImportService.run();
  await until(() => f.runs()[1]?.status === "running");
  assert.equal(f.runs()[1].retryOf, f.runs()[0].id);
  assert.equal(f.service.workRunCoordinator.getRunSessionKey(f.runs()[0]), f.service.workRunCoordinator.getRunSessionKey(f.runs()[1]));
  status = await f.complete(`${RESULT_FAILED}\nStill unavailable.`, "failed");
  assert.equal(status.state, "abandoned"); assert.equal(status.task.attempts, 2);
  await f.restart(); f.advance(RETRY_DELAY_MS * 2); await f.service.codexMemoryImportService.run();
  assert.equal(f.host.turnStarts, 2); assert.equal(f.runs().length, 2);
});

test("a plan without a result marker fails; verified fixture report on retry completes", async (t) => {
  const f = await fixture(t);
  await f.complete("I will read and import the file later.", "failed");
  assert.equal(f.runs()[0].errorCode, "MEMORY_IMPORT_RESULT_MISSING");
  f.advance(RETRY_DELAY_MS); await f.service.codexMemoryImportService.run();
  await until(() => f.runs()[1]?.status === "running");
  const result = await f.complete(`${RESULT_OK}\nFixture success report.`);
  assert.equal(result.state, "completed", JSON.stringify({ result, runs: f.runs() }));
  const persisted = await f.ipc("harness.memory.import.status", { profileId: PROFILE });
  assert.equal(persisted.task.attempts, 2); assert.equal(persisted.state, "completed");
});

test("IPC and backend expose a complete paged report from the terminal transcript after restart", async (t) => {
  const f = await fixture(t);
  const report = `${RESULT_FAILED}\n## 未保存的用户理解\n${"有证据的工作方式🌿\n".repeat(1300)}\nEND_FULL_REPORT`;
  const emit = f.host.emit.bind(f.host);
  f.host.emit = (event) => {
    if (event.type !== "text" || event.text !== report) return emit(event);
    emit({ ...event, text: report.slice(0, 800), contextText: report, phase: "final_answer" });
    emit({ ...event, itemId: "trailing-commentary", text: "This commentary is not the final report.", phase: "commentary" });
  };
  await f.complete(report, "failed");
  const transcriptKey = f.service.workRunCoordinator.getRunSessionKey(f.runs()[0]);
  const transcriptSession = f.service.chatSessionStore.getSession(transcriptKey);
  assert.notEqual(transcriptSession.id, transcriptKey, "sessionKey cannot stand in for the Transcript sessionId");
  const answers = f.service.transcriptStore.listEvents(PROFILE, transcriptSession.id).filter((event) => event.kind === "assistant");
  assert.ok(answers.length, "terminal answer must be persisted in the existing transcript");
  const answer = answers.find((event) => event.content.phase === "final_answer");
  assert.ok(answer.content.contextRef, "reuse the normal native transcript content reference");
  const readAll = async () => {
    let text = "", cursor = 0, runId = null, expectedHash = null;
    do {
      const page = await f.ipc("harness.memory.import.report", {
        profileId: PROFILE, cursor, runId, expectedHash, limit: 2999,
      });
      assert.equal(page.runStatus, "failed"); assert.equal(page.reportedOutcome, "failed", JSON.stringify({
        prefix: page.text.slice(0, 120), hash: page.reportHash, runId: page.runId,
      }));
      assert.equal(page.attempt, 1); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32 * 1024);
      text += page.text; cursor = page.nextCursor; runId = page.runId; expectedHash = page.reportHash;
    } while (cursor !== null);
    return text;
  };
  assert.equal(await readAll(), report);
  assert.ok(Buffer.byteLength(f.runs()[0].resultSummary || "") < Buffer.byteLength(report),
    "the full report must not be derived from the bounded WorkRun summary");
  await f.restart();
  assert.equal(await readAll(), report);
  const contentFile = path.join(f.service.transcriptStore._sessionDir(PROFILE, transcriptSession.id),
    "context-content", `${answer.content.contextRef.hash}.json`);
  fs.renameSync(contentFile, `${contentFile}.retained`);
  await assert.rejects(f.ipc("harness.memory.import.report", {
    profileId: PROFILE, cursor: 0, runId: null, expectedHash: null, limit: 8000,
  }), (error) => error.code === "CONTEXT_CONTENT_UNAVAILABLE");
  fs.renameSync(`${contentFile}.retained`, contentFile);
  assert.equal(await readAll(), report, "missing full content cannot silently fall back to a display excerpt");
  const backend = new ShoggothBackend({ paths: f.paths });
  backend._state = "started"; await backend._refreshManagedProfiles();
  const managed = (await backend.listAgents()).find((item) => item.id.endsWith(PROFILE));
  assert.ok(managed);
  const first = await backend.getAgentMemoryImportReport(managed.id);
  assert.equal(first.reportedOutcome, "failed"); assert.ok(report.startsWith(first.text));
  assert.equal(f.host.turnStarts, 1); assert.equal(f.runs().length, 1);
  assert.equal(f.service.memoryStore.list(PROFILE).length, 0);
  assert.equal(fs.readFileSync(f.file, "utf8"), "# Fixture\n- 回答使用中文。\n");
});
