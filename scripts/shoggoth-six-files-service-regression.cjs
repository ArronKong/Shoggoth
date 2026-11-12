#!/usr/bin/env node
"use strict";

// Production stores, IPC, product tools, runtime adapters and Backend reads.
// Only the external model processes are replaced; all data lives in a temporary root.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const FILES = ["IDENTITY", "SOUL", "USER", "AGENTS", "TOOLS", "MEMORY"];
const READ_ONLY = new Set(["USER", "TOOLS", "MEMORY"]);
const EXPECTED_NAMES = ["Shoggoth", "Codex", "Grok", "Antigravity", "Pi", "DeepSeek"];
const uuid = () => crypto.randomUUID();
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text),
  decryptString: (bytes) => bytes.toString(),
};

function runtimePool() {
  const hosts = new Map();
  const key = (binding, workspace) => `${binding.runtimeProfileId}:${workspace || ""}`;
  const get = (binding, options = {}) => {
    const identity = key(binding, options.workspace);
    if (hosts.has(identity)) return hosts.get(identity);
    const sessions = new Map();
    const listeners = new Set();
    const calls = { start: [], resume: [], turn: [], inject: [] };
    const host = {
      workspace: options.workspace || null, controlInstance: !options.workspace,
      terminated: new Promise(() => {}), registeredSecrets: [], calls,
      authenticationState: () => ({ authenticated: true, credentialPresent: true }),
      accountRead: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: false }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      subscribeAccountAuth() { return () => {}; },
      registerServerRequestHandler() { return () => {}; },
      async modelList() { return { data: [{ model: "fixture", isDefault: true, defaultReasoningEffort: "medium" }], nextCursor: null }; },
      async sessionStart(input) {
        calls.start.push(structuredClone(input));
        const session = { id: uuid(), source: input.source, cwd: input.cwd, archived: false, turns: [] };
        sessions.set(session.id, session);
        return { session: structuredClone(session) };
      },
      async sessionResume(input) {
        calls.resume.push(structuredClone(input));
        return this.sessionRead(input);
      },
      async sessionRead(input) {
        const session = sessions.get(input.sessionId);
        assert.ok(session, "Runtime session must exist");
        return { session: structuredClone(session) };
      },
      async sessionList(input) {
        return { data: [...sessions.values()].filter((session) => session.archived === !!input.archived)
          .map((session) => structuredClone(session)), nextCursor: null };
      },
      async threadStart(input) {
        const { session } = await this.sessionStart({ ...input, source: input.threadSource });
        return { thread: { ...session, threadSource: session.source }, approvalsReviewer: input.approvalsReviewer };
      },
      async threadResume(input) {
        const { session } = await this.sessionResume({ ...input, sessionId: input.threadId });
        return { thread: { ...session, threadSource: session.source }, approvalsReviewer: input.approvalsReviewer };
      },
      async threadInjectItems(input) {
        assert.ok(sessions.has(input.threadId));
        this.lastInjectedItems = structuredClone(input);
        calls.inject.push(structuredClone(input));
        return {};
      },
      async threadRead(input) {
        const { session } = await this.sessionRead({ sessionId: input.threadId });
        return { thread: { ...session, threadSource: session.source } };
      },
      threadList(input) { return this.sessionList(input); },
      async turnStart(input) {
        calls.turn.push(structuredClone(input));
        const session = sessions.get(input.sessionId || input.threadId);
        assert.ok(session);
        const turn = { id: uuid(), status: "inProgress", itemsView: "full",
          items: [{ type: "userMessage", id: uuid(), clientId: input.operationId || input.clientUserMessageId }] };
        session.turns.push(turn);
        return { turn: structuredClone(turn) };
      },
      async turnInterrupt(input) {
        const session = sessions.get(input.sessionId || input.threadId);
        const turn = session?.turns.find((item) => item.id === input.turnId);
        if (turn) turn.status = "interrupted";
        return {};
      },
    };
    hosts.set(identity, host);
    return host;
  };
  return { hosts, get, async stop() {}, async stopAll() {} };
}

async function waitForRun(service, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.workRunCoordinator.getRun(runId);
    if (run.status === "running") return run;
    if (["failed", "interrupted", "canceled"].includes(run.status)) assert.fail(JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Runtime did not start: ${runId}`);
}

async function verifyAgentCreationWithSoul(service, caller, ipc, read) {
  const session = service.chatSessionStore.listSessions().find(item => item.profileId === caller.id);
  const sent = await ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey,
    prompt: "创建一个育儿顾问，帮我写好完整的 SOUL。", createdAt: Date.now() });
  const parent = await waitForRun(service, sent.run.id);
  const call = (run, name, args, callId = uuid()) => service.mcpProductToolController.handle(name, args,
    { profileId: run.profileId, callId }, { runId: run.id, assertCurrent() {} });
  const source = run => ({ source: run.source, sourceId: run.sourceId });
  const soul = "# SOUL.md\n\n" + "保持温和，先查证，再给出建议。\n".repeat(120);
  assert.ok(Buffer.byteLength(soul, "utf8") > 4096, "exercise a draft larger than the receipt binding");
  const args = { ...source(parent), backendId: "shoggoth", name: "育儿顾问", workspace: null,
    identity: "为家长提供易于落实的建议。", soul };
  const callId = uuid();
  const created = await call(parent, "native_agent_create", args, callId);
  assert.equal(created.soulSaved, true);
  assert.equal(created.identitySaved, true);
  assert.deepEqual(await call(parent, "native_agent_create", args, callId), created);
  const profile = service.productStore.listAgentProfiles().find(item => item.agentId === created.agent.agentId);
  const saved = await read(profile.id, "SOUL");
  assert.equal(saved.content, soul);
  const delegated = await call(parent, "federation_agent_run", { backendId: profile.backendId,
    agentId: profile.agentId, prompt: "Describe your role." });
  const child = await waitForRun(service, delegated.task.taskId);
  const snapshot = service.contextSnapshotStore.get(profile.id, child.contextSnapshotId);
  assert.ok(snapshot.developerInstructions.includes(soul.trim()), "the first turn must receive the initial SOUL");
  await assert.rejects(() => call(child, "agent_definition_read", { ...source(child), kind: "SOUL" }),
    { code: "MCP_TOOL_FORBIDDEN" });
  await assert.rejects(() => call(child, "native_agent_create", { ...args, ...source(child), name: "未授权创建" }),
    { code: "MCP_TOOL_FORBIDDEN" });
  for (const run of [child, parent]) {
    await ipc("chat.abort", { operationId: uuid(), sessionKey: run.sourceId, runId: run.id, createdAt: Date.now() });
  }
  console.log("PASS a single native create saves the full SOUL for the first turn; delegation remains scoped");
  return { profileId: profile.id, soul };
}

async function verifyManagedAgentFiles(service, caller, ipc, read) {
  const rename = async (from, name) => {
    const current = service.productStore.listAgentProfiles().find(profile => profile.name === from);
    return (await ipc("agent.update", { operationId: uuid(), profileId: current.id, name, defaultCwd: current.defaultCwd,
      expectedUpdatedAt: current.updatedAt, createdAt: Date.now() })).profile;
  };
  const target = await rename("Codex", "育儿专家");
  const shortName = await rename("Grok", "育儿");
  const mainKey = service.proactiveStore.getTarget(caller.id).sessionKey;
  const quote = "把育儿专家的 SOUL、AGENTS、USER、MEMORY、HEARTBEAT 和 DAILY_REVIEW 改成指定内容，再把 IDENTITY 的名字改成亲子顾问。";
  const send = async (sessionKey, prompt = quote, operationId = uuid()) => {
    const sent = await ipc("chat.send", { operationId, sessionKey, prompt, createdAt: Date.now() });
    return waitForRun(service, sent.run.id, 15_000);
  };
  const abort = run => ipc("chat.abort", { operationId: uuid(), sessionKey: run.sourceId, runId: run.id, createdAt: Date.now() });
  const call = (run, name, args, callId = uuid()) => service.mcpProductToolController.handle(name,
    { source: run.source, sourceId: run.sourceId, ...args }, { profileId: run.profileId, callId }, { runId: run.id, assertCurrent() {} });
  const file = (kind, agentId = target.agentId, sourceQuote = quote) => ({ kind, agentId, sourceQuote });
  const readFile = (run, kind, agentId, sourceQuote) => call(run, "native_agent_file_read", file(kind, agentId, sourceQuote));
  const parent = await send(mainKey);
  await assert.rejects(() => readFile(parent, "SOUL", shortName.agentId), { code: "MCP_AGENT_FILE_TARGET_REQUIRED" });
  await assert.rejects(() => readFile(parent, "SOUL", target.agentId, "育儿专家"), { code: "MCP_AGENT_FILE_TARGET_REQUIRED" });
  await assert.rejects(() => readFile(parent, "SOUL", target.agentId, "并不存在的用户授权"), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  await assert.rejects(() => readFile(parent, "TOOLS"), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  await assert.rejects(() => readFile(parent, "DAILY_REVIEW"), { code: "PROACTIVE_SCOPE_INVALID" });
  const { monitor } = await ipc("proactive.monitor.get", { kind: "inspiration", profileId: null });
  await ipc("proactive.monitor.set", { operationId: uuid(), expectedRevision: monitor.revision,
    config: { ...monitor.config, profileId: target.id, enabled: false } });

  const sourceFiles = new Map([
    ["SOUL", "# SOUL.md\n\n温和地回应，并给出可执行的下一步。\n"],
    ["AGENTS", "# AGENTS.md\n\n- 先查证再回答。\n"],
    ["USER", "# User\n\n- 偏好简洁的建议。\n"],
    ["MEMORY", "# Memory\n\n- 保存对话偏好时保留原意。\n"],
    ["HEARTBEAT", "# Heartbeat\n\n- 只提醒已核实的变化。\n"],
    ["DAILY_REVIEW", "# Daily Review\n\n- 汇总需要复查的条目。\n"],
    ["IDENTITY", "# IDENTITY.md\n\n- Name: 亲子顾问\n- Role: 育儿咨询。\n"],
  ]);
  const stale = await readFile(parent, "SOUL");
  await ipc("harness.definition.update", { profileId: target.id, kind: "SOUL", content: `${stale.content}\n并发页面编辑。\n`,
    expectedRevision: Number(stale.revision), reason: "fixture-ui" });
  await assert.rejects(() => call(parent, "native_agent_file_update", { ...file("SOUL"), expectedRevision: stale.revision,
    oldText: stale.content, newText: sourceFiles.get("SOUL") }), { code: "MCP_TOOL_STATE_CONFLICT" });
  assert.match((await read(target.id, "SOUL")).content, /并发页面编辑/u);

  const firstCallId = uuid();
  let firstArgs;
  for (const [kind, newText] of sourceFiles) {
    const before = await readFile(parent, kind);
    assert.equal(before.agentId, target.agentId);
    let oldText = before.content;
    for (let offset = before.nextOffset; offset !== null;) {
      const page = await call(parent, "native_agent_file_read", { ...file(kind), offset });
      assert.equal(page.revision, before.revision);
      oldText += page.content;
      offset = page.nextOffset;
    }
    const callId = kind === "SOUL" ? firstCallId : uuid();
    const args = { ...file(kind), expectedRevision: before.revision, oldText, newText,
      ...(kind === "IDENTITY" ? { newName: "亲子顾问" } : {}) };
    if (kind === "SOUL") firstArgs = args;
    const saved = await call(parent, "native_agent_file_update", args, callId);
    assert.equal(saved.saved, true, `${kind} was saved`);
    assert.equal(saved.agentId, target.agentId);
    assert.deepEqual(await call(parent, "native_agent_file_update", args, callId), saved);
    let actual;
    if (kind === "HEARTBEAT" || kind === "DAILY_REVIEW") {
      const method = kind === "HEARTBEAT" ? "proactive.document.get" : "proactive.review-document.get";
      actual = (await ipc(method, { profileId: target.id })).document.content;
    } else actual = (await read(target.id, kind)).content;
    assert.equal(actual, newText, `${kind} is visible through the settings reader`);
  }
  assert.equal(service.productStore.getAgentProfile(target.id).name, "亲子顾问");
  assert.notEqual((await read(shortName.id, "SOUL")).content, sourceFiles.get("SOUL"));
  service.transcriptStore.appendEvent({ profileId: caller.id, sessionId: service.chatSessionStore.getSession(mainKey).id,
    id: uuid(), runId: parent.id, kind: "user", runtimeRef: null, occurredAt: Date.now(),
    content: { text: "停止修改助理设定。" } });
  await assert.rejects(() => call(parent, "native_agent_file_update", firstArgs, firstCallId), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  await abort(parent);

  const next = await send(mainKey);
  await assert.rejects(() => call(next, "native_agent_file_update", firstArgs, firstCallId), { code: "MCP_TOOL_FORBIDDEN" });
  await abort(next);
  const otherKey = service.proactiveStore.getTarget(target.id).sessionKey;
  const other = await send(otherKey, "把育儿的 SOUL 改成随和风格。");
  const snapshot = service.contextSnapshotStore.get(target.id, other.contextSnapshotId);
  assert.ok(snapshot.developerInstructions.includes(sourceFiles.get("SOUL").trim()));
  await assert.rejects(() => readFile(other, "SOUL", shortName.agentId, "把育儿的 SOUL 改成随和风格。"),
    { code: "MCP_AGENT_FILE_SHOGGOTH_CHAT_REQUIRED" });
  await abort(other);
  const { session } = await ipc("chat.session.create", { operationId: uuid(), profileId: caller.id, workspace: null, createdAt: Date.now() });
  assert.notEqual(session.sessionKey, mainKey);
  const secondaryQuote = "把亲子顾问的 SOUL 补上一句：先询问孩子的年龄。";
  const secondary = await send(session.sessionKey, secondaryQuote);
  const before = await readFile(secondary, "SOUL", target.agentId, secondaryQuote);
  const capabilities = await service.mcpProductToolController.handle("app_capabilities", {},
    { profileId: caller.id, callId: uuid() }, { runId: secondary.id, assertCurrent() {} });
  for (const tool of ["native_agent_file_read", "native_agent_file_update"]) {
    assert.equal(capabilities.currentAgent.tools.find(item => item.tool === tool)?.availability, "available");
  }
  await assert.rejects(() => readFile(secondary, "SOUL"), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  const soul = `${before.content}\n先询问孩子的年龄。\n`;
  const edit = { ...file("SOUL", target.agentId, secondaryQuote), expectedRevision: before.revision,
    oldText: before.content, newText: soul };
  await assert.rejects(() => call(secondary, "native_agent_file_update", { ...edit, sourceId: mainKey }),
    { code: "MCP_AGENT_FILE_SHOGGOTH_CHAT_REQUIRED" });
  assert.equal((await call(secondary, "native_agent_file_update", edit)).saved, true);
  assert.equal((await read(target.id, "SOUL")).content, soul);
  await abort(secondary);
  for (const origin of ["federation-send", "group-turn"]) {
    const indirect = await send(session.sessionKey, secondaryQuote, `${origin}-${uuid()}`);
    await assert.rejects(() => readFile(indirect, "SOUL", target.agentId, secondaryQuote), { code: "MCP_AGENT_FILE_SHOGGOTH_CHAT_REQUIRED" });
    await abort(indirect);
  }
  console.log("PASS Shoggoth edits named Agent settings in its default and additional direct chats, with exact replay and scoped denials");
  return { profileId: target.id, soul };
}

async function verifySixFiles({ createWithSoul = false, editNamedAgent = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-six-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const pool = runtimePool();
  const create = () => createAgentService({ paths, safeStorage, runtimeStorageHomedir: () => root, builtinCliProfiles: true,
    builtinCliInstalledAccountIds: ["native-codex-default-v1", "native-grok-build-default-v1",
      "native-antigravity-default-v1", "native-pi-default-v1", "native-deepseek-harness-default-v1"],
    version: "six-files-regression", runtimePool: pool, grokBuildRuntimePool: pool,
    antigravityRuntimePool: pool, piRuntimePool: pool, deepSeekHarnessRuntimePool: pool,
    ...(createWithSoul ? { federationHostClient: { async request(method) {
      assert.equal(method, "backend.status");
      return { backends: [{ id: "shoggoth", connected: true, disabled: false }] };
    } } } : {}) });
  let service = create();
  const backends = [];
  const report = [];
  const ipc = async (method, params) => {
    try {
      return await requestService(paths, { version: PROTOCOL_VERSION, token: readClientToken(paths), id: uuid(), method, params },
        editNamedAgent ? { timeoutMs: 15_000 } : undefined);
    }
    catch (error) { error.fixtureMethod = method; throw error; }
  };
  const read = (profileId, kind) => ipc("harness.definition.read", { profileId, kind, revision: null });
  try {
    await service.start();
    const profiles = service.productStore.listAgentProfiles();
    assert.deepEqual(profiles.map((profile) => profile.name), EXPECTED_NAMES);
    if (createWithSoul || editNamedAgent) {
      const verify = editNamedAgent ? verifyManagedAgentFiles : verifyAgentCreationWithSoul;
      const created = await verify(service, profiles.find(profile => profile.isDefault), ipc, read);
      await service.stop();
      service = create();
      await service.start();
      assert.equal((await read(created.profileId, "SOUL")).content, created.soul);
      console.log("PASS restart preserves the target Agent's SOUL exactly");
      return;
    }
    const remembered = [];
    for (const profile of profiles) {
      console.log(`CHECK ${profile.name}: read and mutate six files`);
      const backend = new ShoggothBackend({ paths, id: profile.backendId, name: profile.name,
        readinessTimeoutMs: 5000, readinessIntervalMs: 20,
        requestService: async (...args) => {
          try { return await requestService(...args); }
          catch (error) { console.error(`Backend ${args[1].method}: ${error.code}`); throw error; }
        } });
      backends.push(backend);
      assert.equal(await backend.start(), true);
      const detail = await backend.getAgent(profile.agentId);
      // HEARTBEAT.md is the proactive rules document (ded3d2a3), outside the six Harness files.
      assert.deepEqual(detail.files.map((file) => file.name).sort(), [...FILES.map((kind) => `${kind}.md`), "HEARTBEAT.md"].sort());
      let freshMemoryRevision = null;
      for (const kind of FILES) {
        const value = await backend.getAgentFile(profile.agentId, `${kind}.md`);
        assert.ok(value.content.length > 0, `${profile.name}/${kind} must load`);
        assert.equal(value.readOnly, READ_ONLY.has(kind));
        if (kind === "IDENTITY") assert.ok(value.content.includes(`- Name: ${profile.name}\n`));
        // Shoggoth Memory seeds an empty MEMORY.md, so a fresh profile starts at revision 1.
        if (kind === "MEMORY") { assert.equal(value.revision, 1); freshMemoryRevision = value.revision; }
      }
      const tools = await read(profile.id, "TOOLS");
      assert.equal(tools.revision, service.toolRegistry.revision);
      assert.equal(tools.content, service.toolRegistry.toolsMarkdown());

      // The direct MCP socket now requires a Runtime-issued per-call binding.
      // This fixture checks the product tool behavior with its authoritative
      // Run arguments; dedicated MCP bridge tests exercise socket attestation.
      const call = (run, name, args, callId = uuid()) => service.mcpProductToolController.handle(
        name, { source: run.source, sourceId: run.sourceId, ...args },
        { profileId: profile.id, callId });
      const session = service.chatSessionStore.listSessions().find((item) => item.profileId === profile.id);
      assert.ok(session, `${profile.name} must have its own session`);
      assert.notEqual(session.id, session.sessionKey);
      const send = async (prompt) => {
        const result = await ipc("chat.send", { operationId: uuid(), sessionKey: session.sessionKey,
          prompt, createdAt: Date.now() });
        const run = await waitForRun(service, result.run.id);
        assert.equal(run.profileId, profile.id);
        return run;
      };
      const abort = (run) => ipc("chat.abort", { operationId: uuid(), sessionKey: session.sessionKey,
        runId: run.id, createdAt: Date.now() });
      const nickname = `称呼-${profile.id}`;
      const agentFact = `长期事实-${profile.id}`;
      const newName = `${profile.name} 测试`;
      const run = await send(`以后叫我 ${nickname}。记住 ${agentFact}。以后你叫 ${newName}，语气温和，先查证再回答。`);
      const frozen = service.contextSnapshotStore.get(profile.id, run.contextSnapshotId);
      assert.ok(frozen.blocks.some((block) => block.id === "first-conversation"));
      const empty = await call(run, "memory_search", { query: nickname });
      assert.equal(empty.revision, freshMemoryRevision);
      assert.deepEqual(empty.items, []);
      const saveArgs = { expectedRevision: empty.revision, content: `用户要求称呼为 ${nickname}`,
        scope: "user", classification: "explicit", sourceQuote: `以后叫我 ${nickname}` };
      const callId = uuid();
      const saved = await call(run, "memory_save", saveArgs, callId);
      assert.equal(saved.saved, true);
      assert.deepEqual(await call(run, "memory_save", saveArgs, callId), saved);
      const fact = await call(run, "memory_save", { expectedRevision: saved.revision, content: agentFact,
        scope: "agent", classification: "explicit", sourceQuote: `记住 ${agentFact}` });
      assert.equal(fact.saved, true);
      const user = await read(profile.id, "USER");
      const memory = await read(profile.id, "MEMORY");
      assert.ok(user.content.includes(nickname));
      assert.equal(user.content.includes(agentFact), false, "USER must contain only user-scope facts");
      // Shoggoth Memory keeps user-scope facts in USER.md and Agent facts in MEMORY.md.
      assert.ok(memory.content.includes(agentFact) && !memory.content.includes(nickname));
      assert.equal(memory.revision, fact.revision);

      for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) {
        const before = await call(run, "agent_definition_read", { kind });
        assert.equal(before.truncated, false);
        const oldText = kind === "IDENTITY" ? `- Name: ${profile.name}` : before.content;
        const newText = kind === "IDENTITY" ? `- Name: ${newName}`
          : `${before.content}\n${kind === "SOUL" ? "温和" : "先查证再回答"}-${profile.id}\n`;
        const args = { kind, expectedRevision: before.revision, oldText, newText,
          sourceQuote: kind === "IDENTITY" ? `以后你叫 ${newName}` : kind === "SOUL" ? "语气温和" : "先查证再回答",
          ...(kind === "IDENTITY" ? { newName } : {}) };
        const result = await call(run, "agent_definition_update", args);
        assert.equal(result.saved, true);
        assert.equal(result.effective, "next-turn");
        assert.ok((await backend.getAgentFile(profile.agentId, `${kind}.md`)).content.includes(newText));
      }
      assert.equal(service.productStore.getAgentProfile(profile.id).name, newName);
      for (const kind of READ_ONLY) {
        await assert.rejects(() => ipc("harness.definition.update", { profileId: profile.id, kind,
          expectedRevision: service.agentDefinitionStore.get(profile.id).manifest.revision,
          content: "overwrite generated data", reason: "negative test" }),
        (error) => error.code === "DEFINITION_WRITE_FORBIDDEN");
      }
      const manualContent = `界面手动记忆-${profile.id}`;
      const manual = await backend.mutateAgentMemory(profile.agentId, "create", {
        content: manualContent, scope: "agent", expectedRevision: fact.revision,
      });
      assert.equal(manual.item.status, "active");
      const editedManualContent = `${manualContent}-已修改`;
      const edited = await backend.mutateAgentMemory(profile.agentId, "update", {
        id: manual.item.id, content: editedManualContent, confidence: 1,
        validUntil: null, expectedRevision: manual.revision,
      });
      assert.notEqual(edited.item.id, manual.item.id);
      assert.equal(edited.item.supersedes, manual.item.id);
      assert.ok((await backend.getAgentFile(profile.agentId, "MEMORY.md")).content.includes(editedManualContent));
      const toolState = await ipc("harness.tools.list", { profileId: profile.id });
      await ipc("harness.tools.permission.set", { profileId: profile.id, toolName: "memory_save",
        effect: "deny", expectedRevision: toolState.revision });
      await assert.rejects(() => call(run, "memory_save", { ...saveArgs, expectedRevision: fact.revision }),
        (error) => error.code === "MCP_TOOL_FORBIDDEN");
      assert.deepEqual(await read(profile.id, "TOOLS"), tools, "a tool listing must not grant execution permission");
      assert.deepEqual(service.contextSnapshotStore.get(profile.id, run.contextSnapshotId), frozen);
      await abort(run);

      const next = await send(`查询 ${agentFact} 和界面手动记忆，并用现在的名字介绍自己。`);
      const snapshot = service.contextSnapshotStore.get(profile.id, next.contextSnapshotId);
      assert.equal(snapshot.blocks.some((block) => block.id === "first-conversation"), false);
      for (const text of [`- Name: ${newName}`, `温和-${profile.id}`, `先查证再回答-${profile.id}`]) {
        assert.ok(snapshot.developerInstructions.includes(text));
      }
      assert.ok(snapshot.dynamicContext.includes(nickname) && snapshot.dynamicContext.includes(agentFact));
      assert.ok(snapshot.dynamicContext.includes(editedManualContent), "Manual UI edits must reach the next model turn");
      for (const other of profiles.filter((item) => item.id !== profile.id)) {
        assert.equal(snapshot.dynamicContext.includes(`称呼-${other.id}`), false);
        assert.equal(snapshot.dynamicContext.includes(`长期事实-${other.id}`), false);
      }
      const host = pool.get(profile, { workspace: session.workspace });
      // Memory changed after the first turn, so its native history is stale
      // (0355577c): the conversation continues in a renewed native session on
      // the same binding instead of resuming the old one.
      assert.notEqual(next.runtimeSessionRef.sessionId, run.runtimeSessionRef.sessionId, "Renew the stale runtime session");
      const renewed = service.chatSessionStore.getSession(session.sessionKey);
      assert.ok(renewed.retiredRuntimeSessions.some((item) => item.runtimeSessionId === run.runtimeSessionRef.sessionId
        && item.bindingId === renewed.runtimeBindingId), "The stale session is retired on the same binding");
      // Stable rules are delivered at session start; per-run material is a
      // separate developer item (de45ac6f), so compare the definition texts.
      for (const text of [`- Name: ${newName}`, `温和-${profile.id}`, `先查证再回答-${profile.id}`]) {
        assert.ok(host.calls.start.at(-1).developerInstructions.includes(text),
          "Updated definitions must reach the renewed runtime session");
      }
      const turn = host.calls.turn.at(-1);
      // Codex receives dynamic memory as an injected user-authority item before turn/start.
      const delivered = profile.runtime === "codex" ? host.calls.inject
        .filter((entry) => entry.threadId === next.runtimeSessionRef.sessionId)
        .flatMap((entry) => entry.items).filter((item) => item.role === "user")
        .flatMap((item) => item.content.map((part) => part.text)).join("\n") : turn.context;
      assert.ok(delivered.includes(nickname) && delivered.includes(agentFact),
        "Generated user/memory context must reach the runtime turn");
      const latestTools = await ipc("harness.tools.list", { profileId: profile.id });
      assert.equal(latestTools.tools.find((tool) => tool.name === "memory_save").effect, "deny");
      assert.equal(snapshot.revisions.permission, latestTools.revision);
      await abort(next);

      const beforeRestart = {};
      for (const kind of FILES) beforeRestart[kind] = await read(profile.id, kind);
      remembered.push({ profileId: profile.id, name: newName, files: beforeRestart });
      report.push({ backend: profile.backendId, name: profile.name, files: FILES.map((kind) => `${kind}.md`),
        fileReads: "passed", memoryWrite: "passed", manualMemoryEdit: "passed", conversationalEdit: "passed", profileRename: "passed",
        nextTurnDelivery: "passed", permissions: "passed", isolation: "passed" });
      console.log(`PASS ${profile.name}: six files, bound product writes, rename, renewed-session delivery, isolation and permissions`);
      await backend.stop();
    }
    await service.stop();
    service = create();
    await service.start();
    for (const saved of remembered) {
      assert.equal(service.productStore.getAgentProfile(saved.profileId).name, saved.name);
      for (const kind of FILES) assert.deepEqual(await read(saved.profileId, kind), saved.files[kind], `${saved.name}/${kind} after restart`);
      assert.equal(service.permissionEngine.profileProjection(saved.profileId)
        .tools.find((tool) => tool.name === "memory_save").effect, "deny");
    }
    for (const row of report) row.restart = "passed";
    console.log("PASS restart preserves all 36 files, six Profile names and per-Agent permissions");
    return report;
  } finally {
    for (const backend of backends) await backend.stop();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const createWithSoul = process.argv[2] === "--create-with-soul";
const editNamedAgent = process.argv[2] === "--edit-named-agent";
verifySixFiles({ createWithSoul, editNamedAgent }).then((report) => {
  if (process.argv[2] && !createWithSoul && !editNamedAgent) fs.writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}).catch((error) => { console.error(error); process.exitCode = 1; });
