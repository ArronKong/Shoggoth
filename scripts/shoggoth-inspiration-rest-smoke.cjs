#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requestService, readClientToken } = require('../app/agent-service/client');
const { startInspirationFixture } = require('./fixtures/inspiration-service-fixture.cjs');
const id = () => crypto.randomUUID();
async function runInspirationRestSmoke() {
  const approvalCommand = `echo ${'x'.repeat(24 * 1024 - 64)}`;
  const fixture = await startInspirationFixture({ isolatedHome: true, permissionMode: 'request-approval',
    codexFakeEnv: { CODEX_FAKE_INSPIRATION_APPROVAL_COMMAND: approvalCommand, CODEX_FAKE_MODEL_CATALOG: '1' } });
  const request = async (route = '', method = 'GET', body) => {
    const response = await fetch(`${fixture.url}/__api/inspirations${route}`, { method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request()).data.total, 0);
    const input = { operationId: id(), body: 'REST 灵感回归' };
    let idea = (await request('', 'POST', input)).data.idea;
    assert.ok(idea?.id);
    await assert.rejects(requestService(fixture.paths, { id: id(), token: readClientToken(fixture.paths),
      version: 27, method: 'inspiration.get', params: { id: idea.id } }), { code: 'PROTOCOL_VERSION_MISMATCH' });
    assert.deepEqual((await fixture.ipc('inspiration.get', { id: idea.id })).idea.rounds, { count: 0, agents: [] });
    assert.equal((await request('', 'POST', input)).data.idea.id, idea.id);
    assert.equal(fixture.service.productStore.listWorkRuns().length, 0);
    const detail = `/detail?id=${idea.id}`;
    const prematureArchive = await request(detail, 'PATCH', { operationId: id(), expectedRevision: idea.revision, patch: { archived: true } });
    assert.equal(prematureArchive.status, 409);
    assert.equal(prematureArchive.data.code, 'INSPIRATION_NOT_COMPLETED');
    idea = (await request(detail, 'PATCH', { operationId: id(), expectedRevision: idea.revision, patch: { favorite: true } })).data.idea;
    assert.equal((await request('?query=REST&filter=favorite')).data.total, 1);
    assert.equal((await request(detail, 'PATCH', { operationId: id(), expectedRevision: 1, patch: { body: '冲突' } })).status, 409);
    assert.equal((await request(`/detail?id=${id()}`)).status, 404);
    const { agents } = (await request('/agents')).data;
    const agent = agents.find(value => value.capabilities.execute);
    assert.ok(agent);
    const scope = new URLSearchParams({ backendId: agent.backendId, agentId: agent.id });
    const sessionsBefore = fixture.service.chatSessionStore.listSessions().length;
    const models = await request(`/models?${scope}`);
    assert.equal(models.status, 200, JSON.stringify(models.data));
    const choice = models.data.models.find(model => model.id === 'fake-model' && model.bindingId === models.data.defaultBindingId);
    assert.ok(choice, JSON.stringify(models.data));
    assert.equal(fixture.service.chatSessionStore.listSessions().length, sessionsBefore, 'The seed model menu must not create a Session');
    assert.equal(fixture.service.productStore.listWorkRuns().length, 0, 'The seed model menu must not run the note');
    assert.equal((await request('/agent-dock')).data.agents.find(value => value.id === agent.id).executionCount, 0);
    const start = { operationId: id(), expectedRevision: idea.revision, agentId: agent.id, backendId: agent.backendId, workspace: null, instruction: '',
      modelSelection: { model: choice.id, bindingId: choice.bindingId } };
    const first = await request(`/start?id=${idea.id}`, 'POST', start);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    idea = first.data.idea;
    assert.match(idea.latestExecution.sessionHref, /^\/chat\?backend=/);
    assert.equal((await request(`/start?id=${idea.id}`, 'POST', start)).data.idea.latestExecution.runId, idea.latestExecution.runId);
    assert.equal((await request('/agent-dock')).data.agents.find(value => value.id === agent.id).executionCount, 1);
    const scoped = await request(`?${scope}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.data));
    assert.deepEqual(scoped.data.items.map(item => item.id), [idea.id]);
    assert.equal((await request(`?${new URLSearchParams({ backendId: 'hermes', agentId: agent.id })}`)).data.total, 0);
    assert.equal((await request(`?${new URLSearchParams({ backendId: agent.backendId, agentId: 'unused' })}`)).data.total, 0);
    assert.equal((await request(`?backendId=${encodeURIComponent(agent.backendId)}`)).status, 400);
    assert.equal((await request(`?agentId=${encodeURIComponent(agent.id)}`)).status, 400);
    const deadline = Date.now() + 8000;
    let execution;
    while (Date.now() < deadline) {
      execution = (await request(`/executions?id=${idea.id}&limit=1`)).data.executions[0];
      if (execution.attention?.active || ['failed','interrupted'].includes(execution.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(execution.status, 'waiting_input', JSON.stringify(execution));
    assert.equal(fixture.service.chatSessionStore.getSession(execution.sessionKey).modelOverride, choice.id);
    assert.equal(fixture.service.chatSessionStore.getSession(execution.sessionKey).runtimeBindingId, choice.bindingId);
    assert.equal(fixture.service.workRunCoordinator.getRuntimeContextForSource(execution.profileId, 'inspiration', idea.id).effectiveModel, choice.id);
    const dashboard = async (query = '') => {
      fixture.registry._activityCache = null;
      const response = await fetch(`${fixture.url}/__api/dashboard/activities?kind=inspiration${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    let activities = await dashboard();
    assert.equal(activities.items.length, 1);
    assert.equal(activities.items[0].kind, 'inspiration');
    assert.equal(activities.items[0].inspiration.ideaId, idea.id);
    assert.equal(activities.items[0].inspiration.status, 'waiting_input');
    const activity = await request(`/activity?id=${idea.id}&runId=${execution.runId}`);
    assert.equal(activity.status, 200, JSON.stringify(activity.data));
    assert.equal(activity.data.runId, execution.runId);
    assert.equal(activity.data.trajectory.supported, true, JSON.stringify(activity.data));
    assert.ok(activity.data.trajectory.parts.length > 0);
    assert.equal((await request(`/activity?id=${idea.id}&runId=${id()}`)).status, 400);
    assert.equal((await request(detail, 'DELETE', { operationId: id(), expectedRevision: idea.revision })).status, 409);
    const response = { operationId: id(), runId: execution.runId, requestId: execution.attention.request.requestId,
      response: { action: 'submit', answers: { choice: 'Alpha' } } };
    assert.equal((await request(`/respond?id=${idea.id}`, 'POST', response)).status, 200);
    assert.equal((await request(`/respond?id=${idea.id}`, 'POST', response)).status, 200);
    await fixture.service.workRunCoordinator.waitForTerminal(execution.runId);
    const history = await fixture.ipc('chat.history', { sessionKey: execution.sessionKey, cursor: null, limit: 100 });
    assert.match(JSON.stringify(history), /REST 灵感回归/);
    assert.match(JSON.stringify(history), /Alpha/);
    assert.equal(fixture.service.productStore.listWorkRuns().length, 1);
    const followupInput = { operationId: id(), sessionKey: execution.sessionKey,
      prompt: `从 Session 输入框继续完善\n${'a'.repeat(16 * 1024 - 128)}`, createdAt: Date.now() };
    const followup = await fixture.ipc('chat.send', followupInput);
    assert.equal(followup.run.source, 'inspiration');
    assert.equal(followup.disposition, 'queued');
    assert.ok(followup.reason);
    const followupDeadline = Date.now() + 8000;
    let approval;
    while (Date.now() < followupDeadline) {
      const page = await request(`/executions?id=${idea.id}&limit=1`);
      assert.equal(page.status, 200, JSON.stringify(page.data));
      approval = page.data.executions[0];
      if (approval.attention?.active) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(approval.status, 'waiting_approval');
    assert.equal(approval.sessionKey, execution.sessionKey);
    assert.equal(approval.instruction, followupInput.prompt);
    assert.equal(approval.attention.request.approvalDetails.command, approvalCommand);
    assert.ok(Buffer.byteLength(JSON.stringify(approval)) > 64 * 1024, 'the entire round crosses the previous frame limit');
    assert.equal((await request(`/respond?id=${idea.id}`, 'POST', {
      operationId: id(), runId: approval.runId, requestId: approval.attention.request.requestId,
      response: { choice: 'deny' },
    })).status, 200);
    await fixture.service.workRunCoordinator.waitForTerminal(approval.runId);
    assert.equal((await fixture.ipc('chat.send', followupInput)).run.id, approval.runId);
    assert.equal(fixture.service.productStore.listWorkRuns().length, 2);
    const executionHistory = (await request(`/executions?id=${idea.id}`)).data;
    assert.equal(executionHistory.total, 2);
    assert.equal(executionHistory.executions[0].instruction, followupInput.prompt);
    assert.equal(executionHistory.executions[0].reusableSession, true);
    assert.match(JSON.stringify(await fixture.ipc('chat.history', {
      sessionKey: execution.sessionKey, cursor: null, limit: 100,
    })), /从 Session 输入框继续完善/);
    idea = (await request(detail)).data.idea;
    const adopt = { operationId: id(), expectedRevision: idea.revision, patch: { acceptedRunId: execution.runId } };
    const rejected = await request(detail, 'PATCH', { ...adopt, patch: { acceptedRunId: id() } });
    assert.equal(rejected.data.code, 'INSPIRATION_REPLY_UNAVAILABLE');
    const chosen = await request(detail, 'PATCH', adopt);
    assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
    idea = chosen.data.idea;
    assert.equal(idea.acceptedRunId, execution.runId);
    assert.equal((await request(detail, 'PATCH', adopt)).data.idea.revision, idea.revision, 'Adopting again with the same operation ID must not write');
    const newestPage = await request(`/executions?id=${idea.id}&limit=1`);
    assert.equal(newestPage.data.executions[0].runId, approval.runId);
    assert.equal((await request(detail)).data.acceptedExecution.runId, execution.runId, 'The older reply is readable outside the current history page');
    const patch = { operationId: id(), expectedRevision: idea.revision, patch: { archived: true } };
    idea = (await request(detail, 'PATCH', patch)).data.idea;
    assert.equal((await request(detail)).data.acceptedExecution.runId, execution.runId, 'Archiving keeps the chosen reply');
    activities = await dashboard('&limit=1');
    assert.equal(activities.items.length, 1);
    assert.equal(activities.items[0].inspiration.ideaId, idea.id);
    assert.equal(activities.items[0].inspiration.runId, approval.runId, 'Dashboard shows the latest round of the archived note');
    assert.equal(activities.hasMore, false, 'Older rounds do not create another Dashboard page');
    assert.equal(activities.nextCursor, undefined);
    assert.equal((await request()).data.total, 0);
    assert.equal((await request('?filter=archived')).data.total, 1);
    assert.equal((await request(`/start?id=${idea.id}`, 'POST', { ...start, operationId: id(), expectedRevision: idea.revision })).status, 409);
    const remove = { operationId: id(), expectedRevision: idea.revision };
    const removed = await request(detail, 'DELETE', remove);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(removed.data, { id: idea.id, deleted: true });
    assert.equal((await dashboard()).items.length, 0, 'Deleted inspiration text must not reappear in Dashboard');
    assert.equal((await request(detail, 'DELETE', remove)).status, 200);
    assert.equal((await request(detail)).status, 404);
    assert.equal((await request('?filter=archived')).data.total, 0);
    assert.equal((await request('/agent-dock')).data.agents.find(value => value.id === agent.id).executionCount, 2);
    assert.equal((await request(`/start?id=${idea.id}`, 'POST', start)).status, 404);
    assert.match(JSON.stringify(await fixture.ipc('chat.history', { sessionKey: execution.sessionKey, cursor: null, limit: 100 })), /从 Session 输入框继续完善/);
    // Seed a terminal provider failure in this isolated Service. The public
    // activity route must expose the same bounded Chat projection without opening Chat first.
    const { inspirationStore, chatSessionStore, transcriptStore, workDispatcher } = fixture.service;
    const failedIdea = inspirationStore.create({ operationId: id(), body: '想做一个实时新闻页面' });
    let failed = inspirationStore.prepareExecution({ id: failedIdea.id, operationId: id(), expectedRevision: failedIdea.revision,
      instruction: '', agentId: agent.id, backendId: agent.backendId, profileId: execution.profileId, workspace: execution.workspace }, () => true);
    const failedSession = chatSessionStore.createSession({ operationId: id(), profileId: execution.profileId,
      workspace: execution.workspace, createdAt: Date.now() });
    transcriptStore.ensureSession({ profileId: execution.profileId, sessionId: failedSession.id });
    failed = inspirationStore.bindSession(failed.id, failedSession.sessionKey);
    workDispatcher.enqueue({ id: failed.runId, source: 'inspiration', sourceId: failedIdea.id,
      idempotencyKey: `inspiration:${failed.operationId}`, profileId: failed.profileId, workspace: failed.workspace });
    workDispatcher.admit(failed.runId);
    workDispatcher.transition(failed.runId, 'running');
    workDispatcher.transition(failed.runId, 'failed', { errorCode: 'RUNTIME_QUOTA_EXHAUSTED' });
    transcriptStore.appendEvent({ id: id(), profileId: failed.profileId, sessionId: failedSession.id, runId: failed.runId,
      kind: 'error', content: { transcriptType: 'terminal', status: 'failed', errorCode: 'RUNTIME_QUOTA_EXHAUSTED',
        resultSummary: null, failure: { message: 'Quota exceeded. Check your plan and billing details.' } } });
    const failureActivity = await request(`/activity?id=${failedIdea.id}&runId=${failed.runId}`);
    assert.equal(failureActivity.status, 200, JSON.stringify(failureActivity.data));
    assert.equal(failureActivity.data.errorMessage, '错误：当前账号额度已用尽，本次请求已停止，不会继续排队。请等待额度恢复、补充额度或更换账号后重试\n'
      + '上游原因：Quota exceeded. Check your plan and billing details.\n错误码：RUNTIME_QUOTA_EXHAUSTED');
    assert.equal((await request(`/activity?id=${failedIdea.id}&runId=${execution.runId}`)).status, 400);
    console.log('PASS Inspiration REST save/edit/filter/start/respond/session/archive/delete; archive gating and deletion preserve Session history');
    console.log('PASS Inspiration REST failure details match Chat before opening its Session, with exact round ownership');
  } finally { await fixture.close(); }
}
module.exports = { runInspirationRestSmoke };
if (require.main === module) runInspirationRestSmoke().catch(error => { console.error(error); process.exitCode = 1; });
