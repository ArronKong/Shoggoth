import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ui = path.resolve(import.meta.dirname, '../app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const React = require('react');
const { act, create } = require('react-test-renderer');
const ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let pending = [], calls = [], reveals = [];
const deferred = (kind, args) => { calls.push({ kind, args }); return new Promise((resolve, reject) => pending.push({ kind, resolve, reject })); };
const api = {
  getGroupChat: id => deferred('detail', id),
  listGroupChatMessages: (id, query) => deferred('history', { id, query }),
  revealAttachment: async (...args) => { reveals.push(args); },
};
function load(relative) {
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, setInterval, clearInterval, Date, Map, JSON, Number, Promise, Error,
  require: name => name.includes('/i18n/') ? {} : name.endsWith('.css') ? { default: {} }
    : /\.(svg|png)$/.test(name) ? { __esModule: true, default: name }
      : name.endsWith('/components/ArtifactThumb') ? load('src/components/ArtifactThumb.tsx')
      : name.endsWith('/api/client') ? api
        : name.endsWith('/inspiration-media') ? { inspirationMediaUrl: id => `/__api/inspirations/media?id=${id}` }
          : name === 'react-i18next' ? { useTranslation: () => ({ i18n: { language: 'en' }, t: (key, values) => key + (values ? JSON.stringify(values) : '') }) }
            : require(name),
});
return module.exports;
}
const Files = load('src/pages/GroupChatFiles.tsx').default;
const view = (id = 'g', ownerScope = 'owner') => ({ group: { id }, ownerScope, members: [{ id: 'm', displayName: 'Diva' }] });
const file = (id = 'file', name = `${id}.md`) => ({ id, name, size: 80000, mimeType: 'text/markdown' });
const message = (seq, attachments = [], author = { kind: 'member', memberId: 'm' }, groupId = 'g') => ({ id: `message-${seq}`, groupId, seq, author, attachments, createdAt: Date.now() - 3_600_000 });
let renderer, passed = 0;
const props = value => ({ view: value, onClose() {} });
const flush = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
const settle = async (kind, value, reject = false) => {
  const index = pending.findIndex(item => item.kind === kind);
  assert.notEqual(index, -1, `expected a pending ${kind} request`);
  const [item] = pending.splice(index, 1);
  if (reject) item.reject(value); else item.resolve(value);
  await flush();
};
const mount = async (value = view()) => {
  if (renderer) await act(async () => renderer.unmount());
  pending = []; calls = []; reveals = [];
  await act(async () => { renderer = create(React.createElement(Files, props(value))); });
};
const page = async (messages, hasMore = false, owner = view()) => {
  await settle('history', { messages, hasMore });
  await settle('detail', owner);
};
const start = async value => { await mount(value); await settle('detail', value ?? view()); };
const text = () => JSON.stringify(renderer.toJSON());
const rows = () => renderer.root.findAllByType('button').filter(node => typeof node.props.title === 'string' && node.props.title.startsWith('groupChat.files.reveal'));
const test = async (name, fn) => { await fn(); console.log(`ok ${++passed} - ${name}`); };

await test('all group history pages are scanned, including user files, and media IDs retain the latest author', async () => {
  await start();
  await page([message(120, [file('shared')], { kind: 'user' }), message(119, [file('new')])], true);
  assert.equal(rows().length, 2); assert.match(text(), /loading/); assert.match(text(), /files.me/);
  assert.equal(calls.at(-1).args.query.beforeSeq, 119);
  await page([message(20, [file('shared')]), message(19, [file('old')]), message(18, [file('system')], { kind: 'system' })]);
  assert.equal(rows().length, 3); assert.match(text(), /files.me/); assert.doesNotMatch(text(), /system\.md|files.loading/);
  assert.equal(calls.filter(call => call.kind === 'history').length, 2);
});
await test('a later-page failure keeps loaded files with an explicit partial state and retry', async () => {
  await start(); await page([message(8, [file('first')])], true);
  await settle('history', Error('unavailable'), true);
  assert.equal(rows().length, 1); assert.match(text(), /files.partial/);
  const retry = renderer.root.findAllByType('button').find(node => node.children.includes('groupChat.files.retry'));
  await act(async () => retry.props.onClick());
  assert.equal(rows().length, 0); assert.equal(pending[0].kind, 'detail');
});
await test('complete empty history differs from a failed first read and from a stalled pagination response', async () => {
  await start(); await page([]); assert.match(text(), /files.empty/); assert.doesNotMatch(text(), /files.failed/);
  await start(); await settle('history', Error('failed'), true); assert.match(text(), /files.failed/); assert.doesNotMatch(text(), /files.empty/);
  await start(); await page([], true); assert.match(text(), /files.failed/); assert.equal(pending.length, 0);
});
await test('foreign message pages are rejected before files become visible', async () => {
  await start(); await page([message(4, [file('foreign')], { kind: 'user' }, 'other')]);
  assert.equal(rows().length, 0); assert.match(text(), /files.failed/);
});
await test('history continuation must be an explicit boolean', async () => {
  await start(); await page([message(4, [file('invalid')])], 'yes');
  assert.equal(rows().length, 0); assert.match(text(), /files.failed/); assert.equal(pending.length, 0);
});
await test('owner changes during the authority recheck clear previously loaded files', async () => {
  await start(); await page([message(8, [file('first')])], true);
  await page([message(7, [file('second')])], false, view('g', 'other-owner'));
  assert.equal(rows().length, 0); assert.match(text(), /files.changed/); assert.equal(pending.length, 0);
});
await test('group and owner prop changes discard late history and do not continue the cancelled scan', async () => {
  for (const next of [view('other'), view('g', 'other-owner')]) {
    await start();
    const oldRead = pending.shift();
    await act(async () => renderer.update(React.createElement(Files, props(next))));
    oldRead.resolve({ messages: [message(8, [file('late')])], hasMore: true }); await flush();
    assert.equal(rows().length, 0); assert.equal(calls.filter(call => call.kind === 'history').length, 1);
    await settle('detail', next);
    const nextMessage = message(3, [file('correct')], { kind: 'user' }, next.group.id);
    await page([nextMessage], false, next);
    assert.equal(rows().length, 1); assert.doesNotMatch(text(), /late\.md/);
  }
});
await test('file clicks use only the saved media descriptor and recheck owner before revealing', async () => {
  await start(); await page([message(4, [file('saved', 'notes.md')])]);
  await act(async () => rows()[0].props.onClick());
  await settle('detail', view());
  assert.equal(reveals.length, 1); assert.deepEqual(Array.from(reveals[0]), ['notes.md', '/__api/inspirations/media?id=saved']);
  await act(async () => rows()[0].props.onClick());
  await settle('detail', view('g', 'changed'));
  assert.equal(reveals.length, 1); assert.equal(rows().length, 0); assert.match(text(), /files.changed/);
});

await act(async () => renderer.unmount());
console.log(`PASS ${passed} group files UI contracts`);
