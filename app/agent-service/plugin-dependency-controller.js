"use strict";
const crypto = require("node:crypto");
const { componentId } = require("./plugin-component-catalog");
const { serviceError } = require("./security");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const id = value => typeof value === "string" && ID.test(value);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const fail = (code = "PLUGIN_REQUEST_INVALID") => { throw serviceError(code, "插件依赖请求无效或已变化"); };

class PluginDependencyController {
  #pending = new Map();
  constructor({ store, registry, drainInstallation, resumeInstallation, now = Date.now }) {
    Object.assign(this, { store, registry, drainInstallation, resumeInstallation, now });
  }
  #context(installationId, selectedId) {
    if (!id(installationId) || typeof selectedId !== "string" || !HASH.test(selectedId)) fail();
    const installation = this.store.getInstallation(installationId);
    if (!installation || installation.desiredState === "uninstalled") fail("PLUGIN_INSTALLATION_INVALID");
    const release = this.store.getRelease(installation.sourceIdentity, installation.releaseDigest);
    const component = release.components.mcpServers.find(value => componentId(installationId, "mcp-server", value.name) === selectedId);
    if (!component) fail("PLUGIN_COMPONENT_NOT_FOUND");
    return { installation, release, component, pin: { installationId, componentId: selectedId,
      releaseDigest: installation.releaseDigest, descriptorDigest: component.descriptorDigest } };
  }
  #disabled(context, expectedRevision) {
    if (context.installation.revision !== expectedRevision) fail("REVISION_CONFLICT");
    if (context.installation.desiredState !== "disabled"
      || this.store.hasPendingInstallationDisable(context.installation.installationId)) fail("DEPENDENCY_REQUIRES_DISABLE");
  }
  #receipt(value) {
    return { installationId: value.pin.installationId, componentId: value.pin.componentId,
      status: value.status, revision: value.expectedRevision, operationId: value.operationId || null,
      interpreter: value.interpreter, version: value.executable?.version || null };
  }
  status(input) {
    if (!exact(input, ["installationId", "componentId"])) fail();
    const { pin } = this.#context(input.installationId, input.componentId);
    return this.#receipt(this.registry.queryState(pin));
  }
  operation(input) {
    if (!exact(input, ["operationId"]) || !id(input.operationId)) fail();
    const value = this.registry.getOperation(input.operationId);
    return { operationId: input.operationId, found: Boolean(value), phase: value?.phase || null,
      receipt: value?.result ? this.#receipt(value.result) : null, reasonCode: value?.reasonCode || null };
  }
  preview(input) {
    const fields = ["action", "installationId", "componentId", "expectedRevision", "operationId"];
    if (!exact(input, input?.action === "prepare" ? [...fields, "executablePath"] : fields)
      || !["prepare", "revoke"].includes(input.action) || !id(input.operationId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail();
    const context = this.#context(input.installationId, input.componentId);
    this.#disabled(context, input.expectedRevision);
    const preview = input.action === "prepare" ? this.registry.preview({ ...context.pin, executablePath: input.executablePath })
      : this.registry.queryState(context.pin);
    if (input.action === "revoke" && preview.expectedRevision < 1) fail("DEPENDENCY_PREPARATION_REQUIRED");
    for (const [id, pending] of this.#pending) if (pending.expiresAt <= this.now()) this.#pending.delete(id);
    if (this.#pending.size >= 32) fail("PLUGIN_CONSENT_BUSY");
    const challenge = crypto.randomUUID(), expiresAt = this.now() + 120_000;
    this.#pending.set(challenge, { input: structuredClone(input), context, preview, expiresAt });
    return { challenge, expiresAt, summary: { action: `dependency-${input.action}`,
      package: context.release.name, capability: context.component.name, interpreter: preview.interpreter,
      executablePath: preview.executable?.canonicalPath || null, sha256: preview.executable?.sha256 || null } };
  }
  async commit(input) {
    if (!exact(input, ["challenge", "approved"]) || !id(input.challenge) || typeof input.approved !== "boolean") fail();
    const pending = this.#pending.get(input.challenge);
    this.#pending.delete(input.challenge);
    if (!pending || pending.expiresAt <= this.now()) fail("PLUGIN_CONSENT_EXPIRED");
    if (!input.approved) return { canceled: true, receipt: null };
    const { input: original, preview } = pending;
    const check = () => {
      const context = this.#context(original.installationId, original.componentId);
      this.#disabled(context, original.expectedRevision);
      if (JSON.stringify(context) !== JSON.stringify(pending.context)) fail("REVISION_CONFLICT");
    };
    check();
    // Disabled installations have already revoked all Grants. Wait for the old
    // process before changing the executable; no authorization survives it.
    await this.drainInstallation(original.installationId);
    try {
      check();
      const args = { ...pending.context.pin, expectedRevision: preview.expectedRevision,
        operationId: original.operationId, confirmed: true };
      const result = original.action === "prepare" ? this.registry.prepare({ ...args,
        executablePath: original.executablePath, previewDigest: preview.previewDigest }) : this.registry.revoke(args);
      return { canceled: false, receipt: this.#receipt(result) };
    } finally { this.resumeInstallation(original.installationId); }
  }
  clear() { this.#pending.clear(); }
}
module.exports = { PluginDependencyController };
