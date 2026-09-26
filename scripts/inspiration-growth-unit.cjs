'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { fixture, until } = require('./fixtures/inspiration-coordinator-fixture.cjs');
const immediate = () => new Promise(setImmediate);
const executor = profile => ({ agentId: profile.agentId, backendId: profile.backendId });
const configure = (f, enabled, executors = [executor(f.profile)]) => f.call('growth.set', {
  expectedRevision: f.store.growthSettings().revision, enabled, executors,
});
const current = (f, idea) => f.service.view(idea.id);
const waitRun = async (f, idea) => {
  await until(() => current(f, idea).latestExecution !== null);
  return f.running(current(f, idea));
};

test('native cold start keeps one durable intent and all remaining seeds intact until ready', async t => {
  const f = await fixture(t);
  let ready = false, checks = 0;
  f.service.readinessClient.request = async (method, params) => {
    assert.equal(method, 'inspiration.executor.ready');
    assert.deepEqual(params, executor(f.profile));
    checks++;
    return { ready };
  };
  const ideas = await Promise.all(Array.from({ length: 4 }, () => f.create()));
  await configure(f, true);
  await until(() => f.service.growth.waitingExecutors.size === 1);
  const pending = f.store.growthJobs(['pending'])[0];
  for (let index = 0; index < 10; index++) { f.service.growth.wake(); await immediate(); }
  assert.equal(checks, 1, 'store events cannot create a readiness retry storm');
  assert.equal(f.host.turnStarts, 0);
  assert.equal(f.store.growthFailures().length, 0);
  assert.ok(ideas.every(idea => current(f, idea).latestExecution === null));
  await f.restart();
  await until(() => f.service.growth.waitingExecutors.size === 1);
  assert.equal(f.store.growthJobs(['pending'])[0].input.operationId, pending.input.operationId);
  ready = true;
  // Simulate the readiness timer waking, without a wall-clock five-second wait.
  f.service.growth.waitingExecutors.clear();
  f.service.growth.wake();
  const run = await waitRun(f, ideas[0]);
  assert.equal(f.store.executionForRun(run.id).operationId, pending.input.operationId);
  assert.equal(f.store.growthJobs(['running'])[0].attempt, 1);
  assert.equal(f.host.turnStarts, 1);
  assert.ok(ideas.slice(1).every(idea => current(f, idea).latestExecution === null));
});

test('a late readiness response cannot dispatch after growth is paused', async t => {
  const f = await fixture(t);
  let resolve;
  f.service.readinessClient.request = () => new Promise(done => { resolve = done; });
  const idea = await f.create();
  await configure(f, true);
  await until(() => resolve);
  await configure(f, false);
  resolve({ ready: true });
  await immediate(); await immediate();
  assert.equal(current(f, idea).latestExecution, null);
  assert.equal(f.host.turnStarts, 0);
});

test('default off; empty queue is idle; saving a seed wakes the queue once', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('growth.get', {})).settings, { enabled: false, revision: 1, executors: [] });
  await configure(f, true);
  await immediate(); await immediate();
  let checks = 0;
  const next = f.store.nextGrowthSeed.bind(f.store);
  f.store.nextGrowthSeed = () => { checks++; return next(); };
  for (let i = 0; i < 5; i++) await f.call('growth.get', {});
  await immediate();
  assert.equal(checks, 0, 'UI reads must not poll the empty work queue');
  const idea = await f.create();
  const run = await waitRun(f, idea);
  assert.equal(f.host.turnStarts, 1);
  for (let i = 0; i < 5; i++) f.service.growth.wake();
  await immediate();
  assert.equal(f.host.turnStarts, 1);
  f.host.complete(run);
  await until(() => f.store.growthJobs(['done']).length === 1);
  assert.equal(f.store.listeners('changed').length, 1);
});

test('multiple executors get random assignments, one idea each, and take the next seed on completion', async t => {
  const f = await fixture(t);
  const other = f.productStore.putAgentProfile({ ...f.profile, id: 'growth-other', agentId: 'growth-other', runtimeProfileId: 'growth-other', isDefault: false });
  const ideas = [];
  for (let i = 0; i < 4; i++) ideas.push(await f.create(`Seed ${i}`));
  f.service.growth.random = () => 0;
  await configure(f, true, [executor(f.profile), executor(other)]);
  const first = await waitRun(f, ideas[0]);
  const second = await waitRun(f, ideas[1]);
  assert.equal(current(f, ideas[0]).latestExecution.agentId, other.agentId, 'Executor order was shuffled');
  assert.notEqual(first.profileId, second.profileId);
  assert.equal(current(f, ideas[2]).latestExecution, null);
  await assert.rejects(f.start(ideas[3]), { code: 'INSPIRATION_AGENT_BUSY' });
  f.host.complete(first);
  const third = await waitRun(f, ideas[2]);
  assert.equal(third.profileId, first.profileId);
  assert.equal(current(f, ideas[3]).latestExecution, null);
  await configure(f, false, [executor(f.profile), executor(other)]);
  f.host.complete(second); f.host.complete(third);
  await until(() => f.store.growthJobs(['done']).length === 3);
  assert.equal(current(f, ideas[3]).latestExecution, null, 'Pause keeps the remaining seeds untouched');
});

test('stopping auto growth keeps the card in roots and failure notices without an automatic retry', async t => {
  const f = await fixture(t);
  const idea = await f.create();
  await configure(f, true);
  const first = await waitRun(f, idea);
  await f.call('cancel', { id: idea.id, runId: first.id, operationId: crypto.randomUUID() });
  await until(() => f.store.growthJobs(['blocked']).length === 1);
  const failure = f.store.growthFailures()[0];
  assert.equal(failure.attempts, 1); assert.equal(failure.errorCode, 'INSPIRATION_CANCELED');
  assert.equal((await f.call('growth.get', {})).failures.length, 1);
  assert.equal(current(f, idea).status, 'canceled', 'Preserve the authoritative reason');
  const list = filter => f.call('list', { filter, query: '', cursor: null, limit: 20 });
  assert.equal((await list('saved')).total, 0);
  assert.equal((await list('active')).items[0].id, idea.id);
  await f.restart(); await immediate(); await immediate();
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.store.growthSettings().enabled, true);
  assert.deepEqual(f.store.growthFailures()[0], failure);
  assert.equal((await f.call('growth.get', {})).failures.length, 1);
  assert.equal((await list('active')).total, 1);
  const manual = await f.start(current(f, idea));
  const run = await f.running(manual);
  assert.equal((await f.call('growth.get', {})).failures.length, 0);
  f.host.complete(run);
});

test('notices use live execution state instead of a stale blocked assignment', async t => {
  const f = await fixture(t);
  const idea = await f.create();
  await configure(f, true);
  const run = await waitRun(f, idea);
  f.service.growth.close();
  const job = f.store.growthJobs(['running'])[0];
  f.store.saveGrowthJob({ ...job, state: 'blocked', errorCode: 'OLD_FAILURE' });
  assert.equal(f.store.growthFailures().length, 1, 'The fixture preserves a stale blocked assignment');
  assert.equal((await f.call('growth.get', {})).failures.length, 0, 'Running work is excluded');
  for (const status of ['waiting_approval', 'waiting_input']) {
    f.dispatcher.transition(run.id, status, { waitingRequestId: crypto.randomUUID() });
    assert.equal((await f.call('growth.get', {})).failures.length, 0, `${status} stays on its note card`);
    f.dispatcher.transition(run.id, 'running', { waitingRequestId: null });
  }
  f.dispatcher.transition(run.id, 'failed', { errorCode: 'EXECUTION_FAILED' });
  assert.equal((await f.call('growth.get', {})).failures[0].runId, run.id, 'Only the failed execution enters notices');
});

test('start failure retries once, then reports its reason; disabling and re-enabling does not reset the budget', async t => {
  const f = await fixture(t);
  const idea = await f.create();
  f.host.threadStart = async () => { throw Object.assign(new Error('fixture unavailable'), { code: 'RUNTIME_START_PROCESS_FAILED' }); };
  await configure(f, true);
  await until(() => f.store.growthFailures().length === 1);
  assert.equal(f.store.executions(idea.id).length, 2);
  assert.ok(f.store.growthFailures()[0].errorCode);
  await configure(f, false); await configure(f, true);
  await immediate(); await immediate();
  assert.equal(f.store.executions(idea.id).length, 2);
});

test('waiting for input occupies the executor; completing the response releases the next seed', async t => {
  const f = await fixture(t);
  const first = await f.create('First'), second = await f.create('Second');
  await configure(f, true);
  const run = await waitRun(f, first);
  const answer = f.host.ask(run);
  await until(() => f.dispatcher.getRun(run.id).status === 'waiting_input');
  f.service.growth.wake(); await immediate();
  assert.equal(current(f, second).latestExecution, null);
  const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
  await f.call('respond', { id: first.id, operationId: crypto.randomUUID(), runId: run.id, requestId,
    response: { action: 'submit', answers: { audience: 'family' } } });
  await answer; f.host.complete(run);
  await waitRun(f, second);
  assert.equal(f.host.turnStarts, 2);
});

test('durable pending dispatch recovers the same operation; settings reject stale and duplicate selections', async t => {
  const f = await fixture(t);
  const idea = await f.create();
  const job = f.service.growth.reserve(idea, executor(f.profile), 1);
  const settings = (await configure(f, true)).settings;
  f.service.growth.close();
  await f.restart();
  const run = await waitRun(f, idea);
  assert.equal(f.store.executionForRun(run.id).operationId, job.input.operationId);
  assert.equal(f.store.executions(idea.id).length, 1);
  await assert.rejects(f.call('growth.set', { expectedRevision: 1, enabled: false, executors: [] }), { code: 'INSPIRATION_REVISION_CONFLICT' });
  await assert.rejects(f.call('growth.set', { expectedRevision: settings.revision, enabled: true,
    executors: [executor(f.profile), executor(f.profile)] }), { code: 'INSPIRATION_INVALID' });
  await assert.rejects(f.call('growth.set', { expectedRevision: settings.revision, enabled: true, executors: [] }), { code: 'INSPIRATION_INVALID' });
});

test('manual stops enter notices without auto growth and are never picked up when it is enabled', async t => {
  const f = await fixture(t);
  const idea = await f.create('Stopped before enabling');
  const first = await f.running(await f.start(idea));
  await f.call('cancel', { id: idea.id, runId: first.id, operationId: crypto.randomUUID() });
  assert.equal(f.store.growthJobs(['blocked', 'running']).length, 0);
  assert.equal((await f.call('growth.get', {})).failures[0].runId, first.id);
  await configure(f, true);
  await immediate(); await immediate();
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.host.turnStarts, 1);
  // A profile can disappear after the settings were saved. No model starts,
  // but the bounded retry and failure explanation must still survive.
  f.productStore.putAgentProfile({ ...f.profile, enabled: false });
  const unavailable = await f.create('Unavailable executor');
  await until(() => f.store.growthFailures().length === 2);
  assert.equal(f.store.executions(unavailable.id).length, 0);
  assert.equal(f.store.growthFailures().find(value => value.ideaId === unavailable.id).attempts, 2);
});

for (const state of ['retry', 'pending']) test(`recovery blocks an older ${state} assignment for a stopped run`, async t => {
  const f = await fixture(t);
  const idea = await f.create();
  await configure(f, true);
  const run = await waitRun(f, idea);
  f.service.growth.close();
  const job = f.store.growthJobs(['running'])[0];
  await f.call('cancel', { id: idea.id, runId: run.id, operationId: crypto.randomUUID() });
  f.store.saveGrowthJob({ ...job, state, input: { ...job.input,
    operationId: state === 'pending' ? 'old-reserved-retry' : job.input.operationId } });
  await f.restart();
  await until(() => f.store.growthJobs(['blocked']).length === 1);
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.host.turnStarts, 1);
  assert.equal((await f.call('growth.get', {})).failures[0].errorCode, 'INSPIRATION_CANCELED');
});

test('recovery after start committed but before assignment receipt never starts a duplicate', async t => {
  const f = await fixture(t);
  const idea = await f.create();
  f.service.growth.close();
  const job = f.service.growth.reserve(idea, executor(f.profile), 1);
  const started = f.service.start(job.input);
  await f.running(started);
  assert.equal(f.store.growthJobs(['pending']).length, 1);
  await configure(f, true);
  f.service.growth.open();
  await until(() => f.store.growthJobs(['running']).length === 1);
  assert.equal(f.store.executions(idea.id).length, 1);
  assert.equal(f.host.turnStarts, 1);
});
