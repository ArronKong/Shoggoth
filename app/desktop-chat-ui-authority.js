"use strict";
const crypto = require("node:crypto");
const c = require("./agent-service/chat-ui-contract");

// This authority is held only by Electron main. The generated document's
// state port and the loopback management API never receive a click proof.
function actionFingerprint(value) {
  const copy = { ...value }; delete copy.hostProof;
  // The opaque lease binds the owner and the product session. The management
  // adapter alone translates gateway keys/Profile IDs, so those display keys
  // are not part of the click payload fingerprint.
  delete copy.profileId; delete copy.sessionKey;
  return c.hash({ version: 1, method: "chat.ui.action", params: copy });
}
function createDesktopChatUiAuthority({ now = Date.now } = {}) {
  const proofs = new Map();
  const sweep = () => { for (const [key, proof] of proofs) if (proof.expiresAt <= now()) proofs.delete(key); };
  return {
    issue(params, isCurrent) {
      sweep(); if (proofs.size >= c.LIMITS.pending || isCurrent() !== true) throw c.uiError("UI_HOST_REQUIRED");
      const proofId = crypto.randomUUID();
      proofs.set(proofId, { fingerprint: actionFingerprint(params), expiresAt: now() + 30_000, isCurrent });
      return proofId;
    },
    consume({ proofId, fingerprint }) {
      sweep(); const proof = proofs.get(proofId); proofs.delete(proofId);
      return { approved: !!proof && proof.fingerprint === fingerprint && proof.isCurrent() === true };
    },
    revoke(proofId) { proofs.delete(proofId); },
    close() { proofs.clear(); },
  };
}
module.exports = { actionFingerprint, createDesktopChatUiAuthority };
