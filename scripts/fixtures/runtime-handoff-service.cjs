"use strict";

// Real Product12/Chat7/Transcript/inbox/execution stores and Coordinator. Only
// native Runtime transport and encryption are fixtures; no CLI/provider is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { createAgentService } = require("../../app/agent-service/server");
const { createSessionRuntimeController } = require("../../app/agent-service/session-runtime-controller");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../../app/agent-service/runtime-account");
const { CodexRuntimeAdapter } = require("../../app/agent-service/codex-runtime-adapter");
const { FakeHost } = require("../shoggoth-work-run-coordinator-unit.cjs");

async function openHandoffFixture({ root: existingRoot, transport: existingTransport, catalogs, builtinCliProfiles = false, validateHandles = false, serviceOptions = {} } = {}) {
  const root = fs.realpathSync(existingRoot || fs.mkdtempSync("/tmp/sghandoff-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profile") });
  const transport = existingTransport || { hosts: new Map(), handles: new Map(), acquisitions: [] };
  const mapSession = ({ threadSource, ...rest }) => ({ ...rest, source: threadSource });
  const manager = {
    async acquire(binding, options = {}) {
      transport.acquisitions.push({ binding: structuredClone(binding), options: structuredClone(options) });
      const key = JSON.stringify(binding);
      const previous = transport.handles.get(key);
      if (previous && !previous.host.stopped) return previous;
      // A stopped CLI process is replaced, while its native sessions survive.
      const raw = new FakeHost([], { threads: previous?.host.threads });
      raw.turnStartCalls = previous?.host.turnStartCalls ?? 0;
      // Real Runtime session IDs are unique across hosts sharing an account.
      // FakeHost's per-host counter must not collide across Agent bindings.
      const startThread = raw.threadStart.bind(raw);
      raw.threadStart = async input => {
        const response = await startThread(input);
        const previousId = response.thread.id, id = crypto.randomUUID();
        raw.threads.find(thread => thread.id === previousId).id = id;
        raw.loadedThreads.delete(previousId);
        raw.loadedThreads.add(id);
        return { ...response, thread: { ...response.thread, id } };
      };
      raw.stop = async () => { raw.stopped = true; raw.termination.resolve(); };
      raw.subscribeAccountAuth = () => () => {};
      transport.hosts.set(binding.runtime, raw);
      let handle;
      if (binding.runtime === "codex") {
        const adapter = new CodexRuntimeAdapter({ runtimePool: {
          get: async () => raw, stop: async () => {}, stopAll: async () => {},
        } });
        handle = await adapter.acquire(binding);
      } else {
        handle = { ...binding, host: raw, terminated: raw.terminated, registeredSecrets: [],
          authenticationState: () => ({ authenticated: true, credentialPresent: true }),
          subscribe: listener => raw.subscribe(event => listener({ ...event, sessionId: event.threadId })),
          registerServerRequestHandler: (method, listener) => raw.registerServerRequestHandler(method,
            (params, context) => listener({ ...params, sessionId: params.threadId }, context)),
          sessionList: async input => { const response = await raw.threadList(input);
            return { ...response, data: response.data.map(mapSession) }; },
          sessionStart: async input => ({ session: mapSession((await raw.threadStart({ ...input, threadSource: input.source })).thread) }),
          sessionResume: async input => ({ session: mapSession((await raw.threadResume({ ...input, threadId: input.sessionId })).thread) }),
          sessionRead: async input => ({ session: mapSession((await raw.threadRead({ ...input, threadId: input.sessionId })).thread) }),
          turnStart: input => raw.turnStart({ ...input, threadId: input.sessionId, clientUserMessageId: input.operationId }),
          turnInterrupt: input => raw.turnInterrupt({ ...input, threadId: input.sessionId }),
        };
      }
      if (catalogs) { const modelsList = async ({ cursor, limit }) => {
        const ids = catalogs[binding.runtime];
        if (!ids) throw new Error("fixture catalog unavailable");
        const offset = cursor ? Number(cursor) : 0;
        return { data: ids.slice(offset, offset + limit).map((model, index) => ({ model, displayName: model,
          description: "", isDefault: offset + index === 0, hidden: false })),
          nextCursor: offset + limit < ids.length ? String(offset + limit) : null };
      };
        if (binding.runtime === "codex") raw.modelList = modelsList; else handle.modelsList = modelsList;
      }
      if (validateHandles) {
        const { runtimeHandleV1, RUNTIME_V1_METHODS } = require("../../app/agent-service/runtime-handle-v1");
        if (!handle.capabilities) handle = { ...handle, capabilities: {
          ...Object.fromEntries(Object.entries(RUNTIME_V1_METHODS).map(([method, capability]) => [capability, typeof handle[method] === "function"])),
          events: true, serverRequests: true,
        } };
        handle = runtimeHandleV1(handle, binding);
      }
      transport.handles.set(key, handle);
      return handle;
    },
    async stop(binding) { await transport.handles.get(JSON.stringify(binding))?.host.stop(); },
    async stopAll() { await Promise.all([...transport.handles.values()].map(handle => handle.host.stop())); },
    isRetiredSessionId: (runtime, sessionId) => transport.retired?.(runtime, sessionId) === true,
  };
  const facts = { read: async () => ({ installed: true, releaseEnabled: true, authenticated: true,
    models: ["fixture-model"], attachmentKinds: [], permissionEnforcementProven: true }) };
  const service = createAgentService({ ...serviceOptions, paths, runtimeManager: manager, version: "handoff-fixture", builtinCliProfiles,
    builtinCliInstalledAccountIds: builtinCliProfiles ? DEFAULT_RUNTIME_ACCOUNTS
      .filter(account => account.kind === "native-user").map(account => account.id) : [],
    runtimeSupportDiscover: facts.read,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
  });
  await service.start();
  let profile = service.productStore.listAgentProfiles()[0];
  const config = service.nativeRuntimeConfig.read();
  if (!config.flags.runtimeConversationHandoff) service.nativeRuntimeConfig.apply({ ...config,
    revision: config.revision + 1, flags: { ...config.flags, runtimeConversationHandoff: true } });
  if (profile.defaultModel !== "fixture-model") profile = service.productStore.putAgentProfile({ ...profile,
    defaultModel: "fixture-model", permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" } });
  for (const runtime of ["pi", "deepseek-harness"]) {
    if (!service.productStore.getAgentRuntimeBindings(profile.id).bindings.some(binding => binding.runtime === runtime)) {
      service.productStore.addAgentRuntimeBinding(profile.id, { runtime,
        runtimeAccountId: DEFAULT_RUNTIME_ACCOUNTS.find(account => account.runtime === runtime).id },
      { operationId: `fixture-add-${runtime}` });
    }
  }
  const controller = createSessionRuntimeController({ productStore: service.productStore,
    chatSessionStore: service.chatSessionStore, transcriptStore: service.transcriptStore,
    coordinator: service.workRunCoordinator, facts,
    getNativeRuntimeConfig: () => service.nativeRuntimeConfig.read() });
  const f = { root, paths, workspace, service, transport, controller, profile, facts,
    binding(runtime) { return service.productStore.getAgentRuntimeBindings(profile.id).bindings.find(b => b.runtime === runtime); },
    createSession() { return service.chatSessionStore.createSession({ operationId: `create-${crypto.randomUUID()}`,
      profileId: profile.id, workspace, createdAt: Date.now() }); },
    // Hosts get unique session ids; tests about namespace collisions make the
    // next host created for a runtime reuse an existing native id.
    collideNextSessionId(runtime, sessionId) {
      const set = transport.hosts.set.bind(transport.hosts);
      transport.hosts.set = (name, raw) => {
        if (name === runtime) {
          transport.hosts.set = set;
          const start = raw.threadStart;
          raw.threadStart = async input => {
            const response = await start(input), previousId = response.thread.id;
            raw.threads.find(thread => thread.id === previousId).id = sessionId;
            raw.loadedThreads.delete(previousId); raw.loadedThreads.add(sessionId);
            return { ...response, thread: { ...response.thread, id: sessionId } };
          };
        }
        return set(name, raw);
      };
    },
    async switch(sessionKey, runtime, overrides = {}) {
      const session = service.chatSessionStore.getSession(sessionKey);
      return controller.handle("chat.session.runtime.switch", { profileId: profile.id, sessionKey,
        bindingId: f.binding(runtime).id, revision: session.revision, acceptAdjustments: true, ...overrides });
    },
    async send(sessionKey, operationId, prompt = `fixture ${operationId}`) {
      const ack = await service.workRunCoordinator.send({ operationId, sessionKey, prompt });
      await service.workRunCoordinator.waitForIdle(ack.run.id);
      return service.workRunCoordinator.getRun(ack.run.id);
    },
    async complete(run, text = `answer ${run.id}`) {
      const ref = run.runtimeSessionRef;
      const raw = [...transport.handles.values()].find(handle => handle.runtime === ref.runtime
        && handle.runtimeProfileId === ref.runtimeProfileId && handle.runtimeAccountId === ref.runtimeAccountId).host;
      const thread = raw.threads.find(thread => thread.id === run.runtimeSessionRef.sessionId);
      const turn = thread.turns.find(turn => turn.id === run.runtimeTurnRef.turnId);
      turn.status = "completed";
      turn.items.push({ type: "agentMessage", id: `answer-${run.id}`, text, phase: "final_answer" });
      raw.emit({ known: true, type: "text", threadId: thread.id, turnId: turn.id,
        itemId: `answer-${run.id}`, text, phase: "final_answer" });
      raw.emit({ known: true, type: "complete", threadId: thread.id, turnId: turn.id });
      await service.workRunCoordinator.waitForIdle(run.id);
      assert.equal(service.workRunCoordinator.getRun(run.id).status, "completed");
    },
    async close({ remove = true } = {}) {
      await service.stop({ notify: false });
      if (remove) fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}

module.exports = { openHandoffFixture };
