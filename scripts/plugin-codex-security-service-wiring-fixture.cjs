#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");
const { createAgentService } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { ensurePrivateDirectoryTree } = require("../app/agent-service/security");
const { CodexRuntimePool } = require("../app/agent-service/codex-runtime-pool");
const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { resolveCodexRuntimeLayout, CODEX_APP_SERVER_ARGS } = require("../app/agent-service/codex-runtime-paths");
const { CodexSecurityServiceController, createCodexSecurityServiceController,
  CODEX_SECURITY_STATUS_METHOD } = require("../app/agent-service/codex-security-service-controller");

const repo = path.resolve(__dirname, "..");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/codex-security-service-wiring-"));
const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: path.join(root, "user"), cacheRoot: path.join(root, "cache") });
const outputIndex = process.argv.indexOf("--output"), output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
const verifyHttp = process.argv.includes("--verify-http");
const methods = [], checks = [], hosts = new Map(), pauses = new Set();
let httpVerification = null;
const allowedMethods = new Set(["initialize", "initialized", "account/read"]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bounded = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fixture timed out: ${label}`)), 5_000);
  })]); } finally { clearTimeout(timer); }
};
const pauseNextAccountRead = () => {
  const pause = { entered: deferred(), resume: deferred() };
  pauses.add(pause); pauseAccount = pause; return pause;
};
let service, pauseAccount = null;
const binary = resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
const homeRoot = path.join(root, "empty-managed-homes");
const pool = new CodexRuntimePool({ paths, repoRoot: repo, parentEnv: {},
  runtimeAccountLookup: id => service.productStore.getRuntimeAccount(id),
  runtimeAccountResolver: { resolve(binding) {
    const slot = path.join(homeRoot, binding.runtimeAccountId), home = path.join(slot, "codex"), userHome = path.join(slot, "user");
    ensurePrivateDirectoryTree(home, root); ensurePrivateDirectoryTree(userHome, root);
    return Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
      kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
      home, nativeHome: null, integrationRoot: null, binaryPath: binary,
      launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: userHome, CODEX_HOME: home }), configurationMode: "overlay" });
  } },
  hostFactory(options) {
    const userHome = options.runtimeEnvironment.spawnEnv.HOME;
    const host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: userHome,
      parentEnv: { HOME: userHome, PATH: "/usr/bin:/bin", TMPDIR: root,
        XDG_CONFIG_HOME: userHome, XDG_DATA_HOME: userHome, XDG_CACHE_HOME: userHome },
      spawnProcess(command, args, spawnOptions) {
        assert(!Object.keys(spawnOptions.env).some(key => /TOKEN|SECRET|API_KEY|AUTH_JSON/u.test(key)));
        const child = spawn(command, args, spawnOptions), write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (chunk, ...rest) => {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const message = JSON.parse(line); methods.push(message.method);
            assert(allowedMethods.has(message.method), `forbidden native method: ${message.method}`);
          }
          return write(chunk, ...rest);
        }; return child;
      } });
    const read = host.accountRead.bind(host);
    host.accountRead = async input => {
      const observation = await read(input);
      if (pauseAccount) { const pause = pauseAccount; pauseAccount = null; pause.entered.resolve(); await pause.resume.promise; }
      return observation;
    };
    hosts.set(options.runtimeProfileId, host); return host;
  } });
const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
const request = (method, params, token = readClientToken(paths)) => requestService(paths,
  { version: SERVICE_PROTOCOL_VERSION, method, params, token }, { timeoutMs: 10_000 });
const status = (installationId = null, runtimeProfileId = null) => request(CODEX_SECURITY_STATUS_METHOD, { installationId, runtimeProfileId });

(async () => {
  try {
    assert.throws(() => new CodexSecurityServiceController({ preflight: { inspect: async () => ({ fullPluginUsable: true }) }, getCoordinator() {} }), TypeError);
    assert.throws(() => createCodexSecurityServiceController({ preflight: {}, getCoordinator() {} }), TypeError);
    service = createAgentService({ paths, repoRoot: repo, version: "codex-security-readonly-wiring-fixture", prewarmMcpAuth: false,
      parentEnv: {}, runtimePool: pool, codexRuntimeAdapter: adapter, runtimeManager: adapter });
    await service.start();
    const oldController = service.codexSecurityServiceController;
    assert(oldController instanceof CodexSecurityServiceController);
    await assert.rejects(request(CODEX_SECURITY_STATUS_METHOD, { installationId: null, runtimeProfileId: null }, null), { code: "AUTH_FAILED" });
    for (const field of ["runId", "lease", "ready", "nativeMeta", "lifecycleAdmission", "scanStarted"]) {
      await assert.rejects(request(CODEX_SECURITY_STATUS_METHOD, { installationId: null, runtimeProfileId: null, [field]: true }), { code: "CODEX_SECURITY_SERVICE_INVALID" });
    }
    await assert.rejects(request("plugins.codex-security.inspect", { runId: "untrusted-app-run" }), { code: "UNKNOWN_METHOD" });
    checks.push("production factory requires real preflight; authenticated exact IPC rejects injected Run/lease/readiness/native metadata and exposes no scanner/lifecycle method");

    const missing = await status();
    assert.equal(missing.installation, null); assert.equal(missing.authentication.status, "unobserved");
    assert.equal(missing.fullPluginUsable, false); assert.equal(missing.owningRunQualified, false);
    assert.equal(methods.length, 0); assert.equal(hosts.size, 0);
    checks.push("metadata-only real socket status verifies frozen package and missing installation without initializing Runtime or minting Run authority");

    const preview = service.pluginPackageInstaller.previewBundled("codex-security");
    let installation = service.pluginPackageInstaller.installBundled({ packageId: "codex-security", previewDigest: preview.contentDigest,
      operationId: "service-readonly-actual-install", expectedRevision: 0 });
    const installed = await status(installation.installationId);
    assert.equal(installed.bundle.version, "0.1.24"); assert.equal(installed.bundle.fileCount, 124);
    assert.equal(installed.installedComponents.skillCount, 15); assert.deepEqual(installed.installedComponents.mcpServerNames, ["codex-security"]);
    assert.equal(installed.installedComponents.nativeComponent.originalFileCount,124);
    assert.deepEqual(installed.sharedBindings, []); assert.equal(installed.installedComponents.diagnosticCodes.includes("LEGACY_MCP_FIELD_UNSUPPORTED"),false);
    assert(installed.fullPluginBlockers.includes("ORIGINAL_MCP_NOT_CONVERTED")); assert.equal(methods.length, 0);
    checks.push("actual installer/resolver release has 15 Skills/one native component; no public connection fabricated and scan/account/license gates remain blockers");

    const profile = service.productStore.listAgentProfiles()[0];
    const binding = service.productStore.addAgentRuntimeBinding(profile.id, { runtime: "codex", runtimeAccountId: profile.runtimeAccountId,
      label: "Read-only qualification candidate" }, { operationId: "readonly-candidate-binding" }).binding;
    const accountStatus = await status(installation.installationId, binding.runtimeProfileId);
    assert.equal(accountStatus.candidate.profileId, profile.id); assert.equal(accountStatus.candidate.runtimeAccountId, profile.runtimeAccountId);
    assert.equal(accountStatus.authentication.status, "unauthenticated");
    assert.equal(accountStatus.owningRunQualified, false); assert.equal(accountStatus.lifecycleReady, false);
    assert(accountStatus.fullPluginBlockers.includes("OWNING_RUN_AUTHORITY_NOT_OBSERVED"));
    assert(methods.includes("account/read")); assert(methods.every(method => allowedMethods.has(method)));
    checks.push("explicit candidate account readiness uses actual Service AccountAuthManager and genuine empty-home native account/read; account readiness grants no owning Run");

    if (verifyHttp) httpVerification = await require("./fixtures/plugin-codex-security-status-http.cjs")({
      service, paths, root, installation, profile, nativeMethods: methods });

    const coordinator = service.workRunCoordinator;
    const ownerInput = { runId: "fixture-owning-readonly-run", runtimeProfileId: profile.runtimeProfileId,
      runtimeAccountId: profile.runtimeAccountId, installationId: installation.installationId, owningBindingId: binding.id };
    const beforeRejected = methods.length;
    await assert.rejects(oldController.inspectOwningRun(ownerInput), { code: "HOST_CAPABILITY_REVOKED" });
    assert.equal(methods.length, beforeRejected);
    const workspace = path.join(root, "empty-workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
    coordinator.dispatcher.enqueue({ id: ownerInput.runId, source: "chat", sourceId: "local-readonly-fixture", idempotencyKey: "local-readonly-fixture",
      profileId: profile.id, workspace });
    const run = coordinator.dispatcher.admit(ownerInput.runId, { writable: false }).run;
    const admission = service.runtimeAccountAdmission.admit({ runtimeAccountId: profile.runtimeAccountId, runId: run.id });
    assert.equal(admission.disposition, "started");
    coordinator.runAccountAdmissions.set(run.id, admission);
    // Fixture registration only: actual durable Run/account admission + issuer
    // brand, with no native thread/turn identifiers and no claim of a real turn.
    coordinator.runExecutionContracts.set(run.id, Object.freeze({ runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId }));
    const issue = () => coordinator.hostCapabilityIssuer.issue({ identity: { runId: run.id, profileId: profile.id,
      bindingId: profile.defaultBindingId, runtime: "codex", runtimeAccountId: profile.runtimeAccountId, attemptId: "local-service-fixture-attempt",
      workspace, accountGeneration: admission.generation }, grants: ["mcp"], validate: () => {
        try { service.runtimeAccountAdmission.assertRunAdmitted({ runtimeAccountId: profile.runtimeAccountId, runId: run.id, generation: admission.generation }); }
        catch { return false; }
        return coordinator.state === "open" && coordinator.dispatcher.getRun(run.id)?.status === "starting";
      } });
    const lease = issue(); coordinator.runCapabilityLeases.set(run.id, lease);
    await assert.rejects(oldController.inspectOwningRun({ ...ownerInput, runtimeProfileId: binding.runtimeProfileId }), { code: "HOST_CAPABILITY_REVOKED" });
    const qualification = await oldController.inspectOwningRun(ownerInput);
    assert.equal(qualification.owningRunQualified, true); assert.equal(qualification.owningAgent.profileId, profile.id);
    assert.equal(qualification.fullPluginUsable, false); assert.equal(qualification.modelTurnStarted, false);
    assert.equal(qualification.originalToolsUnlocked, false); assert.equal(qualification.scanStarted, false);
    assert(!JSON.stringify(accountStatus).includes("lifecycleAdmission"));
    checks.push("internal owning-Run inspection takes genuine issuer brand only from current coordinator execution; foreign execution binding rejected; no thread/turn metadata invented");

    const leasePause = pauseNextAccountRead();
    const stale = oldController.inspectOwningRun(ownerInput);
    stale.catch(() => {});
    await bounded(leasePause.entered.promise, "owning lease account/read");
    coordinator.runCapabilityLeases.set(run.id, issue());
    leasePause.resume.resolve();
    await assert.rejects(stale, { code: "HOST_CAPABILITY_REVOKED" });
    coordinator.hostCapabilityIssuer.revoke(lease);
    coordinator.hostCapabilityIssuer.revoke(coordinator.runCapabilityLeases.get(run.id));
    coordinator.runCapabilityLeases.delete(run.id); coordinator.runExecutionContracts.delete(run.id);
    coordinator.runAccountAdmissions.delete(run.id); service.runtimeAccountAdmission.release({ runtimeAccountId: profile.runtimeAccountId, runId: run.id });
    coordinator.dispatcher.transition(run.id, "interrupted", { errorCode: "FIXTURE_COMPLETE_NO_TURN" });
    checks.push("replacing current coordinator lease during genuine account/read discards result even while old brand and same durable Run remain live");

    const installPause = pauseNextAccountRead();
    const changed = status(installation.installationId, binding.runtimeProfileId);
    changed.catch(() => {});
    await bounded(installPause.entered.promise, "installation account/read");
    installation = service.pluginStore.setInstallationDesiredState({ installationId: installation.installationId,
      expectedRevision: installation.revision, desiredState: "disabled" });
    installPause.resume.resolve();
    await assert.rejects(changed, { code: "CODEX_SECURITY_SERVICE_SOURCE_CHANGED" });
    checks.push("IPC discards account-read result when actual installed release state changes in flight");

    await service.stop();
    await assert.rejects(oldController.status({ installationId: null, runtimeProfileId: null }), { code: "CODEX_SECURITY_SERVICE_CLOSED" });
    await service.start();
    assert.notEqual(service.codexSecurityServiceController, oldController);
    const restarted = await status(installation.installationId);
    assert.equal(restarted.installation.desiredState, "disabled"); assert.equal(restarted.fullPluginUsable, false);
    assert.equal(restarted.owningRunQualified, false); assert.equal(restarted.authentication.status, "unobserved");
    assert.equal(coordinator.hostCapabilityIssuer.activeCount, 0);
    assert(methods.every(method => allowedMethods.has(method)));
    checks.push("real Service stop/start rebuilds preflight for fresh coordinator; old controller stays fenced and durable install is observed without restoring Run authority");

    const result = { passed: true, checks, nativeMethods: methods, nativeThreadStarts: 0, nativeModelTurns: 0,
      scans: 0, credentialsSupplied: false, fullPluginUsable: false, originalToolsUnlocked: false,
      fixtureAuthorityScope: "durable local Run/account with coordinator-registered issuer lease; no real Runtime turn",
      installedProjection: installed, accountProjection: accountStatus, restartedProjection: restarted,
      ...(verifyHttp ? { httpVerification } : {}),
      cleanup: "exclusive temporary empty-HOME Service removed after stop" };
    if (output) fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ passed: true, checks: checks.length, nativeMethods: methods,
      nativeThreadStarts: 0, nativeModelTurns: 0, scans: 0, fullPluginUsable: false,
      ...(verifyHttp ? { httpChecks: httpVerification.checks.length } : {}) }, null, 2)}\n`);
  } finally {
    for (const pause of pauses) pause.resume.resolve();
    pauseAccount = null;
    if (service) await service.stop().catch(() => {});
    await pool.stopAll().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
