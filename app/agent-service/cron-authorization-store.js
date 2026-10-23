"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile, statIfExists } = require("./private-file");
const { serviceError } = require("./security");
const { cronAuthorizationDigest: digest } = require("./cron-approval-policy");

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JOBS = 4096;
const MAX_GRANTS_PER_JOB = 256;
const HASH = /^[a-f0-9]{64}$/u;
const validHash = value => typeof value === "string" && HASH.test(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const validId = value => typeof value === "string" && ID.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join() === [...keys].sort().join();
const fail = code => { throw serviceError(code, "定时任务授权记录不可用或已变化"); };

// Scheduler watermarks, names and enabled/paused state do not expand authority.
// Definition edits revoke before the job write, including an edit later reverted.
function cronDefinitionDigest(job) {
  return digest([job.id, job.profileId, job.createdAt, job.prompt, job.workspace,
    job.schedule, job.threadPolicy, job.threadId, job.misfirePolicy, job.maxCatchUp, job.overlapPolicy]);
}
function validCronAuthorizationScope(scope) {
  return exact(scope, ["version", "jobId", "profileId", "epoch", "definitionDigest"])
    && scope.version === 1 && validId(scope.jobId) && validId(scope.profileId)
    && Number.isSafeInteger(scope.epoch) && scope.epoch > 0 && validHash(scope.definitionDigest);
}
function validate(value) {
  if (!exact(value, ["version", "jobs"]) || value.version !== 1
    || !value.jobs || Object.getPrototypeOf(value.jobs) !== Object.prototype
    || Object.keys(value.jobs).length > MAX_JOBS) fail("CRON_AUTHORIZATION_CORRUPT");
  for (const [id, row] of Object.entries(value.jobs)) {
    if (!validId(id) || !exact(row, ["scope", "grants"]) || !validCronAuthorizationScope(row.scope)
      || row.scope.jobId !== id || !row.grants || Object.getPrototypeOf(row.grants) !== Object.prototype
      || Object.keys(row.grants).length > MAX_GRANTS_PER_JOB) fail("CRON_AUTHORIZATION_CORRUPT");
    for (const [key, grant] of Object.entries(row.grants)) {
      if (!validHash(key) || !exact(grant, ["approvedAt", "runId"])
        || !Number.isSafeInteger(grant.approvedAt) || grant.approvedAt < 0 || !validId(grant.runId)) fail("CRON_AUTHORIZATION_CORRUPT");
    }
  }
  return value;
}

// Owned by NativeCronStore's writer lease. Only the Service can mint a grant;
// this file contains hashes/receipts, never commands, credentials or user input.
class CronAuthorizationStore {
  constructor({ paths, fs: fileSystem = fs, atomicWrite = atomicWritePrivateFile }) {
    this.paths = paths;
    this.fs = fileSystem;
    this.atomicWrite = atomicWrite;
    this.file = path.join(paths.stateDir, "cron-authorizations-v1.json");
    this.close();
  }
  open() {
    if (recoverInterruptedPrivateFile(this.file, { fs: this.fs, trustedRoot: this.paths.trustedRoot }) === "uncertain") {
      fail("STORE_COMMIT_UNCERTAIN");
    }
    try {
      this.state = statIfExists(this.fs, this.file)
        ? validate(JSON.parse(readPrivateFile(this.file, { fs: this.fs, maxBytes: MAX_BYTES }))) : { version: 1, jobs: {} };
    } catch (error) {
      if (error?.code?.startsWith("UNSAFE_")) throw error;
      fail("CRON_AUTHORIZATION_CORRUPT");
    }
    this.opened = true;
    this.uncertain = false;
  }
  close() { this.opened = false; this.uncertain = false; this.state = { version: 1, jobs: {} }; }
  #assertOpen() {
    if (this.uncertain) fail("STORE_COMMIT_UNCERTAIN");
    if (!this.opened) fail("CRON_AUTHORIZATION_CLOSED");
  }
  #write(candidate) {
    this.#assertOpen();
    validate(candidate);
    const bytes = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail("CRON_AUTHORIZATION_CAPACITY");
    try { this.atomicWrite(this.file, bytes, { fs: this.fs, trustedRoot: this.paths.trustedRoot }); }
    catch (error) {
      if (error?.committed === true) { this.state = candidate; return; }
      if (error?.committedUncertain === true) { this.uncertain = true; fail("STORE_COMMIT_UNCERTAIN"); }
      throw error;
    }
    this.state = candidate;
  }
  scope(job) {
    this.#assertOpen();
    const definitionDigest = cronDefinitionDigest(job), previous = this.state.jobs[job.id];
    if (previous?.scope.definitionDigest === definitionDigest) return structuredClone(previous.scope);
    const scope = { version: 1, jobId: job.id, profileId: job.profileId,
      epoch: (previous?.scope.epoch || 0) + 1, definitionDigest };
    if (!previous && Object.keys(this.state.jobs).length >= MAX_JOBS) fail("CRON_AUTHORIZATION_CAPACITY");
    this.#write({ version: 1, jobs: { ...this.state.jobs, [job.id]: { scope, grants: {} } } });
    return structuredClone(scope);
  }
  invalidateChanges(previousJobs, jobs) {
    this.#assertOpen();
    let candidate = null;
    for (const [id, previous] of Object.entries(previousJobs)) {
      if (!this.state.jobs[id] || (jobs[id] && cronDefinitionDigest(previous) === cronDefinitionDigest(jobs[id]))) continue;
      candidate ||= structuredClone(this.state);
      if (!jobs[id]) delete candidate.jobs[id];
      else candidate.jobs[id] = { scope: { ...candidate.jobs[id].scope,
        epoch: candidate.jobs[id].scope.epoch + 1, definitionDigest: cronDefinitionDigest(jobs[id]) }, grants: {} };
    }
    if (candidate) this.#write(candidate);
  }
  matches(scope, job) {
    this.#assertOpen();
    return validCronAuthorizationScope(scope) && !!job && job.id === scope.jobId
      && job.profileId === scope.profileId && cronDefinitionDigest(job) === scope.definitionDigest
      && digest(this.state.jobs[job.id]?.scope ?? null) === digest(scope);
  }
  has(scope, job, key) {
    return validHash(key) && this.matches(scope, job) && Object.hasOwn(this.state.jobs[job.id].grants, key);
  }
  remember(scope, job, key, { runId, approvedAt }) {
    if (!validHash(key) || !validId(runId) || !Number.isSafeInteger(approvedAt) || approvedAt < 0
      || !this.matches(scope, job)) fail("CRON_AUTHORIZATION_STALE");
    if (this.has(scope, job, key)) return;
    const candidate = structuredClone(this.state), grants = candidate.jobs[job.id].grants;
    if (Object.keys(grants).length >= MAX_GRANTS_PER_JOB) fail("CRON_AUTHORIZATION_CAPACITY");
    grants[key] = { runId, approvedAt };
    this.#write(candidate);
  }
}

module.exports = { CronAuthorizationStore, cronDefinitionDigest, validCronAuthorizationScope, cronAuthorizationDigest: digest };
