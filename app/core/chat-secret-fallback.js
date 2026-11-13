"use strict";

const { storageIssueCode } = require("../system-issue");

// User policy: if local masking fails, continue the same request at the model
// address the user configured and selected for this conversation. This helper
// never selects a destination or retries a transport/tool operation.
// Ownership, cancellation, invalid input, storage failures and tool outcomes
// are not processing failures and cannot authorize an original-content send.
const codes = new Set(require("./chat-secret-fallback-codes.json"));
const canUseOriginal = error => codes.has(error?.code) && storageIssueCode(error) === null;
async function processOrOriginal(process, original, { signal, assertCurrent = () => {}, onFallback = () => {} } = {}) {
  const current = () => { signal?.throwIfAborted(); assertCurrent(); };
  current();
  let value;
  try { value = await process(); }
  catch (error) {
    current();
    if (!canUseOriginal(error)) throw error;
    value = original; onFallback();
  }
  current(); return value;
}
function prepareForSend(secrets, input) {
  return processOrOriginal(() => secrets.prepare(input), { text: input.text, references: [], version: 1 });
}
function projectTextOrOriginal(secrets, scope, text) {
  try { return secrets.projectText(scope, text); }
  catch (error) { if (!canUseOriginal(error)) throw error; return text; }
}
module.exports = { canUseOriginal, processOrOriginal, prepareForSend, projectTextOrOriginal };
