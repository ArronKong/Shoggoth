import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ui = path.resolve(import.meta.dirname, '../app/manage-ui'), require = createRequire(path.join(ui, 'package.json'));
const React = require('react'), { act, create } = require('react-test-renderer'), ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pending = []; let guard, renderer;
const deferred = (kind, args) => new Promise((resolve, reject) => pending.push({ kind, args, resolve, reject }));
const api = { getNativeMemoryContext: () => deferred('context'), getNativeMemoryConfig: () => deferred('read'),
  updateNativeMemoryConfig: input => deferred('write', structuredClone(input)) };
const el = (tag, props, children) => React.createElement(tag, props, children);
const fields = {
  Field: ({ label, children, hint }) => el('label', {}, [el('span', { key: 'label' }, label), children, hint]),
  TextInput: props => el('input', props), TextArea: props => el('textarea', props),
  Select: ({ children, ...props }) => el('select', props, children), Option: props => el('option', props, props.children),
  Switch: ({ label, checked, onChange, disabled }) => el('input', { type: 'checkbox', title: label, checked, onChange, disabled }),
};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} }, code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, structuredClone, Set, Object, Error, URL,
    require: name => {
      if (name.endsWith('/NativeMemorySharingSettings')) return { __esModule: true, default: () => null };
      if (name.endsWith('/MemoryProviderAccounts')) return { __esModule: true, default: () => null };
      if (name.endsWith('.css')) return {};
      if (name.endsWith('/api/client')) return api;
      if (name.endsWith('/components/Field')) return fields;
      if (name.endsWith('/navigation-guard')) return { useNavigationGuard: value => { guard = value; } };
      if (name.endsWith('/nativeMemoryForm')) return load('src/lib/nativeMemoryForm.ts');
      if (name === 'react-i18next') return { useTranslation: () => ({ t: (key, args) => args?.id ? `${key}:${args.id}` : key }) };
      return require(name);
    },
  }); cache.set(relative, module.exports); return module.exports;
}
const form = load('src/lib/nativeMemoryForm.ts'), Component = load('src/pages/settings/SettingsMemory.tsx').default;
const context = { owner: 'shoggoth-memory-core', agents: [
  { profileId: 'a', agentId: 'public-a', name: 'Agent A' }, { profileId: 'b', agentId: 'public-b', name: 'Agent B' }] };
const initial = { memory: { search: { provider: 'gemini', model: 'gemini-embedding-2', fallback: 'none',
  remote: { baseUrl: 'https://fictional.example.invalid/v1', headers: { 'X-Project': 'fixture' }, batch: { enabled: true } },
  providerRefs: { gemini: 'owner:global', openai: 'owner:fallback' }, multimodal: { enabled: true, modalities: ['image'], maxFileBytes: 1024 },
  inputType: 'search', queryInputType: 'query', documentInputType: 'document', local: { modelPath: '/fixture/dormant.gguf' } } },
  agents: { entries: { a: { memory: { search: { remote: { batch: { enabled: false } }, providerRefs: { openai: 'owner:agent-fallback' } } } },
    b: { memory: { search: { provider: 'none', multimodal: { enabled: false } } } } } },
  plugins: { entries: { 'memory-core': { config: { dreaming: { model: 'fixture-dream' } } } } } };
const json = value => JSON.parse(JSON.stringify(value));
const input = id => renderer.root.findByProps({ id: `memory-setting-${id}` });
const button = key => renderer.root.findAllByType('button').find(node => node.children.includes(key));
const settle = async (kind, value, reject = false) => {
  const request = pending.shift(); assert.equal(request?.kind, kind);
  await act(async () => request[reject ? 'reject' : 'resolve'](value)); return request;
};
const mount = async (config = initial, revision = 7) => {
  assert.equal(pending.length, 0);
  await act(async () => { renderer = create(React.createElement(Component)); });
  assert.equal(pending.length, 0);
  await act(async () => renderer.root.findByProps({ id: 'settings-memory' }).props.onToggle({ currentTarget: { open: true } }));
  await settle('context', context); await settle('read', { revision, config: structuredClone(config) });
};
const unmount = async () => { await act(async () => renderer.unmount()); assert.equal(pending.length, 0); };
const choose = async (title, value) => { await act(async () => renderer.root.findByProps({ title }).props.onChange(value)); };
const edit = async (id, value) => { await act(async () => input(id).props.onChange({ target: { value } })); };
const submit = async () => { await act(async () => { void renderer.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => true } }); }); };

test('native field inheritance matches upstream remote merge while opaque owners merge by key', () => {
  const config = structuredClone(initial), search = form.effectiveMemorySearch(config, 'a');
  assert.deepEqual(json(search.remote), { baseUrl: initial.memory.search.remote.baseUrl, headers: { 'X-Project': 'fixture' }, batch: { enabled: false } });
  assert.deepEqual(json(search.providerRefs), { gemini: 'owner:global', openai: 'owner:agent-fallback' });
  const changed = form.changeMemorySetting(config, ['agents', 'entries', 'a', 'memory', 'search', 'remote', 'headers'], {});
  assert.deepEqual(json(form.effectiveMemorySearch(changed, 'a').remote.headers), {});
  const restored = form.changeMemorySetting(changed, ['agents', 'entries', 'a', 'memory', 'search', 'remote', 'headers'], undefined);
  assert.deepEqual(json(restored), config); assert.ok(form.validMemorySearchDraft(config));
});
test('Profile remote settings save and acknowledge while preserving other fields and independent bindings', async () => {
  await mount();
  assert.equal(renderer.root.findAllByType('input').filter(node => node.props.id === 'memory-setting-memory-search-outputDimensionality').length, 1, 'dormant local fields must not duplicate the remote dimensionality input');
  await choose('nativeMemory.scope', 'a');
  assert.equal(input('agents-entries-a-memory-search-providerRefs-gemini').props.value, '');
  assert.equal(input('agents-entries-a-memory-search-providerRefs-gemini').props.placeholder, 'nativeMemory.inheritOwner:owner:global');
  await edit('agents-entries-a-memory-search-providerRefs-gemini', 'owner:agent-primary');
  await edit('agents-entries-a-memory-search-queryInputType', 'query-fixture');
  await edit('agents-entries-a-memory-search-remote-headers', 'X-Project: agent\nX-Trace: request:42');
  await edit('agents-entries-a-memory-search-multimodal-maxFileBytes', '2048');
  await submit(); const write = pending[0]; assert.equal(write.args.expectedRevision, 7);
  const saved = write.args.config.agents.entries.a.memory.search;
  assert.deepEqual(saved.providerRefs, { openai: 'owner:agent-fallback', gemini: 'owner:agent-primary' });
  assert.deepEqual(saved.remote, { batch: { enabled: false }, headers: { 'X-Project': 'agent', 'X-Trace': 'request:42' } });
  assert.equal(saved.queryInputType, 'query-fixture'); assert.equal(saved.multimodal.maxFileBytes, 2048);
  assert.deepEqual(write.args.config.memory, initial.memory); assert.deepEqual(write.args.config.agents.entries.b, initial.agents.entries.b);
  assert.deepEqual(write.args.config.plugins, initial.plugins);
  await settle('write', { revision: 8, config: write.args.config }); assert.equal(guard.dirty, false);
  await edit('agents-entries-a-memory-search-providerRefs-gemini', ''); await edit('agents-entries-a-memory-search-remote-headers', '');
  await submit(); const restore = pending[0];
  assert.deepEqual(restore.args.config.agents.entries.a.memory.search.providerRefs, { openai: 'owner:agent-fallback' });
  assert.deepEqual(restore.args.config.agents.entries.a.memory.search.remote, { batch: { enabled: false } });
  await settle('write', { revision: 9, config: restore.args.config }); assert.equal(guard.dirty, false); await unmount();
});
test('invalid header, destination, owner or inherited media fallback causes zero save requests and retains draft', async () => {
  await mount();
  await edit('memory-search-remote-headers', 'Authorization: Bearer fictional');
  assert.equal(input('memory-search-remote-headers').props.value, 'Authorization: Bearer fictional');
  assert.equal(button('common.save').props.disabled, true); await submit(); assert.equal(pending.length, 0);
  await edit('memory-search-remote-headers', 'X-Project: safe');
  await edit('memory-search-remote-baseUrl', 'https://user:fictional@fixture.invalid/'); await submit(); assert.equal(pending.length, 0);
  await edit('memory-search-remote-baseUrl', 'https://fictional.example.invalid/v1');
  await edit('memory-search-providerRefs-gemini', ' owner:invalid'); await submit(); assert.equal(pending.length, 0);
  await edit('memory-search-providerRefs-gemini', 'owner:valid');
  await choose('nativeMemory.fields.fallback', 'openai'); await submit(); assert.equal(pending.length, 0);
  await choose('nativeMemory.fields.fallback', 'none');
  await edit('memory-search-model', 'gemini-embedding-001'); await submit(); assert.equal(pending.length, 0);
  await edit('memory-search-model', 'gemini-embedding-2-preview');
  await choose('nativeMemory.fields.modalities', 'empty'); await choose('nativeMemory.fields.fallback', 'openai');
  assert.equal(button('common.save').props.disabled, false, 'native empty modalities means inactive media');
  await submit(); const write = pending[0]; assert.deepEqual(write.args.config.memory.search.multimodal.modalities, []);
  await settle('write', { revision: 8, config: write.args.config }); await unmount();
});
test('CAS conflict retains advanced drafts and reload restores exact readback', async () => {
  await mount(); await choose('nativeMemory.scope', 'a');
  await edit('agents-entries-a-memory-search-providerRefs-gemini', 'owner:draft');
  await edit('agents-entries-a-memory-search-documentInputType', 'draft-document');
  await edit('agents-entries-a-memory-search-remote-headers', '{}'); await submit();
  await settle('write', Object.assign(Error('private data'), { code: 'NATIVE_MEMORY_CONFIG_STALE' }), true);
  assert.equal(input('agents-entries-a-memory-search-providerRefs-gemini').props.value, 'owner:draft');
  assert.equal(input('agents-entries-a-memory-search-documentInputType').props.value, 'draft-document');
  assert.equal(input('agents-entries-a-memory-search-remote-headers').props.value, '{}');
  assert.equal(button('common.save').props.disabled, true); assert.equal(JSON.stringify(renderer.toJSON()).includes('private data'), false);
  await act(async () => button('nativeMemory.discardReload').props.onClick());
  await settle('context', context); await settle('read', { revision: 11, config: structuredClone(initial) });
  assert.equal(input('agents-entries-a-memory-search-providerRefs-gemini').props.value, '');
  assert.equal(guard.dirty, false); await unmount();
});
test('local model and fallback are editable before remote selection and custom providers retain separate owners', async () => {
  const config = { memory: { search: { provider: 'local', local: { modelPath: '/fixture/local.gguf' } } } };
  await mount(config); await edit('memory-search-model', 'fixture-local-model');
  await choose('nativeMemory.fields.fallback', 'openai');
  await edit('memory-search-providerRefs-openai', 'owner:separate-fallback');
  await edit('memory-search-provider', 'fixture-compatible');
  await edit('memory-search-providerRefs-fixture-compatible', 'owner:primary-custom');
  await edit('memory-search-remote-headers', 'X-Project: custom'); await submit();
  const write = pending[0], search = write.args.config.memory.search;
  assert.equal(search.provider, 'fixture-compatible'); assert.equal(search.model, 'fixture-local-model');
  assert.equal(search.fallback, 'openai'); assert.deepEqual(search.providerRefs, { openai: 'owner:separate-fallback', 'fixture-compatible': 'owner:primary-custom' });
  assert.deepEqual(search.local, config.memory.search.local); assert.deepEqual(search.remote.headers, { 'X-Project': 'custom' });
  await settle('write', { revision: 8, config: write.args.config }); await unmount();
});
test('transport routing headers retain the draft and cause zero save requests', async () => {
  await mount();
  for (const name of ['Host', 'hOsT', 'Connection', 'Proxy-Connection', 'Keep-Alive', 'Transfer-Encoding', 'Content-Length', 'TE', 'Trailer', 'Upgrade', ':authority']) {
    const raw = `${name}: fictional-other.invalid`;
    await edit('memory-search-remote-headers', raw);
    assert.equal(input('memory-search-remote-headers').props.value, raw);
    assert.equal(button('common.save').props.disabled, true); await submit(); assert.equal(pending.length, 0);
  }
  await edit('memory-search-remote-headers', 'X-Project: safe');
  assert.equal(button('common.save').props.disabled, false); await unmount();
});
test('header editor preserves invalid text and applies only non-sensitive well-formed maps', () => {
  assert.deepEqual(json(form.parseMemoryRemoteHeaders('X-Project: a:b\nX-Trace: public')), { 'X-Project': 'a:b', 'X-Trace': 'public' });
  assert.equal(form.parseMemoryRemoteHeaders(''), undefined); assert.deepEqual(json(form.parseMemoryRemoteHeaders('{}')), {});
  for (const raw of ['X-Project: a\nx-project: b', 'X-Api-Key: fictional', 'X-Project: bearer fictional', 'not a header', 'X-Project: \ud800']) assert.equal(form.parseMemoryRemoteHeaders(raw), raw);
  assert.equal(form.formatMemoryRemoteHeaders('invalid draft'), 'invalid draft');
});

test('loaded native modality combinations remain visible without rewriting source settings', async () => {
  const config = structuredClone(initial); config.memory.search.multimodal.modalities = ['all', 'image'];
  await mount(config);
  const choice = renderer.root.findByProps({ title: 'nativeMemory.fields.modalities' });
  assert.equal(choice.props.value, 'all,image');
  assert.equal(choice.findAllByType('option').filter(node => node.props.value === 'all,image').length, 1);
  assert.equal(guard.dirty, false); await unmount();
});
