"use strict";

const VERSION = 1;
const TERMINAL = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
// NO_RESET is a compatibility alias for older user-authored monitoring prompts.
// Match the entire final reply: mentioning a token in a report is never silence.
const SILENT_FINALS = new Set(["NO_REPLY", "[SILENT]", "NO_RESET"]);

function validCronOutput(value) {
  return value && value.version === VERSION && Object.keys(value).length === 3
    && ["pending", "deliver", "silent"].includes(value.disposition)
    && (value.disposition === "silent" ? ["token", "empty"].includes(value.reason) : value.reason === null);
}

function cronUnattendedCompletionError(run, events, resultSummary, resolveDisplay = event => event) {
  if (run?.source !== "cron") return null;
  const own = events.filter(event => event.runId === run.id);
  if (!own.some(event => event.content?.transcriptType === "cron.authorization" && event.content.decision === "deny")) return null;
  if (own.some(event => event.kind === "artifact")) return null;
  const messages = own.filter(event => event.kind === "assistant").map(resolveDisplay)
    .filter(event => event.content?.delivery !== "async" && typeof event.content?.text === "string");
  const final = (messages.findLast(event => event.content?.phase === "final_answer")
    || messages.findLast(event => event.content?.phase == null))?.content?.text ?? resultSummary ?? "";
  // An allowed alternative with a real result remains successful. If the
  // model stops silently after a denial, expose failure and release the Run.
  return !final.trim() || SILENT_FINALS.has(final.trim()) ? "CRON_AUTHORIZATION_DENIED" : null;
}

function cronOutputDecision(run, events, resolveDisplay = event => event) {
  if (run?.source !== "cron") return null;
  const own = events.filter(event => event.runId === run.id);
  // Opt in at admission. Existing transcripts and ordinary user turns in the
  // same recurring conversation keep their original history semantics.
  if (!own.some(event => event.kind === "user" && event.content?.cronOutputVersion === VERSION)) return null;
  if (!TERMINAL.has(run.status)) return { version: VERSION, disposition: "pending", reason: null };
  if (run.status !== "completed") return { version: VERSION, disposition: "deliver", reason: null };
  const saved = own.findLast(event => event.content?.transcriptType === "terminal")?.content?.cronOutput;
  if (validCronOutput(saved) && saved.disposition !== "pending") return structuredClone(saved);
  const messages = own.filter(event => event.kind === "assistant").map(resolveDisplay)
    .filter(event => event.content?.delivery !== "async" && typeof event.content?.text === "string");
  const selected = messages.findLast(event => event.content.phase === "final_answer")
    || messages.findLast(event => event.content.phase == null);
  // A run summary is bounded. Prefer the full canonical final, so a marker
  // followed by a long report cannot become silence through truncation.
  const text = selected?.content.text ?? run.resultSummary ?? "";
  const final = text.trim();
  const artifact = own.some(event => event.kind === "artifact");
  if (!artifact && SILENT_FINALS.has(final) && (selected || text.length < 128)) {
    return { version: VERSION, disposition: "silent", reason: "token" };
  }
  const hasContent = own.some(event => event.kind === "artifact"
    || event.kind === "assistant" && typeof event.content?.text === "string" && event.content.text.trim());
  if (!final && !hasContent) return { version: VERSION, disposition: "silent", reason: "empty" };
  return { version: VERSION, disposition: "deliver", reason: null };
}

function publicCronTranscript(events, getDecision) {
  const decisions = new Map();
  return events.filter(event => {
    if (!event.runId) return true;
    if (!decisions.has(event.runId)) decisions.set(event.runId, getDecision(event.runId));
    const disposition = decisions.get(event.runId)?.disposition;
    return !["pending", "silent"].includes(disposition)
      || ["approval", "input", "error"].includes(event.kind);
  });
}

module.exports = { CRON_OUTPUT_VERSION: VERSION, cronOutputDecision, publicCronTranscript, validCronOutput, cronUnattendedCompletionError };
