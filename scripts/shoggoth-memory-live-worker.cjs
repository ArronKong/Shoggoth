"use strict";

// Runs only with a disposable HOME prepared by shoggoth-memory-live-acceptance.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");

const TERMINAL = new Set(["completed", "failed", "interrupted", "canceled", "skipped"]);
function failure(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) {
  return /^[A-Z][A-Z0-9_]{0,100}$/u.test(error?.code || "") ? error.code : "MEMORY_LIVE_FAILED";
}
function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "MEMORY_LIVE_TIMEOUT" })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function toolNames(service, profileId, sessionId, runId) {
  return service.transcriptStore.listEvents(profileId, sessionId)
    .filter((event) => event.runId === runId && event.kind === "tool_call")
    .map((event) => event.content?.tool?.name || event.content?.toolName || "unknown");
}
function requiredTool(tools, name) {
  if (!tools.some((tool) => tool === name || tool.endsWith(`__${name}`) || tool.endsWith(`/${name}`))) {
    throw Object.assign(failure("MEMORY_LIVE_REQUIRED_TOOL_MISSING"), { requiredTool: name });
  }
}
function assertInspirationChatOrigin(service, { profileId, workspace, ideaId, sessionKey, run, prompt }) {
  const session = service.chatSessionStore.getSession(sessionKey);
  const execution = run && service.inspirationStore.executionForRun(run.id);
  if (!session || session.profileId !== profileId || session.workspace !== workspace
    || run?.source !== "inspiration" || run.sourceId !== ideaId
    || run.profileId !== profileId || run.workspace !== workspace
    || execution?.runId !== run.id || execution.ideaId !== ideaId
    || execution.profileId !== profileId || execution.workspace !== workspace
    || execution.sessionKey !== sessionKey || execution.inputSource !== "chat") {
    throw failure("MEMORY_LIVE_INSPIRATION_ORIGIN_INVALID");
  }
  const userEvent = service.transcriptStore.listEvents(profileId, session.id)
    .find((event) => event.runId === run.id && event.kind === "user"
      && !event.contextExcluded && event.content?.text === prompt);
  if (!userEvent) throw failure("MEMORY_LIVE_INSPIRATION_USER_EVENT_MISSING");
  return { session, userEvent };
}
function configureService(service, workspaceRoot) {
  const base = { ...service.productStore.listAgentProfiles()[0] };
  for (const field of ["defaultBindingId", "bindingsRevision", "selectedBindingId"]) delete base[field];
  const id = crypto.randomUUID();
  const profile = service.productStore.putAgentProfile({ ...base, id, backendId: "shoggoth",
    agentId: `memory-live-${id}`, name: "Isolated memory acceptance", runtime: "codex",
    runtimeProfileId: `memory-live-${id}`, runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    providerRef: null, defaultModel: null, defaultCwd: workspaceRoot,
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "read-only" },
    concurrency: { maxActive: 2, maxWorkspaceWrites: 0 }, enabled: true, isDefault: false });
  const current = service.nativeRuntimeConfig.read();
  service.nativeRuntimeConfig.apply({ ...current, revision: current.revision + 1,
    flags: { ...current.flags, runtimeAdmissionV1: true, runtimeContextLifecycleV1: true } });
  service.agentDefinitionStore.ensureProfile({ profileId: profile.id, profileName: profile.name });
  service.memoryStore.ensureProfile(profile.id);
  service.memoryEngine.rebuildViews(profile.id);
  service.nativeSkillStore.ensureProfile(profile.id);
  return profile;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const root = fs.realpathSync(config.root);
  if (!root.startsWith("/private/tmp/sgmemlive-") && !root.startsWith("/tmp/sgmemlive-")) {
    throw new Error("MEMORY_LIVE_ROOT_INVALID");
  }
  if (fs.realpathSync(process.env.HOME) !== root || process.env.CODEX_HOME !== path.join(root, ".codex")) {
    throw new Error("MEMORY_LIVE_ENV_INVALID");
  }
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(root, "mcp-key.bin"), key, { flag: "wx", mode: 0o600 });
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    } };
  const helperCommand = path.join(root, "mcp-helper-launch");
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(helperCommand, "#!/bin/sh\nexec " + shellQuote(process.execPath)
    + ' "$@" 2>' + shellQuote(path.join(root, "mcp-launch-stderr.log")) + "\n", { mode: 0o700 });
  const service = createAgentService({ paths, parentEnv: { ...process.env }, runtimeStorageHomedir: root,
    version: "isolated-memory-live-acceptance", safeStorage,
    // The production issuer now fixes a bootstrap entry instead of using
    // argsPrefix. This source fixture must explicitly select its disposable
    // crypto helper; the installed bootstrap has a separate acceptance gate.
    runtimeMcpGateIssuer: new RuntimeMcpGateIssuer({ paths,
      mcpHelperLaunch: { command: helperCommand, argsPrefix: [] },
      bootstrapPath: path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs") }),
    mcpHelperLaunch: { command: helperCommand,
      argsPrefix: [path.join(__dirname, "shoggoth-memory-live-mcp-helper.cjs")] } });
  const result = { evidence: "isolated-source-service-real-codex-provider", status: "failed",
    stage: "start", p1: { status: "not_run" }, p1Inspiration: { status: "not_run" },
    p3: { status: "not_run" }, serviceStopped: false };
  // Preserve redacted startup evidence inside this disposable fixture. The
  // production RPC intentionally drops remote error text before exposing it.
  const { redactDiagnostic } = require("../app/agent-service/codex-rpc-safety");
  const auth = JSON.parse(fs.readFileSync(path.join(root, ".codex", "auth.json"), "utf8"));
  const authSecrets = Object.values(auth.tokens || {}).concat(auth.OPENAI_API_KEY || [])
    .filter(value => typeof value === "string" && value.length >= 8);
  const hostFactory = service.runtimePool.hostFactory;
  service.runtimePool.hostFactory = options => {
    const host = hostFactory(options), initialize = host.initialize.bind(host);
    const register = host.registerServerRequestHandler.bind(host);
    host.registerServerRequestHandler = (method, handler) => register(method, async (params, context) => {
      const binding = params?._meta?.["shoggoth/runtime-call-binding"];
      try {
        const response = await handler(params, context);
        if (binding) (result.runtimeCallBindings ||= []).push({ name:binding.name,action:response?.action??null });
        return response;
      } catch(error) {
        if(binding) (result.runtimeCallBindings ||= []).push({name:binding.name,errorCode:error.code});
        throw error;
      }
    });
    host.initialize = async (...args) => {
      const value = await initialize(...args), rpc = host.rpc;
      const response = rpc._handleResponse.bind(rpc);
      rpc._handleResponse = message => {
        if (message?.error && ["thread/start", "thread/resume"].includes(rpc.pending.get(message.id)?.method)) {
          (result.runtimeDiagnostics ||= []).push(redactDiagnostic(message.error.message,
            authSecrets.concat(host.registeredSecrets)).slice(0, 2048));
        }
        return response(message);
      };
      return value;
    };
    return host;
  };
  let started = false;
  try {
    await service.start(); started = true;
    result.stage = "configure";
    const workspaceRoot = path.join(root, "workspaces");
    const profile = configureService(service, workspaceRoot);
    const profileId = profile.id;
    let testModel = config.model;
    if (config.suite === "p4" && testModel === "auto") {
      const catalog = await service.profileServiceController.handle("profile.models.list", {
        profileId, cursor: null, limit: 100,
      });
      const selected = catalog.models.find(model=>model.isDefault) || catalog.models[0];
      if (!selected) throw failure("MEMORY_LIVE_MODEL_CATALOG_EMPTY");
      testModel = selected.id;
      result.model = testModel;
    }
    const workspace = path.join(workspaceRoot, "memory");
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const token = readClientToken(paths);
    const productCall = (method, params) => requestService(paths, {
      id: crypto.randomUUID(), token, version: PROTOCOL_VERSION, method, params,
    }, { timeoutMs: 20_000 });
    let sessionOrdinal = 0;
    const createSession = () => {
      const session = service.chatSessionStore.createSession({ profileId, workspace,
        operationId: `memory-live-session-${++sessionOrdinal}`, createdAt: Date.now() });
      return config.suite === "p4" ? service.chatSessionStore.setModelOverride(session.sessionKey, testModel) : session;
    };
    let sendOrdinal = 0;
    const send = async (session, prompt, stage) => {
      result.stage = stage;
      process.stdout.write(`MEMORY_LIVE_STAGE ${stage}\n`);
      const ack = await service.workRunCoordinator.send({ sessionKey: session.sessionKey,
        operationId: `memory-live-send-${++sendOrdinal}`, prompt });
      const run = await bounded(service.workRunCoordinator.waitForTerminal(ack.run.id), 90_000);
      await bounded(service.workRunCoordinator.waitForIdle(ack.run.id), 20_000);
      if (!TERMINAL.has(run.status) || run.status !== "completed") {
        result.runtimeDiagnosticCodes = [...service.runtimePool.entries.values()].flatMap(entry => {
          let text = "";
          try { text = entry.host?.rpc?.stderrDiagnostic?.() || ""; } catch {}
          return text.match(/\b(?:BOOTSTRAP_[A-Z0-9_]+|MCP_HELPER_[A-Z0-9_]+)\b/gu) || [];
        });
        throw Object.assign(new Error("run failed"), { code: run.errorCode || "MEMORY_LIVE_RUN_FAILED" });
      }
      const answers = service.transcriptStore.listEvents(profileId, session.id)
        .filter((event) => event.runId === run.id && event.kind === "assistant"
          && typeof event.content?.text === "string")
        .map((event) => event.content.text);
      const tools = toolNames(service, profileId, session.id, run.id);
      if (config.suite === "p4") (result.turnEvidence ||= []).push({ stage, tools,
        answers: answers.map(text=>redactDiagnostic(text,authSecrets).slice(0,4096)),
        activeSyntheticMemories: service.memoryStore.list(profileId,{status:"active"})
          .map(item=>({id:item.id,content:item.content})) });
      return { run, tools, answers };
    };
    if (config.suite === "p4") {
      result.p4 = await require("./shoggoth-memory-e5-live-steps.cjs").run({
        service, profileId, workspace, createSession, send, result,
      });
      result.status = result.p4.status;
      return;
    }
    const marker = `SGMEM${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    try {
      const first = createSession();
      const saved = await send(first, `我喜欢代号 ${marker} 的蓝色番茄计划。请调用 memory_save 保存这条明确偏好，`
        + `content 使用“用户偏好代号 ${marker} 的蓝色番茄计划”，sourceQuote 使用“我喜欢代号 ${marker} 的蓝色番茄计划”。`, "p1-save");
      requiredTool(saved.tools, "memory_save");
      const original = service.memoryStore.list(profileId, { status: "active" })
        .find((item) => item.content.includes(marker));
      if (!original) throw Object.assign(new Error("not saved"), { code: "MEMORY_LIVE_SAVE_MISSING" });
      const second = createSession();
      const searched = await send(second, `请调用 conversation_search，在 sessionId ${first.id} 中查找上一会话我说的“蓝色番茄计划”原话，`
        + "然后回答其中的确切代号。", "p1-search-original");
      requiredTool(searched.tools, "conversation_search");
      let direct = service.conversationRecallService.search({ profileId,
        args: { source: "chat", sourceId: second.sessionKey, sessionId: first.id,
          query: "蓝色番茄", limit: 10 }, run: searched.run });
      if (direct.status === "rebuilding") {
        await bounded(service.conversationRecallService.whenIndexReady(profileId), 20_000);
        direct = service.conversationRecallService.search({ profileId,
          args: { source: "chat", sourceId: second.sessionKey, sessionId: first.id,
            query: "蓝色番茄", limit: 10 }, run: searched.run });
      }
      if (direct.status !== "ready") throw failure("MEMORY_LIVE_SEARCH_UNREADY");
      const originalVisible = direct.results.some((entry) => entry.snippet.includes(marker));
      if (!originalVisible || !searched.answers.join("").includes(marker)) {
        throw Object.assign(new Error("original not found"), { code: "MEMORY_LIVE_ORIGINAL_NOT_FOUND" });
      }
      const corrected = await send(second, `我现在偏好代号 ${marker} 的绿色番茄计划，旧的蓝色计划不再有效。`
        + "请用 memory_search 找到旧记忆，调用 memory_save 并用 supersedes 更正它。", "p1-correct");
      requiredTool(corrected.tools, "memory_search");
      requiredTool(corrected.tools, "memory_save");
      const afterCorrection = service.memoryStore.list(profileId);
      const current = afterCorrection.find((item) => item.status === "active"
        && item.content.includes(marker) && item.content.includes("绿色"));
      if (!current || current.supersedes !== original.id) {
        throw Object.assign(new Error("correction missing"), { code: "MEMORY_LIVE_CORRECTION_MISSING" });
      }
      const forgotten = await send(second, `请忘记我刚才的代号 ${marker} 绿色番茄计划。`
        + "请用 memory_search 找到这条新记忆，调用 memory_forget 撤回它。", "p1-forget");
      requiredTool(forgotten.tools, "memory_search");
      requiredTool(forgotten.tools, "memory_forget");
      const afterForget = service.memoryStore.list(profileId);
      if (afterForget.some((item) => item.content.includes(marker) && item.status === "active")) {
        throw Object.assign(new Error("forget missing"), { code: "MEMORY_LIVE_FORGET_MISSING" });
      }
      const third = createSession();
      const again = await send(third, `请调用 conversation_search，仅在 sessionId ${first.id} 中再搜索“蓝色番茄计划”原话，`
        + "如果找不到只回答“找不到”。", "p1-search-after-forget");
      requiredTool(again.tools, "conversation_search");
      let after = service.conversationRecallService.search({ profileId,
        args: { source: "chat", sourceId: third.sessionKey, sessionId: first.id,
          query: "蓝色番茄", limit: 10 }, run: again.run });
      if (after.status === "rebuilding") {
        await bounded(service.conversationRecallService.whenIndexReady(profileId), 20_000);
        after = service.conversationRecallService.search({ profileId,
          args: { source: "chat", sourceId: third.sessionKey, sessionId: first.id,
            query: "蓝色番茄", limit: 10 }, run: again.run });
      }
      if (after.status !== "ready") throw failure("MEMORY_LIVE_SEARCH_UNREADY");
      const afterForgetAnswer = again.answers.join("");
      const afterForgetVisible = after.results.some((entry) => entry.sessionId === first.id);
      result.p1 = { status: afterForgetVisible || afterForgetAnswer.includes(marker)
        || !afterForgetAnswer.includes("找不到") ? "failed" : "passed",
        originalVisible, afterForgetVisible,
        toolCalls: { save: saved.tools, search: searched.tools, correct: corrected.tools,
          forget: forgotten.tools, afterForget: again.tools } };
    } catch (error) { result.p1 = { status: "failed", stage: result.stage,
      errorCode: safeCode(error), requiredTool: error?.requiredTool ?? null }; }

    // A card's autonomous run cannot use direct-user memory tools. Start each
    // real Inspiration session through the product entry, then use chat.send to
    // create a direct chat-origin Inspiration run for every memory operation.
    let inspirationOrdinal = 0;
    const startInspirationSession = async (label) => {
      const stage = `p1-inspiration-bootstrap-${label}`;
      result.stage = stage;
      process.stdout.write(`MEMORY_LIVE_STAGE ${stage}\n`);
      const sequence = ++inspirationOrdinal;
      const { idea } = await productCall("inspiration.create", {
        operationId: `memory-live-inspiration-create-${sequence}`,
        body: "隔离记忆验收会话。请只回复“已准备”。",
      });
      if (!idea?.id || !Number.isSafeInteger(idea.revision)) {
        throw failure("MEMORY_LIVE_INSPIRATION_CREATE_INVALID");
      }
      const started = await productCall("inspiration.start", {
        id: idea.id, operationId: `memory-live-inspiration-start-${sequence}`,
        expectedRevision: idea.revision, agentId: profile.agentId,
        backendId: profile.backendId, instruction: "请只回复“已准备”。", workspace,
      });
      const execution = started.idea?.latestExecution;
      if (!execution?.runId || !execution.sessionKey || execution.ideaId !== idea.id
        || execution.profileId !== profileId || execution.workspace !== workspace) {
        throw failure("MEMORY_LIVE_INSPIRATION_START_INVALID");
      }
      const run = await bounded(service.workRunCoordinator.waitForTerminal(execution.runId), 90_000);
      await bounded(service.workRunCoordinator.waitForIdle(execution.runId), 20_000);
      const stored = service.inspirationStore.executionForRun(execution.runId);
      const session = service.chatSessionStore.getSession(execution.sessionKey);
      if (run.status !== "completed" || run.source !== "inspiration"
        || run.sourceId !== idea.id || run.profileId !== profileId || run.workspace !== workspace
        || stored?.sessionKey !== execution.sessionKey || stored.inputSource === "chat"
        || session?.profileId !== profileId || session.workspace !== workspace
        || session.status !== "ready") {
        throw failure(run.errorCode || "MEMORY_LIVE_INSPIRATION_BOOTSTRAP_FAILED");
      }
      return { ideaId: idea.id, session, bootstrapRunId: run.id };
    };
    let inspirationSendOrdinal = 0;
    const sendInspiration = async (origin, prompt, stage) => {
      result.stage = stage;
      process.stdout.write(`MEMORY_LIVE_STAGE ${stage}\n`);
      const ack = await productCall("chat.send", {
        sessionKey: origin.session.sessionKey,
        operationId: `memory-live-inspiration-send-${++inspirationSendOrdinal}`,
        prompt, createdAt: Date.now(),
      });
      if (!ack?.run?.id) throw failure("MEMORY_LIVE_INSPIRATION_SEND_INVALID");
      const run = await bounded(service.workRunCoordinator.waitForTerminal(ack.run.id), 90_000);
      await bounded(service.workRunCoordinator.waitForIdle(ack.run.id), 20_000);
      if (run.status !== "completed") throw failure(run.errorCode || "MEMORY_LIVE_RUN_FAILED");
      const binding = assertInspirationChatOrigin(service, { profileId, workspace,
        ideaId: origin.ideaId, sessionKey: origin.session.sessionKey, run, prompt });
      const tools = toolNames(service, profileId, binding.session.id, run.id);
      const answers = service.transcriptStore.listEvents(profileId, binding.session.id)
        .filter((event) => event.runId === run.id && event.kind === "assistant"
          && typeof event.content?.text === "string")
        .map((event) => event.content.text);
      return { run, tools, answers, userEventId: binding.userEvent.id };
    };
    const readyInspirationSearch = async (run, sessionId, query) => {
      const input = { profileId, args: {
        source: "inspiration", sourceId: run.sourceId, sessionId, query, limit: 10,
      }, run };
      let value = service.conversationRecallService.search(input);
      if (value.status === "rebuilding") {
        await bounded(service.conversationRecallService.whenIndexReady(profileId), 20_000);
        value = service.conversationRecallService.search(input);
      }
      if (value.status !== "ready") throw failure("MEMORY_LIVE_INSPIRATION_SEARCH_UNREADY");
      return value;
    };
    try {
      const inspirationMarker = `SGINSP${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const first = await startInspirationSession("save");
      const saved = await sendInspiration(first,
        `我喜欢代号 ${inspirationMarker} 的蓝色番茄计划。请调用 memory_save 保存这条明确偏好，`
        + `content 使用“用户偏好代号 ${inspirationMarker} 的蓝色番茄计划”，`
        + `sourceQuote 使用“我喜欢代号 ${inspirationMarker} 的蓝色番茄计划”。`,
        "p1-inspiration-save");
      requiredTool(saved.tools, "memory_save");
      const original = service.memoryStore.list(profileId, { status: "active" })
        .find((item) => item.content.includes(inspirationMarker) && item.content.includes("蓝色"));
      if (!original?.sourceRefs.includes(saved.userEventId)) {
        throw failure("MEMORY_LIVE_INSPIRATION_SAVE_MISSING");
      }
      const second = await startInspirationSession("search");
      if (second.session.id === first.session.id) throw failure("MEMORY_LIVE_INSPIRATION_SESSION_REUSED");
      const searched = await sendInspiration(second,
        `请调用 conversation_search，在 sessionId ${first.session.id} 中查找我说的“蓝色番茄计划”原话，`
        + "然后回答其中的确切代号。", "p1-inspiration-search-original");
      requiredTool(searched.tools, "conversation_search");
      const originalSearch = await readyInspirationSearch(searched.run, first.session.id, "蓝色番茄");
      const originalVisible = originalSearch.results.some((entry) => entry.sessionId === first.session.id
        && entry.eventId === saved.userEventId && entry.kind === "user"
        && entry.snippet.includes(inspirationMarker));
      if (!originalVisible || !searched.answers.join("").includes(inspirationMarker)) {
        throw failure("MEMORY_LIVE_INSPIRATION_ORIGINAL_NOT_FOUND");
      }
      const corrected = await sendInspiration(second,
        `我现在偏好代号 ${inspirationMarker} 的绿色番茄计划，旧的蓝色计划不再有效。`
        + "请先用 memory_search 找到旧记忆，再调用 memory_save 并用 supersedes 更正它。"
        + `新 content 使用“用户偏好代号 ${inspirationMarker} 的绿色番茄计划”，`
        + `sourceQuote 使用“我现在偏好代号 ${inspirationMarker} 的绿色番茄计划”。`,
        "p1-inspiration-correct");
      requiredTool(corrected.tools, "memory_search");
      requiredTool(corrected.tools, "memory_save");
      const current = service.memoryStore.list(profileId).find((item) => item.status === "active"
        && item.content.includes(inspirationMarker) && item.content.includes("绿色"));
      if (!current || current.supersedes !== original.id
        || !current.sourceRefs.includes(corrected.userEventId)) {
        throw failure("MEMORY_LIVE_INSPIRATION_CORRECTION_MISSING");
      }
      const forgotten = await sendInspiration(second,
        "请忘记刚才保存的绿色番茄偏好新版本。先用 memory_search 找出它，"
        + "再调用 memory_forget 撤回，并以“请忘记刚才保存的绿色番茄偏好新版本”作为 sourceQuote。",
        "p1-inspiration-forget");
      requiredTool(forgotten.tools, "memory_search");
      requiredTool(forgotten.tools, "memory_forget");
      const afterForget = service.memoryStore.list(profileId);
      if (afterForget.some((item) => item.content.includes(inspirationMarker)
        && item.status === "active")
        || afterForget.find((item) => item.id === current.id)?.status !== "deleted") {
        throw failure("MEMORY_LIVE_INSPIRATION_FORGET_MISSING");
      }
      const third = await startInspirationSession("after-forget");
      if ([first.session.id, second.session.id].includes(third.session.id)) {
        throw failure("MEMORY_LIVE_INSPIRATION_SESSION_REUSED");
      }
      const again = await sendInspiration(third,
        `请调用 conversation_search，仅在 sessionId ${first.session.id} 中搜索“蓝色番茄”原话。`
        + "如果找不到，只回答“找不到”。", "p1-inspiration-search-after-forget");
      requiredTool(again.tools, "conversation_search");
      const after = await readyInspirationSearch(again.run, first.session.id, "蓝色番茄");
      const afterForgetVisible = after.results.length > 0;
      const finalAnswer = again.answers.join("");
      if (afterForgetVisible || finalAnswer.includes(inspirationMarker)
        || !finalAnswer.includes("找不到")) {
        throw failure("MEMORY_LIVE_INSPIRATION_FORGOTTEN_SOURCE_VISIBLE");
      }
      result.p1Inspiration = { status: "passed", directChatOriginRuns: 5,
        distinctSessions: 3, originalVisible, afterForgetVisible,
        toolCalls: { save: saved.tools, search: searched.tools, correct: corrected.tools,
          forget: forgotten.tools, afterForget: again.tools } };
    } catch (error) {
      result.p1Inspiration = { status: "failed", stage: result.stage,
        errorCode: safeCode(error), requiredTool: error?.requiredTool ?? null };
    }

    try {
      const candidateSession = createSession();
      const before = service.memoryStore.list(profileId, { status: "active" }).length;
      const turn = await send(candidateSession,
        `我每周五下午都会复盘本地测试项目 ${marker}。这次只回复收到，不要调用工具。`, "p3-seed");
      result.stage = "p3-extract";
      process.stdout.write("MEMORY_LIVE_STAGE p3-extract\n");
      const extracted = await bounded(service.memoryCandidateService.processSession({ profileId,
        sessionId: candidateSession.id, maxBatches: 1 }), 45_000);
      const pending = service.memoryCandidateService.list({ profileId, status: "pending" }).items;
      const activeAfter = service.memoryStore.list(profileId, { status: "active" }).length;
      result.p3 = { status: extracted.modelCalls > 0 && activeAfter === before ? "passed" : "failed",
        modelCalls: extracted.modelCalls, pendingCount: pending.length,
        activeDelta: activeAfter - before, seedTools: turn.tools };
    } catch (error) { result.p3 = { status: "failed", stage: result.stage, errorCode: safeCode(error) }; }
    result.status = result.p1.status === "passed" && result.p1Inspiration.status === "passed"
      && result.p3.status === "passed" ? "passed" : "failed";
  } catch (error) {
    result.errorCode = safeCode(error);
    if (error?.code === "ERR_ASSERTION") result.assertionDiagnostic = redactDiagnostic(
      `${error.message}\n${error.stack || ""}`, authSecrets).slice(0, 4096);
  } finally {
    if (started) {
      try {
        await bounded(service.stop({ notify: false }), 30_000); result.serviceStopped = true;
        if (config.suite === "p4") {
          result.inferenceChildExit = service.nativeMemorySemanticService.embedding.lastExit;
          if (result.inferenceChildExit?.code !== 0 || result.inferenceChildExit?.signal !== null) {
            result.status = "failed"; result.errorCode = "MEMORY_LIVE_E5_EXIT_FAILED";
          }
        }
      }
      catch { result.errorCode = "MEMORY_LIVE_SERVICE_STOP_FAILED"; result.status = "failed"; }
    }
    key.fill(0);
    const helperErrors = path.join(root, "mcp-helper-errors.jsonl");
    if (fs.existsSync(helperErrors)) result.mcpHelperErrors = fs.readFileSync(helperErrors, "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).code);
    const launchErrors = path.join(root, "mcp-launch-stderr.log");
    if (result.status === "failed" && fs.existsSync(launchErrors)) {
      result.helperStartupDiagnostic = redactDiagnostic(fs.readFileSync(launchErrors, "utf8"),
        authSecrets).slice(-4096);
    }
    const fixtureIo = path.join(root,"mcp-fixture-io.jsonl");
    if(result.status==="failed" && fs.existsSync(fixtureIo)) result.mcpFixtureIo=fs.readFileSync(fixtureIo,"utf8")
      .trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
    fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  }
}

if (require.main === module) main().catch(() => { process.stderr.write("MEMORY_LIVE_WORKER_FAILED\n"); process.exitCode = 1; });

module.exports = { assertInspirationChatOrigin, requiredTool };
