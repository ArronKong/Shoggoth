import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const uiRequire = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = uiRequire('typescript');
const React = uiRequire('react');
const { create, act } = uiRequire('react-test-renderer');
const componentPath = path.join(root, 'app/manage-ui/src/pages/InspirationPage.tsx');
const source = fs.readFileSync(componentPath, 'utf8');
const compiled = ts.transpileModule(source, { fileName: componentPath, compilerOptions: {
  esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { load: loadUiSource } = uiRequire(path.join(root, 'scripts/fixtures/load-ui-typescript.cjs'));
const errorLabels = loadUiSource('i18n/locales/zh-CN.ts').default.inspiration.growth.errors;
const errorKeyPrefix = 'inspiration.growth.errors.';
const errorLabel = (key) => key.startsWith(errorKeyPrefix) ? errorLabels[key.slice(errorKeyPrefix.length)] : undefined;
const execution = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/inspiration-execution.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: execution.exports });
const noteText = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/inspiration-note-text.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: noteText.exports });
{
  const { inspirationNoteContent } = noteText.exports;
  const plain = inspirationNoteContent({ title: null, body: 'Body', attachments: [] });
  assert.equal(plain.body, 'Body');
  assert.equal(plain.attachments.length, 0);
  const merged = inspirationNoteContent({ title: 'Title', body: 'Body', attachments: [{ id: 'a', textOffset: 2 }, { id: 'b' }] });
  assert.equal(merged.body, 'Title\nBody', 'A legacy title is simply the first line of the text');
  assert.deepEqual(merged.attachments.map(item => item.textOffset), [8, 6], 'Attachments keep their places after the folded first line');
  assert.equal(inspirationNoteContent({ title: 'Only', body: '', attachments: [] }).body, 'Only');
}
const capabilities ={ execute: true, session: true, respond: true, cancel: true, reason: null };
const agents = ['shoggoth', 'openclaw', 'hermes'].map((backendId) => ({
  backendId, backendName: backendId, id: `${backendId}-agent`, name: backendId, capabilities: { ...capabilities },
}));
let idea;
let roster;
let refreshes = 0;
const starts = [];
const cancellations = [];
const updates = [];
const refresh = async () => { refreshes++; };
const host = (type) => (props) => React.createElement(type, props, props.children);
const stubs = {
  './InspirationMedia': { __esModule: true, default: props => React.createElement('div', { ...props, 'data-media-editor': true }, React.createElement('textarea', { ...props.inputProps, value: props.body, disabled: props.disabled, onChange: event => props.onChange(previous => ({ ...previous, body: event.target.value })) })), InspirationMediaPreview: host('aside') },
  './inspiration-media': {},
  './inspiration-draft': { draftBytes: value => Buffer.byteLength(JSON.stringify(value), 'utf8') },
  'react-i18next': { useTranslation: () => ({ t: (key) => errorLabel(key) || key,
    i18n: { exists: (key) => Boolean(errorLabel(key)) } }) },
  'react-router-dom': { Link: host('a'), useSearchParams: () => [new URLSearchParams(), () => {}] },
  '../components/Modal': (props) => React.createElement('dialog', {}, props.title, props.children, props.footer),
  '../components/Field': { Field: host('label'), TextArea: host('textarea'), TextInput: host('input'),
    Select: host('select'), Option: host('option') },
  '../components/ui': { useConfirm: () => async () => true, useToast: () => ({ error: assert.fail, success() {} }) },
  '../components/AgentAvatar': host('span'),
  '../lib/usePageCache': { usePageCache: (key) => ({ refresh, data: key.startsWith('inspiration-agents') ? { agents: roster }
    : { idea, history: { executions: idea.latestExecution ? [idea.latestExecution] : [], nextCursor: null } } }) },
  '../lib/page-refresh': { useRegisterPageLoading() {}, useRegisterPageRefresh() {} },
  '../lib/navigation-guard': { useNavigationGuard() {} },
  '../lib/markdown': { toSanitizedMarkdownHtml: (text) => text },
  '../lib/inspiration-navigation': { rememberInspirationReturn() {}, forgetInspirationReturn() {} },
  '../api/client': {
    startInspiration: async (id, input) => { starts.push({ id, input }); },
    cancelInspiration: async (id, input) => { cancellations.push({ id, input }); },
    updateInspiration: async (id, input) => { updates.push({ id, input }); Object.assign(idea, input.patch); idea.revision++; },
  },
  './InspirationStatusIcon': { default: host('i'), inspirationGrowthStage: () => 0, __esModule: true },
  './InspirationActionIcon': host('i'),
  './InspirationActivity': host('section'),
  './InspirationRunBar': host('section'),
  './InspirationRunCard': host('section'),
  './InspirationArchiveControls': () => null, './InspirationTypewriter': host('div'),
  './InspirationCapture': host('section'),
    './InspirationContent': props => props.renderText(props.body, 0),
  './InspirationAutoGrowth': host('section'),
  './InspirationAgentChatter': host('aside'),
  './InspirationAgentDock': host('aside'),
  './inspiration-paper-motion': { prepareInspirationPaperFlight: () => null },
  './inspiration-execution': execution.exports,
  './inspiration-note-text': noteText.exports,
  './inspiration-scroll-stages': { attachInspirationScrollStages() {} },
  './inspiration-card-drag': { beginInspirationCardDrag: () => () => {} },
  './inspiration-wall-pages': { readInspirationWallPages: async () => ({ items: [], total: 0, hasMore: false, nextCursor: null, pageCount: 1 }) },
  './ChatPromptCard': host('aside'),
  '../components/PageHead': { PageHead: host('header') },
  '../components/FilterTabs': host('nav'),
  '../components/SearchCapsule': host('input'),
};
const mod = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
  require: (name) => name.endsWith('.css') ? {} : stubs[name] || uiRequire(name), module: mod,
  window: { setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  crypto: { randomUUID }, TextEncoder, URLSearchParams,
});
const { IdeaDetail } = mod.exports;
const textOf = (node) => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(textOf).join('') : node?.children ? textOf(node.children) : '';
const button = (renderer, label) => renderer.root.findAllByType('button').find((value) => textOf(value) === label);
const render = (status = 'completed', errorCode = null, title = null) => {
  idea = { id: 'idea', body: 'Original idea', title, revision: 2, favorite: false, archivedAt: null, acceptedAt: null,
    createdAt: 1, status, latestExecution: { id: 'execution', ideaId: 'idea', runId: 'run', backendId: 'shoggoth',
      agentId: 'shoggoth-agent', profileId: 'profile', workspace: '/fixture/native', createdAt: 1,
      sessionKey: 'session', status, attention: null, errorCode } };
  roster = structuredClone(agents);
  let renderer;
  act(() => { renderer = create(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })); });
  return renderer;
};
const click = async (target) => { await act(async () => { target.props.onClick(); await new Promise(setImmediate); }); };

for (const backendId of ['openclaw', 'hermes']) {
  const renderer = render();
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: '/fixture/custom-native' } }));
  act(() => renderer.root.findByType('select').props.onChange(`${backendId}/${backendId}-agent`));
  assert.equal(renderer.root.findAllByType('input').length, 0, 'External execution must not suggest a workspace override');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.externalWorkspaceHint'));
  await click(button(renderer, 'inspiration.continue'));
  const start = starts.at(-1);
  assert.equal(start.input.backendId, backendId);
  assert.equal(start.input.agentId, `${backendId}-agent`);
  assert.equal(start.input.workspace, null, 'Switching from native must not leak the previous workspace override');
  act(() => renderer.unmount());
}

{
  const renderer = render();
  await click(button(renderer, 'inspiration.continue'));
  assert.equal(starts.at(-1).input.backendId, 'shoggoth');
  assert.equal(starts.at(-1).input.workspace, '/fixture/native');
  roster = roster.map((agent) => ({ ...agent, capabilities: { ...agent.capabilities, execute: false, reason: 'backend-unavailable' } }));
  act(() => renderer.update(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })));
  assert.ok(renderer.root.findAllByType('option').filter((value) => value.props.value).every((value) => value.props.disabled));
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.unavailable'));
  const startCount = starts.length;
  const unavailable = button(renderer, 'inspiration.continue');
  assert.equal(unavailable.props.disabled, true);
  await click(unavailable);
  assert.equal(starts.length, startCount, 'Execution guard also rejects an unavailable Agent if the handler is invoked');
  act(() => renderer.unmount());
}

{
  const renderer = render('unknown');
  const startCount = starts.length;
  assert.equal(button(renderer, 'inspiration.continue'), undefined);
  assert.equal(renderer.root.findAllByType('select').length, 0);
  const beforeRefresh = refreshes;
  await click(button(renderer, 'inspiration.checkStatus'));
  assert.ok(refreshes > beforeRefresh);
  await click(button(renderer, 'inspiration.stop'));
  assert.equal(cancellations.at(-1).input.runId, 'run');
  assert.equal(starts.length, startCount, 'Unknown status only permits checking or stopping the current execution');
  act(() => renderer.unmount());
}
{
  const renderer = render('canceled');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.status.failed'), 'Manual stops use the failed status in details');
  assert.ok(!textOf(renderer.toJSON()).includes('inspiration.status.canceled'));
  assert.ok(textOf(renderer.toJSON()).includes(errorLabels.INSPIRATION_CANCELED), 'The stop reason remains visible');
  assert.equal(button(renderer, 'inspiration.continue').props.disabled, false);
  assert.equal(button(renderer, 'inspiration.stop'), undefined);
  act(() => renderer.unmount());
}
{
  const renderer = render('interrupted', 'DEMO_SERVICE_RESTARTED');
  const paragraphs = renderer.root.findAllByType('p').map((value) => textOf(value));
  const primary = paragraphs.find((value) => value.startsWith('!') && value.includes('执行服务重启'));
  assert.ok(primary?.includes('请先查看会话中的进度'));
  assert.ok(!primary.includes('DEMO_SERVICE_RESTARTED'), 'Known codes should not replace the explanation in the main panel');
  assert.ok(paragraphs.some((value) => value.includes('DEMO_SERVICE_RESTARTED')), 'The expandable history keeps the diagnostic code');
  assert.equal(errorLabels.SERVICE_RESTARTED, errorLabels.DEMO_SERVICE_RESTARTED);
  act(() => renderer.unmount());
}
{
  const renderer = render('interrupted', 'UNMAPPED_SERVICE_CODE');
  assert.ok(textOf(renderer.toJSON()).includes('UNMAPPED_SERVICE_CODE'), 'Unknown codes stay visible for diagnosis');
  act(() => renderer.unmount());
}
{
  const renderer = render('completed');
  assert.equal(textOf(renderer.toJSON()).split('Original idea').length - 1, 1,
    'A titleless note should show its text only in the original content, not repeat it in the dialog heading');
  act(() => renderer.unmount());
}
{
  const renderer = render('completed');
  await click(button(renderer, 'inspiration.edit'));
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'Plain note' } }));
  await click(button(renderer, 'inspiration.saveEdit'));
  assert.equal(Object.hasOwn(updates.at(-1).input.patch, 'title'), false, 'Editing an untitled note never writes a title');
  act(() => renderer.unmount());
}
{
  // Notes have no title/body split: a legacy title is the first line of the text, not a heading.
  const renderer = render('completed', null, 'Legacy title');
  assert.ok(renderer.root.findAllByType('p').map((value) => textOf(value)).includes('Legacy title\nOriginal idea'),
    'A legacy title is shown as the first line of the note text');
  assert.equal(textOf(renderer.toJSON()).split('Legacy title').length - 1, 1, 'The dialog shows no separate title heading');
  await click(button(renderer, 'inspiration.edit'));
  assert.equal(renderer.root.findAllByType('input').length, 0, 'Editing a note should expose no separate title field');
  assert.equal(renderer.root.findAllByType('textarea').length, 1, 'The note text remains the single text editor');
  assert.equal(renderer.root.findByType('textarea').props.value, 'Legacy title\nOriginal idea', 'The editor holds the complete text');
  assert.ok(!textOf(renderer.toJSON()).includes('inspiration.optionalTitle'));
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'Updated note' } }));
  await click(button(renderer, 'inspiration.saveEdit'));
  assert.equal(updates.at(-1).input.patch.body, 'Updated note');
  assert.equal(updates.at(-1).input.patch.title, null, 'Saving folds the legacy title into the text');
  assert.equal(idea.title, null);
  act(() => renderer.unmount());
}
{
  // A cold deep link mounts the wall and detail together. Use the real cache:
  // one consumer's request must not leave the other's Agent selector empty.
  const seed = render();
  act(() => seed.unmount());
  const realCache = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/lib/usePageCache.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: realCache, require: uiRequire });
  stubs['../lib/usePageCache'].usePageCache = realCache.usePageCache;
  stubs['../api/client'].getInspiration = async () => ({ idea });
  stubs['../api/client'].getInspirationExecutions = async () => ({ executions: [idea.latestExecution], nextCursor: null });
  let requests;
  stubs['../api/client'].getInspirationAgents = () => new Promise(resolve => requests.push(resolve));
  function WallRoster() {
    const roster = realCache.usePageCache('inspiration-agents', stubs['../api/client'].getInspirationAgents);
    return React.createElement('output', {}, String(roster.data?.agents.length || 0));
  }
  for (const reverse of [false, true]) {
    realCache.invalidatePageCache();
    requests = [];
    let renderer;
    await act(async () => {
      renderer = create(React.createElement(React.Fragment, {},
        React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh }),
        React.createElement(WallRoster)));
      await new Promise(setImmediate);
    });
    assert.equal(requests.length, 2);
    await act(async () => {
      for (const resolve of reverse ? [...requests].reverse() : requests) resolve({ agents });
      await new Promise(setImmediate);
    });
    assert.equal(textOf(renderer.root.findByType('output')), '3');
    assert.equal(renderer.root.findAllByType('option').filter(option => option.props.value).length, 3,
      'A deep-linked detail receives its roster even when the wall reads the same catalog');
    assert.equal(button(renderer, 'inspiration.continue').props.disabled, false);
    act(() => renderer.root.findByType('select').props.onChange('hermes/hermes-agent'));
    await click(button(renderer, 'inspiration.continue'));
    assert.equal(starts.at(-1).input.agentId, 'hermes-agent');
    act(() => renderer.unmount());
  }
}
console.log('PASS Inspiration UI: external routes, workspace isolation, native continuation, offline guard, stopped failures, plain-text notes, legacy titles and concurrent deep-link rosters');
