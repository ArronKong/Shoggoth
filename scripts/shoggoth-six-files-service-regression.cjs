#!/usr/bin/env node
"use strict";

// Production stores, IPC, MCP authentication, runtime adapters and Backend reads.
// Only the external model processes are replaced; all data lives in a temporary root.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { authenticateMcpSession } = require("../app/shoggoth-mcp-helper");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");

const FILES = ["IDENTITY", "SOUL", "USER", "AGENTS", "TOOLS", "MEMORY"];
const READ_ONLY = new Set(["USER", "TOOLS", "MEMORY"]);
const EXPECTED_NAMES = ["Shoggoth", "Codex", "Grok", "Antigravity", "Pi", "DeepSeek Harness"];
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
    const calls = { start: [], resume: [], turn: [] };
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
        return { thread: { ...session, threadSource: session.source } };
      },
      async threadResume(input) {
        const { session } = await this.sessionResume({ ...input, sessionId: input.threadId });
        return { thread: { ...session, threadSource: session.source } };
      },
      async threadInjectItems(input) {
        assert.ok(sessions.has(input.threadId));
        this.lastInjectedItems = structuredClone(input);
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

async function waitForRun(service, runId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = service.workRunCoordinator.getRun(runId);
    if (run.status === "running") return run;
    if (["failed", "interrupted", "canceled"].includes(run.status)) assert.fail(JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Runtime did not start: ${runId}`);
}

async function verifySixFiles() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-six-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profiles"), cacheRoot: path.join(root, "cache") });
  const pool = runtimePool();
  const create = () => createAgentService({ paths, safeStorage, builtinCliProfiles: true,
    version: "six-files-regression", runtimePool: pool, grokBuildRuntimePool: pool,
    antigravityRuntimePool: pool, piRuntimePool: pool, deepSeekHarnessRuntimePool: pool });
  let service = create();
  const backends = [];
  const authorizations = [];
  const report = [];
  const ipc = (method, params) => requestService(paths, { version: PROTOCOL_VERSION,
    token: readClientToken(paths), id: uuid(), method, params });
  const read = (profileId, kind) => ipc("harness.definition.read", { profileId, kind, revision: null });
  try {
    await service.start();
    const profiles = service.productStore.listAgentProfiles();
    assert.deepEqual(profiles.map((profile) => profile.name), EXPECTED_NAMES);
    const remembered = [];
    for (const profile of profiles) {
      console.log(`CHECK ${profile.name}: read and mutate six files`);
      const auth = await authenticateMcpSession({ paths, safeStorage,
        runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId });
      authorizations.push(auth);
      const backend = new ShoggothBackend({ paths, id: profile.backendId, name: profile.name,
        readinessTimeoutMs: 5000, readinessIntervalMs: 20,
        requestService: async (...args) => {
          try { return await requestService(...args); }
          catch (error) { console.error(`Backend ${args[1].method}: ${error.code}`); throw error; }
        } });
      backends.push(backend);
      assert.equal(await backend.start(), true);
      const detail = await backend.getAgent(profile.agentId);
      assert.deepEqual(detail.files.map((file) => file.name).sort(), FILES.map((kind) => `${kind}.md`).sort());
      for (const kind of FILES) {
        const value = await backend.getAgentFile(profile.agentId, `${kind}.md`);
        assert.ok(value.content.length > 0, `${profile.name}/${kind} must load`);
        assert.equal(value.readOnly, READ_ONLY.has(kind));
        if (kind === "IDENTITY") assert.ok(value.content.includes(`- Name: ${profile.name}\n`));
        if (kind === "MEMORY") assert.equal(value.revision, 0);
      }
      const tools = await read(profile.id, "TOOLS");
      assert.equal(tools.revision, service.toolRegistry.revision);
      assert.equal(tools.content, service.toolRegistry.toolsMarkdown());

      const call = (run, name, args, callId = uuid()) => requestService(paths, {
        version: PROTOCOL_VERSION, method: "mcp.tool.call", params: {
          runtimeProfileId: profile.runtimeProfileId, runtimeAccountId: profile.runtimeAccountId,
          sessionToken: auth.token, callId, name, arguments: { source: run.source, sourceId: run.sourceId, ...args },
        },
      });
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
      const nickname = `称呼-${profile.backendId}`;
      const agentFact = `长期事实-${profile.backendId}`;
      const newName = `${profile.name} 测试`;
      const run = await send(`以后叫我 ${nickname}。记住 ${agentFact}。以后你叫 ${newName}，语气温和，先查证再回答。`);
      const frozen = service.contextSnapshotStore.get(profile.id, run.contextSnapshotId);
      assert.ok(frozen.blocks.some((block) => block.id === "first-conversation"));
      const empty = await call(run, "memory_search", { query: nickname, includeCandidates: true });
      assert.equal(empty.revision, 0);
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
      assert.ok(memory.content.includes(nickname) && memory.content.includes(agentFact));
      assert.equal(memory.revision, fact.revision);

      for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) {
        const before = await call(run, "agent_definition_read", { kind });
        assert.equal(before.truncated, false);
        const oldText = kind === "IDENTITY" ? `- Name: ${profile.name}` : before.content;
        const newText = kind === "IDENTITY" ? `- Name: ${newName}`
          : `${before.content}\n${kind === "SOUL" ? "温和" : "先查证再回答"}-${profile.backendId}\n`;
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
      const manualContent = `界面手动记忆-${profile.backendId}`;
      const manual = await backend.mutateAgentMemory(profile.agentId, "create", {
        content: manualContent, scope: "agent", expectedRevision: fact.revision,
      });
      assert.equal(manual.item.status, "active");
      const editedManualContent = `${manualContent}-已修改`;
      const edited = await backend.mutateAgentMemory(profile.agentId, "update", {
        id: manual.item.id, content: editedManualContent, confidence: 1,
        validUntil: null, expectedRevision: manual.revision,
      });
      assert.equal(edited.item.id, manual.item.id);
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
      for (const text of [`- Name: ${newName}`, `温和-${profile.backendId}`, `先查证再回答-${profile.backendId}`]) {
        assert.ok(snapshot.developerInstructions.includes(text));
      }
      assert.ok(snapshot.dynamicContext.includes(nickname) && snapshot.dynamicContext.includes(agentFact));
      assert.ok(snapshot.dynamicContext.includes(editedManualContent), "Manual UI edits must reach the next model turn");
      for (const other of profiles.filter((item) => item.id !== profile.id)) {
        assert.equal(snapshot.dynamicContext.includes(`称呼-${other.backendId}`), false);
        assert.equal(snapshot.dynamicContext.includes(`长期事实-${other.backendId}`), false);
      }
      const host = pool.get(profile, { workspace: session.workspace });
      assert.ok(host.calls.resume.length > 0, "Continue the existing runtime session");
      assert.equal(host.calls.resume.at(-1).developerInstructions, snapshot.developerInstructions,
        "Updated definitions must reach the runtime resume call");
      const turn = host.calls.turn.at(-1);
      const delivered = profile.runtime === "codex" ? turn.input[0].text : turn.context;
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
      console.log(`PASS ${profile.name}: six files, authenticated writes, rename, same-session delivery, isolation and permissions`);
      await backend.stop();
    }
    for (const auth of authorizations) auth.close?.();
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
    for (const auth of authorizations) auth.close?.();
    for (const backend of backends) await backend.stop();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

verifySixFiles().then((report) => {
  if (process.argv[2]) fs.writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}).catch((error) => { console.error(error); process.exitCode = 1; });
