import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ui = path.resolve(import.meta.dirname, '../app/manage-ui'), require = createRequire(path.join(ui, 'package.json'));
const React = require('react'), { act, create } = require('react-test-renderer'), ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const calls = [], opened = [];
let pending = [];
const api = { searchGroupChatMessages: (id, input) => { calls.push({ id, input }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } };
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, 'src/pages', file), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, JSON, Number, Promise, Error,
    require: name => name.includes('/i18n/') ? {} : name.endsWith('.css') ? { default: {} }
      : name.endsWith('/lib/groupReply') ? load('../lib/groupReply.ts') : name.endsWith('/api/groupReads') ? api : name.endsWith('/components/Modal') ? { __esModule: true, default: props => React.createElement('section', { role: 'dialog' }, props.children) }
        : name === 'react-i18next' ? { useTranslation: () => ({ t: (key, values) => key + (values ? JSON.stringify(values) : '') }) } : require(name) });
  return file.endsWith('groupReply.ts') ? module.exports : module.exports.default;
}
const Search = load('GroupChatSearch.tsx');
const view = (groupId = 'g', ownerScope = 'owner') => ({ ownerScope, group: { id: groupId }, members: [{ id: 'm', displayName: 'Member' }] });
const hit = (seq = 4, groupId = 'g') => ({ message: { id: `m${seq}`, groupId, seq, author: { kind: 'member', memberId: 'm' }, body: 'needle', fullResult: { bytes: 6, digest: 'a'.repeat(64) } }, snippet: 'needle', snippetOffset: 100, partial: false });
const page = (extra = {}) => ({ groupId: 'g', query: 'needle', authorKind: null, memberId: null, discussionId: null, upperSeq: 4, hits: [hit()], partial: false, hasMore: false, nextCursor: null, ...extra });
let renderer, passed = 0;
const flush = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
const props = value => ({ view: value, onClose() {}, onOpenMessage: message => opened.push(message) });
const mount = async (value = view()) => { if (renderer) await act(async () => renderer.unmount()); calls.length = 0; opened.length = 0; pending = []; await act(async () => { renderer = create(React.createElement(Search, props(value))); }); };
const choose = async (node, value) => { await act(async () => node.props.onChange({ target: { value } })); };
const query = value => choose(renderer.root.findByType('input'), value);
const submit = async () => { await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })); };
const button = suffix => renderer.root.findAllByType('button').find(node => node.children.some(text => typeof text === 'string' && text.startsWith('groupChat.search.' + suffix)));
const click = async node => { await act(async () => node.props.onClick()); };
const resolve = async (index, value) => { pending[index].resolve(value); await flush(); };
const text = () => JSON.stringify(renderer.toJSON());
const test = async (name, fn) => { await fn(); console.log(`ok ${++passed} - ${name}`); };

await test('no automatic history read; explicit query returns bounded fixed-source callback', async () => {
  await mount(); assert.equal(calls.length, 0); await query('needle'); await submit(); assert.equal(calls.length, 1);
  await resolve(0, page()); await click(button('read')); assert.equal(opened.length, 1); assert.equal(opened[0].fullResult.digest, 'a'.repeat(64));
  assert.equal(opened[0].seq, 4); assert.match(text(), /snapshot/);
});
await test('historical quote marker is hidden only at the start of the full body; fixed read keeps quote and digest', async () => {
  const replyTo = { seq: 1, messageId: 'original', author: { kind: 'user' }, excerpt: 'question' };
  const original = hit(); original.message.replyTo = replyTo;
  original.snippet = original.message.body = '回复 #1\nneedle specific advice #11'; original.snippetOffset = 0;
  await mount(); await query('needle'); await submit(); await resolve(0, page({ hits: [original] }));
  assert.doesNotMatch(text(), /回复 #1/); assert.match(text(), /specific advice #11/);
  await click(button('read')); assert.deepEqual(opened[0].replyTo, replyTo);
  assert.equal(opened[0].fullResult.digest, original.message.fullResult.digest);
  const middle = { ...original, snippetOffset: 100 };
  await submit(); await resolve(1, page({ hits: [middle] }));
  assert.match(text(), /回复 #1/, 'an interior mention is content, not the leading protocol marker');
});
await test('pagination preserves frozen upper sequence and passes the exact cursor', async () => {
  await mount(); await query('needle'); await submit(); await resolve(0, page({ hasMore: true, nextCursor: 'cursor' }));
  await click(button('more')); assert.equal(calls[1].input.cursor, 'cursor'); await resolve(1, page({ hits: [hit(2)] }));
  assert.equal(renderer.root.findAllByType('article').length, 2);
  await submit(); await resolve(2, page({ hasMore: true, nextCursor: 'cursor' })); await click(button('more'));
  await resolve(3, page({ upperSeq: 5, hits: [hit(5)] })); assert.match(text(), /failed/); assert.equal(renderer.root.findAllByType('article').length, 1);
});
await test('query changes discard late results even when transport ignores abort', async () => {
  await mount(); await query('needle'); await submit(); await query('new query');
  assert.equal(calls[0].input.signal.aborted, true); await resolve(0, page()); assert.equal(renderer.root.findAllByType('article').length, 0);
});
await test('group and owner changes discard late reads and existing results', async () => {
  for (const value of [view('other'), view('g', 'new-owner')]) {
    await mount(); await query('needle'); await submit(); await act(async () => renderer.update(React.createElement(Search, props(value))));
    await resolve(0, page()); assert.equal(renderer.root.findAllByType('article').length, 0); assert.equal(calls[0].input.signal.aborted, true);
  }
});
await test('author selection uses an exact scope and invalidates existing pages', async () => {
  await mount(); await query('needle'); await submit(); await resolve(0, page());
  await choose(renderer.root.findAllByType('select')[0], 'member:m'); assert.equal(renderer.root.findAllByType('article').length, 0);
  await submit();
  assert.equal(calls[1].input.memberId, 'm'); assert.equal(calls[1].input.authorKind, 'member'); assert.equal(calls[1].input.discussionId, null);
  await resolve(1, page({ authorKind: 'member', memberId: 'm', partial: true, hits: [{ ...hit(), partial: true }] }));
  assert.match(text(), /partialHit/); assert.match(text(), /partial/);
});
await test('foreign responses never become selectable and unmount aborts outstanding reads', async () => {
  await mount(); await query('needle'); await submit(); await resolve(0, page({ hits: [hit(4, 'other')] }));
  assert.match(text(), /failed/); assert.equal(renderer.root.findAllByType('article').length, 0);
  await submit(); const signal = calls[1].input.signal; await act(async () => renderer.unmount()); renderer = null; assert.equal(signal.aborted, true);
  pending[1].resolve(page()); await flush(); assert.equal(opened.length, 0);
});
await test('an empty scan page retains continuation and distinguishes incomplete old text', async () => {
  await mount(); await query('needle'); await submit(); await resolve(0, page({ hits: [], partial: true, hasMore: true, nextCursor: 'scan' }));
  assert.ok(button('more')); assert.match(text(), /empty/); assert.match(text(), /partial/);
});
await act(async () => renderer.unmount()); console.log(`PASS ${passed} group search UI contracts`);
