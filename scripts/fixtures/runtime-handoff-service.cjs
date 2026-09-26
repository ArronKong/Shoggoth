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

async function openHandoffFixture({ root: existingRoot, transport: existingTransport, catalogs, builtinCliProfiles = false } = {}) {
  const root = existingRoot || fs.mkdtempSync("/tmp/sghandoff-");
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
      if (transport.handles.has(key)) return transport.handles.get(key);
      const raw = new FakeHost([]);
      raw.stop = async () => raw.termination.resolve();
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
      transport.handles.set(key, handle);
      return handle;
    },
    async stop() {}, async stopAll() {},
  };
  const facts = { read: async () => ({ installed: true, releaseEnabled: true, authenticated: true,
    models: ["fixture-model"], attachmentKinds: [], permissionEnforcementProven: true }) };
  const service = createAgentService({ paths, runtimeManager: manager, version: "handoff-fixture", builtinCliProfiles,
    runtimeSupportDiscover: facts.read,
    ...(catalogs ? { accountAuthManager: { open: async () => {}, close: async () => {}, read: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }) } } : {}),
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
      const raw = transport.hosts.get(run.runtimeSessionRef.runtime);
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
