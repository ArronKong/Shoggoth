"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function bindConversationSource({ args, run, transcriptStore, chatSessionStore, getRunSessionKey, requireQuote = false }) {
  if (!["chat", "inspiration"].includes(run.source)
    || /^shoggoth:chat-send:federation-(?:send|message)-/u.test(run.idempotencyKey || "")) {
    throw serviceError("MCP_TOOL_FORBIDDEN", "该操作需要当前用户对话");
  }
  const sessionKey = getRunSessionKey(run);
  const session = sessionKey ? chatSessionStore.getSession(sessionKey) : null;
  if (!session || session.profileId !== run.profileId || session.workspace !== run.workspace) {
    throw serviceError("CONVERSATION_SOURCE_INVALID", "对话来源不存在或归属不匹配");
  }
  // Product session keys route requests; transcripts are stored under the distinct session ID.
  const events = transcriptStore.listEvents(run.profileId, session.id)
    .filter((event) => event.runId === run.id && event.kind === "user"
      && !event.contextExcluded)
    .map((event) => {
      if (!event.content?.contextRef) return event;
      // Large user messages keep only a display excerpt in the journal. Both
      // quote lookup and the source hash must use the verified full body.
      if (typeof transcriptStore.contextEvent !== "function") {
        throw serviceError("CONVERSATION_SOURCE_INVALID", "对话来源正文不可用");
      }
      try { return transcriptStore.contextEvent(run.profileId, session.id, event); }
      catch { throw serviceError("CONVERSATION_SOURCE_INVALID", "对话来源正文不可用"); }
    })
    .filter((event) => typeof event.content?.text === "string");
  const quote = args.sourceQuote?.trim();
  const quoted = quote ? events.find((event) => event.content.text.includes(quote)) : null;
  if (requireQuote && !quoted) {
    throw serviceError("CONVERSATION_SOURCE_INVALID", "来源引文必须来自当前用户消息");
  }
  if (events.length === 0) throw serviceError("CONVERSATION_SOURCE_INVALID", "当前执行没有用户消息");
  const sourceEvent = quoted || events.at(-1);
  const quoteStartUtf16 = quoted ? sourceEvent.content.text.indexOf(quote) : null;
  return {
    runId: run.id,
    sourceRefs: [sourceEvent.id, run.id],
    source: {
      runId: run.id,
      sessionId: session.id,
      eventId: sourceEvent.id,
      eventTextHash: sha256(sourceEvent.content.text),
      quoteHash: quoted ? sha256(quote) : null,
      quoteStartUtf16,
      quoteEndUtf16: quoted ? quoteStartUtf16 + quote.length : null,
    },
  };
}

module.exports = { bindConversationSource };
