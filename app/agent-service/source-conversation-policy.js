"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, recoverInterruptedPrivateFile } = require("./private-file");
const { lstatIfExists, serviceError } = require("./security");
const { isDeepStrictEqual } = require("node:util");
const fail = () => { throw serviceError("SOURCE_CONVERSATION_INVALID", "来源会话的策略或归属不匹配"); };
const text = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
function sourceConversationPolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, "value"))
    || !["new-each-run", "dedicated", "explicit"].includes(value.mode)
    || Reflect.ownKeys(value).sort().join() !== (value.mode === "explicit" ? "mode,sessionKey" : "mode")
    || (value.mode === "explicit" && !text(value.sessionKey))) fail();
  return Object.freeze({ ...value });
}
function sourcePolicyForRun(run, { threadPolicy = "new", sessionKey = null } = {}) {
  return sourceConversationPolicy(sessionKey ? { mode: "explicit", sessionKey }
    : { mode: run.source === "inspiration" || (run.source === "cron" && threadPolicy === "continue") ? "dedicated" : "new-each-run" });
}

// Cron and Inspiration keep their existing authoritative associations. This
// store supplies the missing Kanban association without re-owning those records.
class SourceConversationStore {
  constructor({ paths, chatSessionStore, now = Date.now }) {
    this.paths = paths; this.sessions = chatSessionStore; this.now = now;
    this.file = path.join(paths.stateDir, "source-conversations-v1.json"); this.records = null;
  }
  #load() {
    if (this.records) return;
    if (recoverInterruptedPrivateFile(this.file, { trustedRoot: this.paths.trustedRoot }) === "uncertain") fail();
    let records = {};
    if (lstatIfExists(this.file)) {
      const data = JSON.parse(readPrivateFile(this.file, { maxBytes: 32 * 1024 * 1024 }));
      if (!data || Object.keys(data).sort().join() !== "records,version" || data.version !== 1
        || !data.records || Object.getPrototypeOf(data.records) !== Object.prototype || Object.keys(data.records).length > 65536) fail();
      for (const [id, item] of Object.entries(data.records)) {
        if (!item || Object.keys(item).sort().join() !== "createdAt,policy,profileId,runId,sessionKey,source,sourceId,workspace"
          || item.runId !== id || ![id, item.profileId, item.sourceId, item.sessionKey].every(text) || item.source !== "kanban"
          || !(item.workspace === null || (typeof item.workspace === "string" && path.isAbsolute(item.workspace)))
          || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) fail();
        sourceConversationPolicy(item.policy);
      }
      records = data.records;
    }
    this.records = records;
  }
  get(runId) { this.#load(); return structuredClone(this.records[runId] || null); }
  ensure(run, policy = sourcePolicyForRun(run)) {
    this.#load(); policy = sourceConversationPolicy(policy);
    if (run.source !== "kanban" || ![run.id, run.profileId, run.sourceId].every(text)) fail();
    const prior = this.get(run.id);
    if (prior) {
      if (["source", "sourceId", "profileId", "workspace"].some(key => prior[key] !== run[key]) || !isDeepStrictEqual(policy, prior.policy)) fail();
      return this.sessions.getSession(prior.sessionKey); // A deleted session stays deleted.
    }
    let session = policy.mode === "explicit" ? this.sessions.getSession(policy.sessionKey) : null;
    if (policy.mode === "explicit" && !session) fail();
    if (policy.mode === "dedicated") session = Object.values(this.records).filter(item => item.source === run.source
      && item.sourceId === run.sourceId && item.profileId === run.profileId && item.workspace === run.workspace)
      .sort((a, b) => b.createdAt - a.createdAt).map(item => this.sessions.getSession(item.sessionKey))
      .find(item => item && ["draft", "ready"].includes(item.status)) || null;
    if (session && (session.profileId !== run.profileId || session.workspace !== run.workspace || !["draft", "ready"].includes(session.status))) fail();
    if (Object.keys(this.records).length >= 65536) throw serviceError("CHAT_SESSION_CAPACITY", "来源会话关联已满");
    if (!session) {
      const operationId = `source-session-${crypto.createHash("sha256").update(`${run.source}:${run.id}`).digest("hex")}`;
      const operation = this.sessions.getCreateOperation(operationId);
      if (operation?.state === "deleted") return null;
      session = this.sessions.createSession({ operationId, profileId: run.profileId, workspace: run.workspace,
        createdAt: operation?.createdAt ?? this.now() });
    }
    const item = { runId: run.id, source: run.source, sourceId: run.sourceId, profileId: run.profileId,
      workspace: run.workspace, sessionKey: session.sessionKey, policy, createdAt: this.now() };
    const records = { ...this.records, [run.id]: item };
    const bytes = `${JSON.stringify({ version: 1, records })}\n`;
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw serviceError("CHAT_SESSION_CAPACITY", "来源会话关联已满");
    atomicWritePrivateFile(this.file, bytes, { trustedRoot: this.paths.trustedRoot }); this.records = records;
    return session;
  }
  purgeProfile(profileId) {
    this.#load(); const records = Object.fromEntries(Object.entries(this.records).filter(([, item]) => item.profileId !== profileId));
    atomicWritePrivateFile(this.file, `${JSON.stringify({ version: 1, records })}\n`, { trustedRoot: this.paths.trustedRoot }); this.records = records;
  }
}
module.exports = { SourceConversationStore, sourceConversationPolicy, sourcePolicyForRun };
