"use strict";

const { createHash } = require("node:crypto");

function inspirationUserText(execution) {
  if (execution?.inputSource === "chat") return execution.instruction;
  return [execution?.title, execution?.body,
    execution?.instruction ? `本轮补充：\n${execution.instruction}` : null].filter(Boolean).join("\n\n");
}

function inspirationUserAttachments(execution) {
  return execution?.turnAttachments || (execution?.inputSource === "chat" ? [] : execution?.attachments) || [];
}

const inspirationPromptHash = text => createHash("sha256").update(text).digest("hex");

function inspirationHistoryText(message) {
  if (message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)
    || message.content.some(part => ["tool_result", "toolResult"].includes(part?.type))) return null;
  return message.content.filter(part => part?.type === "text").map(part => part.text || "").join("");
}

// Apply only to history from an ownership-checked Inspiration Session. The
// upstream transcript remains intact for model context and run attribution.
function projectInspirationHistory(history, projections) {
  const byHash = new Map(projections.map(value => [value.promptHash, value]));
  return { ...history, messages: history.messages.map(message => {
    const text = inspirationHistoryText(message);
    const projection = text === null ? null : byHash.get(inspirationPromptHash(text));
    if (!projection) return message;
    const otherParts = Array.isArray(message.content)
      ? message.content.filter(part => part?.type !== "text") : [];
    return { ...message, content: [{ type: "text", text: projection.text }, ...otherParts],
      ...(projection.attachments.length ? { shoggoth: { ...message.shoggoth,
        attachments: structuredClone(projection.attachments) } } : {}) };
  }) };
}

module.exports = { inspirationUserText, inspirationUserAttachments, inspirationPromptHash, inspirationHistoryText, projectInspirationHistory };
