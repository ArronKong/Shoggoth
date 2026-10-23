#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { ensureCredential } = require("../app/agent-service/external-plugin-adapter-auth");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { validateExternalPluginSelectionResult } = require("../app/core/plugin-external-selection-dto");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgselsvc-")));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let service;
  let verifications = 0;
  const create = () => createAgentService({ paths, prewarmMcpAuth: false,
    externalPluginAgentVerifier: async identity => {
      verifications += 1;
      return identity.agentId.startsWith("accepted-")
        ? { id: identity.agentId, backendId: identity.backendId } : null;
    }, version: "external-selection-service-fixture" });
  const request = (method, params, token) => requestService(paths, {
    version: SERVICE_PROTOCOL_VERSION, method, params, ...(token === undefined ? {} : { token }),
  }, { timeoutMs: 10_000 });
  const backend = new ShoggothBackend({ paths });
  const subject = { backendId: "openclaw", instanceId: "isolated-openclaw",
    agentId: "accepted-openclaw", sessionId: "actual-chat-session" };
  const identity = { ...subject, runId: "actual-host-run" };
  try {
    const credential = ensureCredential(paths, "openclaw");
    const hermesCredential = ensureCredential(paths, "hermes");
    service = create();
    await service.start();
    const source = path.join(root, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
    const preview = service.pluginPackageInstaller.preview(source);
    const installed = service.pluginPackageInstaller.install({ sourcePath: source,
      previewDigest: preview.contentDigest, operationId: "selection-service-install", expectedRevision: 0 });
    const active = service.pluginStore.setInstallationDesiredState({
      installationId: installed.installationId, expectedRevision: installed.revision, desiredState: "enabled" });
    const input = { subject, operationId: "service-selected-send",
      requiredAdapterId: "shoggoth-shared-capabilities", adapterGeneration: "host-generation",
      pluginSelection: [{ installationId: active.installationId, revision: active.revision }] };
    for (const token of [undefined, credential]) {
      await assert.rejects(request("plugins.selection.external.prepare", input, token), { code: "AUTH_FAILED" });
    }
    const prepared = await backend.prepareExternalPluginSelection(input);
    assert.equal(prepared.receipt.state, "prepared");
    assert(Object.isFrozen(prepared.receipt.subject));
    assert.deepEqual(await backend.prepareExternalPluginSelection(input), prepared);
    await assert.rejects(backend.prepareExternalPluginSelection({ ...input,
      adapterGeneration: "another-generation" }), { code: "EXTERNAL_PLUGIN_SELECTION_CONFLICT" });
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: prepared.envelope, identity, pluginSelection: input.pluginSelection,
    }), { code: "MCP_AUTH_REQUEST_INVALID" });
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: readClientToken(paths), envelope: prepared.envelope, identity,
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: hermesCredential, envelope: prepared.envelope, identity,
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: prepared.envelope,
      identity: { ...identity, sessionId: "neighbor-session" },
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(verifications, 0);
    const bound = await request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: prepared.envelope, identity,
    });
    assert.equal(verifications, 1);
    assert.deepEqual(bound.receipt.identity, identity);
    assert.equal(bound.selectedPlugins[0].packageName, "project-assistant");
    assert.deepEqual(await backend.getExternalPluginSelection({ subject, operationId: input.operationId }), bound.receipt);
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: prepared.envelope, identity: { ...identity, runId: "neighbor-run" },
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.deepEqual(await backend.getExternalPluginSelection({
      subject: { ...subject, sessionId: "neighbor-session" }, operationId: input.operationId }), null);
    const finished = await request("plugin.external.selection.finish", {
      credentialToken: credential, envelope: prepared.envelope, identity,
    });
    assert.equal(finished.state, "completed");
    assert.equal((await backend.getExternalPluginSelection({ subject, operationId: input.operationId })).state, "completed");
    await assert.rejects(request("plugin.external.open", { credentialToken: credential,
      identity: { ...identity, toolCallId: "post-completion-tool" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    const selectedForLease = await backend.prepareExternalPluginSelection({ ...input, operationId: "lease-selected" });
    const leaseIdentity = { ...identity, runId: "actual-lease-run" };
    await request("plugin.external.selection.bind", { credentialToken: credential,
      envelope: selectedForLease.envelope, identity: leaseIdentity });
    const toolIdentity = { ...leaseIdentity, toolCallId: "selected-tool-call" };
    await assert.rejects(request("plugin.external.open", { credentialToken: credential,
      identity: toolIdentity }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    const selectedLease = await request("plugin.external.open", { credentialToken: credential,
      identity: toolIdentity, selectionEnvelope: selectedForLease.envelope });
    const ordinaryIdentity = { ...identity, runId: "ordinary-unselected-run", toolCallId: "ordinary-tool-call" };
    const ordinaryLease = await request("plugin.external.open", { credentialToken: credential, identity: ordinaryIdentity });
    assert.equal((await backend.cancelExternalPluginSelection({ subject, operationId: "lease-selected" })).state, "canceled");
    await assert.rejects(request("plugin.external.search", { token: selectedLease.token,
      identity: toolIdentity, query: "", cursor: 0, limit: 5 }), { code: "EXTERNAL_PLUGIN_LEASE_INVALID" });
    await assert.rejects(request("plugin.external.open", { credentialToken: credential,
      identity: { ...leaseIdentity, toolCallId: "omitted-envelope-after-stop" } }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.equal(typeof (await request("plugin.external.search", { token: ordinaryLease.token,
      identity: ordinaryIdentity, query: "", cursor: 0, limit: 5 })).revision, "string");
    for (const field of ["operationId", "dispatchRef", "selectionDigest", "requiredAdapterId", "adapterGeneration"]) {
      const bad = structuredClone(prepared);
      bad.envelope[field] = field === "selectionDigest" ? "0".repeat(64) : "different";
      assert.throws(() => validateExternalPluginSelectionResult("plugins.selection.external.prepare", bad, input));
    }
    for (const bad of [
      { ...bound.receipt, subject: { ...subject, agentId: "another-agent" } },
      { ...bound.receipt, identity: null },
      { ...bound.receipt, identity: { ...identity, sessionId: "another-session" } },
      { ...bound.receipt, secret: "do-not-forward" },
    ]) assert.throws(() => validateExternalPluginSelectionResult("plugins.selection.external.get", bad,
      { subject, operationId: input.operationId }));
    const pending = await backend.prepareExternalPluginSelection({ ...input, operationId: "pending-before-restart" });
    const pendingQuery = { subject, operationId: pending.envelope.operationId };
    const cancel = await backend.prepareExternalPluginSelection({ ...input, operationId: "cancel-selected" });
    assert.equal((await backend.cancelExternalPluginSelection({ subject, operationId: cancel.envelope.operationId })).state, "canceled");
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: cancel.envelope, identity,
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });

    // Exercise the actual shipped adapter against this real Service. The
    // real Host core is tested separately; this small API facade owns only
    // registration/identity input and never runs a model.
    const { createAdapter } = await import("../resources/external-plugin-adapters/openclaw/index.mjs");
    const adapterSubject = { ...subject, instanceId: "canonical-gateway-adapter" };
    let gate, terminal;
    const production = createAdapter({ instanceId: adapterSubject.instanceId,
      credential: () => credential, requestService: (method, params) => request(method, params) });
    production.register({
      registerCapabilitySelectionGate(callback, metadata) {
        assert.equal(metadata.instanceId, adapterSubject.instanceId);
        gate = callback;
        terminal = metadata.onTerminal;
        return { version: 1, adapterId: input.requiredAdapterId,
          adapterGeneration: input.adapterGeneration, instanceId: metadata.instanceId };
      }, on() {}, registerTool() {},
    });
    const adapterPrepared = await backend.prepareExternalPluginSelection({ ...input,
      subject: adapterSubject, operationId: "production-adapter-selection" });
    const hostIdentity = { operationId: adapterPrepared.envelope.operationId,
      agentId: subject.agentId, sessionKey: "agent:accepted-openclaw:fixture",
      sessionId: subject.sessionId, actualRunId: "actual-production-adapter-run" };
    const gateInput = { capabilitySelection: adapterPrepared.envelope, identity: hostIdentity };
    const proved = await gate(gateInput);
    assert.deepEqual(proved.proof, { ...adapterPrepared.envelope, ...hostIdentity });
    assert(proved.prependSystemContext.includes('"packageName":"project-assistant"'));
    assert(!proved.prependSystemContext.includes(credential));
    const scoped = createAdapter({ instanceId: "separate-model-plugin-facade",
      credential: () => credential, requestService: (method, params) => request(method, params) });
    const coreContext = { agentId: subject.agentId, sessionId: subject.sessionId,
      runId: hostIdentity.actualRunId, capabilitySelection: adapterPrepared.envelope,
      selectionAdapterInstanceId: adapterSubject.instanceId };
    const tool = scoped.tool("shoggoth_capability_search", coreContext);
    scoped.beforeToolCall({ toolName: "shoggoth_capability_search", toolCallId: "canonical-core-call" }, coreContext);
    assert.equal(typeof (await tool.execute("canonical-core-call", { query: "" })).details.revision, "string");
    scoped.beforeToolCall({ toolName: "shoggoth_capability_search", toolCallId: "missing-core-context" }, {
      agentId: subject.agentId, sessionId: subject.sessionId, runId: hostIdentity.actualRunId });
    await assert.rejects(tool.execute("missing-core-context", { query: "" }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    await terminal({ ...gateInput, status: "completed" });
    assert.equal((await backend.getExternalPluginSelection({ subject: adapterSubject,
      operationId: adapterPrepared.envelope.operationId })).state, "completed");
    scoped.beforeToolCall({ toolName: "shoggoth_capability_search", toolCallId: "post-terminal-core-call" }, coreContext);
    await assert.rejects(tool.execute("post-terminal-core-call", { query: "" }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    const queued = await backend.prepareExternalPluginSelection({ ...input,
      subject: adapterSubject, operationId: "session-stop-queued" });
    const activeTurn = await backend.prepareExternalPluginSelection({ ...input,
      subject: adapterSubject, operationId: "session-stop-active" });
    await request("plugin.external.selection.bind", { credentialToken: credential,
      envelope: activeTurn.envelope, identity: { ...adapterSubject, runId: "session-stop-actual-run" } });
    const sessionCanceled = await backend.cancelSessionExternalPluginSelections({ subject: adapterSubject });
    assert.deepEqual(sessionCanceled.map(row => row.operationId).sort(),
      [queued.envelope.operationId, activeTurn.envelope.operationId].sort());
    assert(sessionCanceled.every(row => row.state === "canceled"));
    assert.equal((await request("plugin.external.selection.finish", { credentialToken: credential,
      envelope: activeTurn.envelope, identity: { ...adapterSubject, runId: "session-stop-actual-run" } })).state, "canceled");
    await assert.rejects(request("plugin.external.selection.finish", { credentialToken: credential,
      envelope: queued.envelope, identity: { ...adapterSubject, runId: "never-bound-queue-run" } }),
      { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    assert.deepEqual(await backend.cancelSessionExternalPluginSelections({ subject: adapterSubject }), []);
    assert.equal((await backend.getExternalPluginSelection({ subject: adapterSubject,
      operationId: adapterPrepared.envelope.operationId })).state, "completed");
    await service.stop();
    service = create();
    await service.start();
    assert.deepEqual(await request("plugin.external.selection.finish", {
      credentialToken: credential, envelope: prepared.envelope, identity,
    }), finished, "completion retry after restart is durable observation");
    assert.equal((await backend.getExternalPluginSelection(pendingQuery)).state, "outcome_unknown");
    const observed = await backend.prepareExternalPluginSelection({ ...input, operationId: pendingQuery.operationId });
    assert.deepEqual(observed.envelope, pending.envelope);
    assert.equal(observed.receipt.state, "outcome_unknown");
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: pending.envelope, identity,
    }), { code: "EXTERNAL_PLUGIN_SELECTION_INVALID" });
    await service.stop();
    service = null;
    fs.writeFileSync(path.join(paths.pluginsDir, "external-selection-dispatch.sqlite"), "damaged dispatch database");
    service = create();
    await service.start();
    assert.equal((await request("service.status", {}, readClientToken(paths))).healthy, true);
    await assert.rejects(backend.getExternalPluginSelection(pendingQuery), { code: "EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE" });
    await assert.rejects(request("plugin.external.selection.bind", {
      credentialToken: credential, envelope: pending.envelope, identity,
    }), { code: "EXTERNAL_PLUGIN_SELECTION_UNAVAILABLE" });
    console.log("external plugin selection Service IPC: PASS (App auth, trusted adapter bind, DTO, restart, damaged-store isolation; zero model/remote calls)");
  } finally {
    if (service) await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
