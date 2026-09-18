import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import avatarModule from './helpers/load-agent-avatar.cjs';

const require = createRequire(path.resolve('app/manage-ui/package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [], observers = new Set(), timers = new Map(), listeners = new Map();
const delays = new Map(), sockets = [];
class WebSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
let timerId = 0;
const document = { visibilityState: 'visible', hidden: false,
  addEventListener: (name, listener) => listeners.set(listener, name), removeEventListener: (_name, listener) => listeners.delete(listener) };
const cache = new Map();
const load = file => {
  file = path.resolve('app/manage-ui/src', file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) }
    : name === '../components/AgentAvatar' ? avatarModule
    : name === 'react-i18next' ? { useTranslation: () => ({ t: (key, options) => options?.defaultValue ?? key }) }
      : name === '../api/client' ? { getInspirationActivity: (ideaId, runId, signal) => new Promise((resolve, reject) => requests.push({ ideaId, runId, signal, resolve, reject })) }
        : name.startsWith('.') ? load(path.resolve(path.dirname(file), name) + (fs.existsSync(path.resolve(path.dirname(file), name) + '.tsx') ? '.tsx' : '.ts')) : require(name);
  const setTimer = (fn, delay) => { timers.set(++timerId, fn); delays.set(timerId, delay); return timerId; };
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})(require,module,module.exports)`, {
    module, require: localRequire, document, AbortController, WebSocket, URLSearchParams,
    location: { protocol: 'http:', host: 'localhost:5173' },
    setTimeout: setTimer, clearTimeout: id => { timers.delete(id); delays.delete(id); },
    window: { setInterval: setTimer, clearInterval: id => timers.delete(id) },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.add(this); }
      observe() {} disconnect() { observers.delete(this); }
    },
  });
  cache.set(file, module.exports);
  return module.exports;
};
const { latestInspirationStep, inspirationRunTone } = load('pages/inspiration-run-status.ts');
const execution = { id: 'execution-a', ideaId: 'idea-a', runId: 'run-a', status: 'running', agentId: 'agent-a',
  backendId: 'shoggoth', sessionKey: 'session-a', createdAt: Date.now() - 180000, finishedAt: null, attention: null };
const parts = [
  { type: 'toolCall', toolCallId: 'a', toolName: 'read', toolArgs: { path: 'a.txt' } },
  { type: 'toolCall', toolCallId: 'b', toolName: 'write', toolArgs: { path: 'b.txt' } },
  { type: 'toolResult', toolCallId: 'a', text: 'File missing', isError: true },
];
assert.equal(latestInspirationStep(parts, true).toolName, 'read', 'a late parallel result is the latest activity');
assert.equal(latestInspirationStep(parts, true).status, 'error', 'the trajectory retains the individual tool failure');
assert.equal(inspirationRunTone(execution), 'running', 'a tool failure does not mark a running task as failed');
parts.push({ type: 'thinking', text: 'Trying a different file' });
assert.equal(inspirationRunTone(execution), 'running', 'recovery remains a running task');
parts.push({ type: 'plan', planEntries: [{ content: 'First', status: 'pending' }] },
  { type: 'text', text: 'Working' }, { type: 'plan', planEntries: [{ content: 'Second', status: 'in_progress' }] });
assert.equal(latestInspirationStep(parts, true).kind, 'plan', 'updated plans supersede newer text');
assert.equal(inspirationRunTone({ ...execution, status: 'failed' }), 'error');
assert.equal(inspirationRunTone({ ...execution, status: 'canceled' }), 'error');
assert.equal(inspirationRunTone({ ...execution, status: 'waiting_approval' }), 'attention');

const RunBar = load('pages/InspirationRunBar.tsx').default;
let renderer, opens = 0;
const view = current => React.createElement(RunBar, { ideaId: current.ideaId, execution: current,
  agent: { name: 'Shoggoth' }, attention: React.createElement('button', { type: 'button' }, 'Allow once'), onOpen: () => opens++ });
const root = () => renderer.root.findByProps({ 'data-inspiration-run-bar': true });
const header = () => renderer.root.findByProps({ 'data-inspiration-run-header': true });
const text = () => JSON.stringify(renderer.toJSON());
const reveal = () => { for (const observer of observers) observer.callback([{ isIntersecting: true }]); };
const response = (runId, text) => ({ runId, trajectory: { parts: [{ type: 'text', text }] }, artifacts: { items: [] } });
act(() => { renderer = create(view(execution), { createNodeMock: () => ({ querySelector: () => ({ focus() {} }) }) }); });
assert.equal(requests.length, 0, 'off-screen cards do not poll');
act(reveal);
assert.equal(requests.length, 1);
await act(async () => requests.shift().resolve(response('run-a', 'First live step')));
assert.ok(text().includes('First live step'));
act(() => { for (const [id, tick] of [...timers]) { timers.delete(id); tick(); } });
await act(async () => requests.shift().resolve(response('run-a', 'Second live step')));
assert.ok(text().includes('Second live step'));
assert.ok(!text().includes('First live step'), 'the status line replaces the previous activity');
const tickDelay = delay => { for (const [id, tick] of [...timers]) {
  if (delays.get(id) === delay) { timers.delete(id); delays.delete(id); tick(); }
} };
const ws = sockets.at(-1);
act(() => {
  ws.open();
  ws.receive({ type: 'res', id: ws.sent[0].id, ok: true, payload: {} });
});
assert.deepEqual(ws.sent.map(frame => frame.method), ['sessions.list', 'sessions.subscribe', 'chat.history']);
assert.equal(ws.sent.at(-1).params.sessionKey, 'agent:agent-a:session-a');
act(() => tickDelay(100));
assert.equal(requests.length, 1, 'connection recovery refreshes immediately');
// Multiple events during a slow REST read must cause one trailing exact-run read.
act(() => {
  for (let i = 0; i < 20; i++) ws.receive({ type: 'event', event: 'session.tool',
    payload: { sessionKey: 'agent:agent-a:session-a', data: { phase: 'update' } } });
});
await act(async () => requests.shift().resolve(response('run-a', 'Snapshot before event')));
act(() => tickDelay(100));
assert.equal(requests.length, 1, 'event bursts coalesce without waiting for a polling interval');
await act(async () => requests.shift().resolve(response('run-a', 'Live tool result')));
assert.ok(text().includes('Live tool result'));
act(() => {
  ws.receive({ type: 'event', event: 'chat', payload: { sessionKey: 'foreign-session', runId: 'run-a', state: 'delta' } });
  ws.receive({ type: 'event', event: 'chat', payload: { sessionKey: 'agent:agent-a:session-a', runId: 'foreign-run', state: 'delta' } });
  tickDelay(100);
});
assert.equal(requests.length, 0, 'foreign sessions and explicit foreign runs never invalidate this card');
const { watchInspirationActivity } = load('pages/inspiration-activity-events.ts');
const socketCount = sockets.length;
const stopDetail = watchInspirationActivity('agent:agent-a:session-a', 'run-a', () => {});
assert.equal(sockets.length, socketCount, 'the card and detail share a connection and session observer');
stopDetail();
assert.equal(ws.readyState, WebSocket.OPEN);
act(() => header().props.onClick());
assert.equal(opens, 1);

// Reproduce the reported card: a failed search result while the run continues.
const searchFailure = { runId: 'run-a', trajectory: { parts: [
  { type: 'toolCall', toolCallId: 'search', toolName: 'web_search', toolArgs: { query: 'Weekly report sources' } },
  { type: 'toolResult', toolCallId: 'search', text: 'Source unavailable; preparing an alternative.', isError: true },
] }, artifacts: { items: [] } };
act(() => {
  ws.receive({ type: 'event', event: 'session.tool', payload: { sessionKey: 'agent:agent-a:session-a', data: { phase: 'result', isError: true } } });
  tickDelay(100);
});
await act(async () => requests.shift().resolve(searchFailure));
assert.equal(root().props['data-tone'], 'running', 'an individual failed search keeps the black running bar');
assert.equal(renderer.root.findAllByProps({ className: 'name' }).length, 0, 'running bars never show the assistant name');
assert.equal(renderer.root.findAllByProps({ className: 'elapsed' }).length, 1);
assert.ok(header().props['aria-label'].includes('Source unavailable; preparing an alternative.'), 'the actual tool result remains in the live activity');

act(() => renderer.update(view({ ...execution, status: 'failed', finishedAt: Date.now() })));
await act(async () => requests.shift().resolve(searchFailure));
assert.equal(root().props['data-tone'], 'error', 'a terminal run failure turns the bar red');
assert.equal(renderer.root.findAllByProps({ className: 'name' }).length, 1);
assert.equal(renderer.root.findAllByProps({ className: 'elapsed' }).length, 0, 'failed runs never show a running timer');
assert.equal(header().props['aria-label'], 'Shoggoth · inspiration.status.failed', 'the failed bar shows its status instead of stale activity');

act(() => renderer.update(view({ ...execution, status: 'canceled', finishedAt: Date.now() })));
assert.equal(root().props['data-tone'], 'error', 'manual stops use the same red bar as failed executions');
assert.equal(header().props['aria-label'], 'Shoggoth · inspiration.status.failed');
assert.equal(renderer.root.findAllByProps({ className: 'elapsed' }).length, 0);

const approval = { ...execution, status: 'waiting_approval', attention: { active: true,
  request: { requestId: 'request-a', kind: 'runtime_approval', fields: [] } } };
act(() => renderer.update(view(approval)));
act(() => renderer.update(view({ ...approval, status: 'waiting_input', attention: {
  ...approval.attention, request: { ...approval.attention.request, kind: 'mcp_permission' },
} })));
assert.ok(header().props['aria-label'].includes('inspiration.status.waiting_approval'), 'MCP permission requests use approval wording even on a waiting_input run');
assert.equal(root().props['data-tone'], 'attention', 'approval keeps its own state even after a failed tool');
assert.equal(renderer.root.findAllByProps({ className: 'elapsed' }).length, 0);
const panel = () => renderer.root.findByProps({ 'data-inspiration-run-attention': true });
assert.equal(panel().props.hidden, true);
act(() => root().props.onPointerEnter({ pointerType: 'mouse' }));
assert.equal(header().props['aria-expanded'], true);
assert.equal(panel().props.hidden, false);
const mountedPanel = panel();
act(() => root().props.onPointerLeave());
assert.equal(panel().props.hidden, true);
assert.equal(panel(), mountedPanel, 'collapse preserves the in-flight approval component');
act(() => header().props.onClick());
assert.equal(panel().props.hidden, false, 'touch/click can open the approval');
act(() => root().props.onKeyDown({ key: 'Escape', stopPropagation() {} }));
assert.equal(panel().props.hidden, true);
act(() => root().props.onFocus({ target: { matches: () => true } }));
assert.equal(panel().props.hidden, false, 'keyboard focus opens the approval');

const abandoned = requests.at(-1);
act(() => renderer.update(view({ ...execution, id: 'execution-b', runId: 'run-b' })));
assert.equal(abandoned.signal.aborted, true);
assert.ok(!text().includes('Second live step'), 'a new run never displays the previous run trajectory');
await act(async () => abandoned.resolve(response('run-a', 'Stale late step')));
assert.ok(!text().includes('Stale late step'));
const current = requests.at(-1);
act(() => renderer.unmount());
assert.equal(current.signal.aborted, true);
assert.equal(observers.size, 0);
assert.equal(listeners.size, 0);
const ChatPromptCard = load('pages/ChatPromptCard.tsx').default;
let submissions = 0, settle;
const entry = { id: 'request', version: 1, requestId: 'request', runId: 'run', kind: 'runtime_approval',
  message: 'Review this command', fields: [], approvalChoices: ['once', 'session', 'deny'],
  approvalDetails: { kind: 'command', command: 'node isolated-test.cjs' } };
const visibleText = node => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(visibleText).join(' ') : visibleText(node?.children || []);
for (const details of [
  { kind: 'file_change', input: JSON.stringify({ file_path: '/workspace/capture.md' }), command: 'Edit /workspace/capture.md' },
  { kind: 'command', toolName: 'Bash', command: 'node isolated-test.cjs' },
  { kind: 'mcp', toolName: 'shoggoth__kanban_card_update', input: JSON.stringify({ title: 'New title', body: 'Full description' }) },
]) {
  const props = { entry: { ...entry, approvalDetails: details }, onRespond: async () => {} };
  let full, compact;
  act(() => { full = create(React.createElement(ChatPromptCard, props)); compact = create(React.createElement(ChatPromptCard, { ...props, compactApproval: true })); });
  assert.equal(visibleText(compact.toJSON()), visibleText(full.toJSON()), 'compact approval preserves exactly the Chat content and choices');
  if (details.kind === 'file_change') assert.ok(visibleText(compact.toJSON()).includes('chat.promptChangeFiles'));
  act(() => { full.unmount(); compact.unmount(); });
}
act(() => { renderer = create(React.createElement(ChatPromptCard, { entry, compactApproval: true,
  onRespond: () => { submissions++; return new Promise(resolve => { settle = resolve; }); } })); });
assert.equal(renderer.root.findAllByProps({ className: 'chat-prompt__content' }).length, 1);
const choices = renderer.root.findAllByType('button');
assert.equal(choices.length, 3, 'compact approval preserves all authoritative choices including session and deny');
act(() => { choices[0].props.onClick(); choices[1].props.onClick(); });
assert.equal(submissions, 1, 'compact approval keeps the shared duplicate-submit guard');
assert.ok(renderer.root.findAllByType('button').every(button => button.props.disabled));
await act(async () => settle());
act(() => renderer.unmount());
console.log('PASS rooting card: trajectory events, burst coalescing, shared observers, exact-run isolation, viewport cleanup, approval content parity and submission guard');
