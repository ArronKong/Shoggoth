"use strict";
// Real native Runtime requests in an explicitly disposable Service HOME.
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME } = require("../app/agent-service/runtime-account");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { readRuntimeAuthenticationState } = require("../app/agent-service/runtime-adapter");
const { isRuntimeAvailable } = require("../app/runtime-availability");
const { refsFromEvents } = require("../app/agent-service/shoggoth-memory/borrowed-memory-provenance.cjs");
const TERMINAL = new Set(["completed", "failed", "interrupted", "canceled", "skipped"]);
const code = error => /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "MEMORY_SHARING_LIVE_FAILED";
const fail = value => Object.assign(new Error(value), { code: value });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function bounded(promise, ms = 90000) { let timer; return Promise.race([promise, new Promise((_, reject) => {
  timer = setTimeout(() => reject(fail("MEMORY_SHARING_LIVE_TIMEOUT")), ms);
})]).finally(() => clearTimeout(timer)); }
function textTree(root) {
  if (!fs.existsSync(root)) return "";
  return fs.readdirSync(root, { withFileTypes: true }).map(entry => {
    const file = path.join(root, entry.name); return entry.isDirectory() ? textTree(file)
      : entry.isFile() ? fs.readFileSync(file).toString() : "";
  }).join("\n");
}
function bodyFreeErrorCodes(value, depth = 0, state = { nodes: 0, codes: new Set() }) {
  if (++state.nodes > 2048 || depth > 10) return [...state.codes];
  if (typeof value === "string" && value.length < 256 * 1024 && /^[\[{]/u.test(value.trim())) {
    try { bodyFreeErrorCodes(JSON.parse(value), depth + 1, state); } catch {}
  } else if (value && typeof value === "object") {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, "value")) continue;
      const child = descriptor.value;
      if (["code", "errorCode"].includes(key) && typeof child === "string" && /^[A-Z][A-Z0-9_]{0,100}$/u.test(child)) state.codes.add(child);
      bodyFreeErrorCodes(child, depth + 1, state);
    }
  }
  return [...state.codes].sort();
}
function databaseContains(db, marker) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().some(({ name }) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    return rows.some(row => JSON.stringify(row).includes(marker));
  });
}
function configureProfile(service, base, runtime, workspace, name) {
  const id = crypto.randomUUID(), fields = ["id", "backendId", "agentId", "name", "runtime", "runtimeProfileId", "runtimeAccountId", "providerRef", "defaultModel", "defaultCwd", "permissionPolicy", "concurrency", "isDefault", "enabled", "createdAt", "updatedAt"];
  const profile = Object.fromEntries(fields.map(key => [key, base[key]]));
  Object.assign(profile, { id, backendId: "shoggoth", agentId: `sharing-live-${id}`, name, runtime,
    runtimeProfileId: `sharing-live-${id}`, runtimeAccountId: DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME[runtime],
    providerRef: null, defaultModel: null, defaultCwd: workspace, isDefault: false, enabled: true,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: runtime === "codex" ? "read-only" : "danger-full-access" },
    concurrency: { maxActive: 1, maxWorkspaceWrites: runtime === "codex" ? 0 : 1 } });
  const saved = service.productStore.putAgentProfile(profile);
  service.agentDefinitionStore.ensureProfile({ profileId: id, profileName: name });
  service.memoryStore.ensureProfile(id); service.memoryEngine.recallPolicy.assertReady(id);
  service.nativeSkillStore.ensureProfile(id); return saved;
}
async function probeRuntimes(service, base, workspace, result, stage) {
  stage("runtime-probe");
  for (const runtime of ["claude-code", "grok-build", "antigravity", "pi", "opencode", "deepseek-harness"]) {
      const entry = { runtime, releaseEnabled: isRuntimeAvailable(runtime), status: "blocked", credentialsImportedIntoDisposableHome: false };
      result.runtimeReaders.push(entry);
      if (!entry.releaseEnabled) { entry.errorCode = "RUNTIME_RELEASE_DISABLED"; continue; }
      const profile = configureProfile(service, base, runtime, workspace, `${runtime} 隔离读取验收`);
      try {
        const nativeHost = await bounded(service.runtimeManager.acquire({ runtime, runtimeProfileId: profile.runtimeProfileId,
          runtimeAccountId: profile.runtimeAccountId }, { workspace, permissionPolicy: profile.permissionPolicy }), 20000);
        const auth = await bounded(readRuntimeAuthenticationState(nativeHost, { allowDeferred: true }), 10000);
        entry.authStatus = auth.status; entry.capabilityNames = Object.keys(nativeHost.capabilities || {}).filter(name => nativeHost.capabilities[name] === true);
        entry.errorCode = auth.status === "unauthenticated" ? "ACCOUNT_NOT_AUTHENTICATED" : "DISPOSABLE_RUNTIME_CREDENTIAL_ACCEPTANCE_NOT_COMPLETED";
        // No production auth or third-party session import is performed for
        // these adapters. An auth probe does not claim a borrowed-model turn.
      } catch (error) { entry.errorCode = code(error); }
    }
}
async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), root = fs.realpathSync(config.root);
  if (!root.startsWith("/private/tmp/sgmemlive-") || fs.realpathSync(process.env.HOME) !== root
    || process.env.CODEX_HOME !== path.join(root, ".codex")) throw fail("MEMORY_SHARING_LIVE_ENV_INVALID");
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const key = crypto.randomBytes(32); fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { mode: 0o600, flag: "wx" });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
  const helperCommand = path.join(root, "mcp-helper-launch"), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(helperCommand, "#!/bin/sh\nexec " + quote(process.execPath) + ' "$@" 2>' + quote(path.join(root, "mcp-launch-stderr.log")) + "\n", { mode: 0o700 });
  const helperPath = path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs");
  const service = createAgentService({ paths, parentEnv: { ...process.env }, runtimeStorageHomedir: root,
    version: "isolated-memory-live-acceptance", safeStorage, prewarmMcpAuth: false,
    memoryCore: true, memorySharingFeatureReady: true,
    memoryCoreConfig: { memory: { search: { provider: "none", sources: ["memory", "sessions"], rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: helperCommand, argsPrefix: [] }, bootstrapPath: helperPath }),
    mcpHelperLaunch: { command: helperCommand, argsPrefix: [helperPath] } });
  const result = { version: 1, evidence: config.mode === "probe" ? "disposable-source-service-real-native-adapter-boundary" : "disposable-source-service-real-native-provider", status: "failed", stage: "start",
    codex: { status: "not_run" }, renderer: { status: "not_run" }, runtimeReaders: [], sourceChatModelCalls: 0,
    productionMemoryOrSessionsWritten: false, thirdPartyNativeHistoryIsException: true,
    startedAt: new Date().toISOString(), serviceStopped: false };
  let started = false, source, reader, session;
  const acquire = service.runtimeManager.acquire.bind(service.runtimeManager);
  service.runtimeManager.acquire = (identity, ...args) => {
    if (source && identity.runtimeProfileId === source.runtimeProfileId) result.sourceChatModelCalls++;
    return acquire(identity, ...args);
  };
  const stage = value => { result.stage = value; process.stdout.write(`MEMORY_SHARING_LIVE_STAGE ${value}\n`); };
  try {
    await service.start(); started = true; stage("configure");
    const workspace = path.join(root, "workspaces", "sharing"); fs.mkdirSync(workspace, { mode: 0o700 });
    const base = service.productStore.listAgentProfiles()[0];
    if (config.mode === "probe") {
      await probeRuntimes(service, base, workspace, result, stage);
      result.providerModelCalls = 0; result.credentialFilesRead = false;
      result.status = "adapter-boundaries-recorded"; return;
    }
    const opencode = ["opencode-catalog", "opencode"].includes(config.mode);
    if (opencode && !isRuntimeAvailable("opencode")) throw fail("RUNTIME_RELEASE_DISABLED");
    source = configureProfile(service, base, "claude-code", workspace, "Claude 来源助理");
    reader = configureProfile(service, base, opencode ? "opencode" : "codex", workspace, opencode ? "OpenCode 读取助理" : "Codex 读取助理");
    const runtimeConfig = service.nativeRuntimeConfig.read();
    service.nativeRuntimeConfig.apply({ ...runtimeConfig, revision: runtimeConfig.revision + 1,
      flags: { ...runtimeConfig.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
    const token = readClientToken(paths);
    const productCall = (method, params) => requestService(paths, { id: crypto.randomUUID(), token, version: PROTOCOL_VERSION, method, params }, { timeoutMs: 20000 });
    await productCall("memory.sharing.config.apply", { revision: 0, config: { enabled: false, excludedProfiles: [] } });
    const marker = `SHARELIVE${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    await service.memoryEngine.propose({ profileId: source.id, scope: "agent", classification: "explicit",
      sourceRefs: ["user-edit:isolated-static-source"], content: `隔离验收的银色灯塔校准口令是 ${marker}。` });
    const sourceFile = path.join(service.memoryEngine.store.workspace(source.id), "MEMORY.md"), sourceHash = digest(fs.readFileSync(sourceFile));
    const catalog = await bounded(service.profileServiceController.handle("profile.models.list", { profileId: reader.id, cursor: null, limit: 100 }), 30000);
    let chosen;
    if (opencode) {
      stage("opencode-catalog");
      const nativeHost = await bounded(service.runtimeManager.acquire({ runtime: reader.runtime,
        runtimeProfileId: reader.runtimeProfileId, runtimeAccountId: reader.runtimeAccountId }, { workspace: null,
        permissionPolicy: reader.permissionPolicy }), 20000);
      const providers = (await bounded((nativeHost.host || nativeHost).client.request("GET", "/provider"), 20000)).data;
      const connected = new Set(providers.connected || []), free = [];
      for (const provider of providers.all || []) {
        if (!connected.has(provider.id)) continue;
        for (const [id, model] of Object.entries(provider.models || {})) {
          const costs = model.cost;
          if (model.capabilities?.toolcall !== true || !costs || costs.input !== 0 || costs.output !== 0 || (costs.cache_read ?? 0) !== 0 || (costs.cache_write ?? 0) !== 0) continue;
          const qualified = `${provider.id}/${id}`;
          if (!catalog.models.some(entry => entry.id === qualified)) continue;
          free.push({ id: qualified, toolCallingSupported: true, inputCost: costs.input, outputCost: costs.output,
            cacheReadCost: costs.cache_read ?? 0, cacheWriteCost: costs.cache_write ?? 0 });
        }
      }
      result.freeCatalog = { runtime: "opencode", currentConnectedCatalogVerified: true,
        credentialFilesRead: false, credentialsImportedIntoDisposableHome: false, freeModels: free };
      if (config.mode === "opencode-catalog") { result.providerModelCalls = 0; result.status = "free-catalog-recorded"; return; }
      chosen = config.model ? catalog.models.find(model => model.id === config.model && free.some(entry => entry.id === model.id))
        : catalog.models.find(model => free.some(entry => entry.id === model.id));
      if (!chosen) throw fail("MEMORY_SHARING_LIVE_FREE_MODEL_UNAVAILABLE");
      result.modelSelection = "current-connected-catalog-zero-cost-verified";
    } else {
      chosen = catalog.models.find(model => model.id === config.model) || catalog.models.find(model => model.isDefault) || catalog.models[0];
      result.modelSelection = chosen?.id === config.model ? "source-config-model-verified-in-live-catalog" : "live-catalog-default";
    }
    if (!chosen) throw fail("MEMORY_SHARING_LIVE_MODEL_CATALOG_EMPTY");
    result.model = chosen.id;
    session = service.chatSessionStore.createSession({ profileId: reader.id, workspace, operationId: "sharing-live-session", createdAt: Date.now() });
    session = service.chatSessionStore.setModelOverride(session.sessionKey, chosen.id);
    let ordinal = 0;
    const send = async (profile, target, prompt, name) => {
      stage(name);
      const ack = await service.workRunCoordinator.send({ sessionKey: target.sessionKey, operationId: `sharing-live-send-${++ordinal}`, prompt });
      const runtimeStages = [];
      const subscription = service.workRunCoordinator.subscribeRun(ack.run.id, { streamId: null, afterSeq: 0 }, event => {
        if (event.type === "performance.stage") runtimeStages.push({ type: event.type, stage: event.payload?.stage,
          outcome: event.payload?.outcome, durationMs: event.payload?.durationMs });
      });
      let run;
      try {
        run = await bounded(service.workRunCoordinator.waitForTerminal(ack.run.id), opencode ? 90000 : name === "codex-baseline" ? 210000 : 300000);
        await bounded(service.workRunCoordinator.waitForIdle(ack.run.id), 20000);
      } catch (error) {
        const waiting = service.workDispatcher.getRun(ack.run.id);
        const recorded = service.transcriptStore.listEvents(profile.id, target.id).filter(event => event.runId === ack.run.id);
        (result.waitDiagnostics ||= []).push({ stage: name, runStatus: waiting?.status, errorCode: waiting?.errorCode,
          runtimeSessionEstablished: Boolean(service.chatSessionStore.getSession(target.sessionKey).runtimeSessionId),
          transcriptKinds: recorded.map(event => event.kind),
          toolNames: recorded.filter(event => event.kind === "tool_call").map(event => event.content?.tool?.name || event.content?.toolName || "unknown"),
          toolResultErrorCodes: bodyFreeErrorCodes(recorded.filter(event => event.kind === "tool_result").map(event => event.content)),
          pendingRequestKinds: [...service.workRunCoordinator.pendingRequests.values()].filter(value => value.runId === ack.run.id).map(value => value.kind),
          runtimeStages,
          runtimeHostPendingRpcMethods: [...service.runtimePool.entries.values()].flatMap(entry => [...(entry.host?.rpc?.pending?.values() || [])].map(value => value.method)),
          runtimeHostStates: [...service.runtimePool.entries.values()].map(entry => ({ state: entry.host?.state || entry.state || null, closed: entry.host?.rpc?.closed === true })) });
        throw error;
      } finally { subscription.unsubscribe(); }
      const events = service.transcriptStore.listEvents(profile.id, target.id).filter(event => event.runId === run.id);
      const tools = events.filter(event => event.kind === "tool_call").map(event => event.content?.tool?.name || event.content?.toolName || "unknown");
      const answers = events.filter(event => event.kind === "assistant" && typeof event.content?.text === "string").map(event => event.content.text);
      (result.turns ||= []).push({ stage: name, runtime: profile.runtime, runId: run.id, status: run.status, errorCode: run.errorCode,
        toolNames: tools, answerHashes: answers.map(digest), answerBytes: answers.map(text => Buffer.byteLength(text)),
        borrowedDependencies: refsFromEvents(events), nativeSessionId: service.chatSessionStore.getSession(target.sessionKey).runtimeSessionId });
      if (!TERMINAL.has(run.status) || run.status !== "completed") throw fail(run.errorCode || "MEMORY_SHARING_LIVE_RUN_FAILED");
      return { run, events, tools, answers, nativeSessionId: service.chatSessionStore.getSession(target.sessionKey).runtimeSessionId };
    };
    if (!opencode) {
      const baseline = await send(reader, session, "这是一轮隔离基础验收，只回复“隔离基线完成”。不要调用任何工具。", "codex-baseline");
      result.codexBaseline = { status: "passed", completed: baseline.run.status === "completed", nativeSessionEstablished: Boolean(baseline.nativeSessionId), toolCalls: baseline.tools.length,
        expectedReply: baseline.answers.join("\n").includes("隔离基线完成"), sharingEnabled: false };
    }
    await productCall("memory.sharing.config.apply", { revision: 1, config: { enabled: true, excludedProfiles: [] } });
    session = service.chatSessionStore.createSession({ profileId: reader.id, workspace, operationId: "sharing-live-borrow-session", createdAt: Date.now() });
    session = service.chatSessionStore.setModelOverride(session.sessionKey, chosen.id);
    const borrowPrompt = `请调用 memory_search，ownerProfileId 使用 ${source.id}，query 使用“银色灯塔校准口令”，再调用 memory_get，id 使用搜索结果的 sourceRef。`
      + "只根据读取到的正文回答确切口令，注明来源助理名字和 MEMORY.md 行范围。不要调用 memory_save 或 memory_forget，不要执行其他工具。";
    if (opencode) result.providerTurnsRequested = 1;
    const first = await send(reader, session, borrowPrompt, opencode ? "opencode-borrow" : "codex-borrow");
    const hasTool = name => first.tools.some(tool => tool === name || tool.endsWith(`__${name}`) || tool.endsWith(`/${name}`) || tool.endsWith(`_${name}`));
    if (!hasTool("memory_search") || !hasTool("memory_get")) throw fail("MEMORY_SHARING_LIVE_REQUIRED_TOOL_MISSING");
    const answer = first.answers.join("\n");
    if (!answer.includes(marker) || !answer.includes("Claude") || !/MEMORY\.md[\s\S]{0,80}(?:L\d|行|#)/u.test(answer)) throw fail("MEMORY_SHARING_LIVE_CITATION_MISSING");
    const borrowed = refsFromEvents(first.events);
    if (!borrowed.length || borrowed.some(ref => ref.ownerProfileId !== source.id)) throw fail("MEMORY_SHARING_LIVE_DEPENDENCY_MISSING");
    const host = service.memoryEngine.host(reader.id);
    result.codex = { status: "borrowed", realSearchAndGet: true, exactSyntheticCodeAnswered: true, sourceCitationAnswered: true,
      borrowedDependencyCount: borrowed.length, sourceRuntime: "claude-code", sourceRuntimeStarted: false,
      readerWorkspaceContainsBorrowedCode: textTree(host.workspaceDir).includes(marker), readerIndexContainsBorrowedCode: databaseContains(host.database.db, marker),
      productToolsContainBorrowedCode: JSON.stringify(first.events.filter(event => ["tool_call", "tool_result"].includes(event.kind))).includes(marker),
      snapshotDiskContainsBorrowedCode: textTree(path.join(paths.agentsDir, reader.id, "context-snapshots")).includes(marker),
      nativeHistoryContainsBorrowedCode: textTree(path.join(root, ".codex", "sessions")).includes(marker) };
    if (result.codex.readerWorkspaceContainsBorrowedCode || result.codex.readerIndexContainsBorrowedCode
      || result.codex.productToolsContainBorrowedCode || result.codex.snapshotDiskContainsBorrowedCode) throw fail("MEMORY_SHARING_LIVE_READER_COPY_DETECTED");
    stage(opencode ? "opencode-revoke" : "codex-revoke");
    await productCall("memory.sharing.config.apply", { revision: 2, config: { enabled: true, excludedProfiles: [source.id] } });
    result.codex.dependenciesInvalidAfterRevocation = !service.memoryEngine.borrowedMemoryDependenciesCurrent(reader.id, session.id, borrowed);
    result.codex.nativeAnchorStaleAfterRevocation = service.conversationCheckpointStore.nativeSessionStale(reader.id, session.id,
      first.nativeSessionId, service.chatSessionStore.getSession(session.sessionKey).runtimeBindingId);
    if (opencode) {
      result.opencode = { ...result.codex, runtime: "opencode", status: "passed-borrow-with-revocation-fence",
        sourceFileUnchanged: sourceHash === digest(fs.readFileSync(sourceFile)), nativeSessionRebuild: "not_run_single_provider_attempt" };
      result.codex = { status: "not_run" };
      if (!result.opencode.dependenciesInvalidAfterRevocation || !result.opencode.nativeAnchorStaleAfterRevocation
        || !result.opencode.sourceFileUnchanged) throw fail("MEMORY_SHARING_LIVE_REVOCATION_UNVERIFIED");
      result.status = "passed-borrow-with-revocation-fence"; return;
    }
    const second = await send(reader, session, "来源共享已经关闭。这轮只回复“已停止借阅”。不要调用任何工具，也不要复述之前借到的口令。", "codex-refreshed");
    result.codex.nativeSessionRebuilt = first.nativeSessionId !== second.nativeSessionId;
    result.codex.retiredOldNativeSession = service.chatSessionStore.getSession(session.sessionKey).retiredRuntimeSessions.some(item => item.runtimeSessionId === first.nativeSessionId);
    result.codex.rebuiltAnswerContainsOldCode = second.answers.join("\n").includes(marker);
    result.codex.sourceFileUnchanged = sourceHash === digest(fs.readFileSync(sourceFile));
    if (!result.codex.dependenciesInvalidAfterRevocation || !result.codex.nativeAnchorStaleAfterRevocation
      || !result.codex.nativeSessionRebuilt || !result.codex.retiredOldNativeSession || result.codex.rebuiltAnswerContainsOldCode
      || !result.codex.sourceFileUnchanged) throw fail("MEMORY_SHARING_LIVE_REBUILD_UNVERIFIED");
    result.codex.status = "passed";
    stage("source-ui");
    try { result.renderer = await bounded(require("./native-memory-sharing-live-ui.cjs").render({ service, paths, root,
      reader, session: service.chatSessionStore.getSession(session.sessionKey), expectedCode: marker, electron: config.electron,
      output: config.output.replace(/\.json$/u, "-chat.png") }), 60000); }
    catch (error) { result.renderer = { status: "failed", errorCode: code(error) }; }
    await probeRuntimes(service, base, workspace, result, stage);
    result.status = result.codex.status === "passed" && result.renderer.status === "passed" ? "passed-with-runtime-blockers" : "failed";
  } catch (error) { result.errorCode = code(error); }
  finally {
    if (started) {
      try { await bounded(service.stop({ notify: false }), 30000); result.serviceStopped = true; }
      catch (error) { result.stopErrorCode = code(error); result.status = "failed"; }
    }
    for (const [file, field] of [["mcp-helper-errors.jsonl", "mcpHelperErrors"], ["mcp-fixture-io.jsonl", "mcpFixtureIo"]]) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) result[field] = fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    }
    key.fill(0); result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  }
}
if (require.main === module) main().catch(error => { process.stderr.write(`${code(error)}\n`); process.exitCode = 1; });
module.exports = { configureProfile, databaseContains, textTree, bodyFreeErrorCodes };
