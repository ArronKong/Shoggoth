import assert from 'node:assert/strict';
import avatarModule from './helpers/load-agent-avatar.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
const statusModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/dashboard/activityStatusRows.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: statusModule.exports });
const source = fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/dashboard/ActivityFeed.tsx'), 'utf8');
const requests = [], opened = [];
const empty = { items: [], hasMore: false, degradedSources: [] };
let fetchPage = async () => empty;
let savedKindFilter;
const host = type => props => React.createElement(type, props, props.children);
const stubs = {
  'react-i18next': { useTranslation: () => ({ t: key => key }) },
  '../../api/client': { getDashboardActivities: async params => { requests.push(params); return fetchPage(params); } },
  '../../components/BackendBadge': host('badge'),
  '../../components/BackendTabIcon': { __esModule: true, default: host('backend-icon'), sortBackendTabs: items => [...items] },
  '../../components/FilterTabs': host('filters'),
  '../../components/FusionLoader': host('loader'),
  '../../components/AgentAvatar': avatarModule,
  './ApprovalRow': host('approval-row'),
  './activityStatusRows': statusModule.exports,
  '../../lib/useStickyState': { useStickyState: (key, initial) => React.useState(key === 'dashboard.kindFilter' ? savedKindFilter ?? initial : initial) },
  '../usage/charts': { fmtMs: String },
};
const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true,
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`,
  { module: mod, require: name => stubs[name] || require(name) });
const Feed = mod.exports.default;
const inspiration = { id: 'inspiration:run', backendId: 'native', kind: 'inspiration', agentId: 'agent',
  occurredAt: 200, title: '灵感动态', severity: 'info', inspiration: { ideaId: 'idea', runId: 'run', status: 'running' } };
const cron = { id: 'cron:run', backendId: 'native', kind: 'cron', occurredAt: 100,
  title: '定时动态', severity: 'success', run: {} };
const heartbeat = ['heartbeat wake requested', 'heartbeat completed', 'heartbeat task completed',
  'heartbeat failed: agent-runner-failure', 'heartbeat skipped: active-hours'].map((message, i) => ({
  ...cron, id: `heartbeat:${i}`, backendId: 'openclaw', title: 'heartbeat-vincent', summary: message,
  run: { backendId: 'openclaw', jobId: 'openclaw:hb', jobName: 'heartbeat-vincent', error: message },
}));
const firstPage = { ...empty, items: [inspiration, cron, ...heartbeat] };
const props = { status: [{ id: 'native', connected: true }, { id: 'other', connected: true }], firstPage,
  sinceMs: 0, running: [], getAgentDisplayName: id => id,
  onOpenRun: row => opened.push(row.kind), onOpenTask: row => opened.push(row.kind),
  onOpenInspiration: row => opened.push(row.inspiration.ideaId), onOpenHealth: () => opened.push('health') };
const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : textOf(node?.children || []);
const rows = renderer => renderer.root.findAll(node => node.type === 'button' && node.props.className === 'dash-run');
const tabs = renderer => renderer.root.findAllByType('filters').find(node => node.props.className === 'dash-kind-tabs');
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });

let renderer;
await settle(() => { renderer = create(React.createElement(Feed, props)); });
assert.ok(tabs(renderer).props.items.some(item => item.value === 'inspiration' && item.label === 'dashboard.filterInspiration'));
assert.equal(rows(renderer).length, 2);
assert.doesNotMatch(textOf(renderer.toJSON()), /heartbeat-vincent/, 'Cached heartbeat rows must be hidden on the first render');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '2', 'Feed count excludes heartbeat rows');
const approvals = [{ id: 'pending', backendId: 'native', runId: 'run', requestId: 'request', agentId: 'agent' }];
const onApprovalResponded = async () => {};
await settle(() => renderer.update(React.createElement(Feed, { ...props, approvals, onApprovalResponded,
  canRespondToApproval: () => true, onOpenApprovalRun: item => opened.push(item.id) })));
const approvalRow = renderer.root.findByType('approval-row');
assert.equal(approvalRow.props.item, approvals[0], 'Inline approval retains the full owning request');
assert.equal(approvalRow.props.onResponded, onApprovalResponded);
assert.equal(approvalRow.props.canRespond, true);
assert.ok(renderer.root.findByProps({ className: 'dash-activity-scroll' }).findByType('approval-row'),
  'Approvals share the activity scroll area, so expanded content stays reachable');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '2', 'Pending attention does not inflate activity history counts');
await settle(() => approvalRow.props.onOpenRun());
assert.equal(opened.pop(), 'pending');
const runningTask = { id: 'native:run', backendId: 'native', runId: 'run', kind: 'inspiration', status: 'running', agentId: 'agent' };
await settle(() => renderer.update(React.createElement(Feed, { ...props, running: [runningTask] })));
assert.equal(renderer.root.findByType('approval-row'), approvalRow, 'Resolving approval keeps the same run component mounted');
assert.equal(approvalRow.props.running, runningTask);
assert.equal(approvalRow.props.item, undefined);
await settle(() => renderer.update(React.createElement(Feed, { ...props, running: [runningTask], approvals })));
assert.equal(renderer.root.findAllByType('approval-row').length, 1, 'A running task awaiting approval must not render a second row');
assert.equal(renderer.root.findByType('approval-row'), approvalRow, 'A second approval changes the original row in place');
await settle(() => renderer.update(React.createElement(Feed, { ...props, running: [] })));
assert.equal(renderer.root.findAllByType('approval-row').length, 0, 'Finished tasks leave the live status list');
await settle(() => rows(renderer)[0].props.onClick());
assert.deepEqual(opened, ['idea'], 'Inspiration rows open their detail instead of System settings');

fetchPage = async () => ({ ...empty, items: [inspiration] });
await settle(() => tabs(renderer).props.onChange('inspiration'));
assert.equal(requests.at(-1).kind, 'inspiration');
assert.equal(rows(renderer).length, 1);
assert.match(textOf(renderer.toJSON()), /inspiration.status.running/);
const completed = { ...inspiration, summary: '**本轮成果**', severity: 'success',
  inspiration: { ...inspiration.inspiration, status: 'completed' } };
fetchPage = async () => ({ ...empty, items: [completed] });
await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: { ...firstPage } })));
assert.equal(rows(renderer).length, 1);
assert.match(textOf(renderer.toJSON()), /inspiration.status.completed · 本轮成果/);
await settle(() => renderer.root.findAllByType('filters').find(node => node.props.className === 'dash-backend-tabs').props.onChange('native'));
assert.equal(requests.at(-1).backend, 'native');
assert.equal(requests.at(-1).kind, 'inspiration');
fetchPage = async () => ({ ...empty, items: heartbeat });
await settle(() => tabs(renderer).props.onChange('cron'));
assert.equal(rows(renderer).length, 0);
assert.match(textOf(renderer.toJSON()), /dashboard.feedEmpty/);
await settle(() => renderer.unmount());

const heartbeatReport = { ...cron, id: 'user:heartbeat', backendId: 'openclaw', title: 'heartbeat-report',
  run: { backendId: 'openclaw', jobId: 'openclaw:user', jobName: 'heartbeat-report', summary: 'service is healthy' } };
fetchPage = async () => ({ ...empty, items: [...heartbeat, heartbeatReport] });
await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: {
  ...empty, items: heartbeat, hasMore: true, nextCursor: 'older-tasks',
} })); });
assert.equal(rows(renderer).length, 1, 'Pagination must pass hidden heartbeat rows to reach ordinary tasks');
assert.match(textOf(renderer.toJSON()), /heartbeat-report/, 'A user task mentioning heartbeat remains visible');
await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: { ...firstPage } })));
assert.equal(rows(renderer).length, 3, 'Refresh merges visible tasks while continuing to hide heartbeat');
assert.doesNotMatch(textOf(renderer.toJSON()), /heartbeat-vincent/);
await settle(() => renderer.unmount());

savedKindFilter = 'kanban';
const beforeLegacyFilter = requests.length;
await settle(() => { renderer = create(React.createElement(Feed, props)); });
assert.equal(tabs(renderer).props.value, '', 'A saved hidden filter must return to All');
assert.equal(requests.length, beforeLegacyFilter, 'A saved hidden filter must not request an invisible category');
assert.equal(rows(renderer).length, 2);
await settle(() => renderer.unmount());
savedKindFilter = undefined;

let resolveOldPage;
const oldPage = new Promise(resolve => { resolveOldPage = resolve; });
fetchPage = async params => params.cursor ? oldPage : params.kind === 'inspiration'
  ? { ...empty, items: [inspiration], hasMore: true, nextCursor: 'older-inspiration' }
  : { ...empty, items: [cron] };
await settle(() => { renderer = create(React.createElement(Feed, props)); });
await settle(() => tabs(renderer).props.onChange('inspiration'));
assert.equal(requests.at(-1).cursor, 'older-inspiration');
await settle(() => tabs(renderer).props.onChange('cron'));
await settle(() => resolveOldPage({ ...empty, items: [{ ...inspiration, id: 'older' }] }));
assert.equal(rows(renderer).length, 1);
assert.match(textOf(rows(renderer)[0]), /定时动态/);
await settle(() => renderer.unmount());

const beforeFailure = requests.length;
fetchPage = async params => {
  if (params.cursor) throw new Error('Page unavailable');
  return { ...empty, items: [inspiration], hasMore: true, nextCursor: 'failed-page' };
};
await settle(() => { renderer = create(React.createElement(Feed, props)); });
await settle(() => tabs(renderer).props.onChange('inspiration'));
await settle();
assert.equal(requests.length - beforeFailure, 2, 'Pagination errors must not cause an automatic retry loop');
assert.match(textOf(renderer.toJSON()), /dashboard.activityFetchFailed/);
await settle(() => renderer.unmount());
console.log('PASS Dashboard Inspiration filter, detail callback, refresh, backend scope, empty state, stale-page isolation and bounded failure');
