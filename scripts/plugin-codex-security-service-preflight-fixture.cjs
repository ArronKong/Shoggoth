#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { BundledPluginCatalog } = require("../app/core/bundled-plugin-catalog");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ensurePrivateDirectoryTree } = require("../app/agent-service/security");
const { JsonlProductStore, defaultAgentProfile } = require("../app/agent-service/product-store");
const { agentRuntimeProfileViews } = require("../app/agent-service/agent-runtime-profile-views");
const { createWorkDispatcher, ACTIVE_WORK_RUN_STATUSES } = require("../app/agent-service/work-run");
const { HostCapabilityIssuer } = require("../app/agent-service/host-capability-issuer");
const { RuntimeAccountAdmission } = require("../app/agent-service/runtime-account-admission");
const { AccountAuthManager } = require("../app/agent-service/account-auth-manager");
const { AccountAuthStateStore } = require("../app/agent-service/account-auth-state-store");
const { RuntimeSessionOwnershipStore } = require("../app/agent-service/runtime-session-ownership-store");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentResolver } = require("../app/agent-service/plugin-component-resolver");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { ToolRegistry } = require("../app/agent-service/tool-registry");
const { PluginRuntimeToolService } = require("../app/agent-service/plugin-runtime-tool-service");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { CodexSecurityDelegationController } = require("../app/agent-service/codex-security-delegation-controller");
const { CodexSecurityServicePreflight } = require("../app/agent-service/codex-security-service-preflight");

const repo = path.resolve(__dirname, "..");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/codex-security-service-preflight-"));
const outputIndex = process.argv.indexOf("--output"), output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: root,
  stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const homeRoot = path.join(root, "managed-lifecycle-homes");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const methods = [], checks = [], hosts = new Map();
let productStore, store, ownershipStore, issuer, authState, authManager, pool, lifecycle, pluginRuntime;

(async () => {
  try {
    productStore = new JsonlProductStore({ paths }); productStore.open();
    const profile = productStore.listAgentProfiles()[0], accountId = profile.runtimeAccountId;
    const target = productStore.addAgentRuntimeBinding(profile.id,
      { runtime: "codex", runtimeAccountId: accountId, label: "Isolated lifecycle fixture" }, { operationId: "lifecycle-owning-binding" }).binding;
    const secondId = crypto.randomUUID();
    const second = productStore.putAgentProfile({ ...defaultAgentProfile(Date.now()), id: secondId,
      name: "Isolated lifecycle B", agentId: `shoggoth-${secondId}`, runtimeProfileId: `shoggoth-${secondId}`, isDefault: false });
    const foreignTarget = productStore.addAgentRuntimeBinding(second.id,
      { runtime: "codex", runtimeAccountId: accountId, label: "Isolated foreign lifecycle" }, { operationId: "foreign-owning-binding" }).binding;
    const dispatcher = createWorkDispatcher({ store: productStore });
    const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    const runFor = (id, p) => {
      dispatcher.enqueue({ id, source: "chat", sourceId: `fixture-${id}`, idempotencyKey: `fixture-${id}`, profileId: p.id, workspace });
      return dispatcher.admit(id, { writable: false }).run;
    };
    const run = runFor("real-owning-run", profile), other = runFor("foreign-owning-run", second);
    const accountAdmission = new RuntimeAccountAdmission({ runtimeAccountLookup: id => productStore.getRuntimeAccount(id) });
    const admitted = accountAdmission.admit({ runtimeAccountId: accountId, runId: run.id });
    accountAdmission.admit({ runtimeAccountId: accountId, runId: other.id });
    issuer = new HostCapabilityIssuer();
    const leaseFor = (r, p, includeGeneration = true) => issuer.issue({ identity: { runId: r.id, profileId: p.id,
      bindingId: p.defaultBindingId, runtime: p.runtime, runtimeAccountId: p.runtimeAccountId,
      attemptId: "preflight-attempt-1", workspace,
      ...(includeGeneration ? { accountGeneration: admitted.generation } : {}) }, grants: ["mcp"],
      validate: identity => ACTIVE_WORK_RUN_STATUSES.has(dispatcher.getRun(identity.runId)?.status) });
    const lease = leaseFor(run, profile), foreign = leaseFor(other, second);
    const bundledCatalog = new BundledPluginCatalog(path.join(repo, "resources/bundled-plugins"));
    store = new PluginStore({ paths }).open();
    const resolver = new PluginComponentResolver({ store });
    const installer = new PluginPackageInstaller({ store, bundledCatalog });
    const binary = resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
    const environment = binding => {
      const slot = path.join(homeRoot, binding.runtimeAccountId), home = path.join(slot, "codex"), userHome = path.join(slot, "user");
      ensurePrivateDirectoryTree(home, root); ensurePrivateDirectoryTree(userHome, root);
      return Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
        kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
        home, nativeHome: null, integrationRoot: null, binaryPath: binary,
        launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: userHome, CODEX_HOME: home }), configurationMode: "overlay" });
    };
    pool = new CodexRuntimePool({ paths, repoRoot: repo, parentEnv: {},
      runtimeAccountLookup: id => productStore.getRuntimeAccount(id), runtimeAccountResolver: { resolve: environment },
      hostFactory(options) {
        const userHome = options.runtimeEnvironment.spawnEnv.HOME;
        const host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: userHome,
          parentEnv: { HOME: userHome, PATH: "/usr/bin:/bin", TMPDIR: root,
            XDG_CONFIG_HOME: userHome, XDG_DATA_HOME: userHome, XDG_CACHE_HOME: userHome },
          spawnProcess(command, args, spawnOptions) {
            assert(!Object.keys(spawnOptions.env).some(key => /TOKEN|SECRET|API_KEY|AUTH_JSON/u.test(key)));
            const child = spawn(command, args, spawnOptions), originalWrite = child.stdin.write.bind(child.stdin);
            child.stdin.write = (chunk, ...rest) => {
              for (const line of String(chunk).split("\n").filter(Boolean)) {
                const message = JSON.parse(line); methods.push(message.method);
                assert(!/^turn\/|^mcpServer\/tool\/call$|login|account\/logout/u.test(message.method || ""));
              }
              return originalWrite(chunk, ...rest);
            }; return child;
          } });
        hosts.set(options.runtimeProfileId, host); return host;
      } });
    const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
    authState = new AccountAuthStateStore({ paths }).open();
    const resolveBinding = runtimeProfileId => {
      const binding = agentRuntimeProfileViews(productStore).find(item => item.runtimeProfileId === runtimeProfileId);
      assert(binding); return { runtime: binding.runtime, runtimeProfileId, runtimeAccountId: binding.runtimeAccountId };
    };
    authManager = new AccountAuthManager({ stateStore: authState, runtimeManager: adapter,
      runtimeAccountAdmission: accountAdmission, resolveProfileAuthBinding: resolveBinding,
      resolveRuntimeAccountBinding(runtimeAccountId) {
        const account = productStore.getRuntimeAccount(runtimeAccountId);
        const profiles = agentRuntimeProfileViews(productStore).filter(item => item.runtimeAccountId === runtimeAccountId)
          .sort((left, right) => Number(right.enabled) - Number(left.enabled)
            || Number(left.providerRef != null) - Number(right.providerRef != null)
            || Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id));
        assert(account && profiles[0]?.runtime === account.runtime);
        return { runtime: account.runtime, runtimeProfileId: profiles[0].runtimeProfileId, runtimeAccountId };
      } }).open();
    const preflight = new CodexSecurityServicePreflight({ store, resolver, bundledCatalog, productStore, dispatcher,
      capabilityIssuer: issuer, runtimeAccountAdmission: accountAdmission, accountAuthManager: authManager });
    const input = { installationId: null, owningBindingId: target.id };
    await assert.rejects(preflight.inspect(input, structuredClone(lease)), { code: "HOST_CAPABILITY_REVOKED" });
    await assert.rejects(preflight.inspect({ ...input, authenticated: true }, lease), { code: "CODEX_SECURITY_PREFLIGHT_INVALID" });
    await assert.rejects(preflight.inspect({ ...input, installationId: 123 }, lease), { code: "CODEX_SECURITY_PREFLIGHT_INVALID" });
    await assert.rejects(preflight.inspect({ ...input, owningBindingId: 123 }, lease), { code: "CODEX_SECURITY_PREFLIGHT_INVALID" });
    await assert.rejects(preflight.inspect(input, leaseFor(run, profile, false)), { code: "CODEX_SECURITY_PREFLIGHT_ACCOUNT_ADMISSION_REQUIRED" });
    await assert.rejects(preflight.inspect({ ...input, owningBindingId: foreignTarget.id }, lease));
    const missing = await preflight.inspect(input, lease);
    assert.equal(missing.lifecycleReady, false); assert.equal(missing.installation, null); assert.equal(missing.lifecycleAdmission, null);
    assert.equal(methods.length, 0);
    checks.push("branded owning lease/account admission required; foreign binding and missing install cannot initialize Runtime");
    const preview = installer.previewBundled("codex-security");
    assert(preview.installable); assert.deepEqual(preview.mcpServers, []);
    let installation = installer.installBundled({ packageId: "codex-security", previewDigest: preview.contentDigest,
      operationId: "actual-frozen-release-install", expectedRevision: 0 });
    const inspection = await preflight.inspect({ ...input, installationId: installation.installationId }, lease);
    assert.equal(inspection.lifecycleReady, true); assert.equal(inspection.authentication.status, "unauthenticated");
    assert.equal(inspection.installedComponents.skillCount, 15); assert.deepEqual(inspection.installedComponents.mcpServerNames, ["codex-security"]);
    assert.deepEqual(inspection.sharedBindings, []); assert.equal(inspection.fullPluginUsable, false);
    assert(inspection.fullPluginBlockers.includes("ORIGINAL_MCP_NOT_CONVERTED"));
    assert(inspection.fullPluginBlockers.includes("SHARED_MCP_CONNECTION_NOT_READY"));
    assert(inspection.fullPluginBlockers.includes("CODEX_ACCOUNT_NOT_AUTHENTICATED"));
    assert(inspection.installedComponents.diagnosticCodes.includes("LEGACY_MCP_FIELD_UNSUPPORTED"));
    checks.push("actual frozen 0.1.24 installed release contains 15 Skills and one native component; public connections absent; real account/read is null");
    assert.throws(() => preflight.activateAdmission(structuredClone(inspection.lifecycleAdmission), lease), { code: "CODEX_SECURITY_PREFLIGHT_ADMISSION_INVALID" });
    assert.throws(() => preflight.activateAdmission(inspection.lifecycleAdmission, foreign), { code: "CODEX_SECURITY_PREFLIGHT_ADMISSION_INVALID" });
    ownershipStore = new RuntimeSessionOwnershipStore({ paths }).open();
    const registry = new PluginToolCatalogRegistry();
    const toolRegistry = new ToolRegistry({ capabilities: [{ tool: "mcp_server_call", risk: "read" }],
      definitions: [{ name: "mcp_server_call", description: "Local lifecycle prerequisite", inputSchema: { type: "object", properties: {} } }] });
    const policy = new PermissionEngine({ toolRegistry });
    const capabilityDispatcher = new CapabilityDispatcher({ store, permissionEngine: policy, resolveToolContract: value => registry.resolve(value) });
    pluginRuntime = new PluginRuntimeToolService({ store, productStore, getRun: id => dispatcher.getRun(id), toolCatalogRegistry: registry,
      capabilityDispatcher, permissionEngine: policy, acquireConnection: async () => { assert.fail("No MCP scanner or tool may be acquired"); } });
    pluginRuntime.captureRun(run);
    lifecycle = new CodexSecurityDelegationController({ paths, dispatcher, productStore, runtimeManager: adapter, ownershipStore,
      capabilityIssuer: issuer, pluginRuntimeToolService: pluginRuntime, owningAgentAdmission: preflight, managedHomeRoot: homeRoot }).open();
    await assert.rejects(lifecycle.prepare({ operationId: "no-active-admission" }, lease), { code: "CODEX_SECURITY_PREFLIGHT_ADMISSION_INVALID" });
    preflight.activateAdmission(inspection.lifecycleAdmission, lease);
    const receipt = await lifecycle.prepare({ operationId: "genuine-admitted-owning-thread" }, lease);
    assert.equal(receipt.state, "ready"); assert.equal(receipt.runtimeSessionRef.runtimeProfileId, target.runtimeProfileId);
    assert.equal(receipt.runtimeSessionRef.runtimeAccountId, productStore.getRuntimeAccount(accountId).id);
    assert.equal(receipt.owner.profileId, profile.id); assert.equal(receipt.runtimeTurnRef, null); assert.equal(receipt.fullPluginUsable, false);
    checks.push("opaque preflight admission required by actual controller; owning Codex binding comes from the same admitted Agent profile");
    const host = hosts.get(target.runtimeProfileId), reached = deferred(), continueRead = deferred(), originalRead = host.threadRead.bind(host);
    host.threadRead = async params => { const result = await originalRead(params); reached.resolve(); await continueRead.promise; return result; };
    const inFlight = lifecycle.inspect({ operationId: "genuine-admitted-owning-thread" }, lease);
    const rejected = assert.rejects(inFlight, { code: "CODEX_SECURITY_PREFLIGHT_STALE" });
    await reached.promise;
    installation = store.setInstallationDesiredState({ installationId: installation.installationId,
      desiredState: "disabled", expectedRevision: installation.revision });
    continueRead.resolve(); await rejected; host.threadRead = originalRead;
    await lifecycle.close(); lifecycle = null;
    checks.push("installation revoked during genuine native read invalidates lifecycle admission; shutdown only unsubscribes owned thread");
    installation = store.setInstallationDesiredState({ installationId: installation.installationId,
      desiredState: "enabled", expectedRevision: installation.revision });
    const methodsBeforeReleasedRun = methods.length;
    assert.equal(accountAdmission.release({ runtimeAccountId: accountId, runId: run.id }), true);
    assert.equal(accountAdmission.read(accountId).active, 1);
    await assert.rejects(preflight.inspect({ ...input, installationId: installation.installationId }, lease),
      { code: "CODEX_SECURITY_PREFLIGHT_ACCOUNT_ADMISSION_REQUIRED" });
    assert.equal(methods.length, methodsBeforeReleasedRun);
    assert.equal(accountAdmission.admit({ runtimeAccountId: accountId, runId: run.id }).disposition, "started");
    checks.push("other active Agent cannot mask this owning Run's account admission release; rejection occurs before auth RPC");
    const pauseAuth = deferred(), continueAuth = deferred(), originalAuthRead = authManager.readForProfile.bind(authManager);
    authManager.readForProfile = async params => { const result = await originalAuthRead(params); pauseAuth.resolve(); await continueAuth.promise; return result; };
    const waiting = preflight.inspect({ ...input, installationId: installation.installationId }, lease);
    const revoked = assert.rejects(waiting, { code: "HOST_CAPABILITY_REVOKED" });
    await pauseAuth.promise; issuer.revoke(lease); continueAuth.resolve(); await revoked;
    authManager.readForProfile = originalAuthRead;
    checks.push("lease revoked during real account/read cannot mint a preflight admission");
    const nativeStarts = methods.filter(method => method === "thread/start").length;
    assert.equal(nativeStarts, 1); assert.equal(methods.filter(method => /^turn\//u.test(method || "")).length, 0);
    for (const host of hosts.values()) assert.equal(fs.existsSync(path.join(host.runtimeEnvironment.home, "auth.json")), false);
    const codeHashes = Object.fromEntries([
      "app/agent-service/codex-security-service-preflight.js",
      "app/agent-service/codex-security-delegation-controller.js",
      "app/agent-service/runtime-account-admission.js",
      "scripts/plugin-codex-security-service-preflight-fixture.cjs",
    ].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex")]));
    const evidence = { schemaVersion: 1, outcome: "PASS", scope: "installed-release-and-owning-agent-service-preflight", codeHashes,
      bundle: inspection.bundle, installedReleaseDigest: inspection.installation.releaseDigest,
      installedSkillCount: inspection.installedComponents.skillCount, installedMcpCount: inspection.installedComponents.mcpServerNames.length,
      sharedBindingCount: inspection.sharedBindings.length, authentication: inspection.authentication,
      fullPluginBlockers: inspection.fullPluginBlockers, checks,
      nativeMethods: [...new Set(methods)].sort(), genuineThreadStarts: nativeStarts,
      credentialInput: false, modelTurnStarted: false, scannerLoaded: false, scanStarted: false,
      originalToolsUnlocked: false, serviceIpcWired: false, fullPluginUsable: false, rightsApproved: false };
    if (output) fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
  finally {
    if (lifecycle) await lifecycle.close().catch(error => { console.error(error); process.exitCode = 1; });
    if (authManager) await authManager.close().catch(error => { console.error(error); process.exitCode = 1; });
    if (pool) await pool.stopAll().catch(error => { console.error(error); process.exitCode = 1; });
    issuer?.close(); pluginRuntime?.clear(); ownershipStore?.close(); await authState?.close(); store?.close(); productStore?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
