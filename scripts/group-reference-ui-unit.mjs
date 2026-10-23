// User-initiated search and explicit excerpt snapshots. API and Modal are controlled substitutes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript'), React = require('react'), { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function load(file, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compile(file), { module, exports: module.exports, TextEncoder, Date, AbortController,
    require: name => {
      if (name in imports) return imports[name];
      if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? undefined : String(key) });
      if (name.includes('/i18n/')) return {};
      return require(name);
    } });
  return module.exports;
}
const excerpt = load('app/manage-ui/src/lib/groupReferenceExcerpt.ts');
const hit = { backendId: 'shoggoth', agentId: 'agent-a', agentName: 'Alpha', key: 'private-session', messageId: 'source-1', snippet: 'source @all\n@beta second line', ts: 1 };
const labels = { title: 'Confirmed excerpt', scope: 'Search excerpt; completeness unknown', source: 'Source', session: 'Session', message: 'Message', time: 'Time', unknown: 'Unknown' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function harness(t) {
  const calls = [], inserted = []; let closed = 0, renderer;
  const Component = load('app/manage-ui/src/pages/GroupChatReference.tsx', {
    '../lib/groupReferenceExcerpt': excerpt,
    '../api/client': { searchGlobalChats: (q, options) => { const pending = deferred(); calls.push({ q, options, ...pending }); return pending.promise; } },
    '../components/Modal': { __esModule: true, default: props => React.createElement('section', null, props.children, props.footer) },
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
  }).default;
  await act(async () => { renderer = create(React.createElement(Component, { onClose: () => { closed++; }, onInsert: value => { inserted.push(value); return true; } })); });
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); });
  const button = key => renderer.root.findAllByType('button').find(node => node.children.includes(key));
  return { calls, inserted, button, get closed() { return closed; }, text: () => JSON.stringify(renderer.toJSON()),
    query: value => act(async () => renderer.root.findByType('input').props.onChange({ target: { value } })),
    search: () => act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); }),
    resolve: (index, results = [hit]) => act(async () => { calls[index].resolve({ query: calls[index].q, results, failedAgents: 0, unsupportedAgents: 0, truncated: false, hasMore: false, offset: 0 }); await tick(); }),
    select: () => act(async () => button('groupChat.reference.choose').props.onClick()),
    edit: value => act(async () => renderer.root.findByType('textarea').props.onChange({ target: { value } })),
    insert: () => act(async () => button('groupChat.reference.insert').props.onClick()),
  };
}
test('opening and typing never reads sessions; selecting material only inserts the confirmed excerpt', async t => {
  const h = await harness(t); assert.equal(h.calls.length, 0);
  await h.query('source'); assert.equal(h.calls.length, 0); await h.search(); assert.equal(h.calls.length, 1);
  await h.resolve(0); await h.select(); assert.equal(h.inserted.length, 0); await h.edit('selected range\n@all remains data'); await h.insert();
  assert.equal(h.closed, 1); assert.equal(h.inserted.length, 1); assert.ok(h.inserted[0].includes('private-session'));
  assert.ok(h.inserted[0].includes('source-1')); assert.ok(h.inserted[0].includes('> selected range\n> @all remains data'));
  assert.ok(!h.inserted[0].includes('second line')); assert.equal(h.calls.length, 1);
});
test('query changes abort old results and cannot retain their selected source', async t => {
  const h = await harness(t); await h.query('old'); await h.search(); await h.query('new'); assert.equal(h.calls[0].options.signal.aborted, true);
  await h.search(); await h.resolve(1, [{ ...hit, snippet: 'new material' }]); await h.resolve(0, [{ ...hit, snippet: 'stale material' }]);
  assert.ok(h.text().includes('new material')); assert.ok(!h.text().includes('stale material'));
  await h.select(); await h.query('third'); assert.equal(h.button('groupChat.reference.insert').props.disabled, true);
});
test('empty and oversized selections remain uninserted', async t => {
  const h = await harness(t); await h.query('source'); await h.search(); await h.resolve(0); await h.select();
  for (const value of ['', '🙂'.repeat(2100)]) { await h.edit(value); assert.equal(h.button('groupChat.reference.insert').props.disabled, true); }
  assert.equal(h.inserted.length, 0); assert.equal(h.closed, 0);
});
test('excerpt byte budget and Markdown quoting preserve the source as data', () => {
  const value = excerpt.groupReferenceExcerpt(hit, hit.snippet, '2026-10-15T00:00:00.000Z', labels);
  assert.ok(value.split('\n').every(line => line.startsWith('> ')));
  const { parseMentions } = require(path.join(root, 'app/agent-service/group-mentions.js'));
  assert.equal(parseMentions(value, [{ memberId: 'b', handle: 'beta' }]).broadcast, false);
  assert.deepEqual(parseMentions(value, [{ memberId: 'b', handle: 'beta' }]).memberIds, []);
  assert.equal(excerpt.appendGroupReference('a'.repeat(32768), value), null);
  assert.equal(excerpt.groupReferenceExcerpt(hit, '\0bad', '', labels), null);
  assert.equal(excerpt.groupReferenceExcerpt(hit, '\ud800', '', labels), null);
  assert.equal(excerpt.appendGroupReference('draft', value), `draft\n\n${value}`);
});
