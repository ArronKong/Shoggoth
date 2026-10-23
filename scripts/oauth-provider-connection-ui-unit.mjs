#!/usr/bin/env node
// A native CLI's 断开 in the accounts card is the app switch shared with
// Settings (config.disabledBackends): it never signs out or opens a terminal,
// and reconnecting restores it at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const ui = path.join(root, 'app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const calls = [];
let config = { disabledBackends: ['hermes'] };
let providers = [];
let disconnectFailure = false;
const provider = (enabled, loggedIn = true) => ({
  id: 'native-grok', name: 'Grok', flow: 'external', cliCommand: 'grok login', cliRunnable: true, docsUrl: '',
  disconnectHint: null, disconnectCommand: null, disconnectable: false,
  connection: { id: 'grok-build', enabled },
  status: { loggedIn, source: null, sourceLabel: null, tokenPreview: null, expiresAt: null, hasRefreshToken: false, error: null },
  connectedProfiles: [],
});
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const localRequire = (name) => {
    if (name === 'react-i18next') return { useTranslation: () => ({ t: (key) => key }) };
    if (name.endsWith('/api/client')) return {
      listOAuthProviders: async () => { calls.push(['list']); return { providers, profiles: [] }; },
      getConfig: async () => { calls.push(['getConfig']); return structuredClone(config); },
      updateConfig: async (patch) => { calls.push(['updateConfig', patch]); config = { ...config, ...patch }; return structuredClone(config); },
      disconnectOAuthProvider: async (backend, provider) => {
        calls.push(['signOut', backend, provider]);
        providers = providers.map(p => ({ ...p, status: { ...p.status, loggedIn: false } }));
        if (disconnectFailure) throw new Error('fixture receipt lost after write');
        return { ok: true };
      },
      runProviderCommandInTerminal: async () => { calls.push(['terminal']); },
    };
    if (name.endsWith('/components/ui')) return {
      useConfirm: () => async (options) => { calls.push(['confirm', options.title]); return true; },
      useToast: () => ({ success: (text) => calls.push(['toast', text]), error: (text) => calls.push(['error', text]), info: () => {} }),
    };
    if (name.endsWith('/lib/backends')) return { applyDisabledBackends: (ids) => calls.push(['apply', ids]) };
    if (name.endsWith('/OAuthLoginModal') || name.endsWith('/ProviderLogo')) return { __esModule: true, default: () => null };
    if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(file), name);
    return load(['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)));
  };
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})(require, module, module.exports);`, {
    require: localRequire, module, window: { setTimeout, clearTimeout },
  }, { filename: file });
  return module.exports;
}
const Card = load(path.join(ui, 'src/pages/keys/OAuthProvidersCard.tsx')).default;
const text = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : text(node?.children || []);
// Values built inside the vm context carry its prototypes; compare plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async (fn) => act(async () => { fn?.(); await new Promise(setImmediate); });
let renderer;
const buttons = () => renderer.root.findAllByType('button');

// Connected: 断开 writes the switch only.
providers = [provider(true)];
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth', showActionLabels: true })); });
const off = buttons().find((button) => button.props.title === 'settings.disconnect');
assert.ok(off, 'a connected native CLI offers the app switch');
providers = [provider(false)];
calls.length = 0;
await settle(() => off.props.onClick());
assert.deepEqual(plain(calls.filter(([name]) => ['getConfig', 'updateConfig', 'apply', 'signOut', 'terminal'].includes(name))), [
  ['getConfig'],
  ['updateConfig', { disabledBackends: ['hermes', 'grok-build'] }],
  ['apply', ['hermes', 'grok-build']],
], 'disconnecting only adds the runtime to disabledBackends, read fresh first');
assert.ok(calls.some(([name, title]) => name === 'confirm' && title === 'settings.disconnectConfirmTitle'));

// Disconnected: the row keeps its login and offers only to reconnect.
assert.ok(text(renderer.toJSON()).includes('keys.oauthConnectionOff'));
assert.equal(buttons().some((button) => button.props.title === 'settings.disconnect'), false);
const on = buttons().find((button) => text(button) === 'settings.reconnect');
assert.ok(on, 'a disconnected native CLI offers to reconnect');
providers = [provider(true)];
calls.length = 0;
await settle(() => on.props.onClick());
assert.deepEqual(plain(calls.filter(([name]) => ['updateConfig', 'signOut', 'terminal', 'confirm'].includes(name))),
  [['updateConfig', { disabledBackends: ['hermes'] }]], 'reconnecting needs no confirmation and signs nothing out');
assert.ok(calls.some(([name, key]) => name === 'toast' && key === 'keys.oauthReconnected'));
renderer.unmount();
// An incompatible CLI offers a read-only recheck instead of repeating login.
providers = [{ ...provider(true, false), status: { ...provider(true, false).status,
  verification: 'incompatible', error: 'safe fixed message' } }];
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth-incompatible', showActionLabels: true, refreshKey: 1 })); });
await settle();
assert.ok(text(renderer.toJSON()).includes('settings.runtimeIncompatible'));
const retry = buttons().find(button => button.props.title === 'settings.retry');
assert.ok(retry);
assert.equal(renderer.root.findAll(node => node.props.className === 'oauthDot').length, 0);
calls.length = 0;
await settle(() => retry.props.onClick());
assert.ok(calls.some(([name]) => name === 'list'));
assert.ok(!calls.some(([name]) => ['terminal', 'signOut', 'updateConfig'].includes(name)));
renderer.unmount();
// OpenClaw OAuth signs out through the provider API and refreshes even after a
// lost receipt. Never retry the deletion or keep showing the cached login.
for (const fail of [false, true]) {
  disconnectFailure = fail;
  providers = [{ ...provider(true), id: 'openai', name: 'OpenAI', connection: undefined, disconnectable: true }];
  const backend = `openclaw-oauth-${fail}`;
  await settle(() => { renderer = create(React.createElement(Card, { backend, showActionLabels: true,
    onChanged: () => calls.push(['changed']) })); });
  const signOut = buttons().find(button => button.props.title === 'keys.oauthDisconnect');
  assert.ok(signOut);
  calls.length = 0;
  await settle(() => signOut.props.onClick());
  assert.deepEqual(plain(calls.filter(([name]) => name === 'signOut')), [['signOut', backend, 'openai']]);
  assert.ok(calls.some(([name]) => name === 'list'));
  assert.ok(calls.some(([name]) => name === 'changed'));
  assert.equal(calls.some(([name]) => name === 'error'), fail);
  assert.equal(calls.some(([name]) => name === 'toast'), !fail);
  assert.equal(buttons().some(button => button.props.title === 'keys.oauthDisconnect'), false);
  await settle(() => renderer.unmount());
}
console.log('OAuth provider connection switch UI unit: PASS');
