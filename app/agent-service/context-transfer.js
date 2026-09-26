"use strict";
const crypto = require("node:crypto");

// Receipts live with the source transcript, so a restart never invents an
// accepted target request or loses the source/configuration revision.
function readContextTransfer(store, session, active = false) {
  if (typeof store?.listEvents !== "function") return null;
  const receipt = store.listEvents(session.profileId, session.id).findLast(event => event.kind === "status"
    && event.contextExcluded && event.content?.transcriptType === "context.transfer")?.content.transfer ?? null;
  return receipt && !active && (receipt.state === "preparing"
    || (receipt.state === "ready" && session.revision === receipt.sourceSessionRevision))
    ? { ...receipt, state: "failed", errorCode: "CONTEXT_HANDOFF_INTERRUPTED" } : receipt;
}
function recordContextTransfer(store, session, transfer) {
  store.appendEvent({ profileId: session.profileId, sessionId: session.id,
    id: `context-transfer-${crypto.randomUUID()}`, kind: "status", contextExcluded: true,
    occurredAt: transfer.updatedAt, content: { transcriptType: "context.transfer", transfer } });
  return transfer;
}
module.exports = { readContextTransfer, recordContextTransfer };
