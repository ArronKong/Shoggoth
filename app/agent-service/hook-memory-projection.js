"use strict";
const { digest } = require("./hook-contract");
const { extractBorrowedMemoryRefs, normalizeBorrowedMemoryRefs } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
function hookMemoryRefs(event) { return extractBorrowedMemoryRefs(event); }
function projectHookMemoryOutput(output, refs, referenceOnly = false) {
  const borrowedMemoryRefs = normalizeBorrowedMemoryRefs(refs);
  if (!borrowedMemoryRefs.length && !referenceOnly) return output;
  if (output && output.persistPolicy === "reference_only" && /^[a-f0-9]{64}$/u.test(output.contentHash || "")
    && Object.keys(output).every(key => ["borrowedMemoryRefs", "persistPolicy", "contentHash"].includes(key)))
    return { borrowedMemoryRefs, persistPolicy: "reference_only", contentHash: output.contentHash };
  return { borrowedMemoryRefs, persistPolicy: "reference_only", contentHash: digest(output ?? null) };
}
function projectHookMemoryEvent(event) {
  const refs = hookMemoryRefs(event);
  if (!refs.length && event.persistPolicy !== "reference_only") return event;
  const payload = event.payload;
  const projected = payload && payload.persistPolicy === "reference_only" && /^[a-f0-9]{64}$/u.test(payload.contentHash || "")
    && Object.keys(payload).every(key => ["status", "borrowedMemoryRefs", "persistPolicy", "contentHash"].includes(key))
    ? { borrowedMemoryRefs: refs, persistPolicy: "reference_only", contentHash: payload.contentHash }
    : projectHookMemoryOutput(payload, refs, true);
  return { ...event, borrowedMemoryRefs: refs, payload: { status: event.metadata?.status ?? null, ...projected } };
}
module.exports = { hookMemoryRefs, projectHookMemoryOutput, projectHookMemoryEvent };
