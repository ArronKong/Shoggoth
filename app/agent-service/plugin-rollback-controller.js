"use strict";
const crypto = require("node:crypto");
const { serviceError } = require("./security");
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "插件回退请求无效或已变化"); };
function publicReceipt(operation) {
  const receipt = operation?.result?.receipt;
  const action = ({ "data-snapshot": "snapshot", "code-rollback": "code", "data-restore": "restore" })[operation?.kind];
  if (!receipt || !action) return null;
  return { operationId: receipt.operationId, installationId: receipt.installationId,
    installationRevision: receipt.installationRevision, action, state: receipt.dataState,
    releaseDigest: receipt.releaseDigest || receipt.targetDigest,
    snapshotId: receipt.snapshotId || null, snapshotDigest: receipt.snapshotDigest || null,
    dataDigest: receipt.dataDigest || receipt.restoredDataDigest || receipt.retainedDataDigest,
    retainedDataId: receipt.retainedDataId || null };
}
class PluginRollbackController {
  #pending = new Map();
  #generation = 0;
  constructor({ store, rollback, resumeInstallation, now = Date.now }) {
    Object.assign(this, { store, rollback, resumeInstallation, now });
  }
  list(input) {
    if (!exact(input, ["installationId"]) || !id(input.installationId)) fail();
    return this.rollback.list(input);
  }
  operation(input) {
    if (!exact(input, ["installationId", "operationId"]) || !id(input.installationId) || !id(input.operationId)) fail();
    const operation = this.store.getOperation(input.operationId);
    const found = (operation?.result?.request?.installationId === input.installationId
      || this.store.listInstallationMaintenance(input.installationId).some(item => item.operationId === input.operationId))
      && ["data-snapshot", "code-rollback", "data-restore"].includes(operation.kind);
    return { operationId: input.operationId, found: Boolean(found), phase: found ? operation.phase : null,
      receipt: found ? publicReceipt(operation) : null };
  }
  async prepare(input) {
    const fields = ["action", "installationId", "expectedRevision", "operationId"];
    if (!exact(input, input?.action === "code" ? [...fields, "targetDigest"]
      : input?.action === "restore" ? [...fields, "snapshotId", "snapshotDigest"] : fields)
      || !["snapshot", "code", "restore", "retry"].includes(input.action) || !id(input.installationId) || !id(input.operationId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || (input.action === "code" && !hash(input.targetDigest))
      || (input.action === "restore" && (!hash(input.snapshotId) || !hash(input.snapshotDigest)))) fail();
    this.sweep();
    if (this.#pending.size >= 32) fail("PLUGIN_CONSENT_BUSY");
    const generation = this.#generation;
    const installation = this.store.getInstallation(input.installationId);
    if (!installation || installation.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (installation.desiredState !== "disabled") fail("PLUGIN_MAINTENANCE_REQUIRES_DISABLE");
    const incarnation = this.store.getAuthorityIncarnation();
    let action = input.action;
    let preview = input.action === "code" ? await this.rollback.previewCodeRollback(input)
      : input.action === "restore" ? await this.rollback.previewDataRestore(input) : null;
    if (input.action === "retry") {
      const previous = this.store.getOperation(input.operationId);
      if (!previous || previous.phase === "outcome_unknown") fail("PLUGIN_OPERATION_OUTCOME_UNKNOWN");
      if (previous.result?.request?.installationId !== input.installationId
        || previous.result?.request?.authorityIncarnation !== incarnation || previous.result?.receipt
        || !["created", "committed"].includes(previous.phase)) fail("REVISION_CONFLICT");
      action = ({ "data-snapshot": "snapshot", "code-rollback": "code", "data-restore": "restore" })[previous.kind];
      if (!action) fail();
      const pin = previous.result.request;
      preview = action === "snapshot" ? null : { ...pin,
        previewDigest: crypto.createHash("sha256").update(JSON.stringify(pin)).digest("hex") };
    }
    if (input.action === "snapshot" && this.store.hasPendingInstallationDisable(input.installationId)) fail("ACTIVATION_DEFERRED");
    if (generation !== this.#generation || this.#pending.size >= 32
      || this.store.getAuthorityIncarnation() !== incarnation) fail("PLUGIN_CONSENT_EXPIRED");
    const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    const challenge = crypto.randomUUID(), expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input: structuredClone(input), action, preview, incarnation, generation, expiresAt });
    return { challenge, expiresAt, summary: { action: `rollback-${input.action}`, package: release.name,
      fromDigest: installation.releaseDigest, targetDigest: action === "code" ? preview.targetDigest : installation.releaseDigest,
      snapshotId: input.snapshotId || preview?.snapshotId || null, byteLength: preview?.currentByteLength ?? null,
      dataLossRequired: preview?.dataLossRequired || false } };
  }
  async commit(input) {
    if (!exact(input, ["challenge", "approved"]) || !id(input.challenge) || typeof input.approved !== "boolean") fail();
    const pending = this.#pending.get(input.challenge); this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now() || pending.generation !== this.#generation) fail("PLUGIN_CONSENT_EXPIRED");
    const original = pending.input;
    try {
      if (!input.approved) return { canceled: true, receipt: null };
      if (this.store.getAuthorityIncarnation() !== pending.incarnation) fail("REVISION_CONFLICT");
      const commit = pending.action === "snapshot" ? this.rollback.createSnapshot(original)
        : pending.action === "code" ? this.rollback.rollbackCode({ preview: pending.preview, operationId: original.operationId })
          : this.rollback.restoreData({ preview: pending.preview, operationId: original.operationId, approvedDataLoss: true });
      await commit;
      return { canceled: false, receipt: publicReceipt(this.store.getOperation(original.operationId)) };
    } finally {
      if (!this.store.hasPendingInstallationDisable(original.installationId)) this.resumeInstallation(original.installationId);
    }
  }
  sweep() {
    for (const [challenge, pending] of this.#pending) if (pending.expiresAt <= this.now()) this.#pending.delete(challenge);
  }
  clear() { this.#generation++; this.#pending.clear(); }
}
module.exports = { PluginRollbackController };
