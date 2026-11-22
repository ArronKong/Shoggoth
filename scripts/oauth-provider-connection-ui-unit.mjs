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
const quotaReads = [];
const windowEvents = new EventTarget();
const documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' });
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
      getOAuthProviderQuota: (backend, id, signal) =>
        new Promise(resolve => quotaReads.push({ backend, id, signal, resolve })),
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
    if (name.endsWith('/backends')) return {
      applyDisabledBackends: (ids) => calls.push(['apply', ids]),
      readEnabledOAuthQuotaBackends: async () => ['shoggoth'],
    };
    if (name.endsWith('/OAuthLoginModal') || name.endsWith('/ProviderLogo')) return { __esModule: true, default: () => null };
    if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(file), name);
    return load(['.ts', '.tsx'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate)));
  };
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})(require, module, module.exports);`, {
    require: localRequire, module, AbortController, AbortSignal,
    window: { setTimeout, clearTimeout,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents) },
    document: documentEvents,
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
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth' })); });
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
const on = buttons().find((button) => button.props.title === 'settings.reconnect');
assert.ok(on, 'a disconnected native CLI offers to reconnect');
providers = [provider(true)];
calls.length = 0;
await settle(() => on.props.onClick());
assert.deepEqual(plain(calls.filter(([name]) => ['updateConfig', 'signOut', 'terminal', 'confirm'].includes(name))),
  [['updateConfig', { disabledBackends: ['hermes'] }]], 'reconnecting needs no confirmation and signs nothing out');
assert.ok(calls.some(([name, key]) => name === 'toast' && key === 'keys.oauthReconnected'));
renderer.unmount();
// Unverified is a status to recheck; it does not require starting another login.
providers = [{ ...provider(true, false), status: { ...provider(true, false).status, verification: 'unverified' } }];
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth-unverified' })); });
assert.ok(text(renderer.toJSON()).includes('keys.oauthCredentialUnverified'));
const recheck = buttons().find(button => button.props.title === 'settings.retry');
assert.ok(recheck, 'an unverified account offers a read-only recheck');
assert.ok(buttons().some(button => button.props.title === 'keys.oauthLoginExternal'), 'explicit sign-in remains available');
providers = [provider(true)];
calls.length = 0;
await settle(() => recheck.props.onClick());
assert.ok(calls.some(([name]) => name === 'list'));
assert.ok(text(renderer.toJSON()).includes('keys.oauthConnectedBadge'));
assert.ok(!text(renderer.toJSON()).includes('keys.oauthCredentialUnverified'));
assert.ok(!calls.some(([name]) => ['terminal', 'signOut', 'updateConfig'].includes(name)));
await settle(() => renderer.unmount());

// Returning immediately from a successful chat must read the account again,
// including when the previous account snapshot is less than 30 seconds old.
providers = [{ ...provider(true, false), status: { ...provider(true, false).status, verification: 'unverified' } }];
calls.length = 0;
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth' })); });
assert.ok(calls.some(([name]) => name === 'list'), 're-entry always refreshes the cached account status');
assert.ok(text(renderer.toJSON()).includes('keys.oauthCredentialUnverified'));
providers = [provider(true)];
calls.length = 0;
await settle(() => windowEvents.dispatchEvent(new Event('focus')));
assert.equal(calls.filter(([name]) => name === 'list').length, 1);
assert.ok(text(renderer.toJSON()).includes('keys.oauthConnectedBadge'));
documentEvents.visibilityState = 'hidden';
calls.length = 0;
await settle(() => { windowEvents.dispatchEvent(new Event('focus')); documentEvents.dispatchEvent(new Event('visibilitychange')); });
assert.equal(calls.filter(([name]) => name === 'list').length, 0, 'a hidden page does not probe account state');
providers = [provider(true, false)];
documentEvents.visibilityState = 'visible';
await settle(() => { documentEvents.dispatchEvent(new Event('visibilitychange')); windowEvents.dispatchEvent(new Event('focus')); });
assert.equal(calls.filter(([name]) => name === 'list').length, 1, 'visibility and focus share an in-flight recheck');
assert.ok(!text(renderer.toJSON()).includes('keys.oauthConnectedBadge'), 'a confirmed sign-out replaces the old green status');
await settle(() => renderer.unmount());
calls.length = 0;
await settle(() => { windowEvents.dispatchEvent(new Event('focus')); documentEvents.dispatchEvent(new Event('visibilitychange')); });
assert.equal(calls.filter(([name]) => name === 'list').length, 0, 'unmount removes account refresh listeners');
providers = [provider(true)];
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth' })); });
assert.equal(calls.filter(([name]) => name === 'list').length, 1);
assert.ok(text(renderer.toJSON()).includes('keys.oauthConnectedBadge'));
await settle(() => renderer.unmount());
// An incompatible CLI offers a read-only recheck instead of repeating login.
providers = [{ ...provider(true, false), status: { ...provider(true, false).status,
  verification: 'incompatible', error: 'safe fixed message' } }];
await settle(() => { renderer = create(React.createElement(Card, { backend: 'shoggoth-incompatible', refreshKey: 1 })); });
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

const quotaCache = load(path.join(ui, 'src/lib/oauthAccountQuota.ts'));
const { invalidatePageCache } = load(path.join(ui, 'src/lib/usePageCache.ts'));
const account = { ...provider(true), canReadQuota: true };
const firstQuota = { status: 'available', checkedAt: 100, windows: [] };
providers = [account, { ...account, id: 'disabled', connection: { id: 'disabled', enabled: false } }];
const warmup = quotaCache.warmOAuthAccountQuotas();
await new Promise(setImmediate);
assert.equal(quotaReads.length, 1, 'startup reads only verified, enabled accounts');
const warmHover = quotaCache.refreshOAuthQuota('shoggoth', account);
assert.equal(quotaReads.length, 1, 'hover shares the startup request');
quotaReads[0].resolve(firstQuota);
await Promise.all([warmup, warmHover]);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', account), firstQuota);
assert.equal(quotaCache.readCachedOAuthQuota('openclaw', account), undefined);

const refresh = quotaCache.refreshOAuthQuota('shoggoth', account);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', account), firstQuota, 'refresh retains the last reading');
quotaReads[1].resolve({ status: 'unavailable' });
await refresh;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', account), firstQuota);

const oldRead = quotaCache.refreshOAuthQuota('shoggoth', account);
const nextAccount = { ...account, status: { ...account.status, tokenPreview: 'new-account@example.test' } };
const replacement = quotaCache.prefetchMissingOAuthQuotas('shoggoth', [nextAccount]);
assert.ok(quotaReads[2].signal.aborted);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', nextAccount), undefined);
quotaReads[2].resolve(firstQuota);
await oldRead;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', nextAccount), undefined);
const latestQuota = { ...firstQuota, checkedAt: 200 };
quotaReads[3].resolve(latestQuota);
await replacement;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', nextAccount), latestQuota);
invalidatePageCache();
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', nextAccount), undefined);
console.log('OAuth quota startup, stale reads, and account isolation: PASS');

const scope = 'a'.repeat(64);
const cached = { ...firstQuota, quotaScope: scope };
const restoredAccount = { ...account, quotaScope: scope, cachedQuota: cached };
const restoreRefresh = quotaCache.prefetchMissingOAuthQuotas('shoggoth', [restoredAccount]);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', restoredAccount), cached, 'rehydrate before the background request finishes');
const hover = quotaCache.refreshOAuthQuota('shoggoth', restoredAccount);
assert.equal(quotaReads.length, 5, 'hover shares the background refresh of a restored snapshot');
quotaReads[4].resolve({ ...latestQuota, quotaScope: 'b'.repeat(64) });
assert.equal(await hover, true, 'a different account asks for a new login inventory');
await restoreRefresh;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', restoredAccount), undefined);
const otherAccount = { ...restoredAccount, quotaScope: 'b'.repeat(64) };
const fetchLatest = quotaCache.prefetchMissingOAuthQuotas('shoggoth', [otherAccount]);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', otherAccount), undefined, 'an old disk snapshot must not hydrate a new account');
const currentQuota = { ...latestQuota, quotaScope: otherAccount.quotaScope };
quotaReads[5].resolve(currentQuota);
await fetchLatest;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', otherAccount), currentQuota);
console.log('OAuth persisted quota hydration and verified account changes: PASS');

const unknownQuota = { ...provider(true), id: 'unknown-quota' };
assert.equal(quotaCache.canShowOAuthAccountQuota(unknownQuota), true);
assert.equal(quotaCache.canReadOAuthAccountQuota(unknownQuota), false);
await quotaCache.prefetchMissingOAuthQuotas('shoggoth', [unknownQuota]);
assert.equal(quotaReads.length, 6, 'connected rows without an integration do not request quota');

const newQuota = { ...account, id: 'first-quota' };
const attempt = quotaCache.refreshOAuthQuota('shoggoth', newQuota);
quotaReads.at(-1).resolve({ status: 'unavailable' });
await attempt;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', newQuota)?.status, 'unavailable');
const quotaRetry = quotaCache.refreshOAuthQuota('shoggoth', newQuota);
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', newQuota), undefined);
quotaReads.at(-1).resolve({ status: 'unsupported' });
await quotaRetry;
assert.equal(quotaCache.readCachedOAuthQuota('shoggoth', newQuota)?.status, 'unsupported');
console.log('OAuth quota shows first-read failures and distinguishes unsupported accounts: PASS');
