"use strict";

// Offline proof of an existing original Review transaction. No receipt writer,
// activation repair, model extraction, audience conversion or owner selection.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MemoryCandidateStore } = require("../memory-candidate-store");
const { validateMemoryItem } = require("../memory-store");
const { workspaceMemoryRefs } = require("../memory-engine");
const { readPrivateFile } = require("../private-file");
const { serviceError } = require("../security");
const REVIEWED = /^reviewed-(mc-[a-f0-9]{64})$/u;
const FIELDS = ["id", "profileId", "scope", "type", "content", "sourceRefs", "confidence", "sensitivity", "status", "validFrom", "validUntil", "supersedes", "createdAt", "updatedAt"];
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, text) => { throw serviceError(code, text); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const same = (left, right) => stable(left) === stable(right);
function receiptState(paths, profileId, file) {
  if (file && (!path.isAbsolute(file) || path.normalize(file) !== file || !file.startsWith(paths.trustedRoot + path.sep)
    || fs.realpathSync.native(file) !== file)) fail("MEMORY_ROLLBACK_PATH_UNSAFE", "候选 backup 路径不安全");
  const reader = new MemoryCandidateStore({ paths, readOnly: true });
  // Keep the original parser/checksum/schema/version upgrade unchanged; only
  // choose the already-owned fixed migration backup instead of the live path.
  if (file) reader._file = id => { if (id !== profileId) fail("MEMORY_ROLLBACK_REVIEW_OWNER_MISMATCH", "回执 Profile 不匹配"); return file; };
  return reader.get(profileId);
}
function receiptDelta(before, after, context) {
  if (after.revision < before.revision) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_REGRESSED", "审核回执修订回退");
  const changes = [];
  for (const [id, previous] of Object.entries(before.candidates)) {
    const next = after.candidates[id];
    if (!next) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_REMOVED", "迁移前候选或回执被移除");
    if (same(previous, next)) continue;
    const fixed = candidate => Object.fromEntries(Object.entries(candidate).filter(([key]) => !["status", "acceptedMemoryId", "updatedAt"].includes(key)));
    if (!same(fixed(previous), fixed(next)) || previous.status !== "pending" || !["accepted", "rejected"].includes(next.status)
      || next.updatedAt < previous.updatedAt) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_CHANGED", "迁移前候选语义或已终结回执被篡改");
    changes.push({ candidateId: id, from: previous.status, to: next.status });
  }
  for (const [id, candidate] of Object.entries(after.candidates)) {
    if (!before.candidates[id]) changes.push({ candidateId: id, from: null, to: candidate.status });
    // All delta entries retain a real original source, including pending and
    // rejected entries. A delta is not a blanket permission to invent rows.
    if (!before.candidates[id] || !same(before.candidates[id], candidate)) sourceProof(context, candidate);
  }
  for (const [id, previous] of Object.entries(before.cursors)) {
    const next = after.cursors[id];
    if (!next || next.throughSeq < previous.throughSeq || next.updatedAt < previous.updatedAt) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_REGRESSED", "原候选来源游标回退");
  }
  const operations = new Map(after.operations.map(operation => [operation.operationId, operation]));
  for (const previous of before.operations) {
    const next = operations.get(previous.operationId);
    if (!next || !same(previous, next)) fail("MEMORY_ROLLBACK_REVIEW_OPERATION_CHANGED", "原提取操作回执变化尚未证明");
  }
  if (after.revision === before.revision && !same(before, after)) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_REGRESSED", "同修订候选状态变化");
  return changes.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}
function sourceProof(context, candidate) {
  const { profileId, source } = candidate;
  if (profileId !== context.profileId) fail("MEMORY_ROLLBACK_REVIEW_OWNER_MISMATCH", "候选来源 Profile 不匹配");
  const session = context.sessions.listSessions().find(value => value.id === source.sessionId && value.profileId === profileId);
  if (!session || !["ready", "archived"].includes(session.status) || session.workspace !== source.workspace) fail("MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH", "候选来源会话或 workspace 不匹配");
  const run = context.product.getWorkRun(source.runId);
  if (!run || run.source !== "chat" || run.status !== "completed" || run.profileId !== profileId
    || run.workspace !== session.workspace || run.sourceId !== session.sessionKey) fail("MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH", "候选来源 Run 未完成或归属不匹配");
  const event = context.transcripts.getEvent(profileId, session.id, source.eventId);
  const resolved = event && context.transcripts.contextEvent(profileId, session.id, event), text = resolved?.content?.text;
  if (!event || event.kind !== "user" || event.seq !== source.seq || event.runId !== run.id || typeof text !== "string"
    || hash(text) !== source.contentHash || text.slice(source.quoteStart, source.quoteStart + source.quoteLength).length !== source.quoteLength
    || hash(text.slice(source.quoteStart, source.quoteStart + source.quoteLength)) !== source.quoteHash) fail("MEMORY_ROLLBACK_REVIEW_SOURCE_MISMATCH", "候选真实原文或 quote hash 不匹配");
  let authorized = true;
  try { context.candidates._assertCandidateVisible(profileId, candidate); }
  catch (error) {
    if (!["MEMORY_CANDIDATE_SOURCE_UNAVAILABLE", "MEMORY_CANDIDATE_SOURCE_OUTDATED"].includes(error.code)) throw error;
    authorized = false;
  }
  return { sessionId: session.id, sessionKey: session.sessionKey, runId: run.id, eventId: event.id, seq: event.seq,
    contentHash: source.contentHash, quoteHash: source.quoteHash, workspace: source.workspace, authorized };
}
function transactionProof(context, candidate, rows) {
  const id = `reviewed-${candidate.id}`, matching = rows.flatMap(row => (row.type === "memory.batch" ? row.items : [])
    .filter(item => item.id === id).map(item => ({ row, item })));
  const prepared = matching.find(({ item }) => item.status === "candidate" && context.engine._reviewCommitted(item, { candidates: { [candidate.id]: candidate } }));
  const active = prepared && matching.find(({ row, item }) => row.seq > prepared.row.seq && item.status === "active"
    && context.engine._reviewCommitted(item, { candidates: { [candidate.id]: candidate } }));
  if (!prepared || !active || candidate.updatedAt < prepared.item.updatedAt || candidate.updatedAt > active.item.updatedAt) {
    fail("MEMORY_ROLLBACK_REVIEW_TRANSACTION_UNPROVEN", "缺少原候选预提交、accepted 回执与真实激活事务");
  }
  const normalized = item => ({ ...item, status: "active", updatedAt: 0 });
  if (!same(normalized(prepared.item), normalized(active.item))) fail("MEMORY_ROLLBACK_REVIEW_TRANSACTION_UNPROVEN", "原激活事务改变候选语义");
  return { id, candidateSequence: prepared.row.seq, candidateChecksum: prepared.row.checksum,
    activationSequence: active.row.seq, activationChecksum: active.row.checksum, active: active.item };
}
function captureLegacyAcceptedReviewProof({ paths, profileId, records, baselineReceiptPath, now, assertCurrent, sessionTombstones = [] }) {
  if (!Array.isArray(records) || typeof assertCurrent !== "function") fail("MEMORY_ROLLBACK_REVIEW_INPUT_INVALID", "审核证明需要精确目标及停服 CAS");
  const { openLegacyAuthorizationResources } = require("./legacy-authorization-verifier.cjs");
  const context = openLegacyAuthorizationResources({ paths, profileId, now, assertCurrent });
  try {
    const before = baselineReceiptPath ? receiptState(paths, profileId, baselineReceiptPath) : new MemoryCandidateStore({ paths, readOnly: true })._fresh(profileId), after = context.receipts.get(profileId);
    const delta = receiptDelta(before, after, context);
    // Original MemoryStore has already parsed/checksummed/schema-validated the
    // exact complete journal; inspect its original physical rows for ordering.
    context.store.getRevision(profileId);
    const journalPath = path.join(paths.agentsDir, profileId, "memory", "events.jsonl");
    const bytes = fs.existsSync(journalPath) ? readPrivateFile(journalPath, { maxBytes: 256 * 1024 * 1024 }) : Buffer.alloc(0);
    if (bytes.length && bytes.at(-1) !== 10) fail("MEMORY_ROLLBACK_TRANSACTION_UNSETTLED", "审核原事务 journal 含未闭合尾部");
    const rows = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const proofs = [];
    for (const raw of records.filter(item => REVIEWED.test(item.id))) {
      const item = validateMemoryItem(Object.fromEntries(FIELDS.map(key => [key, raw[key]])), profileId);
      const candidate = after.candidates[REVIEWED.exec(item.id)[1]];
      if (!candidate || candidate.status !== "accepted" || candidate.acceptedMemoryId !== item.id
        || !context.engine._reviewCommitted(item, after)) fail("MEMORY_ROLLBACK_REVIEW_RECEIPT_MISMATCH", "目标不等于原 accepted 回执");
      const expectedRefs = [candidate.source.eventId, candidate.source.runId,
        ...(["project", "workspace"].includes(candidate.scope) ? workspaceMemoryRefs(candidate.source.workspace, candidate.scope) : [])];
      if (!same(item.sourceRefs, [...new Set(expectedRefs)])) fail("MEMORY_ROLLBACK_REVIEW_ADDITIONAL_SOURCE_SEMANTICS", "审核额外来源或晋升语义尚未证明");
      const source = sourceProof(context, candidate), transaction = transactionProof(context, candidate, rows);
      if (sessionTombstones.some(row => [row.session_id, row.session_key, row.source_id].some(id => id === source.sessionId || id === source.sessionKey))) {
        fail("MEMORY_ROLLBACK_REVIEW_SOURCE_TOMBSTONED", "文件 owner 已撤回审核来源会话");
      }
      if (!same({ ...item, status: "active", updatedAt: 0 }, { ...transaction.active, status: "active", updatedAt: 0 })) {
        fail("MEMORY_ROLLBACK_REVIEW_TARGET_CHANGED", "文件目标改变原审核事实语义");
      }
      if (!["active", "deleted", "superseded"].includes(item.status)) fail("MEMORY_ROLLBACK_REVIEW_TRANSACTION_UNPROVEN", "审核目标尚未完成激活");
      if (!source.authorized && item.status === "active") fail("MEMORY_ROLLBACK_REVIEW_SOURCE_REVOKED", "active 审核来源已撤回");
      proofs.push({ id: item.id, targetHash: hash(stable(item)), candidateHash: hash(stable(candidate)),
        source, transaction: Object.fromEntries(Object.entries(transaction).filter(([key]) => key !== "active")), status: item.status });
    }
    // Every newly accepted delta needs a real complete original transaction,
    // even when it is not selected as a file target.
    for (const change of delta.filter(value => value.to === "accepted")) transactionProof(context, after.candidates[change.candidateId], rows);
    const value = { format: "shoggoth-existing-accepted-review-proof", schemaVersion: 1, profileId,
      baselineReceiptHash: baselineReceiptPath ? hash(readPrivateFile(baselineReceiptPath, { maxBytes: 16 * 1024 * 1024 })) : null,
      receiptRevision: after.revision, receiptChecksum: after.checksum, delta, proofs: proofs.sort((a,b) => a.id.localeCompare(b.id)),
      auxiliaryAuthorityHash: context.auxiliary.sha256, audienceProven: false, canSelectLegacyWriter: false };
    assertCurrent(); return freeze({ ...value, sha256: hash(stable(value)) });
  } finally { context.close(); }
}
function assertLegacyAcceptedReviewPlanBinding(plan) {
  const proof = plan.snapshot?.acceptedReviewProof;
  if (!proof) return;
  const { sha256, ...body } = proof;
  if (hash(stable(body)) !== sha256 || proof.profileId !== plan.profileId || proof.audienceProven !== false
    || proof.canSelectLegacyWriter !== false) fail("MEMORY_ROLLBACK_REVIEW_PLAN_MISMATCH", "审核证明绑定不完整");
  for (const operation of plan.operations.filter(value => REVIEWED.test(value.id))) {
    const entry = proof.proofs.find(value => value.id === operation.id);
    if (!entry || entry.targetHash !== hash(stable(operation.after))) fail("MEMORY_ROLLBACK_REVIEW_PLAN_MISMATCH", "审核目标未绑定 immutable 计划");
    // This primitive does not silently add the old Engine's shared audience.
    if (operation.after.status === "active") fail("MEMORY_ROLLBACK_REVIEW_AUDIENCE_UNPROVEN", "active 审核共享读者语义未闭合");
  }
}
function acceptedReviewPlanBinding(plan) {
  assertLegacyAcceptedReviewPlanBinding(plan);
  return plan.snapshot?.acceptedReviewProof ? { acceptedReviewProofHash: plan.snapshot.acceptedReviewProof.sha256 } : {};
}
function reuseLegacyAcceptedReviewProof({ paths, profileId, records, auxiliaryAuthority, proof }) {
  const {sha256,...body}=proof;
  if(hash(stable(body))!==sha256 || proof.profileId!==profileId || auxiliaryAuthority?.sha256!==proof.auxiliaryAuthorityHash) {
    fail("MEMORY_ROLLBACK_SOURCE_CHANGED","原审核来源辅助权威发生变化");
  }
  const receipt=receiptState(paths,profileId);
  if(receipt.revision!==proof.receiptRevision || receipt.checksum!==proof.receiptChecksum) fail("MEMORY_ROLLBACK_SOURCE_CHANGED","原审核回执变化");
  for(const entry of proof.proofs) {
    const raw=records.find(item=>item.id===entry.id);
    if(!raw || hash(stable(validateMemoryItem(Object.fromEntries(FIELDS.map(key=>[key,raw[key]])),profileId)))!==entry.targetHash) fail("MEMORY_ROLLBACK_SOURCE_CHANGED","原审核文件目标变化");
  }
  return proof;
}
module.exports = { captureLegacyAcceptedReviewProof, assertLegacyAcceptedReviewPlanBinding, acceptedReviewPlanBinding, reuseLegacyAcceptedReviewProof };
