import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// The idea thread (InspirationThread.tsx): each round as a chat exchange, the chat composer at its foot.
const root = path.resolve(import.meta.dirname, '..');
const uiRequire = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = uiRequire('typescript');
const React = uiRequire('react');
const { create, act } = uiRequire('react-test-renderer');
const componentPath = path.join(root, 'app/manage-ui/src/pages/InspirationThread.tsx');
const compiled = ts.transpileModule(fs.readFileSync(componentPath, 'utf8'), { fileName: componentPath, compilerOptions: {
  esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { load: loadUiSource } = uiRequire(path.join(root, 'scripts/fixtures/load-ui-typescript.cjs'));
const zh = loadUiSource('i18n/locales/zh-CN.ts').default.inspiration;
const errorLabels = zh.growth.errors;
const errorKeyPrefix = 'inspiration.growth.errors.';
const errorLabel = (key) => key.startsWith(errorKeyPrefix) ? errorLabels[key.slice(errorKeyPrefix.length)] : undefined;
const lists = { 'inspiration.thread.intents': ['Develop', 'Explore'], 'inspiration.thread.followups': ['Go deeper', 'Another way'],
  'inspiration.chatter.lines': ['Hello.'] };
const loadModule = (file, { require: loadDependency = uiRequire, globals = {} } = {}) => {
  const value = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: value.exports, require: loadDependency, ...globals });
  return value.exports;
};
const execution = loadModule('pages/inspiration-execution.ts');
const noteText = loadModule('pages/inspiration-note-text.ts');
{
  const { inspirationNoteContent } = noteText;
  const plain = inspirationNoteContent({ title: null, body: 'Body', attachments: [] });
  assert.equal(plain.body, 'Body');
  assert.equal(plain.attachments.length, 0);
  const merged = inspirationNoteContent({ title: 'Title', body: 'Body', attachments: [{ id: 'a', textOffset: 2 }, { id: 'b' }] });
  assert.equal(merged.body, 'Title\nBody', 'A legacy title is simply the first line of the text');
  assert.deepEqual(merged.attachments.map(item => item.textOffset), [8, 6], 'Attachments keep their places after the folded first line');
  assert.equal(inspirationNoteContent({ title: 'Only', body: '', attachments: [] }).body, 'Only');
}
const capabilities = { execute: true, session: true, respond: true, cancel: true, reason: null };
const agents = ['shoggoth', 'openclaw', 'hermes'].map((backendId) => ({
  backendId, backendName: backendId, id: `${backendId}-agent`, name: backendId, capabilities: { ...capabilities },
}));
let idea;
let roster;
let refreshes = 0;
const starts = [];
const cancellations = [];
const updates = [];
const queueTimers = new Map();
let queueTimer = 0;
const advanceQueue = async () => act(async () => {
  for (const [id, tick] of [...queueTimers]) {
    queueTimers.delete(id);
    tick();
  }
  await new Promise(setImmediate);
});
const refresh = async () => { refreshes++; };
const host = (type) => (props) => React.createElement(type, props, props.children);
const passthrough = (props) => React.createElement(React.Fragment, {}, props.children);
const stubs = {
  'react-i18next': { useTranslation: () => ({ t: (key, options) => options?.returnObjects ? lists[key] ?? [] : errorLabel(key) || key,
    i18n: { exists: (key) => Boolean(errorLabel(key)) } }) },
  'react-router-dom': { Link: host('a'), useSearchParams: () => [new URLSearchParams(), () => {}] },
  '@base-ui/react/popover': { Popover: { Root: passthrough, Portal: passthrough, Positioner: passthrough, Popup: host('div'),
    Trigger: (props) => React.createElement('button', { ...props, type: 'button' }, props.children) } },
  '../components/Modal': (props) => React.createElement('dialog', {}, props.title, props.actions, props.children, props.footer),
  '../components/AgentAvatar': host('span'),
  '../components/ArtifactThumb': host('span'),
  '../components/BackendTabIcon': { __esModule: true, default: host('i'), sortBackendTabs: (items) => items },
  '../components/LiquidPill': () => null,
  '../components/TurnTimeline/TurnTimeline': host('ol'),
  '../components/TurnTimeline/trajectoryIcons': { IconTrajectory: host('i') },
  '../components/ui': { useConfirm: () => async () => true, useToast: () => ({ error: assert.fail, success() {} }) },
  '../lib/usePageCache': { usePageCache: (key) => ({ refresh, data: key.startsWith('inspiration-agents') || key.startsWith('inspiration-idle')
    ? { agents: roster } : { idea, history: { executions: idea.latestExecution ? [idea.latestExecution] : [], nextCursor: null,
      total: idea.latestExecution ? 1 : 0 } } }) },
  '../lib/navigation-guard': { useNavigationGuard() {} },
  '../lib/markdown': { toSanitizedMarkdownHtml: (text) => text },
  '../lib/inspiration-navigation': { rememberInspirationReturn() {} },
  '../lib/backends': { useBackendCatalog: () => [] },
  '../lib/useSessionRuntimeModels': { useSessionRuntimeModels: () => ({ data: undefined, loading: false, error: false, pending: false,
    refresh: async () => {}, select: async () => false }) },
  '../lib/turnTimeline': { stepsFromParts: () => [] },
  '../api/client': {
    ApiError: class ApiError extends Error {},
    getInspiration: async () => ({ idea }),
    startInspiration: async (id, input) => { starts.push({ id, input }); },
    cancelInspiration: async (id, input) => { cancellations.push({ id, input }); },
    updateInspiration: async (id, input) => { updates.push({ id, input }); Object.assign(idea, input.patch); idea.revision++; },
    respondInspiration: async () => {}, revealPath: async () => {},
  },
  './ChatPromptCard': host('aside'),
  './ChatModelMenu': host('span'),
  './chatIcons': { IconAttachmentFolder: host('i'), IconModel: host('i'), IconSend: host('i'), IconStop: host('i') },
  './InspirationStatusIcon': { __esModule: true, default: host('i') },
  './InspirationActionIcon': host('i'),
  './InspirationMedia': (props) => React.createElement('div', { 'data-media-editor': true }, React.createElement('textarea', {
    ...props.inputProps, value: props.body, disabled: props.disabled,
    onChange: (event) => props.onChange((previous) => ({ ...previous, body: event.target.value })) })),
  './InspirationContent': (props) => props.renderText(props.body, 0),
  './inspiration-draft': { draftBytes: (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') },
  './inspiration-execution': execution,
  './inspiration-note-text': noteText,
  './use-inspiration-activity': { useInspirationActivity: () => ({ activity: null, error: false, live: false, retry() {} }) },
};
stubs['./inspiration-next-step'] = loadModule('pages/inspiration-next-step.ts', {
  require: (name) => name === './inspiration-execution' ? execution : stubs[name] ?? uiRequire(name),
  globals: { AbortSignal, crypto: { randomUUID },
    setTimeout: (tick) => { queueTimers.set(++queueTimer, tick); return queueTimer; },
    clearTimeout: (id) => queueTimers.delete(id) },
});
const loadThread = () => {
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
    require: (name) => name.endsWith('.css') ? {} : stubs[name] || uiRequire(name), module: mod,
    window: { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: true }) },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    crypto: { randomUUID }, TextEncoder, URLSearchParams,
  });
  return mod.exports;
};
let { IdeaDetail } = loadThread();
const textOf = (node) => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(textOf).join('') : node?.children ? textOf(node.children) : '';
const buttons = (renderer) => renderer.root.findAllByType('button');
const button = (renderer, label) => buttons(renderer).find((value) => value.props['aria-label'] === label || textOf(value) === label);
const radio = (renderer, name) => renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'radio'
  && node.props['aria-label']?.startsWith(name));
// The picker groups agents by runtime, as the auto-nurture picker does: choose the runtime tab, then the agent.
const pick = async (renderer, backendId) => {
  const tab = buttons(renderer).find((node) => node.props['data-runtime'] === backendId);
  if (tab) await click(tab);
  await click(radio(renderer, backendId)[0]);
};
const type = (renderer, value) => act(() => renderer.root.findByProps({ id: 'inspiration-thread-input' }).props.onChange({ target: { value } }));
const enter = (renderer) => act(async () => {
  renderer.root.findByProps({ id: 'inspiration-thread-input' }).props.onKeyDown({
    key: 'Enter', preventDefault() {}, nativeEvent: { isComposing: false, keyCode: 13 },
  });
  await new Promise(setImmediate);
});
const render = (status = 'completed', errorCode = null, title = null, latestExecution = true) => {
  idea = { id: 'idea', body: 'Original idea', title, revision: 2, favorite: false, archivedAt: null, acceptedAt: null,
    createdAt: 1, updatedAt: 1, status: latestExecution ? status : 'saved', latestExecution: latestExecution ? { id: 'execution', ideaId: 'idea', runId: 'run', backendId: 'shoggoth',
      agentId: 'shoggoth-agent', profileId: 'profile', workspace: '/fixture/native', createdAt: 1, finishedAt: 2,
      sessionKey: 'session', status, attention: null, errorCode, resultSummary: null, instruction: 'Earlier ask' } : null };
  roster = structuredClone(agents);
  let renderer;
  act(() => { renderer = create(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })); });
  return renderer;
};
const click = async (target) => { await act(async () => { target.props.onClick(); await new Promise(setImmediate); }); };

{
  // Each round reads as a chat exchange: what was asked, then the agent's reply.
  const renderer = render();
  assert.ok(renderer.root.findAll((node) => node.type === 'div' && textOf(node) === 'Earlier ask').length > 0, 'the round shows what the user asked');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.thread.adopt'), 'the latest finished round can be chosen');
  assert.ok(button(renderer, 'inspiration.thread.harvestLatest'), 'a finished idea can be harvested from the header');
  act(() => renderer.unmount());
}

for (const backendId of ['openclaw', 'hermes']) {
  const renderer = render();
  await click(button(renderer, 'inspiration.thread.workspace'));
  act(() => renderer.root.findAll((node) => node.type === 'input')[0].props.onChange({ target: { value: '/fixture/custom-native' } }));
  await pick(renderer, backendId);
  assert.equal(renderer.root.findAll((node) => node.type === 'input').length, 0, 'External execution must not suggest a workspace override');
  type(renderer, 'Carry on');
  await click(button(renderer, 'inspiration.thread.send'));
  const start = starts.at(-1);
  assert.equal(start.input.backendId, backendId);
  assert.equal(start.input.agentId, `${backendId}-agent`);
  assert.equal(start.input.instruction, 'Carry on');
  assert.equal(start.input.workspace, null, 'Switching from native must not leak the previous workspace override');
  act(() => renderer.unmount());
}

{
  const originalCache = stubs['../lib/usePageCache'].usePageCache;
  const originalCatalog = stubs['../lib/backends'].useBackendCatalog;
  const originalModels = stubs['../lib/useSessionRuntimeModels'].useSessionRuntimeModels;
  const selections = [];
  const reads = [];
  const otherRounds = [];
  stubs['../lib/usePageCache'].usePageCache = key => {
    const view = originalCache(key);
    return view.data.history ? { ...view, data: { ...view.data, history: {
      executions: [...view.data.history.executions, ...otherRounds], total: 1 + otherRounds.length, nextCursor: null,
    } } } : view;
  };
  stubs['../lib/backends'].useBackendCatalog = () => [{ id: 'shoggoth', surfaces: { sessionRuntimeSwitch: true } }];
  stubs['../lib/useSessionRuntimeModels'].useSessionRuntimeModels = (_backend, _agentId, key, enabled) => {
    if (enabled) reads.push(key);
    return { data: enabled ? { models: [{ id: 'fixture-model', bindingId: 'binding' }],
      selection: { model: null, bindingId: 'binding', canSwitch: true }, runtimes: [] } : undefined,
    select: async () => selections.push(key), refresh: async () => {} };
  };
  const renderer = render();
  const sessionHref = key => '/chat?session=' + encodeURIComponent(key);
  idea.latestExecution = { ...idea.latestExecution, sessionHref: sessionHref('current'), reusableSession: true };
  otherRounds.push({ ...idea.latestExecution, id: 'archived', runId: 'archived-run', workspace: '/fixture/alternate',
    sessionHref: sessionHref('archived'), reusableSession: false },
  { ...idea.latestExecution, id: 'alternate', runId: 'alternate-run', workspace: '/fixture/alternate',
    sessionHref: sessionHref('alternate') });
  act(() => renderer.update(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })));
  assert.equal(reads.at(-1), 'current', 'The current workspace opens its reusable session');
  await click(button(renderer, 'inspiration.thread.workspace'));
  const changeWorkspace = value => act(() => renderer.root.findByType('input').props.onChange({ target: { value } }));
  const models = () => renderer.root.findAllByType(stubs['./ChatModelMenu']);
  const priorReads = reads.length;
  changeWorkspace('/fixture/new-directory');
  assert.equal(models().length, 0, 'A new workspace never offers model writes to an older session');
  assert.equal(reads.length, priorReads);
  changeWorkspace('/fixture/alternate');
  assert.equal(reads.at(-1), 'alternate', 'The matching reusable session wins over an archived session in the same workspace');
  await act(async () => models()[0].props.onSelect('fixture-model', 'provider', 'binding'));
  assert.deepEqual(selections, ['alternate']);
  type(renderer, 'Start in the chosen workspace');
  await click(button(renderer, 'inspiration.thread.send'));
  assert.equal(starts.at(-1).input.workspace, '/fixture/alternate');
  act(() => renderer.unmount());
  stubs['../lib/usePageCache'].usePageCache = originalCache;
  stubs['../lib/backends'].useBackendCatalog = originalCatalog;
  stubs['../lib/useSessionRuntimeModels'].useSessionRuntimeModels = originalModels;
}

{
  const renderer = render();
  await click(button(renderer, 'Go deeper'));
  type(renderer, 'add a budget');
  await click(button(renderer, 'inspiration.thread.send'));
  assert.equal(starts.at(-1).input.backendId, 'shoggoth');
  assert.equal(starts.at(-1).input.workspace, '/fixture/native', 'the same agent continues in its Session directory');
  assert.equal(starts.at(-1).input.instruction, 'inspiration.thread.intentWithText', 'a chosen chip and the typed text form one instruction');
  roster = roster.map((agent) => ({ ...agent, capabilities: { ...agent.capabilities, execute: false, reason: 'backend-unavailable' } }));
  act(() => renderer.update(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })));
  assert.ok(renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'radio').every((value) => value.props.disabled),
    'Unavailable agents cannot be picked');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.noAgent'));
  const startCount = starts.length;
  type(renderer, 'Try again');
  const unavailable = button(renderer, 'inspiration.thread.send');
  assert.equal(unavailable.props.disabled, true);
  await click(unavailable);
  assert.equal(starts.length, startCount, 'Execution guard also rejects an unavailable Agent if the handler is invoked');
  act(() => renderer.unmount());
}

{
  const renderer = render('unknown');
  const startCount = starts.length;
  assert.equal(button(renderer, 'inspiration.thread.send'), undefined, 'A running round offers stop instead of send');
  const beforeRefresh = refreshes;
  await click(button(renderer, 'inspiration.checkStatus'));
  assert.ok(refreshes > beforeRefresh);
  await click(button(renderer, 'inspiration.stop'));
  assert.equal(cancellations.at(-1).input.runId, 'run');
  assert.equal(starts.length, startCount, 'Unknown status only permits checking or stopping the current execution');
  act(() => renderer.unmount());
}
{
  const renderer = render('running');
  const startCount = starts.length;
  type(renderer, 'Next step');
  await enter(renderer);
  assert.equal(starts.length, startCount, 'A step written during a round waits instead of starting');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.thread.queue.waiting'), 'The queued step shows under the round');
  act(() => renderer.unmount());
  let reopened;
  act(() => { reopened = create(React.createElement(IdeaDetail, { id: 'idea', onClose() {}, onChange: refresh })); });
  assert.ok(textOf(reopened.toJSON()).includes('Next step'), 'Reopening shows the step that was already queued');
  act(() => reopened.unmount());
  idea = { ...idea, status: 'completed', latestExecution: { ...idea.latestExecution, status: 'completed' } };
  await advanceQueue();
  await advanceQueue();
  assert.equal(starts.length, startCount + 1, 'The step is sent exactly once with no dialog open');
  assert.equal(starts.at(-1).input.instruction, 'Next step');
  assert.equal(starts.at(-1).input.workspace, '/fixture/native');
}
{
  const renderer = render('running');
  const startCount = starts.length;
  type(renderer, 'Do not send after a stop');
  await enter(renderer);
  idea = { ...idea, status: 'canceled', latestExecution: { ...idea.latestExecution, status: 'canceled' } };
  await advanceQueue();
  assert.equal(starts.length, startCount, 'Stopping the predecessor must not dispatch the next step');
  await click(button(renderer, 'inspiration.thread.queue.restore'));
  assert.equal(renderer.root.findByProps({ id: 'inspiration-thread-input' }).props.value, 'Do not send after a stop');
  act(() => renderer.unmount());
}
{
  const renderer = render('running');
  const startCount = starts.length;
  type(renderer, 'Cancel my queue');
  await enter(renderer);
  await click(button(renderer, 'inspiration.thread.unqueue'));
  idea = { ...idea, status: 'completed', latestExecution: { ...idea.latestExecution, status: 'completed' } };
  await advanceQueue();
  assert.equal(starts.length, startCount, 'A removed queue cannot dispatch from an old timer');
  act(() => renderer.unmount());
}
{
  const renderer = render('running');
  const start = stubs['../api/client'].startInspiration;
  let attempts = 0;
  stubs['../api/client'].startInspiration = async () => { attempts++; throw Error('Response lost'); };
  type(renderer, 'Check this before sending again');
  await enter(renderer);
  idea = { ...idea, status: 'completed', latestExecution: { ...idea.latestExecution, status: 'completed' } };
  await advanceQueue();
  await advanceQueue();
  assert.equal(attempts, 1, 'The window must not repeat a send with an unknown result');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.thread.queue.uncertain'));
  assert.ok(textOf(renderer.toJSON()).includes('Check this before sending again'));
  assert.equal(button(renderer, 'inspiration.thread.queue.restore'), undefined);
  await click(button(renderer, 'inspiration.thread.queue.dismiss'));
  stubs['../api/client'].startInspiration = start;
  act(() => renderer.unmount());
}
{
  const renderer = render('canceled');
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.status.failed'), 'Manual stops use the failed status in details');
  assert.ok(!textOf(renderer.toJSON()).includes('inspiration.status.canceled'));
  assert.ok(textOf(renderer.toJSON()).includes(errorLabels.INSPIRATION_CANCELED), 'The stop reason remains visible');
  type(renderer, 'Again');
  assert.equal(button(renderer, 'inspiration.thread.send').props.disabled, false);
  assert.equal(button(renderer, 'inspiration.stop'), undefined);
  act(() => renderer.unmount());
}
{
  const renderer = render('interrupted', 'DEMO_SERVICE_RESTARTED');
  const paragraphs = renderer.root.findAllByType('p').map((value) => textOf(value));
  const primary = paragraphs.find((value) => value.includes('执行服务重启'));
  assert.ok(primary?.includes('请先查看会话中的进度'));
  assert.ok(!primary.includes('DEMO_SERVICE_RESTARTED'), 'Known codes should not replace the explanation');
  assert.equal(errorLabels.SERVICE_RESTARTED, errorLabels.DEMO_SERVICE_RESTARTED);
  await click(button(renderer, 'inspiration.thread.narrowRetry'));
  assert.equal(starts.at(-1).input.instruction, 'inspiration.thread.narrowRetry', 'A failed round can retry with a smaller scope');
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
  // A seed starts from the lineup with the first intent chosen; sending it alone asks for the default round.
  const renderer = render('saved', null, null, false);
  assert.ok(textOf(renderer.toJSON()).includes('inspiration.thread.seedHeading'));
  assert.equal(radio(renderer, 'shoggoth')[0].props['aria-checked'], true, 'The first capable agent is chosen');
  assert.equal(button(renderer, 'Develop').props['aria-pressed'], true, 'The seed opens with the first intent chosen');
  await click(radio(renderer, 'hermes')[0]);
  await click(button(renderer, 'inspiration.thread.send'));
  assert.equal(starts.at(-1).input.agentId, 'hermes-agent');
  assert.equal(starts.at(-1).input.instruction, 'Develop', 'An intent chip on its own becomes the instruction');
  act(() => renderer.unmount());
}
{
  const renderer = render('completed');
  await click(button(renderer, 'inspiration.edit'));
  act(() => renderer.root.findAll((node) => node.type === 'textarea' && node.props['aria-label'] === 'inspiration.original')[0]
    .props.onChange({ target: { value: 'Plain note' } }));
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
  const editors = () => renderer.root.findAll((node) => node.type === 'textarea' && node.props['aria-label'] === 'inspiration.original');
  assert.equal(renderer.root.findAll((node) => node.type === 'input').length, 0, 'Editing a note should expose no separate title field');
  assert.equal(editors().length, 1, 'The note text remains the single text editor');
  assert.equal(editors()[0].props.value, 'Legacy title\nOriginal idea', 'The editor holds the complete text');
  act(() => editors()[0].props.onChange({ target: { value: 'Updated note' } }));
  await click(button(renderer, 'inspiration.saveEdit'));
  assert.equal(updates.at(-1).input.patch.body, 'Updated note');
  assert.equal(updates.at(-1).input.patch.title, null, 'Saving folds the legacy title into the text');
  assert.equal(idea.title, null);
  act(() => renderer.unmount());
}
{
  // A cold deep link mounts the wall and detail together. Use the real cache:
  // one consumer's request must not leave the other's Agent picker empty.
  const seed = render();
  act(() => seed.unmount());
  const realCache = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/lib/usePageCache.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: realCache, require: uiRequire });
  stubs['../lib/usePageCache'] = { usePageCache: realCache.usePageCache };
  stubs['../api/client'].getInspiration = async () => ({ idea });
  stubs['../api/client'].getInspirationExecutions = async () => ({ executions: [idea.latestExecution], nextCursor: null, total: 1 });
  stubs['../api/client'].getIdleInspirationAgents = async () => ({ agents });
  let requests;
  stubs['../api/client'].getInspirationAgents = () => new Promise(resolve => requests.push(resolve));
  ({ IdeaDetail } = loadThread());
  function WallRoster() {
    const value = realCache.usePageCache('inspiration-agents', stubs['../api/client'].getInspirationAgents);
    return React.createElement('output', {}, String(value.data?.agents.length || 0));
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
    assert.equal(buttons(renderer).filter((node) => node.props['data-runtime']).length, 3,
      'A deep-linked detail receives its roster even when the wall reads the same catalog');
    await pick(renderer, 'hermes');
    type(renderer, 'Hand over');
    assert.equal(button(renderer, 'inspiration.thread.send').props.disabled, false);
    await click(button(renderer, 'inspiration.thread.send'));
    assert.equal(starts.at(-1).input.agentId, 'hermes-agent');
    act(() => renderer.unmount());
  }
}
console.log('PASS Inspiration thread: chat rounds, external routes, workspace isolation, native continuation, combined intents, queued steps, offline guard, stopped failures, retries, seed lineup, plain-text notes, legacy titles and concurrent deep-link rosters');
