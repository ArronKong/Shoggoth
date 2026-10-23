import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ui = path.resolve(import.meta.dirname, '../app/manage-ui'), require = createRequire(path.join(ui, 'package.json'));
const React = require('react'), { act, create } = require('react-test-renderer'), ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const queue = []; let renderer, guard, lastStatus, lastContext, ids = 0;
const defer = (kind, args) => new Promise((resolve, reject) => queue.push({ kind, args: structuredClone(args), resolve, reject }));
const api = { getMemoryProviderOwners: profileId => defer('context', { profileId }),
  applyMemoryProviderOwner: input => defer('apply', input), recoverMemoryProviderOwner: input => defer('recover', input) };
const el = React.createElement;
const fields = {
  Field: ({ label, children, hint }) => el('label', {}, [el('span', { key: 'label' }, label), React.cloneElement(children, { 'aria-label': label, key: 'input' }), hint]),
  TextInput: props => el('input', props),
  Select: ({ children, ...props }) => el('select', props, children), Option: props => el('option', props, props.children),
};
const module = { exports: {} }, code = ts.transpileModule(fs.readFileSync(path.join(ui, 'src/pages/settings/MemoryProviderAccounts.tsx'), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, Object, Set, URL, TextEncoder,
  crypto: { randomUUID: () => `synthetic-operation-${++ids}` }, HTMLInputElement: class {},
  require: name => {
    if (name.endsWith('/api/client')) return api;
    if (name.endsWith('/components/Field')) return fields;
    if (name.endsWith('/navigation-guard')) return { useNavigationGuard: value => { guard = value; } };
    if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) };
    return require(name);
  },
});
const Component = module.exports.default;
const captureContext = value => { lastContext = value; }, captureStatus = value => { lastStatus = value; };
const metadata = { ownerRef: 'memory-owner-synthetic', label: 'Fictional account', providerId: 'openai', api: 'openai-completions',
  scope: { kind: 'global' }, baseUrl: 'https://fixture.invalid/v1', revision: 2, status: 'active', hasCredential: true };
const snapshot = owners => ({ catalogRevision: 4, owners, pendingOperations: [] });
const props = profileId => ({ profileId, disabled: false, onContext: captureContext, onStatus: captureStatus });
const json = value => JSON.parse(JSON.stringify(value));
const input = label => renderer.root.findByProps({ 'aria-label': label });
const button = label => renderer.root.findAllByType('button').find(value => value.props.children === label);
const edit = async (label, value) => { await act(async () => input(label).props.onChange({ target: { value } })); };
const choose = async (label, value) => { await act(async () => input(label).props.onChange(value)); };
const click = async label => { const value = button(label); assert.ok(value, label); await act(async () => value.props.onClick()); };
async function settle(kind, value, reject = false) {
  assert.equal(queue[0]?.kind, kind); const pending = queue.shift(); await act(async () => (reject ? pending.reject : pending.resolve)(value)); return pending;
}
async function mount(owners = [], profileId = '') {
  assert.equal(queue.length, 0); lastContext = null;
  await act(async () => { renderer = create(el(Component, props(profileId))); });
  assert.equal(queue[0].args.profileId, profileId || undefined);
  await settle('context', snapshot(owners)); assert.equal(lastStatus.busy, false);
}
async function unmount() { await act(async () => renderer.unmount()); renderer = null; assert.equal(queue.length, 0); }
async function fill() { await edit('memoryAccounts.label', 'Fictional new account'); await edit('memoryAccounts.endpoint', 'https://fixture.invalid/v1'); await edit('memoryAccounts.apiKey', 'invented-ui-key'); }
const receipt = { operationId: 'synthetic-operation', ownerRef: metadata.ownerRef, catalogRevision: 5, ownerRevision: 3,
  status: 'active', phase: 'completed', cleanupComplete: true, current: true };

test('account registration uses separate credential mutation and exposes only safe catalog choices after acknowledgement', async () => {
  await mount(); await fill(); assert.equal(guard.dirty, true); assert.equal(button('memoryAccounts.create').props.disabled, false);
  await click('memoryAccounts.create'); assert.equal(guard.busy, true);
  const request = queue[0].args; assert.equal(request.action, 'create'); assert.deepEqual(request.scope, { kind: 'global' });
  assert.equal(request.secret, 'invented-ui-key'); assert.equal(request.expectedCatalogRevision, 4);
  assert.equal(Object.hasOwn(request, 'credentialRef'), false); assert.equal(Object.hasOwn(request, 'config'), false);
  await settle('apply', receipt); assert.equal(input('memoryAccounts.apiKey').props.value, '');
  await settle('context', snapshot([metadata])); assert.equal(guard.dirty, false);
  assert.deepEqual(json(lastContext.context.owners), [metadata]); assert.equal(JSON.stringify(lastContext).includes('invented-ui-key'), false); await unmount();
});
test('Profile account admission remains exactly bound to the selected Profile', async () => {
  await mount([], 'profile-a'); await fill(); await click('memoryAccounts.create');
  assert.deepEqual(queue[0].args.scope, { kind: 'profile', profileId: 'profile-a' });
  await settle('apply', receipt); await settle('context', snapshot([])); await unmount();
});
test('preserve cannot change destination, while explicit key replacement can', async () => {
  await mount([metadata]); await click('common.edit');
  assert.equal(input('memoryAccounts.provider').props.disabled, true); assert.equal(input('memoryAccounts.credential').props.value, 'preserve');
  assert.equal(renderer.root.findAllByProps({ 'aria-label': 'memoryAccounts.apiKey' }).length, 0);
  await edit('memoryAccounts.endpoint', 'https://different.invalid/v1'); assert.equal(button('memoryAccounts.update').props.disabled, true);
  await click('memoryAccounts.update'); assert.equal(queue.length, 0);
  await choose('memoryAccounts.credential', 'set'); await edit('memoryAccounts.apiKey', 'invented-replacement-key'); await click('memoryAccounts.update');
  assert.equal(queue[0].args.action, 'update'); assert.equal(queue[0].args.ownerRef, metadata.ownerRef); assert.equal(queue[0].args.expectedOwnerRevision, 2);
  assert.equal(queue[0].args.secretAction, 'set'); assert.equal(queue[0].args.baseUrl, 'https://different.invalid/v1');
  await settle('apply', receipt); await settle('context', snapshot([])); await unmount();
});
test('same destination preserve sends no plaintext and keeps its exact owner CAS', async () => {
  await mount([metadata]); await click('common.edit'); await edit('memoryAccounts.label', 'Fictional renamed');
  await click('memoryAccounts.update'); assert.equal(queue[0].args.secretAction, 'preserve'); assert.equal(Object.hasOwn(queue[0].args, 'secret'), false);
  await settle('apply', receipt); await settle('context', snapshot([metadata])); await unmount();
});
test('revoke sends only the selected owner and revisions, and a revoked row cannot be edited', async () => {
  await mount([metadata]); await click('memoryAccounts.revoke');
  const request = queue[0].args; assert.equal(request.action, 'revoke'); assert.equal(request.ownerRef, metadata.ownerRef);
  assert.equal(request.expectedCatalogRevision, 4); assert.equal(request.expectedOwnerRevision, 2);
  assert.deepEqual(Object.keys(request).sort(), ['action', 'expectedCatalogRevision', 'expectedOwnerRevision', 'operationId', 'ownerRef']);
  await settle('apply', { ...receipt, status: 'revoked' }); await settle('context', snapshot([{ ...metadata, status: 'revoked', hasCredential: false }]));
  assert.equal(button('common.edit'), undefined); assert.equal(button('memoryAccounts.revoke'), undefined); await unmount();
});
test('unconfirmed write clears key, freezes further mutation and retains public draft until explicit reload', async () => {
  await mount(); await fill(); await click('memoryAccounts.create');
  await settle('apply', Object.assign(new Error('synthetic transport loss'), { code: 'MEMORY_OWNER_UNCERTAIN' }), true);
  assert.equal(input('memoryAccounts.apiKey').props.value, ''); assert.equal(input('memoryAccounts.label').props.value, 'Fictional new account');
  assert.equal(lastContext, null); assert.equal(button('memoryAccounts.create').props.disabled, true);
  await click('memoryAccounts.create'); assert.equal(queue.length, 0);
  await click('memoryAccounts.discardReload'); await settle('context', snapshot([metadata]));
  assert.equal(input('memoryAccounts.label').props.value, ''); assert.equal(guard.dirty, false); await unmount();
});
test('pending recovery uses exact operation ID and never permits cancelling a published operation', async () => {
  await mount();
  await act(async () => renderer.update(el(Component, props('profile-a'))));
  await settle('context', { ...snapshot([]), pendingOperations: [{ operationId: 'pending-a', ownerRef: metadata.ownerRef, phase: 'published' }] });
  assert.equal(button('memoryAccounts.cancelPending').props.disabled, true);
  await edit('memoryAccounts.recoveryKey', 'invented-original-key'); await click('memoryAccounts.resume');
  assert.deepEqual(queue[0].args, { operationId: 'pending-a', mode: 'resume', secret: 'invented-original-key' });
  await settle('recover', receipt); await settle('context', snapshot([metadata])); assert.equal(guard.dirty, false); await unmount();
});
test('invalid route, opaque ID or malformed secret makes no admission request and preserves editing text', async () => {
  await mount(); await fill();
  for (const url of ['https://user:key@fixture.invalid/v1', 'https://fixture.invalid/v1?region=fixture', 'file:///private/tmp/key', ' https://fixture.invalid']) {
    await edit('memoryAccounts.endpoint', url); assert.equal(button('memoryAccounts.create').props.disabled, true); await click('memoryAccounts.create');
  }
  await edit('memoryAccounts.endpoint', 'https://fixture.invalid/v1'); await edit('memoryAccounts.provider', 'constructor');
  assert.equal(button('memoryAccounts.create').props.disabled, true); await click('memoryAccounts.create');
  await edit('memoryAccounts.provider', 'openai'); await edit('memoryAccounts.apiKey', '\ud800');
  assert.equal(button('memoryAccounts.create').props.disabled, true); await click('memoryAccounts.create'); assert.equal(queue.length, 0); await unmount();
});
test('a late Profile read cannot replace the new scope context or unblock an old scope mutation', async () => {
  await act(async () => { renderer = create(el(Component, props('profile-a'))); });
  assert.equal(queue[0].args.profileId, 'profile-a');
  await act(async () => renderer.update(el(Component, props('profile-b'))));
  assert.equal(queue.length, 2); await settle('context', snapshot([{ ...metadata, scope: { kind: 'profile', profileId: 'profile-a' } }]));
  assert.equal(lastContext, null); await settle('context', snapshot([{ ...metadata, scope: { kind: 'profile', profileId: 'profile-b' } }]));
  assert.equal(lastContext.profileId, 'profile-b'); assert.equal(lastStatus.busy, false); await unmount();
});
test('reopening the editor waits for the admitted credential write before reading a new catalog snapshot', async () => {
  await mount(); await fill(); await click('memoryAccounts.create');
  await act(async () => renderer.unmount());
  await act(async () => { renderer = create(el(Component, props('profile-a'))); });
  assert.equal(queue.length, 1); assert.equal(queue[0].kind, 'apply');
  await settle('apply', receipt); assert.equal(queue.length, 1); assert.equal(queue[0].kind, 'context');
  assert.equal(queue[0].args.profileId, 'profile-a'); await settle('context', snapshot([metadata]));
  assert.equal(lastContext.profileId, 'profile-a'); assert.equal(input('memoryAccounts.apiKey').props.value, ''); await unmount();
});
