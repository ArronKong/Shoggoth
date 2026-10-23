"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const PROMPT_NAME = "codex-memory-import-and-personalization-prompt-en.md";
const TASK_PROMPT = fs.readFileSync(path.join(__dirname, "prompts", PROMPT_NAME), "utf8");
const RETRY_DELAY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 2;
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const RESULT_OK = "SHOGGOTH_CODEX_MEMORY_IMPORT: completed";
const RESULT_FAILED = "SHOGGOTH_CODEX_MEMORY_IMPORT: failed";
const JOB_IDENTITY_FIELDS = ["name", "profileId", "prompt", "workspace", "schedule",
  "misfirePolicy", "maxCatchUp", "overlapPolicy", "threadPolicy", "threadId"];
const safeCode = (error, fallback = "CODEX_MEMORY_IMPORT_FAILED") => /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.code) ? error.code : fallback;

function taskPrompt(sourcePath) {
  return `${TASK_PROMPT}\n\n## System Task Context\n\n`
    + `The host OS account resolved the authorized source to ${JSON.stringify(sourcePath)}. This path is host metadata, not a Runtime HOME override.\n`
    + "Use the main Shoggoth Agent's own available memory/document tools and native write-back channel. Discover their current schemas; do not use the removed JSON extraction pipeline or create another import/write service.\n"
    + `Start your final response with exactly one of these status lines: ${JSON.stringify(RESULT_OK)} or ${JSON.stringify(RESULT_FAILED)}. Keep the operational status concise while preserving the substantive user profile required by the task, including the unsaved profile when writing is unavailable. Use completed only after the task's required authoritative writes and read-back verification succeed. Missing write capability, an uncertain commit, or incomplete verification requires failed, followed by the specific reason.\n`
    + "This is a one-shot system task. The scheduler owns its one allowed retry; do not create or trigger retry jobs yourself.\n";
}

// Only owns dispatch and retry. The main Agent reads, curates, writes and
// verifies through its normal memory channel. No model-only extraction,
// direct MemoryEngine writes, duplicate memory store or fabricated provenance.
class CodexMemoryImportService {
  constructor({ store, profileId, cronStore, scheduler, dispatcher, readSource,
    readRunReport = () => null, isProfileReady = () => true, now = Date.now, randomUUID = crypto.randomUUID }) {
    Object.assign(this, { store, profileId, cronStore, scheduler, dispatcher, readSource,
      readRunReport, isProfileReady, now, randomUUID });
    this.inFlight = null;
  }
  status(profileId) {
    if (profileId !== this.profileId) return { applicable: false };
    let ledger;
    try { ledger = this.store.get(profileId); }
    catch (error) { ledger = { state: "failed", reason: safeCode(error), sources: [], chunks: {}, totals: {}, updatedAt: null, completedAt: null }; }
    const chunks = Object.values(ledger.chunks);
    const runs = ledger.task ? this.runs(ledger.task) : [];
    const last = runs.at(-1);
    const retryAt = last && TERMINAL.has(last.status) && last.status !== "completed" && runs.length < MAX_ATTEMPTS
      && !["completed", "abandoned"].includes(ledger.state)
      && Number.isSafeInteger(last.finishedAt ?? last.updatedAt)
      ? (last.finishedAt ?? last.updatedAt) + RETRY_DELAY_MS : null;
    return { applicable: true, state: ledger.state, reason: ledger.reason,
      sources: ledger.sources.map((source) => ({ name: source.name, lines: source.lines })),
      chunks: { total: chunks.length, done: chunks.filter((item) => item.state === "done").length,
        skipped: chunks.filter((item) => item.state === "skipped").length,
        pending: chunks.filter((item) => ["pending", "proposed"].includes(item.state)).length },
      // Legacy evidence/counts remain readable; new task counts belong to its
      // Agent report. A completed Runtime turn is not a fabricated save count.
      imported: chunks.reduce((sum, item) => sum + item.imported, 0),
      skipped: chunks.reduce((sum, item) => sum + Object.values(item.skipped).reduce((a, b) => a + b, 0), 0),
      modelCalls: ledger.totals.modelCalls || 0,
      ...(ledger.task ? { task: { jobId: this.jobId(ledger.task), runId: runs.at(-1)?.id ?? null,
        attempts: runs.length, maxAttempts: MAX_ATTEMPTS, retryAt,
        reportRunId: runs.filter((run) => TERMINAL.has(run.status)).at(-1)?.id ?? null } } : {}),
      updatedAt: ledger.updatedAt, completedAt: ledger.completedAt };
  }
  // Read the existing terminal task transcript, never the bounded WorkRun
  // summary or an independent profile store. Pages remain on one run/hash.
  report(profileId, { runId = null, cursor = 0, limit = 8000, expectedHash = null } = {}) {
    if (profileId !== this.profileId) return { applicable: false };
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit)
      || limit < 2 || limit > 8000 || (cursor > 0 && (!runId || !expectedHash))) {
      throw serviceError("INVALID_PARAMS", "运行报告分页参数无效");
    }
    const task = this.store.get(profileId).task;
    const empty = { applicable: true, jobId: task ? this.jobId(task) : null, runId: null,
      attempt: null, runStatus: null, finishedAt: null, reportedOutcome: null,
      reportHash: null, text: "", nextCursor: null, hasMore: false };
    if (!task) {
      if (runId) throw serviceError("MEMORY_IMPORT_REPORT_NOT_FOUND", "运行报告不存在");
      return empty;
    }
    this.#assertJob(task);
    const runs = this.runs(task).slice(0, MAX_ATTEMPTS);
    const eligible = runs.filter((run) => run.profileId === profileId && run.source === "cron"
      && run.sourceId === empty.jobId && TERMINAL.has(run.status));
    let run, text;
    if (runId) {
      run = eligible.find((item) => item.id === runId);
      if (!run) throw serviceError("MEMORY_IMPORT_REPORT_NOT_FOUND", "运行报告不存在");
      text = this.readRunReport(run);
    } else {
      // A retry can fail before producing an answer. Keep the preceding
      // analysis accessible and identify the attempt actually being shown.
      for (const candidate of [...eligible].reverse()) {
        const candidateText = this.readRunReport(candidate);
        run ??= candidate;
        if (typeof candidateText === "string" && candidateText.length) {
          run = candidate; text = candidateText; break;
        }
      }
    }
    if (!run) return empty;
    text = typeof text === "string" ? text : "";
    const reportHash = text ? crypto.createHash("sha256").update(text, "utf8").digest("hex") : null;
    if ((expectedHash !== null && expectedHash !== reportHash) || cursor > text.length
      || (cursor > 0 && /[\uDC00-\uDFFF]/u.test(text[cursor] || ""))) {
      throw serviceError("MEMORY_IMPORT_REPORT_CHANGED", "运行报告已变化，请重新读取");
    }
    let end = Math.min(text.length, cursor + limit);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    const line = text.trimStart().split(/\r?\n/u)[0];
    return { ...empty, runId: run.id, attempt: runs.findIndex((item) => item.id === run.id) + 1,
      runStatus: run.status, finishedAt: run.finishedAt ?? null,
      reportedOutcome: line === RESULT_OK ? "completed" : line === RESULT_FAILED ? "failed" : null,
      reportHash, text: text.slice(cursor, end), nextCursor: end < text.length ? end : null,
      hasMore: end < text.length };
  }
  jobId(task = this.store.get(this.profileId).task) {
    return task?.jobId || (task?.create ? this.cronStore.getOperation(task.create.operationId)?.result?.id : null);
  }
  runs(task) {
    const jobId = this.jobId(task);
    // WorkRun has no createdAt field. The dispatcher already returns durable
    // insertion order, also used by Cron's retry lineage validation.
    return jobId ? this.dispatcher.listRuns({ source: "cron", sourceId: jobId }) : [];
  }
  isSystemJob(jobId) {
    if (!jobId) return false;
    try { return this.jobId() === jobId; } catch { return false; }
  }
  #settle(state, reason = null) {
    this.store.mutate(this.profileId, (next) => ({ ...next, state, reason,
      completedAt: ["completed", "abandoned"].includes(state) ? this.now() : next.completedAt }));
    return this.status(this.profileId);
  }
  run() {
    if (!this.inFlight) this.inFlight = this.#run().catch((error) => {
      try { return this.#settle("failed", safeCode(error)); }
      catch { return this.status(this.profileId); }
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  #assertJob(task) {
    const job = this.cronStore.getJob(this.jobId(task));
    if (!job || JOB_IDENTITY_FIELDS.some((field) => JSON.stringify(job[field]) !== JSON.stringify(task.create[field]))) {
      throw serviceError("MEMORY_IMPORT_JOB_CHANGED", "系统导入任务绑定已变化");
    }
  }
  async #run() {
    let ledger = this.store.get(this.profileId);
    // Completed v1 imports and their provenance stay intact on upgrade.
    if (["completed", "abandoned"].includes(ledger.state)) return this.status(this.profileId);
    if (!ledger.task) {
      if (!this.isProfileReady(this.profileId)) return this.#settle("deferred", "MEMORY_IMPORT_PROFILE_UNAVAILABLE");
      const source = this.readSource("MEMORY.md");
      if (!source?.lines.some((line) => line.trim())) return this.#settle("no_source", "CODEX_MEMORY_NOT_FOUND");
      const createdAt = this.now();
      const create = { operationId: `codex-memory-import-${this.randomUUID()}`, name: "Codex memory import (system)",
        enabled: true, profileId: this.profileId, prompt: taskPrompt(source.path), workspace: null,
        schedule: { kind: "at", at: createdAt + 1 }, misfirePolicy: "latest", maxCatchUp: 1,
        overlapPolicy: "skip", threadPolicy: "continue", threadId: null, nextRunAt: createdAt + 1, createdAt };
      ledger = this.store.mutate(this.profileId, (next) => {
        next.task = { create, jobId: null, retry: null };
        next.sources = [{ name: source.name, sha256: source.sha256, lines: source.lines.length }];
        // Do not activate an unfinished proposal from the removed extractor.
        for (const chunk of Object.values(next.chunks)) if (["pending", "proposed"].includes(chunk.state)) {
          chunk.state = "skipped"; chunk.facts = null; chunk.reason = "IMPORT_FLOW_REPLACED";
        }
        next.state = "running"; next.reason = null; return next;
      });
    }
    if (!ledger.task.jobId) {
      // Recovery uses the frozen create request, including its original time.
      const job = this.cronStore.createJob(ledger.task.create);
      ledger = this.store.mutate(this.profileId, (next) => { next.task.jobId = job.id; return next; });
    }
    try { this.#assertJob(ledger.task); }
    catch (error) { return this.#settle("abandoned", safeCode(error)); }
    const runs = this.runs(ledger.task);
    const last = runs.at(-1);
    if (last?.status === "completed") return this.#settle("completed");
    if (last && TERMINAL.has(last.status)) {
      if (runs.length >= MAX_ATTEMPTS) return this.#settle("abandoned", last.errorCode || "MEMORY_IMPORT_TASK_FAILED");
      if (this.now() < (last.finishedAt ?? last.updatedAt) + RETRY_DELAY_MS) {
        return this.#settle("deferred", last.errorCode || "MEMORY_IMPORT_TASK_FAILED");
      }
      if (!ledger.task.retry) ledger = this.store.mutate(this.profileId, (next) => {
        next.task.retry = { operationId: `codex-memory-retry-${this.randomUUID()}`,
          jobId: next.task.jobId, retryOf: last.id, createdAt: this.now() }; return next;
      });
      await this.scheduler.retryRun(ledger.task.retry);
    } else if (!last) await this.scheduler.tick();
    return this.#settle("running");
  }
  completionError(run, report) {
    if (!this.isSystemJob(run.source === "cron" ? run.sourceId : null)) return null;
    try {
      const task = this.store.get(this.profileId).task;
      this.#assertJob(task);
      if (run.profileId !== this.profileId || !this.runs(task).slice(0, MAX_ATTEMPTS).some((item) => item.id === run.id)) {
        return "MEMORY_IMPORT_JOB_CHANGED";
      }
      const text = report || this.readRunReport(run);
      const line = typeof text === "string" ? text.trimStart().split(/\r?\n/u)[0] : "";
      if (line === RESULT_OK) return null;
      return line === RESULT_FAILED ? "MEMORY_IMPORT_TASK_FAILED" : "MEMORY_IMPORT_RESULT_MISSING";
    } catch (error) { return safeCode(error); }
  }
}
module.exports = { CodexMemoryImportService, TASK_PROMPT, PROMPT_NAME, taskPrompt, RETRY_DELAY_MS, RESULT_OK, RESULT_FAILED };
