#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { InspirationStore } = require("../../app/agent-service/inspiration-store");
const { InspirationService } = require("../../app/agent-service/inspiration-service");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../../app/agent-service/product-store");
const { ChatSessionStore } = require("../../app/agent-service/chat-session-store");
const { TranscriptStore } = require("../../app/agent-service/transcript-store");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { WorkRunCoordinator } = require("../../app/agent-service/work-run-coordinator");
const { createWorkDispatcher } = require("../../app/agent-service/work-run");
const { DomainWorkRunExecutor } = require("../../app/agent-service/domain-work-run-executor");
const { RuntimeAccountAdmission } = require("../../app/agent-service/runtime-account-admission");
const { InspirationRuntime } = require("./inspiration-runtime.cjs");
const id = () => crypto.randomUUID();

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for Inspiration state");
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-inspiration-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const productStore = new JsonlProductStore({ paths }).open();
  const store = new InspirationStore({ paths }).open();
  const sessions = new ChatSessionStore({ paths }).open();
  const transcript = new TranscriptStore({ paths });
  transcript.open();
  const dispatcher = createWorkDispatcher({ store: productStore });
  const accountAdmission = options.accountAdmission ? new RuntimeAccountAdmission({
    runtimeAccountLookup: accountId => productStore.getRuntimeAccount(accountId),
  }) : null;
  const host = new InspirationRuntime();
  const inbox = { enqueue() { assert.fail("Inspiration must not create a second chat run"); },
    get() { return null; }, list() { return []; }, transition() { assert.fail("Unexpected chat inbox transition"); } };
  let service;
  const makeCoordinator = () => new WorkRunCoordinator({ dispatcher, productStore,
    chatSessionStore: sessions, transcriptStore: transcript, inbox,
    ...(accountAdmission ? { runtimeAccountAdmission: accountAdmission } : {}),
    getMediaStore: () => store.media,
    runtimePool: { async get() { return host; } }, assertSecretSafe: () => true,
    resolveRunSession: (run) => store.executionForRun(run.id),
    onRunInteraction: (run, interaction) => service.onInteraction(run, interaction),
    onRunTerminal: (run) => service.onRunTerminal(run),
    sanitizeSummary: (value) => value, terminalRetryDelaysMs: [] });
  let coordinator = makeCoordinator();
  const executor = new DomainWorkRunExecutor({ getCoordinator: () => coordinator });
  service = new InspirationService({ paths, store, productStore, chatSessionStore: sessions,
    transcriptStore: transcript, dispatcher, getCoordinator: () => coordinator, executor,
    readinessClient: { async request(method, params) {
      assert.equal(method, "inspiration.executor.ready");
      assert.ok(params.backendId && params.agentId);
      return { ready: true };
    } } });
  await coordinator.open();
  service.open();
  const profile = productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
  const call = (method, params) => service.handle(`inspiration.${method}`, params);
  const create = async (body = "想做一个咖啡记录工具") => (await call("create", { operationId: id(), body })).idea;
  const start = async (idea, instruction = "", operationId = id()) => (await call("start", {
    id: idea.id, expectedRevision: idea.revision, operationId, instruction,
    agentId: profile.agentId, backendId: profile.backendId, workspace: null,
  })).idea;
  t.after(async () => {
    service.close();
    await coordinator.close();
    transcript.close(); sessions.close(); store.close(); productStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, store, sessions, productStore, profile, transcript, dispatcher, host, accountAdmission,
    get coordinator() { return coordinator; }, service, call, create, start,
    async restart() {
      service.close(); await coordinator.close(); store.close(); store.open();
      coordinator = makeCoordinator(); await coordinator.open(); service.open();
    },
    async running(idea) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await coordinator.waitForIdle(idea.latestExecution.runId);
      await until(() => {
        const run = dispatcher.getRun(idea.latestExecution.runId);
        assert.ok(!["failed", "canceled", "interrupted"].includes(run?.status), JSON.stringify(run));
        return run?.status === "running";
      });
      return dispatcher.getRun(idea.latestExecution.runId);
    },
  };
}

module.exports = { fixture, until };
