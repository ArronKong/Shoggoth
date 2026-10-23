"use strict";

const { isGroupChatRun } = require("../group-chat-run");
const { isHistoricalChatSession } = require("../historical-chat-session");
const { isBorrowedMemoryDerived, extractBorrowedMemoryRefs } = require("../shoggoth-memory/borrowed-memory-provenance.cjs");
const { isUiActionSubmission } = require("../ui-input-provenance");
const { hasSecret } = require("../memory-engine");
const { digest, fail, LIMITS, text } = require("./protocol");

const DERIVED_TOOLS = /^(?:skill_|learning_|memory_|conversation_|proactive_|heartbeat_|federation_|group_|plugin_resource_read|runtime_context_get|app_help_get)/iu;
function derivedTool(tool) {
  let name = tool.name || tool.kind;
  if (/^(?:call_mcp_tool|use_tool|callmcptool|usetool|mcptoolcall)$/iu.test(name || "")) {
    name = tool.displayArgs?.toolName || tool.displayArgs?.tool_name;
    if (!name) return true; // An unidentified wrapper is not verification evidence.
  }
  return DERIVED_TOOLS.test(String(name).split(/__|[/:.]/u).at(-1));
}
const CORRECTION = /(?:以后|下次|记住|不要再|别再|应该先|正确的做法|请改成)|\b(?:next time|remember to|instead of|you should|correction)\b/iu;
const LEARNING_REQUEST = /(?:请|帮我)(?:把.{0,20})?(?:记住|学会|学习|保存|提炼).{0,24}(?:方法|流程|技能)|\b(?:learn|save|remember)\s+(?:this|the)\s+(?:method|procedure|skill)\b/iu;
const FOREGROUND = new Set(["queued", "starting", "running", "waiting_input", "waiting_approval"]);

class LearningSources {
  constructor({ products, sessions, transcripts, recall, getCoordinator, assertSessionCurrent }) {
    this.products = products; this.sessions = sessions; this.transcripts = transcripts;
    this.recall = recall; this.getCoordinator = getCoordinator; this.assertSessionCurrent = assertSessionCurrent;
  }
  activeRuns(profileId = null) {
    return this.products.listWorkRuns(profileId ? { profileId } : {}).filter(run => FOREGROUND.has(run.status));
  }
  eligibleRun(run) {
    return run && ["chat", "inspiration"].includes(run.source) && !isGroupChatRun(run)
      && !/^shoggoth:chat-send:federation-/u.test(run.idempotencyKey || "");
  }
  readRun(profileId, runId) {
    const profile = this.products.getAgentProfile(profileId), run = this.products.getWorkRun(runId);
    if (!profile?.enabled) fail("LEARNING_PROFILE_UNAVAILABLE");
    if (!run || !this.eligibleRun(run) || run.profileId !== profileId) fail("LEARNING_SOURCE_REVOKED");
    if (run.status !== "completed") fail("LEARNING_SOURCE_UNAVAILABLE");
    const sessionKey = this.getCoordinator().getRunSessionKey(run);
    const session = sessionKey && this.sessions.getSession(sessionKey);
    if (!session || session.profileId !== profileId || !isHistoricalChatSession(session)
      || session.workspace !== run.workspace || this.sessions.getCronSessionOrigin?.(sessionKey)) fail("LEARNING_SOURCE_REVOKED");
    this.assertSessionCurrent(profileId, session.id);
    const revision = this.transcripts.getRevision(profileId, session.id);
    const raw = this.transcripts.listEvents(profileId, session.id).filter(event => event.runId === runId);
    if (!raw.length || raw.length > 512) fail("LEARNING_SOURCE_UNAVAILABLE");
    if (raw.some(event => isBorrowedMemoryDerived(event)
      || extractBorrowedMemoryRefs(event).length || isUiActionSubmission(event))) fail("LEARNING_SOURCE_REVOKED");
    const dialogue = [];
    // The existing recall policy is authoritative for both historical visibility
    // and the owning direct task. A model's claim is never an admission receipt.
    let afterSeq = Math.max(0, Math.min(...raw.map(event => event.seq)) - 1);
    const lastSeq = Math.max(...raw.map(event => event.seq));
    for (let pageIndex = 0; pageIndex < 64 && afterSeq < lastSeq; pageIndex += 1) {
      const page = this.recall.scanEligibleSession({ profileId, sessionId: session.id, afterSeq, limit: 100, completedOnly: true });
      for (const event of page.events) if (event.runId === runId) {
        this.recall.assertCandidateSourceCurrent(profileId, event);
        dialogue.push({ runId, eventId: event.eventId, sessionId: session.id, seq: event.seq,
          kind: event.kind, text: event.text, contentHash: digest(event.text) });
      }
      if (page.throughSeq <= afterSeq) fail("LEARNING_SOURCE_UNAVAILABLE");
      afterSeq = page.throughSeq;
      if (!page.hasMore) break;
    }
    const user = dialogue.filter(event => event.kind === "user"), assistant = dialogue.filter(event => event.kind === "assistant");
    // A withdrawn part of a run cannot survive through an unfiltered tool log.
    const visibleIds = new Set(dialogue.map(event => event.eventId));
    if (raw.some(event => ["user", "assistant"].includes(event.kind)
      && typeof event.content?.text === "string" && event.content.text.trim() && !visibleIds.has(event.id))) fail("LEARNING_SOURCE_REVOKED");
    if (!user.length || !assistant.length) fail("LEARNING_SOURCE_UNAVAILABLE");
    const toolResults = [];
    for (const original of raw) {
      if (original.kind !== "tool_result" || original.contextExcluded) continue;
      const event = this.transcripts.contextEvent?.(profileId, session.id, original) || original;
      if (isBorrowedMemoryDerived(event) || !this.recall.policy.isEventVisible(profileId, event)) continue;
      // Use the bounded canonical result projection, not an expanded raw
      // Runtime context payload. Expansion is used only for provenance checks.
      const tool = original.content?.tool;
      const name = tool?.name || tool?.kind;
      if (!tool || typeof name !== "string" || derivedTool(tool) || tool.resultTruncated
        || !["completed", "failed"].includes(tool.status) || !text(tool.resultSummary, 4 * 1024)
        || hasSecret(tool.resultSummary) || tool.errorCode && tool.status === "completed") continue;
      const failed = tool.status === "failed" || tool.success === false || tool.error
        || typeof tool.exitCode === "number" && tool.exitCode !== 0;
      const value = { name, status: failed ? "failed" : "completed", result: tool.resultSummary };
      toolResults.push({ runId, eventId: event.id, sessionId: session.id, seq: event.seq,
        kind: "tool_result", tool: value, contentHash: digest(value) });
    }
    if (!toolResults.some(event => event.tool.status === "completed")) fail("LEARNING_SOURCE_UNAVAILABLE");
    const evidence = [...dialogue, ...toolResults].sort((a, b) => a.seq - b.seq);
    if (evidence.length > LIMITS.evidence || Buffer.byteLength(JSON.stringify(evidence)) > LIMITS.inputBytes
      || evidence.some(event => hasSecret(JSON.stringify(event)))) fail("LEARNING_SOURCE_UNAVAILABLE");
    if (this.transcripts.getRevision(profileId, session.id) !== revision) fail("LEARNING_SOURCE_UNAVAILABLE");
    const sourceRefs = evidence.map(({ text: _text, tool: _tool, ...ref }) => ref);
    return { profileId, runId, sessionKey, sessionId: session.id, state: "ready", sourceRefs,
      sourceHash: digest(sourceRefs), evidence, finishedAt: run.finishedAt,
      toolResults: toolResults.filter(event => event.tool.status === "completed").length,
      hasCorrection: user.some(event => CORRECTION.test(event.text)),
      explicitLearningRequest: user.some(event => LEARNING_REQUEST.test(event.text)) };
  }
  assertRefs(profileId, sourceRefs) {
    if (!Array.isArray(sourceRefs) || !sourceRefs.length || sourceRefs.length > 256) fail("LEARNING_STORE_CORRUPT");
    const runs = new Map();
    for (const ref of sourceRefs) {
      if (!runs.has(ref.runId)) runs.set(ref.runId, this.readRun(profileId, ref.runId));
      const current = runs.get(ref.runId).sourceRefs.find(candidate => candidate.eventId === ref.eventId);
      if (!current || digest(current) !== digest(ref)) fail("LEARNING_SOURCE_REVOKED");
    }
    return [...runs.values()];
  }
  prepare(job) {
    const runs = this.assertRefs(job.profileId, job.sourceRefs);
    const allowed = new Set(job.sourceRefs.map(ref => ref.eventId));
    const evidence = runs.flatMap(run => run.evidence.filter(event => allowed.has(event.eventId)));
    if (digest(evidence.map(({ text: _text, tool: _tool, ...ref }) => ref)) !== digest(job.sourceRefs)) fail("LEARNING_SOURCE_UNAVAILABLE");
    return evidence;
  }
}
module.exports = { LearningSources, CORRECTION, DERIVED_TOOLS, FOREGROUND };
