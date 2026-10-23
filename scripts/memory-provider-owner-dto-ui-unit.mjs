import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const draft = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(process.argv[2] || process.cwd());
const ui = path.join(repo, 'app/manage-ui');
const require = createRequire(path.join(ui, 'package.json'));
const React = require('react'), { act, create } = require('react-test-renderer'), ts = require('typescript');
const P = require(path.join(repo, 'app/agent-service/memory-provider-owner-protocol.cjs'));
const modules = new Map(), queue = [], calls = []; let ids = 0, renderer, guard, lastContext, lastStatus;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchFixture = (url, init) => new Promise((resolve, reject) => {
  // The independent sharing form has its own tested protocol. Keep it healthy
  // while these cases exercise the actual Provider owner and memory form.
  if (url === '/__api/native-memory-sharing-config') {
    assert.equal(init?.method || 'GET', 'GET');
    resolve(rawResponse(JSON.stringify({ revision: 0, config: { enabled: true, excludedProfiles: [] } }))); return;
  }
  if (url === '/__api/native-memory-sharing-config/context') {
    resolve(rawResponse(JSON.stringify({ owner: 'shoggoth-memory-core', revision: 0,
      featureReady: true, effectiveEnabled: true, agents: [] }))); return;
  }
  assert.match(url, /^\/__api\/(?:memory-provider-owners(?:\/recover|\?profileId=[A-Za-z0-9._:%-]+)?|native-memory-config(?:\/context)?)$/);
  const call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
  calls.push(call); queue.push({ ...call, resolve, reject });
});
const el = React.createElement;
const fields = {
  Field: ({ label, children, hint }) => el('label', {}, [el('span', { key: 'label' }, label), React.cloneElement(children, { 'aria-label': label, key: 'input' }), hint]),
  TextInput: props => el('input', props), TextArea: props => el('textarea', props), Switch: ({ label, checked, onChange, disabled }) => el('input', { type: 'checkbox', title: label, checked, onChange, disabled }), Select: ({ children, ...props }) => el('select', props, children), Option: props => el('option', props, props.children),
};
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = name => {
    if (name.endsWith('.css')) return {};
    if (name.endsWith('/api/client')) return load(path.join(draft, 'app/manage-ui/src/api/client.ts'));
    if (name.endsWith('/MemoryProviderAccounts')) return load(path.join(draft, 'app/manage-ui/src/pages/settings/MemoryProviderAccounts.tsx'));
    if (name.endsWith('/nativeMemoryForm')) return load(path.join(ui, 'src/lib/nativeMemoryForm.ts'));
    if (name.endsWith('/components/Field')) return fields;
    if (name.endsWith('/navigation-guard')) return { useNavigationGuard: value => { guard = value; } };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
    if (name.endsWith('/lib/cronVisibility')) return { isVisibleCronJob: () => true };
    if (name.endsWith('/lib/runtimeVisibility')) return { isVisibleRuntime: () => true };
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name);
      for (const extension of ['.ts', '.tsx']) if (fs.existsSync(target + extension)) return load(target + extension);
      throw new Error('Unexpected synthetic local dependency');
    }
    return require(name);
  };
  Function('module', 'exports', 'require', 'fetch', 'crypto', 'HTMLInputElement', code)(module, module.exports, localRequire, fetchFixture, { randomUUID: () => `synthetic-operation-${++ids}` }, class {});
  return module.exports;
}
const dto = load(path.join(draft, 'app/manage-ui/src/api/memoryProviderOwnerDto.ts'));
const api = load(path.join(draft, 'app/manage-ui/src/api/client.ts'));
const Component = load(path.join(draft, 'app/manage-ui/src/pages/settings/MemoryProviderAccounts.tsx')).default;
const json = value => JSON.parse(JSON.stringify(value));
const owner = { ownerRef: 'memory-owner-fictional', label: 'Fictional account', scope: { kind: 'global' }, providerId: 'openai', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', revision: 2, status: 'active', hasCredential: true };
const context = (owners = [owner], pendingOperations = []) => ({ catalogRevision: 4, owners: json(owners), pendingOperations: json(pendingOperations) });
const receipt = operationId => ({ operationId, ownerRef: owner.ownerRef, catalogRevision: 5, ownerRevision: 3, status: 'active', cleanupComplete: true, phase: 'completed', current: true });
const mutation = () => ({ operationId: 'synthetic-create', action: 'create', expectedCatalogRevision: 4, scope: { kind: 'global' }, providerId: 'openai', label: 'Fictional new account', baseUrl: 'https://fixture.invalid/v1', secretAction: 'set', secret: 'invented-transient-key' });
const invalid = fn => assert.throws(fn, error => error.code === 'MEMORY_OWNER_INVALID' && !String(error.message).includes('invented'));
function frozen(value) { if (!value || typeof value !== 'object') return; assert.equal(Object.isFrozen(value), true); for (const entry of Object.values(value)) frozen(entry); }
const rawResponse = (raw, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => raw });
async function settle(value, { raw = false, status = 200 } = {}) { const pending = queue.shift(); assert.ok(pending); pending.resolve(rawResponse(raw ? value : JSON.stringify(value), status)); await new Promise(resolve => setImmediate(resolve)); return pending; }
async function httpResult(promise, value, options) { const pending = settle(value, options); const result = await promise; await pending; return result; }
async function httpInvalid(promise, value, options) { const rejection = assert.rejects(promise, error => error.code === 'MEMORY_OWNER_INVALID'); await settle(value, options); await rejection; assert.equal(queue.length, 0); }

test('context matches the exact backend protocol, reconstructs metadata and freezes every public node', () => {
  const input = context(); const result = dto.validateMemoryProviderOwnerContext(input);
  assert.deepEqual(result, P.validateResult(P.METHODS[0], input)); frozen(result); assert.notEqual(result, input); assert.notEqual(result.owners[0], input.owners[0]);
  input.owners[0].label = 'Mutated untrusted input'; assert.equal(result.owners[0].label, owner.label);
});
test('Profile context admits global inheritance and only the selected Profile', () => {
  const own = { ...owner, ownerRef: 'owner-profile', scope: { kind: 'profile', profileId: 'profile-a' } };
  assert.equal(dto.validateMemoryProviderOwnerContext(context([owner, own]), 'profile-a').owners.length, 2);
  invalid(() => dto.validateMemoryProviderOwnerContext(context([own])));
  invalid(() => dto.validateMemoryProviderOwnerContext(context([own]), 'profile-b'));
  invalid(() => dto.validateMemoryProviderOwnerContext(context(), ''));
});
for (const [name, change] of [
  ['empty object', () => ({})], ['root array', () => []], ['missing owners', v => { delete v.owners; return v; }],
  ['unknown root secret', v => ({ ...v, apiKey: 'invented-key' })], ['unknown metadata credentialRef', v => { v.owners[0].credentialRef = 'private-ref'; return v; }],
  ['unknown metadata fingerprint', v => { v.owners[0].credentialFingerprint = 'private-fingerprint'; return v; }],
  ['unknown candidate ref', v => ({ ...v, pendingOperations: [{ operationId: 'op', ownerRef: 'owner', phase: 'reserved', candidateRef: 'private-ref' }] })],
  ['scope extra field', v => { v.owners[0].scope.profileId = 'profile-a'; return v; }],
  ['scope unknown key', v => { v.owners[0].scope.auth = 'private'; return v; }],
  ['malformed unicode', v => { v.owners[0].label = '\ud800'; return v; }],
  ['unsafe revision', v => ({ ...v, catalogRevision: Number.MAX_SAFE_INTEGER + 1 })],
  ['boolean string', v => { v.owners[0].hasCredential = 'true'; return v; }],
  ['nonremote provider', v => { v.owners[0].providerId = 'local'; return v; }],
  ['unknown api', v => { v.owners[0].api = 'invented-api'; return v; }],
  ['credential endpoint', v => { v.owners[0].baseUrl = 'https://user:key@fixture.invalid/v1'; return v; }],
  ['endpoint query', v => { v.owners[0].baseUrl += '?token=private'; return v; }],
  ['endpoint fragment', v => { v.owners[0].baseUrl += '#private'; return v; }],
  ['duplicate owner', v => ({ ...v, owners: [v.owners[0], v.owners[0]] })],
  ['duplicate operation', v => ({ ...v, pendingOperations: Array(2).fill({ operationId: 'op', ownerRef: 'owner', phase: 'reserved' }) })],
]) test(`context rejects ${name} without retaining an untrusted node`, () => invalid(() => dto.validateMemoryProviderOwnerContext(change(context()))));
test('unknown object validation rejects getters without invoking them, foreign prototypes, symbols and hidden properties', () => {
  let reads = 0; const getter = context(); Object.defineProperty(getter, 'owners', { enumerable: true, get() { reads++; return []; } }); invalid(() => dto.validateMemoryProviderOwnerContext(getter));
  const nested = context(); Object.defineProperty(nested.owners[0], 'label', { enumerable: true, get() { reads++; return 'private'; } }); invalid(() => dto.validateMemoryProviderOwnerContext(nested));
  assert.equal(reads, 0);
  for (const value of [Object.assign(Object.create(null), context()), Object.assign(new (class {})(), context()), { ...context(), [Symbol('extra')]: 'private' }]) invalid(() => dto.validateMemoryProviderOwnerContext(value));
  const hidden = context(); Object.defineProperty(hidden, 'fingerprint', { value: 'private' }); invalid(() => dto.validateMemoryProviderOwnerContext(hidden));
});
test('array holes, getters, foreign prototypes and extra enumerable or symbolic members fail closed', () => {
  const variants = [new Array(1), Object.assign([], { extra: true }), Object.assign([], { [Symbol('extra')]: true })];
  const getter = []; let reads = 0; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return owner; } }); variants.push(getter);
  const foreign = []; Object.setPrototypeOf(foreign, null); variants.push(foreign);
  for (const owners of variants) invalid(() => dto.validateMemoryProviderOwnerContext({ ...context(), owners })); assert.equal(reads, 0);
});
test('backend capacities and the UTF8 RPC envelope budget are enforced before publishing context', () => {
  const rows = Array.from({ length: 128 }, (_, i) => ({ ...owner, ownerRef: `owner-${i}` })); assert.equal(dto.validateMemoryProviderOwnerContext(context(rows)).owners.length, 128);
  invalid(() => dto.validateMemoryProviderOwnerContext(context([...rows, { ...owner, ownerRef: 'owner-overflow' }])));
  const pending = Array.from({ length: 1024 }, (_, i) => ({ operationId: `op-${i}`, ownerRef: 'owner', phase: 'reserved' }));
  invalid(() => dto.validateMemoryProviderOwnerContext(context([], [...pending, { operationId: 'overflow', ownerRef: 'owner', phase: 'reserved' }])));
  assert.equal(dto.validateMemoryProviderOwnerContext(context([], pending.slice(0, 900))).pendingOperations.length, 900);
  const oversized = context([{ ...owner, baseUrl: `https://fixture.invalid/${'x'.repeat(4000)}` }, ...rows.slice(0, 30).map(v => ({ ...v, baseUrl: `https://fixture.invalid/${'x'.repeat(4000)}` }))]);
  invalid(() => dto.validateMemoryProviderOwnerContext(oversized)); assert.throws(() => P.validateResult(P.METHODS[0], oversized));
});
test('receipt preserves valid terminal/idempotent semantics, exact correlation and deep freeze', () => {
  for (const value of [receipt('op'), { ...receipt('op'), current: false }, { ...receipt('op'), status: 'revoked' }, { ...receipt('op'), phase: 'cancelled', status: 'cancelled', current: false }]) {
    const result = dto.validateMemoryProviderOwnerReceipt(value, { operationId: 'op', ownerRef: owner.ownerRef }); assert.deepEqual(result, P.validateResult(P.METHODS[1], value)); frozen(result);
  }
  for (const value of [{}, { ...receipt('different') }, { ...receipt('op'), ownerRef: 'wrong-owner' }, { ...receipt('op'), phase: 'cancelled' }, { ...receipt('op'), status: 'cancelled' }, { ...receipt('op'), cleanupComplete: false }, { ...receipt('op'), credentialRef: 'private' }]) invalid(() => dto.validateMemoryProviderOwnerReceipt(value, { operationId: 'op', ownerRef: owner.ownerRef }));
  invalid(() => dto.validateMemoryProviderOwnerReceipt({ ...receipt('op'), ownerRef: 'invented-transient-key' }, { operationId: 'op', secret: 'invented-transient-key' }));
});
test('request reconstruction mirrors backend mutation/recovery and never serializes unknown keys or getters', async () => {
  const input = mutation(); assert.deepEqual(dto.validateMemoryProviderOwnerMutation(input), P.validateParams(P.METHODS[1], input)); frozen(dto.validateMemoryProviderOwnerMutation(input));
  for (const value of [{ ...input, credentialRef: 'private-ref' }, { ...input, headers: { Authorization: 'Bearer invented' } }, { ...input, providerId: 'constructor' }, { ...input, secret: '\ud800' }]) {
    await assert.rejects(api.applyMemoryProviderOwner(value), error => error.code === 'MEMORY_OWNER_INVALID'); assert.throws(() => P.validateParams(P.METHODS[1], value));
  }
  let reads = 0; const value = mutation(); Object.defineProperty(value, 'secret', { enumerable: true, get() { reads++; return 'private'; } }); await assert.rejects(api.applyMemoryProviderOwner(value)); assert.equal(reads, 0);
  await assert.rejects(api.recoverMemoryProviderOwner({ operationId: 'op', mode: 'resume', fingerprint: 'private' })); await assert.rejects(api.getMemoryProviderOwners(''));
  assert.equal(queue.length, 0); assert.equal(calls.length, 0);
});
for (const secret of ['true', 'false', '5', '3']) test(`opaque key ${secret} is not confused with JSON booleans or numeric revisions`, async () => {
  const input = { ...mutation(), secret };
  assert.deepEqual(dto.validateMemoryProviderOwnerReceipt(receipt(input.operationId), input), P.validateResult(P.METHODS[1], receipt(input.operationId)));
  frozen(await httpResult(api.applyMemoryProviderOwner(input), receipt(input.operationId)));
  invalid(() => dto.validateMemoryProviderOwnerReceipt({ ...receipt(input.operationId), ownerRef: `owner-${secret}-echo` }, input));
});
for (const [name, raw] of [['HTTP 200 empty object', '{}'], ['invalid JSON', '{'], ['empty body', ''], ['JSON array', '[]'], ['JSON null', 'null'], ['unknown secret field', JSON.stringify({ ...context(), secret: 'invented-leak' })], ['oversized HTTP JSON', ' '.repeat(65537) + '{}']]) test(`API rejects ${name} through unknown JSON boundary`, async () => httpInvalid(api.getMemoryProviderOwners(), raw, { raw: true }));
test('all three API methods validate responses, bind requests and expose only rebuilt frozen DTOs', async () => {
  const result = await httpResult(api.getMemoryProviderOwners('profile-a'), context([owner, { ...owner, ownerRef: 'profile-owner', scope: { kind: 'profile', profileId: 'profile-a' } }])); frozen(result);
  assert.match(calls.at(-1).url, /profileId=profile-a$/);
  const input = mutation(); const promise = api.applyMemoryProviderOwner(input); input.secret = 'changed-after-admission';
  assert.equal(queue[0].body.secret, 'invented-transient-key'); frozen(await httpResult(promise, receipt('synthetic-create')));
  frozen(await httpResult(api.recoverMemoryProviderOwner({ operationId: 'recover-op', mode: 'resume' }), receipt('recover-op')));
  await httpInvalid(api.applyMemoryProviderOwner(mutation()), {}); await httpInvalid(api.recoverMemoryProviderOwner({ operationId: 'recover-op', mode: 'cancel' }), receipt('wrong-op'));
  await httpInvalid(api.getMemoryProviderOwners('profile-a'), context([{ ...owner, scope: { kind: 'profile', profileId: 'profile-b' } }]));
});
test('frontend public error whitelist matches every backend owner error without propagating its message', async () => {
  for (const [code, error] of Object.entries(P.PUBLIC_MESSAGES)) {
    const promise = api.getMemoryProviderOwners(); const rejection = assert.rejects(promise, value => value.code === code && value.message !== error);
    await settle({ code, error }, { status: 409 }); await rejection;
  }
});
test('HTTP failures retain only whitelisted safe error codes and never raw error/details/refs/fingerprints', async () => {
  for (const [body, code] of [
    [{ code: 'MEMORY_OWNER_CONFLICT', error: 'invented-raw-secret' }, 'MEMORY_OWNER_CONFLICT'],
    [{ code: 'MEMORY_OWNER_CONFLICT', error: 'invented-raw-secret', details: { credentialRef: 'private-ref' } }, 'MEMORY_OWNER_INVALID'],
    [{ code: 'invented-raw-secret', error: 'invented-raw-secret' }, 'MEMORY_OWNER_INVALID'],
  ]) {
    const promise = api.getMemoryProviderOwners(); const rejection = assert.rejects(promise, error => { assert.equal(error.code, code); assert.equal(error.status, 409); assert.equal(Object.isFrozen(error), true); assert.equal('details' in error, false); assert.equal(JSON.stringify(error).includes('invented'), false); assert.equal(String(error.stack).includes('invented'), false); return true; });
    await settle(body, { status: 409 }); await rejection;
  }
  const promise = api.getMemoryProviderOwners(); const rejection = assert.rejects(promise, error => error.code === 'MEMORY_OWNER_UNCERTAIN' && !String(error).includes('invented')); queue.shift().reject(new Error('invented-provider-secret')); await rejection;
});
const props = profileId => ({ profileId, disabled: false, onContext: value => { lastContext = value; }, onStatus: value => { lastStatus = value; } });
const input = label => renderer.root.findByProps({ 'aria-label': label });
const button = label => renderer.root.findAllByType('button').find(value => value.props.children === label);
async function mount(profileId = '') { assert.equal(queue.length, 0); lastContext = null; await act(async () => { renderer = create(el(Component, props(profileId))); }); }
async function renderReply(value, options) { await act(async () => { await settle(value, options); }); }
async function unmount() { await act(async () => renderer.unmount()); renderer = null; assert.equal(queue.length, 0); }
async function edit(label, value) { await act(async () => input(label).props.onChange({ target: { value } })); }
async function click(label) { assert.ok(button(label), label); await act(async () => button(label).props.onClick()); }
async function fill() { await edit('memoryAccounts.label', 'Fictional draft'); await edit('memoryAccounts.endpoint', 'https://fixture.invalid/v1'); await edit('memoryAccounts.apiKey', 'invented-transient-key'); }
for (const [name, value, options] of [['empty context', {}, undefined], ['invalid JSON', '{', { raw: true }], ['root array', [], undefined], ['unknown secret field', { ...context(), credentialRef: 'private-ref' }, undefined], ['wrong Profile', context([{ ...owner, scope: { kind: 'profile', profileId: 'profile-b' } }]), undefined]]) test(`React accounts safely rejects ${name} without publishing or saving provider refs`, async () => {
  const initialCalls = calls.length; await mount('profile-a'); await renderReply(value, options);
  assert.equal(lastContext, null); assert.equal(lastStatus.busy, false); assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  assert.equal(button('memoryAccounts.create'), undefined); assert.ok(button('memoryAccounts.discardReload')); assert.equal(calls.length, initialCalls + 1);
  assert.equal(calls.slice(initialCalls).some(value => value.method !== 'GET'), false); await unmount();
});
test('React rejects an invalid receipt, retains public draft, clears key and prevents further writes/ref selection', async () => {
  await mount(); await renderReply(context([])); await fill(); await click('memoryAccounts.create'); assert.equal(queue[0].method, 'POST');
  await renderReply({}); assert.equal(lastContext, null); assert.equal(input('memoryAccounts.label').props.value, 'Fictional draft'); assert.equal(input('memoryAccounts.apiKey').props.value, '');
  assert.equal(button('memoryAccounts.create').props.disabled, true); assert.equal(guard.dirty, true); assert.equal(lastStatus.busy, false); assert.equal(queue.length, 0);
  await click('memoryAccounts.create'); assert.equal(queue.length, 0); await click('memoryAccounts.discardReload'); await renderReply(context()); assert.equal(lastContext.context.owners[0].ownerRef, owner.ownerRef); await unmount();
});
test('React preserves draft after a verified receipt followed by malformed context and never publishes raw choices', async () => {
  await mount(); await renderReply(context([])); await fill(); await click('memoryAccounts.create'); const op = queue[0].body.operationId;
  await renderReply(receipt(op)); assert.equal(input('memoryAccounts.apiKey').props.value, ''); assert.equal(input('memoryAccounts.label').props.value, 'Fictional draft');
  await renderReply({ ...context(), fingerprint: 'private' }); assert.equal(lastContext, null); assert.equal(input('memoryAccounts.label').props.value, 'Fictional draft'); assert.equal(button('memoryAccounts.create').props.disabled, true); await unmount();
});
test('React valid correlated write and Profile inheritance refresh expose only frozen DTOs after success', async () => {
  await mount('profile-a'); await renderReply(context([])); await fill(); await click('memoryAccounts.create'); const request = queue[0].body; assert.deepEqual(request.scope, { kind: 'profile', profileId: 'profile-a' });
  await renderReply(receipt(request.operationId)); const row = { ...owner, ownerRef: 'profile-owner', scope: { kind: 'profile', profileId: 'profile-a' } }; await renderReply(context([owner, row]));
  frozen(lastContext.context); assert.equal(lastContext.profileId, 'profile-a'); assert.equal(input('memoryAccounts.label').props.value, ''); assert.equal(guard.dirty, false); assert.equal(JSON.stringify(lastContext).includes('invented-transient-key'), false); await unmount();
});
test('React pending recovery accepts cancelled current=false while rejecting uncorrelated or leaking receipts', async () => {
  await mount(); await renderReply(context([], [{ operationId: 'pending-op', ownerRef: owner.ownerRef, phase: 'reserved' }])); await click('memoryAccounts.cancelPending');
  assert.equal(queue[0].body.operationId, 'pending-op'); await renderReply({ ...receipt('pending-op'), phase: 'cancelled', status: 'cancelled', current: false }); await renderReply(context([])); assert.equal(lastContext.context.pendingOperations.length, 0);
  await unmount();
});

const Settings = load(path.join(ui, 'src/pages/settings/SettingsMemory.tsx')).default;
const nativeContext = { owner: 'shoggoth-memory-core', agents: [{ profileId: 'profile-a', agentId: 'agent-a', name: 'Fictional Profile A' }] };
const nativeConfig = { memory: { search: { provider: 'openai', model: 'text-embedding-3-small', fallback: 'none' } }, agents: { entries: { 'profile-a': {} } } };
async function mountSettings() {
  assert.equal(queue.length, 0); await act(async () => { renderer = create(el(Settings)); });
  await act(async () => renderer.root.findByProps({ id: 'settings-memory' }).props.onToggle({ currentTarget: { open: true } }));
  assert.equal(queue[0].url, '/__api/native-memory-config/context'); await renderReply(nativeContext);
  assert.equal(queue[0].url, '/__api/native-memory-config'); await renderReply({ revision: 7, config: json(nativeConfig) });
  assert.equal(queue[0].url, '/__api/memory-provider-owners');
}
const accountSelects = () => renderer.root.findAllByType('select').filter(node => typeof node.props.title === 'string' && node.props.title.startsWith('memoryAccounts.selectAccount'));
async function editSetting(id, value) { await act(async () => renderer.root.findByProps({ id: `memory-setting-${id}` }).props.onChange({ target: { value } })); }
async function submitSettings() { await act(async () => renderer.root.findByProps({ 'aria-label': 'nativeMemory.title' }).props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } })); }
test('actual SettingsMemory and accounts reject malformed catalog without options or automatic providerRef writes', async () => {
  const initialCalls = calls.length; await mountSettings(); await renderReply({}); assert.equal(accountSelects().length, 0);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1);
  await editSetting('memory-search-queryInputType', 'fictional-query'); await submitSettings();
  assert.equal(queue[0].url, '/__api/native-memory-config'); assert.equal(queue[0].method, 'PUT');
  const write = queue[0].body; assert.equal(Object.hasOwn(write.config.memory.search, 'providerRefs'), false);
  await renderReply({ revision: 8, config: write.config }); assert.equal(calls.slice(initialCalls).filter(call => call.method === 'PUT').length, 1); await unmount();
});
test('actual SettingsMemory removes catalog choices after malformed receipt and never writes its owner ref', async () => {
  const initialCalls = calls.length; await mountSettings(); await renderReply(context()); assert.equal(accountSelects().length, 1);
  await editSetting('memory-search-queryInputType', 'fictional-query'); await fill(); await click('memoryAccounts.create'); await renderReply({});
  assert.equal(accountSelects().length, 0); assert.equal(input('memoryAccounts.label').props.value, 'Fictional draft');
  assert.equal(button('memoryAccounts.create').props.disabled, true); assert.equal(calls.slice(initialCalls).some(call => call.method === 'PUT'), false);
  await submitSettings(); const write = queue[0].body; assert.equal(Object.hasOwn(write.config.memory.search, 'providerRefs'), false);
  await renderReply({ revision: 8, config: write.config }); await unmount();
});
test('actual SettingsMemory offers validated scope choices and writes an owner ref only after explicit selection', async () => {
  await mountSettings(); await renderReply(context()); const choices = accountSelects(); assert.equal(choices.length, 1);
  assert.equal(queue.length, 0); await act(async () => choices[0].props.onChange(owner.ownerRef)); await submitSettings();
  const write = queue[0].body; assert.deepEqual(write.config.memory.search.providerRefs, { openai: owner.ownerRef });
  await renderReply({ revision: 8, config: write.config }); await unmount();
});
