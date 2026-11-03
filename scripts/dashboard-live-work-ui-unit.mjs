import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
const timers = new Map(), listeners = new Map(), requests = [];
let nextTimer = 0;
const document = { visibilityState: 'visible',
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: name => listeners.delete(name),
};
const responseModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/lib/dashboardPromptResponses.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: responseModule.exports });
const { acknowledgeDashboardPrompt } = responseModule.exports;
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/dashboard/useDashboardLiveWork.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { exports: module.exports, document, window: {
  setInterval: (fn, delay) => { assert.equal(delay, 3000); timers.set(++nextTimer, fn); return nextTimer; },
  clearInterval: id => timers.delete(id),
}, require: name => name.endsWith('/api/client') ? {
  getDashboardLiveWork: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
} : name.endsWith('/lib/dashboardPromptResponses') ? responseModule.exports : require(name) });

let state, displayedWork;
const fallback = { generatedAt: 1, running: [{ backend: 'a', supported: true, items: [{ id: 'active-run' },
  { id: 'old-waiting-run', status: 'waiting_approval', waitingRequestId: 'cached-task-request' }] }],
  approvals: [{ backend: 'a', supported: true, items: [{ id: 'old-cached-approval' }] }] };
const failed = { backend: 'a', supported: false, reason: 'error', items: [] };
const snapshot = (id) => ({ generatedAt: 2, running: [{ backend: 'a', supported: true, items: id ? [{ id }] : [] }],
  approvals: [{ backend: 'a', supported: true, items: [] }] });
function Host({ scope = '', seed = fallback }) {
  state = module.exports.useDashboardLiveWork(seed, scope);
  displayedWork = state.work || seed;
  return null;
}
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });
const tick = () => { for (const fn of timers.values()) fn(); };
let renderer;
await settle(() => { renderer = create(React.createElement(Host)); });
assert.equal(requests.length, 1, 'Live work refreshes immediately on entry');
assert.equal(displayedWork.approvals[0]?.items.length || 0, 0,
  'Cached approvals must not flash as pending before the live read returns');
assert.equal(displayedWork.running[0].items.length, 1, 'A cached waiting task must not recreate an approval row');
await settle(tick);
assert.equal(requests.length, 1, 'Slow polls cannot overlap or accumulate');
await settle(() => requests[0].resolve({ generatedAt: 2, running: [failed], approvals: [failed] }));
assert.equal(state.work.running[0].items[0].id, 'active-run', 'A failed first poll preserves the summary fallback');
assert.equal(state.work.running[0].items.length, 1, 'A failed first poll cannot revive cached waiting tasks');
assert.equal(state.work.approvals[0].items.length, 0,
  'A failed first poll cannot revive approvals from a historical summary');
await settle(tick);
assert.equal(requests.length, 2);
await settle(() => requests[1].resolve(snapshot('new-run')));
assert.equal(state.work.running[0].items[0].id, 'new-run');
document.visibilityState = 'hidden';
await settle(tick);
assert.equal(requests.length, 2, 'Hidden Dashboard must not keep polling');
document.visibilityState = 'visible';
await settle(() => listeners.get('visibilitychange')());
assert.equal(requests.length, 3, 'Returning to Dashboard refreshes promptly');
await settle(() => { void state.refresh(); });
assert.equal(requests.length, 4, 'Approval response can force a newer refresh over an in-flight poll');
await settle(() => requests[3].resolve(snapshot('resumed-run')));
await settle(() => requests[2].resolve(snapshot('old-waiting-run')));
assert.equal(state.work.running[0].items[0].id, 'resumed-run', 'Late polls must not roll a response back to waiting');
await settle(tick);
await settle(() => requests[4].reject(new Error('offline')));
assert.equal(state.work.running[0].items[0].id, 'resumed-run', 'Transport failure retains the last valid state');
await settle(tick);
await settle(() => requests[5].resolve({ generatedAt: 3, running: [failed], approvals: [failed] }));
assert.equal(state.work.running[0].items[0].id, 'resumed-run', 'Partial source failure cannot look like task completion');
await settle(tick);
await settle(() => requests[6].resolve(snapshot(null)));
assert.equal(state.work.running[0].items.length, 0, 'A valid empty response removes completed runs');
await settle(tick);
await settle(() => renderer.unmount());
await settle(() => requests[7].resolve(snapshot('late-run')));
assert.equal(timers.size, 0);
assert.equal(listeners.size, 0);
assert.equal(state.work.running[0].items.length, 0, 'Unmounted Dashboard ignores in-flight responses');
await settle(() => { renderer = create(React.createElement(Host, { scope: 'a' })); });
const previousRequest = requests.at(-1);
const seedB = { generatedAt: 4, running: [{ backend: 'b', supported: true, items: [{ id: 'b-run' }] }], approvals: [] };
await settle(() => renderer.update(React.createElement(Host, { scope: 'b', seed: seedB })));
assert.equal(state.work.running[0].items[0].id, 'b-run', 'Connection scope changes select only the new fallback');
assert.notEqual(requests.at(-1), previousRequest, 'A scope change starts a fresh poll without waiting for the previous request');
await settle(() => previousRequest.resolve(snapshot('disabled-a-run')));
assert.equal(state.work.running[0].items[0].id, 'b-run', 'A poll from a disconnected scope cannot repopulate live work');
await settle(() => requests.at(-1).resolve({ generatedAt: 5,
  running: [{ backend: 'b', supported: false, reason: 'error', items: [] }], approvals: [],
}));
assert.equal(state.work.running[0].items[0].id, 'b-run', 'Failure fallback belongs to the new connection scope');
await settle(() => renderer.unmount());

// A Chat receipt must win immediately, including over a late poll and source
// errors, without hiding the next request or another backend's request.
const identity = { backendId: 'a', runId: 'chat-run', requestId: 'answered-request' };
const approval = { id: 'approval-a', ...identity, source: 'chat', kind: 'approval' };
const foreign = { ...approval, id: 'approval-b', backendId: 'b' };
const taskIdentity = { backendId: 'a', runId: 'task-run', requestId: 'task-request' };
const live = { generatedAt: 10,
  approvals: [{ backend: 'a', supported: true, items: [approval, { id: 'task-approval', ...taskIdentity }] },
    { backend: 'b', supported: true, items: [foreign] }],
  running: [{ backend: 'a', supported: true, items: [{ id: 'task', runId: 'task-run', status: 'waiting_approval',
    waitingRequestId: 'task-request', kind: 'inspiration' }] }],
};
await settle(() => { renderer = create(React.createElement(Host, { scope: 'a,b' })); });
await settle(() => requests.at(-1).resolve(live));
assert.equal(state.work.approvals[0].items.length, 2, 'A verified pending request stays visible until acknowledged');
await settle(tick);
const latePoll = requests.at(-1);
await settle(() => acknowledgeDashboardPrompt(identity));
assert.equal(state.work.approvals[0].items.length, 1, 'Chat acknowledgment clears its Dashboard approval immediately');
assert.equal(state.work.approvals[1].items.length, 1, 'The same request ID on a different backend stays pending');
await settle(() => latePoll.resolve(live));
assert.equal(state.work.approvals[0].items.length, 1, 'A poll started before the Chat receipt cannot resurrect the approval');
await settle(() => acknowledgeDashboardPrompt(taskIdentity));
assert.equal(state.work.running[0].items[0].status, 'running', 'Answering a task keeps the task and clears only its wait');
assert.equal(state.work.running[0].items[0].waitingRequestId, undefined);
await settle(tick);
await settle(() => requests.at(-1).resolve({ generatedAt: 11, running: [failed], approvals: [failed] }));
assert.equal(state.work.approvals[0].items.length, 0, 'Source failure cannot revive an acknowledged approval');
await settle(tick);
await settle(() => requests.at(-1).resolve({ ...live, approvals: [{ backend: 'a', supported: true,
  items: [{ ...approval, id: 'approval-next', requestId: 'next-request' }] }] }));
assert.equal(state.work.approvals[0].items[0].requestId, 'next-request', 'The next request in the same run remains actionable');
await settle(() => renderer.unmount());
await settle(() => { renderer = create(React.createElement(Host, { scope: 'a,b', seed: live })); });
assert.equal(state.work.approvals[0]?.items.length || 0, 0, 'Revisiting Dashboard never renders cached pending approvals');
await settle(() => requests.at(-1).resolve(live));
assert.equal(state.work.approvals[0].items.length, 0, 'Receipts survive a Dashboard route remount');
assert.equal(state.work.approvals[1].items.length, 1);
await settle(() => renderer.unmount());
assert.equal(timers.size, 0);
assert.equal(listeners.size, 0);
console.log('PASS Dashboard live polling and Chat receipt sync: cache entry, acknowledgment races, exact ownership, source failures and route remount');
