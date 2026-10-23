#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os"), assert = require("node:assert/strict");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { prepareCodexRuntimeAccountHome } = require("../app/agent-service/codex-runtime-paths");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { readMacSystemProxyEnvironment } = require("../app/agent-service/launch-agent");
const { redactDiagnostic } = require("../app/agent-service/codex-rpc-safety");
const fixtureArgs = process.argv.slice(2);
assert.ok(fixtureArgs.length === 0 || (fixtureArgs.length === 1 && fixtureArgs[0] === "--metadata-only"), "Unknown acceptance mode");
const metadataOnly = fixtureArgs[0] === "--metadata-only";
const repoRoot = path.resolve(__dirname, ".."), output = path.join(repoRoot, metadataOnly
  ? ".artifacts/proactive-reminders/live-runtime-metadata.json" : ".artifacts/proactive-reminders/live-runtime.json");
async function main() {
  const root = fs.mkdtempSync("/private/tmp/sg-proactive-live-"); fs.chmodSync(root, 0o700);
  try { await runFixture(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function runFixture(root) {
  const paths = resolveServicePaths({ trustedRoot: root, homeDir: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const nativeHome = path.join(root, ".codex"); fs.mkdirSync(nativeHome, { mode: 0o700 });
  const accountHome = prepareCodexRuntimeAccountHome(paths, SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID);
  const sourceAuth = path.join(os.homedir(), ".codex", "auth.json"), stat = fs.lstatSync(sourceAuth);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  fs.copyFileSync(sourceAuth, path.join(accountHome, "auth.json")); fs.chmodSync(path.join(accountHome, "auth.json"), 0o600);
  const key = crypto.randomBytes(32); fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { mode: 0o600 });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
  const helper = path.join(repoRoot, "scripts/fixtures/proactive-live-mcp.cjs");
  const mcpHelperLaunch = { command: fs.realpathSync(process.execPath), argsPrefix: [helper] };
  const submissions = [];
  const service = createAgentService({ paths, repoRoot, version: "proactive-source-acceptance", safeStorage,
    parentEnv: { ...readMacSystemProxyEnvironment(), HOME: root, CODEX_HOME: nativeHome, PATH: "/opt/homebrew/bin:/usr/bin:/bin", TMPDIR: root }, runtimeStorageHomedir: root,
    mcpHelperLaunch, runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch, bootstrapPath: helper }),
    notificationSender: async input => { submissions.push(input.noticeId); return { state: "submitted" }; } });
  const result = { scope: "isolated source Service with real bundled Codex and Provider", productionBootstrapVerified: false,
    realMacNotificationVerified: false, verified: false, stage: "start", accountHomeKind: "managed-shared",
    metadataOnly, nativeTurnRequests: 0 };
  const stage = value => { result.stage = value; console.log(JSON.stringify({ stage: value })); };
  const errorCodes = error => [error, error?.cause, ...(error?.errors || [])].flatMap(value => value
    ? [(/^[A-Z0-9_]+$/.test(value.code || "") ? value.code : "UNCLASSIFIED_ERROR"), ...(value !== error ? value.errors || [] : [])
      .map(child => /^[A-Z0-9_]+$/.test(child.code || "") ? child.code : "UNCLASSIFIED_ERROR")] : []);
  // Preserve capability metadata and bounded, redacted configuration errors. The verifier deliberately
  // maps native failures to a fixed public error; acceptance still needs the
  // actual failing boundary without logging credentials or model content.
  const acquire = service.codexRuntimeAdapter.acquire.bind(service.codexRuntimeAdapter);
  service.codexRuntimeAdapter.acquire = async (...args) => {
    const handle = await acquire(...args);
    const observed = Object.create(handle);
    result.runtimeEvidence = { version: handle.host.runtimeVersion, phase: "acquired" };
    const credentialStrings = [];
    const collectStrings = value => {
      if (typeof value === "string" && Buffer.byteLength(value) >= 4) credentialStrings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
    };
    collectStrings(JSON.parse(fs.readFileSync(path.join(accountHome, "auth.json"))));
    result.runtimeEvents ??= [];
    handle.host.subscribe(event => {
      if (result.runtimeEvents.length >= 100 || !event.tool) return;
      const value = { type: event.type, method: event.method,
        tool: String(event.tool.name || "").replace(/[^A-Za-z0-9_./:-]/gu, "").slice(0, 160),
        status: event.tool.status ?? null, success: event.tool.success ?? null };
      const error = event.tool.error;
      const diagnostic = redactDiagnostic(typeof error === "string" ? error : JSON.stringify(error || ""), [...handle.registeredSecrets, ...credentialStrings]);
      value.errorCodes = [...new Set(diagnostic.match(/\b[A-Z][A-Z0-9_]{3,95}\b/gu) || [])].slice(0, 8);
      if (error) value.errorMessage = diagnostic.slice(0, 500).toWellFormed();
      result.runtimeEvents.push(value);
    });
    const rpc = handle.host.rpc, response = rpc._handleResponse.bind(rpc);
    rpc._handleResponse = message => {
      if (message?.error && rpc.pending.get(message.id)?.method === "thread/start") {
        const diagnostic = redactDiagnostic(message.error.message, [...handle.registeredSecrets, ...credentialStrings]);
        result.runtimeEvidence.nativeFailure = { rpcCode: message.error.code,
          message: diagnostic.slice(0, 500).toWellFormed() };
      }
      return response(message);
    };
    const accountRead = handle.accountRead.bind(handle);
    observed.accountRead = async params => {
      result.runtimeEvidence.phase = "account_read";
      try {
        const value = await accountRead(params);
        result.runtimeEvidence.authenticationMetadata = { accountPresent: value?.account !== null,
          requiresOpenaiAuthType: typeof value?.requiresOpenaiAuth,
          ...(typeof value?.requiresOpenaiAuth === "boolean" ? { requiresOpenaiAuth: value.requiresOpenaiAuth } : {}) };
        return value;
      } catch (error) { result.runtimeEvidence.errorCodes = errorCodes(error); throw error; }
    };
    const verify = handle.verifyProactiveReview.bind(observed);
    const features = handle._proactiveFeatures.bind(observed);
    observed._proactiveFeatures = async threadId => {
      const values = await features(threadId);
      result.runtimeEvidence.enabledFeatures = values.filter(value => value.enabled).map(value => value.name);
      return values;
    };
    const config = handle._proactiveReviewConfig.bind(observed);
    observed._proactiveReviewConfig = async () => {
      result.runtimeEvidence.phase = "review_config";
      const value = await config(); result.runtimeEvidence.phase = "thread_start"; return value;
    };
    const isolation = handle.assertProactiveReviewIsolation.bind(observed);
    observed.assertProactiveReviewIsolation = async (response, options) => {
      result.runtimeEvidence.phase = "isolation";
      result.runtimeEvidence.readOnly = response?.sandbox?.type === "readOnly";
      result.runtimeEvidence.networkDisabled = response?.sandbox?.networkAccess === false;
      result.runtimeEvidence.bindingElicitationEnabled = response?.approvalPolicy === "on-request";
      const inventory = await handle.host.mcpServerStatusList({ threadId: response?.thread?.id, cursor: null, limit: 100, detail: "toolsAndAuthOnly" });
      result.runtimeEvidence.responseToolInventory = inventory.data.map(server => ({ name: server.name,
        tools: Object.values(server.tools || {}).map(tool => ({ name: tool.name,
          readOnlyHint: tool.annotations?.readOnlyHint === true })).slice(0, 32) }));
      const responseTools = inventory.data.flatMap(server => Object.values(server.tools || {})).filter(tool => tool.name === "proactive_respond");
      assert.equal(responseTools.length, 1, "Acceptance needs the sole production response tool");
      assert.equal(responseTools[0].annotations?.readOnlyHint, true, "Response tool must retain production read-only metadata before starting a model turn");
      return isolation(response, options);
    };
    observed.verifyProactiveReview = async () => {
      try { const proof = await verify(); result.runtimeEvidence.phase = "verified"; return proof; }
      catch (error) { result.runtimeEvidence.errorCodes = errorCodes(error); throw error; }
    };
    const turnStart = handle.turnStart.bind(observed);
    observed.turnStart = async params => {
      assert.equal(metadataOnly, false, "Metadata acceptance cannot start a model turn");
      assert.equal(result.nativeTurnRequests, 0, "Only one additional real model turn is authorized");
      result.nativeTurnRequests++;
      return turnStart(params);
    };
    return observed;
  };
  const ipc = (method, params) => requestService(paths, { id: crypto.randomUUID(), token: readClientToken(paths), version: PROTOCOL_VERSION, method, params });
  try {
    await service.start(); stage("verify_readonly");
    const capability = await ipc("proactive.runtime.verify", { profileId: DEFAULT_AGENT_PROFILE_ID }); assert.equal(capability.capabilities.semanticVerified, true);
    if (metadataOnly) {
      assert.equal(result.nativeTurnRequests, 0);
      assert.equal(service.workDispatcher.listRuns({ source: "proactive" }).length, 0);
      assert.equal(submissions.length, 0);
      result.responseToolVerified = true; result.verified = true;
      stage("metadata_only_completed"); return;
    }
    stage("automatic_tick");
    const snapshot = await ipc("proactive.monitor.get", { kind: "heartbeat", profileId: DEFAULT_AGENT_PROFILE_ID });
    const config = { ...snapshot.monitor.config, enabled: true, activeHours: null,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() }, budget: { maxRunsPerDay: 1, maxTokensPerDay: 20_000 },
      checklist: [{ id: "local-acceptance", enabled: true, mode: "review", instruction: "This isolated acceptance check is due and requires my review. Return notice for this supplied checklist candidate using proactive_respond, with its exact evidenceVersion. Use body: Please review the isolated proactive acceptance result. If the tool is deferred, use tool_search only to discover shoggoth proactive_respond. No other product tools or actions are authorized." }] };
    await ipc("proactive.monitor.set", { operationId: crypto.randomUUID(), expectedRevision: snapshot.monitor.revision, config });
    const end = Date.now() + 240_000;
    while (Date.now() < end) {
      const check = service.proactiveStore.history(config.id, null, 1)[0];
      if (check && ["published", "failed", "needs_verification", "silent", "skipped"].includes(check.state)) {
        result.check = { state: check.state, reason: check.reason, responseOutcome: check.response?.outcome || null };
        const run = check.runId ? service.workDispatcher.getRun(check.runId) : null;
        result.run = run ? { source: run.source, status: run.status, errorCode: run.errorCode, runtime: run.runtimeSessionRef?.runtime } : null;
        assert.equal(check.state, "published", `Check did not publish: ${check.reason}`);
        const notice = service.proactiveStore.noticeForOccurrence(check.id); assert.equal(notice.appState, "published");
        assert.equal(notice.systemState, "submitted"); assert.equal(submissions.length, 1);
        assert.equal(service.workDispatcher.listRuns({ source: "proactive" }).length, 1);
        result.notice = { appState: notice.appState, systemState: notice.systemState, items: notice.items.length };
        result.usage = service.tokenUsageStore.list({ profileId: DEFAULT_AGENT_PROFILE_ID }).filter(record => record.source === 'proactive')
          .map(({ totalTokens, model }) => ({ totalTokens, model }));
        assert.ok(result.usage.some(record => record.totalTokens > 0), "Actual Provider usage must be recorded");
        stage("restart"); await service.stop({ notify: false }); await service.start(); await service.proactiveScheduler.waitForIdle();
        assert.equal(submissions.length, 1); assert.equal(service.workDispatcher.listRuns({ source: "proactive" }).length, 1);
        result.verified = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(result.verified, true, "Automatic real Runtime review did not complete in the bounded observation window");
  } catch (error) { result.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : "LIVE_ACCEPTANCE_FAILED"; result.errorCodes = errorCodes(error); process.exitCode = 1; }
  finally {
    try {
      const runs = service.workDispatcher.listRuns({ source: "proactive" });
      result.modelRuns = runs.length;
      result.runs = runs.map(run => ({ id: run.id, status: run.status, errorCode: run.errorCode,
        sessionId: run.runtimeSessionRef?.sessionId || null, turnId: run.runtimeTurnRef?.turnId || null }));
      result.productToolCalls = service.productStore.listMcpToolCalls({ profileId: DEFAULT_AGENT_PROFILE_ID })
        .map(call => ({ name: call.name, status: call.status, errorCode: call.errorCode ?? null }));
      result.usage = service.tokenUsageStore.list({ profileId: DEFAULT_AGENT_PROFILE_ID })
        .filter(record => record.source === "proactive").map(({ totalTokens, model }) => ({ totalTokens, model }));
    } catch {}
    try { await service.stop({ notify: false }); result.serviceStopped = true; } catch (error) { result.stopErrorCode = error.code || "SERVICE_STOP_FAILED"; result.stopErrorCodes = errorCodes(error); result.verified = false; process.exitCode = 1; }
    key.fill(0); fs.rmSync(root, { recursive: true }); result.temporaryCredentialsRemoved = true;
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, output }));
  }
}
main().catch(error => { console.error(error.code || "LIVE_FIXTURE_FAILED"); process.exitCode = 1; });
