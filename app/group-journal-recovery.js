"use strict";
// Text-only recovery projection. It grants no send identity, attachment access or write authority.
const encoder = new TextEncoder();
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const field = (value, key) => {
  if (!plain(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, "value") ? property.value : undefined;
};
const part = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
const validText = value => typeof value === "string" && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
function projectJournalRecovery(state, { ownerScope, groupId, offset = 0, snapshotDigest }) {
  if (!part(ownerScope) || !part(groupId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1256
    || !/^[a-f0-9]{64}$/u.test(snapshotDigest ?? "") || field(state, "version") !== 1
    || !Array.isArray(field(state, "sends")) || !Array.isArray(field(state, "drafts"))) {
    throw Object.assign(new Error("GROUP_JOURNAL_RECOVERY_UNAVAILABLE"), { code: "GROUP_JOURNAL_RECOVERY_UNAVAILABLE" });
  }
  const sends = state.sends.slice(0, 1000), drafts = state.drafts.slice(0, 256);
  const rows = [...sends.map(row => ["send", row]), ...drafts.map(row => ["draft", row])];
  const items = []; let skipped = 0, position = offset, scanned = 0;
  for (; position < rows.length && scanned < 256 && items.length < 20; position++, scanned++) {
    const [kind, row] = rows[position];
    const owner = field(row, "ownerScope"), group = field(row, "groupId");
    if (owner !== ownerScope || group !== groupId) { if (!part(owner) || !part(group)) skipped++; continue; }
    const id = field(row, kind === "send" ? "clientMessageId" : "draftId");
    const source = field(row, kind === "send" ? "inputSnapshot" : "composer");
    const originalText = field(source, kind === "send" ? "body" : "text");
    if (!part(id) || field(row, "key") !== JSON.stringify([ownerScope, groupId, id]) || !validText(originalText)) { skipped++; continue; }
    const bytes = encoder.encode(originalText), truncated = bytes.length > 32 * 1024;
    const text = truncated ? new TextDecoder().decode(bytes.subarray(0, 32 * 1024), { stream: true }) : originalText;
    const files = field(source, kind === "send" ? "attachments" : "files");
    const attachmentNames = Array.isArray(files) ? files.slice(0, 8).flatMap(file => {
      const name = field(file, "name"); return validText(name) && name.length <= 512 ? [name] : [];
    }) : [];
    items.push({ kind, id, text, attachmentNames, truncated, unverified: true });
  }
  return { ownerScope, groupId, snapshotDigest, readOnly: true, items, skipped,
    collectionTruncated: state.sends.length > 1000 || state.drafts.length > 256,
    hasMore: position < rows.length, nextOffset: position < rows.length ? position : null };
}
module.exports = { projectJournalRecovery };
