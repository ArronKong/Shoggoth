"use strict";

const { estimateContextTokens, validWindow } = require("./conversation-context-budget");

// These are application transport limits, not model capacities. Native Hosts
// accept 4 MiB context fields; the Handle/JSONL envelope is checked separately.
function contextTransportLimits(runtime) {
  return Object.freeze({ contextBytes: 4 * 1024 * 1024, frameBytes: 8 * 1024 * 1024,
    promptBytes: 1024 * 1024, summaryPromptBytes: 128 * 1024,
    // Verified against the pinned app-server: aggregate user input is limited
    // independently of model_context_window. UTF-16 length is conservative
    // for supplementary Unicode characters.
    requestCharacters: runtime === "codex" ? 1048576 : null, runtime });
}

function inputTokenLimit(budget, limits = {}) {
  const outputReserve = limits.windowKind === "total" && validWindow(limits.outputTokens)
    ? limits.outputTokens : 0;
  // The 80% trigger already leaves headroom for estimates and unspecified
  // output. Do not deduct a maximum output allowance from an input-only or
  // already effective CLI window.
  return Math.max(0, Math.min(budget.triggerTokens, budget.tokens - outputReserve,
    validWindow(limits.inputTokens) ? limits.inputTokens : Infinity));
}

function attachmentTokens(attachments = []) {
  return attachments.reduce((total, item) => total + estimateContextTokens(JSON.stringify({
    name: item.name, mimeType: item.mimeType, id: item.id,
  })) + 256 + (item.mimeType?.startsWith("image/") ? 8192 : 0), 0);
}

function requestBudget({ budget, limits = {}, developerInstructions = "", context = "", prompt = "",
  tools = [], attachments = [], nativeUsage = null, fresh = true }) {
  const instructions = estimateContextTokens(developerInstructions);
  const toolTokens = estimateContextTokens(JSON.stringify(tools));
  const added = estimateContextTokens(context) + estimateContextTokens(prompt) + attachmentTokens(attachments);
  const serializedTokens = instructions + toolTokens + added;
  // A native meter includes its own history, instructions and tools. Using the
  // larger estimate avoids counting the same definitions twice on every turn.
  const estimatedTokens = !fresh && nativeUsage?.usedTokens != null
    ? Math.max(serializedTokens, nativeUsage.usedTokens + added) : serializedTokens;
  const limitTokens = inputTokenLimit(budget, limits);
  return Object.freeze({ estimatedTokens, limitTokens, fixedTokens: instructions + toolTokens
    + estimateContextTokens(prompt) + attachmentTokens(attachments),
    quality: "estimated", attachmentsEstimated: attachments.some(item => item.mimeType?.startsWith("image/")),
    exceedsBudget: estimatedTokens > limitTokens });
}

function assertContextTransport({ runtime, prompt = "", context = "", attachments = [] }) {
  const limits = contextTransportLimits(runtime);
  const bytes = Buffer.byteLength(context);
  // Check the actual JSON representation, including escapes. Image byte
  // expansion is validated by the native Host before creating a turn receipt.
  const frameBytes = Buffer.byteLength(JSON.stringify({ prompt, context, attachments }));
  const characters = context.length + prompt.length + (context.length ? "\n\nCURRENT USER REQUEST\n".length : 0);
  if (bytes > limits.contextBytes || Buffer.byteLength(prompt) > limits.promptBytes || frameBytes > limits.frameBytes
    || (limits.requestCharacters !== null && characters > limits.requestCharacters)) {
    throw Object.assign(new Error("目标 Runtime 的上下文传输容量不足，请先压缩历史"), {
      code: "CONTEXT_TRANSPORT_EXCEEDED", acceptance: "not_sent",
    });
  }
  return { contextBytes: bytes, frameBytes };
}

function rejectedContextCapacity(error) {
  const read = (value, key) => Object.getOwnPropertyDescriptor(value || {}, key)?.value;
  for (let depth = 0; error && depth < 8; depth++, error = read(error, "cause")) {
    if (!["CONTEXT_LENGTH_EXCEEDED", "context_length_exceeded", "INPUT_TOO_LONG", "context_window_exceeded"]
      .includes(read(error, "code"))) continue;
    const acceptance = read(error, "acceptance");
    if (acceptance !== "not_sent" && !(acceptance === "rejected" && read(error, "executed") === false)) continue;
    const capacity = read(error, "contextWindow");
    return { tokens: validWindow(capacity) ? capacity : null };
  }
  return null;
}

module.exports = { contextTransportLimits, inputTokenLimit, attachmentTokens, requestBudget, assertContextTransport, rejectedContextCapacity };
