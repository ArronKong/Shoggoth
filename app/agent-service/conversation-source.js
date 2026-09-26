"use strict";

const { serviceError } = require("./security");

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
      && !event.contextExcluded && typeof event.content?.text === "string");
  const quote = args.sourceQuote?.trim();
  const quoted = quote ? events.find((event) => event.content.text.includes(quote)) : null;
  if (requireQuote && !quoted) {
    throw serviceError("CONVERSATION_SOURCE_INVALID", "来源引文必须来自当前用户消息");
  }
  if (events.length === 0) throw serviceError("CONVERSATION_SOURCE_INVALID", "当前执行没有用户消息");
  return { runId: run.id, sourceRefs: [quoted?.id || events.at(-1).id, run.id] };
}

module.exports = { bindConversationSource };
