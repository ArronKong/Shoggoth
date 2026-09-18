import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import avatarModule from './helpers/load-agent-avatar.cjs';

const root = path.resolve(import.meta.dirname, '..');
const uiRequire = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = uiRequire('typescript');
const React = uiRequire('react');
const { act, create } = uiRequire('react-test-renderer');
const styles = new Proxy({}, { get: (_target, key) => key });
const host = type => props => React.createElement(type, props, props.children);
const load = (file, stubs, globals = {}) => {
  const source = fs.readFileSync(path.join(root, 'app/manage-ui/src', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => name.endsWith('.css') ? { __esModule: true, default: styles } : stubs[name] || uiRequire(name),
    window: { setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    document: { hidden: false }, Error, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => setImmediate(callback), ...globals });
  return module.exports;
};
const t = (key, args) => args?.name ? `${key}:${args.name}` : args?.count ? `${key}:${args.count}` : key;
const PopoverContext = React.createContext(null);
const Popover = {
  Root: props => React.createElement(PopoverContext.Provider, { value: props }, props.children),
  Trigger: props => {
    const context = React.useContext(PopoverContext);
    return React.createElement('button', { ...props, onClick: () => context.onOpenChange(!context.open) });
  },
  Portal: props => React.useContext(PopoverContext).open ? props.children : null,
  Positioner: host('section'), Popup: host('dialog'), Title: host('h2'), Description: host('p'),
};
const runtimeIds = ['shoggoth', 'hermes', 'codex', 'claude-code', 'grok-build', 'deepseek-harness'];
const catalog = runtimeIds.map(id => ({ id, name: id }));
let connectedRuntimeIds = [...runtimeIds];
const agent = (id, backendId = 'shoggoth', execute = true) => ({ id, backendId, name: id, backendName: backendId,
  capabilities: { execute, session: true, respond: true, cancel: true, reason: execute ? null : 'backend-unavailable' } });
let agents = [agent('Maya'), agent('Shoggoth'), agent('Offline', 'shoggoth', false), agent('Maya', 'codex')];
let growth = { settings: { enabled: false, revision: 1, executors: [] }, failures: [], errorCode: null };
let failSave = false;
let holdSave = null;
const writes = [];
const opened = [];
const cache = load('lib/usePageCache.ts', {});
const noticeStorage = new Map();
const localStorage = { getItem: key => noticeStorage.get(key) ?? null, setItem: (key, value) => noticeStorage.set(key, value) };
const loadNoticeBadge = () => load('pages/use-inspiration-notice-badge.ts', {}, { localStorage });
let noticeBadge = loadNoticeBadge();
const Component = load('pages/InspirationAutoGrowth.tsx', {
  'react-i18next': { useTranslation: () => ({ t }) },
  'react-dom': { createPortal: children => children },
  '@base-ui/react/popover': { Popover },
  '../components/BackendTabIcon': load('components/BackendTabIcon.tsx', {}),
  '../components/AgentAvatar': avatarModule,
  '../components/LiquidPill': load('components/LiquidPill.tsx', {}),
  '../components/Field': { Switch: props => React.createElement('button', { role: 'switch',
    'aria-checked': props.checked, disabled: props.disabled, onClick: () => props.onChange(!props.checked) }) },
  '../lib/usePageCache': cache,
  '../lib/backends': { useBackendCatalog: () => catalog },
  './InspirationGrowthIcon': props => React.createElement('i', { 'data-growth-enabled': props.enabled }),
  './use-inspiration-notice-badge': noticeBadge,
  '../api/client': {
    getStatus: async () => catalog.map(item => ({ ...item, connected: connectedRuntimeIds.includes(item.id) })),
    getInspirationAgents: async () => ({ agents: structuredClone(agents) }),
    getInspirationGrowth: async () => structuredClone(growth),
    updateInspirationGrowth: async input => {
      writes.push(structuredClone(input));
      if (holdSave) await new Promise(resolve => { holdSave = resolve; });
      if (failSave) throw new Error('Save failed');
      if (input.expectedRevision !== growth.settings.revision) throw new Error('Revision conflict');
      growth = { ...growth, settings: { enabled: input.enabled, executors: structuredClone(input.executors), revision: input.expectedRevision + 1 } };
      return structuredClone(growth);
    },
  },
}).default;
const settle = async callback => act(async () => { callback?.(); await new Promise(setImmediate); });
const listViewport = { scrollTop: 0, scrollHeight: 312, clientHeight: 232 };
const overviewViewport = { scrollTop: 0, scrollHeight: 24, clientHeight: 24 };
let renderer;
await settle(() => { renderer = create(React.createElement(Component, { noticeTarget: {}, onOpen: id => opened.push(id), onChange: async () => {} }), {
  createNodeMock: element => element.props.id === 'inspiration-growth-executors' ? listViewport
    : element.props.id === 'inspiration-growth-active-executors' ? overviewViewport : null,
}); });
const isActive = node => {
  for (let ancestor = node; ancestor; ancestor = ancestor.parent) if (ancestor.props['aria-hidden'] === true) return false;
  return true;
};
const find = label => renderer.root.findAllByType('button').find(node => isActive(node) && node.props['aria-label'] === label);
const trigger = () => find('inspiration.growth.title');
const add = () => find('inspiration.growth.addAgent');
const confirm = () => find('inspiration.growth.confirmAgents');
const rows = () => renderer.root.findAllByProps({ role: 'checkbox' }).filter(isActive);
const checked = () => rows().filter(node => node.props['aria-checked']);
const back = () => renderer.root.findByProps({ className: 'back' });
const toggle = () => renderer.root.findByProps({ role: 'switch' });
const click = node => settle(() => node.props.onClick());
const selectedCount = count => renderer.root.findByProps({ 'aria-label': `inspiration.growth.selectedCount:${count}` });

assert.equal(renderer.root.findAllByType('dialog').length, 0);
assert.equal(renderer.root.findByType('i').props['data-growth-enabled'], false, 'Disabled nurture keeps a static icon');
await click(trigger());
assert.equal(toggle().props.disabled, true);
assert.equal(rows().length, 0, 'The first page contains no selection form');
assert.equal(renderer.root.findByProps({ 'data-page': 'picker' }).props.inert, '', 'The inactive picker cannot receive focus or clicks');
await click(add());
assert.equal(renderer.root.findByProps({ 'data-page': 'overview' }).props.inert, '', 'The fading overview cannot receive focus or clicks');
assert.equal(renderer.root.findByProps({ 'data-page': 'picker' }).props.inert, undefined);
assert.equal(rows().length, 3);
const scrollList = () => renderer.root.findByProps({ id: 'inspiration-growth-executors' });
assert.equal(scrollList().props['data-scrolled'], undefined, 'Top row stays clear before scrolling');
assert.equal(scrollList().props['data-more'], true);
await settle(() => { listViewport.scrollTop = 40; scrollList().props.onScroll(); });
assert.equal(scrollList().props['data-scrolled'], true, 'Scrolling reveals the top fade');
assert.equal(scrollList().props['data-more'], true, 'Both edges fade in the middle of the list');
await settle(() => { listViewport.scrollTop = 80; scrollList().props.onScroll(); });
assert.equal(scrollList().props['data-more'], undefined, 'The final row stays clear at the bottom');
assert.equal(rows().find(node => node.props['aria-label'].includes('Offline')).props.disabled, true);
await click(find('Maya · shoggoth'));
await click(find('Shoggoth · shoggoth'));
await click(find('codex'));
assert.equal(listViewport.scrollTop, 0, 'Changing runtimes resets the scroll position');
assert.equal(scrollList().props['data-scrolled'], undefined, 'Changing runtimes also clears the top fade');
assert.equal(rows().length, 1, 'Runtime filters scope the visible list');
await click(find('Maya · codex'));
assert.ok(selectedCount(3));
await click(find('shoggoth'));
assert.equal(checked().length, 2, 'Cross-runtime selections survive filtering');
await click(back());
assert.equal(writes.length, 0, 'Back discards unconfirmed selection');
assert.equal(toggle().props.disabled, true);
assert.ok(selectedCount(3), 'The fading picker keeps its selection count until it exits');
assert.equal(renderer.root.findAllByProps({ role: 'checkbox', 'aria-checked': true }).length, 2,
  'Selected rows stay painted while the picker fades out');

await click(add());
assert.equal(checked().length, 0, 'Reopening discards the cancelled draft and restores saved selections');
await click(find('Maya · shoggoth'));
await click(confirm());
assert.deepEqual(growth.settings.executors, [{ agentId: 'Maya', backendId: 'shoggoth' }]);
assert.equal(growth.settings.enabled, false, 'Adding an Agent does not start assignments');
assert.equal(renderer.root.findAllByType('dialog').length, 1, 'Saving returns to the open overview');
const overviewList = () => renderer.root.findByProps({ id: 'inspiration-growth-active-executors' });
assert.equal(overviewList().props['data-scrolled'], undefined);
assert.equal(overviewList().props['data-more'], undefined, 'An overview that fits has no faded edges');
await settle(() => {
  overviewViewport.clientHeight = 278; overviewViewport.scrollHeight = 384;
  overviewList().props.onScroll();
});
assert.equal(overviewList().props['data-more'], true, 'A long overview uses the same bottom fade as the picker');
await settle(() => { overviewViewport.scrollTop = 53; overviewList().props.onScroll(); });
assert.equal(overviewList().props['data-scrolled'], true);
assert.equal(overviewList().props['data-more'], true, 'Both overview edges fade between the list ends');
await settle(() => { overviewViewport.scrollTop = 106; overviewList().props.onScroll(); });
assert.equal(overviewList().props['data-more'], undefined, 'The final overview row stays fully visible');
overviewViewport.clientHeight = 24; overviewViewport.scrollHeight = 24; overviewViewport.scrollTop = 0;
await click(toggle());
assert.equal(growth.settings.enabled, true);
assert.equal(renderer.root.findByType('i').props['data-growth-enabled'], true, 'The cycle starts only after enabling succeeds');
await click(add());
assert.equal(scrollList().props['data-scrolled'], undefined, 'Overview scrolling does not leak into the picker');
await click(find('codex'));
await click(find('Maya · codex'));
await click(confirm());
assert.equal(growth.settings.executors.length, 2, 'Identical Agent names in different runtimes remain distinct');
assert.equal(growth.settings.enabled, true);
await click(find('inspiration.growth.removeAgent:Maya'));
assert.equal(growth.settings.executors.length, 1);
await click(find('inspiration.growth.removeAgent:Maya'));
assert.equal(growth.settings.executors.length, 0);
assert.equal(growth.settings.enabled, false, 'Removing the last Agent also turns nurture off');
assert.equal(renderer.root.findByType('i').props['data-growth-enabled'], false, 'Removing the last Agent stops the cycle');

await click(add());
await click(find('Maya · shoggoth'));
failSave = true;
await click(confirm());
assert.equal(checked().length, 1, 'Failed saves retain the draft');
assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), 'Save failed');
assert.equal(growth.settings.executors.length, 0);
failSave = false;
await click(confirm());
assert.equal(growth.settings.executors.length, 1);
failSave = true;
await click(toggle());
assert.equal(renderer.root.findByType('i').props['data-growth-enabled'], false, 'A failed enable request never starts the cycle');
failSave = false;

await click(add());
await click(find('Shoggoth · shoggoth'));
growth = { ...growth, settings: { revision: growth.settings.revision + 1, enabled: false,
  executors: [{ agentId: 'Maya', backendId: 'codex' }] } };
await click(confirm());
assert.equal(confirm().props.disabled, true, 'A revision conflict must not overwrite another edit');
assert.ok(selectedCount(2), 'Conflicting draft is retained until the user reloads it');
await click(renderer.root.findAllByType('button').find(node => node.children.includes('inspiration.growth.refreshSelection')));
assert.equal(confirm().props.disabled, false);
await click(find('codex'));
assert.equal(checked().length, 1);
await click(confirm());

const previousWrites = writes.length;
holdSave = true;
const handler = toggle().props.onClick;
await settle(() => { handler(); handler(); });
assert.equal(writes.length, previousWrites + 1, 'Rapid repeat actions create a single save');
assert.equal(toggle().props.disabled, true);
await click(trigger());
assert.equal(renderer.root.findAllByType('dialog').length, 1, 'An in-flight save cannot be dismissed and reopened with stale state');
const release = holdSave; holdSave = null;
await settle(release);
assert.equal(growth.settings.enabled, true);

await click(trigger());
agents = [...agents, agent('External', 'custom-runtime')];
growth = { ...growth, settings: { revision: growth.settings.revision + 1, enabled: false,
  executors: [{ agentId: 'Missing', backendId: 'custom-runtime' }] },
  failures: [{ ideaId: 'idea-1', title: 'Needs help', attempts: 2, errorCode: 'INSPIRATION_FAILED' }] };
await click(trigger());
assert.ok(find('inspiration.growth.removeAgent:Missing'), 'Unavailable saved executors stay removable');
await click(add());
await click(find('custom-runtime'));
assert.equal(rows().length, 2, 'New runtimes and missing saved Agents remain discoverable');
await click(back());
assert.equal(renderer.root.findAllByProps({ id: 'inspiration-growth-alert' }).length, 0, 'Auto Nurture no longer carries the failure badge');
assert.ok(!JSON.stringify(renderer.toJSON()).includes('Needs help'), 'Failed ideas are no longer inside Auto Nurture settings');
assert.equal(renderer.root.findByProps({ 'data-inspiration-notices-badge': true }).children.join(''), '1');
await click(find('inspiration.growth.needsYou'));
assert.equal(renderer.root.findAllByType('dialog').length, 1, 'The dedicated notices button closes settings and opens its own popup');
assert.equal(renderer.root.findAllByProps({ 'data-inspiration-notices-badge': true }).length, 0, 'Opening notices clears the unread badge immediately');
await click(renderer.root.findAllByType('button').find(node => node.findAllByType('span').some(span => span.children.includes('Needs help'))));
assert.deepEqual(opened, ['idea-1']);
assert.equal(renderer.root.findAllByType('dialog').length, 0);

connectedRuntimeIds = ['shoggoth'];
agents = [agent('Only Agent')];
growth = { settings: { revision: growth.settings.revision + 1, enabled: false, executors: [] }, failures: [], errorCode: null };
await click(trigger());
await click(add());
const runtimeTabs = () => renderer.root.findAllByProps({ 'aria-label': 'inspiration.growth.filterBackend' }).filter(isActive);
assert.equal(runtimeTabs().length, 0, 'Supported but disconnected backends do not create runtime tabs');
assert.equal(rows().length, 1);
assert.equal(renderer.root.findByProps({ 'data-page': 'picker' }).props['data-layout'], 'single-agent');
await click(find('Only Agent · shoggoth'));
await click(confirm());
assert.equal(growth.settings.executors[0].agentId, 'Only Agent', 'The compact picker still saves selections');

await click(trigger());
agents.push(agent('Second Agent'));
await click(trigger());
await click(add());
assert.equal(runtimeTabs().length, 0);
assert.equal(rows().length, 2);
assert.equal(renderer.root.findByProps({ 'data-page': 'picker' }).props['data-layout'], 'single-runtime');
await click(back());
await click(trigger());
agents = Array.from({ length: 9 }, (_, index) => agent(index === 0 ? 'Only Agent' : `Agent ${index + 1}`));
await click(trigger());
await click(add());
assert.equal(runtimeTabs().length, 0, 'Many agents in one backend still use a single list');
assert.equal(rows().length, 9);

await click(back());
await click(trigger());
connectedRuntimeIds = ['shoggoth', 'codex'];
await click(trigger());
await click(add());
assert.equal(runtimeTabs().length, 1, 'A second connected backend restores runtime tabs');
await click(find('codex'));
assert.equal(rows().length, 0, 'A connected backend with no agents remains reachable');
assert.ok(renderer.root.findAllByProps({ role: 'status' }).some(node => node.children.includes('inspiration.growth.noBackendAgents')));
await click(back());
await click(trigger());
connectedRuntimeIds = ['shoggoth'];
growth.settings = { ...growth.settings, revision: growth.settings.revision + 1,
  executors: [{ agentId: 'Offline saved agent', backendId: 'codex' }] };
await click(trigger());
await click(add());
assert.equal(runtimeTabs().length, 0, 'A saved offline executor does not create a tab for a disconnected backend');
assert.ok(find('Offline saved agent · codex · inspiration.unavailable'), 'Saved offline executors remain removable in the direct list');
act(() => renderer.unmount());

let noticeState;
const NoticeProbe = ({ failures, open = false }) => {
  noticeState = noticeBadge.useInspirationNoticeBadge(failures, open);
  return React.createElement('span', null, noticeState.unreadCount);
};
const failure = (ideaId, runId = `${ideaId}-run`) => ({ ideaId, runId, title: ideaId, attempts: 2, errorCode: 'FAILED' });
let failures = [failure('unread-a'), failure('unread-b')];
await settle(() => { renderer = create(React.createElement(NoticeProbe, { failures })); });
assert.equal(noticeState.unreadCount, 2);
await settle(() => noticeState.markRead());
assert.equal(noticeState.unreadCount, 0);
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures: [...failures].reverse().map(item => ({ ...item, title: 'Renamed' })) })));
assert.equal(noticeState.unreadCount, 0, 'Reordering, renaming, and polling do not make the same errors unread again');
failures = [failures[0], failure('unread-c')];
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures })));
assert.equal(noticeState.unreadCount, 1, 'A new error is detected even if the total count stays the same');
await settle(() => noticeState.markRead());
failures = [failure('unread-a', 'retried-run'), failures[1]];
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures })));
assert.equal(noticeState.unreadCount, 1, 'A new failed run on the same idea is unread');
await settle(() => noticeState.markRead());
failures = [{ ...failures[0], errorCode: 'DIFFERENT_ERROR' }, failures[1]];
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures })));
assert.equal(noticeState.unreadCount, 1, 'New error details are unread even on the same run');
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures, open: true })));
assert.equal(noticeState.unreadCount, 0);
failures = [...failures, failure('unread-d')];
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures, open: true })));
await settle(() => renderer.update(React.createElement(NoticeProbe, { failures })));
assert.equal(noticeState.unreadCount, 0, 'Refresh results displayed in an open popup are already read');
act(() => renderer.unmount());
noticeBadge = loadNoticeBadge();
await settle(() => { renderer = create(React.createElement(NoticeProbe, { failures })); });
assert.equal(noticeState.unreadCount, 0, 'Read receipts survive a fresh module and page mount');
for (const count of [9, 19, 100, 1000]) {
  await settle(() => renderer.update(React.createElement(NoticeProbe, {
    failures: Array.from({ length: count }, (_, index) => failure(`size-${count}-${index}`)),
  })));
  assert.equal(noticeState.unreadCount, count, 'Badge counts keep all digits');
}
const saveNotice = localStorage.setItem;
localStorage.setItem = () => { throw new Error('Storage unavailable'); };
await settle(() => noticeState.markRead());
assert.equal(noticeState.unreadCount, 0, 'Unavailable persistence never prevents clearing the visible badge');
localStorage.setItem = saveNotice;
act(() => renderer.unmount());

const visibilityListeners = new Set();
const iconDocument = { hidden: false,
  addEventListener: (event, listener) => { if (event === 'visibilitychange') visibilityListeners.add(listener); },
  removeEventListener: (event, listener) => { if (event === 'visibilitychange') visibilityListeners.delete(listener); },
};
const GrowthIcon = load('pages/InspirationGrowthIcon.tsx', {}, { document: iconDocument }).default;
await settle(() => { renderer = create(React.createElement(GrowthIcon, { enabled: false })); });
const cycle = () => renderer.root.findByType('svg');
assert.equal(cycle().props['data-growing'], false);
assert.equal(visibilityListeners.size, 0, 'The resting icon needs no visibility listener');
await settle(() => { renderer.update(React.createElement(GrowthIcon, { enabled: true })); });
assert.equal(cycle().props['data-growing'], true);
assert.equal(cycle().props['data-paused'], false);
assert.equal(visibilityListeners.size, 1);
await settle(() => { iconDocument.hidden = true; visibilityListeners.forEach(listener => listener()); });
assert.equal(cycle().props['data-paused'], true, 'Background tabs pause the cycle');
await settle(() => { iconDocument.hidden = false; visibilityListeners.forEach(listener => listener()); });
assert.equal(cycle().props['data-paused'], false, 'Returning to the page resumes the same cycle');
await settle(() => { renderer.update(React.createElement(GrowthIcon, { enabled: false })); });
assert.equal(cycle().props['data-growing'], false);
assert.equal(visibilityListeners.size, 0, 'Disabling removes the listener and stops the cycle');
act(() => renderer.unmount());

const Search = load('components/SearchCapsule.tsx', {}).default;
let query = '';
function SearchFixture() {
  const [value, setValue] = React.useState('');
  return React.createElement(Search, { value, collapsible: true, ariaLabel: 'Search seeds', onChange: next => { query = next; setValue(next); } });
}
await settle(() => { renderer = create(React.createElement(SearchFixture)); });
assert.equal(renderer.root.findAllByType('input').length, 0);
await click(renderer.root.findByType('button'));
assert.equal(renderer.root.findByType('input').props.autoFocus, true);
await settle(() => renderer.root.findByType('input').props.onChange({ target: { value: 'seed' } }));
await settle(() => renderer.root.findByType('input').props.onBlur({ currentTarget: {}, relatedTarget: null }));
assert.equal(query, 'seed');
assert.equal(renderer.root.findAllByType('input').length, 1, 'A non-empty search stays visible after blur');
await settle(() => renderer.root.findByType('input').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
assert.equal(query, '');
assert.equal(renderer.root.findAllByType('input').length, 0);
act(() => renderer.unmount());
await settle(() => { renderer = create(React.createElement(Search, { value: '', onChange() {}, ariaLabel: 'Other page search' })); });
assert.equal(renderer.root.findAllByType('input').length, 1, 'Existing pages retain the expanded search by default');
act(() => renderer.unmount());
console.log('PASS Auto Nurture UI: single/multiple connected backends, 1/2/9 agents, inactive-page isolation, both list fades, add/back, multiselect, confirm, switch, remove, unavailable agents, failures, stale revisions, busy guard and search');
