"use strict";

const { normalizeInteractiveRequestV1, validInteractiveApprovalOptions } = require("../core/shoggoth-interaction-contract");
const { transcriptEventId } = require("./transcript-store");

const APPROVAL_LABELS = Object.freeze({ once: "仅本次允许", session: "允许本次会话", deny: "拒绝", cancel: "取消" });
const MAX_EVIDENCE_BYTES = 12 * 1024;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function validGroupContinuationTarget(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 3
    && typeof value.sourceEventId === "string" && EVENT_ID.test(value.sourceEventId)
    && typeof value.groupId === "string" && UUID.test(value.groupId)
    && typeof value.ownerScope === "string" && value.ownerScope.startsWith("ga1:") && UUID.test(value.ownerScope.slice(4));
}

function groupContinuationFromAnswer(event) {
  if (event?.kind !== "assistant" || !event.runId || event.runtimeRef !== null || !event.contextExcluded
    || event.content?.partialReview !== true || event.content.transcriptType !== "text" || event.content.phase !== "final_answer"
    || event.id !== transcriptEventId("context-partial-answer", event.runId)) return null;
  const { groupContinuation, partialReviewEventIds } = event.content;
  return validGroupContinuationTarget(groupContinuation) && Array.isArray(partialReviewEventIds)
    && partialReviewEventIds.includes(groupContinuation.sourceEventId) ? groupContinuation : null;
}

// Transcript can prove what an original prompt offered. Only the original
// interaction owner can prove whether it is still actionable or accept a reply.
function readRecordedContinuationInteraction(event, events, resolveVisibleResponse) {
  if (!event || event.contextExcluded || !["approval", "input"].includes(event.kind)) return null;
  const payload = event.content;
  const eventType = event.kind === "approval" ? "approval" : "prompt";
  if (!payload || payload.transcriptType !== eventType || payload.redacted
    || typeof payload.requestId !== "string" || event.id !== transcriptEventId("chat-request", payload.requestId)
    || typeof event.sessionId !== "string" || !Number.isSafeInteger(event.seq)) return null;
  if (payload.approvalOptions !== undefined && !validInteractiveApprovalOptions(payload.approvalOptions)) return null;

  let request;
  try { request = normalizeInteractiveRequestV1({ runId: event.runId, eventType, payload, expiresAt: payload.expiresAt }); }
  catch { return null; }
  const choices = request.approvalChoices.map(choice => request.approvalOptions?.find(option => option.choice === choice)?.label
    ?? APPROVAL_LABELS[choice]).filter(Boolean);
  const fields = request.fields.filter(field => !field.secret && field.options.length > 0)
    .map(field => ({ label: field.label, choices: field.options.map(option => option.label) }));
  if (!choices.length && !fields.length) return null;

  // A visible response event proves that a response was recorded, not that
  // its selected action completed. Approval responses are normally excluded.
  const responseId = transcriptEventId("interactive-response", payload.requestId);
  const exactResponse = candidate => candidate?.id === responseId && !candidate.contextExcluded
    && candidate.kind === "user" && candidate.runId === event.runId && candidate.sessionId === event.sessionId
    && Number.isSafeInteger(candidate.seq) && candidate.seq > event.seq
    && candidate.content?.transcriptType === "interaction.response" && candidate.content.requestId === payload.requestId
    && typeof candidate.content.operationId === "string" && candidate.content.operationId.length > 0;
  const candidate = resolveVisibleResponse && events.find(exactResponse);
  const response = candidate && exactResponse(resolveVisibleResponse(candidate)) ? { eventId: responseId } : null;
  const evidence = { kind: request.kind, availability: "historical_record_only", choices, fields, response };
  return Buffer.byteLength(JSON.stringify(evidence), "utf8") <= MAX_EVIDENCE_BYTES ? evidence : null;
}

module.exports = { readRecordedContinuationInteraction, validGroupContinuationTarget, groupContinuationFromAnswer };
