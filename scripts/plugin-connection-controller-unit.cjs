"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), test = require("node:test");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { PluginConnectionController } = require("../app/agent-service/plugin-connection-controller");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");
const { validatePluginConnectionResult: validate } = require("../app/core/plugin-connection-dto");

async function fixture(run) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/sg-disconnect-"));
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"), trustedRoot: root });
  const store = new PluginStore({ paths }).open();
  try {
    const installer = new PluginPackageInstaller({ store }), source = path.join(__dirname, "fixtures/plugins/project-assistant");
    const installed = installer.install({ sourcePath: source, previewDigest: installer.preview(source).contentDigest,
      expectedRevision: 0, operationId: "install" });
    store.setInstallationDesiredState({ installationId: installed.installationId, expectedRevision: installed.revision, desiredState: "enabled" });
    const component = componentId(installed.installationId, "mcp-server", "remote-issues");
    const profiles = ["a", "b", "c"].map(id => ({ id: `profile-${id}`, name: `Agent ${id}`, enabled: true }));
    const connections = ["a", "b"].map(id => {
      store.createConnection({ connectionId: `connection-${id}`, installationId: installed.installationId,
        componentId: component, endpointIdentity: "https://fixture.invalid/mcp", credentialRef: `opaque-fixture-${id}` });
      return store.setConnectionIdentity({ connectionId: `connection-${id}`, principalIdentity: `private-account-${id}`,
        state: "ready", expectedRevision: 1 });
    });
    const bindings = profiles.map((profile, index) => {
      const connection = connections[index < 2 ? 0 : 1];
      const binding = store.createBinding({ bindingId: `binding-${index}`, profileId: profile.id,
        installationId: installed.installationId, componentId: component, connectionId: connection.connectionId });
      const enabled = store.setBindingEnabled({ bindingId: binding.bindingId, enabled: true, expectedRevision: binding.revision });
      store.setGrant({ grantId: `grant-${index}`, bindingId: binding.bindingId,
        toolIdentity: `plugin:${installed.installationId}:${component}:${connection.connectionId}:${"a".repeat(64)}`,
        contractDigest: "b".repeat(64), effect: "allow", approvalMode: "always", expectedRevision: 0 });
      return enabled;
    });
    const events = [], productStore = { getAgentProfile: id => profiles.find(profile => profile.id === id) || null };
    const hooks = {
      drainConnection(id) { assert.equal(store.getConnection(id).state, "disconnected"); events.push(["drain", id]); },
      cancelStaleOAuth(values) { assert.ok(values.every(value => !value.enabled)); events.push(["cancel", values.length]); },
      invalidateConnection(id) { events.push(["invalidate", id]); },
    };
    const make = extra => new PluginConnectionController({ store, productStore, ...hooks, ...extra });
    const controller = make(), input = { profileId: profiles[0].id, bindingId: bindings[0].bindingId,
      expectedRevision: bindings[0].revision, operationId: "disconnect-a" };
    const commit = (control = controller, request = input) => control.commit({ challenge: control.prepare(request).challenge, approved: true });
    await run({ store, profiles, connections, bindings, input, controller, make, commit, events });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("native consent cancellation, extra fields, profile isolation and preview CAS", async () => fixture(async f => {
  const preview = f.controller.prepare(f.input); validate("plugins.connections.prepare", preview);
  assert.equal(preview.summary.affectedBindings, 2);
  assert.equal(preview.summary.credentialDisposition, "retained_encrypted_unusable");
  assert.deepEqual(await f.controller.commit({ challenge: preview.challenge, approved: false }), { canceled: true, receipt: null });
  assert.equal(f.events.length, 0); assert.deepEqual(f.store.getConnection("connection-a"), f.connections[0]);
  assert.throws(() => f.controller.prepare({ ...f.input, approved: true }), { code: "PLUGIN_REQUEST_INVALID" });
  assert.throws(() => f.controller.prepare({ ...f.input, profileId: "profile-b" }), { code: "PLUGIN_BINDING_INVALID" });
  const pending = f.controller.prepare(f.input); f.profiles[0].name = "Renamed";
  await assert.rejects(f.controller.commit({ challenge: pending.challenge, approved: true }), { code: "REVISION_CONFLICT" });
}));

test("all shared bindings and grants fence atomically; other accounts and encrypted refs remain", async () => fixture(async f => {
  const auth = new PluginConnectionAuth({ getConnection: id => f.store.getConnection(id),
    readCredential: async () => { throw new Error("must never read after fence"); } });
  const provider = auth.credentialProvider(f.connections[0]);
  const result = await f.commit(); validate("plugins.connections.commit", result);
  assert.equal(result.receipt.cleanupStatus, "complete");
  assert.equal(f.store.getConnection("connection-a").authRevision, f.connections[0].authRevision + 1);
  await assert.rejects(provider(), { code: "CONNECTION_IDENTITY_CHANGED" });
  for (const before of f.bindings.slice(0, 2)) {
    const after = f.store.getBinding(before.bindingId);
    assert.equal(after.enabled, false); assert.equal(after.revision, before.revision + 1);
    assert.equal(f.store.getGrantCountsForBinding(before.bindingId).allow, 0);
  }
  assert.deepEqual(f.store.getConnection("connection-b"), f.connections[1]);
  assert.deepEqual(f.store.getBinding(f.bindings[2].bindingId), f.bindings[2]);
  assert.equal(f.store.getGrantCountsForBinding(f.bindings[2].bindingId).allow, 1);
  assert.equal(f.store.getConnectionAuth("connection-a").credentialRef, "opaque-fixture-a");
  for (const secret of ["private-account", "endpointIdentity", "credentialRef", "authorityIncarnation"]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(await f.commit(), result, "same operation never increments revisions twice");
  assert.equal(f.store.getConnection("connection-a").authRevision, f.connections[0].authRevision + 1);
  assert.throws(() => f.controller.prepare({ ...f.input, expectedRevision: f.input.expectedRevision + 1 }), { code: "REVISION_CONFLICT" });
  assert.throws(() => f.controller.operation({ profileId: "profile-b", operationId: f.input.operationId }), { code: "PLUGIN_BINDING_INVALID" });
}));

test("already disabled bindings still advance; response loss and cleanup failure keep durable authority fence", async () => fixture(async f => {
  const before = f.store.setBindingEnabled({ bindingId: f.input.bindingId, enabled: false, expectedRevision: f.input.expectedRevision });
  const input = { ...f.input, expectedRevision: before.revision };
  const crash = f.make({ onPhase() { throw Object.assign(new Error("simulated response loss"), { code: "PLUGIN_SIMULATED_CRASH" }); } });
  await assert.rejects(f.commit(crash, input), { code: "PLUGIN_SIMULATED_CRASH" });
  const after = f.store.getBinding(input.bindingId); assert.equal(after.revision, before.revision + 1);
  const reopened = f.make({ drainConnection() { throw new Error("close not yet confirmed"); } });
  const recovered = reopened.operation({ profileId: input.profileId, operationId: input.operationId });
  validate("plugins.connections.operation", recovered);
  assert.equal(recovered.phase, "completed"); assert.equal(recovered.receipt.cleanupStatus, "pending");
  const retry = await f.commit(reopened, input);
  assert.equal(retry.receipt.cleanupStatus, "pending");
  assert.equal(f.store.getBinding(input.bindingId).revision, after.revision);
  assert.equal((await f.commit(f.make(), input)).receipt.cleanupStatus, "complete");
}));

test("old cleanup cannot affect a new identity and restored receipts cannot replay", async () => fixture(async f => {
  await f.commit();
  const old = f.store.getConnection("connection-a");
  f.store.setConnectionIdentity({ connectionId: old.connectionId, expectedRevision: old.revision,
    principalIdentity: "new-private-identity", state: "ready" });
  const count = f.events.length;
  assert.equal((await f.commit()).receipt.reasonCode, "CONNECTION_IDENTITY_CHANGED");
  assert.equal(f.events.length, count);
  f.store.rotateAuthorityForRestore({ backupId: "disconnect-fixture-restore" });
  const value = f.controller.operation({ profileId: f.input.profileId, operationId: f.input.operationId });
  validate("plugins.connections.operation", value);
  assert.equal(value.phase, "outcome_unknown"); assert.equal(value.receipt, null);
  assert.throws(() => f.controller.prepare(f.input), { code: "PLUGIN_OPERATION_OUTCOME_UNKNOWN" });
}));
