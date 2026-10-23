"use strict";

const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_IDS = 8192;
const FIELDS = ["version", "seededProfileIds", "greetedProfileIds", "codexAutomationOwnerProfileId"];

function fail() {
  throw serviceError("BUILTIN_AGENT_STATE_UNAVAILABLE", "内置 Agent 状态不可用");
}

function idList(value) {
  if (!Array.isArray(value) || value.length > MAX_IDS
    || value.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(value).size !== value.length) fail();
  return [...value];
}

// Agent facts the Product Store does not keep, in one private atomic file:
// built-in CLI Agents that were ever created (a deleted one is never created
// again), Agents that already received their first greeting, and the Agent that
// currently owns the Codex desktop automations.
class BuiltinAgentState {
  constructor({ paths }) {
    this.paths = paths;
    this.filePath = path.join(paths.stateDir, "builtin-agent-state.json");
    this.data = null;
    // True when this installation had no record before this Service start.
    this.firstRun = false;
  }

  open() {
    if (this.data) return;
    if (recoverInterruptedPrivateFile(this.filePath, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail();
    if (!lstatIfExists(this.filePath)) {
      this.firstRun = true;
      this.data = { version: 1, seededProfileIds: [], greetedProfileIds: [], codexAutomationOwnerProfileId: null };
      return;
    }
    let value;
    try { value = JSON.parse(readPrivateFile(this.filePath, { maxBytes: 1024 * 1024 }).toString("utf8")); } catch { fail(); }
    const owner = value?.codexAutomationOwnerProfileId;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== FIELDS.length
      || !FIELDS.every((key) => Object.hasOwn(value, key)) || value.version !== 1
      || !(owner === null || (typeof owner === "string" && ID.test(owner)))) fail();
    this.data = { version: 1, seededProfileIds: idList(value.seededProfileIds),
      greetedProfileIds: idList(value.greetedProfileIds), codexAutomationOwnerProfileId: owner };
  }

  get opened() { return this.data !== null; }

  isSeeded(profileId) { return this._read().seededProfileIds.includes(profileId); }

  isGreeted(profileId) { return this._read().greetedProfileIds.includes(profileId); }

  codexAutomationOwner() { return this._read().codexAutomationOwnerProfileId; }

  markSeeded(profileIds) { this._add("seededProfileIds", profileIds); }

  markGreeted(profileIds) { this._add("greetedProfileIds", profileIds); }

  setCodexAutomationOwner(profileId) {
    const data = this._read();
    if (profileId !== null && (typeof profileId !== "string" || !ID.test(profileId))) fail();
    if (data.codexAutomationOwnerProfileId !== profileId) this._save({ ...data, codexAutomationOwnerProfileId: profileId });
  }

  _read() {
    if (!this.data) fail();
    return this.data;
  }

  _add(field, profileIds) {
    const data = this._read();
    const added = [...new Set(profileIds)].filter((id) => !data[field].includes(id));
    if (added.length > 0) this._save({ ...data, [field]: idList([...data[field], ...added]) });
  }

  _save(next) {
    atomicWritePrivateFile(this.filePath, `${JSON.stringify(next)}\n`, { trustedRoot: this.paths.trustedRoot });
    this.data = next;
  }
}

module.exports = { BuiltinAgentState };
