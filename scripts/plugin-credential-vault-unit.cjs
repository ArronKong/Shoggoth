"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { PluginCredentialVault, newPluginCredentialRef } = require("../app/agent-service/plugin-credential-vault");
const { PluginConnectionAuth } = require("../app/agent-service/plugin-connection-auth");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");

const fixture = path.join(__dirname, "fixtures/plugins/project-assistant");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-vault-"));
const key = crypto.randomBytes(32);
const broker = {
  async encrypt(plaintext) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  },
  async decrypt(encrypted) {
    const nonce = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(encrypted.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  },
};
const paths = resolveServicePaths({ stateRoot: path.join(temp, "state"),
  userDataRoot: temp, profileRoot: path.join(temp, "profile"),
  cacheRoot: path.join(temp, "cache"), trustedRoot: temp });
const endpointIdentity = "https://fixture.example/mcp";
const issuer = "https://fixture.example/";
const audience = "fixture-api";
let now = 1_000_000;
let store;
let secrets;

function tokens(suffix, overrides = {}) {
  return { access_token: `fixture-access-${suffix}`,
    refresh_token: `fixture-refresh-${suffix}`, token_type: "Bearer",
    expires_in: 120, scope: "issues:read issues:write", ...overrides };
}
function makeVault(verifyPrincipal, refreshTokens = null, invalidateToolCatalog = null) {
  return new PluginCredentialVault({ store, secretStore: secrets,
    verifyPrincipal, refreshTokens, invalidateToolCatalog, now: () => now });
}
function addConnection(installationId, suffix, credentialRef = newPluginCredentialRef()) {
  return store.createConnection({ connectionId: `connection-${suffix}`, installationId,
    componentId: componentId(installationId, "mcp-server", "remote-issues"),
    endpointIdentity, credentialRef });
}
function save(vault, suffix, input = tokens(suffix)) {
  return vault.storePendingOAuthTokens({ connectionId: `connection-${suffix}`,
    expectedRevision: 1, tokens: input, issuer, audience,
    requestedScopes: ["issues:read", "issues:write"] });
}
function verify(vault, suffix) {
  return vault.verifyAndActivate({ connectionId: `connection-${suffix}`, expectedRevision: 1 });
}
function assertPrivate() {
  const ciphertext = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
  const catalog = fs.readFileSync(paths.pluginCatalogPath);
  for (const secret of ["fixture-access-a", "fixture-refresh-a", "fixture-access-b",
    "fixture-refresh-b"]) {
    assert.equal(ciphertext.includes(secret), false);
    assert.equal(catalog.includes(Buffer.from(secret)), false);
  }
  assert.equal(fs.statSync(paths.encryptedSecretsPath).mode & 0o777, 0o600);
}

async function main() {
  store = new PluginStore({ paths }).open();
  secrets = await new EncryptedSecretStore({ paths, cryptoBroker: broker }).open();
  const installer = new PluginPackageInstaller({ store });
  const preview = installer.preview(fixture);
  const installed = installer.install({ sourcePath: fixture, previewDigest: preview.contentDigest,
    operationId: "fixture-install", expectedRevision: 0 });
  const a = addConnection(installed.installationId, "a");
  const b = addConnection(installed.installationId, "b");
  const aRef = store.getConnectionAuth(a.connectionId).credentialRef;
  const bRef = store.getConnectionAuth(b.connectionId).credentialRef;
  assert.notEqual(aRef, bRef);
  assert.equal(Object.hasOwn(a, "credentialRef"), false);
  assert.throws(() => addConnection(installed.installationId, "duplicate", aRef),
    (error) => error.code === "PLUGIN_CONNECTION_INVALID");

  const principalForToken = ({ accessToken }) => ({
    "fixture-access-a": "account-a", "fixture-access-b": "account-b",
  })[accessToken] || null;
  const vault = makeVault(principalForToken);
  assert.equal(await vault.readCredential(a.connectionId), null);
  await assert.rejects(save(vault, "a", tokens("a", { access_token: "bad\r\ntoken" })),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  await assert.rejects(vault.storePendingOAuthTokens({ connectionId: a.connectionId,
    expectedRevision: 1, tokens: tokens("a"), issuer: "https://fixture.example/?bad=1",
    audience, requestedScopes: ["issues:read", "issues:write"] }),
  (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  await assert.rejects(save(vault, "a", tokens("a", { scope: "issues:read admin:write" })),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  assert.equal(secrets.getCredentialRevision(aRef), null);
  await save(vault, "a");
  await save(vault, "b");
  assert.equal(store.getConnection(a.connectionId).state, "pending");
  assert.equal(await vault.readCredential(a.connectionId), null);
  assert.equal(await vault.readCredential(b.connectionId), null);
  await assert.rejects(save(vault, "a"),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  assertPrivate();

  const activatedA = await verify(vault, "a");
  const activatedB = await verify(vault, "b");
  assert.equal(activatedA.principalIdentity, "account-a");
  assert.equal(activatedB.principalIdentity, "account-b");
  assert.equal(activatedA.authRevision, 1);
  assert.equal(activatedB.authRevision, 1);
  assert.equal(Object.hasOwn(activatedA, "credentialRef"), false);
  assert.equal(JSON.stringify([activatedA, activatedB]).includes("fixture-access"), false);
  assertPrivate();

  const auth = new PluginConnectionAuth({ getConnection: (id) => store.getConnection(id),
    readCredential: (id) => vault.readCredential(id), now: () => now });
  const providerA = auth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity,
    issuer, audience, requiredScopes: ["issues:read"] });
  const providerB = auth.credentialProvider({ connectionId: b.connectionId,
    principalIdentity: "account-b", authRevision: 1, endpointIdentity,
    issuer, audience, requiredScopes: ["issues:read"] });
  assert.equal((await providerA()).accessToken, "fixture-access-a");
  assert.equal((await providerB()).accessToken, "fixture-access-b");
  await assert.rejects(auth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-b", authRevision: 1, endpointIdentity })(),
  (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  await assert.rejects(auth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity,
    requiredScopes: ["admin:write"] })(),
  (error) => error.code === "CONNECTION_SCOPE_CHANGED");

  await secrets.close();
  store.close();
  store = new PluginStore({ paths }).open();
  secrets = await new EncryptedSecretStore({ paths, cryptoBroker: broker }).open();
  const reopenedVault = makeVault(principalForToken);
  assert.equal((await reopenedVault.readCredential(a.connectionId)).accessToken,
    "fixture-access-a");
  assert.equal((await reopenedVault.readCredential(b.connectionId)).accessToken,
    "fixture-access-b");
  assertPrivate();

  addConnection(installed.installationId, "c");
  const failedProof = makeVault(async () => { throw new Error("fixture principal offline"); });
  await save(failedProof, "c", tokens("c"));
  await assert.rejects(verify(failedProof, "c"), /fixture principal offline/u);
  await assert.rejects(verify(makeVault(() => "bad\nprincipal"), "c"),
    (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  assert.equal(store.getConnection("connection-c").state, "pending");
  assert.equal(await failedProof.readCredential("connection-c"), null);

  let failCommit = true;
  const crashStore = {
    getConnectionAuth: (id) => store.getConnectionAuth(id),
    setConnectionIdentity(input) {
      if (failCommit) { failCommit = false; throw new Error("fixture crash before SQLite commit"); }
      return store.setConnectionIdentity(input);
    },
  };
  const crashVault = new PluginCredentialVault({ store: crashStore, secretStore: secrets,
    verifyPrincipal: () => "account-c", now: () => now });
  await assert.rejects(verify(crashVault, "c"), /fixture crash before SQLite commit/u);
  assert.equal(store.getConnection("connection-c").state, "pending");
  assert.equal(await crashVault.readCredential("connection-c"), null);
  const recovered = await verify(makeVault(() => "account-c"), "c");
  assert.equal(recovered.principalIdentity, "account-c");
  assert.equal(recovered.authRevision, 1);

  addConnection(installed.installationId, "d");
  const dRef = store.getConnectionAuth("connection-d").credentialRef;
  const competingVault = makeVault(() => "account-d");
  const writes = await Promise.allSettled([save(competingVault, "d", tokens("d-first")),
    save(makeVault(() => "account-d"), "d", tokens("d-second"))]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(writes.filter((result) => result.status === "rejected")[0].reason.code,
    "SECRET_REVISION_CONFLICT");
  assert.equal(secrets.listMetadata().find((entry) => entry.credentialRef === dRef).kind,
    "mcp-oauth");

  addConnection(installed.installationId, "e");
  await save(reopenedVault, "e", tokens("e"));
  let releaseProof;
  const proofGate = new Promise((resolve) => { releaseProof = resolve; });
  let proofEntered;
  const entered = new Promise((resolve) => { proofEntered = resolve; });
  const gatedVault = makeVault(async () => {
    proofEntered();
    await proofGate;
    return "account-e";
  });
  const inFlight = verify(gatedVault, "e");
  await entered;
  store.setConnectionIdentity({ connectionId: "connection-e", principalIdentity: "other-account",
    state: "disconnected", expectedRevision: 1 });
  releaseProof();
  await assert.rejects(inFlight, (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal(await gatedVault.readCredential("connection-e"), null);

  addConnection(installed.installationId, "f");
  await save(reopenedVault, "f", tokens("f"));
  let releaseSecretProof;
  const secretGate = new Promise((resolve) => { releaseSecretProof = resolve; });
  let secretProofEntered;
  const secretEntered = new Promise((resolve) => { secretProofEntered = resolve; });
  const secretGatedVault = makeVault(async () => {
    secretProofEntered();
    await secretGate;
    return "account-f";
  });
  const inFlightSecret = verify(secretGatedVault, "f");
  await secretEntered;
  const fRef = store.getConnectionAuth("connection-f").credentialRef;
  await secrets.put(fRef, await secrets.get(fRef), { kind: "mcp-oauth" });
  releaseSecretProof();
  await assert.rejects(inFlightSecret,
    (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal(store.getConnection("connection-f").state, "pending");

  addConnection(installed.installationId, "g");
  const fallbackVault = makeVault(() => "account-g");
  await save(fallbackVault, "g", tokens("g", { scope: undefined }));
  await verify(fallbackVault, "g");
  assert.deepEqual((await fallbackVault.readCredential("connection-g")).scopes,
    ["issues:read", "issues:write"]);
  addConnection(installed.installationId, "h");
  const narrowedVault = makeVault(() => "account-h");
  await save(narrowedVault, "h", tokens("h", { scope: "issues:read" }));
  await verify(narrowedVault, "h");
  assert.deepEqual((await narrowedVault.readCredential("connection-h")).scopes,
    ["issues:read"]);
  const narrowedAuth = new PluginConnectionAuth({ getConnection: (id) => store.getConnection(id),
    readCredential: (id) => narrowedVault.readCredential(id), now: () => now });
  await assert.rejects(narrowedAuth.credentialProvider({ connectionId: "connection-h",
    principalIdentity: "account-h", authRevision: 1, endpointIdentity,
    requiredScopes: ["issues:write"] })(),
  (error) => error.code === "CONNECTION_SCOPE_CHANGED");

  now += 100_000;
  const catalogRegistry = new PluginToolCatalogRegistry();
  const catalogInstallation = { ...installed,
    activeReleaseDigest: installed.releaseDigest };
  const catalogContext = (connectionId) => {
    const connection = store.getConnection(connectionId);
    return { installation: catalogInstallation, connection,
      binding: { componentId: connection.componentId, connectionId } };
  };
  const catalogClient = { async listTools() {
    return [{ name: "issue_read", inputSchema: { type: "object" } }];
  } };
  const oldCatalog = await catalogRegistry.refresh({ ...catalogContext(a.connectionId),
    client: catalogClient });
  await catalogRegistry.refresh({ ...catalogContext(b.connectionId),
    client: catalogClient });
  assert(catalogRegistry.listForBinding(catalogContext(a.connectionId)));
  assert(catalogRegistry.listForBinding(catalogContext(b.connectionId)));
  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshEntered;
  const enteredRefresh = new Promise((resolve) => { refreshEntered = resolve; });
  const refreshVault = makeVault(({ accessToken }) =>
    accessToken === "fixture-access-a-rotated" ? "account-a" : null,
  async ({ refreshToken }) => {
    refreshCalls += 1;
    assert.equal(refreshToken, "fixture-refresh-a");
    refreshEntered();
    await refreshGate;
    return tokens("a-rotated", { refresh_token: "fixture-refresh-a-rotated",
      scope: "issues:read" });
  }, (connectionId) => catalogRegistry.invalidate(connectionId));
  const refreshingAuth = new PluginConnectionAuth({
    getConnection: (id) => store.getConnection(id),
    readCredential: (id) => refreshVault.readCredential(id),
    refreshCredential: (context) => refreshVault.refreshCredential(context),
    now: () => now,
  });
  const refreshingProvider = refreshingAuth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity,
    issuer, audience, requiredScopes: ["issues:read"] });
  const firstRefresh = refreshingProvider();
  const secondRefresh = refreshingProvider();
  await enteredRefresh;
  assert.equal(refreshCalls, 1);
  assert.equal(catalogRegistry.listForBinding(catalogContext(a.connectionId)), null,
    "refresh must fence a catalog issued under the previous token before rotation");
  assert(catalogRegistry.listForBinding(catalogContext(b.connectionId)),
    "another account's catalog stays available");
  let releaseStaleCatalog;
  const staleRefresh = catalogRegistry.refresh({
    ...catalogContext(a.connectionId),
    client: { listTools: () => new Promise((resolve) => {
      releaseStaleCatalog = resolve;
    }) },
  });
  releaseRefresh();
  assert.equal((await firstRefresh).accessToken, "fixture-access-a-rotated");
  assert.equal((await secondRefresh).accessToken, "fixture-access-a-rotated");
  assert.equal(store.getConnection(a.connectionId).authRevision, 1);
  assert.equal((await reopenedVault.readCredential(a.connectionId)).scopes.join(" "),
    "issues:read");
  releaseStaleCatalog([{ name: "issue_read", inputSchema: { type: "object" } }]);
  await assert.rejects(staleRefresh,
    (error) => error.code === "TOOL_CONTRACT_CHANGED",
    "an old-token discovery completing after rotation cannot republish its catalog");
  assert.equal(catalogRegistry.listForBinding(catalogContext(a.connectionId)), null);
  const newCatalog = await catalogRegistry.refresh({
    ...catalogContext(a.connectionId), client: catalogClient });
  assert.notEqual(newCatalog.catalogRevision, oldCatalog.catalogRevision);
  await assert.rejects(refreshingAuth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity,
    requiredScopes: ["issues:write"] })(),
  (error) => error.code === "CONNECTION_SCOPE_CHANGED");
  const expandedVault = makeVault(() => "account-a", async () =>
    tokens("unexpected-scope", { scope: "issues:read admin:write" }));
  await assert.rejects(expandedVault.refreshCredential({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity }),
  (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  assert.equal((await reopenedVault.readCredential(a.connectionId)).accessToken,
    "fixture-access-a-rotated");

  store.createBinding({ bindingId: "fixture-binding-b", profileId: "profile-b",
    installationId: installed.installationId,
    componentId: componentId(installed.installationId, "mcp-server", "remote-issues"),
    connectionId: b.connectionId });
  const beforeSwitchGrant = store.setGrant({ grantId: "fixture-grant-b",
    bindingId: "fixture-binding-b", toolIdentity: "fixture-issues-read",
    contractDigest: "a".repeat(64), effect: "allow", approvalMode: "always",
    expectedRevision: 0 });
  assert.equal(beforeSwitchGrant.effect, "allow");
  const switchedVault = makeVault(() => "other-account", async () =>
    tokens("switched", { scope: "issues:read" }));
  const switchedAuth = new PluginConnectionAuth({
    getConnection: (id) => store.getConnection(id),
    readCredential: (id) => switchedVault.readCredential(id),
    refreshCredential: (context) => switchedVault.refreshCredential(context),
    now: () => now,
  });
  await assert.rejects(switchedAuth.credentialProvider({ connectionId: b.connectionId,
    principalIdentity: "account-b", authRevision: 1, endpointIdentity })(),
  (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal(store.getConnection(b.connectionId).state, "disconnected");
  assert.equal(store.getConnection(b.connectionId).authRevision, 2);
  const afterSwitchGrant = store.getGrant("fixture-binding-b", "fixture-issues-read");
  assert.equal(afterSwitchGrant.effect, "deny");
  assert.ok(afterSwitchGrant.epoch > beforeSwitchGrant.epoch);
  assert.equal(await switchedVault.readCredential(b.connectionId), null);

  let releaseConflictRefresh;
  const conflictGate = new Promise((resolve) => { releaseConflictRefresh = resolve; });
  let conflictEntered;
  const enteredConflict = new Promise((resolve) => { conflictEntered = resolve; });
  const conflictVault = makeVault(() => "account-c", async () => {
    conflictEntered();
    await conflictGate;
    return tokens("c-rotated");
  });
  const conflict = conflictVault.refreshCredential({ connectionId: "connection-c",
    principalIdentity: "account-c", authRevision: 1, endpointIdentity });
  await enteredConflict;
  const cRef = store.getConnectionAuth("connection-c").credentialRef;
  await secrets.put(cRef, await secrets.get(cRef), { kind: "mcp-oauth" });
  releaseConflictRefresh();
  await assert.rejects(conflict,
    (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal((await reopenedVault.readCredential("connection-c")).accessToken,
    "fixture-access-c");

  store.createBinding({ bindingId: "fixture-binding-c", profileId: "profile-c",
    installationId: installed.installationId,
    componentId: componentId(installed.installationId, "mcp-server", "remote-issues"),
    connectionId: "connection-c" });
  const beforeDisconnect = store.setGrant({ grantId: "fixture-grant-c",
    bindingId: "fixture-binding-c", toolIdentity: "fixture-issues-read",
    contractDigest: "b".repeat(64), effect: "allow", approvalMode: "always",
    expectedRevision: 0 });
  let releaseRevokedRefresh;
  const revokedGate = new Promise((resolve) => { releaseRevokedRefresh = resolve; });
  let revokedEntered;
  const enteredRevoked = new Promise((resolve) => { revokedEntered = resolve; });
  const revokedVault = makeVault(() => "account-c", async () => {
    revokedEntered();
    await revokedGate;
    return tokens("c-after-revoke");
  });
  const pendingRevoked = revokedVault.refreshCredential({ connectionId: "connection-c",
    principalIdentity: "account-c", authRevision: 1, endpointIdentity });
  await enteredRevoked;
  const cBefore = store.getConnection("connection-c");
  store.setConnectionIdentity({ connectionId: "connection-c",
    principalIdentity: "account-c", state: "disconnected",
    expectedRevision: cBefore.revision });
  releaseRevokedRefresh();
  await assert.rejects(pendingRevoked,
    (error) => error.code === "CONNECTION_IDENTITY_CHANGED");
  assert.equal(await reopenedVault.readCredential("connection-c"), null);
  const afterDisconnect = store.getGrant("fixture-binding-c", "fixture-issues-read");
  assert.equal(afterDisconnect.effect, "deny");
  assert.ok(afterDisconnect.epoch > beforeDisconnect.epoch);

  now += 121_000;
  const expiredAuth = new PluginConnectionAuth({ getConnection: (id) => store.getConnection(id),
    readCredential: (id) => reopenedVault.readCredential(id), now: () => now });
  await assert.rejects(expiredAuth.credentialProvider({ connectionId: a.connectionId,
    principalIdentity: "account-a", authRevision: 1, endpointIdentity })(),
  (error) => error.code === "CONNECTION_AUTH_REQUIRED");
  console.log("plugin credential vault local fixture: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (secrets) await secrets.close();
    if (store) store.close();
    key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  });
