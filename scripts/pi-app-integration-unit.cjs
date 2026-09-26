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
const { NATIVE_PI_RUNTIME_ACCOUNT_ID } = require(path.join(
  ROOT, "app", "agent-service", "runtime-account.js",
));
const { requestService } = require(path.join(ROOT, "app", "agent-service", "client.js"));
const { SERVICE_PROTOCOL_VERSION } = require(path.join(
  ROOT, "app", "agent-service", "service-protocol-version.js",
));
const { ShoggothBackend } = require(path.join(ROOT, "app", "core", "shoggoth-backend.js"));

const PI_MODEL = "openai/gpt-pi-test";
const PI_PERMISSION = Object.freeze({
  approvalPolicy: "on-request",
  sandbox: "danger-full-access",
});
const USAGE = Object.freeze({
  totalTokens: 30,
  inputTokens: 20,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  outputTokens: 10,
  reasoningOutputTokens: 3,
});

function fakePiPool() {
  const acquisitions = [];
  const hosts = new Map();
  let sessionSequence = 0;
  let turnSequence = 0;

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
            model: PI_MODEL,
            displayName: "GPT Pi Test",
            description: "Pi multi-provider fixture",
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
          id: `pi-session-${++sessionSequence}`,
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
        assert.ok(session, "Pi fixture session must exist before resume");
        return Promise.resolve({ session: projectSession(session) });
      },
      sessionRead(input) {
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        assert.ok(session, "Pi fixture session must exist before read");
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
        assert.ok(session, "Pi fixture session must exist before turn");
        const existing = session.turns.find((turn) => (
          turn.items.some((item) => item.type === "userMessage" && item.clientId === input.operationId)
        ));
        if (existing) return Promise.resolve({ turn: structuredClone(existing) });
        const sequence = ++turnSequence;
        const turn = {
          id: `pi-turn-${sequence}`,
          status: "inProgress",
          itemsView: "full",
          items: [{ type: "userMessage", clientId: input.operationId }],
        };
        session.turns.push(turn);
        setImmediate(() => {
          const text = `Pi completed ${input.operationId}`;
          turn.status = "completed";
          turn.items.push({
            type: "agentMessage",
            id: `pi-message-${sequence}`,
            text,
            phase: "final_answer",
            delivery: "local",
          });
          publish({
            known: true,
            method: "pi/message_update",
            type: "text_delta",
            sessionId: session.id,
            turnId: turn.id,
            itemId: `pi-message-${sequence}`,
            delta: text,
          });
          publish({
            known: true,
            method: "pi/agent_settled",
            type: "usage",
            sessionId: session.id,
            turnId: turn.id,
            responseId: `pi-response-${sequence}`,
            provider: "openai",
            model: "gpt-pi-test",
            usage: { ...USAGE },
          });
          publish({
            known: true,
            method: "pi/agent_settled",
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
    get() { throw new Error(`${label} runtime must remain lazy in Pi integration`); },
    stop() { return Promise.resolve(); },
    stopAll() { return Promise.resolve(); },
  };
}

function authority(profileId) {
  return { profileId, callId: crypto.randomUUID(), confirmation: true };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-pi-app-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    trustedRoot: root,
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
  });
  const piSpec = BUILTIN_CLI_AGENT_PROFILES.find((profile) => profile.runtime === "pi");
  assert.ok(piSpec);
  const piHome = path.join(root, "native-pi-home");
  fs.mkdirSync(piHome, { recursive: true, mode: 0o700 });
  const runtimePool = fakePiPool();
  const binaryDir = path.join(root, "bin");
  fs.mkdirSync(binaryDir, { mode: 0o700 });
  const binaryPath = path.join(binaryDir, "pi");
  fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const service = createAgentService({
    paths,
    version: "pi-app-integration",
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8"),
      decryptString: (value) => Buffer.from(value).toString("utf8"),
    },
    builtinCliProfiles: true,
    runtimePool: lazyPool("Codex"),
    grokBuildRuntimePool: lazyPool("Grok"),
    antigravityRuntimePool: lazyPool("Antigravity"),
    piRuntimePool: runtimePool,
    claudeCodeRuntimePool: lazyPool("Claude Code"),
  });
  const backend = new ShoggothBackend({
    paths,
    id: "pi",
    name: "Pi",
    connectionMode: "native-runtime",
    claimsAgentId: (agentId) => agentId === "shoggoth-pi"
      || (typeof agentId === "string" && agentId.startsWith("pi-")),
    readinessTimeoutMs: 5_000,
    readinessIntervalMs: 1,
    readinessMaxAttempts: 50,
    pollIntervalMs: 1,
    runtimeCliAuth: [{
      runtime: "pi",
      runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID,
      name: "Pi",
      binaryPath,
      accountHome: piHome,
      processHome: root,
      homeEnv: "PI_CODING_AGENT_DIR",
      accountKind: "native-user",
      credentialFile: "auth.json",
      loginArgs: [],
      logoutArgs: [],
      docsUrl: "https://pi.dev/docs/latest/providers",
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
        runtimeProfileId: piSpec.runtimeProfileId,
        runtimeAccountId: NATIVE_PI_RUNTIME_ACCOUNT_ID,
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
    assert.deepEqual(backend.getAgents().map((agent) => agent.id), [piSpec.agentId]);
    const chatCapabilities = backend.getChatCapabilities(piSpec.agentId);
    assert.deepEqual({ ...chatCapabilities, permissions: undefined }, {
      attachments: {
        image: { maxBytes: 10 * 1024 * 1024 },
        pdf: { maxBytes: 50 * 1024 * 1024 },
        file: { maxBytes: 50 * 1024 * 1024 },
      },
      maxPromptBytes: 60 * 1024,
      maxAttachmentBytes: 50 * 1024 * 1024,
      maxAttachments: 8,
      slash: true,
      steer: true,
      modelProvider: "pi",
      modelScope: piSpec.id,
      permissions: undefined,
    });
    assert.deepEqual({
      scope: chatCapabilities.permissions.scope,
      apply: chatCapabilities.permissions.apply,
      defaultMode: chatCapabilities.permissions.defaultMode,
      optionIds: chatCapabilities.permissions.options.map((option) => option.id),
    }, {
      scope: "session",
      apply: "next-turn",
      defaultMode: "ask",
      optionIds: ["read-only", "ask", "workspace-auto", "full"],
    });

    fs.writeFileSync(path.join(piHome, "auth.json"),
      '{"openai":{"type":"api_key","key":"test-only"}}\n', { mode: 0o600 });
    const oauth = await backend.listOAuthProviders();
    assert.equal(oauth.providers.length, 1);
    assert.equal(oauth.providers[0].status.loggedIn, true);
    assert.match(oauth.providers[0].cliCommand, /PI_CODING_AGENT_DIR=/u);
    assert.deepEqual(await service.profileServiceController.handle("profile.auth.read", {
      profileId: piSpec.id,
    }), { status: "authenticated" });

    const models = await backend.getModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, PI_MODEL);
    assert.equal(models[0].provider, "pi");
    assert.deepEqual(models[0].modelScopes, [piSpec.id]);

    const sessionKey = await backend.createSession(piSpec.agentId);
    assert.deepEqual(await backend.setSessionModel(sessionKey, {
      model: PI_MODEL,
      provider: "pi",
    }), { model: PI_MODEL, scope: "session" });
    const chat = { final: [], error: [] };
    await backend.sendMessage(sessionKey, "Pi App chat", "pi-app-chat", {
      final: (...args) => chat.final.push(args),
      error: (error) => chat.error.push(error),
    });
    assert.equal(chat.error.length, 0);
    assert.equal(chat.final.length, 1);
    assert.match(chat.final[0][0], /^Pi completed /u);
    const chatRunId = chat.final[0][2].runId;
    assert.equal(service.workDispatcher.getRun(chatRunId).status, "completed");

    const boards = await backend.getBoards();
    const board = boards.find((candidate) => candidate.agentId === piSpec.agentId);
    assert.ok(board);
    const task = await backend.createTask({
      boardId: board.id,
      title: "Pi App Kanban",
      body: "Run the Pi Kanban path",
    });
    const taskDispatch = await backend.runTaskCard(task.id, { workspace: workspaces.kanban });
    const kanbanRun = await service.kanbanRunService.waitForIdle(taskDispatch.runId);
    assert.equal(kanbanRun.status, "completed");
    assert.equal(kanbanRun.profileId, piSpec.id);

    const cron = await backend.createCronJob({
      agentId: piSpec.agentId,
      name: "Pi App Cron",
      prompt: "Run the Pi Cron path",
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
    assert.equal(cronRun.profileId, piSpec.id);
    assert.equal((await backend.getCronRuns(cron.id)).runs[0].status, "ok");

    const dashboard = await backend.getDashboardRunDetail(kanbanRun.id);
    assert.equal(dashboard.backendId, "pi");
    assert.equal(dashboard.agentId, piSpec.agentId);
    assert.equal(dashboard.status, "completed");
    assert.equal(dashboard.events.some((event) => (
      event.type === "terminal" && event.status === "completed"
    )), true);
    assert.deepEqual(await backend.getRunningWork(), { supported: true, items: [] });
    assert.deepEqual(await backend.getPendingApprovals(), { supported: true, items: [] });

    const records = service.tokenUsageStore.list({ profileId: piSpec.id });
    assert.equal(records.length, 3);
    assert.deepEqual(new Set(records.map((record) => record.source)), new Set(["chat", "kanban", "cron"]));
    assert.equal(records.every((record) => (
      record.provider === "openai" && record.model === "gpt-pi-test"
    )), true);
    const usageSeries = await backend.getUsageSeries("today");
    const usageBreakdown = await backend.getUsageBreakdown("today");
    assert.equal(usageSeries.totals.totalTokens, 90);
    assert.equal(usageSeries.totals.missingCostEntries, 3);
    assert.equal(usageBreakdown.byModel[0].provider, "openai");
    assert.equal(usageBreakdown.byModel[0].model, "gpt-pi-test");

    const skills = await backend.getSkills({ agentId: piSpec.agentId });
    const authoring = skills.find((skill) => skill.name === "shoggoth-skill-authoring");
    assert.ok(authoring);
    const enabledSkill = await backend.updateSkill(authoring.name, { enabled: true }, {
      agentId: piSpec.agentId,
    });
    assert.equal(enabledSkill.enabled, true);
    const catalog = await service.mcpProductToolController.handle(
      "skill_catalog", { cursor: 0, limit: 10 }, authority(piSpec.id),
    );
    assert.equal(catalog.items.some((skill) => skill.name === authoring.name), true);
    const runtimeSkill = catalog.items.find((skill) => skill.name === authoring.name);
    const read = await service.mcpProductToolController.handle("skill_read", {
      name: runtimeSkill.name,
      contentHash: runtimeSkill.contentHash,
      cursor: 0,
      maxBytes: 32 * 1024,
    }, authority(piSpec.id));
    assert.match(read.content, /Shoggoth Skill Authoring/u);

    const createdAgent = await backend.createAgent({ name: "Pi Reviewer" });
    assert.match(createdAgent.id, /^pi-/u);
    assert.equal((await backend.getAgent(createdAgent.id)).provider, "pi");
    const createdProfile = service.productStore.listAgentProfiles()
      .find((profile) => profile.agentId === createdAgent.id);
    assert.ok(createdProfile);
    assert.ok(service.agentDefinitionStore.get(createdProfile.id));
    assert.equal(Number.isSafeInteger(service.memoryStore.getRevision(createdProfile.id)), true);
    assert.ok(service.nativeSkillStore.ensureProfile(createdProfile.id));
    assert.equal(service.nativeKanbanStore.listBoards()
      .some((candidate) => candidate.profileId === createdProfile.id), true);
    const createdHome = path.join(paths.stateDir, "pi", createdProfile.runtimeProfileId);
    assert.equal(fs.existsSync(path.join(createdHome, "auth.json")), false);

    const executionHosts = [...runtimePool.hosts.values()].filter((host) => !host.controlInstance);
    const starts = executionHosts.flatMap((host) => host.calls.sessionStart);
    const turns = executionHosts.flatMap((host) => host.calls.turnStart);
    assert.equal(starts.length, 3);
    assert.equal(turns.length, 3);
    assert.equal(starts.every((input) => (
      JSON.stringify(input.permissionPolicy) === JSON.stringify(PI_PERMISSION)
    )), true);
    assert.equal(turns.every((input) => (
      JSON.stringify(input.permissionPolicy) === JSON.stringify(PI_PERMISSION)
    )), true);
    assert.equal(starts.filter((input) => input.model === PI_MODEL).length, 1);
    assert.equal(starts.some((input) => input.cwd === workspaces.kanban), true);
    assert.equal(starts.some((input) => input.cwd === workspaces.cron), true);
  } finally {
    await backend.stop().catch(() => {});
    await service.stop({ notify: false }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("PASS Pi App integration: dashboard/chat/cron/kanban/agent/token/models/skills/auth");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
