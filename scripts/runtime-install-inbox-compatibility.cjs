"use strict";

const { statFile, extractFile } = require("@electron/asar");

const INBOX_SOURCE = "app/agent-service/pending-command-inbox.js";
const V1 = /^const PENDING_COMMAND_INBOX_VERSION = 1;$/mu;
const V2 = /^const RECOVERABLE_PENDING_COMMAND_INBOX_VERSION = 2;$/mu;

function compatibilityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function supportsEnvelope(archive, version) {
  let source;
  try {
    const entry = statFile(archive, INBOX_SOURCE, false);
    if (entry.unpacked || entry.link || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 256 * 1024) return false;
    source = extractFile(archive, INBOX_SOURCE).toString("utf8");
  } catch { return false; }
  if (!V1.test(source)) return false;
  // Inspect the signed archive without evaluating its code. Recognize the
  // shipped reader checks, including the shared v2 envelope parser, rather
  // than assuming equal Service protocol or package version means compatibility.
  const sharedParser = V2.test(source)
    && /^function envelopeFields\(value\) \{\n\s+if \([^\n]+\n\s+\|\| !\[PENDING_COMMAND_INBOX_VERSION, RECOVERABLE_PENDING_COMMAND_INBOX_VERSION\]\.includes\(value\.version\)$/mu.test(source)
    && /^function validateEnvelope\(value\) \{\n\s+const envelope = envelopeFields\(value\);$/mu.test(source);
  if (sharedParser) return version === 1 || version === 2;
  return version === 1 && /^function validateEnvelope\(value\) \{\n\s+if \([^\n]+\n\s+\|\| value\.version !== PENDING_COMMAND_INBOX_VERSION$/mu.test(source);
}

function assertInboxReaderCompatibility(archive, auditedInbox) {
  if (auditedInbox === null) return;
  if (![1, 2].includes(auditedInbox?.version) || !Number.isSafeInteger(auditedInbox.revision) || auditedInbox.revision < 1) {
    throw compatibilityError("INSTALL_INBOX_FORMAT_UNVERIFIED", "The state audit did not verify the PendingCommand Inbox format.");
  }
  if (!supportsEnvelope(archive, auditedInbox.version)) {
    throw compatibilityError("INSTALL_INBOX_READER_INCOMPATIBLE",
      `The target must read PendingCommand Inbox v${auditedInbox.version}. Use a verified compatible build for this state.`);
  }
}

module.exports = { assertInboxReaderCompatibility };
