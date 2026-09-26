#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startInspirationFixture } = require('./fixtures/inspiration-service-fixture.cjs');
const id = () => crypto.randomUUID();
async function runInspirationRestSmoke() {
  const fixture = await startInspirationFixture();
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
    assert.equal((await request('/agent-dock')).data.agents.find(value => value.id === agent.id).executionCount, 0);
    const start = { operationId: id(), expectedRevision: idea.revision, agentId: agent.id, backendId: agent.backendId, workspace: null, instruction: '' };
    const first = await request(`/start?id=${idea.id}`, 'POST', start);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    idea = first.data.idea;
    assert.match(idea.latestExecution.sessionHref, /^\/chat\?backend=/);
    assert.equal((await request(`/start?id=${idea.id}`, 'POST', start)).data.idea.latestExecution.runId, idea.latestExecution.runId);
    assert.equal((await request('/agent-dock')).data.agents.find(value => value.id === agent.id).executionCount, 1);
    const scope = new URLSearchParams({ backendId: agent.backendId, agentId: agent.id });
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
      prompt: '从 Session 输入框继续完善', createdAt: Date.now() };
    const followup = await fixture.ipc('chat.send', followupInput);
    assert.equal(followup.run.source, 'inspiration');
    assert.equal(followup.disposition, 'queued');
    assert.ok(followup.reason);
    const followupDeadline = Date.now() + 8000;
    let approval;
    while (Date.now() < followupDeadline) {
      approval = (await request(`/executions?id=${idea.id}&limit=1`)).data.executions[0];
      if (approval.attention?.active) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(approval.status, 'waiting_approval');
    assert.equal(approval.sessionKey, execution.sessionKey);
    assert.equal((await request(`/respond?id=${idea.id}`, 'POST', {
      operationId: id(), runId: approval.runId, requestId: approval.attention.request.requestId,
      response: { choice: 'deny' },
    })).status, 200);
    await fixture.service.workRunCoordinator.waitForTerminal(approval.runId);
    assert.equal((await fixture.ipc('chat.send', followupInput)).run.id, approval.runId);
    assert.equal(fixture.service.productStore.listWorkRuns().length, 2);
    assert.match(JSON.stringify(await fixture.ipc('chat.history', {
      sessionKey: execution.sessionKey, cursor: null, limit: 100,
    })), /从 Session 输入框继续完善/);
    idea = (await request(detail)).data.idea;
    const patch = { operationId: id(), expectedRevision: idea.revision, patch: { archived: true } };
    idea = (await request(detail, 'PATCH', patch)).data.idea;
    activities = await dashboard('&limit=1');
    assert.equal(activities.items.length, 1);
    assert.equal(activities.hasMore, true, 'Dashboard includes both rounds of archived inspirations');
    const secondPage = await dashboard(`&limit=1&cursor=${encodeURIComponent(activities.nextCursor)}`);
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0].id, activities.items[0].id);
    assert.equal(secondPage.items[0].inspiration.runId, execution.runId);
    assert.equal(secondPage.items[0].inspiration.status, 'completed');
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
    console.log('PASS Inspiration REST save/edit/filter/start/respond/session/archive/delete; archive gating and deletion preserve Session history');
  } finally { await fixture.close(); }
}
module.exports = { runInspirationRestSmoke };
if (require.main === module) runInspirationRestSmoke().catch(error => { console.error(error); process.exitCode = 1; });
