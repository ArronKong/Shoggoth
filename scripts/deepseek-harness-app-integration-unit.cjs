#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { createAgentService } = require(path.join(ROOT, "app", "agent-service", "server.js"));
const { resolveServicePaths } = require(path.join(ROOT, "app", "agent-service", "paths.js"));
const { BUILTIN_CLI_AGENT_PROFILES } = require(path.join(
  ROOT, "app", "agent-service", "builtin-cli-profiles.js",
));
const { NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));
const { requestService } = require(path.join(ROOT, "app", "agent-service", "client.js"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(
  ROOT, "app", "agent-service", "service-protocol-version.js",
));
const { ShoggothBackend } = require(path.join(ROOT, "app", "core", "shoggoth-backend.js"));
const {
  DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY,
} = require(path.join(ROOT, "app", "agent-service", "deepseek-harness-runtime-paths.js"));

const DSH_MODEL = "deepseek-official/deepseek-v4-flash";
const DSH_PERMISSION = DEFAULT_DEEPSEEK_HARNESS_PERMISSION_POLICY;
const USAGE = Object.freeze({
  totalTokens: 30,
  inputTokens: 20,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  outputTokens: 10,
  reasoningOutputTokens: 3,
});

function fakeDeepSeekHarnessPool() {
  const acquisitions = [];
  const hosts = new Map();
  let sessionSequence = 0;
  let turnSequence = 0;
  let nextTurnErrorCode = null;

  function createHost(runtimeProfileId, workspace, controlInstance) {
    const listeners = new Set();
    const sessions = [];
    const calls = { sessionStart: [], turnStart: [] };
    const projectSession = (session, includeTurns = false) => ({
      id: session.id,
      source: session.source,
      cwd: session.cwd,
      name: session.name,
      archived: session.archived,
      ...(includeTurns ? { turns: structuredClone(session.turns) } : {}),
    });
    const publish = (event) => {
      for (const listener of [...listeners]) listener(Object.freeze(event));
    };
    return {
      runtimeProfileId,
      workspace,
      controlInstance,
      terminated: new Promise(() => {}),
      registeredSecrets: [],
      calls,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      registerServerRequestHandler() { return () => {}; },
      authenticationState() {
        return Promise.resolve({ authenticated: true, credentialPresent: true });
      },
      modelsList() {
        return Promise.resolve({
          data: [{
            model: DSH_MODEL,
            displayName: "GPT DeepSeek Harness Test",
            description: "DeepSeek Harness multi-provider fixture",
            isDefault: true,
            hidden: false,
          }],
          nextCursor: null,
        });
      },
      sessionList(input = {}) {
        return Promise.resolve({
          data: sessions.filter((session) => session.archived === (input.archived === true))
            .map((session) => projectSession(session)),
          nextCursor: null,
        });
      },
      sessionStart(input) {
        calls.sessionStart.push(structuredClone(input));
        const existing = sessions.find((session) => session.source === input.source);
        if (existing) return Promise.resolve({ session: projectSession(existing) });
        const session = {
          id: `deepseek-harness-session-${++sessionSequence}`,
          source: input.source,
          cwd: input.cwd,
          name: null,
          archived: false,
          turns: [],
        };
        sessions.push(session);
        return Promise.resolve({ session: projectSession(session) });
      },
      sessionResume(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session, "DeepSeek Harness fixture session must exist before resume");
        return Promise.resolve({ session: projectSession(session) });
      },
      sessionRead(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session, "DeepSeek Harness fixture session must exist before read");
        return Promise.resolve({ session: projectSession(session, input.includeTurns === true) });
      },
      sessionRename(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session);
        session.name = input.name;
        return Promise.resolve({});
      },
      sessionArchive(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session);
        session.archived = true;
        return Promise.resolve({});
      },
      sessionUnarchive(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session);
        session.archived = false;
        return Promise.resolve({});
      },
      sessionDelete(input) {
        const index = sessions.findIndex((candidate) => candidate.id === input.sessionId);
        assert.notEqual(index, -1);
        sessions.splice(index, 1);
        return Promise.resolve({});
      },
      turnStart(input) {
        calls.turnStart.push(structuredClone(input));
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session, "DeepSeek Harness fixture session must exist before turn");
        const existing = session.turns.find((turn) => (
          turn.items.some((item) => item.type === "userMessage" && item.clientId === input.operationId)
        ));
        if (existing) return Promise.resolve({ turn: structuredClone(existing) });
        const sequence = ++turnSequence;
        const turn = {
          id: `deepseek-harness-turn-${sequence}`,
          status: "inProgress",
          itemsView: "full",
          items: [{ type: "userMessage", clientId: input.operationId }],
        };
        session.turns.push(turn);
        const errorCode = nextTurnErrorCode;
        nextTurnErrorCode = null;
        setImmediate(() => {
          if (errorCode) {
            turn.status = "failed";
            turn.errorCode = errorCode;
            publish({
              known: true, method: "deepseek-harness/turn_end", type: "complete",
              sessionId: session.id, turnId: turn.id, status: "failed", errorCode,
            });
            return;
          }
          const text = `DeepSeek Harness completed ${input.operationId}`;
          turn.status = "completed";
          turn.items.push({
            type: "agentMessage",
            id: `deepseek-harness-message-${sequence}`,
            text,
            phase: "final_answer",
            delivery: "local",
          });
          publish({
            known: true,
            method: "deepseek-harness/assistant_chunk",
            type: "text_delta",
            sessionId: session.id,
            turnId: turn.id,
            itemId: `deepseek-harness-message-${sequence}`,
            delta: text,
          });
          publish({
            known: true,
            method: "deepseek-harness/usage",
            type: "usage",
            sessionId: session.id,
            turnId: turn.id,
            responseId: `deepseek-harness-response-${sequence}`,
            provider: "deepseek-official",
            model: "deepseek-v4-flash",
            usage: { ...USAGE },
          });
          publish({
            known: true,
            method: "deepseek-harness/turn_end",
            type: "complete",
            sessionId: session.id,
            turnId: turn.id,
            status: "completed",
          });
        });
        return Promise.resolve({
          turn: { id: turn.id, status: "inProgress", itemsView: "full", items: [] },
        });
      },
      turnSteer(input) { return Promise.resolve({ turnId: input.turnId }); },
      turnInterrupt(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        const turn = session?.turns.find((candidate) => candidate.id === input.turnId);
        if (turn) turn.status = "canceled";
        return Promise.resolve({});
      },
    };
  }

  return {
    acquisitions,
    hosts,
    failNextTurn(errorCode) { nextTurnErrorCode = errorCode; },
    get(runtimeProfileId, options = {}) {
      const controlInstance = !Object.prototype.hasOwnProperty.call(options, "workspace");
      const workspace = controlInstance ? null : options.workspace;
      acquisitions.push({ runtimeProfileId, options: structuredClone(options) });
      const key = JSON.stringify([runtimeProfileId, controlInstance, workspace]);
      if (!hosts.has(key)) hosts.set(key, createHost(runtimeProfileId, workspace, controlInstance));
      return Promise.resolve(hosts.get(key));
    },
    stop(runtimeProfileId) {
      for (const key of [...hosts.keys()]) {
        if (JSON.parse(key)[0] === runtimeProfileId) hosts.delete(key);
      }
      return Promise.resolve();
    },
    stopAll() { hosts.clear(); return Promise.resolve(); },
  };
}

function lazyPool(label) {
  return {
    get() { throw new Error(`${label} runtime must remain lazy in DeepSeek Harness integration`); },
    stop() { return Promise.resolve(); },
    stopAll() { return Promise.resolve(); },
  };
}

function authority(profileId) {
  return { profileId, callId: crypto.randomUUID(), confirmation: true };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dsh-app-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const deepSeekHarnessSpec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "deepseek-harness");
  assert.ok(deepSeekHarnessSpec);
  const deepSeekHarnessHome = path.join(
    root,
    "native-dsh-home",
  );
  fs.mkdirSync(deepSeekHarnessHome, { recursive: true, mode: 0o700 });
  const runtimePool = fakeDeepSeekHarnessPool();
  const binaryDir = path.join(root, "bin");
  fs.mkdirSync(binaryDir, { mode: 0o700 });
  const binaryPath = path.join(binaryDir, "dsh");
  fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const service = createAgentService({
    paths,
    version: "deepseek-harness-app-integration",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => Buffer.from(value).toString("utf8"),
    },
    builtinCliProfiles: true,
    runtimePool: lazyPool("Codex"),
    grokBuildRuntimePool: lazyPool("Grok"),
    antigravityRuntimePool: lazyPool("Antigravity"),
    deepSeekHarnessRuntimePool: runtimePool,
    claudeCodeRuntimePool: lazyPool("Claude Code"),
  });
  const backend = new ShoggothBackend({
    paths,
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-deepseek-harness"
      || (typeof agentId === "string" && agentId.startsWith("deepseek-harness-")),
    readinessTimeoutMs: 5_000,
    readinessIntervalMs: 1,
    readinessMaxAttempts: 50,
    pollIntervalMs: 1,
    runtimeCliAuth: [{
      runtime: "deepseek-harness",
      runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
      name: "DeepSeek Harness",
      binaryPath,
      accountHome: deepSeekHarnessHome,
      processHome: root,
      homeEnv: "DSH_HOME",
      accountKind: "native-user",
      credentialFile: null,
      credentialProbe: "runtime",
      loginArgs: ["web", "--no-open", "--port", "0"],
      logoutArgs: [],
      docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    }],
  });
  const workspaces = Object.fromEntries(["kanban", "cron"].map((kind) => {
    const target = path.join(root, `${kind}-workspace`);
    fs.mkdirSync(target, { mode: 0o700 });
    return [kind, fs.realpathSync(target)];
  }));

  try {
    await service.start();
    await requestService(paths, {
      version: SERVICE_PROTOCOL_VERSION,
      method: "mcp.auth.challenge",
      params: {
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        runtimeProfileId: deepSeekHarnessSpec.runtimeProfileId,
        runtimeAccountId: NATIVE_DEEPSEEK_HARNESS_RUNTIME_ACCOUNT_ID,
        clientNonce: crypto.randomBytes(32).toString("base64url"),
      },
    });
    assert.equal(await backend.start(), true);

    const descriptor = backend.getBackendDescriptor();
    assert.deepEqual(descriptor.surfaces, {
      chat: true,
      agents: true,
      models: true,
      skills: true,
      usage: true,
      oauth: true,
      dashboardRuns: true,
      agentHarness: true,
      cron: { kind: "native" },
      kanban: { kind: "native" },
    });
    assert.deepEqual(backend.getAgents().map((agent) => agent.id), [deepSeekHarnessSpec.agentId]);
    const chatCapabilities = backend.getChatCapabilities(deepSeekHarnessSpec.agentId);
    assert.deepEqual({ ...chatCapabilities, permissions: undefined }, {
      attachments: {
        image: { maxBytes: 10 * 1024 * 1024 },
        file: { maxBytes: 50 * 1024 * 1024 },
        pdf: { maxBytes: 50 * 1024 * 1024 },
      },
      maxAttachmentBytes: 50 * 1024 * 1024,
      maxAttachments: 8,
      maxPromptBytes: 60 * 1024,
      slash: true,
      steer: true,
      modelProvider: "deepseek-harness",
      modelScope: deepSeekHarnessSpec.id,
      permissions: undefined,
    });
    assert.deepEqual(chatCapabilities.permissions.options.map((option) => option.id), [
      "workspace-write", "danger-full-access",
    ]);

    fs.writeFileSync(path.join(deepSeekHarnessHome, ".credentials.yaml"),
      "version: 1\nrefs:\n  DEEPSEEK_API_KEY: test-only\n", { mode: 0o600 });
    const oauth = await backend.listOAuthProviders();
    assert.equal(oauth.providers.length, 1);
    assert.equal(oauth.providers[0].status.loggedIn, true, JSON.stringify(oauth.providers[0]));
    assert.match(oauth.providers[0].cliCommand, /DSH_HOME=/u);
    assert.deepEqual(await service.profileServiceController.handle("profile.auth.read", {
      profileId: deepSeekHarnessSpec.id,
    }), { status: "authenticated" });

    const models = await backend.getModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, DSH_MODEL);
    assert.equal(models[0].provider, "deepseek-harness");
    assert.deepEqual(models[0].modelScopes, [deepSeekHarnessSpec.id]);

    const sessionKey = await backend.createSession(deepSeekHarnessSpec.agentId);
    assert.deepEqual(await backend.setSessionModel(sessionKey, {
      model: DSH_MODEL,
      provider: "deepseek-harness",
    }), { model: DSH_MODEL, scope: "session" });
    const chat = { final: [], error: [] };
    await backend.sendMessage(sessionKey, "DeepSeek Harness App chat", "deepseek-harness-app-chat", {
      final: (...args) => chat.final.push(args),
      error: (error) => chat.error.push(error),
    });
    assert.equal(chat.error.length, 0);
    assert.equal(chat.final.length, 1);
    assert.match(chat.final[0][0], /^DeepSeek Harness completed /u);
    const chatRunId = chat.final[0][2].runId;
    assert.equal(service.workDispatcher.getRun(chatRunId).status, "completed");

    const boards = await backend.getBoards();
    const board = boards.find((candidate) => candidate.agentId === deepSeekHarnessSpec.agentId);
    assert.ok(board);
    const task = await backend.createTask({
      boardId: board.id,
      title: "DeepSeek Harness App Kanban",
      body: "Run the DeepSeek Harness Kanban path",
    });
    const taskDispatch = await backend.runTaskCard(task.id, { workspace: workspaces.kanban });
    const kanbanRun = await service.kanbanRunService.waitForIdle(taskDispatch.runId);
    assert.equal(kanbanRun.status, "completed");
    assert.equal(kanbanRun.profileId, deepSeekHarnessSpec.id);

    const cron = await backend.createCronJob({
      agentId: deepSeekHarnessSpec.agentId,
      name: "DeepSeek Harness App Cron",
      prompt: "Run the DeepSeek Harness Cron path",
      enabled: false,
      workspace: workspaces.cron,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      misfirePolicy: "latest",
      maxCatchUp: 1,
      overlapPolicy: "skip",
      threadPolicy: "new",
      threadId: null,
    });
    const cronDispatch = await backend.runCronJob(cron.id);
    const cronRun = await service.nativeCronScheduler.waitForIdle(cronDispatch.runId);
    assert.equal(cronRun.status, "completed");
    assert.equal(cronRun.profileId, deepSeekHarnessSpec.id);
    assert.equal((await backend.getCronRuns(cron.id)).runs[0].status, "ok");

    const dashboard = await backend.getDashboardRunDetail(kanbanRun.id);
    assert.equal(dashboard.backendId, "deepseek-harness");
    assert.equal(dashboard.agentId, deepSeekHarnessSpec.agentId);
    assert.equal(dashboard.status, "completed");
    assert.equal(dashboard.events.some((event) => (
      event.type === "terminal" && event.status === "completed"
    )), true);
    assert.deepEqual(await backend.getRunningWork(), { supported: true, items: [] });
    assert.deepEqual(await backend.getPendingApprovals(), { supported: true, items: [] });

    const records = service.tokenUsageStore.list({ profileId: deepSeekHarnessSpec.id });
    assert.equal(records.length, 3);
    assert.deepEqual(new Set(records.map((record) => record.source)), new Set(["chat", "kanban", "cron"]));
    assert.equal(records.every((record) => (
      record.provider === "deepseek-official" && record.model === "deepseek-v4-flash"
    )), true);
    const usageSeries = await backend.getUsageSeries("today");
    const usageBreakdown = await backend.getUsageBreakdown("today");
    assert.equal(usageSeries.totals.totalTokens, 90);
    assert.equal(usageSeries.totals.missingCostEntries, 3);
    assert.equal(usageBreakdown.byModel[0].provider, "deepseek-official");
    assert.equal(usageBreakdown.byModel[0].model, "deepseek-v4-flash");

    const skills = await backend.getSkills({ agentId: deepSeekHarnessSpec.agentId });
    const authoring = skills.find((skill) => skill.name === "shoggoth-skill-authoring");
    assert.ok(authoring);
    const enabledSkill = await backend.updateSkill(authoring.name, { enabled: true }, {
      agentId: deepSeekHarnessSpec.agentId,
    });
    assert.equal(enabledSkill.enabled, true);
    const catalog = await service.mcpProductToolController.handle(
      "skill_catalog", { cursor: 0, limit: 10 }, authority(deepSeekHarnessSpec.id),
    );
    assert.equal(catalog.items.some((skill) => skill.name === authoring.name), true);
    const runtimeSkill = catalog.items.find((skill) => skill.name === authoring.name);
    const read = await service.mcpProductToolController.handle("skill_read", {
      name: runtimeSkill.name,
      contentHash: runtimeSkill.contentHash,
      cursor: 0,
      maxBytes: 32 * 1024,
    }, authority(deepSeekHarnessSpec.id));
    assert.match(read.content, /Shoggoth Skill Authoring/u);

    const createdAgent = await backend.createAgent({ name: "DeepSeek Harness Reviewer" });
    assert.match(createdAgent.id, /^deepseek-harness-/u);
    assert.equal((await backend.getAgent(createdAgent.id)).provider, "deepseek-harness");
    const createdProfile = service.productStore.listAgentProfiles()
      .find((profile) => profile.agentId === createdAgent.id);
    assert.ok(createdProfile);
    assert.ok(service.agentDefinitionStore.get(createdProfile.id));
    assert.equal(Number.isSafeInteger(service.memoryStore.getRevision(createdProfile.id)), true);
    assert.ok(service.nativeSkillStore.ensureProfile(createdProfile.id));
    assert.equal(service.nativeKanbanStore.listBoards()
      .some((candidate) => candidate.profileId === createdProfile.id), true);
    const createdHome = path.join(paths.stateDir, "deepseek-harness", createdProfile.runtimeProfileId);
    assert.equal(fs.existsSync(path.join(createdHome, ".credentials.yaml")), false);

    const executionHosts = [...runtimePool.hosts.values()].filter((host) => !host.controlInstance);
    const starts = executionHosts.flatMap((host) => host.calls.sessionStart);
    const turns = executionHosts.flatMap((host) => host.calls.turnStart);
    assert.equal(starts.length, 3);
    assert.equal(turns.length, 3);
    assert.equal(starts.every((input) => (
      JSON.stringify(input.permissionPolicy) === JSON.stringify(DSH_PERMISSION)
    )), true);
    assert.equal(turns.every((input) => (
      JSON.stringify(input.permissionPolicy) === JSON.stringify(DSH_PERMISSION)
    )), true);
    assert.equal(starts.filter((input) => input.model === DSH_MODEL).length, 1);
    assert.equal(starts.some((input) => input.cwd === workspaces.kanban), true);
    assert.equal(starts.some((input) => input.cwd === workspaces.cron), true);

    const previousRuns = new Set(service.workDispatcher.listRuns().map((run) => run.id));
    runtimePool.failNextTurn("RUNTIME_AUTH_REQUIRED");
    const failedSessionKey = await backend.createSession(deepSeekHarnessSpec.agentId);
    const authErrors = [];
    await backend.sendMessage(failedSessionKey, "check authentication", "deepseek-auth-failure", {
      error: (message) => authErrors.push(message),
      final: () => assert.fail("authentication failure cannot produce a final answer"),
    });
    assert.deepEqual(authErrors, ["当前 Agent 登录验证失败，请前往「设置」检查账号状态或重新登录后重试"]);
    const newRuns = service.workDispatcher.listRuns().filter((run) => !previousRuns.has(run.id));
    assert.equal(newRuns.length, 1);
    const failedRun = newRuns[0];
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.errorCode, "RUNTIME_AUTH_REQUIRED");
  } finally {
    await backend.stop().catch(() => {});
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("PASS DeepSeek Harness App integration: dashboard/chat/cron/kanban/agent/token/models/skills/auth");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
