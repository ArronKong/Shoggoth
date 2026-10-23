import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ui = path.resolve(import.meta.dirname, '../app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(ui, 'src/api/groupReads.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const input = () => ({ seq: 2, offset: 0, digest: 'a'.repeat(64) });
function load(fetch, onDelay = () => {}) {
  const module = { exports: {} }, delays = [];
  vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams, TypeError,
    setTimeout(resolve, delay) { delays.push(delay); onDelay(); queueMicrotask(resolve); },
    require(name) { assert.equal(name, './client'); return { jsonFetch: fetch }; },
  });
  return { ...module.exports, delays };
}

test('a transient read network failure recovers once under the same fixed source URL', async () => {
  const calls = [], query = input(), page = { text: 'saved full answer' };
  const api = load(async url => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return { page };
  }, () => { query.seq = 99; query.digest = 'b'.repeat(64); });
  assert.equal((await api.readGroupChatMessage('original-group', query)).page, page);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], calls[0], 'a changed caller object cannot retarget the retry');
  assert.match(calls[0], /id=original-group&seq=2&offset=0&digest=a{64}$/);
  assert.deepEqual(api.delays, [250]);
});

test('successful reads do not add a request or delay', async () => {
  let calls = 0;
  const api = load(async () => { calls++; return { page: {} }; });
  await api.readGroupChatMessage('group', input());
  assert.equal(calls, 1); assert.deepEqual(api.delays, []);
});

test('HTTP, authorization, recovery and fixed-source errors are not retried', async () => {
  for (const code of ['GROUP_CHAT_UNAVAILABLE', 'GROUP_RESULT_MISMATCH', 'GROUP_CHAT_OWNER_CHANGED', 'SERVICE_RECOVERY_REQUIRED']) {
    let calls = 0; const error = Object.assign(new Error(code), { code, status: 503 });
    const api = load(async () => { calls++; throw error; });
    await assert.rejects(api.readGroupChatMessage('group', input()), value => value === error);
    assert.equal(calls, 1); assert.deepEqual(api.delays, []);
  }
});

test('a second network failure remains visible and never starts an unbounded loop', async () => {
  let calls = 0; const error = new TypeError('Failed to fetch');
  const api = load(async () => { calls++; throw error; });
  await assert.rejects(api.readGroupChatMessage('group', input()), value => value === error);
  assert.equal(calls, 2); assert.deepEqual(api.delays, [250]);
});
