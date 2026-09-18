import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const ui = path.join(root, 'app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
const calls = [], notifications = [], timers = new Map();
const resumed = { runId: 'owner-run', status: 'running' };
let send = async () => resumed, refreshed = 0, focused = 0, clock = 1000, nextTimer = 0;
class TestDate extends Date { static now() { return clock; } }
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const localRequire = name => {
    if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
    if (name.endsWith('/api/client')) return { respondBackendPrompt: async (backend, input) => { calls.push({ backend, ...input }); return send(); } };
    if (name.endsWith('/components/ui')) return { useToast: () => ({ success: key => notifications.push(key), error: key => notifications.push(key) }) };
    if (name.endsWith('/lib/avatar-background')) return { agentAvatarStyle: () => ({}) };
    if (name.endsWith('/usage/charts')) return { fmtMs: String };
    if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(file), name);
    return load(['.ts', '.tsx'].map(ext => base + ext).find(candidate => fs.existsSync(candidate)));
  };
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})(require, module, module.exports);`, {
    require: localRequire, module, Date: TestDate,
    window: { setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) },
  }, { filename: file });
  return module.exports;
}
const Row = load(path.join(ui, 'src/pages/dashboard/ApprovalRow.tsx')).default;
const request = { version: 1, runId: 'owner-run', requestId: 'owner-request', kind: 'runtime_approval',
  title: 'Command', message: 'Read only this workspace', fields: [], approvalChoices: ['once', 'session', 'deny'], expiresAt: null };
const item = { id: 'approval', backendId: 'shoggoth', agentId: 'stable-agent', kind: 'approval',
  source: 'chat',
  runId: request.runId, requestId: request.requestId, commandText: 'git diff -- app/manage-ui',
  allowedDecisions: request.approvalChoices, interactiveRequest: request };
const props = { item, agentName: 'My agent', canRespond: true, onResponded: async () => { refreshed++; } };
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : text(node?.children || []);
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });
let renderer, headerNode;
const mount = async (overrides = {}) => settle(() => {
  renderer = create(React.createElement(Row, { ...props, ...overrides }), { createNodeMock: element => {
    if (element.type === 'button' && element.props['aria-controls']) {
      headerNode = { focus: () => focused++, matches: selector => selector === ':focus-visible' };
      return headerNode;
    }
    return null;
  } });
});
const row = () => renderer.root.findByProps({ 'data-dashboard-approval': true });
const header = () => renderer.root.findAllByType('button').find(button => button.props['aria-controls']);
const button = label => renderer.root.findAllByType('button').find(button => text(button) === label);
const expanded = () => header().props['aria-expanded'];

await mount();
assert.equal(expanded(), false);
assert.equal(renderer.root.findByProps({ id: header().props['aria-controls'] }).props['aria-hidden'], true);
assert.equal(renderer.root.findByProps({ id: header().props['aria-controls'] }).props.inert, '');
await settle(() => row().props.onPointerEnter({ pointerType: 'touch' }));
assert.equal(expanded(), false, 'Touch hover must not accidentally expand');
await settle(() => header().props.onClick());
assert.equal(expanded(), true, 'Touch/click can pin details');
await settle(() => header().props.onClick());
assert.equal(expanded(), false);
await settle(() => row().props.onPointerEnter({ pointerType: 'mouse' }));
assert.equal(expanded(), true, 'Mouse entry expands details without a click');
await settle(() => row().props.onPointerLeave());
assert.equal(expanded(), false);
await settle(() => row().props.onFocus({ target: headerNode }));
assert.equal(expanded(), true, 'Keyboard focus exposes the same controls');
await settle(() => row().props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }));
assert.equal(expanded(), true, 'Moving focus into a response button keeps details open');
await settle(() => row().props.onKeyDown({ key: 'Escape', stopPropagation() {} }));
assert.equal(expanded(), false); assert.equal(focused, 1);
assert.equal(renderer.root.findByType('img').props.src, '/avatar/stable-agent');
assert.match(text(renderer.toJSON()), /git diff -- app\/manage-ui/);
await settle(() => renderer.unmount());

// Native approval scopes keep their original choice and owning backend/run/request.
const options = [
  { choice: 'runtime:4', kind: 'allow_always', scope: 'tool', label: 'Only this tool' },
  { choice: 'runtime:7', kind: 'reject_always', label: 'Never allow' },
  { choice: 'deny', kind: 'reject_once', label: 'Deny' },
];
await mount({ item: { ...item, backendId: 'grok-build', allowedDecisions: ['runtime:4', 'runtime:7', 'deny'],
  interactiveRequest: { ...request, approvalChoices: ['runtime:4', 'runtime:7', 'deny'], approvalOptions: options } } });
assert.equal(renderer.root.findAllByType('button').filter(b => /promptDeny/.test(text(b))).length, 1);
assert.doesNotMatch(text(renderer.toJSON()), /Never allow/);
let release;
send = () => new Promise(resolve => { release = resolve; });
await settle(() => button('chat.promptAllowTool').props.onClick());
await settle(() => button('chat.promptAllowTool').props.onClick());
await settle(() => row().props.onPointerLeave());
assert.equal(calls.length, 1, 'Pending response suppresses double submission');
assert.equal(expanded(), true, 'Response stays visible while submitting');
assert.equal(button('chat.promptAllowTool').props.disabled, true);
assert.deepEqual(calls[0], { backend: 'grok-build', kind: 'approval', runId: 'owner-run', requestId: 'owner-request', choice: 'runtime:4' });
await settle(() => release(resumed));
assert.equal(renderer.toJSON(), null, 'Successful response removes only its own row');
assert.equal(refreshed, 1);
await settle(() => renderer.unmount());

// A failed response keeps the row available for retry.
send = async () => { throw new Error('offline'); };
await mount();
await settle(() => button('chat.promptAllowOnce').props.onClick());
assert.equal(expanded(), true);
assert.equal(button('chat.promptAllowOnce').props.disabled, false);
assert.equal(notifications.at(-1), 'dashboard.approvalRespondFailed');
assert.equal(refreshed, 1);
send = async () => resumed;
await settle(() => button('chat.promptDenyOperation').props.onClick());
assert.equal(calls.at(-1).choice, 'deny');
assert.equal(renderer.toJSON(), null);
await settle(() => renderer.unmount());

// Expired, invalid, foreign and unsupported requests remain inspectable without response actions.
for (const overrides of [
  { canRespond: false }, { item: { ...item, interactionInvalid: true } },
  { item: { ...item, interactiveRequest: { ...request, requestId: 'foreign-request' } } },
  { item: { ...item, expiresAtMs: 500 } },
]) {
  await mount(overrides);
  assert.equal(button('chat.promptAllowOnce'), undefined);
  await settle(() => header().props.onClick());
  assert.match(text(renderer.toJSON()), /git diff -- app\/manage-ui/);
  await settle(() => renderer.unmount());
}
await mount({ item: { ...item, expiresAtMs: 2000 } });
assert.ok(button('chat.promptAllowOnce'));
await settle(() => { clock = 2001; for (const fn of [...timers.values()]) fn(); });
assert.equal(button('chat.promptAllowOnce'), undefined, 'Actions disappear at expiry without waiting for dashboard polling');
assert.equal(timers.size, 0, 'Expired requests must not reschedule a zero-delay timer');
await settle(() => renderer.unmount());

// Waiting-input uses the original field IDs, masks secrets, and retains drafts across hover exit.
const fields = [{ id: 'reason', type: 'text', label: 'Reason', required: true, secret: true, description: '', options: [] }];
await mount({ item: { ...item, kind: 'input', interactiveRequest: { ...request, kind: 'user_input', fields, approvalChoices: [] } } });
assert.equal(button('chat.promptSubmit').props.disabled, true);
assert.equal(renderer.root.findByType('input').props.type, 'password');
await settle(() => renderer.root.findByType('input').props.onChange({ target: { value: 'test-only answer' } }));
await settle(() => row().props.onPointerLeave());
await settle(() => row().props.onPointerEnter({ pointerType: 'mouse' }));
assert.equal(renderer.root.findByType('input').props.value, 'test-only answer');
assert.equal(button('chat.promptSubmit').props.disabled, false);
await settle(() => button('chat.promptSubmit').props.onClick());
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { backend: 'shoggoth', kind: 'input', runId: 'owner-run',
  requestId: 'owner-request', action: 'submit', answers: { reason: 'test-only answer' } });
await settle(() => renderer.unmount());
await mount({ item: { ...item, kind: 'input', interactiveRequest: { ...request, kind: 'product_confirmation', approvalChoices: ['once', 'deny'] } } });
await settle(() => button('chat.promptDenyOperation').props.onClick());
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), { backend: 'shoggoth', kind: 'input', runId: 'owner-run',
  requestId: 'owner-request', action: 'cancel', answers: {} });
await settle(() => renderer.unmount());
assert.equal(timers.size, 0);

// The same header survives black -> orange -> black for every task source.
const statusRow = () => renderer.root.findByProps({ 'data-dashboard-status': true });
const statusHeader = () => renderer.root.findByProps({ 'data-dashboard-status-header': true });
for (const source of ['cron', 'kanban', 'inspiration']) {
  const running = { id: 'shoggoth:owner-run', backendId: 'shoggoth', runId: 'owner-run', agentId: 'stable-agent',
    kind: source, status: 'running', startedAt: 100 };
  const approval = { ...item, source };
  await mount({ item: undefined, running });
  const originalHeader = statusHeader();
  const update = (overrides) => settle(() => renderer.update(React.createElement(Row, { ...props, item: approval, running, ...overrides })));
  assert.equal(statusRow().props['data-tone'], 'running');
  const waiting = { ...running, status: 'waiting_approval', waitingRequestId: request.requestId };
  await update({ running: waiting });
  assert.equal(statusHeader(), originalHeader);
  assert.equal(statusRow().props['data-tone'], 'attention');
  await settle(() => statusRow().props.onPointerEnter({ pointerType: 'mouse' }));
  assert.equal(expanded(), true);
  let resume;
  send = () => new Promise(resolve => { resume = resolve; });
  await settle(() => button('chat.promptAllowOnce').props.onClick());
  assert.equal(statusRow().props['data-tone'], 'attention', 'Do not indicate running before the server accepts the response');
  await settle(() => resume(resumed));
  assert.equal(statusRow().props['data-tone'], 'running', `${source} resumes immediately after acknowledgment`);
  assert.equal(statusRow().props['data-expanded'], false);
  assert.equal(statusHeader(), originalHeader, 'Changing color must not replace the header DOM node');
  await update({ running: { ...waiting }, item: { ...approval } });
  assert.equal(statusRow().props['data-tone'], 'running', 'A stale snapshot cannot resurrect a handled request');
  const nextApproval = { ...approval, id: 'second-approval', requestId: 'second-request',
    interactiveRequest: { ...request, requestId: 'second-request', message: 'A different operation' } };
  await update({ running: { ...waiting, waitingRequestId: nextApproval.requestId }, item: nextApproval });
  assert.equal(statusRow().props['data-tone'], 'attention', 'The next request turns the same task orange again');
  assert.ok(button('chat.promptAllowOnce'));
  assert.equal(statusHeader(), originalHeader);
  send = async () => { throw new Error('offline'); };
  await settle(() => button('chat.promptAllowOnce').props.onClick());
  assert.equal(statusRow().props['data-tone'], 'attention', 'Failed submission keeps attention and retry controls');
  await update({ item: undefined });
  assert.equal(statusRow().props['data-tone'], 'running', 'An approval answered elsewhere follows the actual run status');
  await update({ item: undefined, running: { ...waiting, waitingRequestId: 'third-request' } });
  assert.equal(statusRow().props['data-tone'], 'attention', 'Missing request details must not falsely indicate a waiting task is running');
  assert.equal(statusHeader().props['aria-expanded'], undefined, 'Unavailable details have no misleading expandable controls');
  assert.doesNotMatch(statusHeader().props['aria-label'], /Read only this workspace|A different operation/,
    'Waiting for a newer request must not reuse the previous request description');
  await settle(() => renderer.unmount());
}

// A later request can arrive while an earlier response is still in flight.
const task = { ...item, source: 'inspiration' };
await mount({ item: task });
let finishOld;
send = () => new Promise(resolve => { finishOld = resolve; });
await settle(() => button('chat.promptAllowOnce').props.onClick());
await settle(() => renderer.update(React.createElement(Row, { ...props, item: { ...task, requestId: 'new-request',
  interactiveRequest: { ...request, requestId: 'new-request' } } })));
await settle(() => finishOld(resumed));
assert.equal(statusRow().props['data-tone'], 'attention', 'Old response cannot dismiss a newer request for the same run');
assert.equal(button('chat.promptAllowOnce').props.disabled, false);
await settle(() => renderer.unmount());

const { activityStatusRows } = load(path.join(ui, 'src/pages/dashboard/activityStatusRows.ts'));
// Keeping a task mounted must not keep a submitted secret in the hidden input.
send = async () => resumed;
await mount({ item: { ...item, source: 'inspiration', kind: 'input',
  interactiveRequest: { ...request, kind: 'user_input', fields, approvalChoices: [] } } });
await settle(() => renderer.root.findByType('input').props.onChange({ target: { value: 'private-answer' } }));
await settle(() => button('chat.promptSubmit').props.onClick());
assert.equal(statusRow().props['data-tone'], 'running');
assert.equal(renderer.root.findByType('input').props.value, '', 'Successful response clears the outgoing input draft');
await settle(() => renderer.unmount());
send = async () => ({ runId: 'different-run', status: 'running' });
await mount({ item: task });
await settle(() => button('chat.promptAllowOnce').props.onClick());
assert.equal(statusRow().props['data-tone'], 'attention', 'Unbound response must not claim this task resumed');
await settle(() => renderer.unmount());

const runs = ['cron', 'kanban', 'inspiration', 'chat'].map((kind, i) => ({ id: `task-${i}`, backendId: 'a', runId: `run-${i}`, kind, status: 'running' }));
const initialRows = activityStatusRows(runs, []);
assert.equal(initialRows.length, 3, 'Chat is never rendered as a black task bar');
const mixed = activityStatusRows([...runs].reverse(), [
  { ...item, backendId: 'a', runId: 'run-0' },
  { ...item, backendId: 'b', runId: 'run-0' },
  { ...item, backendId: 'a', runId: undefined, id: 'legacy' },
], initialRows.map(row => row.key));
assert.deepEqual(Array.from(mixed.slice(0, 3), row => row.key), Array.from(initialRows, row => row.key), 'Refresh and attention do not reorder existing task rows');
assert.equal(mixed.length, 5, 'Different backends and unbound legacy approvals cannot be merged accidentally');
assert.equal(mixed[0].approval.runId, 'run-0');
assert.equal(activityStatusRows(runs.map(run => ({ ...run, status: 'completed' })), []).length, 0);
console.log('PASS Dashboard task lifecycle, stable row identity/order, Chat dismissal, hover/keyboard/touch, ownership/scopes, retry, stale/new requests, expiry and input');
