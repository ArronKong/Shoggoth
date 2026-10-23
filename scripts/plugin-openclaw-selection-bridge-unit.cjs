#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { prepareOpenClawPluginSelection, validateOpenClawSelectionReceipt,
  cancelOpenClawPluginSelectionSession, readOpenClawPluginSelectionOperation } = require("../app/core/openclaw-plugin-selection");

const params = { sessionKey: "agent:main:test", idempotencyKey: "selection-operation",
  message: "Use the selected plugin", pluginSelection: [{ installationId: "fixture-installation", revision: 2 }] };
const capability = { version: 1, host: "openclaw", hostVersion: "2026.9.5", wire: "capabilitySelection",
  receiptMethod: "chat.selection.get", supportedQueueModes: ["followup"], supportedHarnesses: ["openclaw"],
  adapters: [{ adapterId: "shoggoth-shared-capabilities", adapterGeneration: "host-generation", instanceId: "gateway-instance" }],
  subject: { agentId: "main", sessionKey: params.sessionKey, sessionId: "physical-session" } };
function authority(input, state = "prepared") {
  const envelope = { version: 1, operationId: input.operationId, dispatchRef: "service-generated-ref",
    selectionDigest: "a".repeat(64), requiredAdapterId: input.requiredAdapterId, adapterGeneration: input.adapterGeneration };
  return { envelope, receipt: { ...envelope, subject: input.subject, state,
    identity: ["bound", "completed"].includes(state) ? { ...input.subject, runId: "actual-host-run" } : null,
    createdAt: 1000, updatedAt: 1000, expiresAt: 10000000000000 } };
}
async function main() {
  const hostCalls = [], serviceCalls = [];
  let capabilities = capability, previous = null, state = "prepared";
  const requestHost = async (method, values) => {
    hostCalls.push({ method, values });
    return structuredClone(method === "chat.selection.capabilities" ? capabilities : previous);
  };
  const service = { prepareExternalPluginSelection: async input => {
    serviceCalls.push(input); return authority(input, state);
  }, cancelSessionExternalPluginSelections: async input => { serviceCalls.push(input); return []; } };
  const prepared = await prepareOpenClawPluginSelection({ params, requestHost, service });
  assert.equal(prepared.params.sessionId, "physical-session");
  assert.equal(prepared.params.capabilitySelection.dispatchRef, "service-generated-ref");
  assert(!Object.hasOwn(prepared.params, "pluginSelection"));
  assert.deepEqual(serviceCalls[0].subject, { backendId: "openclaw", agentId: "main",
    instanceId: "gateway-instance", sessionId: "physical-session" });
  assert.deepEqual(hostCalls.map(item => item.method), ["chat.selection.capabilities", "chat.selection.get"]);
  const receipt = { ...prepared.selection.envelope, agentId: "main", sessionKey: params.sessionKey,
    sessionId: "physical-session", clientRunId: params.idempotencyKey, actualRunId: null,
    status: "accepted", acceptedAt: 1000, updatedAt: 1000 };
  assert.deepEqual(validateOpenClawSelectionReceipt(receipt, prepared.selection), receipt);
  for (const bad of [{ ...receipt, sessionId: "neighbor-session" }, { ...receipt, agentId: "neighbor" },
    { ...receipt, clientRunId: "another-operation" }, { ...receipt, adapterGeneration: "changed" },
    { ...receipt, selectionDigest: "b".repeat(64) }, { ...receipt, status: "bound" }, { ...receipt, token: "extra" }]) {
    assert.throws(() => validateOpenClawSelectionReceipt(bad, prepared.selection), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  }
  const initialServices = serviceCalls.length;
  for (const invalidCapabilities of [null, { ...capability, hostVersion: "different" },
    { ...capability, adapters: [] }, { ...capability, adapters: [...capability.adapters, ...capability.adapters] },
    { ...capability, subject: { ...capability.subject, agentId: "neighbor" } },
    { ...capability, adapters: [{ ...capability.adapters[0], token: "extra" }] }]) {
    capabilities = invalidCapabilities;
    await assert.rejects(prepareOpenClawPluginSelection({ params, requestHost, service }), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
  }
  assert.equal(serviceCalls.length, initialServices, "unsupported Host never creates Service authority");
  capabilities = capability;
  for (const invalidParams of [{ ...params, capabilitySelection: prepared.selection.envelope },
    { ...params, sessionId: "guessed-ui-id" }, { ...params, idempotencyKey: "" },
    { ...params, pluginSelection: [{ installationId: "fixture-installation", revision: 2, packageName: "forged" }] }]) {
    await assert.rejects(prepareOpenClawPluginSelection({ params: invalidParams, requestHost, service }));
  }
  previous = { ...receipt, actualRunId: "actual-host-run", status: "completed" };
  state = "completed";
  const replay = await prepareOpenClawPluginSelection({ params, requestHost, service });
  assert.deepEqual(replay.params.capabilitySelection, prepared.params.capabilitySelection);
  assert.equal((await readOpenClawPluginSelectionOperation({ sessionKey: params.sessionKey,
    operationId: params.idempotencyKey, requestHost })).run.status, "completed");
  previous = { ...previous, status: "needs-verification" };
  assert.equal((await readOpenClawPluginSelectionOperation({ sessionKey: params.sessionKey,
    operationId: params.idempotencyKey, requestHost })).run.status, "needs_verification");
  previous = { ...previous, status: "completed" };
  const originalCompleted = previous;
  previous = { ...previous, operationId: "neighbor-operation" };
  await assert.rejects(readOpenClawPluginSelectionOperation({ sessionKey: params.sessionKey,
    operationId: params.idempotencyKey, requestHost }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  previous = originalCompleted;
  assert.equal(hostCalls.filter(item => item.method === "chat.send").length, 0, "bridge only negotiates; Host owns replay admission");
  previous = { ...previous, adapterGeneration: "prior-host-generation" };
  const beforeChanged = serviceCalls.length;
  await assert.rejects(prepareOpenClawPluginSelection({ params, requestHost, service }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  assert.equal(serviceCalls.length, beforeChanged, "old generation cannot mint another dispatch");
  previous = null;
  assert.equal((await readOpenClawPluginSelectionOperation({ sessionKey: params.sessionKey,
    operationId: params.idempotencyKey, requestHost })).status, "not_found");
  state = "outcome_unknown";
  await assert.rejects(prepareOpenClawPluginSelection({ params, requestHost, service }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  state = "prepared";
  let release;
  const mutable = structuredClone(params);
  const waiting = prepareOpenClawPluginSelection({ params: mutable, service,
    requestHost: async (method, value) => {
      if (method === "chat.selection.capabilities") { await new Promise(resolve => { release = resolve; }); return capability; }
      return null;
    } });
  mutable.pluginSelection[0].revision = 99;
  mutable.message = "changed while waiting";
  release();
  const immutable = await waiting;
  assert.equal(immutable.params.message, params.message);
  assert.equal(serviceCalls.at(-1).pluginSelection[0].revision, 2);
  await cancelOpenClawPluginSelectionSession({ sessionKey: params.sessionKey, requestHost, service });
  assert.deepEqual(serviceCalls.at(-1), { subject: prepared.selection.subject });
  console.log("OpenClaw selection App bridge: PASS (Host negotiation, physical identity, version/generation, immutable input, replay and exact session Stop; no model/remote calls)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
