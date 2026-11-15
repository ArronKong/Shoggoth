"use strict";

const { createHash } = require("node:crypto");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { TranscriptStore, transcriptEventId } = require("./transcript-store");
const { cronFinalAnswer, validCronOutput } = require("./cron-output-policy");

const REBUILD_BATCH = 24;
const MAX_BASELINES = 4096;
const MAX_BASELINE_BYTES = 16 * 1024 * 1024;
const READ_BUDGET_MS = 2000;
const after = (a, b) => a.finishedAt > b.finishedAt || (a.finishedAt === b.finishedAt && a.id > b.id);
const digest = text => createHash("sha256").update(text).digest("hex");
const deliverable = event => event && !event.contextExcluded && event.content?.transcriptType === "terminal"
  && validCronOutput(event.content.cronOutput) && event.content.cronOutput.disposition === "deliver";

function inspectReport(transcripts, { profileId, sessionId, id }) {
  const rawTerminal = transcripts.getEvent(profileId, sessionId, transcriptEventId("chat-terminal", id, "completed"));
  if (rawTerminal?.runId !== id || rawTerminal.contextExcluded) return null;
  const terminal = transcripts.displayEvent(profileId, sessionId, rawTerminal);
  if (!deliverable(terminal)) return null;
  const answer = cronFinalAnswer(transcripts.runEventsView(profileId, sessionId, id).filter(event => !event.contextExcluded),
    event => transcripts.displayEvent(profileId, sessionId, event));
  const text = answer?.content.text;
  if (!text?.trim()) return null;
  const source = transcripts.cachedJournalIdentity(profileId, sessionId);
  if (!source) return undefined;
  const event = transcripts.getCachedEvent(profileId, sessionId, answer.id);
  if (!event) return undefined;
  if (event.contextExcluded) return null;
  return { event: eventEvidence(event), terminalId: terminal.id, source,
    bytes: Buffer.byteLength(text), digest: digest(text) };
}

function eventEvidence(event) {
  const { id, kind, runId, contextExcluded } = event;
  const { text, displayRef } = event.content;
  return { id, kind, runId, contextExcluded, content: displayRef ? { displayRef } : { text } };
}

class CronReportIndex {
  constructor({ paths, products, transcripts, jobs, sessionForRun, hasPublished }) {
    Object.assign(this, { paths, products, transcripts, jobs, sessionForRun, hasPublished });
    this.entries = new Map();
    this.entryBytes = 0;
    this.waitingForRebuild = false;
    this.incomplete = new Map();
  }

  binding(run) {
    const job = this.jobs.getJob(run.sourceId);
    if (!job || job.profileId !== run.profileId || run.finishedAt < job.createdAt) return null;
    const groupId = job.groupDelivery?.groupId ?? null;
    return { groupId, scope: JSON.stringify([run.sourceId, run.profileId, run.workspace, job.createdAt,
      job.groupDelivery ? [job.groupDelivery.ownerScope, groupId, job.groupDelivery.memberId] : null]) };
  }

  candidate(run) {
    if (run.source !== "cron" || run.status !== "completed" || !Number.isSafeInteger(run.finishedAt)) return null;
    const binding = this.binding(run);
    if (!binding) return null;
    if (binding.groupId && !this.hasPublished({ groupId: binding.groupId, jobId: run.sourceId, runId: run.id })) return null;
    const sessionId = this.sessionForRun(run);
    return sessionId ? { ...binding, id: run.id, profileId: run.profileId, sessionId, finishedAt: run.finishedAt } : null;
  }

  record(run, { terminal, answer } = {}) {
    // Call only after the terminal append (direct) or group publish transaction.
    let candidate;
    try {
      candidate = this.candidate(run);
      if (!candidate) return;
      const previous = this.entries.get(candidate.scope);
      if (previous && !after(candidate, previous)) return;
      const report = this.inspect(run, candidate.sessionId, terminal, answer);
      if (report) this.insert(candidate, report);
      else if (report === undefined) this.markIncomplete(candidate);
    } catch {
      // An unreadable newer publication prevents matching against an older
      // report. A future verified publication can establish a new baseline.
      if (candidate) { try { this.markIncomplete(candidate); } catch {} }
    }
  }

  insert(candidate, report, fromRebuild = false) {
    const previous = this.entries.get(candidate.scope), unfinished = this.incomplete.get(candidate.scope);
    if (!previous || after(candidate, previous)) {
      this.remove(candidate.scope);
      const memoryBytes = Buffer.byteLength(JSON.stringify(report.event));
      this.entries.set(candidate.scope, { ...candidate, ...report, memoryBytes, fromRebuild });
      this.entryBytes += memoryBytes;
      while (this.entries.size > MAX_BASELINES || this.entryBytes > MAX_BASELINE_BYTES) {
        this.remove(this.entries.keys().next().value);
      }
    }
    if (unfinished && after(candidate, unfinished)) this.incomplete.delete(candidate.scope);
  }

  remove(key) {
    this.entryBytes -= this.entries.get(key)?.memoryBytes ?? 0;
    this.entries.delete(key);
  }

  markIncomplete(candidate) {
    const previous = this.entries.get(candidate.scope), unresolved = this.incomplete.get(candidate.scope);
    if ((!previous || after(candidate, previous)) && (!unresolved || after(candidate, unresolved))) {
      this.incomplete.set(candidate.scope, candidate);
      if (this.incomplete.size > MAX_BASELINES) {
        // Lose optimization rather than evict a negative witness and fall
        // back to an older report for that scope.
        this.entries.clear();
        this.entryBytes = 0;
        this.incomplete.clear();
        throw new Error("Cron report index exceeds incomplete scope limit");
      }
    }
  }

  inspect(run, sessionId, terminal, answer) {
    const text = answer?.content?.text;
    if (!terminal || !answer) return inspectReport(this.transcripts, { profileId: run.profileId, sessionId, id: run.id });
    const displayTerminal = this.transcripts.displayEvent(run.profileId, sessionId, terminal);
    if (!deliverable(displayTerminal) || answer.runId !== run.id || answer.contextExcluded || !text?.trim()) return null;
    const source = this.transcripts.cachedJournalIdentity(run.profileId, sessionId);
    const event = source && this.transcripts.getCachedEvent(run.profileId, sessionId, answer.id);
    return event ? { event: eventEvidence(event), terminalId: terminal.id, source,
      bytes: Buffer.byteLength(text), digest: digest(text) } : undefined;
  }

  matches(run, text) {
    try {
      const binding = this.binding(run);
      const previous = binding && this.entries.get(binding.scope);
      if (!previous || this.waitingForRebuild || this.incomplete.has(binding.scope) || !after(run, previous)
        || Buffer.byteLength(text) !== previous.bytes || digest(text) !== previous.digest) return false;
      if (previous.groupId && !this.hasPublished({ groupId: previous.groupId, jobId: run.sourceId, runId: previous.id })) return false;
      const priorRun = this.products.getWorkRun(previous.id);
      if (!priorRun || priorRun.status !== "completed" || priorRun.finishedAt !== previous.finishedAt
        || this.binding(priorRun)?.scope !== binding.scope || this.sessionForRun(priorRun) !== previous.sessionId) return false;
      const { profileId, sessionId } = previous;
      const terminal = this.transcripts.getCachedEvent(profileId, sessionId, previous.terminalId);
      let event;
      if (terminal === undefined) {
        // A cold, previously verified journal is safe only if the entire
        // source identity is still exact. Never load a cold journal here.
        if (!this.transcripts.hasJournalIdentity(profileId, sessionId, previous.source)) return false;
        event = previous.event;
      } else {
        if (terminal?.runId !== previous.id || terminal.contextExcluded
          || !deliverable(this.transcripts.displayEvent(profileId, sessionId, terminal))) return false;
        event = this.transcripts.getCachedEvent(profileId, sessionId, previous.event.id);
        if (event?.runId !== previous.id || event.kind !== "assistant" || event.contextExcluded) return false;
      }
      const equal = this.transcripts.displayEvent(profileId, sessionId, event).content.text === text;
      return equal && (terminal !== undefined || this.transcripts.hasJournalIdentity(profileId, sessionId, previous.source));
    } catch { return false; }
  }

  rebuild() {
    if (this.current || typeof this.products.iterateWorkRuns !== "function") return this.current?.promise;
    this.waitingForRebuild = true;
    const flight = {};
    this.current = flight;
    flight.promise = this.scan(flight).catch(() => {}).finally(() => {
      if (this.current === flight) this.current = null;
    });
    return flight.promise;
  }

  async scan(flight) {
    try {
      const iterator = this.products.iterateWorkRuns();
      while (this.current === flight) {
        await new Promise(resolve => setImmediate(resolve));
        if (this.current !== flight) return;
        const batch = [];
        let done = false;
        for (let i = 0; i < REBUILD_BATCH; i++) {
          const next = iterator.next();
          if (next.done) { done = true; break; }
          const candidate = this.candidate(next.value);
          if (!candidate) continue;
          const previous = this.entries.get(candidate.scope);
          if (!previous || after(candidate, previous)) batch.push(candidate);
        }
        if (batch.length) {
          const results = await this.readBatch(flight, batch);
          if (this.current !== flight) return;
          for (const [index, report] of results.entries()) {
            const candidate = batch[index];
            if (report) this.insert(candidate, report, true);
            else if (report === undefined) this.markIncomplete(candidate);
          }
        }
        if (done) { this.waitingForRebuild = false; return; }
      }
    } catch {
      // Discard partial historical results after a reader failure. Newly
      // delivered reports can establish a fresh baseline without history.
      if (this.current === flight) {
        for (const [key, value] of this.entries) if (value.fromRebuild) this.remove(key);
        this.incomplete.clear();
        this.waitingForRebuild = false;
      }
    } finally {
      await flight.worker?.terminate().catch(() => {});
    }
  }

  readBatch(flight, batch) {
    if (!flight.worker) {
      flight.worker = new Worker(__filename, { resourceLimits: { maxOldGenerationSizeMb: 160 },
        workerData: { cronReportReader: true, paths: {
          trustedRoot: this.paths.trustedRoot, agentsDir: this.paths.agentsDir,
        } },
      });
      // Termination between requests can still emit an asynchronous error.
      flight.worker.on("error", () => {});
    }
    const { worker } = flight;
    return new Promise((resolve, reject) => {
      const complete = (error, results) => {
        clearTimeout(timer);
        worker.off("message", replied);
        worker.off("exit", failed);
        worker.off("error", failed);
        if (error) reject(error); else resolve(results);
      };
      const replied = results => complete(null, results);
      const failed = () => complete(new Error("Cron report index reader stopped"));
      const timer = setTimeout(failed, READ_BUDGET_MS);
      worker.once("message", replied);
      worker.once("exit", failed);
      worker.once("error", failed);
      try { worker.postMessage(batch); } catch { failed(); }
    });
  }

  async close() {
    const flight = this.current;
    this.current = null;
    this.entries.clear();
    this.entryBytes = 0;
    this.incomplete.clear();
    this.waitingForRebuild = false;
    await flight?.worker?.terminate().catch(() => {});
    await flight?.promise;
  }
}

if (!isMainThread && workerData?.cronReportReader === true) {
  const transcripts = new TranscriptStore({ paths: workerData.paths, readOnly: true });
  transcripts.openReadOnly();
  parentPort.on("message", batch => {
    const results = batch.map(candidate => {
      try { return inspectReport(transcripts, candidate); }
      catch { return undefined; }
    });
    parentPort.postMessage(results);
  });
}

module.exports = { CronReportIndex };
