#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { prepareHermesPluginSelection, validateHermesSelectionReceipt, validateHermesSelectionAcknowledgement,
  cancelHermesPluginSelectionSession, readHermesPluginSelectionOperation } = require("../app/core/hermes-plugin-selection");

const args = { runtimeId: "ui-session", agentId: "hermes-fixture", operationId: "selected-operation",
  pluginSelection: [{ installationId: "fixture-installation", revision: 2 }] };
const capabilities = { version: 1, runtime_session_id: "physical-session", adapters: [{
  required_adapter_id: "shoggoth_shared_capabilities", adapter_generation: "host-generation",
  instance_id: "gateway-instance", agent_id: args.agentId }] };
function authority(input, state) {
  const envelope = { version: 1, operationId: input.operationId, dispatchRef: "service-generated-reference",
    selectionDigest: "a".repeat(64), requiredAdapterId: input.requiredAdapterId, adapterGeneration: input.adapterGeneration };
  return { envelope, receipt: { ...envelope, subject: input.subject, state,
    identity: ["bound", "completed"].includes(state)
      ? { ...input.subject, taskId: "actual-task", turnId: "actual-turn" } : null,
    createdAt: 1000, updatedAt: 1000, expiresAt: 10000000000000 } };
}
function missing() {
  return Object.assign(new Error("not found"), { jsonRpc: true, code: 4096, contractCode: "SELECTION_NOT_FOUND" });
}
async function main() {
  let capability = capabilities, previous = null, state = "prepared", getError = null;
  const hostCalls = [], serviceCalls = [];
  const requestHost = async (method, params) => {
    hostCalls.push({ method, params });
    if (method === "prompt.selection.capabilities") return structuredClone(capability);
    if (getError) throw getError;
    if (previous === null) throw missing();
    return { selection_dispatch: structuredClone(previous) };
  };
  const service = { prepareExternalPluginSelection: async input => {
    serviceCalls.push(input); return authority(input, state);
  }, cancelSessionExternalPluginSelections: async input => { serviceCalls.push(input); return []; } };
  const prepared = await prepareHermesPluginSelection({ ...args, requestHost, service });
  assert.equal(prepared.wire.operation_id, args.operationId);
  assert.equal(prepared.wire.required_adapter_id, "shoggoth_shared_capabilities");
  assert.equal(prepared.wire.dispatch_ref, "service-generated-reference");
  assert.deepEqual(serviceCalls[0].subject, { backendId: "hermes", instanceId: "gateway-instance",
    agentId: args.agentId, sessionId: "physical-session" });
  assert.deepEqual(hostCalls.map(item => item.method), ["prompt.selection.capabilities", "prompt.selection.get"]);
  assert.equal(hostCalls[1].params.session_id, "ui-session", "UI id is used only to address Host RPC");
  const receipt = { ...prepared.wire, dispatch_id: "host-dispatch", state: "queued",
    actual_session_id: null, actual_task_id: null, actual_turn_id: null, error_code: null };
  const bound = { ...receipt, state: "bound", actual_session_id: "physical-session",
    actual_task_id: "actual-task", actual_turn_id: "actual-turn" };
  assert.deepEqual(validateHermesSelectionReceipt(receipt, prepared.selection), receipt);
  assert.deepEqual(validateHermesSelectionAcknowledgement({ status: "queued", selection_dispatch: receipt }, prepared.selection), receipt);
  assert.deepEqual(validateHermesSelectionAcknowledgement({ status: "streaming", selection_dispatch: bound }, prepared.selection), bound);
  // Fast completion can precede the first outer ACK; a durable uncertain receipt
  // never establishes acceptance, even if the outer ACK still says streaming.
  assert.equal(validateHermesSelectionAcknowledgement({ status: "streaming",
    selection_dispatch: { ...bound, state: "complete" } }, prepared.selection).state, "complete");
  for (const status of ["streaming", "queued"]) for (const state of ["unknown", "interrupted"]) {
    assert.throws(() => validateHermesSelectionAcknowledgement({ status,
      selection_dispatch: { ...bound, state } }, prepared.selection), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  }
  for (const ack of [{ status: "streaming", selection_dispatch: receipt },
    { status: "queued", selection_dispatch: { ...receipt, state: "accepted" } },
    { status: "streaming", selection_dispatch: bound, replayed: "true" }]) {
    assert.throws(() => validateHermesSelectionAcknowledgement(ack, prepared.selection), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  }
  assert.deepEqual(validateHermesSelectionReceipt({ ...bound, runtime_session_id: "physical-session" }, prepared.selection, true),
    { ...bound, runtime_session_id: "physical-session" });
  for (const bad of [{ ...bound, actual_session_id: "neighbor-session" }, { ...bound, actual_turn_id: null },
    { ...bound, operation_id: "neighbor-operation" }, { ...bound, adapter_generation: "new-generation" },
    { ...bound, selection_digest: "b".repeat(64) }, { ...bound, actual_task_id: "" },
    { ...receipt, state: "bound" }, { ...receipt, access_token: "extra" }]) {
    assert.throws(() => validateHermesSelectionReceipt(bad, prepared.selection), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  }
  assert.throws(() => validateHermesSelectionReceipt({ ...bound, runtime_session_id: "neighbor" }, prepared.selection, true),
    { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  const beforeUnsupported = serviceCalls.length;
  for (const unsupported of [null, { ...capabilities, version: 2 }, { ...capabilities, adapters: [] },
    { ...capabilities, runtime_session_id: "" }, { ...capabilities, adapters: [...capabilities.adapters, ...capabilities.adapters] },
    { ...capabilities, adapters: [{ ...capabilities.adapters[0], agent_id: "neighbor" }] },
    { ...capabilities, adapters: [{ ...capabilities.adapters[0], token: "extra" }] }]) {
    capability = unsupported;
    await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service }), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
  }
  assert.equal(serviceCalls.length, beforeUnsupported);
  capability = capabilities;
  for (const selection of [[], [{ installationId: "fixture-installation", revision: 2, authority: "forged" }],
    [{ installationId: "fixture-installation", revision: 0 }]]) {
    await assert.rejects(prepareHermesPluginSelection({ ...args, pluginSelection: selection, requestHost, service }));
  }
  assert.equal(serviceCalls.length, beforeUnsupported);
  const beforeErrors = serviceCalls.length;
  for (const error of [Object.assign(new Error("timeout"), { code: "TIMEOUT" }),
    Object.assign(new Error("wrong RPC code"), { jsonRpc: true, code: 4096 }),
    Object.assign(new Error("wrong contract code"), { jsonRpc: true, code: 4096, contractCode: "SELECTION_DENIED" })]) {
    getError = error;
    await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service }), error);
  }
  assert.equal(serviceCalls.length, beforeErrors, "transport and owner errors cannot mean a new operation");
  getError = null;
  previous = { ...bound, state: "complete" };
  state = "completed";
  assert.deepEqual((await prepareHermesPluginSelection({ ...args, requestHost, service })).wire, prepared.wire);
  const beforeQueries = serviceCalls.length;
  for (const [hostState, expected] of Object.entries({ accepted: "accepted", queued: "queued", binding: "running",
    bound: "running", complete: "completed", stopped: "canceled", failed: "failed", canceled: "canceled",
    cancelled: "canceled", interrupted: "interrupted", unknown: "needs_verification" })) {
    previous = { ...bound, state: hostState };
    const result = await readHermesPluginSelectionOperation({ ...args, sessionKey: "agent:hermes-fixture:chat", requestHost });
    assert.equal(result.status, "found");
    assert.equal(result.admissionAccepted, true);
    assert.equal(result.run.status, expected);
  }
  assert.equal(serviceCalls.length, beforeQueries, "observation never prepares a new dispatch");
  for (const changed of [{ ...bound, adapter_generation: "prior-generation" },
    { ...bound, actual_session_id: "prior-physical-session" }]) {
    previous = changed;
    await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  }
  assert.equal(serviceCalls.length, beforeQueries, "changed Host identity cannot mint a new dispatch");
  previous = { ...bound, state: "unknown" };
  await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  previous = null;
  state = "outcome_unknown";
  await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service }), { code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  assert.equal((await readHermesPluginSelectionOperation({ ...args, sessionKey: "agent:hermes-fixture:chat", requestHost })).status, "not_found");
  state = "prepared";
  let release;
  const mutable = structuredClone(args);
  const waiting = prepareHermesPluginSelection({ ...mutable, service, requestHost: async (method) => {
    if (method === "prompt.selection.capabilities") {
      await new Promise(resolve => { release = resolve; }); return capabilities;
    }
    throw missing();
  } });
  mutable.pluginSelection[0].revision = 99;
  release();
  await waiting;
  assert.equal(serviceCalls.at(-1).pluginSelection[0].revision, 2);
  let checks = 0;
  await assert.rejects(prepareHermesPluginSelection({ ...args, requestHost, service,
    assertCurrent: () => { if (++checks === 1) throw new Error("connection changed"); } }), /connection changed/);
  await cancelHermesPluginSelectionSession({ ...args, requestHost, service });
  assert.deepEqual(serviceCalls.at(-1), { subject: prepared.selection.subject });
  assert.equal(hostCalls.filter(item => item.method === "prompt.submit").length, 0);
  const { HermesBackend } = require("../app/core/hermes-backend");
  for (const state of ["unknown", "interrupted", "complete", "failed"]) {
    const backend = Object.create(HermesBackend.prototype);
    const sessionKey = "agent:hermes-fixture:chat";
    let accepted = 0, delta = 0, errors = 0;
    const sock = { generation: 1, restoreServerRequests() {}, replayServerRequests() {}, request: async method => {
      if (method === "prompt.selection.capabilities") return capabilities;
      if (method === "prompt.selection.get") throw missing();
      assert.equal(method, "prompt.submit");
      backend.gwTurns.get(args.runtimeId).hooks.delta("unconfirmed-before-ACK");
      return { status: "streaming", replayed: state === "complete",
        selection_dispatch: { ...bound, state, ...(state === "failed" ? {
          actual_session_id: null, actual_task_id: null, actual_turn_id: null, error_code: "SELECTION_GATE_FAILED",
        } : {}) } };
    } };
    Object.assign(backend, { _sessionTarget: () => ({ tail: "chat", dash: {} }), _gwSocket: () => sock,
      _externalPluginSelectionService: service, gwSockets: new Map([["default", sock]]),
      gwRuntimeByKey: new Map([[sessionKey, { runtimeId: args.runtimeId, generation: 1 }]]),
      gwTurns: new Map(), gwUsageByKey: new Map(), nextTurnConfigs: new Map(), freshSessionKeys: new Set(), freshSessionTransports: new Map() });
    await backend._sendViaGateway({ sessionKey, message: "original operation", profile: "default", transcript: [],
      atts: { images: [], pdfs: [], files: [] }, assertCurrentGeneration: () => {}, requiredTransport: "gateway",
      pluginSelection: args.pluginSelection, operationId: args.operationId,
      hooks: { accepted: () => accepted++, delta: () => delta++, error: (_text, meta) => {
        assert.equal(meta.executionUncertain, true); errors++;
      }, final: (_text, _failed, meta) => { assert.equal(meta.executionUncertain, true); errors++; } } });
    assert.deepEqual({ accepted, delta, errors, turns: backend.gwTurns.size }, { accepted: 0, delta: 0, errors: 1, turns: 0 });
  }
  console.log("Hermes selection App bridge: PASS (physical owner, immutable queued choice, strict receipts/events, replay, observation, restart unknown and exact session Stop; no model/remote calls)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
