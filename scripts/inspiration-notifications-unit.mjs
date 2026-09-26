import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
function load(file, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports: module.exports, ...globals });
  return module.exports;
}
const { sanitizeNotifications, normalizeConfig } = require(path.join(root, 'app/core/config-store.js'));
const allOn = { chat: true, cron: true, task: true };
assert.deepEqual(sanitizeNotifications(undefined), allOn);
assert.deepEqual(sanitizeNotifications({ chat: null, cron: 'false', task: 0 }), allOn);
assert.deepEqual(sanitizeNotifications({ task: false }), { ...allOn, task: false });
assert.deepEqual(normalizeConfig({ notifications: { chat: false, cron: false, task: false } }).notifications,
  { chat: false, cron: false, task: false }, 'Existing explicit choices survive normalization');

const helper = load('app/manage-ui/src/lib/inspiration-notifications.ts');
const { readInspirationNotifications: read, inspirationNotificationStatus: statusOf } = helper;
const active = new Set(['queued', 'starting', 'running', 'waiting_input', 'waiting_approval', 'unknown']);
function idea(id, status = 'saved', at = 100) {
  return { id, title: `Idea ${id}`, body: '', archivedAt: null, createdAt: at, updatedAt: at, status,
    latestExecution: status === 'saved' ? null : { runId: `run-${id}`, status, createdAt: at, attention: null } };
}
const recent = Array.from({ length: 60 }, (_, i) => idea(`recent-${i}`, 'saved', 1_000 - i));
let rows = [...recent, idea('long-running', 'running', 10)];
const details = [], pages = [];
const reader = {
  list: async ({ filter, cursor, limit }) => {
    pages.push({ filter, cursor });
    const visible = rows.filter(item => item.archivedAt === null && (filter !== 'active' || active.has(statusOf(item))))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const offset = Number(cursor || 0), items = visible.slice(offset, offset + limit);
    return { items: structuredClone(items), total: visible.length, hasMore: offset + limit < visible.length,
      nextCursor: offset + limit < visible.length ? String(offset + limit) : null };
  },
  get: async id => {
    details.push(id);
    const found = rows.find(item => item.id === id);
    if (!found) throw Object.assign(new Error('deleted'), { status: 404 });
    return { idea: structuredClone(found) };
  },
};
let sample = await read(null, reader);
assert.equal(sample.changed.length, 0, 'Initial history is silent');
assert.equal(pages.filter(page => page.filter === 'all').length, 1, 'Seeding does not scan all saved history');
assert.ok(sample.snapshot.states.has('long-running'), 'Older active notes remain tracked beyond the recent page');
const baseline = sample.snapshot;
rows[60].latestExecution.status = 'completed';
await assert.rejects(read(baseline, { ...reader, get: async () => { throw new Error('offline'); } }), /offline/);
assert.equal(baseline.states.get('long-running').active, true, 'Failed reads preserve the previous baseline');
sample = await read(baseline, reader);
assert.equal(sample.changed.map(item => item.id).join(), 'long-running');
assert.ok(details.includes('long-running'), 'Completion is resolved even without an updatedAt change');
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 0, 'A completion is delivered only once');

rows[60].updatedAt = 1_100;
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 0, 'Editing an old result is not a new run');
rows[60] = { ...rows[60], updatedAt: 1_200, latestExecution: { runId: 'retry', status: 'running', createdAt: 1_200 } };
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.map(item => item.id).join(), 'long-running', 'A retry is a new activity');
rows[60].latestExecution.attention = { active: true, request: { kind: 'approval', requestId: 'request-1' } };
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 1);
assert.equal(statusOf(sample.changed[0]), 'waiting_approval');
rows[60].latestExecution.attention.request.requestId = 'request-2';
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 1, 'A new approval request must notify even when the status is unchanged');
rows[60].latestExecution.attention = { active: true, request: { kind: 'user_input', requestId: 'input-1' } };
sample = await read(sample.snapshot, reader);
assert.equal(statusOf(sample.changed[0]), 'waiting_input');
for (const status of ['completed', 'running', 'failed', 'canceled', 'interrupted', 'skipped']) {
  rows[60].latestExecution.attention = null;
  rows[60].latestExecution.status = status;
  sample = await read(sample.snapshot, reader);
  assert.equal(sample.changed.length, 1, `Observed ${status} state must notify`);
}
rows[60].archivedAt = 1_300;
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 0, 'Archived notes are silent');

rows = Array.from({ length: 65 }, (_, i) => idea(`active-${i}`, 'running', 100 + i));
sample = await read(null, reader);
assert.equal(sample.snapshot.states.size, 65, 'All active pages are seeded');
rows[0].latestExecution.status = 'failed';
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.map(item => item.id).join(), 'active-0');
rows[1].archivedAt = 500;
rows.splice(2, 1);
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 0, 'Archived or deleted active notes are not announced');
rows.push(...Array.from({ length: 70 }, (_, i) => idea(`new-${i}`, 'completed', 2_000 + i)));
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 70, 'Changes beyond one recent page are not lost');
sample = await read(sample.snapshot, reader);
assert.equal(sample.changed.length, 0);
await assert.rejects(read(null, { ...reader, list: async ({ filter }) => filter === 'active'
  ? { items: [], hasMore: true, nextCursor: 'loop' } : { items: [], hasMore: false } }), /cursor/);

// Mount the real driver with in-memory APIs; never emit real system notifications.
const React = require('react');
const { create, act } = require('react-test-renderer');
const notices = [], intervals = new Map(), listeners = new Map(), toasts = [], taskReads = [];
let openTarget, resolveConfig, pendingList = null, listCalls = 0, cronCalls = 0, timerId = 0;
let config = new Promise(resolve => { resolveConfig = resolve; });
let current = idea('target:with & punctuation', 'running');
let boardTasks = [], cronJobs = [], taskDetail = {}, boardIds = [];
class Socket { close() {} send() {} }
const location = { protocol: 'http:', host: 'fixture', hash: '' };
const window = { location, addEventListener: (name, callback) => listeners.set(name, callback),
  removeEventListener: name => listeners.delete(name) };
const notifications = load('app/manage-ui/src/lib/notify.ts', { window });
const agentDisplay = load('app/manage-ui/src/lib/agentDisplay.ts');
const api = {
  getConfig: async () => config,
  getBoards: async () => boardIds.map(id => ({ id })),
  getTaskBoard: async () => ({ columns: [{ name: 'Doing', tasks: structuredClone(boardTasks) }] }),
  getTask: async (...args) => { taskReads.push(args); return taskDetail; },
  listCronJobs: async () => { cronCalls++; return structuredClone(cronJobs); },
  listInspirations: async ({ filter }) => {
    listCalls++;
    if (filter === 'all' && pendingList) return pendingList;
    return { items: filter === 'active' && !active.has(statusOf(current)) ? [] : [structuredClone(current)], hasMore: false };
  },
  getInspiration: async () => ({ idea: structuredClone(current) }),
};
const backends = ['openclaw'];
const Notifier = load('app/manage-ui/src/components/Notifier.tsx', {
  require: name => {
    if (name === 'react') return React;
    if (name === './ui') return { useToast: () => ({ info: text => toasts.push(text), error: text => toasts.push(text) }) };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: (key, params) => `${key}${params?.title ? `:${params.title}` : ''}` }) };
    if (name === '../api/client') return api;
    if (name === '../lib/backends') return { useEnabledBackends: () => backends };
    if (name === '../lib/agentDisplay') return agentDisplay;
    if (name === '../lib/shoggothDomainUi') return { usesExplicitBoardIdentity: () => boardIds.length > 0 };
    if (name === '../lib/inspiration-notifications') return helper;
    if (name === '../lib/notify') return { ...notifications,
      onOpenTarget: callback => { openTarget = callback; return () => { openTarget = null; }; },
      fireNotification: (payload, options) => { notices.push({ payload, options }); return true; } };
    return require(name);
  },
  window, location, WebSocket: Socket, setTimeout, clearTimeout,
  setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
  clearInterval: id => intervals.delete(id),
}).default;
const settle = async callback => act(async () => { callback(); await new Promise(resolve => setImmediate(resolve)); });
const poll = () => settle(() => { for (const callback of intervals.values()) callback(); });
const save = value => settle(() => { config = value; listeners.get('openclaw:config-changed')(); });
let renderer;
await settle(() => { renderer = create(React.createElement(Notifier)); });
await poll();
assert.equal(listCalls + cronCalls, 0, 'Do not poll before saved preferences are known');
await settle(() => resolveConfig({ notifications: { chat: false, cron: false, task: false } }));
assert.equal(listCalls + cronCalls, 0, 'Explicit disabled settings do not poll');
await save({});
assert.ok(listCalls > 0 && cronCalls > 0, 'Missing preferences enable all categories');
assert.equal(notices.length, 0, 'Enabling starts with a silent baseline');
current.latestExecution.status = 'completed';
await poll();
assert.equal(notices.length, 1);
assert.equal(notices[0].payload.category, 'task');
assert.equal(notices[0].payload.body, 'inspiration.status.completed');
assert.match(notices[0].payload.title, /^notif.inspirationUpdated:Idea /);
const target = `inspiration:${current.id}`;
assert.equal(notices[0].payload.target, target);
notices[0].options.onClick();
assert.equal(location.hash, `#/inspirations?id=${encodeURIComponent(current.id)}`, 'Browser notification opens the exact note');
location.hash = '';
openTarget({ category: 'task', target });
assert.equal(location.hash, `#/inspirations?id=${encodeURIComponent(current.id)}`, 'Native notification opens the exact note');
openTarget({ category: 'task', target: null });
assert.equal(location.hash, `#/inspirations?id=${encodeURIComponent(current.id)}`, 'Legacy task notifications never return to the hidden board');
assert.equal(toasts.at(-1), 'notif.taskSessionUnavailable');
await poll();
assert.equal(notices.length, 1);

let resolveList;
pendingList = new Promise(resolve => { resolveList = resolve; });
await poll();
const beforeOverlap = listCalls;
await poll();
assert.equal(listCalls, beforeOverlap, 'Slow inspiration requests do not overlap');
await save({ notifications: { ...allOn, task: false } });
await save({ notifications: allOn });
current.latestExecution.status = 'failed';
await settle(() => { resolveList({ items: [structuredClone(current)], hasMore: false }); pendingList = null; });
assert.equal(notices.length, 1, 'A request started before disable/re-enable must not notify');
await poll();
assert.equal(notices.length, 1, 'Re-enabling silently resets the baseline');
current.latestExecution = { runId: 'next', status: 'running', createdAt: 200 };
current.updatedAt = 200;
await poll();
assert.equal(notices.length, 2);
await save({ notifications: { ...allOn, task: false } });
const beforeDisabled = listCalls;
current.latestExecution.status = 'completed';
await poll();
assert.equal(listCalls, beforeDisabled);
assert.equal(notices.length, 2);

cronJobs = [{ id: 'job:with & punctuation', backendId: 'openclaw', name: 'Scheduled task', lastRunAt: 100 }];
boardIds = ['board:with & punctuation'];
await save({ notifications: allOn });
cronJobs[0].lastRunAt = 200;
boardTasks = [{ id: 'task-1', title: 'Task', column: 'doing', sessionKey: 'agent:main:task / session&1' }];
await poll();
const cronNote = notices.findLast(note => note.payload.category === 'cron');
const boardNote = notices.findLast(note => note.payload.target?.kind === 'task');
assert.ok(cronNote && boardNote, 'Cron and board changes must carry actionable targets');
cronNote.options.onClick();
let query = new URLSearchParams(location.hash.split('?')[1]);
assert.equal(query.get('job'), cronJobs[0].id);
assert.equal(query.get('backend'), 'openclaw');
const firstClick = query.get('notification');
openTarget(cronNote.payload);
query = new URLSearchParams(location.hash.split('?')[1]);
assert.equal(query.get('job'), cronJobs[0].id);
assert.notEqual(query.get('notification'), firstClick, 'A second native click can reopen the same Cron detail');
boardNote.options.onClick();
query = new URLSearchParams(location.hash.split('?')[1]);
assert.ok(location.hash.startsWith('#/chat?'));
assert.equal(query.get('session'), boardTasks[0].sessionKey);
assert.equal(query.get('backend'), 'openclaw');
assert.equal(taskReads.length, 0, 'A known session opens without another task read');
openTarget(boardNote.payload);
assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('session'), boardTasks[0].sessionKey);

boardTasks[0] = { ...boardTasks[0], sessionKey: undefined, column: 'done' };
await poll();
const movedNote = notices.findLast(note => note.payload.target?.kind === 'task');
taskDetail = { execution: { sessionKey: 'agent:main:resolved-session' } };
await settle(() => movedNote.options.onClick());
assert.deepEqual(taskReads.at(-1), ['openclaw', 'task-1', boardIds[0]], 'Session fallback uses the exact backend, task and board');
assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('session'), taskDetail.execution.sessionKey);
const beforeMissing = location.hash;
taskDetail = {};
await settle(() => openTarget(movedNote.payload));
assert.equal(location.hash, beforeMissing);
assert.equal(toasts.at(-1), 'notif.taskSessionUnavailable');

let finishTaskRead;
taskDetail = new Promise(resolve => { finishTaskRead = resolve; });
await settle(() => openTarget(movedNote.payload));
openTarget({ category: 'task', target });
await settle(() => finishTaskRead({ sessionKey: 'agent:main:stale' }));
assert.equal(location.hash, `#/inspirations?id=${encodeURIComponent(current.id)}`, 'A late task lookup cannot replace a more recent notification click');
api.getTask = async () => { throw new Error('offline'); };
await settle(() => openTarget(movedNote.payload));
assert.equal(toasts.at(-1), 'notif.taskSessionFailed');
assert.equal(location.hash, `#/inspirations?id=${encodeURIComponent(current.id)}`);
await settle(() => renderer.unmount());
assert.equal(intervals.size + listeners.size, 0);
assert.equal(openTarget, null);

const message = { role: 'assistant', content: 'Done' };
assert.equal(notifications.chatNotificationFor({ ...message, shoggoth: { source: 'inspiration' } }, 'agent:codex:session'), null);
assert.equal(notifications.chatNotificationFor(message, 'agent:main:dashboard:inspiration-abc'), null);
assert.equal(notifications.chatNotificationFor({ ...message, shoggoth: { source: 'cron' } }, 'agent:codex:session'), null);
assert.equal(notifications.chatNotificationFor(message, 'agent:codex:session').category, 'chat');

// Verify real native and external backend completion paths attach provenance.
const { ShoggothBackend } = require(path.join(root, 'app/core/shoggoth-backend.js'));
const final = [], activities = [];
const context = { _generation: 1, _state: 'started', _activeBySession: new Map(),
  _sessionsByKey: new Map([['raw-key', { inspirationId: 'idea' }]]),
  _clearSessionRuntime() {}, _invokeHook: (hooks, name, ...args) => hooks[name]?.(...args),
  _syncFederationTargetSession: async () => ({ liveSession: true, sessionKey: 'agent:codex:key' }),
  _sessionActivityNotifier: value => activities.push(value) };
await ShoggothBackend.prototype._settleTerminal.call(context,
  { run: { id: 'run', source: 'inspiration' }, sessionKey: 'raw-key', poll: {}, hooks: { final: (...args) => final.push(args) } },
  { text: 'Done' }, { id: 'run', status: 'completed' });
assert.equal(final[0][2].notificationCategory, 'inspiration');
await ShoggothBackend.prototype._observeExternalInspirationExecution.call(context, {},
  { runId: 'external', status: 'completed', attention: null, resultSummary: 'Done' },
  { final: (...args) => final.push(args) }, {}, 1);
assert.equal(final[1][2].notificationCategory, 'inspiration');
await ShoggothBackend.prototype._applyFederationTerminalActivity.call(context,
  { sessionKey: 'raw-key', runId: 'run', status: 'completed', result: 'Done', finishedAt: 200 }, 1);
assert.equal(activities[0].notificationCategory, 'inspiration');

console.log('PASS notification defaults, inspiration pagination/transitions/retries, mounted preference gating, click navigation, and backend provenance');
