#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { InspirationStore } = require("../app/agent-service/inspiration-store");
const { InspirationService } = require("../app/agent-service/inspiration-service");
const { ExternalInspirationExecutor } = require("../app/agent-service/external-inspiration-executor");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");
const id = () => crypto.randomUUID();
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-inspiration-service-"));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  const store = new InspirationStore({ paths }).open();
  const calls = [], snapshots = new Map();
  let hostId = id(), sequence = 0;
  const client = { async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === "inspiration.executor.ready") {
      if (options.readiness) await options.readiness();
      return { ready: true };
    }
    const execution = store.executionForRun(params.runId);
    if (method.endsWith(".prepare")) {
      assert.equal(execution.external.phase, "preparing");
      if (options.prepare) await options.prepare();
      return { hostId, binding: { sessionKey: params.sessionKey || `agent:${params.agentId}:external:${execution.id}`,
        workspace: params.workspace || root, mode: params.backendId === "hermes" ? "gateway" : "openclaw" } };
    }
    if (method.endsWith(".start")) {
      assert.equal(execution.external.phase, "dispatched");
      const { openDatabase } = require("../app/agent-service/inspiration-database");
      const reader = openDatabase(store.filePath);
      try { assert.equal(JSON.parse(reader.prepare("SELECT data FROM executions WHERE id=?").get(execution.id).data).external.phase, "dispatched"); }
      finally { reader.close(); }
      if (options.uncertainStart) throw Object.assign(new Error("lost receipt"), { code: "FEDERATION_COMMIT_UNCERTAIN" });
    }
    const snapshot = { executionId: execution.id, runId: execution.runId, backendId: execution.backendId,
      agentId: execution.agentId, sessionKey: execution.sessionKey, workspace: execution.workspace,
      mode: execution.external.mode, status: "running", sequence: ++sequence, resultSummary: null,
      errorCode: null, finishedAt: null, attention: null, ...(snapshots.get(execution.runId) || {}) };
    if (method.endsWith(".respond")) Object.assign(snapshot, { attention: null, status: "running" });
    if (method.endsWith(".cancel")) Object.assign(snapshot, { attention: null, status: "canceled", finishedAt: Date.now() });
    return { hostId, snapshot };
  } };
  let service;
  const executor = new ExternalInspirationExecutor({ store, client, prompt: execution => service.buildPrompt(execution, true), pollMs: 60000,
    sanitizeSummary: value => value?.includes("SECRET") ? null : value });
  const dispatcher = { getRun() { return null; } };
  service = new InspirationService({ paths, store, dispatcher, externalExecutor: executor,
    productStore: { getAgentProfile() { assert.fail("external task must not create native profiles"); } } });
  service.open();
  const call = (method, params) => service.handle(`inspiration.${method}`, params);
  const create = async () => (await call("create", { operationId: id(), body: "仅用文字给出三个中文建议；不得调用工具或写文件。" })).idea;
  const params = idea => ({ id: idea.id, operationId: id(), expectedRevision: idea.revision,
    instruction: "保留原文约束", agentId: "main", backendId: "hermes", workspace: null });
  const settle = async runId => { await flush(); await executor.pending.get(runId); await flush(); };
  t.after(() => { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, calls, snapshots, executor, service, call, create, params, settle,
    setHost() { hostId = id(); },
    async reconcile(runId) { await executor.schedule(store.executionForRun(runId), true); },
    async restart() { service.close(); store.close(); store.open(); service.open(); await flush();
      await Promise.all([...executor.pending.values()]); },
  };
}

test('external attachment-only notes receive saved media paths and retain a readable Session origin', async t => {
  const f = fixture(t);
  const data = Buffer.alloc(44); data.write('RIFF'); data.write('WAVE', 8);
  const attachment = { id: id(), name: '语音.wav', mimeType: 'audio/wav', size: data.length };
  await f.call('media.write', { attachment, offset: 0, content: data.toString('base64') });
  const { idea } = await f.call('create', { operationId: id(), body: '', attachments: [attachment] });
  const { idea: started } = await f.call('start', f.params(idea));
  await f.settle(started.latestExecution.runId);
  const execution = f.store.executionForRun(started.latestExecution.runId);
  const file = f.store.media.filePath(attachment);
  assert.deepEqual(fs.readFileSync(file), data);
  assert.ok(f.calls.find(call => call.method.endsWith('.start')).params.prompt.includes(file));
  const origin = await f.call('session.get', { backendId: 'hermes', agentId: 'main', sessionKey: execution.sessionKey });
  assert.equal(origin.origin.inspirationTitle, attachment.name);
});

test('external media preparation fails before marking a prompt as dispatched', async t => {
  const f = fixture(t);
  const data = Buffer.alloc(44); data.write('RIFF'); data.write('WAVE', 8);
  const attachment = { id: id(), name: 'voice.wav', mimeType: 'audio/wav', size: data.length };
  await f.call('media.write', { attachment, offset: 0, content: data.toString('base64') });
  const { idea } = await f.call('create', { operationId: id(), body: '', attachments: [attachment] });
  f.store.media.materialize = () => { throw Object.assign(new Error('disk failure'), { code: 'INSPIRATION_MEDIA_UNAVAILABLE' }); };
  const { idea: started } = await f.call('start', f.params(idea));
  await f.settle(started.latestExecution.runId);
  assert.equal(f.calls.filter(call => call.method.endsWith('.start')).length, 0);
  assert.equal(f.store.executionForRun(started.latestExecution.runId).preparationFailure.code, 'INSPIRATION_MEDIA_UNAVAILABLE');
});

test('external auto growth advances on persisted terminal snapshots and retries only once', async t => {
  const f = fixture(t);
  const first = await f.create(), second = await f.create();
  await f.call('growth.set', { expectedRevision: 1, enabled: true, executors: [{ backendId: 'hermes', agentId: 'main' }] });
  const until = async predicate => {
    for (let index = 0; index < 100; index++) { if (predicate()) return; await flush(); }
    assert.fail('Auto growth did not advance');
  };
  await until(() => f.store.latestExecution(first.id)?.external.status === 'running');
  assert.equal(f.store.latestExecution(second.id), null);
  const one = f.store.latestExecution(first.id);
  f.snapshots.set(one.runId, { status: 'failed', errorCode: 'AGENT_OPERATION_FAILED', finishedAt: Date.now() });
  await f.reconcile(one.runId);
  await until(() => f.store.executions(first.id).length === 2 && f.store.latestExecution(first.id).external.status === 'running');
  const retry = f.store.latestExecution(first.id);
  f.snapshots.set(retry.runId, { status: 'failed', errorCode: 'AGENT_OPERATION_FAILED', finishedAt: Date.now() });
  await f.reconcile(retry.runId);
  await until(() => f.store.latestExecution(second.id)?.external.status === 'running');
  assert.equal(f.store.executions(first.id).length, 2);
  assert.equal((await f.call('growth.get', {})).failures[0].errorCode, 'AGENT_OPERATION_FAILED');
});

test('an unconfirmed external start occupies its executor and is never automatically retried', async t => {
  const f = fixture(t, { uncertainStart: true });
  const first = await f.create(), second = await f.create();
  await f.call('growth.set', { expectedRevision: 1, enabled: true, executors: [{ backendId: 'hermes', agentId: 'main' }] });
  for (let index = 0; index < 30; index++) await flush();
  assert.equal(f.store.latestExecution(first.id).external.status, 'unknown');
  assert.equal(f.store.latestExecution(second.id), null);
  assert.equal(f.calls.filter(value => value.method.endsWith('.start')).length, 1);
  for (let index = 0; index < 5; index++) f.service.growth.wake();
  await flush();
  assert.equal(f.store.executions(first.id).length, 1);
});

test('offline desktop executors keep seeds pending across restart and reconnect without spending a retry', async t => {
  let ready = false;
  const f = fixture(t, { readiness: async () => {
    if (!ready) throw Object.assign(new Error('App is starting'), { code: 'APP_HOST_UNAVAILABLE' });
  } });
  const idea = await f.create();
  await f.call('growth.set', { expectedRevision: 1, enabled: true, executors: [{ backendId: 'hermes', agentId: 'main' }] });
  for (let i = 0; i < 10; i++) await flush();
  const operationId = f.store.growthJobs(['pending'])[0].input.operationId;
  assert.equal(f.store.latestExecution(idea.id), null);
  assert.equal(f.calls.some(call => call.method.endsWith('.prepare')), false);
  assert.equal(f.service.growthView().errorCode, 'INSPIRATION_EXECUTOR_UNAVAILABLE');
  await f.restart();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(f.store.growthJobs(['pending'])[0].attempt, 1);
  ready = true;
  await new Promise(resolve => setTimeout(resolve, 5100));
  const execution = f.store.latestExecution(idea.id);
  assert.equal(execution.operationId, operationId);
  assert.equal(execution.external.status, 'running');
  assert.equal(f.store.growthJobs(['running'])[0].attempt, 1);
  assert.equal(f.calls.filter(call => call.method.endsWith('.start')).length, 1);
  assert.equal(f.service.growthView().errorCode, null);
  assert.equal(f.service.growth.reconnectTimer, null);
});

test('pausing during an executor readiness check never dispatches after the check returns', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { readiness: () => gate });
  const idea = await f.create();
  const executors = [{ backendId: 'hermes', agentId: 'main' }];
  await f.call('growth.set', { expectedRevision: 1, enabled: true, executors });
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(f.service.growth.checking.size, 1);
  await f.call('growth.set', { expectedRevision: 2, enabled: false, executors });
  release();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(f.store.latestExecution(idea.id), null);
  assert.equal(f.service.growth.reconnectTimer, null);
  assert.equal(f.service.growth.checking.size, 0);
  await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { favorite: true } });
  await f.call('growth.set', { expectedRevision: 3, enabled: true, executors });
  for (let i = 0; i < 30; i++) await flush();
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.store.growthJobs(['running'])[0].attempt, 1, 'An edit while paused must not consume a retry');
});

test('manual work during a pause supersedes an offline assignment instead of running again on resume', async t => {
  const f = fixture(t, { readiness: async () => { throw Object.assign(new Error('Offline'), { code: 'BACKEND_UNAVAILABLE' }); } });
  const idea = await f.create(), executors = [{ backendId: 'hermes', agentId: 'main' }];
  await f.call('growth.set', { expectedRevision: 1, enabled: true, executors });
  for (let i = 0; i < 10; i++) await flush();
  await f.call('growth.set', { expectedRevision: 2, enabled: false, executors });
  const started = (await f.call('start', f.params(idea))).idea.latestExecution;
  await f.settle(started.runId);
  f.snapshots.set(started.runId, { status: 'completed', finishedAt: Date.now() });
  await f.reconcile(started.runId);
  await f.call('growth.set', { expectedRevision: 3, enabled: true, executors });
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(f.store.growthJobs(['done']).length, 1);
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.service.growth.reconnectTimer, null);
});

test("external start freezes durable identity before side effects and same operation starts once", async t => {
  const f = fixture(t), idea = await f.create(), params = f.params(idea);
  const first = (await f.call("start", params)).idea;
  await f.settle(first.latestExecution.runId);
  assert.equal((await f.call("start", params)).idea.latestExecution.runId, first.latestExecution.runId);
  await f.settle(first.latestExecution.runId);
  const execution = f.store.executionForRun(first.latestExecution.runId);
  assert.equal(execution.profileId, null);
  assert.equal(execution.workspace, f.root);
  assert.equal(execution.body, idea.body);
  assert.equal(f.calls.filter(call => call.method.endsWith(".start")).length, 1);
  assert.ok(f.calls.find(call => call.method.endsWith(".start")).params.prompt.includes(idea.body));
  await assert.rejects(f.call("start", { ...params, instruction: "changed" }), { code: "INSPIRATION_OPERATION_CONFLICT" });
  await assert.rejects(f.call("start", f.params(f.service.view(idea.id))), { code: "INSPIRATION_BUSY" });
});

test("results persist across Service restart and continuation reuses the exact external session", async t => {
  const f = fixture(t), idea = await f.create();
  const first = (await f.call("start", f.params(idea))).idea;
  const runId = first.latestExecution.runId;
  await f.settle(runId);
  f.snapshots.set(runId, { status: "completed", resultSummary: "三个建议已完成", finishedAt: Date.now() });
  await f.reconcile(runId);
  await f.restart();
  assert.equal(f.service.view(idea.id).latestExecution.resultSummary, "三个建议已完成");
  const sessionKey = f.service.view(idea.id).latestExecution.sessionKey;
  const origin = await f.call("session.get", { backendId: "hermes", agentId: "main", sessionKey });
  assert.equal(origin.origin.inspirationId, idea.id);
  const send = { backendId: "hermes", agentId: "main", sessionKey, operationId: id(), prompt: "增加第四点" };
  const next = (await f.call("session.send", send)).idea;
  await f.settle(next.latestExecution.runId);
  assert.equal(next.latestExecution.sessionKey, sessionKey);
  assert.notEqual(next.latestExecution.runId, runId);
  await f.call("session.send", send);
  assert.equal(f.calls.filter(call => call.method.endsWith(".start")).length, 2);
  assert.equal((await f.call("session.get", { backendId: "openclaw", agentId: "main", sessionKey })).origin, null);
  await assert.rejects(f.call("session.send", { ...send, backendId: "openclaw" }), { code: "INSPIRATION_BINDING_INVALID" });
});

for (const backendId of ["hermes", "openclaw"]) test(`${backendId}: composer sends plain text, card additions retain the template after restart`, async t => {
  const f = fixture(t), idea = await f.create();
  const first = (await f.call("start", { ...f.params(idea), backendId })).idea;
  const finish = async runId => {
    await f.settle(runId);
    f.snapshots.set(runId, { status: "completed", resultSummary: "完成", finishedAt: Date.now() });
    await f.reconcile(runId);
  };
  await finish(first.latestExecution.runId);
  const sessionKey = first.latestExecution.sessionKey || f.service.view(idea.id).latestExecution.sessionKey;
  const send = { backendId, agentId: "main", sessionKey, operationId: id(), prompt: "聊天框里的原文\n不要附加模板" };
  const next = (await f.call("session.send", send)).idea;
  await finish(next.latestExecution.runId);
  const starts = () => f.calls.filter(call => call.method.endsWith(".start"));
  assert.match(starts()[0].params.prompt, /^The user has captured/);
  assert.equal(starts()[1].params.prompt, send.prompt);
  assert.equal(f.store.executionForRun(next.latestExecution.runId).inputSource, "chat");
  await f.restart();
  const chatExecution = f.store.executionForRun(next.latestExecution.runId);
  assert.equal(f.service.buildPrompt(chatExecution, true), send.prompt);
  await f.call("session.send", send);
  assert.equal(starts().length, 2);
  const card = (await f.call("start", { ...f.params(f.service.view(idea.id)), backendId, instruction: "灵感详情里的追加" })).idea;
  await f.settle(card.latestExecution.runId);
  assert.equal(f.service.view(idea.id).latestExecution.sessionKey, sessionKey);
  assert.match(starts()[2].params.prompt, /^The user has captured/);
  assert.ok(starts()[2].params.prompt.includes(idea.body));
  assert.match(starts()[2].params.prompt, /Additional user instructions for this turn:\n灵感详情里的追加/);
});

test("lost dispatch receipt and replacement App reconcile without repeating the model prompt", async t => {
  const f = fixture(t, { uncertainStart: true }), idea = await f.create();
  const first = (await f.call("start", f.params(idea))).idea;
  const runId = first.latestExecution.runId;
  await f.settle(runId);
  assert.equal(f.service.view(idea.id).status, "unknown");
  f.setHost();
  f.snapshots.set(runId, { status: "unknown", errorCode: "EXTERNAL_EXECUTION_UNCONFIRMED" });
  await f.restart();
  await f.reconcile(runId);
  assert.equal(f.calls.filter(call => call.method.endsWith(".start")).length, 1);
  await assert.rejects(f.call("start", f.params(f.service.view(idea.id))), { code: "INSPIRATION_BUSY" });
  await f.call("cancel", { id: idea.id, runId, operationId: id() });
  assert.equal(f.service.view(idea.id).status, "canceled");
});

test("cancel during preparation is durable and never starts a model", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { prepare: () => gate }), idea = await f.create();
  const started = (await f.call("start", f.params(idea))).idea;
  await flush();
  const stop = f.call("cancel", { id: idea.id, runId: started.latestExecution.runId, operationId: id() });
  release(); await stop;
  assert.equal(f.service.view(idea.id).status, "canceled");
  assert.equal(f.calls.filter(call => call.method.endsWith(".start")).length, 0);
});

test("interactive replies stay on the same run, persist only a digest, and reject expired requests", async t => {
  const f = fixture(t), idea = await f.create();
  const first = (await f.call("start", f.params(idea))).idea;
  const runId = first.latestExecution.runId;
  await f.settle(runId);
  const request = normalizeInteractiveRequestV1({ runId, eventType: "prompt", payload: {
    requestId: "secret-request", message: "临时凭据", requestedSchema: { type: "object",
      properties: { answer: { type: "string", writeOnly: true } }, required: ["answer"] },
  } });
  f.snapshots.set(runId, { status: "waiting_input", attention: { request, active: true,
    occurredAt: Date.now(), command: null, cwd: null, details: null } });
  await f.reconcile(runId);
  const response = { id: idea.id, runId, operationId: id(), requestId: request.requestId,
    response: { action: "submit", answers: { answer: "SECRET-temporary-answer" } } };
  await f.call("respond", response);
  await f.call("respond", response);
  assert.equal(f.calls.filter(call => call.method.endsWith(".respond")).length, 1);
  assert.equal(fs.readFileSync(f.store.filePath, "utf8").includes("SECRET-temporary-answer"), false);
  await assert.rejects(f.call("respond", { ...response, response: { action: "submit", answers: { answer: "different" } } }),
    { code: "INSPIRATION_OPERATION_CONFLICT" });
  f.snapshots.set(runId, { status: "completed", resultSummary: "SECRET-result", finishedAt: Date.now() });
  await f.reconcile(runId);
  assert.equal(f.service.view(idea.id).latestExecution.resultSummary, null);
  assert.equal(f.calls.filter(call => call.method.endsWith(".start")).length, 1);
});

test("unbound recovered intent fails before dispatch and preserves the editable original", async t => {
  const f = fixture(t), idea = await f.create();
  f.store.prepareExternalExecution(f.params(idea), () => true);
  await f.restart();
  assert.equal(f.service.view(idea.id).status, "failed");
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.view(idea.id).body, idea.body);
});
