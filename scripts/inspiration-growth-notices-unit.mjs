import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(path.resolve('app/manage-ui/package.json'));
const ts = require('typescript');
const states = ['failed', 'waiting_approval', 'waiting_input', 'running', 'starting', 'queued', 'interrupted', 'canceled', 'skipped', 'completed', 'unknown'];
const candidates = [...states, 'superseded', 'archived', 'missing', 'unconfirmed', 'active-approval', 'no-run'];
const failures = candidates.map(ideaId => ({ ideaId, runId: ideaId === 'no-run' ? null : `${ideaId}-run`,
  title: ideaId, attempts: 2, errorCode: 'OLD_FAILURE' }));
const growth = { settings: { enabled: false, revision: 1, executors: [] }, failures, errorCode: null };
const reads = [];
const methods = [];
const module = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync('app/manage-ui/src/api/client.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, { module, exports: module.exports, URLSearchParams,
  fetch: async (url, options) => {
    methods.push(options?.method || 'GET');
    const request = new URL(url, 'http://fixture.local');
    if (request.pathname === '/__api/inspirations/growth') return { ok: true, text: async () => JSON.stringify(growth) };
    assert.equal(request.pathname, '/__api/inspirations/detail');
    const id = request.searchParams.get('id');
    reads.push(id);
    if (id === 'missing' || id === 'unconfirmed') return { ok: false, status: id === 'missing' ? 404 : 503, text: async () => '{}' };
    const idea = { id, archivedAt: id === 'archived' ? 1 : null, latestExecution: {
      runId: id === 'superseded' ? 'newer-run' : `${id}-run`,
      status: states.includes(id) ? id : 'failed', attention: id === 'active-approval' ? { active: true } : null,
    } };
    return { ok: true, text: async () => JSON.stringify({ idea }) };
  },
});
const { getInspirationGrowth, updateInspirationGrowth } = module.exports;
assert.deepEqual(Array.from((await getInspirationGrowth()).failures, value => value.ideaId), ['failed', 'canceled']);
assert.ok(!reads.includes('no-run'), 'An unstarted assignment is not an execution failure');
assert.deepEqual(Array.from((await updateInspirationGrowth({ enabled: false, executors: [], expectedRevision: 1 })).failures, value => value.ideaId), ['failed', 'canceled'],
  'Saving nurture settings retains failures and manual stops, with approvals excluded');
assert.equal(methods.filter(method => method === 'PATCH').length, 1);
assert.ok(methods.every(method => ['GET', 'PATCH'].includes(method)), 'State verification never responds to an approval or restarts work');
console.log('PASS inspiration notices: failed executions and manual stops included; approval, input, stale and unconfirmed records excluded on reads and saves');
