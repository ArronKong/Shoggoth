import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript'), React = require('react');
const { create, act } = require('react-test-renderer');
const requests = [], intervals = new Map(), timeouts = new Map(), listeners = new Map();
let timer = 0;
const document = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: name => listeners.delete(name) };
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports: module.exports, AbortController, document, window: {
    setInterval: fn => { intervals.set(++timer, fn); return timer; }, clearInterval: id => intervals.delete(id),
    setTimeout: fn => { timeouts.set(++timer, fn); return timer; }, clearTimeout: id => timeouts.delete(id),
  }, require: name => name.endsWith('/api/client') ? {
    getBackendRunDetail: (backend, run, signal) => new Promise((resolve, reject) => requests.push({ backend, run, signal, resolve, reject })),
  } : name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name) });
  return module.exports;
}
const { dashboardRunPresentation: present } = load(path.join(root, 'app/manage-ui/src/pages/dashboard/runPresentation.ts'));
const base = { id: 'a:one', backendId: 'a', runId: 'one', source: 'cron', status: 'running', artifacts: [] };
const events = [
  { seq: 1, type: 'status', status: 'running' },
  { seq: 2, type: 'performance.stage' },
  { seq: 3, type: 'text.delta', delta: '正在核对', segmentId: 'progress' },
  { seq: 4, type: 'text', text: '正在核对官方消息。', phase: 'commentary', segmentId: 'progress' },
  { seq: 5, type: 'text', text: '正在核对官方消息。', phase: 'commentary', segmentId: 'progress' },
  { seq: 6, type: 'tool.start', toolCallId: 'lookup', tool: { name: 'web_search', displayArgs: { activityTitle: '查找官方公告' } } },
  { seq: 7, type: 'tool.update', toolCallId: 'lookup', tool: { name: 'web_search' }, message: 'Found sources' },
  { seq: 8, type: 'tool.result', toolCallId: 'lookup', tool: { name: 'web_search', status: 'failed', resultSummary: 'Network unavailable' } },
  { seq: 9, type: 'text.delta', delta: '## 结论\n' },
  { seq: 10, type: 'text.delta', delta: '已完成核对。' },
];
let view = present({ ...base, events });
assert.equal('output' in view, false, 'Run activity does not project a separate reply/result body');
assert.equal(view.steps.length, 2, 'Debug/status events and reply fragments are not activity rows');
assert.equal(view.steps[0].text, '正在核对官方消息。');
assert.equal(view.steps[1].status, 'error', 'A failed tool remains failed while the run continues');
assert.equal(view.steps[1].args.activityTitle, '查找官方公告');
assert.equal(view.live, true);
assert.deepEqual(present({ ...base, events: [...events, events[9]] }).steps, view.steps, 'Replayed seq cannot duplicate activity');
view = present({ ...base, status: 'completed', summary: 'short summary', events });
assert.equal(view.steps.length, 2, 'Completed reply and summary stay out of the execution activity');
assert.equal(view.live, false);
view = present({ ...base, events: [...events, { seq: 11, type: 'terminal', status: 'completed' }] });
assert.equal(view.live, false, 'Terminal event can arrive after the run snapshot was read');
view = present({ ...base, status: 'canceled', events: events.slice(0, 7) });
assert.equal(view.steps[1].status, 'aborted');
assert.equal(present({ ...base, status: 'failed', summary: 'Failure summary', events: [] }).steps.length, 0);

const { useDashboardRunDetail } = load(path.join(root, 'app/manage-ui/src/pages/dashboard/useDashboardRunDetail.ts'));
let state;
function Host({ run = 'one', open = true }) { state = useDashboardRunDetail('a', run, open); return null; }
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });
const tick = () => { for (const fn of intervals.values()) fn(); };
let renderer;
await settle(() => { renderer = create(React.createElement(Host)); });
assert.equal(requests.length, 1);
await settle(tick); assert.equal(requests.length, 1, 'Slow requests cannot overlap');
await settle(() => requests[0].resolve({ ...base, events }));
assert.equal(state.detail.events.length, 10);
await settle(tick);
await settle(() => requests[1].reject(Error('offline')));
assert.equal(state.error, true); assert.equal(state.detail.events.length, 10, 'Transient failure retains readable content');
document.visibilityState = 'hidden';
await settle(tick); assert.equal(requests.length, 2);
document.visibilityState = 'visible';
await settle(() => listeners.get('visibilitychange')());
assert.equal(requests.length, 3);
await settle(() => requests[2].resolve({ ...base, status: 'completed', events }));
assert.equal(state.error, false);
await settle(tick); assert.equal(requests.length, 3, 'Terminal runs stop polling');
await settle(() => state.refresh());
assert.equal(requests.length, 4, 'Manual retry can still refresh a terminal snapshot');
await settle(() => renderer.update(React.createElement(Host, { open: false })));
assert.equal(requests[3].signal.aborted, true);
await settle(() => requests[3].resolve({ ...base, status: 'running', events: [] }));
assert.equal(state.detail.status, 'completed', 'Closing invalidates the in-flight response');
assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
await settle(() => renderer.update(React.createElement(Host, { key: 'two', run: 'two' })));
assert.equal(state.detail, null, 'A new run starts without another run\'s content');
await settle(() => requests[4].resolve({ ...base, events }));
assert.equal(state.detail, null, 'A mismatched run response is rejected'); assert.equal(state.error, true);
await settle(tick);
await settle(() => renderer.unmount());
assert.equal(requests[5].signal.aborted, true);
await settle(() => requests[5].resolve({ ...base, runId: 'two', events }));
assert.equal(intervals.size, 0); assert.equal(timeouts.size, 0);
console.log('PASS Dashboard run details: public progress, text merging, tools, terminal state, retries, identity, visibility and cleanup');
