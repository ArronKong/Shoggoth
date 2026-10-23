"use strict";
const crypto = require("node:crypto");
const { OWNER, ACCOUNT_ID } = require("../agent-service/codex-automation-store");
const { MESSAGES } = require("../agent-service/codex-automation-protocol");
function error(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
const isCodexAutomationId = id => typeof id === "string" && /^codex-automation:[a-f0-9]{24}:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id);
// The Service elects the owner; `undefined` means it has not been asked yet,
// and the first-generated Codex Agent is assumed until then.
const automationOwnerId = facade => facade._codexAutomationOwnerId === undefined ? OWNER.id : facade._codexAutomationOwnerId;
class CodexAutomationBackend {
  constructor(facade) { this.facade = facade; }
  owner() {
    const profile = this.facade._profilesById.get(automationOwnerId(this.facade));
    if (this.facade.id !== OWNER.backendId || !profile || profile.runtime !== "codex" || profile.runtimeAccountId !== ACCOUNT_ID) throw error("CODEX_AUTOMATION_OWNER_UNAVAILABLE");
    return profile;
  }
  call(name, params) { const profile = this.owner(); return this.facade._call(`codex.automation.${name}`, { profileId: profile.id, ...params }); }
  source() { return this.facade._call("codex.automation.source", { backendId: this.facade.id }); }
  async list(includePrompt = false) {
    const jobs = []; let offset = 0;
    for (let page = 0; page < 52; page += 1) {
      const result = await this.call("list", { offset, limit: 20 }); jobs.push(...result.jobs);
      if (result.nextOffset === null) {
        if (includePrompt) for (const job of jobs) job.prompt = await this.content(job, "prompt", null, job.revision);
        return jobs;
      }
      if (result.nextOffset <= offset) throw error("CODEX_AUTOMATION_RESPONSE_INVALID");
      offset = result.nextOffset;
    }
    throw error("CODEX_AUTOMATION_CAPACITY");
  }
  async content(job, field, runId, revision) {
    let text = "", offset = 0;
    for (let page = 0; page < 2800; page += 1) {
      const result = await this.call("content.read", { id: job.id, field, runId, revision, offset, limit: 6000 });
      if (result.revision !== revision) throw error("CODEX_AUTOMATION_CONFLICT");
      text += result.content;
      if (result.nextOffset === null) return text;
      if (result.nextOffset <= offset || text.length > 16 * 1024 * 1024) throw error("CODEX_AUTOMATION_CAPACITY");
      offset = result.nextOffset;
    }
    throw error("CODEX_AUTOMATION_CAPACITY");
  }
  async get(id, includePrompt = false) {
    const { job } = await this.call("get", { id });
    const owner = this.owner();
    if (job.id !== id || job.ownerProfileId !== owner.id || job.agentId !== owner.agentId) throw error("CODEX_AUTOMATION_RESPONSE_INVALID");
    if (includePrompt) job.prompt = await this.content(job, "prompt", null, job.revision);
    return job;
  }
  async create(input) {
    const owner = this.owner();
    if (input.agentId !== owner.agentId || input.backendId !== owner.backendId || input.origin !== "codex-desktop") throw error("CODEX_AUTOMATION_OWNER_UNAVAILABLE");
    const allowed = new Set(["backendId", "agentId", "origin", "name", "prompt", "schedule", "model", "reasoningEffort", "enabled", "kind", "cwd", "executionEnvironment", "targetThreadId", "operationId"]);
    if (Object.keys(input).some(key => !allowed.has(key)) || input.schedule?.kind !== "rrule") throw error("CODEX_AUTOMATION_PARAMS_INVALID");
    const { backendId, agentId, origin, schedule, operationId, ...spec } = input;
    return (await this.call("create", { operationId: operationId || crypto.randomUUID(), spec: { ...spec, rrule: schedule.rrule } })).job;
  }
  async update(id, input) {
    const allowed = new Set(["revision", "origin", "name", "prompt", "schedule", "model", "reasoningEffort", "enabled", "cwd", "executionEnvironment", "targetThreadId"]);
    if (Object.keys(input).some(key => !allowed.has(key)) || (input.schedule && input.schedule.kind !== "rrule")) throw error("CODEX_AUTOMATION_PARAMS_INVALID");
    const { revision, origin, schedule, ...patch } = input;
    if (schedule) patch.rrule = schedule.rrule;
    const job = revision ? null : await this.get(id);
    return (await this.call("update", { id, revision: revision || job.revision, patch })).job;
  }
  async run(id, mode, options = {}) {
    if (mode && mode !== "force") throw error("CODEX_AUTOMATION_RUN_UNSUPPORTED");
    const job = options.revision ? null : await this.get(id);
    return this.call("run", { id, revision: options.revision || job.revision, operationId: options.operationId || crypto.randomUUID() });
  }
  async runs(id, options = {}) {
    return this.call("runs.list", { id, offset: Number.isSafeInteger(options.offset) ? options.offset : 0,
      limit: Math.min(20, Math.max(1, options.limit || 20)) });
  }
  models() { return this.call("models.list", {}); }
  async result(id, runId) {
    const value = await this.call("runs.result", { id, runId });
    const fullText = value.available ? await this.content({ id }, "result", runId, value.contentRevision) : null;
    return { ...value, fullText };
  }
  control(id, input) { return this.call("runs.control", { id, ...input }); }
  async runForOccurrence(id, atMs) {
    const job = await this.get(id);
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: job.schedule.tz,
      year: "numeric", month: "2-digit", day: "2-digit" });
    const day = ms => {
      const parts = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const targetDay = day(atMs);
    let best = null, bestDelta = Infinity, offset = 0;
    // Desktop records actual start times, not the planned occurrence. It can
    // start early or catch up hours late. Match the closest run on the same
    // schedule-local day, paging until that day's complete history is seen.
    for (let page = 0; page < 256; page += 1) {
      const { runs, nextOffset, sourceError } = await this.runs(id, { offset, limit: 20 });
      if (sourceError) throw error(sourceError);
      for (const run of runs) {
        const runDay = day(run.startedAt);
        if (runDay < targetDay) return best;
        const delta = Math.abs(run.startedAt - atMs);
        if (runDay === targetDay && delta < bestDelta) { best = run; bestDelta = delta; }
      }
      if (nextOffset === null) return best;
      if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw error("CODEX_AUTOMATION_RESPONSE_INVALID");
      offset = nextOffset;
    }
    // An incomplete search must not masquerade as a day without output.
    throw error("CODEX_AUTOMATION_CAPACITY");
  }
  async latest(id, atMs) {
    let run;
    if (Number.isFinite(atMs)) run = await this.runForOccurrence(id, atMs);
    else {
      const { runs, sourceError } = await this.runs(id);
      if (sourceError) throw error(sourceError);
      run = runs[0];
    }
    if (!run) return { supported: true, available: false, hasRun: false, fullText: null, source: "none" };
    const result = await this.result(id, run.runId);
    return { ...result, supported: true, hasRun: true,
      source: result.fullText ? "transcript" : result.summary ? "summary" : "none" };
  }
}
const isCodexAutomationOwner = (profile, ownerId = OWNER.id) => profile?.id === ownerId && profile.backendId === OWNER.backendId
  && profile.runtime === "codex" && profile.runtimeAccountId === ACCOUNT_ID;
module.exports = { CodexAutomationBackend, isCodexAutomationId, isCodexAutomationOwner };
