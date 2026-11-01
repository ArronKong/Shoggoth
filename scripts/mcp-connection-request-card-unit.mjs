import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from '../app/manage-ui/node_modules/typescript/lib/typescript.js';
const uiRequire = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const React = uiRequire('react'), Renderer = uiRequire('react-test-renderer');
const clone = value => JSON.parse(JSON.stringify(value));
function moduleFrom(relative, requireModule, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: requireModule, AbortController, ...globals });
  return module.exports;
}
const resources = moduleFrom('../app/manage-ui/src/i18n/mcpConnectorResources.ts', uiRequire).mcpConnectorResources;
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children) : '';
const translate = (key, options = {}) => {
  let result = key.split('.').slice(1).reduce((value, part) => value?.[part], resources['zh-CN']) || key;
  for (const [name, value] of Object.entries(options)) result = result.replaceAll(`{{${name}}}`, String(value));
  return result;
};
const realApi = moduleFrom('../app/manage-ui/src/api/mcpConnectors.ts', name => {
  assert.equal(name, './client'); return { jsonFetch() { throw Error('Unexpected real network request'); } };
}, { URLSearchParams, Event });
const helpers = moduleFrom('../app/manage-ui/src/lib/mcpConnectorUi.ts', uiRequire);
const now = Date.now();
function request(id, patch = {}) {
  return { requestId: id, kind: 'secret', serverId: 'mcp-local', registryName: null, url: null,
    title: `Fixture ${id}`, purpose: 'Read the isolated fixture', status: 'pending',
    requiredFields: [{ name: 'TOKEN', label: 'env:TOKEN', kind: 'env' }],
    createdAt: now - 1000, updatedAt: now - 1000, expiresAt: now + 600000, ...patch };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let servers = [{ id: 'mcp-local', name: 'Fixture server', status: 'ready' }];
  const rows = new Map(), reads = [], submissions = [], storageWrites = [], timers = new Map(), listeners = new Map(); let timerId = 0, completeBehavior = async input => {
    for (const [scope, items] of rows) rows.set(scope, items.map(item => item.requestId === input.requestId ? { ...item, status: 'completed' } : item));
    return { status: 'completed' };
  };
  const storage = { getItem() { return null; }, setItem(...args) { storageWrites.push(args); }, removeItem(...args) { storageWrites.push(args); } };
  const browser = { localStorage: storage, sessionStorage: storage, addEventListener(name, fn) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const api = { MCP_CHANGE_EVENT: 'fixture-mcp-changed', formatMcpError: realApi.formatMcpError,
    async listMcpRequests(input) { reads.push(clone(input)); return { items: clone(rows.get(input.sessionKey) || []) }; },
    async listMcpConnectors() { return { revision: 1, servers: clone(servers) }; },
    async searchMcpRegistry() { throw Error('Not used in single-field lifecycle test'); },
    async completeMcpRequest(input) { submissions.push(clone(input)); return completeBehavior(input); },
  };
  // The visual shell is replaced because react-test-renderer has no DOM portal.
  // The actual request component, state, effects, input/submit/close handlers,
  // credential mapping and error formatter all execute unchanged.
  function Modal({ open, children, onClose }) { return open ? React.createElement('div', { role: 'dialog' }, children, React.createElement('button', { 'data-close': true, onClick: onClose }, 'Close fixture shell')) : null; }
  const mod = moduleFrom('../app/manage-ui/src/components/McpConnectionRequests.tsx', name => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return uiRequire(name);
    if (name === 'react-i18next') return { useTranslation: () => ({ t: translate }) };
    if (name === '../api/mcpConnectors') return api;
    if (name === '../lib/mcpConnectorUi') return helpers;
    if (name === './Modal') return { __esModule: true, default: Modal };
    if (name === '../pages/McpConnectorDialog') return { __esModule: true, default: props => React.createElement('div', { 'data-setup-dialog': true, ...props }) };
    if (name.endsWith('.module.css')) return { __esModule: true, default: {} };
    throw Error('Unexpected component dependency: ' + name);
  }, { document: { visibilityState: 'visible' }, window: browser, localStorage: storage, sessionStorage: storage,
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); } });
  let mounted;
  const props = (sessionKey, extra = {}) => ({ backendId: 'shoggoth', agentId: 'agent-a', sessionKey, visible: true, ...extra });
  // Production ChatPage keys both ordinary and immersive instances by session.
  const host = (mode, sessionKey, extra) => React.createElement('section', { 'data-mode': mode }, React.createElement(mod.default, { key: `${mode}:${sessionKey}`, ...props(sessionKey, extra) }));
  return { rows, reads, submissions, storageWrites, setServers(value) { servers = value; }, setBehavior(value) { completeBehavior = value; },
    get root() { return mounted.root; }, get json() { return mounted.toJSON(); },
    async mount(mode, session, extra = {}) { await Renderer.act(async () => { mounted = Renderer.create(host(mode, session, extra)); }); },
    async change(mode, session, extra = {}) { await Renderer.act(async () => { mounted.update(host(mode, session, extra)); }); },
    async event(fn) { await Renderer.act(async () => { fn(); await Promise.resolve(); await Promise.resolve(); }); },
    async tick() { await Renderer.act(async () => { for (const callback of [...timers.values()]) callback(); }); },
    async close() { if (mounted) await Renderer.act(async () => mounted.unmount()); assert.equal(timers.size, 0); for (const set of listeners.values()) assert.equal(set.size, 0); },
  };
}
function button(f, label) { const found = f.root.findAllByType('button').find(node => text(node.props.children) === label); assert.ok(found, `Missing button ${label}`); return found; }
function input(f) { const fields = f.root.findAllByType('input'); assert.equal(fields.length, 1); return fields[0]; }
// These wiring assertions supplement component execution; they are not a full
// ChatPage render. Both real hosts keep group conversations behind visible=false.
const chatSource = fs.readFileSync(new URL('../app/manage-ui/src/pages/ChatPage.tsx', import.meta.url), 'utf8');
const immersiveSource = fs.readFileSync(new URL('../app/manage-ui/src/pages/immersive/ImmersiveChat.tsx', import.meta.url), 'utf8');
assert.equal((chatSource.match(/<McpConnectionRequests\b/g) || []).length, 2);
assert.equal((chatSource.split('\n').filter(line => line.includes('<McpConnectionRequests') && line.includes('!activeGroupId'))).length, 2);
assert.ok(immersiveSource.includes('{connectionRequests}'));
let scenarios = 0;
for (const mode of ['normal', 'immersive']) {
  const f = fixture(); try {
    f.rows.set('session-a', [request('pending'), request('done', { status: 'completed' }), request('expired', { expiresAt: now - 1 })]);
    await f.mount(mode, 'session-a'); const rendered = text(f.json);
    assert.ok(rendered.includes(resources['zh-CN'].requestDone)); assert.ok(rendered.includes(resources['zh-CN'].requestExpired));
    assert.equal(f.root.findAllByType('button').filter(node => text(node.props.children) === resources['zh-CN'].requestSecret).length, 1);
    await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick());
    const secret = `local-${mode}-secret-canary`;
    await f.event(() => input(f).props.onChange({ target: { value: secret } }));
    assert.equal(input(f).props.type, 'password'); assert.equal(input(f).props.value, secret); assert.equal(f.submissions.length, 0); assert.deepEqual(f.storageWrites, []);
    assert.equal(text(f.json).includes(secret), false, 'credentials cannot become transcript/card text');
    await f.event(() => f.root.findByProps({ 'data-close': true }).props.onClick());
    assert.equal(f.root.findAllByType('input').length, 0);
    await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); assert.equal(input(f).props.value, '', 'close clears local draft');
    await f.event(() => input(f).props.onChange({ target: { value: secret } }));
    f.rows.set('session-b', [request('other-session')]); await f.change(mode, 'session-b');
    assert.equal(f.root.findAllByType('input').length, 0); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); assert.equal(input(f).props.value, '', 'session change clears local draft');
    await f.event(() => input(f).props.onChange({ target: { value: 'hidden-draft' } })); await f.change(mode, 'session-b', { visible: false }); assert.equal(f.root.findAllByType('input').length, 0);
    await f.change(mode, 'session-b'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); assert.equal(input(f).props.value, '', 'hidden surface clears local draft');
    scenarios++;
  } finally { await f.close(); }
}
{
  const f = fixture(); try {
    f.rows.set('retry', [request('same-request')]); await f.mount('normal', 'retry'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick());
    await f.event(() => input(f).props.onChange({ target: { value: 'wrong-fixture-value' } }));
    f.setBehavior(async () => { throw Object.assign(Error('private-backend-canary'), { code: 'MCP_SERVER_PROBE_FAILED' }); });
    await f.event(() => button(f, resources['zh-CN'].finish).props.onClick());
    assert.equal(f.root.findByProps({ role: 'alert' }).children.join(''), resources['zh-CN'].errors.probe); assert.equal(input(f).props.value, 'wrong-fixture-value');
    await f.event(() => input(f).props.onChange({ target: { value: 'correct-fixture-value' } }));
    f.setBehavior(async () => { f.rows.set('retry', [request('same-request', { status: 'completed' })]); return { status: 'completed' }; });
    await f.event(() => button(f, resources['zh-CN'].finish).props.onClick());
    assert.deepEqual(f.submissions, [{ requestId: 'same-request', serverId: 'mcp-local', fields: { env: { TOKEN: 'wrong-fixture-value' } } }, { requestId: 'same-request', serverId: 'mcp-local', fields: { env: { TOKEN: 'correct-fixture-value' } } }]);
    assert.ok(text(f.json).includes(resources['zh-CN'].requestDone)); assert.equal(f.root.findAllByType('input').length, 0); assert.deepEqual(f.storageWrites, []); scenarios++;
  } finally { await f.close(); }
}
{
  const f = fixture(); try {
    f.rows.set('ack', [request('unknown-ack')]); await f.mount('immersive', 'ack'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick());
    await f.event(() => input(f).props.onChange({ target: { value: 'ack-local-canary' } }));
    f.setBehavior(async () => { throw Object.assign(Error('private-transport-canary'), { code: 'MCP_REQUEST_ACK_UNKNOWN' }); });
    await f.event(() => button(f, resources['zh-CN'].finish).props.onClick());
    const alert = text(f.root.findByProps({ role: 'alert' }).props.children); assert.equal(alert, resources['zh-CN'].errors.ackUnknown); assert.ok(alert.includes('不会重发')); assert.equal(text(f.json).includes('private-transport-canary'), false); assert.equal(text(f.json).includes('ack-local-canary'), false); assert.equal(f.submissions.length, 1); scenarios++;
  } finally { await f.close(); }
}
{
  const f = fixture(); try {
    f.rows.set('group-presentation', [request('group-card')]); await f.mount('normal', 'group-presentation', { group: true });
    assert.ok(text(f.json).includes(resources['zh-CN'].privateOnly)); assert.equal(f.root.findAllByType('button').length, 0); assert.equal(f.root.findAllByType('input').length, 0); assert.equal(f.submissions.length, 0); scenarios++;
  } finally { await f.close(); }
}
{
  const f = fixture(); try {
    const pending = deferred(); f.rows.set('old', [request('old-card')]); f.rows.set('new', [request('new-card')]);
    await f.mount('normal', 'old'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); await f.event(() => input(f).props.onChange({ target: { value: 'old-session-only' } }));
    f.setBehavior(() => pending.promise); await f.event(() => button(f, resources['zh-CN'].finish).props.onClick());
    await f.change('normal', 'new'); pending.reject(Object.assign(Error('stale-private-error'), { code: 'MCP_REQUEST_ACK_UNKNOWN' })); await f.event(() => {});
    assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); assert.equal(input(f).props.value, ''); assert.equal(input(f).props.disabled, false); scenarios++;
  } finally { await f.close(); }
}
{
  const f = fixture(); try {
    f.rows.set('group-switch', [request('private-card-must-not-leak')]); await f.mount('normal', 'group-switch'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick());
    await f.event(() => input(f).props.onChange({ target: { value: 'private-draft-must-not-leak' } }));
    const beforeReads=f.reads.length; await f.change('normal','group-switch',{group:true});
    assert.equal(f.root.findAllByType('input').length,0,'entering group must hide an already-open credential form');
    assert.equal(text(f.json).includes('private-card-must-not-leak'),false,'group may not inherit private card metadata');
    await f.tick(); assert.equal(f.reads.length,beforeReads,'group must not poll private cards');
    await f.change('normal','group-switch'); await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick()); assert.equal(input(f).props.value,'');
    scenarios++;
  } finally { await f.close(); }
}
assert.equal(realApi.formatMcpError({code:'MCP_REQUEST_PRIVATE_CHAT_REQUIRED',message:'private-canary'},translate),resources['zh-CN'].privateOnly);
for (const mode of ['normal', 'immersive']) {
  const f = fixture(); try {
    f.setServers([{ id: 'mcp-key', name: 'API connector', status: 'needsSetup' }, { id: 'mcp-login', name: 'OAuth connector', status: 'signedOut' }]);
    f.rows.set('setup-session', [request('setup-batch', { kind: 'setup', serverId: 'mcp-key', serverIds: ['mcp-key', 'mcp-login'], requiredFields: [], continuation: 'waiting' })]);
    await f.mount(mode, 'setup-session');
    assert.equal(f.root.findAllByType('button').length, 2, 'only credential and sign-in actions remain; no add/import confirmation');
    await f.event(() => button(f, resources['zh-CN'].requestSecret).props.onClick());
    const dialog = f.root.findByProps({ 'data-setup-dialog': true });
    assert.equal(dialog.props.credentialsOnly, true); assert.equal(dialog.props.server.id, 'mcp-key');
    await f.event(() => dialog.props.onReady({ id: 'mcp-key', status: 'ready' }));
    assert.deepEqual(f.submissions, [{ requestId: 'setup-batch' }], 'completion carries no credential or alternate server identity');
    assert.equal(f.root.findAllByProps({ 'data-setup-dialog': true }).length, 0);
    f.rows.set('setup-session', [request('uncertain-batch', { kind: 'setup', serverId: 'mcp-key', serverIds: ['mcp-key'], requiredFields: [], continuation: 'unknown' })]);
    await f.tick(); assert.equal(f.root.findAllByType('button').length, 0, 'uncertain continuation has no replay action');
    assert.ok(text(f.json).includes(resources['zh-CN'].errors.ackUnknown)); assert.deepEqual(f.storageWrites, []); scenarios++;
  } finally { await f.close(); }
}
console.log(JSON.stringify({ outcome: 'PASS', scenarios, level: 'real React component events with controlled API; not Service, browser layout, or actual group integration proof', ordinaryAndImmersive: true, localDraftOnly: true, failedRetrySameRequest: true, unknownAckNoReplayGuidance: true }));
