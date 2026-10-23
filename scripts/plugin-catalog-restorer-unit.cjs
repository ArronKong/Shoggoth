"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginMcpConnectionManager } = require("../app/agent-service/plugin-mcp-connection-manager");
const { PluginMcpConsent } = require("../app/agent-service/plugin-mcp-consent");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { PluginCatalogRestorer } = require("../app/agent-service/plugin-catalog-restorer");
const { PluginServiceController } = require("../app/agent-service/plugin-service-controller");
const { TOOL } = require("./fixtures/plugins/mcp-sdk-fixture.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function wait(predicate, label, timeout = 1500) { const deadline = Date.now() + timeout; while (!predicate()) {
  if (Date.now() >= deadline) throw new Error(label + " timeout"); await sleep(5);
} }
let checked = 0;
async function test(name, fn) { await fn(); checked += 1; console.log("PASS " + name); }
async function withFixture(fn, count = 1) {
  const root = fs.mkdtempSync("/private/tmp/sgh-catalog-unit-");
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  let now = 100000, acquired = 0, released = 0;
  const store = new PluginStore({ paths, now: () => now }).open();
  const registry = new PluginToolCatalogRegistry();
  const profiles = [{ id: "profile-current", name: "Fixture", enabled: true }];
  const productStore = { listAgentProfiles: () => profiles, getAgentProfile: id => profiles.find(row => row.id === id) || null };
  const holds = new Set(), calls = [], rows = [];
  const behavior = { list: async () => [TOOL], acquire: async () => {} };
  const pool = { acquireStdio: async input => {
    acquired += 1; await behavior.acquire(input);
    return { listTools: async () => { calls.push(input.installationId); return behavior.list(input); }, release: async () => { released += 1; } };
  } };
  const manager = new PluginMcpConnectionManager({ store, resolver: new PluginComponentResolver({ store }), pool });
  const consent = new PluginMcpConsent({ store, productStore, manager, registry, now: () => now });
  const restorer = new PluginCatalogRestorer({ store, productStore, consent, registry, now: () => now,
    concurrency: 2, timeoutMs: 200, maxPending: 8 });
  try {
    for (let index = 0; index < count; index++) {
      const source = path.join(root, "source-" + index); fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), source, { recursive: true });
      fs.chmodSync(path.join(source, "bin/issue-fixture"), 0o700);
      const installer = new PluginPackageInstaller({ store });
      const installed = installer.install({ sourcePath: source, previewDigest: installer.preview(source).contentDigest,
        expectedRevision: 0, operationId: "install-" + index });
      const installation = store.setInstallationDesiredState({ installationId: installed.installationId, desiredState: "enabled", expectedRevision: installed.revision });
      const component = new PluginComponentCatalog({ store }).list().find(row => row.installationId === installation.installationId).components.find(row => row.localName === "local-issues");
      const proposal = consent.prepare({ action: "connect", profileId: profiles[0].id,
        installationId: installation.installationId, componentId: component.componentId,
        expectedRevision: installation.revision, operationId: "connect-" + index });
      const bindingId = (await consent.commit({ challenge: proposal.challenge, approved: true })).receipt.bindingId;
      await consent.discover({ profileId: profiles[0].id, bindingId });
      const tool = registry.listForBinding(store.getCapabilityRecords(bindingId, "projection")).entries[0];
      const allow = consent.prepare({ action: "allow", profileId: profiles[0].id, bindingId,
        toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest, catalogRevision: tool.catalogRevision,
        approvalMode: "always", expectedRevision: 0, operationId: "grant-" + index });
      await consent.commit({ challenge: allow.challenge, approved: true });
      rows.push({ installation, bindingId, tool });
    }
    registry.clear(); calls.length = 0; acquired = 0; released = 0;
    await fn({ store, registry, profiles, productStore, consent, manager, restorer, rows, behavior, calls,
      get acquired() { return acquired; }, get released() { return released; },
      clock: value => { now = value; }, hold() { const hold = deferred(); holds.add(hold); return hold; } });
  } finally {
    restorer.stop(); for (const hold of holds) hold.resolve([TOOL]);
    await wait(() => restorer.getState().running === 0, "own workers close");
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  await test("current Grant count excludes expiry, disabled/pending install, disconnected principal", () => withFixture(async f => {
    const row = f.rows[0]; let grant = f.store.getGrant(row.bindingId, row.tool.toolIdentity);
    assert.equal(f.store.getCurrentAllowedGrantCount(row.bindingId), 1);
    f.store.setGrant({ grantId: grant.grantId, bindingId: row.bindingId, toolIdentity: grant.toolIdentity,
      contractDigest: grant.contractDigest, effect: "allow", approvalMode: "each-call", expiresAt: 100001, expectedRevision: grant.revision });
    f.clock(100001); assert.equal(f.store.getGrantCountsForBinding(row.bindingId).allow, 1);
    assert.equal(f.store.getCurrentAllowedGrantCount(row.bindingId), 0);
    f.restorer.start(); await sleep(20); assert.equal(f.acquired, 0); f.restorer.stop();
    grant = f.store.getGrant(row.bindingId, row.tool.toolIdentity);
    f.store.setGrant({ grantId: grant.grantId, bindingId: row.bindingId, toolIdentity: grant.toolIdentity,
      contractDigest: grant.contractDigest, effect: "allow", approvalMode: "always", expectedRevision: grant.revision });
    const connection = f.store.getConnection(f.store.getBinding(row.bindingId).connectionId);
    f.store.setConnectionIdentity({ connectionId: connection.connectionId, principalIdentity: "local:different",
      state: "ready", expectedRevision: connection.revision });
    assert.equal(f.store.getCurrentAllowedGrantCount(row.bindingId), 0);
    assert.throws(() => f.store.getCurrentAllowedGrantCount(row.bindingId, -1), { code: "PLUGIN_GRANT_INVALID" });
  }));
  await test("startup is asynchronous and restores without mutating authority", () => withFixture(async f => {
    const row = f.rows[0], before = f.store.getCapabilityRecords(row.bindingId, row.tool.toolIdentity);
    f.restorer.start(); assert.equal(f.acquired, 0);
    await wait(() => f.restorer.getState().restored === 1, "startup restoration");
    assert.equal(f.calls.length, 1); assert.equal(f.released, 1);
    assert.deepEqual(f.store.getCapabilityRecords(row.bindingId, row.tool.toolIdentity), before);
    assert(f.registry.listForBinding(before));
  }));
  await test("selection wait coalesces the exact installed binding", () => withFixture(async f => {
    const hold = f.hold(); f.behavior.list = () => hold.promise; const row = f.rows[0];
    f.restorer.start(); const selection = [{ installationId: row.installation.installationId, revision: row.installation.revision }];
    const first = f.restorer.prepareSelection(selection), second = f.restorer.prepareSelection(selection);
    await wait(() => f.calls.length === 1, "single discover");
    assert.equal(f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection")), null);
    hold.resolve([TOOL]); await Promise.all([first, second]); assert.equal(f.calls.length, 1);
    await assert.rejects(f.restorer.prepareSelection([{ ...selection[0], revision: selection[0].revision + 1 }]), { code: "PLUGIN_SELECTION_STALE" });
    assert.equal(f.calls.length, 1);
  }));
  for (const mutation of ["revoke", "disable", "disconnect", "profile", "stop", "generation"]) {
    await test("pending tools/list cannot publish after " + mutation, () => withFixture(async f => {
      const row = f.rows[0], hold = f.hold(); f.behavior.list = () => hold.promise; f.restorer.start();
      await wait(() => f.calls.length === 1, "pending discover");
      const selected = f.restorer.prepareSelection([{ installationId: row.installation.installationId, revision: row.installation.revision }]);
      const rejected = assert.rejects(selected, { code: "PLUGIN_SELECTION_UNAVAILABLE" });
      if (mutation === "revoke") { const grant = f.store.getGrant(row.bindingId, row.tool.toolIdentity); f.store.revokeGrant({ bindingId: row.bindingId, toolIdentity: grant.toolIdentity, expectedRevision: grant.revision }); }
      if (mutation === "disable") { f.store.beginInstallationDisable({ installationId: row.installation.installationId,
        expectedRevision: row.installation.revision, operationId: "pending-disable", fingerprint: "f".repeat(64) }); assert.equal(f.store.getCurrentAllowedGrantCount(row.bindingId), 0); }
      if (mutation === "disconnect") { const connection = f.store.getConnection(f.store.getBinding(row.bindingId).connectionId); f.store.disconnectMcpConnection({ connectionId: connection.connectionId, expectedRevision: connection.revision }); }
      if (mutation === "profile") f.profiles[0].enabled = false;
      if (["stop", "generation"].includes(mutation)) f.restorer.stop();
      if (mutation === "generation") {
        f.restorer.start();
        // Let the new asynchronous startup scan see the still-owned physical
        // worker. A later fresh discovery is valid; this old result is not.
        await sleep(20);
        assert.equal(f.calls.length, 1);
        assert.equal(f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection")), null);
      }
      hold.resolve([TOOL]); await rejected;
      await wait(() => f.restorer.getState().running === 0, "stale worker end");
      assert.equal(f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection")), null);
      if (mutation === "generation") {
        f.behavior.list = async () => [{ ...TOOL, description: "Fresh new generation contract" }];
        await f.restorer.prepareSelection([{ installationId: row.installation.installationId, revision: row.installation.revision }]);
        assert.equal(f.calls.length, 2);
        assert.notEqual(f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection")).entries[0].contractDigest, row.tool.contractDigest);
      }
    }));
  }
  await test("timeout stays closed and cannot grow physical workers", () => withFixture(async f => {
    const row = f.rows[0], hold = f.hold(); f.behavior.list = () => hold.promise; f.restorer.start();
    const selection = [{ installationId: row.installation.installationId, revision: row.installation.revision }];
    await assert.rejects(f.restorer.prepareSelection(selection), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    assert.equal(f.restorer.getState().running, 1);
    await assert.rejects(f.restorer.prepareSelection(selection), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
    assert.equal(f.acquired, 1); hold.resolve([TOOL]);
    await wait(() => f.restorer.getState().running === 0, "late timeout worker");
    assert.equal(f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection")), null);
  }));
  await test("fresh contract drift does not change or revive a saved Grant", () => withFixture(async f => {
    const row = f.rows[0], before = f.store.getGrant(row.bindingId, row.tool.toolIdentity);
    f.behavior.list = async () => [{ ...TOOL, description: "Changed server contract" }];
    f.restorer.start(); await f.restorer.prepareSelection([{ installationId: row.installation.installationId, revision: row.installation.revision }]);
    const catalog = f.registry.listForBinding(f.store.getCapabilityRecords(row.bindingId, "projection"));
    assert(catalog); assert.notEqual(catalog.entries[0].contractDigest, before.contractDigest);
    assert.deepEqual(f.store.getGrant(row.bindingId, row.tool.toolIdentity), before);
    assert.equal(require("../app/agent-service/plugin-availability").createPluginAvailability(f.store, f.registry)(row.installation, "mcp-server", "local-issues"), "permission_required");
  }));
  await test("startup workers stay bounded while queued selection has priority", () => withFixture(async f => {
    const hold = f.hold(); let active = 0, peak = 0;
    f.behavior.list = async () => { active += 1; peak = Math.max(peak, active); try { return await hold.promise; } finally { active -= 1; } };
    f.restorer.start(); await wait(() => f.calls.length === 2, "two workers only");
    assert.equal(f.acquired, 2); assert.equal(f.restorer.getState().queued, 1);
    const row = f.rows[2], selected = f.restorer.prepareSelection([{ installationId: row.installation.installationId, revision: row.installation.revision }]);
    await sleep(10); assert.equal(f.acquired, 2); hold.resolve([TOOL]); await selected;
    await wait(() => f.restorer.getState().running === 0, "bounded workers finish");
    assert.equal(f.calls.length, 3); assert.equal(f.released, 3); assert.equal(peak, 2);
  }, 3));
  await test("Registry final synchronous fence and old marker cannot revoke a successor", () => withFixture(async f => {
    const row = f.rows[0], records = f.store.getCapabilityRecords(row.bindingId, "projection");
    await assert.rejects(f.registry.refresh({ ...records, client: { listTools: async () => [TOOL] }, assertCurrent: () => false }));
    assert.equal(f.registry.listForBinding(records), null);
    await assert.rejects(f.registry.refresh({ ...records, client: { listTools: async () => [TOOL] }, assertCurrent: () => Promise.resolve(true) }));
    const hold = f.hold(); const old = f.registry.refresh({ ...records, client: { listTools: () => hold.promise }, assertCurrent: () => { throw new Error("old generation"); } });
    const rejected = assert.rejects(old);
    const current = await f.registry.refresh({ ...records, client: { listTools: async () => [TOOL] }, assertCurrent: () => true });
    hold.resolve([TOOL]); await rejected;
    assert.equal(f.registry.listForBinding(records).catalogRevision, current.catalogRevision);
    assert.equal(f.registry.invalidate(records.connection.connectionId, "old-catalog"), false);
    assert.equal(f.registry.listForBinding(records).catalogRevision, current.catalogRevision);
  }));
  await test("optional startup enumeration failure does not throw from start", () => withFixture(async f => {
    f.productStore.listAgentProfiles = () => { throw Object.assign(new Error("fixture catalog unavailable"), { code: "PLUGIN_STORE_CLOSED" }); };
    assert.doesNotThrow(() => f.restorer.start());
    await wait(() => f.restorer.getState().active === false, "failed optional generation closed");
    assert.equal(f.acquired, 0);
    await assert.rejects(f.restorer.prepareSelection([{ installationId: f.rows[0].installation.installationId, revision: f.rows[0].installation.revision }]), { code: "PLUGIN_SELECTION_UNAVAILABLE" });
  }));
  await test("Controller captures selection and physical subject before awaiting", () => withFixture(async f => {
    const hold = f.hold(); let hookCalls = 0, submitted;
    const controller = new PluginServiceController({ store: f.store, productStore: f.productStore,
      installer: new PluginPackageInstaller({ store: f.store }), catalog: new PluginComponentCatalog({ store: f.store }),
      resolver: new PluginComponentResolver({ store: f.store }), toolCatalogRegistry: f.registry,
      drainInstallation: async () => {}, resumeInstallation: () => {},
      getExternalSelectionDispatch: () => ({ get: () => null, prepare: value => { submitted = value; return { accepted: true }; } }),
      prepareSelectionCatalog: selection => { hookCalls += 1; assert.equal(selection[0].revision, f.rows[0].installation.revision); return hold.promise; } });
    const params = { subject: { backendId: "hermes", instanceId: "trusted-instance", agentId: "actual-agent", sessionId: "physical-owner" },
      operationId: "controller-operation", requiredAdapterId: "shoggoth_shared_capabilities", adapterGeneration: "host-generation",
      pluginSelection: [{ installationId: f.rows[0].installation.installationId, revision: f.rows[0].installation.revision }] };
    const accepted = controller.handle("plugins.selection.external.prepare", params);
    params.subject.sessionId = "mutated-owner"; params.pluginSelection[0].revision = 999;
    hold.resolve(); await accepted; assert.equal(hookCalls, 1);
    assert.equal(submitted.subject.sessionId, "physical-owner"); assert.equal(submitted.pluginSelection[0].revision, f.rows[0].installation.revision);
    assert.throws(() => controller.handle("plugins.selection.external.prepare", { ...params, subject: {} }), { code: "PLUGIN_REQUEST_INVALID" });
    assert.throws(() => controller.handle("plugins.selection.external.prepare", { ...submitted, pluginSelection: [] }), { code: "PLUGIN_SELECTION_INVALID" });
    assert.equal(hookCalls, 1);
  }));
  await test("Controller existing dispatch stays observation without restore", () => withFixture(async f => {
    let hookCalls = 0;
    const controller = new PluginServiceController({ store: f.store, productStore: f.productStore,
      installer: new PluginPackageInstaller({ store: f.store }), catalog: new PluginComponentCatalog({ store: f.store }),
      resolver: new PluginComponentResolver({ store: f.store }), toolCatalogRegistry: f.registry,
      drainInstallation: async () => {}, resumeInstallation: () => {},
      getExternalSelectionDispatch: () => ({ get: () => ({ state: "outcome_unknown" }), prepare: () => ({ original: true }) }),
      prepareSelectionCatalog: () => { hookCalls += 1; throw new Error("unexpected rediscovery"); } });
    assert.deepEqual(controller.handle("plugins.selection.external.prepare", {
      subject: { backendId: "hermes", instanceId: "trusted-instance", agentId: "actual-agent", sessionId: "physical-owner" },
      operationId: "controller-operation", requiredAdapterId: "shoggoth_shared_capabilities", adapterGeneration: "host-generation",
      pluginSelection: [{ installationId: f.rows[0].installation.installationId, revision: f.rows[0].installation.revision }] }), { original: true });
    assert.equal(hookCalls, 0);
  }));
  await test("Controller failed read restoration rereads current authority", () => withFixture(async f => {
    const hold = f.hold(); let hookCalls = 0;
    const controller = new PluginServiceController({ store: f.store, productStore: f.productStore,
      installer: new PluginPackageInstaller({ store: f.store }), catalog: new PluginComponentCatalog({ store: f.store }),
      resolver: new PluginComponentResolver({ store: f.store }), toolCatalogRegistry: f.registry,
      drainInstallation: async () => {}, resumeInstallation: () => {},
      prepareSelectionCatalog: () => { hookCalls += 1; return hold.promise; } });
    const params = { profileId: f.profiles[0].id, bindingId: f.rows[0].bindingId };
    const pending = controller.handle("plugins.mcp.tools.list", params);
    const grant = f.store.getGrant(params.bindingId, f.rows[0].tool.toolIdentity);
    f.store.revokeGrant({ bindingId: params.bindingId, toolIdentity: grant.toolIdentity, expectedRevision: grant.revision });
    hold.resolve(); const result = await pending;
    assert.equal(result.available, false); assert.equal(hookCalls, 1);
    assert.equal((await controller.handle("plugins.mcp.tools.list", params)).available, false); assert.equal(hookCalls, 1);
  }));
  console.log(JSON.stringify({ ok: true, tests: checked, realStoreConsentRegistry: true, noRemote: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
