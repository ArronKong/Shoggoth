import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(path.resolve('app/manage-ui/package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The card's own behavior is under test: the activity read, the trajectory timeline and the artifact list are stand-ins.
let activityState;
let retries = 0;
const stubs = {
  'react-i18next': { useTranslation: () => ({ t: (key, options) => options?.defaultValue ?? key }) },
  '../components/AgentAvatar': { __esModule: true, default: props => React.createElement('span', { className: props.className, 'data-avatar': props.agentId }) },
  '../components/TurnTimeline/TurnTimeline': { __esModule: true,
    default: props => React.createElement('ol', { 'data-timeline': true, 'data-status': props.status, 'data-follow': props.autoFollow,
      'data-rows': props.steps.length }) },
  '../components/TurnTimeline/trajectoryIcons': { TrajChevron: () => React.createElement('i', { 'data-chevron': true }),
    TrajGlyph: ({ kind }) => React.createElement('i', { 'data-glyph': kind }) },
  './InspirationActivity': { InspirationArtifacts: ({ activity }) => React.createElement('div', { 'data-artifacts': activity?.artifacts.items.length ?? 0 }) },
  './use-inspiration-activity': { useInspirationActivity: () => ({ ...activityState, retry: () => { retries++; } }) },
};
const cache = new Map();
const load = file => {
  file = path.resolve('app/manage-ui/src', file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) }
    : stubs[name] ? stubs[name]
      : name.startsWith('.') ? load(path.resolve(path.dirname(file), name) + (fs.existsSync(path.resolve(path.dirname(file), name) + '.tsx') ? '.tsx' : '.ts'))
        : require(name);
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})(require,module,module.exports)`, {
    module, require: localRequire, document: { hidden: false }, window: { setInterval: () => 1, clearInterval() {} },
  });
  cache.set(file, module.exports);
  return module.exports;
};
const RunCard = load('pages/InspirationRunCard.tsx').default;
const execution = { id: 'execution-a', ideaId: 'idea-a', runId: 'run-a', status: 'running', agentId: 'agent-a',
  backendId: 'shoggoth', sessionKey: 'session-a', createdAt: Date.now() - 29000, finishedAt: null, attention: null };
const toolParts = [
  { type: 'toolCall', toolCallId: 'a', toolName: 'read', toolArgs: { path: 'route.md' } },
  { type: 'toolResult', toolCallId: 'a', text: 'ok' },
  { type: 'text', text: 'Checking the walking times' },
];
const activity = (parts, items = []) => ({ runId: 'run-a', trajectory: { parts, reason: null, truncated: false }, artifacts: { items } });
const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.children ? textOf(node.children) : '';
let renderer;
const show = (run, extra = {}) => {
  act(() => { renderer = create(React.createElement(RunCard, { ideaId: 'idea-a', execution: run, agentName: 'Shoggoth', ...extra },
    extra.children)); });
  return renderer;
};
const bar = () => renderer.root.findAllByProps({ 'data-inspiration-detail-bar': true });
const card = () => renderer.root.findAllByProps({ 'data-inspiration-run-card': true });
const request = () => renderer.root.findAllByProps({ 'data-inspiration-run-request': true });

// A running round names its latest step on the black bar, with a live elapsed time.
activityState = { activity: activity(toolParts), error: false, live: true };
show(execution);
assert.equal(bar().length, 1);
assert.equal(card().length, 0, 'the trajectory starts folded');
assert.equal(bar()[0].props['aria-expanded'], 'false');
assert.ok(textOf(bar()[0].children).includes('Checking the walking times'), 'the bar shows the latest live step');
assert.ok(JSON.stringify(renderer.toJSON()).includes('29s') || JSON.stringify(renderer.toJSON()).includes('30s'), 'a live round counts its elapsed seconds');

// Opening swaps the bar for the trajectory card; its header folds it back.
act(() => bar()[0].props.onClick());
assert.equal(bar().length, 0);
assert.equal(card().length, 1);
const timeline = renderer.root.findByProps({ 'data-timeline': true });
assert.equal(timeline.props['data-status'], 'running');
assert.equal(timeline.props['data-follow'], true, 'a live trajectory follows its newest step');
assert.ok(timeline.props['data-rows'] >= 2);
const head = card()[0].findByType('button');
assert.equal(head.props['aria-expanded'], 'true');
act(() => head.props.onClick());
assert.equal(card().length, 0);
assert.equal(bar().length, 1);
act(() => renderer.unmount());

// A successful round hides the live bar even when it recorded a trajectory.
activityState = { activity: activity(toolParts), error: false, live: false };
show({ ...execution, status: 'completed', finishedAt: Date.now() });
assert.equal(bar().length + card().length, 0);
act(() => renderer.unmount());

// Nothing recorded and nothing pending: no empty trajectory to open, but the panel and files remain.
activityState = { activity: activity([], [{ path: '/work/a.html', name: 'a.html' }]), error: false, live: false };
show({ ...execution, status: 'completed', finishedAt: Date.now() }, { children: React.createElement('section', { 'data-panel': true }, 'Result panel') });
assert.equal(bar().length + card().length, 0);
assert.equal(renderer.root.findAllByProps({ 'data-panel': true }).length, 1);
assert.equal(renderer.root.findByProps({ 'data-artifacts': 1 }).props['data-artifacts'], 1, 'artifacts share the card\'s single activity read');
act(() => renderer.unmount());

// A failed or stopped round keeps a red bar naming its status, recorded or not, like the wall's card.
for (const status of ['failed', 'canceled', 'interrupted']) {
  activityState = { activity: activity([]), error: false, live: false };
  show({ ...execution, status, finishedAt: Date.now() });
  assert.equal(bar().length, 1, `${status} rounds keep their bar`);
  assert.equal(bar()[0].props['data-tone'], 'error');
  assert.ok(textOf(bar()[0].children).includes(`inspiration.status.${status === 'canceled' ? 'failed' : status}`));
  act(() => renderer.unmount());
}
activityState = { activity: activity(toolParts), error: false, live: false };
show({ ...execution, status: 'failed', finishedAt: Date.now() });
assert.ok(textOf(bar()[0].children).includes('inspiration.status.failed · turnLab.processSummary'), 'a recorded failure names its status before the summary');
act(() => renderer.unmount());
activityState = { activity: activity(toolParts), error: false, live: true };
show(execution);
assert.equal(bar()[0].props['data-tone'], 'running', 'a running round keeps the black bar');
act(() => renderer.unmount());

// A request takes the top slot; the bar folds beneath it, then the panel, then the files.
activityState = { activity: activity(toolParts, [{ path: '/work/a.html', name: 'a.html' }]), error: false, live: true };
show({ ...execution, status: 'waiting_approval' }, {
  attention: React.createElement('button', { type: 'button', 'data-allow': true }, 'Allow once'),
  children: React.createElement('section', { 'data-panel': true }, 'Panel') });
const order = renderer.toJSON().map(node => node.props['data-inspiration-run-request'] ? 'request'
  : node.props['data-inspiration-detail-bar'] ? 'bar' : node.props['data-panel'] ? 'panel' : node.props['data-artifacts'] !== undefined ? 'artifacts' : '?');
assert.deepEqual(order, ['request', 'bar', 'panel', 'artifacts']);
assert.equal(request()[0].findAllByProps({ 'data-allow': true }).length, 1, 'the request body is the owner\'s own control');
assert.equal(request()[0].children.length, 1, 'the Session\'s prompt card is the whole request, with no extra header');
act(() => renderer.unmount());

// An unreadable trajectory is stated and can be retried from the open card.
activityState = { activity: null, error: true, live: true };
show(execution);
assert.ok(textOf(bar()[0].children).includes('inspiration.activityUnavailable'));
act(() => bar()[0].props.onClick());
assert.ok(textOf(renderer.toJSON()).includes('inspiration.activityUnavailable'));
const retry = renderer.root.findAllByType('button').find(button => textOf(button.children) === 'common.retry');
act(() => retry.props.onClick());
assert.equal(retries, 1);
act(() => renderer.unmount());

console.log('PASS Inspiration run card: folded live bar, trajectory card, completed bar hidden, unrecorded rounds, red failure bars, request ordering and retry');
