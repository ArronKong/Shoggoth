#!/usr/bin/env node
"use strict";

// Real pinned app-server lifecycle only. Never send a model turn, scanner call,
// credentials, user prompt, or installed plugin into the disposable homes.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { ensurePrivateDirectoryTree } = require("../app/agent-service/security");
const { JsonlProductStore, defaultAgentProfile } = require("../app/agent-service/product-store");
const { createWorkDispatcher, ACTIVE_WORK_RUN_STATUSES } = require("../app/agent-service/work-run");
const { HostCapabilityIssuer } = require("../app/agent-service/host-capability-issuer");
const { RuntimeSessionOwnershipStore } = require("../app/agent-service/runtime-session-ownership-store");
const { PluginStore } = require("../app/agent-service/plugin-store");
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

const repo = path.resolve(__dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/shoggoth-codex-security-lifecycle-"));
const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: root,
  stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const homeRoot = path.join(root, "lifecycle-homes");
const binary = resolveCodexRuntimeLayout({ repoRoot: repo }).runtimePath;
const rpcMethods = [], starts = [], nativeErrors = [], hosts = new Map();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let controller, pool, productStore, pluginStore, ownershipStore, issuer, pluginRuntime;
const checks = [];

(async () => {
  try {
    ensurePrivateDirectoryTree(homeRoot, root);
    const runtimeVersion = execFileSync(binary, ["--version"], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root } }).trim();
    assert.equal(runtimeVersion, "codex-cli 0.159.2");
    productStore = new JsonlProductStore({ paths }); productStore.open();
    const firstProfile = productStore.listAgentProfiles()[0];
    const secondId = crypto.randomUUID();
    const secondProfile = productStore.putAgentProfile({ ...defaultAgentProfile(Date.now()),
      id: secondId, agentId: `shoggoth-${secondId}`, runtimeProfileId: `shoggoth-${secondId}`,
      name: "Lifecycle fixture B", isDefault: false });
    const dispatcher = createWorkDispatcher({ store: productStore });
    const newRun = (id, profile) => {
      const workspace = path.join(root, `workspace-${id}`);
      fs.mkdirSync(workspace, { mode: 0o700 });
      dispatcher.enqueue({ id, source: "chat", sourceId: `local-${id}`, idempotencyKey: `local-${id}`,
        profileId: profile.id, workspace });
      const run = dispatcher.admit(id, { writable: false }).run;
      assert.equal(run.status, "starting");
      return run;
    };
    const runA = newRun("lifecycle-run-a", firstProfile);
    const runB = newRun("lifecycle-run-b", secondProfile);
    const runC = newRun("lifecycle-run-c", firstProfile);
    issuer = new HostCapabilityIssuer();
    const issue = (run, grants = ["mcp"], attemptId = "lifecycle-attempt-1") => {
      const profile = productStore.getAgentProfile(run.profileId);
      const identity = { runId: run.id, profileId: profile.id, bindingId: profile.defaultBindingId,
        runtime: profile.runtime, runtimeAccountId: profile.runtimeAccountId,
        attemptId, workspace: run.workspace };
      return issuer.issue({ identity, grants, validate: candidate => {
        const current = dispatcher.getRun(candidate.runId);
        return ACTIVE_WORK_RUN_STATUSES.has(current?.status) && current.profileId === candidate.profileId;
      } });
    };
    const leaseA = issue(runA), leaseB = issue(runB), leaseC = issue(runC);
    ownershipStore = new RuntimeSessionOwnershipStore({ paths }).open();
    pluginStore = new PluginStore({ paths }).open();
    const catalogs = new PluginToolCatalogRegistry();
    const toolRegistry = new ToolRegistry({ capabilities: [{ tool: "mcp_server_call", risk: "read" }],
      definitions: [{ name: "mcp_server_call", description: "Lifecycle fixture capability projection",
        inputSchema: { type: "object", properties: {} } }] });
    const policy = new PermissionEngine({ toolRegistry });
    const capabilityDispatcher = new CapabilityDispatcher({ store: pluginStore, permissionEngine: policy,
      resolveToolContract: value => catalogs.resolve(value) });
    pluginRuntime = new PluginRuntimeToolService({ store: pluginStore, productStore,
      getRun: id => dispatcher.getRun(id), toolCatalogRegistry: catalogs, capabilityDispatcher,
      permissionEngine: policy, acquireConnection: async () => { assert.fail("No plugin is connected or executed"); } });
    for (const run of [runA, runB, runC]) {
      assert.deepEqual(pluginRuntime.captureRun(run), { serverCount: 0 });
      assert.deepEqual(pluginRuntime.skillToolProjectionForRun(run), []);
    }
    const targetBindingForOwner = owner => ({ runtime: "codex",
      runtimeProfileId: `security-lifecycle-${crypto.createHash("sha256").update(`${owner.profileId}:${owner.runId}:${owner.attemptId}`).digest("hex").slice(0, 32)}`,
      runtimeAccountId: "shoggoth-codex-security-lifecycle-local" });
    const environmentFor = binding => {
      const slot = path.join(homeRoot, binding.runtimeProfileId);
      const home = path.join(slot, "codex"), userHome = path.join(slot, "user");
      ensurePrivateDirectoryTree(home, root); ensurePrivateDirectoryTree(userHome, root);
      return Object.freeze({ runtime: "codex", runtimeAccountId: binding.runtimeAccountId,
        kind: "shoggoth-managed", installationKind: "bundled", homeKind: "managed-shared", strategy: "managed-shared",
        home, nativeHome: null, integrationRoot: null, binaryPath: binary,
        launchArgs: Object.freeze([...CODEX_APP_SERVER_ARGS]), spawnEnv: Object.freeze({ HOME: userHome, CODEX_HOME: home }),
        configurationMode: "overlay" });
    };
    pool = new CodexRuntimePool({ paths, parentEnv: {}, repoRoot: repo,
      runtimeAccountLookup: () => null,
      runtimeAccountResolver: { resolve: binding => environmentFor(binding) },
      hostFactory(options) {
        const home = options.runtimeEnvironment.spawnEnv.HOME;
        const host = new CodexRuntimeHost({ ...options, repoRoot: repo, cwd: home,
          parentEnv: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: root,
            XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home },
          spawnProcess(command, args, spawnOptions) {
            assert.equal(command, binary);
            assert(!Object.keys(spawnOptions.env).some(key => /TOKEN|SECRET|API_KEY|AUTH_JSON/u.test(key)));
            const child = spawn(command, args, spawnOptions);
            let buffered = "";
            child.stdout.on("data", chunk => { buffered += chunk.toString(); for (;;) {
              const end = buffered.indexOf("\n"); if (end < 0) break;
              const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
              try { const response = JSON.parse(line); if (response.error) nativeErrors.push(response.error); } catch {}
            } });
            const originalWrite = child.stdin.write.bind(child.stdin);
            child.stdin.write = function (chunk, ...rest) {
              for (const line of String(chunk).split("\n").filter(Boolean)) {
                const request = JSON.parse(line);
                rpcMethods.push(request.method);
                assert(!/^turn\/|^mcpServer\/tool\/call$|login|account\/logout/u.test(request.method || ""), "No model, MCP call, scan, or authentication RPC is allowed");
                if (request.method === "thread/start") {
                  assert.equal(request.params.ephemeral, false);
                  assert.equal(request.params.approvalPolicy, "never"); assert.equal(request.params.sandbox, "read-only");
                  assert.equal(request.params.model, undefined); assert.equal(request.params.developerInstructions, undefined);
                  starts.push({ runtimeProfileId: options.runtimeProfileId, cwd: request.params.cwd });
                }
              }
              return originalWrite(chunk, ...rest);
            };
            return child;
          } });
        hosts.set(options.runtimeProfileId, host);
        return host;
      } });
    const adapter = new CodexRuntimeAdapter({ runtimePool: pool });
    const makeController = () => new CodexSecurityDelegationController({ paths, dispatcher, productStore,
      runtimeManager: adapter, ownershipStore, capabilityIssuer: issuer,
      pluginRuntimeToolService: pluginRuntime, targetBindingForOwner, managedHomeRoot: homeRoot }).open();
    controller = makeController();
    assert.throws(makeController, { code: "CODEX_SECURITY_DELEGATION_STORE_IN_USE" });
    await assert.rejects(controller.prepare({ operationId: "forged" }, structuredClone(leaseA)), { code: "HOST_CAPABILITY_REVOKED" });
    await assert.rejects(controller.prepare({ operationId: "no-grant" }, issue(runA, [])), { code: "HOST_CAPABILITY_REVOKED" });
    await assert.rejects(controller.prepare({ operationId: "extra", threadId: "forged" }, leaseA), { code: "CODEX_SECURITY_DELEGATION_INVALID" });
    assert.equal(rpcMethods.length, 0);
    checks.push("opaque Service lease, exact request, MCP grant, and duplicate controller rejected before native RPC");
    const environmentB = environmentFor(targetBindingForOwner({ profileId: secondProfile.id, runId: runB.id, attemptId: "lifecycle-attempt-1" }));
    fs.writeFileSync(path.join(environmentB.home, "config.toml"), 'model = "must-not-load-fixture"\n', { mode: 0o600 });
    await assert.rejects(controller.prepare({ operationId: "existing-config" }, leaseB), { code: "CODEX_SECURITY_DELEGATION_CREDENTIALLESS_RUNTIME_REQUIRED" });
    assert.equal(rpcMethods.length, 0); assert.equal(hosts.size, 0);
    fs.unlinkSync(path.join(environmentB.home, "config.toml"));
    fs.writeFileSync(path.join(environmentB.home, "auth.json"), '{}\n', { mode: 0o600 });
    await assert.rejects(controller.prepare({ operationId: "existing-auth" }, leaseB), { code: "CODEX_SECURITY_DELEGATION_CREDENTIALLESS_RUNTIME_REQUIRED" });
    assert.equal(rpcMethods.length, 0); assert.equal(hosts.size, 0);
    fs.unlinkSync(path.join(environmentB.home, "auth.json"));
    checks.push("existing config/auth file refused before RuntimePool initializes or emits any native RPC");

    const receipts = await Promise.all([controller.prepare({ operationId: "own-a" }, leaseA), controller.prepare({ operationId: "own-a" }, leaseA)]);
    assert.deepEqual(receipts[0], receipts[1]);
    const receipt = receipts[0];
    assert.equal(receipt.state, "ready"); assert.equal(receipt.owner.runId, runA.id); assert.equal(receipt.owner.profileId, firstProfile.id);
    assert.equal(receipt.runtimeTurnRef, null); assert.equal(receipt.scanStarted, false); assert.equal(receipt.fullPluginUsable, false);
    assert.equal(starts.length, 1, "Concurrent idempotent requests create one genuine thread");
    const hostA = hosts.get(receipt.runtimeSessionRef.runtimeProfileId);
    const native = await hostA.threadRead({ threadId: receipt.runtimeSessionRef.sessionId, includeTurns: false });
    assert.equal(native.thread.id, receipt.runtimeSessionRef.sessionId);
    assert.equal(native.thread.cwd, runA.workspace); assert.equal(native.thread.ephemeral, false); assert.deepEqual(native.thread.turns, []);
    assert.deepEqual(await hostA.accountRead({ refreshToken: false }), { account: null, requiresOpenaiAuth: true });
    assert.equal(ownershipStore.assertOwned({ binding: targetBindingForOwner(receipt.owner),
      profileId: receipt.owner.profileId, sessionId: receipt.runtimeSessionRef.sessionId, workspace: runA.workspace }).status, "active");
    assert.deepEqual(await controller.inspect({ operationId: "own-a" }, leaseA), receipt);
    checks.push("actual 0.159.2 thread/start and thread/read; empty turns; account=null; persisted owning Agent");

    const rpcBefore = rpcMethods.length;
    for (const foreign of [leaseB, leaseC, issue(runA, ["mcp"], "different-attempt")]) {
      await assert.rejects(controller.inspect({ operationId: "own-a" }, foreign), { code: "CODEX_SECURITY_DELEGATION_OWNER_INVALID" });
      await assert.rejects(controller.release({ operationId: "own-a" }, foreign), { code: "CODEX_SECURITY_DELEGATION_OWNER_INVALID" });
    }
    assert.equal(rpcMethods.length, rpcBefore, "Foreign Agent, Run, attempt cannot read or unsubscribe a thread");
    checks.push("cross-Agent, cross-Run, and cross-attempt reuse rejected before native RPC");
    const unsubscribeBefore = rpcMethods.filter(method => method === "thread/unsubscribe").length;
    const parallelRelease = await Promise.all([controller.release({ operationId: "own-a" }, leaseA), controller.release({ operationId: "own-a" }, leaseA)]);
    assert.deepEqual(parallelRelease[0], parallelRelease[1]);
    assert.equal(rpcMethods.filter(method => method === "thread/unsubscribe").length, unsubscribeBefore + 1);
    const released = parallelRelease[0];
    assert.equal(released.state, "released");
    assert.deepEqual(await controller.release({ operationId: "own-a" }, leaseA), released);
    assert.equal(released.releaseMethod, "thread/unsubscribe");
    assert.equal(released.unsubscribeStatus, "unsubscribed");
    assert.equal(released.nativeThreadArchived, false); assert.equal(released.nativeThreadDeleted, false);
    assert.equal(ownershipStore.assertOwned({ binding: targetBindingForOwner(receipt.owner),
      profileId: receipt.owner.profileId, sessionId: receipt.runtimeSessionRef.sessionId, workspace: runA.workspace }).status, "active");
    assert.equal(hostA.state, "ready", "Delegation release does not stop the shared runtime host");
    checks.push("actual schema-validated unsubscribe; concurrent/idempotent release; fixed ownership retained; RuntimePool remains available");
    const receiptB = await controller.prepare({ operationId: "own-b" }, leaseB);
    assert.equal(receiptB.owner.profileId, secondProfile.id);
    assert.notEqual(receiptB.runtimeSessionRef.sessionId, receipt.runtimeSessionRef.sessionId);
    assert.notEqual(receiptB.runtimeSessionRef.runtimeProfileId, receipt.runtimeSessionRef.runtimeProfileId);
    assert.notEqual(hosts.get(receiptB.runtimeSessionRef.runtimeProfileId).runtimeEnvironment.home, hostA.runtimeEnvironment.home);
    await controller.release({ operationId: "own-b" }, leaseB);
    checks.push("two genuine Agents have distinct owning native threads, Runtime profiles, and private homes");

    const acquired = await adapter.acquire(targetBindingForOwner({ ...receipt.owner, runId: runC.id, workspace: runC.workspace }),
      { permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    const hostC = acquired.host;
    const readReached = deferred(), finishRead = deferred();
    const originalRead = hostC.threadRead.bind(hostC);
    hostC.threadRead = async request => { const response = await originalRead(request); readReached.resolve(); await finishRead.promise; return response; };
    const revokedCreate = controller.prepare({ operationId: "revoke-after-read" }, leaseC);
    await readReached.promise; issuer.revoke(leaseC); finishRead.resolve();
    await assert.rejects(revokedCreate, { code: "HOST_CAPABILITY_REVOKED" });
    hostC.threadRead = originalRead;
    const recordedAfterRevoke = JSON.parse(fs.readFileSync(controller.recordPath)).records.find(record => record.operationId === "revoke-after-read");
    assert.equal(recordedAfterRevoke.state, "needs_verification"); assert(recordedAfterRevoke.sessionId);
    checks.push("lease revoked during genuine native read cannot publish ready; known thread retained for cleanup");

    const originalStart = hostA.threadStart.bind(hostA);
    let lostNativeId;
    hostA.threadStart = async request => {
      const response = await originalStart(request); lostNativeId = response.thread.id;
      throw Object.assign(new Error("Fixture drops a genuine native thread/start ACK"), { code: "RPC_ACK_DROPPED" });
    };
    await assert.rejects(controller.prepare({ operationId: "lost-start-ack" }, leaseA));
    hostA.threadStart = originalStart;
    assert(lostNativeId);
    const countAfterLostAck = starts.length;
    await assert.rejects(controller.prepare({ operationId: "lost-start-ack" }, leaseA), { code: "CODEX_SECURITY_DELEGATION_VERIFICATION_REQUIRED" });
    assert.equal(starts.length, countAfterLostAck);
    await controller.close(); controller = null;
    assert.equal(ownershipStore.assertOwned({ binding: targetBindingForOwner({ ...receipt.owner, runId: runC.id, workspace: runC.workspace }),
      profileId: firstProfile.id, sessionId: recordedAfterRevoke.sessionId, workspace: runC.workspace }).status, "active");
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.pluginDataDir, "codex-security-delegation", "lifecycle-v1.json"))).records.find(record => record.operationId === "revoke-after-read").state, "released");
    controller = makeController();
    await assert.rejects(controller.prepare({ operationId: "lost-start-ack" }, leaseA), { code: "CODEX_SECURITY_DELEGATION_VERIFICATION_REQUIRED" });
    assert.equal(starts.length, countAfterLostAck, "Restart cannot silently create a replacement thread");
    const unknown = await controller.inspect({ operationId: "lost-start-ack" }, leaseA);
    assert.equal(unknown.state, "needs_verification"); assert.equal(unknown.runtimeSessionRef, null);
    checks.push("genuine thread/start ACK lost; operation never replayed before or after controller restart");

    const state = JSON.parse(fs.readFileSync(controller.recordPath));
    const lifecycleModes = [...new Set(state.records.map(record => record.state))].sort();
    await controller.close(); controller = null;
    fs.writeFileSync(path.join(homeRoot, "journal-original.json"), JSON.stringify(state));
    const damaged = { ...state, checksum: "0".repeat(64) };
    fs.writeFileSync(path.join(paths.pluginDataDir, "codex-security-delegation", "lifecycle-v1.json"), JSON.stringify(damaged), { mode: 0o600 });
    assert.throws(makeController, { code: "CODEX_SECURITY_DELEGATION_STORE_CORRUPT" });
    checks.push("corrupt persisted journal fails closed");
    fs.writeFileSync(path.join(paths.pluginDataDir, "codex-security-delegation", "lifecycle-v1.json"), JSON.stringify(state), { mode: 0o600 });
    controller = makeController();
    fs.appendFileSync(controller.recordPath, "\n");
    const beforeCas = starts.length;
    await assert.rejects(controller.prepare({ operationId: "stale-writer" }, leaseA), { code: "CODEX_SECURITY_DELEGATION_STORE_CONFLICT" });
    assert.equal(starts.length, beforeCas);
    await controller.close(); controller = null;
    checks.push("private journal CAS refuses an externally changed file before thread/start");
    assert.equal(rpcMethods.filter(method => /^turn\//u.test(method || "")).length, 0);
    assert.equal(rpcMethods.filter(method => method === "mcpServer/tool/call").length, 0);
    for (const host of hosts.values()) assert.equal(fs.existsSync(path.join(host.runtimeEnvironment.home, "auth.json")), false);
    const evidence = { schemaVersion: 1, outcome: "PASS", scope: "credentialless-owning-thread-lifecycle-only",
      runtimeVersion, binarySha256: crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
      productionStructures: ["JsonlProductStore", "WorkDispatcher", "HostCapabilityIssuer", "PluginRuntimeToolService",
        "CodexRuntimePool", "CodexRuntimeAdapter", "CodexRuntimeHost", "RuntimeSessionOwnershipStore"],
      checks, nativeMethods: [...new Set(rpcMethods)].sort(), genuineThreadStarts: starts.length,
      lifecycleModes, credentialInput: false, authenticatedAccount: false, modelTurnStarted: false,
      scannerLoaded: false, scanStarted: false, userDataRead: false,
      serviceIpcWired: false, frozenToolConversionCompleted: false, fullScanAcceptance: false, rightsApproved: false };
    if (output) fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
  } catch (error) { console.error(error.stack || error); console.error(JSON.stringify({ methods: rpcMethods, nativeErrors })); process.exitCode = 1; }
  finally {
    if (controller) await controller.close().catch(error => console.error(`controller cleanup: ${error.code || error.message}`));
    if (pool) await pool.stopAll().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
    issuer?.close(); pluginRuntime?.clear(); ownershipStore?.close(); pluginStore?.close(); productStore?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
