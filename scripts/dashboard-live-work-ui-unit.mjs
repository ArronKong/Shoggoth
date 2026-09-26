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
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/dashboard/useDashboardLiveWork.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { exports: module.exports, document, window: {
  setInterval: (fn, delay) => { assert.equal(delay, 3000); timers.set(++nextTimer, fn); return nextTimer; },
  clearInterval: id => timers.delete(id),
}, require: name => name.endsWith('/api/client') ? {
  getDashboardLiveWork: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
} : require(name) });

let state;
const fallback = { generatedAt: 1, running: [{ backend: 'a', supported: true, items: [{ id: 'active-run' }] }],
  approvals: [{ backend: 'a', supported: true, items: [] }] };
const failed = { backend: 'a', supported: false, reason: 'error', items: [] };
const snapshot = (id) => ({ generatedAt: 2, running: [{ backend: 'a', supported: true, items: id ? [{ id }] : [] }], approvals: fallback.approvals });
function Host({ scope = '', seed = fallback }) { state = module.exports.useDashboardLiveWork(seed, scope); return null; }
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });
const tick = () => { for (const fn of timers.values()) fn(); };
let renderer;
await settle(() => { renderer = create(React.createElement(Host)); });
assert.equal(requests.length, 1, 'Live work refreshes immediately on entry');
await settle(tick);
assert.equal(requests.length, 1, 'Slow polls cannot overlap or accumulate');
await settle(() => requests[0].resolve({ generatedAt: 2, running: [failed], approvals: [failed] }));
assert.equal(state.work.running[0].items[0].id, 'active-run', 'A failed first poll preserves the summary fallback');
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
assert.equal(state.work, undefined, 'Connection scope changes clear the old live snapshot immediately');
assert.notEqual(requests.at(-1), previousRequest, 'A scope change starts a fresh poll without waiting for the previous request');
await settle(() => previousRequest.resolve(snapshot('disabled-a-run')));
assert.equal(state.work, undefined, 'A poll from a disconnected scope cannot repopulate live work');
await settle(() => requests.at(-1).resolve({ generatedAt: 5,
  running: [{ backend: 'b', supported: false, reason: 'error', items: [] }], approvals: [],
}));
assert.equal(state.work.running[0].items[0].id, 'b-run', 'Failure fallback belongs to the new connection scope');
await settle(() => renderer.unmount());
console.log('PASS Dashboard live polling: single-flight, response ordering, source failures, connection scope and cleanup');
