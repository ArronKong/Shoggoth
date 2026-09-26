'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { startInspirationFixture } = require('./fixtures/inspiration-service-fixture.cjs');

test('Service startup before desktop readiness does not consume seeds; the real IPC gate resumes once', { timeout: 20000 }, async t => {
  const f = await startInspirationFixture();
  t.after(() => f.close());
  const service = f.service.inspirationService, store = f.service.inspirationStore;
  const call = (method, params) => service.handle(`inspiration.${method}`, params);
  const until = async check => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'readiness recovery timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  await f.desktopHost.stop();
  const ideas = [];
  for (let index = 0; index < 3; index++) ideas.push((await call('create', { operationId: randomUUID(), body: `Isolated startup seed ${index}` })).idea);
  const profile = f.service.productStore.listAgentProfiles()[0];
  await call('growth.set', { expectedRevision: 1, enabled: true,
    executors: [{ backendId: profile.backendId, agentId: profile.agentId }] });
  await until(() => service.growth.waitingExecutors.size === 1);
  const operation = store.growthJobs(['pending'])[0].input.operationId;
  assert.equal(store.growthFailures().length, 0);
  assert.ok(ideas.every(idea => store.latestExecution(idea.id) === null));
  await f.desktopHost.start();
  await until(() => service.view(ideas[0].id).latestExecution?.status === 'waiting_input');
  const execution = store.latestExecution(ideas[0].id);
  assert.equal(execution.operationId, operation);
  assert.equal(store.executions(ideas[0].id).length, 1);
  assert.ok(ideas.slice(1).every(idea => store.latestExecution(idea.id) === null));
  assert.equal(store.growthJobs(['running'])[0].attempt, 1);
  assert.equal(store.growthFailures().length, 0);
});
