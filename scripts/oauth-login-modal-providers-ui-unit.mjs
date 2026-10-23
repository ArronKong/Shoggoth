#!/usr/bin/env node
// flow "providers" (OpenCode): pick a model provider, a method and its inputs;
// an API key is saved directly, OAuth continues in the browser flow (with the
// provider's instructions, or a code to paste back).
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

const DEVICE = 'https://github.com/login/device';
const calls = [];
let polls = [];
const intervals = new Map();
const timeouts = new Map();
let nextTimer = 0;
const fakeWindow = {
  open: (url) => calls.push(['open', url]),
  setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearInterval: (id) => intervals.delete(id),
  setTimeout: (fn) => { timeouts.set(++nextTimer, fn); return nextTimer; },
  clearTimeout: (id) => timeouts.delete(id),
};
const options = { providers: [
  { id: 'deepseek', name: 'DeepSeek', connected: false, methods: [{ index: 0, type: 'api', label: 'API Key', prompts: [] }] },
  { id: 'github-copilot', name: 'GitHub Copilot', connected: false, methods: [{ index: 0, type: 'oauth', label: 'Login with GitHub Copilot', prompts: [
    { type: 'select', key: 'deploymentType', message: 'Select GitHub deployment type', placeholder: null, when: null,
      options: [{ label: 'GitHub.com', value: 'github.com', hint: 'Public' }, { label: 'GitHub Enterprise', value: 'enterprise', hint: null }] },
    { type: 'text', key: 'enterpriseUrl', message: 'Enter your GitHub Enterprise URL', placeholder: 'company.ghe.com', options: [],
      when: { key: 'deploymentType', op: 'eq', value: 'enterprise' } },
  ] }] },
  { id: 'poe', name: 'Poe', connected: false, methods: [{ index: 0, type: 'oauth', label: 'Login with Poe', prompts: [] }] },
  { id: 'opencode', name: 'OpenCode Zen', connected: true, methods: [{ index: 0, type: 'api', label: 'API Key', prompts: [] }] },
] };
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
      listOAuthLoginOptions: async (backend, provider) => { calls.push(['options', provider]); return structuredClone(options); },
      startOAuthLogin: async (_backend, provider, _profile, target) => {
        calls.push(['start', provider, target]);
        return { sessionId: 'req-1', flow: 'browser', expiresIn: 900, authUrl: target.providerId === 'poe' ? 'https://poe.com/oauth' : DEVICE,
          verificationUrl: null, userCode: null, profile: 'default' };
      },
      pollOAuthSession: async () => polls.shift(),
      submitOAuthCode: async (_backend, provider, sessionId, code) => { calls.push(['submit', provider, sessionId, code]); return { ok: true, status: 'approved', message: '' }; },
      saveOAuthApiKey: async (_backend, provider, target, key) => { calls.push(['apikey', provider, target, key]); return { ok: true }; },
      cancelOAuthSession: async () => ({ ok: true }),
      listOAuthProviders: async () => ({ providers: [], profiles: [] }),
      runProviderCommandInTerminal: async () => ({ ok: true }),
    };
    if (name.endsWith('/components/ui')) return {
      useConfirm: () => async () => true,
      useToast: () => ({ success: (key) => calls.push(['toast', key]), error: (key) => calls.push(['error', key]), info: () => {} }),
    };
    if (name.endsWith('/components/Modal')) return { __esModule: true, default: ({ children }) => React.createElement('div', null, children) };
    if (name.endsWith('/components/Field')) return {
      Field: ({ label, children }) => React.createElement('label', null, label, children),
      TextInput: (props) => React.createElement('input', props),
      Select: ({ value, onChange, children }) => React.createElement('select', { value, onChange: (e) => onChange(e.target.value) }, children),
      Option: ({ value, children }) => React.createElement('option', { value }, children),
    };
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
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async (fn) => act(async () => { fn?.(); await new Promise(setImmediate); await new Promise(setImmediate); });
const poll = async () => settle(() => { for (const { fn, ms } of [...intervals.values()]) if (ms === 2000) fn(); });
const provider = { id: 'native-opencode-default-v1', name: 'OpenCode', flow: 'providers', cliCommand: 'opencode auth login',
  cliRunnable: true, docsUrl: '', disconnectHint: null, disconnectCommand: null, disconnectable: false,
  status: { loggedIn: false, source: null, sourceLabel: null, tokenPreview: null, expiresAt: null, hasRefreshToken: false, error: null },
  connectedProfiles: [] };
const mount = async () => {
  let renderer;
  await settle(() => { renderer = create(React.createElement(Modal, { provider, backend: 'shoggoth', onClose: () => {} })); });
  return renderer;
};
const button = (renderer, label) => renderer.root.findAllByType('button').find((node) => text(node) === label);
const reset = () => { calls.length = 0; intervals.clear(); timeouts.clear(); };

// An API key provider: search, pick, paste, save.
let renderer = await mount();
assert.deepEqual(renderer.root.findAllByProps({ role: 'listitem' }).map((node) => text(node.children[0])),
  ['OpenCode Zen', 'DeepSeek', 'GitHub Copilot', 'Poe'], 'connected providers come first');
await settle(() => renderer.root.findByProps({ 'aria-label': 'keys.providerSearch' }).props.onChange({ target: { value: 'deep' } }));
assert.deepEqual(renderer.root.findAllByProps({ role: 'listitem' }).map((node) => text(node.children[0])), ['DeepSeek']);
await settle(() => button(renderer, 'DeepSeek').props.onClick());
assert.equal(button(renderer, 'keys.providerSave').props.disabled, true, 'nothing is saved without a key');
await settle(() => renderer.root.findByProps({ type: 'password' }).props.onChange({ target: { value: ' sk-test ' } }));
await settle(() => button(renderer, 'keys.providerSave').props.onClick());
assert.deepEqual(plain(calls.find(([name]) => name === 'apikey')),
  ['apikey', provider.id, { providerId: 'deepseek', method: 0, inputs: {} }, 'sk-test']);
assert.ok(text(renderer.toJSON()).includes('keys.oauthApproved'));
renderer.unmount();

// An OAuth method with conditional inputs, then the provider's instructions.
reset();
renderer = await mount();
await settle(() => button(renderer, 'GitHub Copilot').props.onClick());
assert.equal(renderer.root.findAllByType('select')[0].props.value, 'github.com', 'a select starts on its first option');
assert.equal(renderer.root.findAllByProps({ placeholder: 'company.ghe.com' }).length, 0, 'an input shows only when its condition holds');
await settle(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'enterprise' } }));
await settle(() => renderer.root.findByProps({ placeholder: 'company.ghe.com' }).props.onChange({ target: { value: 'company.ghe.com' } }));
await settle(() => renderer.root.findAllByType('select')[0].props.onChange({ target: { value: 'github.com' } }));
polls = [{ status: 'pending', errorMessage: '', authUrl: null, stage: 'waiting', browserOpened: false,
  instructions: 'Enter code: ABCD-1234', codeRequired: false }, { status: 'approved', errorMessage: '' }];
await settle(() => button(renderer, 'keys.providerContinue').props.onClick());
assert.deepEqual(plain(calls.find(([name]) => name === 'start')),
  ['start', provider.id, { providerId: 'github-copilot', method: 0, inputs: { deploymentType: 'github.com' } }],
  'hidden inputs are not sent');
assert.deepEqual(calls.filter(([name]) => name === 'open'), [['open', DEVICE]], 'the app opens the page OpenCode returned');
await poll();
assert.ok(text(renderer.toJSON()).includes('Enter code: ABCD-1234'), "the provider's instructions are shown");
await poll();
assert.ok(text(renderer.toJSON()).includes('keys.oauthApproved'));
renderer.unmount();

// An OAuth method that hands back a code to paste.
reset();
renderer = await mount();
await settle(() => button(renderer, 'Poe').props.onClick());
polls = [{ status: 'pending', errorMessage: '', authUrl: null, stage: 'waiting', browserOpened: false, instructions: null, codeRequired: true }];
await settle(() => button(renderer, 'keys.providerContinue').props.onClick());
await poll();
assert.ok(text(renderer.toJSON()).includes('keys.oauthCodePrompt'));
await settle(() => renderer.root.findByProps({ placeholder: 'keys.oauthPasteCode' }).props.onChange({ target: { value: 'abc123' } }));
await settle(() => button(renderer, 'keys.oauthSubmitCode').props.onClick());
assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', provider.id, 'req-1', 'abc123']);
assert.ok(text(renderer.toJSON()).includes('keys.oauthApproved'));
renderer.unmount();
console.log('OAuth modal provider sign-in UI unit: PASS');
