"use strict";
const { serviceError } = require("./security");
const { SECRET_MESSAGES } = require("../core/chat-secret-contract");
const fail = () => { throw serviceError("SECRET_PROCESSING_UNAVAILABLE", SECRET_MESSAGES.SECRET_PROCESSING_UNAVAILABLE); };
function createSecretEmbeddingProjection({ secrets, media, getSession }) {
  return async (profileId, input, { sessionId, signal } = {}) => {
    signal?.throwIfAborted();
    const session = sessionId ? getSession(sessionId) : null;
    if (session && session.profileId !== profileId) fail();
    // Background file indexing has no conversation identity. It uses an
    // independent scope, never a union of temporary secrets from other chats.
    const scope = { profileId, sessionId: session?.sessionKey || `memory-index:${profileId}` };
    const text = value => { if (typeof value !== "string") fail(); return secrets.projectText(scope, value); };
    if (typeof input === "string") return text(input);
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).some(key => !["text", "parts"].includes(key))) fail();
    const safe = { text: text(input.text) };
    if (input.parts !== undefined) {
      if (!Array.isArray(input.parts) || input.parts.length > 64) fail();
      safe.parts = [];
      for (const part of input.parts) {
        signal?.throwIfAborted();
        if (part?.type === "text") safe.parts.push({ type: "text", text: text(part.text) });
        else if (part?.type === "inline-data") {
          if (!media) fail();
          const projected = await media.projectInline(scope, { mimeType: part.mimeType, data: part.data }, { signal });
          if (projected.mimeType === "image/png" || projected.mimeType === "application/pdf")
            safe.parts.push({ type: "inline-data", mimeType: projected.mimeType, data: projected.data.toString("base64") });
          else safe.parts.push({ type: "text", text: text(projected.text) });
        } else fail();
      }
    }
    signal?.throwIfAborted(); return safe;
  };
}
module.exports = { createSecretEmbeddingProjection };
