import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from '../app/manage-ui/node_modules/typescript/lib/typescript.js';

const require = createRequire(import.meta.url), uiRequire = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const React = uiRequire('react'), Renderer = uiRequire('react-test-renderer');
const { NativeMcpStore } = require('../app/agent-service/native-mcp-store');
const { McpConnectorController } = require('../app/agent-service/mcp-connector-controller');
const { resolveServicePaths } = require('../app/agent-service/paths');
const { validateConnectorParams, validateConnectorResult } = require('../app/core/connector-dto');
const presets = require('../app/agent-service/data/mcp-featured-presets.json');
const serial = value => JSON.parse(JSON.stringify(value));
function load(relative, customRequire) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: customRequire, AbortController, URL, setInterval, clearInterval });
  return module.exports;
}
const helpers = load('../app/manage-ui/src/lib/mcpConnectorUi.ts', uiRequire);
const catalog = load('../app/manage-ui/src/lib/mcpRecommendationCatalog.ts', uiRequire);
const resources = load('../app/manage-ui/src/i18n/mcpConnectorResources.ts', uiRequire).mcpConnectorResources;

async function fixture(id = 'wind', language = 'en') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-service-groups-')); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, 'state'), cacheRoot: path.join(root, 'cache'), profileRoot: path.join(root, 'profiles') });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  const store = new NativeMcpStore({ paths }).open(), secretValues = new Map(), calls = [], probes = [];
  const secrets = { refFor: id => `mcp-connector:${id}`, get: async ref => secretValues.get(ref.replace('mcp-connector:', '')) || null,
    write: async (id, patch) => secretValues.set(id, { ...secretValues.get(id), ...patch }), remove: async id => secretValues.delete(id) };
  let failUrl, beforeCall, afterCall, dialog, changed = 0, closed = 0;
  const manager = { closeServer: async () => {}, listTools: async id => {
    const record = store.getPrivate(id); probes.push(record.transport.url);
    if (record.transport.url === failUrl) throw Object.assign(Error('fixture'), { code: 'MCP_SERVER_ACCESS_DENIED' });
    return [{ name: 'shared_tool_name', description: new URL(record.transport.url).pathname, inputSchema: { type: 'object' } }];
  } };
  const controller = new McpConnectorController({ store, secrets, manager, paths, registry: {}, packageLauncher: {}, oauth: { close: async () => {} } }).open();
  const call = async (method, input = {}) => {
    const params = validateConnectorParams(method, serial(input)); calls.push({ method, input: serial(input) });
    await beforeCall?.(method, params);
    const result = validateConnectorResult(method, await controller.handle(method, params));
    await afterCall?.(method, params, result);
    return result;
  };
  const api = {
    listMcpSubjects: async () => ({ items: [], unavailableBackends: [] }),
    listMcpConnectors: () => call('connector.mcp.list'),
    addMcpConnector: input => call('connector.mcp.add', input),
    saveMcpCredentials: (id, fields, expectedRevision) => call('connector.mcp.credentials.update', { id, fields, expectedRevision }),
    verifyMcpConnector: id => call('connector.mcp.verify', { id }),
    removeMcpConnector: (id, expectedRevision) => call('connector.mcp.remove', { id, expectedRevision }),
    formatMcpError: error => error.code || 'MCP_CONNECTOR_REQUEST_FAILED',
  };
  const translate = (key, values = {}) => {
    const value = key.replace(/^mcpConnectors\./, '').split('.').reduce((value, part) => value?.[part], resources[language]);
    return typeof value === 'string' ? value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name])) : key;
  };
  const Component = load('../app/manage-ui/src/pages/McpConnectorDialog.tsx', name => {
    if (name === 'react' || name === 'react/jsx-runtime') return uiRequire(name);
    if (name === 'react-i18next') return { useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: language } }) };
    if (name === '../api/mcpConnectors') return api;
    if (name === '../components/Modal') return { __esModule: true, default: ({ children, title }) => React.createElement('section', {}, React.createElement('header', {}, title), children) };
    if (name === '../components/McpConnectorIcon') return { __esModule: true, default: () => null };
    if (name === '../components/ConnectorTools') return { __esModule: true, default: props => React.createElement('div', { 'data-tools-server': props.serverId }) };
    if (name === '../components/ui') return { useConfirm: () => async () => true };
    if (name === '../lib/mcpConnectorUi') return helpers;
    if (name === '../lib/mcpRecommendationCatalog') return catalog;
    if (name === '../../../agent-service/data/mcp-featured-presets.json') return { __esModule: true, default: presets };
    if (name === '../../../core/flightaware-connector-policy.json') return { __esModule: true, default: require('../app/core/flightaware-connector-policy.json') };
    if (name.endsWith('.module.css')) return { __esModule: true, default: {} };
    throw Error('Unexpected dependency ' + name);
  }).default;
  const recommendation = presets.find(value => value.id === id), headers = key => id === 'wind' ? { Authorization: `Bearer ${key}` } : { 'X-API-Key': key };
  const add = (index = 0, key = 'old-key', url = recommendation.endpoints[index].url) => call('connector.mcp.add', {
    source: { kind: 'custom' }, name: 'Existing fixture', option: { kind: 'remote', protocol: 'streamable-http', url }, fields: { headers: headers(key) }, expectedRevision: store.revision,
  });
  const mount = async (props = {}) => Renderer.act(async () => {
    dialog = Renderer.create(React.createElement(Component, { recommendation, onClose: () => { closed++; }, onChanged: () => { changed++; }, ...props }));
  });
  const unmount = async () => { if (dialog) { await Renderer.act(async () => dialog.unmount()); dialog = undefined; } };
  const button = key => dialog.root.findAllByType('button').find(value => value.props.children === translate(`mcpConnectors.${key}`));
  const fill = async (key = 'service-group-key-canary') => Renderer.act(async () => {
    const input = dialog.root.findAllByType('input').find(value => value.props.type === 'password'); assert.ok(input);
    input.props.onChange({ target: { value: id === 'wind' ? `Bearer ${key}` : key } });
  });
  const click = async key => Renderer.act(async () => { const action = button(key); assert.ok(action, key); assert.equal(action.props.disabled, false, key); await action.props.onClick(); });
  const writes = () => calls.filter(value => !['connector.mcp.list', 'connector.mcp.tools.list'].includes(value.method));
  const view = () => JSON.stringify(dialog.toJSON());
  return { store, paths, secretValues, controller, calls, probes, headers, add, mount, unmount, button, fill, click, writes, view, recommendation, api,
    get dialog() { return dialog; }, get changed() { return changed; }, get closed() { return closed; },
    setFailure: value => { failUrl = value; }, before: value => { beforeCall = value; }, after: value => { afterCall = value; },
    close: async () => { await unmount(); await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

for (const language of ['en', 'zh-CN']) for (const id of ['wind', 'variflight']) await test(`${id} (${language}): one key connects every service through the real controller`, async () => {
  const f = await fixture(id, language);
  try {
    await f.mount(); assert.equal(f.writes().length, 0, 'opening only reads'); assert.equal(f.button('group.connectAll').props.disabled, true);
    assert.equal(f.dialog.root.findAllByType('ol').length, f.recommendation.setupSteps?.length ? 1 : 0, 'setup instructions appear once');
    await f.fill(); const connect = f.button('group.connectAll');
    await Renderer.act(async () => { await Promise.all([connect.props.onClick(), connect.props.onClick()]); });
    assert.equal(f.writes().length, f.recommendation.endpoints.length, 'double click never duplicates fan-out');
    const records = f.store.list().servers;
    assert.equal(records.length, f.recommendation.endpoints.length);
    assert.deepEqual(records.map(value => value.transport.url).sort(), f.recommendation.endpoints.map(value => value.url).sort());
    for (const record of records) {
      assert.equal(record.status, 'ready'); assert.deepEqual(f.secretValues.get(record.id).headers, f.headers('service-group-key-canary'));
      assert.equal(f.controller.tools(record.id).items[0].name, 'shared_tool_name', 'same tool name remains scoped to its server');
    }
    assert.equal(f.view().includes('service-group-key-canary'), false, 'submitted input is cleared');
    assert.equal(fs.readFileSync(f.paths.nativeMcpRegistryPath, 'utf8').includes('service-group-key-canary'), false, 'key stays out of public registry');
    assert.equal(f.button('group.connectAll'), undefined, 'complete setup hides the key form');
  } finally { await f.close(); }
});

await test('existing service keeps its ID and exclusions; unrelated credentials and records stay unchanged', async () => {
  const f = await fixture();
  try {
    const existing = (await f.add()).server;
    f.store.update({ id: existing.id, patch: { disabledProfileIds: ['agent-off'] }, expectedRevision: f.store.revision });
    const unrelated = (await f.add(0, 'unrelated-key', 'https://unrelated.example/mcp')).server;
    const before = f.writes().length;
    await f.mount({ server: f.store.get(existing.id) }); assert.equal(f.writes().length, before);
    await f.fill(); await f.click('group.connectAll');
    assert.equal(f.store.list().servers.length, 8); assert.deepEqual(f.store.get(existing.id).disabledProfileIds, ['agent-off']);
    assert.deepEqual(f.secretValues.get(existing.id).headers, f.headers('service-group-key-canary'));
    assert.deepEqual(f.secretValues.get(unrelated.id).headers, f.headers('unrelated-key'));
    assert.equal(f.writes().filter(value => value.method === 'connector.mcp.add').length, 8, 'only six missing services are added');
    await f.click('group.verifyAll'); assert.equal(f.store.list().servers.length, 8);
    assert.equal(f.writes().filter(value => value.method === 'connector.mcp.credentials.update').length, 1, 'checking never resubmits a key');
  } finally { await f.close(); }
});

await test('a readiness failure preserves the other services and can be checked again without re-entering a key', async () => {
  const f = await fixture();
  try {
    f.setFailure(f.recommendation.endpoints[1].url); await f.mount(); await f.fill(); await f.click('group.connectAll');
    assert.equal(f.store.list().servers.filter(value => value.status === 'ready').length, 6);
    assert.ok(f.view().includes('6 / 7 services ready')); assert.ok(f.view().includes('MCP_SERVER_ACCESS_DENIED'));
    f.setFailure(undefined); await f.click('group.verifyAll');
    assert.equal(f.store.list().servers.filter(value => value.status === 'ready').length, 7);
    assert.equal(f.writes().filter(value => value.method === 'connector.mcp.add').length, 7);
    assert.equal(f.writes().filter(value => value.method === 'connector.mcp.credentials.update').length, 0);
  } finally { await f.close(); }
});

await test('an uncertain save stops immediately, reconciles by reading, and never replays automatically', async () => {
  const f = await fixture();
  try {
    let uncertain = true;
    f.after(method => { if (method === 'connector.mcp.add' && uncertain) { uncertain = false; throw { code: 'MCP_CONNECTOR_RESULT_UNKNOWN' }; } });
    await f.mount(); await f.fill(); await f.click('group.connectAll');
    assert.equal(f.store.list().servers.length, 1); assert.equal(f.writes().length, 1); assert.ok(f.view().includes('MCP_CONNECTOR_RESULT_UNKNOWN'));
    assert.equal(f.view().includes('service-group-key-canary'), false);
    await f.unmount(); await f.mount(); assert.equal(f.writes().length, 1, 'reopening does not replay the unknown mutation');
    await f.fill('explicit-replacement'); await f.click('group.connectAll');
    assert.equal(f.store.list().servers.length, 7); assert.equal(f.writes().filter(value => value.method === 'connector.mcp.add').length, 7);
  } finally { await f.close(); }
});

await test('revision conflict stops remaining writes and keeps completed services', async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    f.before(method => { if (method === 'connector.mcp.add' && ++attempts === 2) throw { code: 'MCP_REGISTRY_REVISION_CONFLICT' }; });
    await f.mount(); await f.fill(); await f.click('group.connectAll');
    assert.equal(attempts, 2); assert.equal(f.store.list().servers.length, 1); assert.ok(f.view().includes('MCP_REGISTRY_REVISION_CONFLICT'));
    assert.equal(f.view().includes('service-group-key-canary'), false);
  } finally { await f.close(); }
});

await test('disabled services keep their credentials, ID and disabled state during bulk setup', async () => {
  const f = await fixture();
  try {
    const existing = (await f.add()).server;
    f.store.update({ id: existing.id, patch: { enabled: false, status: 'disabled' }, expectedRevision: f.store.revision });
    await f.mount({ server: f.store.get(existing.id) }); await f.fill(); await f.click('group.connectAll');
    assert.equal(f.store.get(existing.id).enabled, false); assert.equal(f.store.get(existing.id).status, 'disabled');
    assert.deepEqual(f.secretValues.get(existing.id).headers, f.headers('old-key'));
    assert.equal(f.store.list().servers.length, 7); assert.ok(f.view().includes('Disabled services stay disabled'));
    assert.equal(f.writes().some(value => value.method === 'connector.mcp.rebind'), false);
  } finally { await f.close(); }
});

await test('multiple accounts for one service block bulk credential replacement', async () => {
  const f = await fixture();
  try {
    const first = (await f.add()).server, second = (await f.add(0, 'another-account-key')).server;
    await f.mount(); await f.fill(); assert.equal(f.button('group.connectAll').props.disabled, true);
    const count = f.writes().length; await Renderer.act(async () => f.button('group.connectAll').props.onClick());
    assert.equal(f.writes().length, count); assert.deepEqual(f.secretValues.get(first.id).headers, f.headers('old-key'));
    assert.deepEqual(f.secretValues.get(second.id).headers, f.headers('another-account-key')); assert.ok(f.view().includes('different accounts'));
    assert.equal(f.dialog.root.findAllByType('button').filter(value => value.props.children === resources.en.group.manageService).length, 2);
  } finally { await f.close(); }
});

await test('closing during an in-flight save prevents all subsequent service writes', async () => {
  const f = await fixture();
  try {
    let release, entered;
    const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    f.after(async method => { if (method === 'connector.mcp.add') { entered(); await held; } });
    await f.mount(); await f.fill(); let action;
    await Renderer.act(async () => { action = f.button('group.connectAll').props.onClick(); await started; });
    await f.unmount(); release(); await action;
    assert.equal(f.store.list().servers.length, 1); assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

await test('pending Add never saves a key or connects; explicit group removal leaves unrelated records', async () => {
  const f = await fixture('variflight');
  try {
    let staged = 0;
    await f.mount({ catalogEntry: true, autoAdd: true, onStage: () => { staged++; } });
    assert.equal(staged, 1); assert.equal(f.writes().length, 0);
    await f.fill(); await f.click('group.connectAll');
    const unrelated = (await f.add(0, 'unrelated-key', 'https://unrelated.example/mcp')).server;
    await f.click('group.remove');
    assert.deepEqual(f.store.list().servers.map(value => value.id), [unrelated.id]); assert.equal(f.closed, 1);
    assert.equal(f.secretValues.size, 1);
  } finally { await f.close(); }
});
