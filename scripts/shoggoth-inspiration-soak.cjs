#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, until } = require('./fixtures/inspiration-coordinator-fixture.cjs');
const count = Number(process.argv[2] || 1000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('Count must be 1..1000');
(async () => {
  const cleanup = [];
  const f = await fixture({ after: (callback) => cleanup.push(callback) });
  const before = process.memoryUsage().rss;
  try {
    let idea = await f.start(await f.create('Repeated input, approval and recovery'));
    let run = await f.running(idea);
    for (let index = 0; index < count; index++) {
      const approval = index % 2 === 1;
      const answered = approval ? f.host.approve(run) : f.host.ask(run);
      await until(() => ['waiting_input', 'waiting_approval'].includes(f.dispatcher.getRun(run.id).status));
      const requestId = f.dispatcher.getRun(run.id).waitingRequestId;
      const response = approval ? { choice: index % 4 === 1 ? 'once' : 'deny' }
        : { action: 'submit', answers: { audience: index % 4 === 0 ? 'family' : 'friends' } };
      const input = { id: idea.id, operationId: crypto.randomUUID(), runId: run.id, requestId, response };
      if (index % 3 === 0) {
        await f.coordinator[approval ? 'respondApproval' : 'respondInput']({ operationId: input.operationId,
          runId: run.id, requestId, ...(approval ? { choice: response.choice } : response) });
      } else {
        await f.call('respond', input);
        await f.call('respond', input);
      }
      await answered;
      assert.equal(f.coordinator.getMemoryStats().pendingRequests, 0);
      assert.equal((await f.call('executions', { id: idea.id, cursor: null, limit: 1 })).executions[0].attention, null);
      if ((index + 1) % 20 === 0) {
        f.host.complete(run, `round ${index + 1}`);
        await until(() => f.dispatcher.getRun(run.id).status === 'completed');
        await f.restart();
        assert.equal(f.coordinator.getMemoryStats().domainCommands, 0);
        assert.equal(f.coordinator.getMemoryStats().runHostAssignments, 0);
        if (index + 1 < count) {
          idea = await f.start((await f.call('get', { id: idea.id })).idea, `continue ${index + 1}`);
          run = await f.running(idea);
        }
      }
      if ((index + 1) % 100 === 0) console.log(`Inspiration soak ${index + 1}/${count}`);
    }
    if (f.dispatcher.getRun(run.id).status === 'running') { f.host.complete(run); await until(() => f.dispatcher.getRun(run.id).status === 'completed'); }
    const stats = f.coordinator.getMemoryStats();
    assert.equal(stats.pendingRequests, 0); assert.equal(stats.domainCommands, 0);
    assert.equal(stats.runHostAssignments, 0); assert.equal(stats.terminalWaiters, 0);
    assert.equal(f.sessions.listSessions().length, 1);
    const growth = process.memoryUsage().rss - before;
    assert.ok(growth < 512 * 1024 * 1024, `RSS growth ${growth} exceeded budget`);
    console.log(`PASS Inspiration ${count} interactions, ${Math.floor(count / 20)} recovery cycles; RSS growth=${growth}; pending/execution owners=0`);
  } finally { for (const callback of cleanup.reverse()) await callback(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
