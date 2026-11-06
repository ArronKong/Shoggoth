import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { bundledBridgeVersions, loadConnectorDetails } from './fixtures/connector-details-ui.mjs';

const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const React = require('react'), Renderer = require('react-test-renderer'), ts = require('typescript');
const presets = JSON.parse(fs.readFileSync(new URL('../app/agent-service/data/mcp-featured-presets.json', import.meta.url)));
const registryName = 'io.github.variflight/variflight-mcp';
const clone = value => JSON.parse(JSON.stringify(value));
function load(relative, imports = {}, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, URL, URLSearchParams, AbortController, Event,
    setTimeout, clearTimeout, setInterval, clearInterval, require: name => name in imports ? imports[name] : require(name), ...globals });
  return module.exports;
}
const helpers = load('../app/manage-ui/src/lib/mcpConnectorUi.ts');
const catalog = load('../app/manage-ui/src/lib/mcpRecommendationCatalog.ts');
const resources = load('../app/manage-ui/src/i18n/mcpConnectorResources.ts').mcpConnectorResources;
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.children ? text(node.children) : '';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const server = (id, url, patch = {}) => ({ id, name: id, enabled: true, createdAt: 1, updatedAt: 1,
  source: { kind: 'custom' }, transport: { kind: 'remote', protocol: 'streamable-http', url }, auth: { kind: 'headers' },
  setup: { requiredFields: [], configuredFields: ['header:X-API-Key'] }, status: 'ready',
  lastCheck: { at: 1, toolCount: 1, errorCode: null }, disabledProfileIds: [], ...patch });

async function fixture({ language = 'zh-CN', target = { registryName }, initialServers = [], kind = 'connection', failUrl } = {}) {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const browser = Object.assign(new EventTarget(), { localStorage: storage, sessionStorage: storage, setTimeout, clearTimeout, open() { assert.fail('No external authorization is expected'); } });
  const globals = { window: browser, localStorage: storage, sessionStorage: storage, document: { visibilityState: 'visible' } };
  const t = (key, options = {}) => {
    const value = key.replace(/^mcpConnectors\./, '').split('.').reduce((value, part) => value?.[part], resources[language]);
    return typeof value === 'string' ? value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name])) : key;
  };
  const request = { requestId: 'mcp-request-entry-test', kind, serverId: kind === 'setup' ? initialServers[0].id : null,
    serverIds: kind === 'setup' ? initialServers.map(item => item.id) : undefined,
    registryName: target.registryName || null, url: target.url || null, title: target.registryName || target.url || 'Setup', purpose: 'Synthetic entry consistency test',
    status: 'pending', requiredFields: [], expiresAt: Date.now() + 600000, createdAt: 1, updatedAt: 1 };
  let records = clone(initialServers), revision = 1, mounted;
  const writes = [], completions = [], searches = [];
  const result = record => ({ revision: ++revision, server: clone(record) });
  const api = {
    MCP_CHANGE_EVENT: 'entry-connectors-changed', formatMcpError: error => error.code || 'fixture-error',
    listMcpRequests: async () => ({ items: [clone(request)] }),
    listMcpConnectors: async () => ({ revision, servers: clone(records) }),
    searchMcpRegistry: async query => { searches.push(query); return { items: [{ registryName: query, name: 'Legacy Registry package', version: '1.1.0', description: 'Legacy description', options: [
      { id: 'package:0', transport: { kind: 'stdio-command', command: 'node', args: ['legacy-flight'] }, fields: [{ name: 'VARIFLIGHT_API_KEY', location: 'env', required: true, secret: true }] },
    ] }] }; },
    addMcpConnector: async input => { writes.push({ action: 'add', input: clone(input) }); const record = server('added-' + records.length, input.option.url, { name: input.name, status: input.option.url === failUrl ? 'failed' : 'ready' }); records.push(record); return result(record); },
    saveMcpCredentials: async (id, fields, expectedRevision) => { writes.push({ action: 'credentials', id, fields: clone(fields), expectedRevision }); const record = records.find(item => item.id === id); record.status = record.transport.url === failUrl ? 'failed' : 'ready'; return result(record); },
    verifyMcpConnector: async id => { writes.push({ action: 'verify', id }); return result(records.find(item => item.id === id)); },
    completeMcpRequest: async input => { completions.push(clone(input)); request.status = 'completed'; return clone(request); },
    getMcpOAuthInfo: async () => ({ redirectUri: 'http://127.0.0.1:45829/callback' }),
  };
  const sticky = load('../app/manage-ui/src/lib/useStickyState.ts', {}, globals);
  const pending = load('../app/manage-ui/src/lib/usePendingConnectors.ts', {}, globals);
  function Modal({ open, title, subtitle, children, footer, onClose }) {
    return open ? React.createElement('section', { role: 'dialog' }, React.createElement('h2', null, title), React.createElement('p', null, subtitle),
      children, React.createElement('footer', null, footer), React.createElement('button', { 'data-close': true, onClick: onClose }, 'Close')) : null;
  }
  const common = {
    'react-i18next': { useTranslation: () => ({ t, i18n: { resolvedLanguage: language } }) },
    '../api/mcpConnectors': api, '../lib/mcpConnectorUi': helpers, '../lib/mcpRecommendationCatalog': catalog,
    '../components/Modal': { __esModule: true, default: Modal }, './Modal': { __esModule: true, default: Modal },
    '../components/ConnectorDetails': loadConnectorDetails(t), '../components/ui': { useConfirm: () => async () => false },
    '../components/McpConnectorIcon': { __esModule: true, default: ({ iconId, identity }) => React.createElement('i', { 'data-icon': iconId || identity }) },
    './McpConnectorIcon': { __esModule: true, default: ({ iconId, identity }) => React.createElement('i', { 'data-icon': iconId || identity }) },
    '../components/ConnectorTools': { __esModule: true, default: props => React.createElement('div', { 'data-preview': props.previewId }, props.description) },
    '../../../agent-service/data/mcp-featured-presets.json': { __esModule: true, default: presets },
    '../../../agent-service/data/mcp-bundled-bridge-versions.json': bundledBridgeVersions,
    '../../../core/flightaware-connector-policy.json': { __esModule: true, default: JSON.parse(fs.readFileSync(new URL('../app/core/flightaware-connector-policy.json', import.meta.url))) },
    './ConnectorsPage.module.css': { __esModule: true, default: {} }, '../pages/ConnectorsPage.module.css': { __esModule: true, default: {} },
  };
  const Dialog = load('../app/manage-ui/src/pages/McpConnectorDialog.tsx', common, globals).default;
  const Requests = load('../app/manage-ui/src/components/McpConnectionRequests.tsx', { ...common,
    '../lib/useStickyState': sticky, '../lib/usePendingConnectors': pending,
    '../pages/McpConnectorDialog': { __esModule: true, default: Dialog },
  }, globals).default;
  const act = async callback => Renderer.act(async () => { await callback(); await flush(); });
  await act(() => { mounted = Renderer.create(React.createElement(Requests, { backendId: 'shoggoth', agentId: 'fixture-agent', sessionKey: 'fixture-session' })); });
  return { t, api, writes, completions, searches, values, Dialog, act,
    get root() { return mounted.root; }, get records() { return records; },
    dialog: () => mounted.root.findByProps({ role: 'dialog' }),
    async open() { await act(() => mounted.root.findAllByType('button').find(button => button.props.children === t(kind === 'setup' ? 'mcpConnectors.requestSecret' : 'mcpConnectors.add')).props.onClick()); },
    async close() { await act(() => mounted.unmount()); },
  };
}
function snapshot(dialog) {
  return { title: text(dialog.findByType('h2')), text: text(dialog),
    previews: dialog.findAll(node => !!node.props['data-preview']).map(node => node.props['data-preview']),
    inputs: dialog.findAllByType('input').map(node => ({ type: node.props.type, value: node.props.value, required: !!node.props.required })),
    footer: dialog.findByType('footer').findAllByType('button').map(text) };
}
async function catalogSnapshot(f, props) {
  let mounted;
  try { await f.act(() => { mounted = Renderer.create(React.createElement(f.Dialog, { ...props, onClose() {}, onChanged() {} })); }); return snapshot(mounted.root.findByProps({ role: 'dialog' })); }
  finally { if (mounted) await f.act(() => mounted.unmount()); }
}

for (const language of ['zh-CN', 'en']) {
  const recommendation = presets.find(item => item.id === 'variflight');
  const f = await fixture({ language });
  try {
    await f.open();
    assert.deepEqual(snapshot(f.dialog()), await catalogSnapshot(f, { recommendation, catalogEntry: true, pending: true }),
      'chat Add must open the same current catalog details, fields, service group, guide, version and footer');
    assert.equal(f.searches.length, 0, 'a curated application does not fall back to its legacy Registry package');
    assert.equal(f.writes.length, 0, 'opening or staging never submits credentials or connects');
    const input = f.dialog().findByType('input');
    await f.act(() => input.props.onChange({ target: { value: 'entry-private-key-canary' } }));
    await f.act(() => f.dialog().findAllByType('button').find(button => button.props.children === f.t('mcpConnectors.group.connectAll')).props.onClick());
    assert.equal(f.records.length, 2, 'the canonical VariFlight setup connects both services');
    assert.deepEqual(f.completions, [{ requestId: 'mcp-request-entry-test', serverId: 'added-0' }], 'completion binds the primary application target exactly once');
    assert.ok(f.writes.every(write => write.input?.fields?.headers?.['X-API-Key'] === 'entry-private-key-canary'));
    assert.equal(JSON.stringify([...f.values]).includes('entry-private-key-canary'), false, 'credentials never enter local storage');
    console.log(`PASS ${language}: identical VariFlight details through real chat and catalog components; dual-service setup and completion`);
  } finally { await f.close(); }
}
{
  const recommendation = presets.find(item => item.id === 'wind'), url = recommendation.endpoints[1].url;
  const f = await fixture({ target: { url } });
  try {
    await f.open(); assert.deepEqual(snapshot(f.dialog()), await catalogSnapshot(f, { recommendation, catalogEntry: true, pending: true, initialUrl: url }));
    await f.act(() => f.dialog().findByType('input').props.onChange({ target: { value: 'entry-wind-key-canary' } }));
    await f.act(() => f.dialog().findAllByType('button').find(button => button.props.children === f.t('mcpConnectors.group.connectAll')).props.onClick());
    assert.equal(f.records.length, 7); assert.equal(f.completions[0].serverId, 'added-1', 'a request for another group endpoint keeps that exact target');
    console.log('PASS URL request: shared Wind group and exact requested endpoint completion');
  } finally { await f.close(); }
}
{
  const recommendation = presets.find(item => item.id === 'variflight');
  const initialServers = recommendation.endpoints.map((endpoint, index) => server('existing-' + index, endpoint.url));
  const f = await fixture({ initialServers });
  try {
    await f.open(); assert.deepEqual(snapshot(f.dialog()), await catalogSnapshot(f, { recommendation, server: initialServers[0] }));
    assert.deepEqual(f.completions, [], 'opening an existing ready application remains read-only');
    await f.act(() => f.dialog().findByType('footer').findAllByType('button').find(button => button.props.children === f.t('mcpConnectors.flow.done')).props.onClick());
    assert.equal(f.completions[0].serverId, 'existing-0'); assert.equal(f.writes.length, 0);
    console.log('PASS existing application: shared Done action completes the request without reinstalling');
  } finally { await f.close(); }
}
{
  const recommendation = presets.find(item => item.id === 'variflight');
  const f = await fixture({ failUrl: recommendation.endpoints[1].url });
  try {
    await f.open(); await f.act(() => f.dialog().findByType('input').props.onChange({ target: { value: 'partial-key-canary' } }));
    await f.act(() => f.dialog().findAllByType('button').find(button => button.props.children === f.t('mcpConnectors.group.connectAll')).props.onClick());
    assert.equal(f.records.length, 2); assert.equal(f.completions.length, 0, 'a partial group never completes the chat request');
    assert.equal(f.dialog().findByType('input').props.value, '', 'partial failure clears the submitted key');
    console.log('PASS partial readiness: request stays pending and submitted secret is cleared');
  } finally { await f.close(); }
}
{
  const recommendation = presets.find(item => item.id === 'canva');
  const current = server('existing-canva', recommendation.url, { auth: { kind: 'oauth-dcr' } });
  const f = await fixture({ target: { url: recommendation.url }, initialServers: [current] });
  try {
    await f.open(); assert.deepEqual(snapshot(f.dialog()), await catalogSnapshot(f, { recommendation, server: current }), 'single-service ready details and Done action are identical');
    await f.act(() => f.dialog().findByType('footer').findAllByType('button').find(button => button.props.children === f.t('mcpConnectors.flow.done')).props.onClick());
    assert.equal(f.completions[0].serverId, current.id); assert.equal(f.writes.length, 0);
    console.log('PASS single-service ready application: identical full details and Done action');
  } finally { await f.close(); }
}
{
  const recommendation = presets.find(item => item.id === 'day-one');
  const current = server('existing-day-one', undefined, { transport: recommendation.transport, auth: { kind: 'none' }, status: 'needsSetup', lastCheck: null, setup: { requiredFields: [], configuredFields: [] } });
  const f = await fixture({ target: {}, initialServers: [current], kind: 'setup' });
  try {
    await f.open(); assert.deepEqual(snapshot(f.dialog()), await catalogSnapshot(f, { recommendation, server: current }), 'setup cards use the full shared dialog rather than a credentials-only variant');
    assert.deepEqual(f.writes, []); assert.deepEqual(f.completions, []);
    console.log('PASS setup request: same local-app details, guide, advanced settings and footer');
  } finally { await f.close(); }
}
