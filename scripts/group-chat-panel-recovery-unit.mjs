// Render the real panel with synthetic replies and controlled lifecycle/timers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';

const ui = path.resolve(import.meta.dirname, '../app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const React = require('react'), { act, create } = require('react-test-renderer'), ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const sourcePath = process.env.GROUP_CHAT_PANEL_TEST_SOURCE || path.join(ui, 'src/pages/GroupChatPanel.tsx');
const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const group = id => ({ ownerScope: 'recovery-fixture-owner', group: { id, name: `owned-${id}`, purpose: '', status: 'active', createdAt: 1, updatedAt: 1,
  metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 0, ownerMemberId: 'member' },
  members: [{ id: 'member', groupId: id, backendId: 'shoggoth', agentId: 'owned-member', displayName: 'Owned Member',
    handle: 'member', state: 'active', position: 0, joinedSeq: 0, leftSeq: null, card: null }],
  currentOwnerId: 'member', round: null,
  activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [] });
const round = { id: 'owned-round', causeMessageId: 'message-1', order: [] };
const message = (id, seq) => ({ id: `message-${seq}`, groupId: id, seq, threadId: 'main', author: { kind: 'user' },
  body: `owned-message-${seq}`, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: seq });
const page = (id, seq = 1, hasMore = false) => ({ messages: [message(id, seq)], hasMore });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness(t, detail, messages = id => page(id), options = {}) {
  let now = 0, timerId = 0, renderer, detailCount = 0;
  const groupChanged = new Set();
  const timers = new Map(), window = new EventTarget(), document = new EventTarget(), calls = [];
  document.visibilityState = 'visible';
  const api = new Proxy({
    getGroupChat: id => { calls.push({ method: 'detail', id }); return detail(id, ++detailCount); },
    listGroupChatMessages: (id, query) => { calls.push({ method: 'messages', id, query: JSON.parse(JSON.stringify(query)) }); return messages(id, query); },
    ...(options.api ?? {}),
  }, { get: (target, key) => key in target ? target[key] : () => { throw Error('Unexpected synthetic mutation: ' + String(key)); } });
  const component = () => null;
  const stubs = new Proxy({ __esModule: true, default: component }, { get: (target, key) => key in target ? target[key] : component });
  const modules = new Map(), journalDrafts = new Map(), journalWrites = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const journal = {
    async read(ownerScope, groupId) { return { sends: [], foreignPending: 0,
      draft: clone([...journalDrafts.values()].filter(row => row.ownerScope === ownerScope && row.groupId === groupId).at(-1) ?? null) }; },
    async saveComposer(ownerScope, groupId, draftId, revision, composer, expectedStorageRevision) {
      const key = JSON.stringify([ownerScope, groupId, draftId]), before = journalDrafts.get(key);
      assert.equal(before?.storageRevision ?? 0, expectedStorageRevision, 'synthetic journal retains its draft CAS');
      const snapshot = { version: 1, key, ownerScope, groupId, draftId, revision, storageRevision: expectedStorageRevision + 1,
        composer: clone(composer), updatedAt: now };
      journalWrites.push({ ownerScope, groupId, draftId, revision }); journalDrafts.set(key, snapshot); return clone(snapshot);
    },
  };
  const deterministicMath = Object.create(Math); deterministicMath.random = () => 0.5;
  const globals = { Date: class extends Date { static now() { return now; } }, Math: deterministicMath,
    Set, Map, Error, JSON, Promise, Array, TextEncoder, Uint8Array, window, document,
    crypto: globalThis.crypto, URL: { revokeObjectURL() {} }, requestAnimationFrame: fn => fn(),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval: null }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval: delay }); return id; },
    clearInterval: id => timers.delete(id),
  };
  let groupJournal;
  const importModule = relative => {
    if (modules.has(relative)) return modules.get(relative);
    const loaded = { exports: {} }, source = ts.transpileModule(fs.readFileSync(path.join(ui, relative), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, { ...globals, module: loaded, exports: loaded.exports, require: importDependency });
    modules.set(relative, loaded.exports); return loaded.exports;
  };
  const importDependency = name => {
      if (name === 'react' || name.startsWith('react/')) return require(name);
      if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
      if (name.endsWith('/api/client')) return api;
      if (name.endsWith('/lib/groupPanelObserver')) return importModule('src/lib/groupPanelObserver.ts');
      if (name.endsWith('/lib/groupSendJournal')) return groupJournal;
      if (name.endsWith('/lib/turnTimeline')) return importModule('src/lib/turnTimeline.ts');
      if (name.endsWith('/lib/groupReferenceExcerpt')) return importModule('src/lib/groupReferenceExcerpt.ts');
      if (name.endsWith('/lib/groupReply')) return importModule('src/lib/groupReply.ts');
      if (name.endsWith('/lib/groupTimeline')) return importModule('src/lib/groupTimeline.ts');
      if (name.endsWith('/lib/groupMessagePresentation')) return importModule('src/lib/groupMessagePresentation.ts');
      if (name.endsWith('/i18n/groupCollaborationResources') || name.endsWith('/i18n/groupComposerResources')) return {};
      if (name.endsWith('/lib/groupChat')) return { GROUP_MAX_MEMBERS: 32,
        onGroupChanged: fn => { groupChanged.add(fn); return () => groupChanged.delete(fn); } };
      if (name.endsWith('/components/ui')) return { useToast: () => ({ error() {} }), useConfirm: () => async () => false, usePrompt: () => async () => null };
      if (name.endsWith('.css')) return new Proxy({}, { get: (_target, key) => key === '__esModule' ? undefined : String(key) });
      if (name.endsWith('/components/ChatMarkdown')) return { __esModule: true, default: props => React.createElement('p', null, props.text) };
      if (name === './GroupChatMarkdown') return { __esModule: true, default: props => React.createElement('p', null, props.lead, props.text) };
      if (name === './ChatPromptCard') return { __esModule: true, default: props => React.createElement('section', { 'data-approval': props.entry.id }) };
      if (name === './inspiration-media') return { MAX_INSPIRATION_ATTACHMENTS: 8, inspirationMediaLimit: () => 0 };
      return stubs;
  };
  const realJournal = importModule('src/lib/groupSendJournal.ts');
  const cache = importModule('src/lib/groupPanelCache.ts').createGroupPanelCache();
  groupJournal = { ...realJournal, groupSendJournal: journal,
    GroupDraftSession: class extends realJournal.GroupDraftSession {
      constructor(ownerScope, groupId, snapshot) { super(ownerScope, groupId, snapshot, journal); }
    } };
  const module = { exports: {} };
  vm.runInNewContext(code, { ...globals, module, exports: module.exports, require: importDependency });
  const Panel = module.exports.default;
  let cacheScope = 'recovery-fixture-owner';
  const element = id => React.createElement(Panel, { key: options.cache ? `${cacheScope}:${id}` : undefined,
    groupId: id, cache: options.cache ? cache : undefined, cacheScope, agents: [], onArchived() {} });
  const unmount = async () => { if (renderer) { await act(async () => renderer.unmount()); renderer = null; } };
  t.after(unmount);
  await act(async () => { renderer = create(element('a'), { unstable_isConcurrent: true }); });
  return {
    window, document, calls, timers, journalWrites, unmount, cache,
    get detailCount() { return detailCount; },
    get retryTimers() { return [...timers.values()].filter(timer => timer.interval === null).length; },
    get watchdogTimers() { return [...timers.values()].filter(timer => timer.interval !== null).length; },
    text: () => JSON.stringify(renderer.toJSON()),
    root: () => renderer.root,
    change: id => act(async () => { for (const listener of [...groupChanged]) listener(id); }),
    event: (target, type) => act(async () => target.dispatchEvent(new Event(type))),
    switch: id => act(async () => renderer.update(element(id))),
    scope: scope => act(async () => { cacheScope = scope; renderer.update(element('a')); }),
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        if (next[1].interval === null) timers.delete(next[0]); else next[1].at += next[1].interval;
        await act(async () => next[1].fn());
      }
      now = until;
    },
  };
}

test('stop gives immediate single-flight feedback and retains the draft until a confirmed terminal view', async t => {
  const pending = deferred(); let authority = group('a'), stops = 0;
  authority.round = round;
  authority.activeTurns = [{ opportunityId: 'owned-turn', memberId: 'member', startedAt: 1, inputThroughSeq: 0 }];
  const h = await harness(t, async () => authority, undefined, { api: {
    stopGroupChatDiscussion: async id => { assert.equal(id, 'a'); stops++; return pending.promise; },
  } });
  await act(async () => h.root().findByType('textarea').props.onChange({ target: { value: 'preserve draft', selectionStart: 14 } }));
  const stop = () => h.root().findAllByType('button').find(button => button.props.className?.includes('chat-stop'));
  let stopping;
  await act(async () => { stopping = stop().props.onClick(); });
  assert.equal(stops, 1);
  assert.equal(stop().props.disabled, true, 'stop must be visibly pending before the RPC settles');
  assert.ok(h.text().includes('groupChat.stopState.requesting'));
  await act(async () => stop().props.onClick());
  assert.equal(stops, 1, 'repeat clicks cannot post another stop or invalidate ongoing reads');
  authority = { ...authority, round: null, activeTurns: [
    { ...authority.activeTurns[0], stopping: true, recovery: { type: 'execution', reason: 'GROUP_EXECUTION_STOP_UNCONFIRMED', since: 1, cancelRequested: true } },
  ] };
  await act(async () => { pending.resolve(authority); await stopping; });
  assert.ok(h.text().includes('groupChat.stopState.confirming'));
  assert.equal(stop().props.disabled, true);
  assert.equal(h.root().findByType('textarea').props.value, 'preserve draft');
  authority = { ...authority, activeTurns: [] };
  await h.event(h.window, 'focus');
  assert.equal(stop(), undefined, 'only a fresh terminal view removes the pending stop');
});

test('a failed stop stays retryable and cannot leave a pending button behind in another group', async t => {
  const pending = deferred(); let stops = 0;
  const running = id => ({ ...group(id), round });
  const h = await harness(t, async id => running(id), undefined, { api: {
    stopGroupChatDiscussion: async () => { stops++; return stops === 1 ? pending.promise : running('b'); },
  } });
  const stop = () => h.root().findAllByType('button').find(button => button.props.className?.includes('chat-stop'));
  await act(async () => stop().props.onClick());
  await h.switch('b');
  assert.equal(stop().props.disabled, false);
  await act(async () => pending.reject(Error('old stop failed')));
  assert.equal(stop().props.disabled, false, 'an old completion cannot change the selected group stop state');
  await act(async () => stop().props.onClick());
  assert.equal(stops, 2);
});

test('a failed stop in the selected group releases the button and allows a retry', async t => {
  let stops = 0;
  const authority = { ...group('a'), round };
  const h = await harness(t, async () => authority, undefined, { api: {
    stopGroupChatDiscussion: async () => {
      stops++;
      if (stops === 1) throw Error('temporary stop failure');
      return { ...authority, round: null };
    },
  } });
  const stop = () => h.root().findAllByType('button').find(button => button.props.className?.includes('chat-stop'));
  await act(async () => stop().props.onClick());
  assert.equal(stop().props.disabled, false);
  assert.ok(!h.text().includes('groupChat.stopState.requesting'));
  await act(async () => stop().props.onClick());
  assert.equal(stops, 2);
});

test('returning to a cached group paints history while the incremental refresh is still pending', async t => {
  const pending = deferred(); let reads = 0;
  const h = await harness(t, id => id === 'a' && ++reads > 1 ? pending.promise : Promise.resolve(group(id)),
    async (id, query) => query.afterSeq === undefined ? page(id, 101, true) : page(id, 102), { cache: true });
  await h.switch('b'); await h.switch('a');
  assert.ok(h.text().includes('owned-message-101'), 'cached messages must render before a fresh detail response');
  assert.ok(h.text().includes('groupChat.loadOlder'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').at(-1).query, { afterSeq: 101, limit: 200 });
  await act(async () => pending.resolve(group('a')));
  assert.ok(h.text().includes('owned-message-102'));
  assert.ok(h.text().includes('owned-message-101'));
  assert.ok(h.text().includes('groupChat.loadOlder'), 'incremental hasMore must not erase older pagination');
});

test('cached empty groups and a failed warm refresh remain usable without a full-panel loader', async t => {
  let fail = false;
  const h = await harness(t, async id => { if (fail) throw Error('offline'); return group(id); },
    async () => ({ messages: [], hasMore: false }), { cache: true });
  await h.switch('b'); fail = true; await h.switch('a');
  assert.ok(h.text().includes('owned-a'));
  assert.equal(h.root().findAllByType('textarea').length, 1);
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').at(-1).query, { afterSeq: 0, limit: 200 });
  assert.ok(h.text().includes('groupChat.sync.recovering'));
});

test('owner changes cannot paint cached history and restart from the latest page', async t => {
  const pending = deferred(); let scope = 'recovery-fixture-owner';
  const h = await harness(t, id => scope === 'new-owner' ? pending.promise : Promise.resolve(group(id)),
    async id => page(id, scope === 'new-owner' ? 301 : 101), { cache: true });
  scope = 'new-owner'; await h.scope(scope);
  assert.ok(!h.text().includes('owned-message-101'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').at(-1).query, { limit: 100 });
  await act(async () => pending.resolve({ ...group('a'), ownerScope: scope }));
  assert.ok(h.text().includes('owned-message-301'));
});

test('a changed owner discovered during warm refresh drops the old cursor before re-reading', async t => {
  let scope = 'recovery-fixture-owner', changed = false;
  const h = await harness(t, async id => ({ ...group(id), ownerScope: scope }),
    async (id, query) => changed ? query.afterSeq === undefined ? page(id, 3, true) : page(id, 999)
      : page(id, 101), { cache: true });
  await h.switch('b'); scope = 'new-owner'; changed = true; await h.switch('a');
  assert.ok(!h.text().includes('owned-message-101'));
  assert.ok(!h.text().includes('owned-message-999'), 'the page read across an owner change is discarded');
  assert.ok(h.text().includes('owned-message-3'));
  assert.ok(h.text().includes('groupChat.loadOlder'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').slice(-2).map(c => c.query),
    [{ afterSeq: 101, limit: 200 }, { limit: 100 }]);
});

test('the page cache bounds retained groups and messages without hiding older history', async t => {
  const h = await harness(t, async id => group(id));
  const snapshot = id => ({ view: group(id), messages: Array.from({ length: 250 }, (_, i) => message(id, i + 1)),
    hasOlder: false, lastSyncAt: 1 });
  for (let i = 0; i < 8; i++) h.cache.put(snapshot(String(i)));
  const first = h.cache.get('0', 'recovery-fixture-owner');
  assert.equal(first.messages.length, 200); assert.equal(first.messages[0].seq, 51); assert.equal(first.hasOlder, true);
  h.cache.put(snapshot('8'));
  assert.equal(h.cache.get('1', 'recovery-fixture-owner'), undefined);
  assert.ok(h.cache.get('0', 'recovery-fixture-owner'));
  assert.equal(h.cache.get('0', 'foreign-owner'), undefined);
  assert.equal(h.cache.get('0', 'recovery-fixture-owner'), undefined);
  h.cache.put({ ...snapshot('archived'), view: { ...group('archived'), group: { ...group('archived').group, status: 'archived' } } });
  assert.equal(h.cache.get('archived', 'recovery-fixture-owner'), undefined);
  h.cache.put(snapshot('unscoped'));
  assert.equal(h.cache.get('unscoped'), undefined);
});

test('returning to a group retains loaded older pages and still appends new messages', async t => {
  const h = await harness(t, async id => group(id), async (id, query) => query.beforeSeq ? page(id, 100)
    : query.afterSeq !== undefined ? page(id, 102) : page(id, 101, true), { cache: true });
  const older = h.root().findAllByType('button').find(b => b.children.includes('groupChat.loadOlder'));
  await act(async () => older.props.onClick());
  await h.switch('b'); await h.switch('a');
  for (const seq of [100, 101, 102]) assert.ok(h.text().includes(`owned-message-${seq}`));
  assert.ok(!h.text().includes('groupChat.loadOlder'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').at(-1).query, { afterSeq: 101, limit: 200 });
});

test('a late inactive refresh cannot replace the cached snapshot or the selected group', async t => {
  const pending = deferred(); let late = false;
  const h = await harness(t, id => id === 'a' && late ? pending.promise : Promise.resolve(group(id)),
    async id => page(id, late ? 102 : 101), { cache: true });
  await h.switch('b'); late = true; await h.switch('a'); await h.switch('b');
  await act(async () => pending.resolve({ ...group('a'), group: { ...group('a').group, name: 'stale-refresh' } }));
  assert.ok(h.text().includes('owned-b')); assert.ok(!h.text().includes('stale-refresh'));
  const cached = h.cache.get('a', 'recovery-fixture-owner');
  assert.equal(cached.messages.at(-1).seq, 101);
  assert.equal(cached.view.group.name, 'owned-a');
});

test('messages from another group cannot enter the visible or cached history', async t => {
  let wrong = false;
  const h = await harness(t, async id => group(id), async id => page(wrong ? 'other-group' : id, wrong ? 999 : 101), { cache: true });
  wrong = true; await h.event(h.window, 'focus');
  assert.ok(h.text().includes('owned-message-101')); assert.ok(!h.text().includes('owned-message-999'));
  assert.equal(h.cache.get('a', 'recovery-fixture-owner').messages.at(-1).seq, 101);
});

test('first-read outage recovers without group activity, then retains the bounded idle watchdog', async t => {
  const h = await harness(t, async (id, count) => { if (count === 1) throw Error('GROUP_CHAT_UNAVAILABLE'); return group(id); });
  assert.ok(h.text().includes('GROUP_CHAT_UNAVAILABLE'));
  await h.advance(799); assert.equal(h.detailCount, 1);
  await h.advance(1);
  assert.ok(h.text().includes('owned-a'));
  assert.ok(h.text().includes('owned-message-1'));
  assert.ok(!h.text().includes('GROUP_CHAT_UNAVAILABLE'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query), [{ limit: 100 }, { limit: 100 }]);
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
  await h.advance(19_999); assert.equal(h.detailCount, 2, 'no successful idle read before the 20 second bound');
  await h.advance(201); assert.equal(h.detailCount, 3, 'the one-second check samples the 20 second idle deadline');
  await h.advance(60_000); assert.equal(h.detailCount, 6, 'successful idle checks stay at one read per 20 seconds');
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});

test('startup failures use capped backoff and recover after a long outage', async t => {
  let ready = false;
  const h = await harness(t, async id => { if (!ready) throw Error('offline'); return group(id); });
  await h.advance(31000);
  assert.equal(h.detailCount, 6, 'deterministic .5 jitter reads at 0, .8, 2.4, 5.6, 12 and 24.8 seconds');
  ready = true;
  await h.advance(19_399); assert.equal(h.detailCount, 6, 'the next retry deadline is 50.4 seconds');
  await h.advance(1);
  assert.ok(h.text().includes('owned-a'));
  assert.equal(h.detailCount, 7);
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});

test('successful group event clears the old error; other groups do not cause reads', async t => {
  let ready = false;
  const h = await harness(t, async id => { if (!ready) throw Error('offline'); return group(id); });
  ready = true;
  await h.change('other'); await h.advance(150); assert.equal(h.detailCount, 1);
  await h.change('a'); await h.change('a'); await h.advance(150);
  assert.equal(h.detailCount, 2);
  assert.ok(h.text().includes('owned-a'));
  assert.ok(!h.text().includes('offline'));
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});

test('focus and visible return recover idle groups without writes', async t => {
  let version = group('a');
  const h = await harness(t, async () => version);
  version = { ...version, group: { ...version.group, name: 'focused-authority' } };
  await h.event(h.window, 'focus'); assert.ok(h.text().includes('focused-authority'));
  version = { ...version, group: { ...version.group, name: 'visible-authority' } };
  h.document.visibilityState = 'hidden';
  await h.event(h.document, 'visibilitychange'); assert.equal(h.detailCount, 2);
  h.document.visibilityState = 'visible';
  await h.event(h.document, 'visibilitychange'); assert.equal(h.detailCount, 3);
  assert.ok(h.text().includes('visible-authority'));
});

test('failed refresh preserves draft, messages, approval and live member draft, then reads incrementally', async t => {
  const authority = group('a');
  authority.activeTurns = [{ opportunityId: 'live-turn', memberId: 'member', startedAt: 1, floor: true, released: false, draft: 'owned-live-draft' }];
  authority.pendingInteractions = [{ status: 'pending', opportunityId: 'approval-turn', memberId: 'member',
    request: { requestId: 'owned-approval', kind: 'approval' } }];
  let failing = false;
  const h = await harness(t, async () => { if (failing) throw Error('offline'); return authority; },
    async (id, query) => query.afterSeq ? page(id, 2) : page(id, 1));
  await act(async () => h.root().findByType('textarea').props.onChange({ target: { value: 'owned-composer-draft', selectionStart: 20 } }));
  failing = true;
  await h.event(h.window, 'focus');
  assert.equal(h.root().findByType('textarea').props.value, 'owned-composer-draft');
  assert.ok(h.text().includes('owned-message-1'));
  assert.ok(h.text().includes('owned-live-draft'));
  assert.equal(h.root().findAllByProps({ 'data-approval': 'owned-approval' }).length, 1);
  assert.ok(!h.text().includes('offline'));
  failing = false; await h.advance(1000);
  assert.equal(h.root().findByType('textarea').props.value, 'owned-composer-draft');
  assert.ok(h.text().includes('owned-message-1') && h.text().includes('owned-message-2'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query),
    [{ limit: 100 }, { afterSeq: 1, limit: 200 }, { afterSeq: 1, limit: 200 }]);
});

test('events during a pending first read coalesce into one incremental authoritative refresh', async t => {
  const first = deferred();
  const h = await harness(t, (id, count) => count === 1 ? first.promise : Promise.resolve(group(id)));
  await h.change('a'); await h.change('a'); await h.advance(150);
  await h.event(h.window, 'focus'); assert.equal(h.detailCount, 1);
  await act(async () => first.resolve(group('a')));
  assert.equal(h.detailCount, 2);
  assert.ok(h.text().includes('owned-a'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query), [{ limit: 100 }, { afterSeq: 1, limit: 200 }]);
});

test('switching group fences old pending success/failure and keeps a new first-page read', async t => {
  const old = deferred();
  const h = await harness(t, id => id === 'a' ? old.promise : Promise.resolve(group(id)), async id => page(id));
  await h.switch('b'); assert.ok(h.text().includes('owned-b'));
  await act(async () => old.reject(Error('old-generation-outage')));
  assert.ok(h.text().includes('owned-b'));
  assert.ok(!h.text().includes('old-generation-outage'));
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query), [{ limit: 100 }, { limit: 100 }]);
});

test('unmount cancels outage retries and lifecycle events; late response cannot retry', async t => {
  const h = await harness(t, async () => { throw Error('offline'); });
  assert.equal(h.retryTimers, 1); assert.equal(h.watchdogTimers, 1);
  await h.unmount();
  await h.advance(60000); await h.event(h.window, 'focus'); await h.event(h.document, 'visibilitychange'); await h.change('a');
  assert.equal(h.detailCount, 1); assert.equal(h.timers.size, 0);
  const late = deferred();
  const h2 = await harness(t, () => late.promise);
  await h2.unmount(); await act(async () => late.reject(Error('late-outage')));
  assert.equal(h2.timers.size, 0); assert.equal(h2.detailCount, 1);
});

test('first page preserves older pagination and incremental reads do not consume older history', async t => {
  const h = await harness(t, async id => group(id), async (id, query) => query.beforeSeq ? page(id, 100)
    : query.afterSeq ? page(id, 102) : page(id, 101, true));
  assert.equal(h.detailCount, 1);
  assert.ok(h.text().includes('groupChat.loadOlder'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query), [{ limit: 100 }]);
  await h.change('a'); await h.advance(150);
  assert.ok(h.text().includes('owned-message-101') && h.text().includes('owned-message-102'));
  assert.ok(h.text().includes('groupChat.loadOlder'));
  const older = h.root().findAllByType('button').find(b => b.children.includes('groupChat.loadOlder'));
  await act(async () => older.props.onClick());
  assert.ok(h.text().includes('owned-message-100'));
  assert.ok(!h.text().includes('groupChat.loadOlder'));
  assert.deepEqual(h.calls.filter(c => c.method === 'messages').map(c => c.query),
    [{ limit: 100 }, { afterSeq: 101, limit: 200 }, { beforeSeq: 101, limit: 100 }]);
});

test('wrong group and malformed message response cannot replace authoritative content', async t => {
  let authority = group('wrong'), malformed = false;
  const h = await harness(t, async () => authority, async id => malformed ? { hasMore: false } : page(id));
  assert.ok(h.text().includes('Invalid group chat response'));
  assert.ok(!h.text().includes('owned-wrong'));
  authority = group('a'); await h.advance(1000);
  assert.ok(h.text().includes('owned-a'));
  authority = { ...authority, group: { ...authority.group, name: 'partial-unconfirmed-view' } };
  malformed = true; await h.event(h.window, 'focus');
  assert.ok(h.text().includes('owned-a'));
  assert.ok(!h.text().includes('partial-unconfirmed-view'));
  malformed = false; await h.advance(1000);
  assert.ok(h.text().includes('partial-unconfirmed-view'));
});

test('late successful old-group read cannot change the selected group or clear its error', async t => {
  const old = deferred();
  const h = await harness(t, id => id === 'a' ? old.promise : Promise.reject(Error('new-group-outage')),
    async id => page(id));
  await h.switch('b');
  assert.ok(h.text().includes('new-group-outage'));
  await act(async () => old.resolve(group('a')));
  assert.ok(h.text().includes('new-group-outage'));
  assert.ok(!h.text().includes('owned-a'));
  assert.equal(h.retryTimers, 1, 'only the selected group retry survives');
  assert.equal(h.watchdogTimers, 1, 'only the selected group watchdog survives');
});

test('concurrent React incremental pages advance the cursor before rendering', async t => {
  const seen = [];
  const h = await harness(t, async (id, count) => { if (count > 10) throw Error('read safety bound'); return group(id); },
    async (id, query) => { seen.push(JSON.parse(JSON.stringify(query))); if (!query.afterSeq) return page(id, 100, true);
      const next = query.afterSeq + 1; return page(id, next, next < 103); });
  await h.event(h.window, 'focus');
  assert.deepEqual(seen, [{ limit: 100 }, { afterSeq: 100, limit: 200 }, { afterSeq: 101, limit: 200 }, { afterSeq: 102, limit: 200 }]);
  assert.ok(h.text().includes('owned-message-103'));
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});

test('continuous group events cannot postpone the initial recovery deadline', async t => {
  let ready = false;
  const h = await harness(t, async id => { if (!ready) throw Error('initial-outage'); return group(id); });
  ready = true;
  for (let n = 0; n < 25; n++) { await h.change('a'); await h.advance(100); }
  assert.ok(h.detailCount >= 2);
  assert.ok(h.text().includes('owned-a'));
  assert.ok(!h.text().includes('initial-outage'));
});

for (const badPage of ['empty', 'repeated']) test(`incremental hasMore with ${badPage} page stops and retains the view`, async t => {
  let invalid = true;
  const h = await harness(t, async (id, count) => { if (count > 4) throw Error('read safety bound'); return group(id); },
    async (id, query) => !query.afterSeq ? page(id, 10) : invalid
      ? { messages: badPage === 'empty' ? [] : [message(id, 10)], hasMore: true } : page(id, 11));
  await h.event(h.window, 'focus');
  assert.equal(h.detailCount, 2);
  assert.ok(h.text().includes('owned-message-10'));
  assert.equal(h.retryTimers, 1); assert.equal(h.watchdogTimers, 1);
  invalid = false; await h.advance(1000);
  assert.ok(h.text().includes('owned-message-11'));
  assert.equal(h.detailCount, 3); assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});

test('a long valid incremental stream is read in bounded batches', async t => {
  const h = await harness(t, async (id, count) => { if (count > 12) throw Error('read safety bound'); return group(id); },
    async (id, query) => !query.afterSeq ? page(id, 100) : page(id, query.afterSeq + 1, query.afterSeq < 109));
  await h.event(h.window, 'focus');
  assert.equal(h.detailCount, 9, 'one first read and at most eight incremental reads');
  assert.ok(h.text().includes('owned-message-108'));
  assert.equal(h.retryTimers, 1); assert.equal(h.watchdogTimers, 1);
  await h.advance(999); assert.equal(h.detailCount, 9);
  await h.advance(1); assert.equal(h.detailCount, 11);
  assert.ok(h.text().includes('owned-message-110'));
  assert.equal(h.retryTimers, 0); assert.equal(h.watchdogTimers, 1);
});
