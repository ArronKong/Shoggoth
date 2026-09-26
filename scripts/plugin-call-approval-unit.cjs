"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { PluginRuntimeToolService, pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const { openFixture, sendAndDrain, waitUntil, PROFILE_ID, RUNTIME_ACCOUNT_ID } =
  require("./shoggoth-work-run-coordinator-unit.cjs");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-call-consent-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
    profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  let clock = 1_000;
  const timers = new Map();
  let nextTimer = 0;
  const value = await openFixture({ now: () => clock, approvalTimeoutMs: 1_000,
    promptScheduler: { set(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clear(id) { timers.delete(id); } } });
  try {
    const sourcePath = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath, { recursive: true });
    const installer = new PluginPackageInstaller({ store });
    const installed = installer.install({ sourcePath, previewDigest: installer.preview(sourcePath).contentDigest,
      operationId: "per-call-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components.find(item => item.localName === "local-issues");
    const pending = store.createConnection({ connectionId: "per-call-connection", installationId: installed.installationId,
      componentId: component.componentId, endpointIdentity: "fixture://per-call" });
    const connection = store.setConnectionIdentity({ connectionId: pending.connectionId,
      principalIdentity: "fixture-account", state: "ready", expectedRevision: pending.revision });
    const initialBinding = store.createBinding({ bindingId: "per-call-binding", profileId: PROFILE_ID,
      installationId: installed.installationId, componentId: component.componentId, connectionId: connection.connectionId });
    const binding = store.setBindingEnabled({ bindingId: initialBinding.bindingId, enabled: true,
      expectedRevision: initialBinding.revision });
    const catalogs = new PluginToolCatalogRegistry();
    const productRegistry = { revision: "fixture", get: name => ({ tool: name, enabled: true, risk: "write" }),
      list: () => [{ tool: "mcp_server_call", enabled: true, risk: "write" }] };
    const policy = new PermissionEngine({ toolRegistry: productRegistry });
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine: policy,
      resolveToolContract: input => catalogs.resolve(input), now: () => clock });
    let beforeSend = null;
    const sends = [];
    const tools = ["write", "revocable"].map(name => ({ name, inputSchema: { type: "object" } }));
    const client = { listTools: async () => tools, release: async () => {},
      async callTool(name, args, authority) {
        if (beforeSend) await beforeSend();
        dispatcher.authorizeEgress({ connectionId: connection.connectionId,
          principalIdentity: connection.principalIdentity, toolName: name, arguments: args, authority });
        sends.push({ name, args: structuredClone(args) });
        return { content: [], structuredContent: { accepted: true } };
      } };
    const catalog = await catalogs.refresh({ installation, connection, client });
    for (const tool of catalog.entries) store.setGrant({ grantId: `grant-${tool.downstreamName}`,
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "allow", approvalMode: "each-call", expectedRevision: 0 });
    const runtime = new PluginRuntimeToolService({ store, productStore: value.productStore,
      getRun: id => value.dispatcher.getRun(id), toolCatalogRegistry: catalogs, capabilityDispatcher: dispatcher,
      permissionEngine: policy, acquireConnection: async () => client,
      requestApproval: input => value.coordinator.requestPluginToolApproval(input) });
    value.coordinator.pluginRuntimeToolService = runtime;
    const { ack } = await sendAndDrain(value, { operationId: "per-call-runtime" });
    const run = value.dispatcher.getRun(ack.run.id);
    const events = [];
    value.coordinator.subscribeRun(run.id, { streamId: null, afterSeq: 0 }, event => events.push(event));
    const serverId = pluginServerId(binding.bindingId);
    const args = { serverId, toolName: "write", arguments: { destination: "fixture-a", arbitraryField: "full-detail" } };
    const invoke = (input = args, authority = { profileId: PROFILE_ID, callId: crypto.randomUUID() }) =>
      value.coordinator.invokeRuntimeCapability({ runId: run.id, runtimeProfileId: "runtime-default",
        runtimeAccountId: RUNTIME_ACCOUNT_ID }, scope => runtime.callTool(input, authority, scope));
    const waitApproval = async () => {
      await waitUntil(() => value.dispatcher.getRun(run.id).status === "waiting_approval", 1_000, "plugin approval");
      return value.dispatcher.getRun(run.id).waitingRequestId;
    };
    const respond = (requestId, choice) => value.coordinator.respondApproval({ operationId: crypto.randomUUID(),
      runId: run.id, requestId, choice });

    const firstAuthority = { profileId: PROFILE_ID, callId: crypto.randomUUID(), confirmation: true };
    const first = invoke(args, firstAuthority);
    const requestId = await waitApproval();
    assert.equal(sends.length, 0, "model confirmation does not skip each-call approval");
    const event = events.find(item => item.type === "approval" && item.payload.requestId === requestId);
    assert.equal(event.payload.method, "shoggoth/pluginTool/requestApproval");
    const card = normalizeInteractiveRequestV1({ runId: run.id, eventType: "approval", payload: event.payload });
    assert(card.approvalChoices.includes("once"));
    assert(!card.approvalChoices.includes("session"));
    assert.deepEqual(JSON.parse(card.approvalDetails.command), args.arguments, "full arguments are rendered, not only known keys");
    await assert.rejects(respond(requestId, "session"), error => error.code === "WORK_RUN_APPROVAL_RESPONSE_INVALID");
    await assert.rejects(respond("forged-request", "once"), error => error.code === "WORK_RUN_REQUEST_MISMATCH");
    await respond(requestId, "once");
    assert.equal((await first).result.structuredContent.accepted, true);
    assert.equal(sends.length, 1);
    await assert.rejects(respond(requestId, "once"), error => error.code === "WORK_RUN_REQUEST_MISMATCH");
    await assert.rejects(invoke(args, firstAuthority), error => error.code === "CALL_ALREADY_RECORDED");
    assert.equal(sends.length, 1, "a completed call cannot replay with its prior approval");

    const denied = invoke(); denied.catch(() => {});
    await respond(await waitApproval(), "deny");
    await assert.rejects(denied, error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(sends.length, 1);

    // Arguments belong to the operation at prompt creation. Mutating the
    // caller's object while approval waits cannot change the outgoing request.
    const changing = structuredClone(args);
    const immutable = invoke(changing);
    const immutableRequest = await waitApproval();
    changing.arguments.destination = "changed-after-prompt";
    await respond(immutableRequest, "once");
    await immutable;
    assert.equal(sends.at(-1).args.destination, "fixture-a");

    const beforeExpiry = sends.length;
    beforeSend = async () => { clock += 60_001; };
    const expired = invoke(); expired.catch(() => {});
    await respond(await waitApproval(), "once");
    await assert.rejects(expired, error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(sends.length, beforeExpiry, "approved receipt expires before delayed transport send");
    beforeSend = null;

    const revocable = catalog.entries.find(item => item.downstreamName === "revocable");
    const revoked = invoke({ ...args, toolName: "revocable" }); revoked.catch(() => {});
    const revokedRequest = await waitApproval();
    const grant = store.getGrant(binding.bindingId, revocable.toolIdentity);
    store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: revocable.toolIdentity, contractDigest: revocable.contractDigest,
      effect: "deny", approvalMode: "each-call", expectedRevision: grant.revision });
    await respond(revokedRequest, "once");
    await assert.rejects(revoked, error => error.code === "GRANT_REVOKED");
    assert.equal(sends.length, beforeExpiry, "approval cannot override a revoked Grant");

    const tool = catalog.entries.find(item => item.downstreamName === "write");
    const freshGrant = store.getGrant(binding.bindingId, tool.toolIdentity);
    const dispatchInput = { callId: "opaque-receipt-call", authority: { kind: "native-profile",
      profileId: PROFILE_ID, profile: value.productStore.getAgentProfile(PROFILE_ID) },
    execution: { kind: "native-run", profileId: PROFILE_ID, workspace: run.workspace, run },
    envelope: { runId: run.id, authorityIncarnation: store.getAuthorityIncarnation(),
      bindingId: binding.bindingId, installationId: installation.installationId,
      releaseDigest: installation.releaseDigest, componentId: binding.componentId,
      connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
      bindingRevision: binding.revision, grantEpoch: freshGrant.epoch,
      connectionAuthRevision: connection.authRevision, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest },
    bindingId: binding.bindingId, toolIdentity: tool.toolIdentity, downstreamToolName: "write",
    contractDigest: tool.contractDigest, arguments: args.arguments };
    const receipt = dispatcher.approveCall(dispatchInput); // trusted Service mint, never a public API
    await assert.rejects(dispatcher.dispatch({ ...dispatchInput, client, execution: {
      ...dispatchInput.execution, approval: { bindingId: binding.bindingId,
        connectionId: connection.connectionId, principalIdentity: connection.principalIdentity,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, runId: run.id,
        argumentDigest: crypto.createHash("sha256").update(JSON.stringify(args.arguments)).digest("hex"),
        expiresAt: clock + 60_000, consumed: false },
    } }), error => error.code === "CAPABILITY_FORBIDDEN");
    await assert.rejects(dispatcher.dispatch({ ...dispatchInput, client, approvalReceipt: structuredClone(receipt) }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    await assert.rejects(dispatcher.dispatch({ ...dispatchInput, callId: "different-call", client, approvalReceipt: receipt }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    await dispatcher.dispatch({ ...dispatchInput, client, approvalReceipt: receipt });
    await assert.rejects(dispatcher.dispatch({ ...dispatchInput, client, approvalReceipt: receipt }),
      error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(sends.length, beforeExpiry + 1, "opaque receipt consumed once at final egress");

    // Expiring a pending card rejects late UI approval and settles the blocked
    // call through the same existing Run interruption lifecycle.
    const pendingExpiry = invoke(); pendingExpiry.catch(() => {});
    const expiredRequest = await waitApproval();
    clock += 1_001;
    await assert.rejects(respond(expiredRequest, "once"), error => error.code === "WORK_RUN_REQUEST_MISMATCH");
    for (const callback of [...timers.values()]) callback();
    await assert.rejects(pendingExpiry);
    await value.coordinator.waitForIdle(run.id);
    assert.notEqual(value.dispatcher.getRun(run.id).status, "waiting_approval");
    runtime.clear(); dispatcher.clear();
    console.log("plugin-call-approval-unit: trusted approval, deny, revocation, expiry, argument binding and one-use receipts passed");
  } finally {
    await value.coordinator.close();
    store.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
