#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { GogGmailConnectionController } =
  require("../app/agent-service/plugin-gogcli-gmail-controller");
const { SOURCE_IDENTITY, COMPONENT_NAME, TRANSPORT } =
  require("../app/agent-service/plugin-gogcli-gmail-sidecar");

const HASH = "a".repeat(64);
const input = { profileId: "agent", installationId: "gmail-install", componentId: HASH,
  expectedRevision: 1, operationId: "gmail-connect-1", email: "test@example.com" };
const recoveryInput = { profileId: input.profileId, installationId: input.installationId,
  componentId: input.componentId, expectedRevision: input.expectedRevision,
  email: input.email };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const connections = new Map(), operations = new Map(), bindings = new Map();
  let resolveAuth, policyRevision = 1, aborted = false, pendingAuth = false;
  let credentialPresent = false;
  let failOperation = false, failCommit = false, time = 0;
  const runtime = {
    status: () => ({ configured: true }),
    capabilities: () => ({ revision: policyRevision }),
    hasPendingAuthorization: () => pendingAuth,
    pendingAuthorization: () => pendingAuth ? { email: input.email, client: "shoggoth" } : null,
    reconcilePendingAuthorization: async email => {
      assert.equal(email, input.email);
      if (credentialPresent) throw Object.assign(new Error("credential still present"),
        { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
      const recovered = pendingAuth;
      pendingAuth = false;
      return { recovered };
    },
    commitAuthorization: email => {
      assert.equal(email, input.email);
      assert.equal(pendingAuth, true);
      if (failCommit) throw Object.assign(new Error("marker cleanup failed"),
        { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
      pendingAuth = false;
    },
    authorize: (_email, { signal }) => new Promise((resolve, reject) => {
      resolveAuth = resolve;
      signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(
        new Error("canceled"), { code: "GMAIL_AUTH_CANCELED" })); }, { once: true });
    }),
  };
  const component = () => ({ installation: { installationId: input.installationId,
    sourceIdentity: SOURCE_IDENTITY, releaseDigest: HASH, desiredState: "enabled", revision: 1 },
  component: { name: COMPONENT_NAME, transport: TRANSPORT, spec: { type: TRANSPORT },
    descriptorDigest: HASH } });
  const store = {
    listGlobalBindings: () => [...bindings.values()],
    getOperation: id => operations.get(id) || null,
    getConnection: id => connections.get(id) || null,
    createConnection: value => {
      const connection = { ...value, revision: 1, authRevision: 0, state: "pending",
        principalIdentity: null };
      connections.set(value.connectionId, connection); return connection;
    },
    setConnectionIdentity: ({ connectionId, principalIdentity, state, expectedRevision }) => {
      const connection = connections.get(connectionId);
      assert.equal(connection.revision, expectedRevision);
      const next = { ...connection, principalIdentity, state,
        revision: expectedRevision + 1, authRevision: connection.authRevision + 1 };
      connections.set(connectionId, next); return next;
    },
    listBindingsForConnection: connectionId => [...bindings.values()].filter(item => item.connectionId === connectionId),
    disconnectMcpConnection: ({ connectionId, expectedRevision }) =>
      store.setConnectionIdentity({ connectionId, principalIdentity: "unverified",
        state: "disconnected", expectedRevision }),
    performManagementOperation: ({ operationId, apply }) => {
      if (failOperation) throw Object.assign(new Error("binding failed"),
        { code: "REVISION_CONFLICT" });
      const result = apply(); operations.set(operationId, result); return { result };
    },
    createGlobalBinding: value => {
      const binding = { ...value, enabled: false, revision: 1 };
      bindings.set(value.bindingId, binding); return binding;
    },
    setMcpBindingConnection: ({ bindingId, connectionId, expectedRevision }) => {
      const current = bindings.get(bindingId);
      assert.equal(current.revision, expectedRevision);
      const binding = { ...current, connectionId, revision: current.revision + 1 };
      bindings.set(bindingId, binding); return binding;
    },
    setBindingEnabled: ({ bindingId, enabled, expectedRevision }) => {
      const current = bindings.get(bindingId);
      assert.equal(current.revision, expectedRevision);
      const binding = { ...current, enabled, revision: current.revision + 1 };
      bindings.set(bindingId, binding); return binding;
    },
  };
  const controller = new GogGmailConnectionController({ store,
    productStore: { getAgentProfile: () => ({ id: "agent", enabled: true }) },
    manager: { component }, runtime, now: () => time });
  return { controller, connections, bindings, operations,
    resolveAuth: email => { pendingAuth = true; credentialPresent = true; resolveAuth(email); },
    setPendingAuth: value => { pendingAuth = value; credentialPresent = value; },
    setCredentialPresent: value => { credentialPresent = value; },
    hasPendingAuth: () => pendingAuth,
    failBinding: () => { failOperation = true; },
    failMarkerCommit: () => { failCommit = true; },
    advance: delta => { time += delta; },
    changePolicy: () => { policyRevision += 1; }, wasAborted: () => aborted };
}

async function main() {
  const canceled = fixture();
  const start = canceled.controller.start(input);
  await assert.rejects(canceled.controller.reconcile(recoveryInput), { code: "GMAIL_AUTH_CONFLICT" });
  assert.equal(start.flow.status, "pending");
  assert.equal(canceled.connections.size, 0, "no pending Connection before real API verification");
  const result = canceled.controller.cancel({ profileId: input.profileId, flowId: start.flow.flowId });
  assert.equal(result.status, "pending", "wait for auth add process to exit before settling cancellation");
  await settle();
  assert.equal(canceled.controller.status({ profileId: input.profileId,
    flowId: start.flow.flowId }).status, "canceled");
  assert.equal(canceled.bindings.size, 0);
  assert.equal(canceled.wasAborted(), true);

  const canceledAfterStore = fixture();
  const stored = canceledAfterStore.controller.start(input);
  canceledAfterStore.setPendingAuth(true);
  canceledAfterStore.controller.cancel({ profileId: input.profileId, flowId: stored.flow.flowId });
  await settle();
  const residual = canceledAfterStore.controller.status({ profileId: input.profileId,
    flowId: stored.flow.flowId });
  assert.equal(residual.status, "failed");
  assert.equal(residual.reasonCode, "GMAIL_AUTH_RECOVERY_REQUIRED");
  assert.equal(canceledAfterStore.bindings.size, 0);
  assert.deepEqual(canceledAfterStore.controller.pendingAuthorization({
    profileId: input.profileId, installationId: input.installationId,
    componentId: input.componentId, expectedRevision: input.expectedRevision,
  }), { email: input.email, client: "shoggoth" });
  await assert.rejects(canceledAfterStore.controller.reconcile(recoveryInput),
    { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
  canceledAfterStore.setCredentialPresent(false);
  assert.deepEqual(await canceledAfterStore.controller.reconcile(recoveryInput), { recovered: true });
  assert.equal(canceledAfterStore.controller.pendingAuthorization({
    profileId: input.profileId, installationId: input.installationId,
    componentId: input.componentId, expectedRevision: input.expectedRevision,
  }), null);

  const timedOut = fixture();
  const timed = timedOut.controller.start(input);
  timedOut.advance(330_001);
  assert.equal(timedOut.controller.status({ profileId: input.profileId,
    flowId: timed.flow.flowId }).status, "pending");
  await settle();
  const expired = timedOut.controller.status({ profileId: input.profileId,
    flowId: timed.flow.flowId });
  assert.equal(expired.status, "failed");
  assert.equal(expired.reasonCode, "GMAIL_AUTH_FAILED");

  const stale = fixture();
  const pending = stale.controller.start(input);
  stale.changePolicy();
  stale.resolveAuth(input.email);
  await settle();
  const staleState = stale.controller.status({ profileId: input.profileId, flowId: pending.flow.flowId });
  assert.equal(staleState.status, "failed");
  assert.equal(staleState.reasonCode, "GMAIL_AUTH_RECOVERY_REQUIRED");
  assert.equal(stale.bindings.size, 0, "stale policy cannot publish a binding");

  const failedBinding = fixture();
  const bindingFlow = failedBinding.controller.start(input);
  failedBinding.failBinding();
  failedBinding.resolveAuth(input.email);
  await settle();
  const bindingState = failedBinding.controller.status({ profileId: input.profileId,
    flowId: bindingFlow.flow.flowId });
  assert.equal(bindingState.status, "failed");
  assert.equal(bindingState.reasonCode, "GMAIL_AUTH_RECOVERY_REQUIRED");
  assert.equal(failedBinding.hasPendingAuth(), true);
  assert.equal([...failedBinding.connections.values()][0].state, "disconnected");

  const failedCommit = fixture();
  const commitFlow = failedCommit.controller.start(input);
  failedCommit.failMarkerCommit();
  failedCommit.resolveAuth(input.email);
  await settle();
  const commitState = failedCommit.controller.status({ profileId: input.profileId,
    flowId: commitFlow.flow.flowId });
  assert.equal(commitState.status, "failed");
  assert.equal(commitState.reasonCode, "GMAIL_AUTH_RECOVERY_REQUIRED");
  assert.equal(failedCommit.hasPendingAuth(), true);

  const ready = fixture();
  const verified = ready.controller.start(input);
  ready.resolveAuth(input.email);
  await settle();
  const state = ready.controller.status({ profileId: input.profileId, flowId: verified.flow.flowId });
  assert.equal(state.status, "ready");
  assert.equal(state.receipt.kind, "mcp-connect");
  assert.equal(ready.connections.size, 1);
  assert.equal([...ready.connections.values()][0].principalIdentity, "gmail:test@example.com");
  assert.equal([...ready.bindings.values()][0].enabled, true);
  assert.equal(ready.operations.size, 1);
  assert.equal(ready.hasPendingAuth(), false);
  console.log("gogcli Gmail auth binding fence: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
