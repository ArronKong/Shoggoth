#!/usr/bin/env node
// The OAuth modal's in-app flow ("browser"): the backend signs in, the modal
// shows each step, opens a page only when the runtime did not, and closes on
// success. Failures offer the terminal fallback; closing cancels the session.
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

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fake';
const OPENAI = 'https://auth.openai.com/oauth/authorize?client_id=fake';
const calls = [];
let started = null;
let polls = [];
let nextTimer = 0;
const intervals = new Map();
const timeouts = new Map();
const fakeWindow = {
  open: (url) => calls.push(['open', url]),
  setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearInterval: (id) => intervals.delete(id),
  setTimeout: (fn) => { timeouts.set(++nextTimer, fn); return nextTimer; },
  clearTimeout: (id) => timeouts.delete(id),
};
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
      startOAuthLogin: async (backend, provider) => { calls.push(['start', backend, provider]); return started; },
      pollOAuthSession: async (_backend, _provider, sessionId) => { calls.push(['poll', sessionId]); return polls.shift(); },
      cancelOAuthSession: async (_backend, sessionId) => { calls.push(['cancel', sessionId]); return { ok: true }; },
      submitOAuthCode: async () => ({ ok: false }),
      listOAuthProviders: async () => ({ providers: [], profiles: [] }),
      runProviderCommandInTerminal: async (_backend, provider, kind) => { calls.push(['terminal', provider, kind]); return { ok: true }; },
    };
    if (name.endsWith('/components/ui')) return {
      useConfirm: () => async () => true,
      useToast: () => ({ success: (key) => calls.push(['toast', key]), error: (key) => calls.push(['error', key]), info: () => {} }),
    };
    if (name.endsWith('/components/Modal')) return { __esModule: true, default: ({ children }) => React.createElement('div', null, children) };
    if (name.endsWith('/components/Field')) return { TextInput: (props) => React.createElement('input', props) };
    if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(file), name);
    return load(['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)));
  };
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})(require, module, module.exports);`, {
    require: localRequire, module, window: fakeWindow, navigator: {},
  }, { filename: file });
  return module.exports;
}
const Modal = load(path.join(ui, 'src/pages/keys/OAuthLoginModal.tsx')).default;
const text = (node) => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : text(node?.children || []);
const settle = async (fn) => act(async () => { fn?.(); await new Promise(setImmediate); await new Promise(setImmediate); });
const poll = async () => settle(() => { for (const { fn, ms } of [...intervals.values()]) if (ms === 2000) fn(); });
const provider = { id: 'native-antigravity-default-v1', name: 'Antigravity', flow: 'browser', cliCommand: 'Shoggoth login.js',
  cliRunnable: true, docsUrl: '', disconnectHint: null, disconnectCommand: null, disconnectable: false,
  status: { loggedIn: false, source: null, sourceLabel: null, tokenPreview: null, expiresAt: null, hasRefreshToken: false, error: null },
  connectedProfiles: [] };
const session = (authUrl) => ({ sessionId: 'req-1', flow: 'browser', expiresIn: 900, authUrl, verificationUrl: null, userCode: null, profile: 'default' });
let closed = 0;
const mount = async (value = provider) => {
  let renderer;
  await settle(() => { renderer = create(React.createElement(Modal, { provider: value, backend: 'shoggoth', onClose: () => { closed++; } })); });
  return renderer;
};

// A runtime that opens the browser itself: progress, then its page as a link only.
started = session(null);
polls = [{ status: 'pending', errorMessage: '', authUrl: null, stage: 'installing', browserOpened: true },
  { status: 'pending', errorMessage: '', authUrl: GOOGLE, stage: 'waiting', browserOpened: true },
  { status: 'approved', errorMessage: '', authUrl: GOOGLE, stage: null, browserOpened: true }];
let renderer = await mount();
assert.ok(text(renderer.toJSON()).includes('keys.oauthBrowserStarting'));
await poll();
assert.ok(text(renderer.toJSON()).includes('keys.oauthBrowserInstalling'));
await poll();
assert.ok(text(renderer.toJSON()).includes('keys.oauthBrowserWaiting'));
assert.equal(renderer.root.findAllByType('a').find((link) => link.props.href === GOOGLE)?.props.target, '_blank');
assert.equal(calls.some(([name]) => name === 'open'), false, 'the runtime already opened the browser');
await poll();
assert.ok(text(renderer.toJSON()).includes('keys.oauthApproved'));
assert.ok(calls.some(([name, key]) => name === 'toast' && key === 'keys.oauthConnectedToast'));
await settle(() => { for (const fn of timeouts.values()) fn(); });
assert.equal(closed, 1, 'the modal closes itself after the sign-in succeeds');
renderer.unmount();

// Codex returns its page at start: the app opens it once.
calls.length = 0; intervals.clear(); timeouts.clear();
started = session(OPENAI);
polls = [{ status: 'pending', errorMessage: '', authUrl: null, stage: null, browserOpened: false }];
renderer = await mount();
await poll();
assert.deepEqual(calls.filter(([name]) => name === 'open'), [['open', OPENAI]]);

// Closing while it waits cancels that Service sign-in.
await settle(() => renderer.root.findAllByType('button').find((button) => text(button) === 'common.cancel').props.onClick());
assert.ok(calls.some(([name, id]) => name === 'cancel' && id === 'req-1'));
renderer.unmount();

// A failure explains itself and offers the terminal fallback.
calls.length = 0; intervals.clear(); timeouts.clear();
started = session(null);
polls = [{ status: 'error', errorMessage: '下载 Antigravity 官方服务端失败', authUrl: null, stage: null, browserOpened: true }];
renderer = await mount();
await poll();
assert.ok(text(renderer.toJSON()).includes('下载 Antigravity 官方服务端失败'));
const terminal = renderer.root.findAllByType('button').find((button) => text(button) === 'keys.oauthRunInTerminal');
assert.ok(terminal, 'a failed in-app sign-in can fall back to the terminal');
await settle(() => terminal.props.onClick());
assert.ok(calls.some(([name, id, kind]) => name === 'terminal' && id === provider.id && kind === 'cli'));
renderer.unmount();
console.log('OAuth modal in-app browser flow UI unit: PASS');
