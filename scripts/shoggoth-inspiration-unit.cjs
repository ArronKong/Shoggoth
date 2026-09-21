#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { InspirationStore, INSPIRATION_STORE_VERSION } = require("../app/agent-service/inspiration-store");
const { validateChatServiceResult, mapChatServiceError } = require("../app/agent-service/chat-service-protocol");
const { fixture, until } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const id = () => crypto.randomUUID();

test('灵感聊天额度耗尽立即落为可见失败，历史保留且恢复后不会重放旧消息', async (t) => {
  const f = await fixture(t, { accountAdmission: true });
  const idea = await f.start(await f.create('中国科技新闻'));
  const first = await f.running(idea);
  f.accountAdmission.noteRateLimitBackoff({ runtimeAccountId: f.profile.runtimeAccountId,
    generation: 1, retryAt: Date.now() + 4 * 86400000, errorCode: 'RUNTIME_QUOTA_EXHAUSTED' });
  f.host.complete(first, '上一条已完成');
  await until(() => f.dispatcher.getRun(first.id).status === 'completed');
  const input = { sessionKey: idea.latestExecution.sessionKey, operationId: id(), prompt: '中国科技新闻' };
  const ack = f.service.sendFromSession(input);
  validateChatServiceResult('chat.send', ack);
  await until(() => f.dispatcher.getRun(ack.run.id).status === 'failed');
  await f.coordinator.waitForIdle(ack.run.id);
  assert.equal(f.dispatcher.getRun(ack.run.id).errorCode, 'RUNTIME_QUOTA_EXHAUSTED');
  assert.equal(f.coordinator.getRunSnapshot(ack.run.id).queue, undefined);
  assert.equal((await f.call('get', { id: idea.id })).idea.latestExecution.status, 'failed');
  const session = f.sessions.getSession(input.sessionKey);
  const terminal = f.transcript.listEvents(f.profile.id, session.id)
    .find(event => event.runId === ack.run.id && event.kind === 'error');
  assert.equal(terminal.content.errorCode, 'RUNTIME_QUOTA_EXHAUSTED');
  f.accountAdmission.noteRateLimitBackoff({ runtimeAccountId: f.profile.runtimeAccountId,
    generation: 1, retryAt: 0 });
  const replay = f.service.sendFromSession(input);
  validateChatServiceResult('chat.send', replay);
  assert.equal(replay.run.status, 'failed');
  assert.equal(f.host.turnStarts, 1);
  await f.restart();
  assert.equal(f.dispatcher.getRun(ack.run.id).status, 'failed');
  assert.equal(f.host.turnStarts, 1);
});

test('Agent 次数按完整执行历史统计，重放不重复计数，重试和删除后的历史仍保留', async (t) => {
  const f = await fixture(t);
  const native = { backendId: f.profile.backendId, agentId: f.profile.agentId };
  const external = { backendId: 'hermes', agentId: native.agentId };
  const zero = { backendId: native.backendId, agentId: 'never-used' };
  const stats = () => f.call('agent-stats', { agents: [native, external, zero] });
  assert.deepEqual((await stats()).agents.map(agent => agent.executionCount), [0, 0, 0]);
  let idea = await f.create('同一条灵感的多轮执行');
  const original = idea, operation = id();
  idea = await f.start(idea, '', operation);
  await f.start(original, '', operation);
  assert.deepEqual((await stats()).agents.map(agent => agent.executionCount), [1, 0, 0]);
  let run = await f.running(idea);
  f.host.complete(run, '第一轮');
  await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  idea = await f.start(idea);
  run = await f.running(idea);
  f.host.complete(run, '第二轮');
  await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  idea = (await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { archived: true } })).idea;
  await f.call('delete', { id: idea.id, operationId: id(), expectedRevision: idea.revision });
  // The same Agent id on another backend must never share its execution count.
  const another = await f.create('外部 Agent 的独立历史');
  f.store.prepareExternalExecution({ id: another.id, operationId: id(), expectedRevision: another.revision,
    ...external, workspace: null, instruction: '' }, () => true);
  await f.restart();
  assert.deepEqual((await stats()).agents, [{ ...native, executionCount: 2 }, { ...external, executionCount: 1 }, { ...zero, executionCount: 0 }]);
  const { validateInspirationServiceResult } = require('../app/agent-service/inspiration-service-protocol');
  for (const agents of [[native, native], Array(51).fill(native), [{ ...native, extra: true }]]) {
    await assert.rejects(f.call('agent-stats', { agents }), { code: 'INSPIRATION_INVALID' });
  }
  for (const executionCount of [-1, 1.5, '2']) {
    assert.throws(() => validateInspirationServiceResult('inspiration.agent-stats', { agents: [{ ...native, executionCount }] }),
      { code: 'INSPIRATION_RESPONSE_INVALID' });
  }
});

test('收藏和取消收藏保留排序、游标和时间，正文修改仍正常置前', async (t) => {
  const f = await fixture(t);
  let clock = 100;
  f.store.now = () => clock++;
  const notes = [];
  for (let index = 0; index < 5; index++) notes.push(await f.create(`排序测试 ${index}`));
  const list = (cursor = null, limit = 20) => f.call('list', { filter: 'saved', query: '', cursor, limit });
  const before = await list();
  const first = await list(null, 2);
  const original = notes[1];
  clock = 500;
  const request = { id: original.id, operationId: id(), expectedRevision: original.revision, patch: { favorite: true } };
  let updated = (await f.call('update', request)).idea;
  assert.equal(updated.updatedAt, original.updatedAt);
  assert.equal(updated.revision, original.revision + 1);
  assert.deepEqual((await list()).items.map(idea => idea.id), before.items.map(idea => idea.id));
  assert.deepEqual((await list(first.nextCursor)).items.map(idea => idea.id), before.items.slice(2).map(idea => idea.id));
  await f.restart();
  assert.equal((await f.call('update', request)).idea.updatedAt, original.updatedAt);
  updated = (await f.call('update', { id: original.id, operationId: id(), expectedRevision: updated.revision, patch: { favorite: false } })).idea;
  assert.deepEqual((await list()).items.map(idea => idea.id), before.items.map(idea => idea.id));
  assert.equal(updated.updatedAt, original.updatedAt);
  updated = (await f.call('update', { id: original.id, operationId: id(), expectedRevision: updated.revision,
    patch: { body: '修改了正文', favorite: true } })).idea;
  assert.ok(updated.updatedAt > original.updatedAt);
  assert.equal((await list()).items[0].id, original.id);
  assert.equal(f.host.turnStarts, 0);
});

test('纸色随灵感持久化，重试、编辑和重启不换色，旧请求仍可读写', async (t) => {
  const f = await fixture(t);
  const input = { operationId: id(), body: '这是一张鼠尾草色的纸', paperTone: 1 };
  const idea = (await f.call('create', input)).idea;
  assert.equal(idea.paperTone, 1);
  assert.equal((await f.call('create', input)).idea.id, idea.id);
  await assert.rejects(f.call('create', { ...input, paperTone: 2 }), { code: 'INSPIRATION_OPERATION_CONFLICT' });
  await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { body: '继续写在同一张纸上', favorite: true } });
  const palette = [];
  for (let paperTone = 0; paperTone < 8; paperTone++) {
    const request = { operationId: id(), body: `预设纸色 ${paperTone}`, paperTone };
    palette.push({ request, idea: (await f.call('create', request)).idea });
  }
  await f.restart();
  assert.equal((await f.call('get', { id: idea.id })).idea.paperTone, 1);
  const listed = (await f.call('list', { filter: 'saved', query: '', cursor: null, limit: 20 })).items;
  assert.equal(listed.find(item => item.id === idea.id).paperTone, 1);
  for (const { request, idea: colored } of palette) {
    assert.equal((await f.call('get', { id: colored.id })).idea.paperTone, request.paperTone);
    assert.equal(listed.find(item => item.id === colored.id).paperTone, request.paperTone);
    assert.equal((await f.call('create', request)).idea.id, colored.id, 'all eight colors remain retry-safe after restart');
  }
  assert.equal((await f.call('create', input)).idea.paperTone, 1);
  for (const paperTone of [-1, 8, 1.5, '1', null]) {
    await assert.rejects(f.call('create', { operationId: id(), body: '无效纸色', paperTone }), { code: 'INSPIRATION_INVALID' });
  }
  const legacy = (await f.call('create', { operationId: id(), body: '旧版不带纸色的请求' })).idea;
  assert.equal(legacy.paperTone, undefined);
  assert.equal(f.host.turnStarts, 0);
});

test('删除可重试且持久化，过时编辑和旧操作不会复活灵感', async (t) => {
  const f = await fixture(t);
  const create = { operationId: id(), body: '待删除的原文' };
  const idea = (await f.call('create', create)).idea;
  const edit = { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { favorite: true } };
  const updated = (await f.call('update', edit)).idea;
  const remove = { id: idea.id, operationId: id(), expectedRevision: updated.revision };
  await assert.rejects(f.call('delete', { ...remove, expectedRevision: 1 }), { code: 'INSPIRATION_REVISION_CONFLICT' });
  assert.deepEqual(await f.call('delete', remove), { id: idea.id, deleted: true });
  assert.deepEqual(await f.call('delete', remove), { id: idea.id, deleted: true });
  await f.restart();
  assert.deepEqual(await f.call('delete', remove), { id: idea.id, deleted: true });
  assert.equal(f.store.get(idea.id), null);
  assert.equal(f.store.list().length, 0);
  await assert.rejects(f.call('get', { id: idea.id }), { code: 'INSPIRATION_NOT_FOUND' });
  await assert.rejects(f.call('create', create), { code: 'INSPIRATION_NOT_FOUND' });
  await assert.rejects(f.call('update', edit), { code: 'INSPIRATION_NOT_FOUND' });
  const persisted = f.store.exportSnapshot();
  assert.equal(persisted.ideas[idea.id].body, '');
  assert.equal(f.host.turnStarts, 0);
});

test('正在执行和尚未准入的灵感不可删除，结束后删除保留 Session 历史', async (t) => {
  const f = await fixture(t);
  const original = await f.create();
  const operationId = id();
  let idea = await f.start(original, '', operationId);
  const run = await f.running(idea);
  await assert.rejects(f.call('delete', { id: idea.id, operationId: id(), expectedRevision: idea.revision }), { code: 'INSPIRATION_BUSY' });
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  f.host.complete(run, '保留成果与执行记录');
  await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  const history = f.transcript.listEvents(run.profileId, session.id);
  await f.call('delete', { id: idea.id, operationId: id(), expectedRevision: idea.revision });
  await assert.rejects(f.start(original, '', operationId), { code: 'INSPIRATION_NOT_FOUND' });
  assert.throws(() => f.service.sendFromSession({ sessionKey: session.sessionKey, operationId: id(), prompt: '不能复活已删除灵感' }), { code: 'INSPIRATION_NOT_FOUND' });
  await f.restart();
  assert.deepEqual(f.transcript.listEvents(run.profileId, session.id), history);
  assert.equal(f.sessions.getSession(session.sessionKey).id, session.id);
  assert.equal(f.store.executionForRun(run.id).body, original.body);
  assert.equal(f.host.turnStarts, 1);
  idea = await f.create('尚未准入');
  f.store.prepareExecution({ id: idea.id, expectedRevision: idea.revision, operationId: id(), instruction: '',
    agentId: f.profile.agentId, backendId: f.profile.backendId, profileId: f.profile.id, workspace: fs.realpathSync(f.root) }, () => true);
  await assert.rejects(f.call('delete', { id: idea.id, expectedRevision: idea.revision + 1, operationId: id() }), { code: 'INSPIRATION_BUSY' });
});

test('仅最新一轮已完成的灵感可归档，恢复后继续执行重新受限', async (t) => {
  const f = await fixture(t);
  let idea = await f.create();
  const archive = () => f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { archived: true } });
  await assert.rejects(archive(), { code: 'INSPIRATION_NOT_COMPLETED' });
  idea = await f.start(idea);
  const run = await f.running(idea);
  await assert.rejects(archive(), { code: 'INSPIRATION_NOT_COMPLETED' });
  f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  idea = (await archive()).idea;
  assert.ok(idea.archivedAt);
  idea = (await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { favorite: true } })).idea;
  assert.equal((await f.call('list', { filter: 'favorite', query: '', cursor: null, limit: 20 })).items[0].id, idea.id,
    'Favorites include the fourth growth stage');
  idea = (await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { archived: false } })).idea;
  idea = await f.start(idea);
  await f.running(idea);
  await assert.rejects(archive(), { code: 'INSPIRATION_NOT_COMPLETED' });
  await f.call('cancel', { id: idea.id, operationId: id(), runId: idea.latestExecution.runId });
  await assert.rejects(archive(), { code: 'INSPIRATION_NOT_COMPLETED' });
});

test('旧版灵感存储无损迁移，未知旧字段仍拒绝加载', async (t) => {
  const f = await fixture(t);
  const idea = await f.create('旧版保存的原文');
  const file = f.store.legacyPath;
  const previous = f.store.exportSnapshot();
  f.store.close();
  fs.unlinkSync(f.store.filePath);
  previous.version = 1;
  for (const value of Object.values(previous.ideas)) delete value.deletedAt;
  fs.writeFileSync(file, JSON.stringify(previous), { mode: 0o600 });
  f.store.open();
  assert.equal(f.store.get(idea.id).body, idea.body);
  await f.call('delete', { id: idea.id, operationId: id(), expectedRevision: idea.revision });
  assert.equal(f.store.exportSnapshot().version, INSPIRATION_STORE_VERSION);
  f.store.close();
  previous.ideas[idea.id].unexpected = true;
  fs.unlinkSync(f.store.filePath);
  fs.unlinkSync(f.store.migratedPath);
  fs.writeFileSync(file, JSON.stringify(previous), { mode: 0o600 });
  assert.throws(() => f.store.open(), { code: 'INSPIRATION_STORE_CORRUPT' });
});

test("保存与重复请求不调用 Agent；重开仍有原文，冲突不覆盖", async (t) => {
  const f = await fixture(t);
  const input = { operationId: id(), body: "原文\nhttps://example.com" };
  const first = await f.call("create", input);
  assert.equal((await f.call("create", input)).idea.id, first.idea.id);
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.sessions.listSessions().length, 0);
  await assert.rejects(f.call("create", { ...input, body: "不同内容" }), { code: "INSPIRATION_OPERATION_CONFLICT" });
  await f.call("update", { id: first.idea.id, operationId: id(), expectedRevision: 1, patch: { favorite: true } });
  await assert.rejects(f.call("update", { id: first.idea.id, operationId: id(), expectedRevision: 1,
    patch: { body: "过时编辑" } }), { code: "INSPIRATION_REVISION_CONFLICT" });
  f.store.close(); f.store.open();
  assert.equal(f.store.get(first.idea.id).body, input.body);
  assert.equal(f.store.get(first.idea.id).favorite, true);
});

test("一次启动冻结输入、只建一个领域 Run 和一个可见 Session", async (t) => {
  const f = await fixture(t);
  const idea = await f.create();
  const operationId = id();
  const first = await f.start(idea, "先做网页", operationId);
  assert.equal((await f.start(idea, "先做网页", operationId)).latestExecution.runId, first.latestExecution.runId);
  const run = await f.running(first);
  assert.equal(run.source, "inspiration");
  assert.equal(f.host.turnStarts, 1);
  assert.equal(f.sessions.listSessions().length, 1);
  assert.equal(f.coordinator.listSessionRuns(first.latestExecution.sessionKey)[0].id, run.id);
  await assert.rejects(f.start(first), { code: "INSPIRATION_BUSY" });
  await f.call("update", { id: idea.id, operationId: id(), expectedRevision: first.revision, patch: { body: "后来编辑的想法" } });
  assert.equal(f.store.executionForRun(run.id).body, idea.body);
  const session = f.sessions.getSession(first.latestExecution.sessionKey);
  const events = f.transcript.listEvents(run.profileId, session.id);
  assert.equal(events.filter((event) => event.kind === "user").length, 1);
  assert.ok(events[0].content.text.includes("先做网页"));
});

test("补充与授权在卡片响应后沿同一 Run 继续，并写入同一 Transcript", async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  let run = await f.running(idea);
  const answer = f.host.ask(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_input");
  let history = await f.call("executions", { id: idea.id, cursor: null, limit: 20 });
  const question = history.executions[0].attention.request;
  assert.equal(question.kind, "user_input");
  assert.equal(question.fields[0].options[0].value, "family");
  await f.call("respond", { id: idea.id, operationId: id(), runId: run.id, requestId: question.requestId,
    response: { action: "submit", answers: { audience: "family" } } });
  assert.deepEqual(await answer, { action: "accept", content: { audience: "family" } });
  run = f.dispatcher.getRun(run.id);
  const approval = f.host.approve(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  history = await f.call("executions", { id: idea.id, cursor: null, limit: 20 });
  const request = history.executions[0].attention.request;
  assert.equal(request.kind, "runtime_approval");
  await f.call("respond", { id: idea.id, operationId: id(), runId: run.id, requestId: request.requestId,
    response: { choice: "once" } });
  assert.deepEqual(await approval, { decision: "accept" });
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const events = f.transcript.listEvents(run.profileId, session.id);
  assert.equal(events.filter((event) => event.content.transcriptType === "interaction.response").length, 2);
  assert.equal(f.host.turnStarts, 1);
  f.host.complete(run, "已创建咖啡记录方案");
  await until(() => f.dispatcher.getRun(run.id).status === "completed");
  assert.equal((await f.call("get", { id: idea.id })).idea.status, "completed");
  assert.equal((await f.call("executions", { id: idea.id, cursor: null, limit: 20 })).executions[0].attention, null);
});

test("灵感授权保留 Grok 工具与服务器范围，响应和记录使用实际选项", async (t) => {
  const { validateInspirationServiceResult } = require("../app/agent-service/inspiration-service-protocol");
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approvalOptions = [
    { choice: "once", label: "Allow once", kind: "allow_once" },
    { choice: "runtime:1", label: "Always allow this tool", kind: "allow_always", scope: "tool" },
    { choice: "runtime:2", label: "Always allow this server", kind: "allow_always", scope: "server" },
    { choice: "deny", label: "Reject", kind: "reject_once" },
  ];
  const response = f.host.request("item/commandExecution/requestApproval", {
    threadId: run.codexThreadId, turnId: run.codexTurnId, itemId: "grok-tool",
    command: "shoggoth__kanban_card_create", sessionApprovalAvailable: false, approvalOptions,
  });
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  const history = await f.call("executions", { id: idea.id, cursor: null, limit: 20 });
  validateInspirationServiceResult("inspiration.executions", history);
  const request = history.executions[0].attention.request;
  assert.deepEqual(request.approvalOptions, approvalOptions);
  assert.deepEqual(request.approvalChoices, ["once", "runtime:1", "runtime:2", "deny", "cancel"]);
  for (const choice of ["session", "runtime:31"]) {
    await assert.rejects(f.call("respond", { id: idea.id, operationId: id(), runId: run.id,
      requestId: request.requestId, response: { choice } }), { code: "INTERACTION_RESPONSE_INVALID" });
    assert.equal(f.dispatcher.getRun(run.id).waitingRequestId, request.requestId);
  }
  for (const malformed of ["runtime:2", ["once", "session", "runtime:1", "runtime:2", "deny", "cancel"]]) {
    const invalid = structuredClone(history);
    invalid.executions[0].attention.request.approvalChoices = malformed;
    assert.throws(() => validateInspirationServiceResult("inspiration.executions", invalid),
      { code: "INSPIRATION_RESPONSE_INVALID" });
  }
  await f.call("respond", { id: idea.id, operationId: id(), runId: run.id,
    requestId: request.requestId, response: { choice: "runtime:2" } });
  assert.deepEqual(await response, { decision: "accept", approvalChoice: "runtime:2" });
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  const reply = f.transcript.listEvents(run.profileId, session.id)
    .find((event) => event.content.transcriptType === "interaction.response");
  assert.equal(reply.content.text, "授权：Always allow this server");
  assert.equal(f.host.turnStarts, 1);
});

test("从会话处理请求后卡片同步结算；过期授权和跨灵感响应被拒绝", async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approval = f.host.approve(run);
  await until(() => f.dispatcher.getRun(run.id).status === "waiting_approval");
  const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
  await f.coordinator.respondApproval({ operationId: id(), runId: run.id, requestId, choice: "deny" });
  assert.deepEqual(await approval, { decision: "decline" });
  assert.equal((await f.call("executions", { id: idea.id, cursor: null, limit: 20 })).executions[0].attention, null);
  await assert.rejects(f.call("respond", { id: idea.id, operationId: id(), runId: run.id, requestId,
    response: { choice: "once" } }), { code: "INSPIRATION_REQUEST_EXPIRED" });
  const other = await f.create("另一条灵感");
  await assert.rejects(f.call("respond", { id: other.id, operationId: id(), runId: run.id, requestId,
    response: { choice: "once" } }), { code: "INSPIRATION_BINDING_INVALID" });
});

test("成果后继续沿用 Session；重启打断等待，保留问题但不重放旧授权", async (t) => {
  const f = await fixture(t);
  let idea = await f.start(await f.create());
  let run = await f.running(idea);
  f.host.complete(run, "第一版已完成");
  await until(() => f.dispatcher.getRun(run.id).status === "completed");
  idea = await f.start((await f.call("get", { id: idea.id })).idea, "增加搜索");
  const next = await f.running(idea);
  assert.equal(f.coordinator.getRunSessionKey(run), f.coordinator.getRunSessionKey(next));
  assert.equal(f.host.threads.length, 1);
  const waiting = f.host.ask(next);
  await until(() => f.dispatcher.getRun(next.id).status === "waiting_input");
  await f.restart();
  await waiting;
  await until(() => f.dispatcher.getRun(next.id).status === "interrupted");
  const history = await f.call("executions", { id: idea.id, cursor: null, limit: 20 });
  assert.equal(history.executions[0].attention.active, false);
  assert.equal(history.executions[0].attention.request.message, "主要给谁使用？");
  assert.equal(f.host.turnStarts, 2);
});

test("回答回执持久幂等，重试不重复提交且不能更换答案", async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const answer = f.host.ask(run);
  await until(() => f.dispatcher.getRun(run.id).status === 'waiting_input');
  const input = { id: idea.id, operationId: id(), runId: run.id,
    requestId: f.dispatcher.getRun(run.id).waitingRequestId,
    response: { action: 'submit', answers: { audience: 'family' } } };
  await f.call('respond', input); await answer;
  assert.equal((await f.call('respond', input)).idea.id, idea.id);
  await assert.rejects(f.call('respond', { ...input, response: { action: 'submit', answers: { audience: 'friends' } } }), { code: 'INSPIRATION_OPERATION_CONFLICT' });
  await f.restart();
  assert.equal((await f.call('respond', input)).idea.id, idea.id);
  assert.equal(f.host.turnStarts, 1);
});

test("启动准备和准入失败都终结意图，修复后可新一轮开始", async (t) => {
  const f = await fixture(t);
  const createSession = f.sessions.createSession.bind(f.sessions);
  f.sessions.createSession = () => { throw Object.assign(new Error('session capacity'), { code: 'CHAT_SESSION_LIMIT' }); };
  let idea = await f.start(await f.create());
  assert.equal(idea.status, 'failed');
  assert.equal(idea.latestExecution.errorCode, 'CHAT_SESSION_LIMIT');
  assert.equal(f.host.turnStarts, 0);
  f.sessions.createSession = createSession;
  idea = await f.start(idea);
  const run = await f.running(idea);
  await f.call('cancel', { id: idea.id, operationId: id(), runId: run.id });
  assert.equal((await f.call('get', { id: idea.id })).idea.status, 'canceled');
  assert.equal(f.coordinator.getMemoryStats().domainCommands, 0);
});

test("未启动的持久意图在重开后只恢复一次，输入快照不受后续编辑影响", async (t) => {
  const f = await fixture(t);
  const original = await f.create('重启前的原始想法');
  const workspace = fs.realpathSync(f.root);
  const execution = f.store.prepareExecution({ id: original.id, expectedRevision: original.revision,
    operationId: id(), instruction: '保留快照', agentId: f.profile.agentId, backendId: f.profile.backendId,
    profileId: f.profile.id, workspace }, () => true);
  await f.call('update', { id: original.id, expectedRevision: 2, operationId: id(), patch: { body: '重启前的新编辑' } });
  await f.restart();
  const idea = (await f.call('get', { id: original.id })).idea;
  await f.running(idea);
  assert.equal(f.host.turnStarts, 1);
  assert.equal(f.store.executionForRun(execution.runId).body, original.body);
});

test("私有写入失败不伪报成功；完整备份恢复原文与执行关联", async (t) => {
  const f = await fixture(t);
  const idea = await f.create('备份中的灵感');
  const write = f.store.commitTransaction;
  f.store.commitTransaction = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(f.call('update', { id: idea.id, expectedRevision: 1, operationId: id(), patch: { body: '不应写入' } }), { code: 'ENOSPC' });
  assert.equal(f.store.get(idea.id).body, idea.body);
  f.store.commitTransaction = write;
  const { createAuthorityBackup, restoreAuthorityBackup } = require('../app/agent-service/authority-backup');
  assert.throws(() => createAuthorityBackup({ paths: f.paths, backupId: 'inspiration-test' }), { code: 'BACKUP_SERVICE_ACTIVE' });
  f.service.close(); await f.coordinator.close(); f.transcript.close(); f.sessions.close(); f.store.close(); f.productStore.close();
  const backup = createAuthorityBackup({ paths: f.paths, backupId: 'inspiration-test' });
  assert.ok(backup.manifest.entries.some((entry) => entry.path === 'inspirations.sqlite'));
  const destinationStateDir = path.join(f.root, 'restored');
  restoreAuthorityBackup({ paths: f.paths, backupId: 'inspiration-test', destinationStateDir });
  const restored = new InspirationStore({ paths: { ...f.paths, stateDir: destinationStateDir } }).open();
  assert.equal(restored.get(idea.id).body, idea.body);
  assert.equal(fs.statSync(path.join(destinationStateDir, 'inspirations.sqlite')).mode & 0o777, 0o600);
  restored.close();
});

test("严格协议拒绝伪造会话、未知字段及编码后超限正文", async (t) => {
  const f = await fixture(t);
  const { validateInspirationServiceResult } = require('../app/agent-service/inspiration-service-protocol');
  const idea = await f.start(await f.create());
  assert.throws(() => validateInspirationServiceResult('inspiration.get', { idea: { ...idea, extra: true } }), { code: 'INSPIRATION_RESPONSE_INVALID' });
  const forged = structuredClone(idea); forged.latestExecution.ideaId = id();
  assert.throws(() => validateInspirationServiceResult('inspiration.get', { idea: forged }), { code: 'INSPIRATION_RESPONSE_INVALID' });
  await assert.rejects(f.call('create', { operationId: id(), body: '\\'.repeat(8192) }), { code: 'INSPIRATION_INVALID' });
});

test("Runtime 启动失败会释放槽位，修复后继续；更换目录另建 Session", async (t) => {
  const f = await fixture(t);
  const accountRead = f.host.accountRead.bind(f.host);
  f.host.accountRead = async () => { throw Object.assign(new Error('fake unavailable'), { code: 'RPC_REMOTE_ERROR' }); };
  let idea = await f.start(await f.create());
  await until(() => f.dispatcher.getRun(idea.latestExecution.runId)?.status === 'failed');
  assert.equal(f.coordinator.getMemoryStats().domainCommands, 0);
  assert.ok((await f.call('list', { query: '', filter: 'active', cursor: null, limit: 20 })).items.some(item => item.id === idea.id),
    '没有全部筛选时，执行失败仍须出现在推进阶段，保留重试入口');
  f.host.accountRead = accountRead;
  idea = await f.start((await f.call('get', { id: idea.id })).idea);
  const run = await f.running(idea);
  f.host.complete(run);
  await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  const current = (await f.call('get', { id: idea.id })).idea;
  const workspace = fs.realpathSync(f.root);
  const next = (await f.call('start', { id: idea.id, expectedRevision: current.revision, operationId: id(),
    agentId: f.profile.agentId, backendId: f.profile.backendId, workspace, instruction: '在另一目录继续' })).idea;
  await f.running(next);
  assert.notEqual(next.latestExecution.sessionKey, current.latestExecution.sessionKey);
  assert.equal(f.store.executions(idea.id).length, 3);
  await assert.rejects(f.coordinator.abort({ operationId: id(), sessionKey: current.latestExecution.sessionKey,
    runId: next.latestExecution.runId }), { code: 'WORK_RUN_CONTROL_MISMATCH' });
});

for (const lostStartResponse of [false, true]) test(
  `会话创建失败后，重启服务恢复原灵感（${lostStartResponse ? '创建回执丢失' : '尚未创建会话'}）`, async (t) => {
  const f = await fixture(t);
  const threadStart = f.host.threadStart.bind(f.host);
  const threadList = f.host.threadList.bind(f.host);
  f.host.threadStart = async (params) => {
    if (lostStartResponse) await threadStart(params);
    throw Object.assign(new Error('MCP initialization failed'), { code: 'RPC_REMOTE_ERROR' });
  };
  f.host.threadList = async (params) => {
    if (lostStartResponse && f.host.threads.length) {
      throw Object.assign(new Error('Runtime temporarily unavailable'), { code: 'RPC_REMOTE_ERROR' });
    }
    return threadList(params);
  };
  const idea = await f.start(await f.create('保留创建失败前的灵感原文'));
  const { sessionKey, runId } = idea.latestExecution;
  await f.coordinator.waitForIdle(runId);
  await until(() => f.dispatcher.getRun(runId)?.status === 'failed');
  assert.equal(f.dispatcher.getRun(runId).errorCode, 'RUNTIME_START_SESSION_START_OR_RESUME_FAILED');
  assert.equal(f.sessions.getSession(sessionKey).status, 'binding');
  assert.equal(f.sessions.getSession(sessionKey).runtimeSessionId, null);
  const binding = f.sessions.listPendingBindings().find(value => value.sessionKey === sessionKey);
  assert.ok(binding);
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.host.threads.length, Number(lostStartResponse));

  f.host.threadStart = threadStart;
  f.host.threadList = threadList;
  await f.restart();
  const input = { operationId: id(), sessionKey, prompt: '恢复后继续，只需简短回复' };
  const next = f.service.sendFromSession(input);
  assert.equal(f.service.sendFromSession(input).run.id, next.run.id);
  const updated = (await f.call('get', { id: idea.id })).idea;
  assert.equal(updated.latestExecution.sessionKey, sessionKey);
  assert.equal(updated.latestExecution.retryOf, runId);
  const run = await f.running(updated);
  assert.equal(f.sessions.listSessions().length, 1);
  assert.equal(f.host.threads.length, 1);
  assert.equal(f.host.threads[0].threadSource, binding.threadSource);
  assert.equal(f.sessions.getSession(sessionKey).status, 'ready');
  assert.equal(f.host.turnStarts, 1);
  f.host.complete(run, '恢复成功');
  await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  const session = f.sessions.getSession(sessionKey);
  const events = f.transcript.listEvents(f.profile.id, session.id);
  assert.deepEqual(events.filter(event => event.kind === 'user').map(event => event.content.text),
    ['保留创建失败前的灵感原文', input.prompt]);
  assert.ok(events.some(event => event.runId === runId && event.kind === 'error'));
  assert.ok(events.some(event => event.runId === run.id && event.kind === 'assistant'));
});

test('会话续写固定原绑定，归档会话不能另开 Session 执行', async (t) => {
  const f = await fixture(t);
  let idea = await f.start(await f.create());
  let run = await f.running(idea);
  const originalSession = idea.latestExecution.sessionKey;
  f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  const archiveId = id();
  f.sessions.requestArchive(originalSession, archiveId, Date.now());
  f.sessions.completeRemoteOperation(archiveId);
  const count = f.store.executions(idea.id).length;
  assert.throws(() => f.service.sendFromSession({ sessionKey: originalSession, operationId: id(), prompt: '不能暗中创建新会话' }), { code: 'INSPIRATION_BINDING_INVALID' });
  assert.equal(f.store.executions(idea.id).length, count);
  idea = await f.start((await f.call('get', { id: idea.id })).idea);
  run = await f.running(idea);
  assert.notEqual(idea.latestExecution.sessionKey, originalSession);
  f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === 'completed');
  const input = { sessionKey: idea.latestExecution.sessionKey, operationId: id(), prompt: '会话内继续' };
  const next = f.service.sendFromSession(input);
  assert.equal(f.store.executionForRun(next.run.id).sessionKey, input.sessionKey);
  assert.equal(f.service.sendFromSession(input).run.id, next.run.id);
  assert.equal(f.store.executions(idea.id).length, count + 2);
});

test('已归档灵感的会话返回明确原因且恢复后可在原会话续写', async (t) => {
  const f = await fixture(t);
  let idea = await f.start(await f.create());
  const first = await f.running(idea);
  const sessionKey = idea.latestExecution.sessionKey;
  f.host.complete(first);
  await until(() => f.dispatcher.getRun(first.id).status === 'completed');
  idea = (await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision,
    patch: { archived: true } })).idea;
  const count = f.dispatcher.listRuns().length;
  assert.throws(() => f.service.sendFromSession({ operationId: id(), sessionKey, prompt: '继续' }), error => {
    assert.equal(mapChatServiceError(error).code, 'INSPIRATION_ARCHIVED');
    return true;
  });
  assert.equal(f.dispatcher.listRuns().length, count);
  await f.call('update', { id: idea.id, operationId: id(), expectedRevision: idea.revision, patch: { archived: false } });
  const next = f.service.sendFromSession({ operationId: id(), sessionKey, prompt: '恢复后继续' });
  assert.equal(f.store.executionForRun(next.run.id).sessionKey, sessionKey);
});

test('会话输入框续写在排队、运行和完成时均满足 Chat 响应契约', async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const first = await f.running(idea);
  f.host.complete(first);
  await until(() => f.dispatcher.getRun(first.id).status === 'completed');
  const input = { operationId: id(), sessionKey: idea.latestExecution.sessionKey, prompt: '从会话继续完善' };
  const queued = validateChatServiceResult('chat.send', f.service.sendFromSession(input));
  assert.equal(queued.disposition, 'queued');
  assert.ok(queued.reason);
  await until(() => f.dispatcher.getRun(queued.run.id).status === 'running');
  const running = validateChatServiceResult('chat.send', f.service.sendFromSession(input));
  assert.equal(running.disposition, 'started');
  assert.equal(running.reason, null);
  f.host.complete(running.run);
  await until(() => f.dispatcher.getRun(running.run.id).status === 'completed');
  const completed = validateChatServiceResult('chat.send', f.service.sendFromSession(input));
  assert.equal(completed.disposition, 'completed');
  assert.equal(completed.run.id, queued.run.id);
  assert.equal(f.productStore.listWorkRuns().length, 2);
  assert.equal(f.sessions.listSessions().length, 1);
});

test('密码字段传给 Runtime，但不进入可见 Session 历史', async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const answer = f.host.request('mcpServer/elicitation/request', { threadId: run.codexThreadId,
    turnId: run.codexTurnId, serverName: 'inspiration-fixture', message: '输入访问口令',
    requestedSchema: { type: 'object', properties: { passphrase: { type: 'string', writeOnly: true } }, required: ['passphrase'] } });
  await until(() => f.dispatcher.getRun(run.id).status === 'waiting_input');
  const value = 'unregistered-private-value';
  await f.call('respond', { id: idea.id, operationId: id(), runId: run.id,
    requestId: f.dispatcher.getRun(run.id).waitingRequestId,
    response: { action: 'submit', answers: { passphrase: value } } });
  assert.equal((await answer).content.passphrase, value);
  const session = f.sessions.getSession(idea.latestExecution.sessionKey);
  assert.equal(JSON.stringify(f.transcript.listEvents(run.profileId, session.id)).includes(value), false);
  assert.equal(fs.readFileSync(f.store.filePath, 'utf8').includes(value), false);
});

test('权限范围完整可见，无法完整展示的审批仅可拒绝或取消', async (t) => {
  const f = await fixture(t);
  const idea = await f.start(await f.create());
  const run = await f.running(idea);
  const approval = f.host.request('item/permissions/requestApproval', { threadId: run.codexThreadId,
    turnId: run.codexTurnId, itemId: 'permissions', reason: '需要目录权限',
    permissions: { fileSystem: { write: [run.workspace] } } });
  await until(() => f.dispatcher.getRun(run.id).status === 'waiting_approval');
  let attention = (await f.call('executions', { id: idea.id, cursor: null, limit: 1 })).executions[0].attention;
  assert.ok(attention.details.includes(run.workspace));
  await f.call('respond', { id: idea.id, operationId: id(), runId: run.id,
    requestId: attention.request.requestId, response: { choice: 'deny' } });
  await approval;
  const oversized = f.host.request('item/commandExecution/requestApproval', { threadId: run.codexThreadId,
    turnId: run.codexTurnId, itemId: 'too-large', command: 'x'.repeat(40 * 1024), reason: 'Large approval' });
  await until(() => f.dispatcher.getRun(run.id).status === 'waiting_approval');
  attention = (await f.call('executions', { id: idea.id, cursor: null, limit: 1 })).executions[0].attention;
  assert.deepEqual(attention.request.approvalChoices, ['deny', 'cancel']);
  assert.equal(attention.command, null);
  await f.call('respond', { id: idea.id, operationId: id(), runId: run.id,
    requestId: attention.request.requestId, response: { choice: 'deny' } });
  await oversized;
});
