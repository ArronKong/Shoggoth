"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { ExternalPluginLeaseManager } = require("../app/agent-service/external-plugin-lease");
const { ExternalPluginToolService } = require("../app/agent-service/external-plugin-tool-service");
const { ExternalPluginProvenance } = require("../app/agent-service/external-plugin-provenance");
const { sqliteNativeBinding } = require("../app/agent-service/sqlite-native-binding");
const { ExternalPluginApprovalBroker } = require("../app/agent-service/external-plugin-approval-broker");
const { validateExternalPluginAuditPage } = require("../app/core/plugin-external-audit-dto");
const { ensureCredential, authorizeAdapter, credentialPath } = require("../app/agent-service/external-plugin-adapter-auth");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-external-plugin-"));
  const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"), userDataRoot: temp,
    profileRoot: path.join(temp, "profile"), cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
  const store = new PluginStore({ paths }).open();
  const provenance = new ExternalPluginProvenance({ paths, store }).open();
  try {
    const openclawToken = ensureCredential(paths, "openclaw");
    const hermesToken = ensureCredential(paths, "hermes");
    assert.notEqual(openclawToken, hermesToken);
    assert.equal(fs.statSync(credentialPath(paths, "openclaw")).mode & 0o077, 0);
    assert.equal(authorizeAdapter(paths, "openclaw", hermesToken), false);
    assert.equal(authorizeAdapter(paths, "openclaw", openclawToken), true);

    const sourcePath = path.join(temp, "source");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath,
      { recursive: true });
    fs.mkdirSync(path.join(sourcePath, "skills", "issue-summary", "references"),
      { mode: 0o700 });
    fs.writeFileSync(path.join(sourcePath, "skills", "issue-summary", "references", "guide.md"),
      "Plugin reference fixture\n");
    fs.mkdirSync(path.join(sourcePath, "skills", "issue-summary", "agents"),
      { mode: 0o700 });
    fs.writeFileSync(path.join(sourcePath, "skills", "issue-summary", "agents", "helper.md"),
      "Plugin agent fixture\n");
    const installer = new PluginPackageInstaller({ store });
    const installed = installer.install({ sourcePath,
      previewDigest: installer.preview(sourcePath).contentDigest,
      operationId: "external-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const catalog = new PluginComponentCatalog({ store }).list()[0];
    const component = catalog.components.find(item => item.localName === "local-issues");
    const pending = store.createConnection({ connectionId: "external-connection",
      installationId: installed.installationId, componentId: component.componentId,
      endpointIdentity: "fixture://external" });
    const connection = store.setConnectionIdentity({ connectionId: pending.connectionId,
      principalIdentity: "fixture-account", state: "ready", expectedRevision: pending.revision });
    const created = store.createGlobalBinding({ bindingId: "external-binding",
      installationId: installed.installationId, componentId: component.componentId,
      connectionId: connection.connectionId });
    const binding = store.setBindingEnabled({ bindingId: created.bindingId,
      enabled: true, expectedRevision: created.revision });
    assert.equal(binding.subjectKind, "global");
    const registry = new PluginToolCatalogRegistry();
    let sends = 0;
    let pauseBeforeSend = null;
    let pauseAfterSend = null;
    const productRegistry = { revision: "fixture", get: name => ({ tool: name, enabled: true, risk: "write" }),
      list: () => [{ tool: "mcp_server_call", enabled: true, risk: "write" }] };
    const permission = new PermissionEngine({ toolRegistry: productRegistry });
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine: permission,
      resolveToolContract: records => registry.resolve(records) });
    let failRelease = false;
    const client = { listTools: async () => [{ name: "read", description: "Read issue",
      inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
    release: async () => { if (failRelease) throw new Error("cleanup failed"); },
    callTool: async (name, args, ticket, options) => {
      if (pauseBeforeSend) await pauseBeforeSend();
      dispatcher.authorizeEgress({ connectionId: connection.connectionId,
        principalIdentity: connection.principalIdentity, toolName: name,
        arguments: args, authority: ticket });
      sends += 1;
      if (pauseAfterSend) {
        await pauseAfterSend();
        if (options.signal.aborted) {
          throw Object.assign(new Error("canceled after egress"), { code: "REQUEST_ABORTED" });
        }
      }
      return { content: [{ type: "text", text: args.value }] };
    } };
    const toolCatalog = await registry.refresh({ installation, connection, client });
    const read = toolCatalog.entries[0];
    const grant = store.setGrant({ grantId: "external-read-grant", bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: 0 });
    const leases = new ExternalPluginLeaseManager({ authorizeAdapter: (backend, token) =>
      authorizeAdapter(paths, backend, token) });
    const approvals = new ExternalPluginApprovalBroker();
    let nativeRevision = 1;
    let scaledNativeSkills = null;
    const nativeStore = {
      get revision() { return nativeRevision; },
      listGlobalEnabled: () => scaledNativeSkills || ["native-global", "native-secondary"].map((name, index) => ({
        id: `global-native-${index}`, name, version: "1.0.0",
        description: "Native global Skill", contentHash: "a".repeat(64),
        registryRevision: nativeRevision, requiredTools: [], requiredRuntimeCapabilities: [],
      })),
      readGlobalEnabled: () => ({ name: "native-global", contentHash: "a".repeat(64),
        content: "# Native global instructions" }),
      readGlobalEnabledFile: ({ relativePath }) => ({ name: "native-global",
        relativePath, fileHash: "b".repeat(64), content: "Native reference fixture" }),
    };
    const service = new ExternalPluginToolService({ store,
      resolver: new PluginComponentResolver({ store }), toolCatalogRegistry: registry,
      capabilityDispatcher: dispatcher, acquireConnection: async () => client,
      leaseManager: leases, provenance, approvalBroker: approvals,
      getNativeSkillStore: () => nativeStore });
    const identity = (index, backendId = "openclaw") => backendId === "openclaw"
      ? { backendId, instanceId: crypto.randomUUID(), agentId: `agent-${index}`,
        sessionId: `session-${index}`, runId: `run-${index}`, toolCallId: `call-${index}` }
      : { backendId, instanceId: crypto.randomUUID(), agentId: `agent-${index}`,
        sessionId: `session-${index}`, taskId: `task-${index}`, turnId: `turn-${index}`,
        toolCallId: `call-${index}` };
    const external = identity(0);
    let leaseClock = 1_000_000;
    const timed = new ExternalPluginLeaseManager({ authorizeAdapter: () => true,
      now: () => leaseClock });
    const timedIdentity = identity(201);
    const timedOpen = await timed.issue({ credentialToken: openclawToken,
      identity: timedIdentity });
    leaseClock += 59_000;
    const timedClaim = timed.claim({ token: timedOpen.token, identity: timedIdentity });
    leaseClock += 2_000;
    assert.doesNotThrow(() => timedClaim.assertCurrent());
    leaseClock += 134_000;
    assert.throws(() => timedClaim.assertCurrent(),
      error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    timed.clear();
    const opened = await service.open({ credentialToken: openclawToken, identity: external });
    await assert.rejects(service.open({ credentialToken: hermesToken, identity: external }),
      error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    await assert.rejects(service.search({ token: opened.token, identity: { ...external, agentId: "evil" } }),
      error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    const found = await service.search({ token: opened.token, identity: external, query: "read" });
    assert(found.items.some(item => item.kind === "tool" && item.name === "read"));
    await assert.rejects(service.search({ token: opened.token, identity: external }),
      error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    const nativeIdentity = identity(99);
    const firstPageLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    const firstPage = await service.search({ token: firstPageLease.token, identity: nativeIdentity,
      query: "native", cursor: 0, limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextCursor, 1);
    assert.match(firstPage.revision, /^[a-f0-9]{64}$/u);
    const secondPageLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    const secondPage = await service.search({ token: secondPageLease.token, identity: nativeIdentity,
      query: "native", cursor: firstPage.nextCursor, limit: 1, revision: firstPage.revision });
    assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);
    assert.equal(secondPage.revision, firstPage.revision);
    const missingRevisionLease = await service.open({ credentialToken: openclawToken,
      identity: nativeIdentity });
    await assert.rejects(service.search({ token: missingRevisionLease.token,
      identity: nativeIdentity, query: "native", cursor: 1, limit: 1 }),
    error => error.code === "CAPABILITY_FORBIDDEN");
    const stalePageLease = await service.open({ credentialToken: openclawToken,
      identity: nativeIdentity });
    nativeRevision += 1;
    await assert.rejects(service.search({ token: stalePageLease.token,
      identity: nativeIdentity, query: "native", cursor: 1, limit: 1,
      revision: firstPage.revision }), error => error.code === "CATALOG_REVISION_CHANGED");
    const nativeSearchLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    const nativeFound = await service.search({ token: nativeSearchLease.token,
      identity: nativeIdentity, query: "native" });
    const native = nativeFound.items.find(item => item.source === "native-skill");
    assert(native);
    const nativeReadLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    const nativeRead = await service.readSkill({ token: nativeReadLease.token,
      identity: nativeIdentity, skillId: native.id });
    assert.equal(nativeRead.content, "# Native global instructions");
    const nativeFileLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    const nativeFile = await service.readSkillFile({ token: nativeFileLease.token,
      identity: nativeIdentity, skillId: native.id, relativePath: "references/guide.md" });
    assert.equal(nativeFile.content, "Native reference fixture");
    const pluginIdentity = identity(100);
    const pluginSearchLease = await service.open({ credentialToken: openclawToken,
      identity: pluginIdentity });
    const pluginFound = await service.search({ token: pluginSearchLease.token,
      identity: pluginIdentity, query: "issue-summary" });
    const pluginSkill = pluginFound.items.find(item => item.source === "plugin");
    assert(pluginSkill);
    const pluginFileLease = await service.open({ credentialToken: openclawToken,
      identity: pluginIdentity });
    const pluginFile = await service.readSkillFile({ token: pluginFileLease.token,
      identity: pluginIdentity, skillId: pluginSkill.id,
      relativePath: "references/guide.md" });
    assert.equal(pluginFile.content, "Plugin reference fixture\n");
    const agentFileLease = await service.open({ credentialToken: openclawToken,
      identity: pluginIdentity });
    const agentFile = await service.readSkillFile({ token: agentFileLease.token,
      identity: pluginIdentity, skillId: pluginSkill.id,
      relativePath: "agents/helper.md" });
    assert.equal(agentFile.content, "Plugin agent fixture\n");
    const installedGuide = path.join(paths.pluginPackagesDir, installed.releaseDigest,
      "skills", "issue-summary", "references", "guide.md");
    const originalGuide = fs.readFileSync(installedGuide);
    fs.appendFileSync(installedGuide, "changed\n");
    const tamperedLease = await service.open({ credentialToken: openclawToken,
      identity: pluginIdentity });
    await assert.rejects(service.readSkillFile({ token: tamperedLease.token,
      identity: pluginIdentity, skillId: pluginSkill.id,
      relativePath: "references/guide.md" }), error => error.code === "PACKAGE_CHANGED");
    fs.writeFileSync(installedGuide, originalGuide);
    const traversalLease = await service.open({ credentialToken: openclawToken,
      identity: pluginIdentity });
    await assert.rejects(service.readSkillFile({ token: traversalLease.token,
      identity: pluginIdentity, skillId: pluginSkill.id,
      relativePath: "references/../../plugin.json" }),
    error => error.code === "PLUGIN_COMPONENT_INVALID");
    const revokedNativeLease = await service.open({ credentialToken: openclawToken, identity: nativeIdentity });
    nativeRevision += 1;
    await assert.rejects(service.readSkill({ token: revokedNativeLease.token,
      identity: nativeIdentity, skillId: native.id }),
      error => error.code === "GRANT_REVOKED");
    const four = [identity(1), identity(2, "hermes"), identity(3), identity(4, "hermes")];
    const calls = await Promise.all(four.map(async row => {
      const token = row.backendId === "openclaw" ? openclawToken : hermesToken;
      const lease = await service.open({ credentialToken: token, identity: row });
      return service.call({ token: lease.token, identity: row,
        serverId: `plugin.${crypto.createHash("sha256").update(binding.bindingId).digest("hex")}`,
        toolName: "read", arguments: { value: row.agentId } });
    }));
    assert.deepEqual(calls.map(item => item.result.content[0].text).sort(),
      four.map(item => item.agentId).sort());
    assert.equal(sends, 4);
    const audited = provenance.list({ backendId: null, cursor: null, limit: 2 });
    assert.deepEqual(validateExternalPluginAuditPage(audited), audited);
    assert.throws(() => validateExternalPluginAuditPage({ ...audited,
      items: [{ ...audited.items[0], credentialToken: openclawToken }, audited.items[1]] }));
    assert.throws(() => validateExternalPluginAuditPage({ ...audited,
      items: [{ ...audited.items[0], [Symbol("secret")]: openclawToken }, audited.items[1]] }));
    assert.equal(audited.items.length, 2);
    assert(audited.nextCursor);
    const auditedTail = provenance.list({ backendId: null, cursor: audited.nextCursor, limit: 2 });
    assert.equal(auditedTail.items.length, 2);
    const auditRows = [...audited.items, ...auditedTail.items];
    for (const row of four) {
      const record = auditRows.find(item => item.agentId === row.agentId);
      assert(record);
      assert.equal(record.backendId, row.backendId);
      assert.equal(record.instanceId, row.instanceId);
      assert.equal(record.sessionId, row.sessionId);
      assert.equal(record.toolCallId, row.toolCallId);
      assert.equal(record.runId, row.runId || null);
      assert.equal(record.taskId, row.taskId || null);
      assert.equal(record.turnId, row.turnId || null);
      assert.equal(record.bindingId, binding.bindingId);
      assert.equal(record.toolIdentity, read.toolIdentity);
      assert.equal(record.status, "confirmed");
      assert.match(record.resultDigest, /^[a-f0-9]{64}$/u);
      assert(record.resultBytes > 0);
    }

    const canceled = identity(5);
    const canceledLease = await service.open({ credentialToken: openclawToken, identity: canceled });
    let releasePause;
    pauseBeforeSend = () => new Promise(resolve => { releasePause = resolve; });
    const call = service.call({ token: canceledLease.token, identity: canceled,
      serverId: calls[0].serverId, toolName: "read", arguments: { value: "cancel" } });
    while (!releasePause) await new Promise(resolve => setImmediate(resolve));
    service.cancel({ token: canceledLease.token, identity: canceled });
    releasePause();
    await assert.rejects(call, error => error.code === "EXTERNAL_PLUGIN_LEASE_INVALID");
    assert.equal(sends, 4);
    const canceledRecord = provenance.list({ backendId: "openclaw", limit: 10 })
      .items.find(item => item.agentId === canceled.agentId);
    assert.equal(canceledRecord.status, "canceled_before_send");
    assert.equal(canceledRecord.cancelRequested, true);
    pauseBeforeSend = null;

    const old = identity(6);
    const oldLease = await service.open({ credentialToken: openclawToken, identity: old });
    const revoked = store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "deny", approvalMode: "always", expectedRevision: grant.revision });
    const reenabled = store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: revoked.revision });
    await assert.rejects(service.call({ token: oldLease.token, identity: old,
      serverId: calls[0].serverId, toolName: "read", arguments: { value: "stale" } }),
    error => error.code === "GRANT_REVOKED");
    assert.equal(sends, 4);
    const beforeEachCall = identity(7);
    const beforeEachLease = await service.open({ credentialToken: openclawToken,
      identity: beforeEachCall });
    const eachCall = store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "each-call", expectedRevision: reenabled.revision });
    await assert.rejects(service.call({ token: beforeEachLease.token, identity: beforeEachCall,
      serverId: calls[0].serverId, toolName: "read", arguments: { value: "needs-approval" } }),
    error => error.code === "GRANT_REVOKED");
    const eachSearchLease = await service.open({ credentialToken: openclawToken,
      identity: beforeEachCall });
    const eachSearch = await service.search({ token: eachSearchLease.token,
      identity: beforeEachCall, query: "read" });
    assert.equal(eachSearch.items.some(item => item.kind === "tool"), true);
    assert.equal(sends, 4);
    store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: read.toolIdentity, contractDigest: read.contractDigest,
      effect: "allow", approvalMode: "always", expectedRevision: eachCall.revision });
    for (const count of [50, 500, 5_000]) {
      nativeRevision += 1;
      scaledNativeSkills = Array.from({ length: count - 1 }, (_, index) => ({
        id: `scale-${index}`, name: `skill-${String(index).padStart(5, "0")}`,
        version: "1.0.0", description: "Scale fixture",
        contentHash: "a".repeat(64), registryRevision: nativeRevision,
        requiredTools: [], requiredRuntimeCapabilities: [],
      }));
      const scaleIdentity = identity(count + 1_000);
      const firstLease = await service.open({ credentialToken: openclawToken, identity: scaleIdentity });
      const first = await service.search({ token: firstLease.token, identity: scaleIdentity,
        query: "", limit: 5 });
      assert.equal(first.items.length, 5);
      assert.equal(first.nextCursor, 5);
      assert(Buffer.byteLength(JSON.stringify(first), "utf8") < 8 * 1024);
      const tailLease = await service.open({ credentialToken: openclawToken, identity: scaleIdentity });
      const tail = await service.search({ token: tailLease.token, identity: scaleIdentity,
        query: `skill-${String(count - 2).padStart(5, "0")}`, limit: 5 });
      assert.equal(tail.items.length, 1);
      assert.equal(tail.items[0].name, `skill-${String(count - 2).padStart(5, "0")}`);
      assert.equal(tail.nextCursor, null);
    }
    const afterEgress = identity(8_888);
    const afterEgressLease = await service.open({ credentialToken: openclawToken,
      identity: afterEgress });
    let releaseAfterEgress;
    pauseAfterSend = () => new Promise(resolve => { releaseAfterEgress = resolve; });
    const uncertainCall = service.call({ token: afterEgressLease.token, identity: afterEgress,
      serverId: calls[0].serverId, toolName: "read", arguments: { value: "sent-then-canceled" } });
    while (!releaseAfterEgress) await new Promise(resolve => setImmediate(resolve));
    service.cancel({ token: afterEgressLease.token, identity: afterEgress });
    releaseAfterEgress();
    await assert.rejects(uncertainCall, error => error.code === "REQUEST_ABORTED");
    pauseAfterSend = null;
    const uncertainAudit = provenance.list({ backendId: "openclaw", limit: 20 })
      .items.find(item => item.agentId === afterEgress.agentId);
    assert.equal(uncertainAudit.status, "canceled_outcome_unknown");
    assert.equal(uncertainAudit.cancelRequested, true);
    assert.equal(store.getCapabilityCall(uncertainAudit.callId).phase, "outcome_unknown");
    const settledDespiteAuditFailure = identity(8_887);
    const settledLease = await service.open({ credentialToken: openclawToken,
      identity: settledDespiteAuditFailure });
    const nativeBinding = sqliteNativeBinding();
    const auditDb = new Database(provenance.path, nativeBinding ? { nativeBinding } : undefined);
    let confirmedResponse;
    const rejectedId = "external-live-audit-rejection";
    try {
      // Fail the actual SQLite settlement transaction after capability egress.
      // The successful primary result must remain successful, and the bounded
      // audit retry must recover without restarting this Service instance.
      auditDb.exec(`CREATE TRIGGER block_audit_settle BEFORE UPDATE OF status
        ON external_plugin_calls BEGIN SELECT RAISE(ABORT, 'audit disk failure'); END;`);
      confirmedResponse = await service.call({ token: settledLease.token,
        identity: settledDespiteAuditFailure, serverId: calls[0].serverId,
        toolName: "read", arguments: { value: "already-written" } });
      assert.equal(confirmedResponse.result.content[0].text, "already-written");
      assert.equal(store.getCapabilityCall(confirmedResponse.callId).phase, "result_confirmed");
      provenance.begin({ callId: rejectedId, identity: settledDespiteAuditFailure,
        bindingId: binding.bindingId, installationId: installation.installationId,
        componentId: component.componentId, connectionId: connection.connectionId,
        toolIdentity: read.toolIdentity, toolName: "read" });
      assert.throws(() => provenance.settle(rejectedId, { error: Object.assign(
        new Error("denied before send"), { code: "CAPABILITY_FORBIDDEN" }) }));
      const interrupted = provenance.list({ backendId: "openclaw", limit: 20 }).items;
      assert.equal(interrupted.find(item => item.callId === confirmedResponse.callId).status, "pending");
      assert.equal(interrupted.find(item => item.callId === rejectedId).status, "pending");
    } finally {
      auditDb.exec("DROP TRIGGER IF EXISTS block_audit_settle");
      auditDb.close();
    }
    const retried = provenance.list({ backendId: "openclaw", limit: 20 }).items;
    const recoveredConfirmed = retried.find(item => item.callId === confirmedResponse.callId);
    assert.equal(recoveredConfirmed.status, "confirmed");
    assert.equal(recoveredConfirmed.resultDigest,
      crypto.createHash("sha256").update(JSON.stringify(confirmedResponse.result)).digest("hex"));
    assert.equal(retried.find(item => item.callId === rejectedId).status, "rejected_before_send");
    assert.equal(retried.find(item => item.callId === rejectedId).errorCode, "CAPABILITY_FORBIDDEN");
    const cleanupFailure = identity(8_886);
    const cleanupLease = await service.open({ credentialToken: openclawToken,
      identity: cleanupFailure });
    failRelease = true;
    try {
      const response = await service.call({ token: cleanupLease.token,
        identity: cleanupFailure, serverId: calls[0].serverId,
        toolName: "read", arguments: { value: "cleanup-independent" } });
      assert.equal(response.result.content[0].text, "cleanup-independent");
      assert.equal(store.getCapabilityCall(response.callId).phase, "result_confirmed");
    } finally { failRelease = false; }
    const unavailable = identity(8_889);
    const unavailableLease = await service.open({ credentialToken: openclawToken,
      identity: unavailable });
    provenance.close();
    const sentBeforeUnavailable = sends;
    await assert.rejects(service.call({ token: unavailableLease.token, identity: unavailable,
      serverId: calls[0].serverId, toolName: "read", arguments: { value: "audit-unavailable" } }),
    error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
    assert.equal(sends, sentBeforeUnavailable);
    provenance.open();

    const currentGrant = store.getGrant(binding.bindingId, read.toolIdentity);
    const protectedGrant = store.setGrant({ grantId: currentGrant.grantId,
      bindingId: binding.bindingId, toolIdentity: read.toolIdentity,
      contractDigest: read.contractDigest, effect: "allow", approvalMode: "each-call",
      expectedRevision: currentGrant.revision });
    const exactSession = identity(8_900);
    const sameSession = { ...exactSession, toolCallId: "call-8901" };
    const otherHost = identity(8_902, "hermes");
    const once = async (row, value) => {
      const lease = await service.open({ credentialToken: row.backendId === "hermes"
        ? hermesToken : openclawToken, identity: row });
      const call = service.call({ token: lease.token, identity: row,
        serverId: calls[0].serverId, toolName: "read", arguments: value });
      call.catch(() => {});
      return { call, lease };
    };
    const approvedCall = await once(exactSession, { value: "first" });
    const deniedCall = await once(sameSession, { value: "second" });
    const hermesCall = await once(otherHost, { value: "third" });
    const pendingPage = approvals.list();
    const pendingTail = approvals.list({ cursor: pendingPage.nextCursor });
    const pendingApprovals = [...pendingPage.items, ...pendingTail.items];
    assert.deepEqual(pendingApprovals.map(item => item.toolCallId),
      [exactSession.toolCallId, sameSession.toolCallId, otherHost.toolCallId]);
    assert.equal(pendingApprovals[0].sessionId, pendingApprovals[1].sessionId);
    assert.notEqual(pendingApprovals[1].sessionId, pendingApprovals[2].sessionId);
    const deniedRequest = approvals.prepare({ requestId: pendingApprovals[1].requestId,
      operationId: "deny-second", decision: "deny" });
    approvals.commit({ challenge: deniedRequest.challenge, approved: false });
    await assert.rejects(deniedCall.call, error => error.code === "CAPABILITY_FORBIDDEN");
    const allowFirst = approvals.prepare({ requestId: pendingApprovals[0].requestId,
      operationId: "allow-first", decision: "once" });
    approvals.commit({ challenge: allowFirst.challenge, approved: true });
    const allowThird = approvals.prepare({ requestId: pendingApprovals[2].requestId,
      operationId: "allow-third", decision: "once" });
    approvals.commit({ challenge: allowThird.challenge, approved: true });
    assert.equal((await approvedCall.call).result.content[0].text, "first");
    assert.equal((await hermesCall.call).result.content[0].text, "third");
    assert.equal(sends, sentBeforeUnavailable + 2);
    const decisions = provenance.list({ limit: 20 }).items;
    const approvedAudit = decisions.find(item => item.toolCallId === exactSession.toolCallId
      && item.sessionId === exactSession.sessionId);
    const deniedAudit = decisions.find(item => item.toolCallId === sameSession.toolCallId
      && item.sessionId === sameSession.sessionId);
    const hermesAudit = decisions.find(item => item.toolCallId === otherHost.toolCallId
      && item.sessionId === otherHost.sessionId);
    assert.equal(approvedAudit.approvalOutcome, "approved");
    assert.equal(approvedAudit.status, "confirmed");
    assert.equal(deniedAudit.approvalOutcome, "denied");
    assert.equal(deniedAudit.status, "rejected_before_send");
    assert.equal(hermesAudit.approvalOutcome, "approved");
    assert.equal(hermesAudit.status, "confirmed");
    assert.notEqual(approvedAudit.approvalRequestId, deniedAudit.approvalRequestId);
    validateExternalPluginAuditPage({ items: [approvedAudit, deniedAudit, hermesAudit],
      nextCursor: null });

    const mutable = { value: "original" };
    const immutableCall = await once(identity(8_903), mutable);
    const immutableRequest = approvals.list().items[0];
    mutable.value = "changed while waiting";
    const immutablePrepared = approvals.prepare({ requestId: immutableRequest.requestId,
      operationId: "allow-immutable", decision: "once" });
    approvals.commit({ challenge: immutablePrepared.challenge, approved: true });
    assert.equal((await immutableCall.call).result.content[0].text, "original");

    const revokedDuringWait = await once(identity(8_904), { value: "never sent" });
    const revokedRequest = approvals.list().items[0];
    const deniedGrant = store.setGrant({ grantId: protectedGrant.grantId,
      bindingId: binding.bindingId, toolIdentity: read.toolIdentity,
      contractDigest: read.contractDigest, effect: "deny", approvalMode: "each-call",
      expectedRevision: protectedGrant.revision });
    assert.throws(() => approvals.prepare({ requestId: revokedRequest.requestId,
      operationId: "revoked-approval", decision: "once" }), error => error.code === "GRANT_REVOKED");
    await assert.rejects(revokedDuringWait.call, error => error.code === "GRANT_REVOKED");
    const restoredGrant = store.setGrant({ grantId: protectedGrant.grantId,
      bindingId: binding.bindingId, toolIdentity: read.toolIdentity,
      contractDigest: read.contractDigest, effect: "allow", approvalMode: "each-call",
      expectedRevision: deniedGrant.revision });
    const stopped = identity(8_905);
    const stoppedCall = await once(stopped, { value: "stopped" });
    const stoppedRequest = approvals.list().items[0];
    service.cancel({ token: stoppedCall.lease.token, identity: stopped });
    await assert.rejects(stoppedCall.call, error => ["CAPABILITY_FORBIDDEN",
      "EXTERNAL_PLUGIN_LEASE_INVALID"].includes(error.code));
    const stoppedAudit = provenance.list({ limit: 20 }).items.find(item =>
      item.toolCallId === stopped.toolCallId && item.sessionId === stopped.sessionId);
    assert.equal(stoppedAudit.approvalOutcome, "withdrawn");
    assert.equal(stoppedAudit.status, "canceled_before_send");
    assert.throws(() => approvals.prepare({ requestId: stoppedRequest.requestId,
      operationId: "stopped-approval", decision: "once" }), error => error.code === "PLUGIN_REQUEST_INVALID");

    const delayedApprovalDb = new Database(provenance.path,
      nativeBinding ? { nativeBinding } : undefined);
    const beforeApprovalFailure = sends;
    try {
      delayedApprovalDb.exec(`CREATE TRIGGER block_audit_approval BEFORE UPDATE OF approval_outcome
        ON external_plugin_calls BEGIN SELECT RAISE(ABORT, 'approval disk failure'); END;`);
      const withdrawn = identity(8_907);
      const withdrawnLease = await service.open({ credentialToken: openclawToken,
        identity: withdrawn });
      const withdrawnCall = service.call({ token: withdrawnLease.token, identity: withdrawn,
        serverId: calls[0].serverId, toolName: "read", arguments: { value: "not sent" } });
      withdrawnCall.catch(() => {});
      assert(approvals.list().items.some(item => item.toolCallId === withdrawn.toolCallId));
      service.cancel({ token: withdrawnLease.token, identity: withdrawn });
      await assert.rejects(withdrawnCall, error => error.code === "CAPABILITY_FORBIDDEN");

      const expiringApprovals = new ExternalPluginApprovalBroker({ timeoutMs: 20 });
      const expiringService = new ExternalPluginToolService({ store,
        resolver: new PluginComponentResolver({ store }), toolCatalogRegistry: registry,
        capabilityDispatcher: dispatcher, acquireConnection: async () => client,
        leaseManager: leases, provenance, approvalBroker: expiringApprovals,
        getNativeSkillStore: () => nativeStore });
      const expired = identity(8_908, "hermes");
      const expiredLease = await expiringService.open({ credentialToken: hermesToken,
        identity: expired });
      const expiredCall = expiringService.call({ token: expiredLease.token, identity: expired,
        serverId: calls[0].serverId, toolName: "read", arguments: { value: "not sent" } });
      await assert.rejects(expiredCall, error => error.code === "CAPABILITY_FORBIDDEN");

      const pendingAudit = provenance.list({ limit: 20 }).items;
      for (const item of [withdrawn, expired]) {
        const row = pendingAudit.find(entry => entry.toolCallId === item.toolCallId);
        assert.equal(row.status, "pending", "an unwritten decision must block terminal audit settlement");
        assert.equal(row.approvalOutcome, null);
      }
      assert.equal(sends, beforeApprovalFailure, "audit failure must not cause capability egress");
    } finally {
      delayedApprovalDb.exec("DROP TRIGGER IF EXISTS block_audit_approval");
      delayedApprovalDb.close();
    }
    const recoveredApprovalAudit = provenance.list({ limit: 20 }).items;
    assert.equal(recoveredApprovalAudit.find(item => item.toolCallId === "call-8907")
      .approvalOutcome, "withdrawn");
    assert.equal(recoveredApprovalAudit.find(item => item.toolCallId === "call-8907")
      .status, "canceled_before_send");
    assert.equal(recoveredApprovalAudit.find(item => item.toolCallId === "call-8908")
      .approvalOutcome, "expired");
    assert.equal(recoveredApprovalAudit.find(item => item.toolCallId === "call-8908")
      .status, "rejected_before_send");
    const afterRestart = await once(identity(8_906), { value: "restart" });
    approvals.clear();
    await assert.rejects(afterRestart.call, error => error.code === "CAPABILITY_FORBIDDEN");
    assert.equal(store.getGrant(binding.bindingId, read.toolIdentity).revision,
      restoredGrant.revision);
    service.clear();
    const recovery = identity(9_999, "hermes");
    const recoveryId = "external-recovery-fixture";
    provenance.begin({ callId: recoveryId, identity: recovery,
      bindingId: binding.bindingId, installationId: installation.installationId,
      componentId: component.componentId, connectionId: connection.connectionId,
      toolIdentity: read.toolIdentity, toolName: "read" });
    store.beginCapabilityCall({ callId: recoveryId, runRef: "external-recovery-run",
      bindingId: binding.bindingId, connectionId: connection.connectionId,
      principalIdentity: connection.principalIdentity, toolIdentity: read.toolIdentity,
      contractDigest: read.contractDigest, argumentDigest: "a".repeat(64) });
    store.markCapabilityCallSendStarted(recoveryId);
    provenance.close();
    store.close();
    store.open();
    provenance.open();
    const recovered = provenance.list({ backendId: "hermes", limit: 10 })
      .items.find(item => item.callId === recoveryId);
    assert.equal(recovered.status, "outcome_unknown");
    assert.equal(store.getCapabilityCall(recoveryId).phase, "outcome_unknown");
    provenance.close();
    fs.unlinkSync(provenance.path);
    fs.writeFileSync(provenance.path, "", { mode: 0o600 });
    let auditClock = 1_000;
    const aged = new ExternalPluginProvenance({ paths, store, now: () => auditClock });
    try {
      aged.open();
      assert.deepEqual(aged.list(), { items: [], nextCursor: null });
      aged.begin({ callId: "old-audit", identity: recovery, bindingId: binding.bindingId,
        installationId: installation.installationId, componentId: component.componentId,
        connectionId: connection.connectionId, toolIdentity: read.toolIdentity,
        toolName: "read" });
      aged.settle("old-audit", { error: Object.assign(new Error("rejected"),
        { code: "CAPABILITY_FORBIDDEN" }) });
      auditClock += 31 * 24 * 60 * 60 * 1_000;
      aged.begin({ callId: "new-audit", identity: recovery, bindingId: binding.bindingId,
        installationId: installation.installationId, componentId: component.componentId,
        connectionId: connection.connectionId, toolIdentity: read.toolIdentity,
        toolName: "read" });
      aged.settle("new-audit", { error: Object.assign(new Error("rejected"),
        { code: "CAPABILITY_FORBIDDEN" }) });
      assert.deepEqual(aged.list().items.map(item => item.callId), ["new-audit"]);
    } finally { aged.close(); }
    const capped = new ExternalPluginProvenance({ paths, store, maxDeferred: 1,
      maxJournal: 2 }).open();
    const cappedDb = new Database(capped.path, nativeBinding ? { nativeBinding } : undefined);
    try {
      for (const callId of ["queued-approval", "overflow-approval"]) {
        capped.begin({ callId, identity: recovery, bindingId: binding.bindingId,
          installationId: installation.installationId, componentId: component.componentId,
          connectionId: connection.connectionId, toolIdentity: read.toolIdentity,
          toolName: "read", approvalRequired: true });
      }
      cappedDb.exec(`CREATE TRIGGER block_capped_approval BEFORE UPDATE OF approval_outcome
        ON external_plugin_calls BEGIN SELECT RAISE(ABORT, 'approval disk failure'); END;`);
      assert.throws(() => capped.recordApproval("queued-approval", "queued-request", "denied"),
        error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
      assert.throws(() => capped.recordApproval("overflow-approval", "overflow-request", "denied"),
        error => error.code === "EXTERNAL_PLUGIN_AUDIT_UNAVAILABLE");
      const pendingJournal = new Database(capped.journalPath,
        nativeBinding ? { nativeBinding } : undefined);
      try {
        assert.deepEqual(pendingJournal.prepare(`SELECT call_id, request_id, outcome
          FROM approval_events ORDER BY call_id`).all(), [
          { call_id: "overflow-approval", request_id: "overflow-request", outcome: "denied" },
          { call_id: "queued-approval", request_id: "queued-request", outcome: "denied" },
        ]);
      } finally { pendingJournal.close(); }
      cappedDb.exec("DROP TRIGGER block_capped_approval");
      capped.close();
      const restarted = new ExternalPluginProvenance({ paths, store }).open();
      try {
        const afterRestart = restarted.list({ limit: 20 }).items;
        for (const [callId, requestId] of [["overflow-approval", "overflow-request"],
          ["queued-approval", "queued-request"]]) {
          const row = afterRestart.find(item => item.callId === callId);
          assert.equal(row.approvalRequestId, requestId);
          assert.equal(row.approvalOutcome, "denied");
          assert.equal(row.status, "outcome_unknown", "restart cannot infer dispatch from an audit decision");
        }
      } finally { restarted.close(); }
    } finally {
      cappedDb.exec("DROP TRIGGER IF EXISTS block_capped_approval");
      cappedDb.close(); capped.close();
    }
    console.log("plugin-external-lease-unit: ok");
  } finally { provenance.close(); store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
