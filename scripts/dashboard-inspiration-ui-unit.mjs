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
const dreaming = { ...cron, id: 'system:dreaming', backendId: 'openclaw', title: 'Memory Dreaming Promotion',
  run: { backendId: 'openclaw', jobId: 'openclaw:dreaming', systemManaged: true, summary: 'NO_REPLY' } };
const firstPage = { ...empty, items: [inspiration, cron, dreaming, ...heartbeat] };
const props = { status: [{ id: 'native', connected: true }, { id: 'other', connected: true }, { id: 'openclaw', connected: true }], firstPage,
  sinceMs: 0, running: [], getAgentDisplayName: id => id,
  onOpenRun: row => opened.push(row.kind), onOpenTask: row => opened.push(row.kind),
  onOpenInspiration: row => opened.push(row.inspiration.ideaId), onOpenHealth: () => opened.push('health') };
const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : textOf(node?.children || []);
const rows = renderer => renderer.root.findAll(node => node.type === 'button' && node.props.className === 'dash-run');
const tabs = renderer => renderer.root.findAllByType('filters').find(node => node.props.className === 'dash-kind-tabs');
const settle = async fn => act(async () => { fn?.(); await new Promise(setImmediate); });

let renderer;
// Reproduce the screenshot: two executions of the same monitor, only one report.
const silentCron = { ...cron, id: 'silent-monitor', title: 'Tibo 额度重置监测',
  run: { backendId: 'native', jobId: 'monitor', runId: 'silent', status: 'ok', outputDisposition: 'silent' } };
const monitorReport = { ...silentCron, id: 'monitor-report', summary: '额度重置已生效',
  run: { ...silentCron.run, runId: 'report', outputDisposition: 'deliver' } };
const silentPage = { ...empty, items: [monitorReport, inspiration, silentCron] };
await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: silentPage })); });
assert.equal(rows(renderer).length, 2, 'Cached silent executions must be hidden without hiding the same task’s report');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '2', 'Visible rows and activity count agree');
assert.match(textOf(renderer.toJSON()), /额度重置已生效/);
fetchPage = async () => ({ ...empty, items: [silentCron, monitorReport] });
await settle(() => tabs(renderer).props.onChange('cron'));
assert.equal(rows(renderer).length, 1, 'Task-filter responses from older servers also hide silent output');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '1');
await settle(() => renderer.unmount());
fetchPage = async () => ({ ...empty, items: [silentCron, monitorReport] });
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [silentCron], hasMore: true, nextCursor: 'after-silent' },
})); });
assert.equal(rows(renderer).length, 1, 'An all-silent page still loads the next page and reaches real output');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '1');
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [silentCron] },
})));
assert.equal(rows(renderer).length, 0);
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '0');
assert.match(textOf(renderer.toJSON()), /dashboard.feedEmpty/);
await settle(() => renderer.unmount());
fetchPage = async () => empty;

await settle(() => { renderer = create(React.createElement(Feed, props)); });
assert.ok(tabs(renderer).props.items.some(item => item.value === 'inspiration' && item.label === 'dashboard.filterInspiration'));
assert.equal(rows(renderer).length, 2);
assert.doesNotMatch(textOf(renderer.toJSON()), /heartbeat-vincent/, 'Cached heartbeat rows must be hidden on the first render');
assert.doesNotMatch(textOf(renderer.toJSON()), /Memory Dreaming Promotion/, 'System memory maintenance must be hidden');
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
assert.equal(rows(renderer).length, 2, 'A complete refresh replaces superseded rows while continuing to hide heartbeat');
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

const disconnectedStatus = props.status.map(row => row.id === 'native' ? row : { ...row, disabled: true, connected: false });
const staleFirstPage = { ...empty, items: [inspiration, heartbeatReport] };
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  status: disconnectedStatus, firstPage: staleFirstPage,
  running: [{ id: 'old-live', backendId: 'openclaw' }], approvals: [{ id: 'old-approval', backendId: 'openclaw' }],
})); });
assert.equal(rows(renderer).length, 1, 'Cached activities from disconnected backends are hidden on entry');
assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '1');
assert.equal(renderer.root.findAllByType('approval-row').length, 0, 'Disconnected live work and approvals stay hidden');
await settle(() => renderer.unmount());

let resolveDisconnectedPage;
fetchPage = async () => new Promise(resolve => { resolveDisconnectedPage = resolve; });
await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: {
  ...staleFirstPage, hasMore: true, nextCursor: 'all-backends-page',
} })); });
assert.equal(rows(renderer).length, 2);
await settle(() => renderer.update(React.createElement(Feed, { ...props, status: disconnectedStatus,
  firstPage: { ...empty, items: [inspiration] },
})));
assert.equal(rows(renderer).length, 1, 'Disconnect drops previously merged history');
await settle(() => resolveDisconnectedPage({ ...empty, items: [{ ...heartbeatReport, id: 'late-old-page' },
  { ...cron, id: 'stale-native-page', title: 'stale scoped pagination' }] }));
assert.equal(rows(renderer).length, 1, 'In-flight pages from the previous backend scope are discarded in full');
fetchPage = async () => empty;
await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: { ...empty, items: [inspiration, cron] } })));
assert.equal(rows(renderer).length, 2, 'Reconnect uses the fresh first page instead of resurrecting disconnected history');
await settle(() => renderer.root.findAllByType('filters').find(node => node.props.className === 'dash-backend-tabs').props.onChange('openclaw'));
const requestsBeforeDisconnect = requests.length;
await settle(() => renderer.update(React.createElement(Feed, { ...props, status: disconnectedStatus,
  firstPage: { ...empty, items: [inspiration] },
})));
assert.equal(rows(renderer).length, 1, 'Disconnecting the selected backend resets its hidden filter to All');
assert.ok(requests.slice(requestsBeforeDisconnect).every(request => request.backend !== 'openclaw'));
await settle(() => renderer.unmount());

// A queued execution initially uses its admission timestamp. Starting it fills
// startedAt, so older servers/caches supply a different activity id for the same run.
const pendingCron = { ...cron, id: 'cron:native:daily:100:execution', occurredAt: 100,
  run: { backendId: 'native', jobId: 'daily', runId: 'execution', startedAt: 100, status: 'running' } };
const startedCron = { ...pendingCron, id: 'cron:native:daily:150:execution', occurredAt: 150,
  run: { ...pendingCron.run, startedAt: 150 } };
const completedCron = { ...startedCron, id: 'cron:native:daily:run:execution', occurredAt: 200,
  summary: 'current result', severity: 'success', run: { ...startedCron.run, finishedAt: 200, status: 'ok' } };
fetchPage = async () => empty;
await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: { ...empty, items: [pendingCron] } })); });
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [startedCron], degradedSources: [{ backend: 'other', source: 'cron', reason: 'error' }] },
})));
assert.equal(rows(renderer).length, 1, 'A changed start timestamp must update the same execution even in a partial snapshot');
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [completedCron] },
})));
assert.equal(rows(renderer).length, 1, 'A current canonical id replaces legacy cached ids');
assert.match(textOf(rows(renderer)[0]), /current result/);
const secondExecution = { ...completedCron, id: 'second', run: { ...completedCron.run, runId: 'execution-2' } };
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [completedCron, secondExecution] },
})));
assert.equal(rows(renderer).length, 2, 'Identical titles, results and times do not merge distinct executions');
await settle(() => renderer.unmount());

// Hermes can switch between the durable ledger and its session-backed fallback.
// Both describe the same run, with different start stamps and optional runId.
const sessionCron = { ...cron, id: 'cron:native:daily:150:', occurredAt: 200,
  run: { backendId: 'native', jobId: 'daily', sessionKey: 'cron-daily-session', startedAt: 150, finishedAt: 200, status: 'ok' } };
const ledgerCron = { ...sessionCron, id: 'cron:native:daily:run:ledger-run',
  run: { ...sessionCron.run, runId: 'ledger-run', runIdAliases: [sessionCron.run.sessionKey], startedAt: 100 } };
const partialPage = items => ({ ...empty, items, degradedSources: [{ backend: 'native', source: 'cron', reason: 'latest-only' }] });
for (const [before, after] of [[ledgerCron, sessionCron], [sessionCron, ledgerCron]]) {
  await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: partialPage([before]) })); });
  await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: partialPage([after]) })));
  assert.equal(rows(renderer).length, 1, 'Ledger/session fallback switching must update one activity in either direction');
  assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '1');
  await settle(() => renderer.update(React.createElement(Feed, { ...props,
    firstPage: partialPage([{ ...after, id: `${after.id}:refresh`, run: { ...after.run, startedAt: 175 } }]),
  })));
  assert.equal(rows(renderer).length, 1, 'A later legacy refresh retains the previously proven identity and aliases');
  await settle(() => renderer.unmount());
}
const identifiedSessionCron = { ...sessionCron, id: 'cron:native:daily:run:cron-daily-session',
  run: { ...sessionCron.run, runId: sessionCron.run.sessionKey, runIdAliases: [sessionCron.run.sessionKey] } };
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  firstPage: partialPage([ledgerCron, sessionCron, identifiedSessionCron]),
})); });
assert.equal(rows(renderer).length, 1, 'Cached session aliases and the durable execution collapse on the first render');
const sharedSessionRun = { ...ledgerCron, id: 'second-ledger-run', run: { ...ledgerCron.run, runId: 'second-ledger-run' } };
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [ledgerCron, sharedSessionRun] },
})));
assert.equal(rows(renderer).length, 2, 'Two durable executions in the same session remain distinct');
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: partialPage([ledgerCron, sharedSessionRun, sessionCron]),
})));
assert.equal(rows(renderer).length, 3, 'An ambiguous legacy session cannot be assigned to an arbitrary execution');
const otherJobSession = { ...identifiedSessionCron, id: 'other-job', run: { ...identifiedSessionCron.run, jobId: 'other-job' } };
const otherBackendSession = { ...identifiedSessionCron, id: 'other-backend', backendId: 'other',
  run: { ...identifiedSessionCron.run, backendId: 'other' } };
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [identifiedSessionCron, otherJobSession, otherBackendSession] },
})));
assert.equal(rows(renderer).length, 3, 'Session aliases are scoped to their backend and job');
await settle(() => renderer.unmount());

const sharedConversation = { ...ledgerCron, run: { ...ledgerCron.run, runIdAliases: undefined } };
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  firstPage: partialPage([sharedConversation, sessionCron, { ...sessionCron, id: 'another-legacy-run',
    run: { ...sessionCron.run, startedAt: 50 } }]),
})); });
assert.equal(rows(renderer).length, 3, 'A shared conversation is not an execution alias without backend proof');
await settle(() => renderer.unmount());

const dailyTasks = Array.from({ length: 4 }, (_, i) => ({ ...ledgerCron, id: `daily-${i}`,
  run: { ...ledgerCron.run, jobId: `daily-${i}`, runId: `execution-${i}`, sessionKey: `session-${i}`, runIdAliases: [`session-${i}`] } }));
await settle(() => { renderer = create(React.createElement(Feed, { ...props, firstPage: partialPage(dailyTasks) })); });
for (let refresh = 0; refresh < 6; refresh++) {
  const items = refresh % 2 ? dailyTasks : dailyTasks.map(task => ({ ...task, id: `${task.id}-fallback-${refresh}`,
    run: { ...task.run, runId: undefined, startedAt: 150 + refresh / 10 } }));
  await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: partialPage(items) })));
  assert.equal(rows(renderer).length, 4, 'Repeated partial refreshes cannot double multiple daily tasks');
  assert.equal(textOf(renderer.root.findByProps({ className: 'dash-section-count' })), '4');
}
await settle(() => renderer.unmount());

// Session-backed fallbacks may be superseded without a shared run id. The
// authoritative snapshot removes obsolete rows; it must not guess by title.
const provisional = { ...cron, id: 'fallback', occurredAt: 300 };
const canonical = { ...cron, id: 'canonical', occurredAt: 350 };
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [provisional] },
})); });
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [canonical] },
})));
assert.equal(rows(renderer).length, 1, 'A full snapshot removes a superseded fallback without a route change');
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, degradedSources: [{ backend: 'native', source: 'cron', reason: 'error' }] },
})));
assert.equal(rows(renderer).length, 1, 'A failed source is not evidence that history was deleted');
await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: { ...empty } })));
assert.equal(rows(renderer).length, 0, 'An authoritative empty snapshot clears stale history');
await settle(() => renderer.unmount());

const older = { ...cron, id: 'older-history', occurredAt: 50 };
const boundary = { ...cron, id: 'page-boundary', occurredAt: 100 };
fetchPage = async () => ({ ...empty, items: [older] });
await settle(() => { renderer = create(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [provisional, boundary], hasMore: true, nextCursor: 'first-page' },
})); });
assert.equal(rows(renderer).length, 3);
let resolveStalePage;
fetchPage = async () => new Promise(resolve => { resolveStalePage = resolve; });
await settle(() => renderer.update(React.createElement(Feed, { ...props,
  firstPage: { ...empty, items: [canonical, boundary], hasMore: true, nextCursor: 'updated-page' },
})));
assert.equal(rows(renderer).length, 3, 'Refresh retains already-loaded rows older than the current page boundary');
assert.equal(requests.at(-1).cursor, 'updated-page', 'Pagination continues from the current snapshot');
await settle(() => renderer.update(React.createElement(Feed, { ...props, firstPage: { ...empty, items: [canonical] } })));
await settle(() => resolveStalePage({ ...empty, items: [provisional] }));
assert.equal(rows(renderer).length, 1, 'Late pagination cannot restore a row removed by a newer complete snapshot');
await settle(() => renderer.unmount());
console.log('PASS Dashboard activity identity, authoritative refresh, pagination races, filters, scope and failure retention');
