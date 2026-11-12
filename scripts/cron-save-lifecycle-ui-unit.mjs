import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const ts = require("typescript");
const React = require("react");
const { create, act } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = type => props => React.createElement(type, props, props.children);
const compile = file => ts.transpileModule(fs.readFileSync(path.join(uiRoot, "src", file), "utf8"), {
  fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const lifecycle = { exports: {} };
vm.runInNewContext(compile("lib/lowUiLifecycle.ts"), { exports: lifecycle.exports });
const visibility = { exports: {} };
vm.runInNewContext(compile("lib/cronVisibility.ts"), { exports: visibility.exports });
const scheduleDisplay = { exports: {} };
const codexSchedule = { exports: {} };
vm.runInNewContext(compile("lib/codexAutomationSchedule.ts"), { exports: codexSchedule.exports, require, Intl, Date });
vm.runInNewContext(compile("pages/cron/cronPresets.tsx"), {
  exports: scheduleDisplay.exports, Intl, Date,
  require: name => name === "../../lib/codexAutomationSchedule" ? codexSchedule.exports
    : name.endsWith("/Field") || name === "react-i18next" ? {} : require(name),
});
const translations = { useTranslation: () => ({
  t: (key, params) => params?.n === undefined ? key : `${key}:${params.n}`,
  i18n: { resolvedLanguage: "zh-CN" },
}) };
const scheduleTypes = { exports: {} };
vm.runInNewContext(compile("pages/cron/CronFormLayout.tsx"), {
  exports: scheduleTypes.exports, require: name => name === "react-i18next" ? translations
    : name === "../../components/Field" ? { Field: host("field"), TextInput: host("input") } : require(name),
});
const openClawForm = { exports: {} };
const openClawFormStubs = {
  "react-i18next": translations,
  "../../components/Field": { Field: host("field"), TextArea: host("textarea") },
  "./CronFormLayout": scheduleTypes.exports,
  "./CronSchedulePicker": { CronExpressionPicker: host("cron-expression") },
};
vm.runInNewContext(compile("pages/cron/OpenClawCronForm.tsx"), {
  exports: openClawForm.exports, require: name => openClawFormStubs[name] || require(name),
});
const filtersBar = { exports: {} };
const filterStubs = {
  "react-i18next": translations,
  "./CronFilterMenu": { __esModule: true, default: host("filter-menu"), CronAgentFilter: host("agent-filter") },
  "./CronFormLayout": scheduleTypes.exports,
  "./cronIcons": { IconSchedule: host("i"), IconSliders: host("i") },
};
vm.runInNewContext(compile("pages/cron/CronFiltersBar.tsx"), {
  exports: filtersBar.exports, require: name => filterStubs[name] || require(name),
});
const pageCode = compile("pages/CronPage.tsx");
const flush = () => new Promise(setImmediate);
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jobs = ["A", "B", "System"].map(name => ({ id: name, name, backendId: "openclaw", enabled: true,
  schedule: { kind: "every", everyMs: 60000 }, actions: name === "System" ? { edit: false, toggle: false, delete: false, run: true, reason: "system-managed" } : {} }));
const nativeJob = { ...jobs[0], id: "shoggoth:native/fixture", name: "Native", backendId: "shoggoth", prompt: "Preview" };

async function fixture(agentsLoader = async () => [{ id: "fixture-agent", name: "Fixture", backendId: "openclaw" }], fixtureJobs = jobs, savedFilters, options = {}) {
  const backends = [{ id: "openclaw", name: "OpenClaw", surfaces: { cron: { kind: "openclaw" } } }];
  if (fixtureJobs.some(job => job.backendId === "shoggoth")) {
    backends.push({ id: "shoggoth", name: "Shoggoth", surfaces: { cron: { kind: "native" } } });
  }
  const backendIds = backends.map(({ id }) => id);
  const state = { updates: [], creates: [], deletes: [], confirmations: [], refreshes: [], successes: [], errors: [], infos: [], gates: new Map(),
    allJobs: fixtureJobs, listRequests: [], runRequests: [], detailRequests: [], deliveryRequests: [],
    pageRegistrations: [], dialogCloses: 0, dialogChanges: 0,
    details: new Map(fixtureJobs.map(job => [job.id, job])) };
  options.configure?.(state);
  const form = { __esModule: true, default: host("cron-form"), emptyOpenClawDraft: () => ({ name: "", backendId: "openclaw" }),
    openClawDraftFromJob: job => ({ name: job.name, backendId: job.backendId }), openClawPatchFromDraft: draft => ({ ...draft }),
    validateOpenClawDraft: () => null };
  const stubs = {
    "react-i18next": translations,
    "react-router-dom": { useNavigate: () => () => {}, useSearchParams: () => {
      const pair = React.useState(new URLSearchParams()); state.setSearchParams = pair[1]; return pair;
    } },
    "../components/PageHead": { PageHead: host("header") },
    "../components/PillTabs": host("pill-tabs"),
    "../components/SearchCapsule": host("search-capsule"),
    "../components/BackendTabIcon": host("backend-icon"),
    "../components/Field": { Switch: host("switch") },
    "../components/Modal": { __esModule: true,
      default: props => React.createElement("modal", props, props.open ? props.children : null, props.open ? props.footer : null) },
    "../components/ui": { useConfirm: () => async opts => {
      state.confirmations.push(opts);
      return state.gates.get("confirm")?.promise ?? true;
    },
      useToast: () => ({ success: message => state.successes.push(message), error: message => state.errors.push(message), info: message => state.infos.push(message) }) },
    "../components/TurnTimeline/TurnProcess": host("timeline"),
    "../lib/markdown": { toSanitizedMarkdownHtml: text => text },
    "../lib/turnTimeline": { stepsFromParts: () => [] },
    "../lib/backends": { useBackendCatalog: () => backends, useEnabledBackends: () => backendIds, cronForceRunResumesPaused: () => false },
    "../lib/usePageCache": { usePageCache: (key, fetcher) => {
      state.fetchJobs = fetcher;
      const [error, setError] = React.useState(null);
      return { data: fixtureJobs, loading: false, error, setError, refresh: async () => { state.refreshes.push(key); } };
    } },
    "../lib/page-refresh": { useRegisterPageRefresh(path) { state.pageRegistrations.push(path); }, useRegisterPageLoading() {} },
    "../lib/productTelemetry": { measureTelemetry: (_event, _backend, action) => action() },
    "../lib/useStickyState": { useStickyState: (key, initial) => {
      const saved = { "cron.view": "list", "cron.filters": savedFilters };
      return React.useState(saved[key] ?? initial);
    } },
    "../lib/lowUiLifecycle": lifecycle.exports,
    "../lib/cronVisibility": visibility.exports,
    "../lib/cronChatHandoff": { canonicalCronSessionKey: () => null, firstNonBlankText: () => null, writeCronChatHandoff() {} },
    "../model-catalog-store": { readModelCatalog: () => ({ models: [] }), subscribeModelCatalog: () => () => {},
      revalidateModelCatalog: async backendId => ({ backendId, models: [] }) },
    "./CronCalendar": { __esModule: true, default: host("calendar"), calendarRangeTitle: () => "Calendar", shiftCalendarCursor: date => date, startOfMonth: date => date },
    "./cron/CronFiltersBar": filtersBar.exports,
    "./cron/CronFormLayout": scheduleTypes.exports,
    "./cron/cronIcons": { IconPlus: host("i"), IconCalendarChevron: host("i") },
    "./cron/CronRunReportModal": { __esModule: true, default: props => React.createElement("report-modal", props,
      props.open ? props.children : null), ReportNote: host("report-note"), runExecutionFailed: () => false },
    "./cron/cronPresets": scheduleDisplay.exports,
    "./cron/OpenClawCronForm": options.useOpenClawForm ? openClawForm.exports : form,
    "./cron/CodexCronForm": { __esModule: true, default: host("codex-form"), emptyCodexCronDraft: () => ({}) },
    "./cron/CronAgentPicker": { CronAssignedAgent: host("assigned-agent") },
    "./cron/CronCreateForm": { __esModule: true, default: host("create-form") },
    "./cron/cronCreateDraft": {
      emptyCronCreateDraft: () => ({ name: "", prompt: "", backendId: "", agentId: "", enabled: true }),
      cronAgentAvailable: agent => !agent.archived,
      cronCreateInputFromDraft: draft => ({ ...draft }),
    },
    "./cron/HermesCronForm": { __esModule: true, default: host("hermes-form"), emptyHermesDraft: () => ({}), hermesDraftFromJob: () => ({}), hermesInputFromDraft: () => ({}), validateHermesDraft: () => null },
    "./cron/ShoggothCronForm": { __esModule: true, default: host("native-form"), emptyNativeCronDraft: () => ({}),
      nativeCronDraftFromJob: job => ({ ...job }), nativeCronEditPlan: () => ({}), validateNativeCronDraft: () => null },
    "../api/client": {
      listAgents: agentsLoader, getCronRuns: async id => { state.runRequests.push(id); return []; },
      listCronJobs: async filters => { state.listRequests.push(filters); await state.gates.get('list')?.promise; return state.allJobs; },
      getCronJobDetail: async id => {
        state.detailRequests.push(id);
        await state.gates.get(`detail:${id}`)?.promise;
        return state.details.get(id);
      },
      getCronLatestDelivery: async (id, at) => { state.deliveryRequests.push({ id, at }); return { fullText: "Report" }; },
      getModelCatalog: async () => ({}),
      updateCronJob: async (id, input) => { state.updates.push({ id, input }); await state.gates.get(id)?.promise; },
      createCronJob: async input => { state.creates.push(input); await state.gates.get("new")?.promise; },
      deleteCronJob: async id => { state.deletes.push(id); await state.gates.get(`delete:${id}`)?.promise; },
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(pageCode, { exports: mod.exports, URLSearchParams, Date, Error, setTimeout,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require: name => stubs[name] || require(name),
  });
  let renderer;
  await act(async () => {
    renderer = create(options.dialogJob ? React.createElement(mod.exports.CronJobDialog, {
      job: options.dialogJob,
      onClose: () => { state.dialogCloses++; },
      onChange: async () => { state.dialogChanges++; },
    }) : React.createElement(mod.exports.default));
    await flush();
  });
  const buttons = scope => scope.findAllByType("button");
  const filterMenu = label => renderer.root.findAllByType("filter-menu").find(menu => menu.props.label === label);
  const click = async button => { await act(async () => { button.props.onClick(); await flush(); }); };
  const row = id => renderer.root.findAllByType("tr").find(node => node.findAllByProps({ className: "job-name" })[0]?.children[0] === id);
  const edit = async id => click(buttons(row(id)).find(button => button.children.includes("common.edit")));
  const formModal = () => renderer.root.findAllByType("modal").find(modal => modal.props.open);
  const save = async () => click(buttons(formModal()).find(button => button.children.includes("common.save") || button.children.includes("cronForm.createAction")));
  let notificationSequence = 0;
  const notify = async (id, backend = "openclaw") => { await act(async () => {
    state.setSearchParams(new URLSearchParams({ job: id, backend, notification: String(++notificationSequence) })); await flush();
  }); };
  const dispose = () => act(() => renderer.unmount());
  return { state, renderer, buttons, filterMenu, click, row, edit, formModal, save, notify, dispose };
}

for (const command of [
  {
    label: "cronForm.openclawCommand",
    argv: ["sh", "-lc", "printf '%s\\n' 'original value'"],
    editedArgv: ["sh", "-lc", "  printf '%s\\n' 'edited value'\n"],
    display: argv => argv[2],
    invalid: "",
    error: "cronForm.openclawValidateCommand",
  },
  {
    label: "cronForm.openclawCommandArgv",
    argv: ["/fixtures/command with spaces", "--value", "line 1\nline 2"],
    editedArgv: ["/fixtures/command with spaces", "--value", "  a \"quoted\" value\n  "],
    display: argv => JSON.stringify(argv, null, 2),
    invalid: '["/fixtures/command", 42]',
    error: "cronForm.openclawValidateCommandArgv",
  },
]) {
  const job = {
    id: "openclaw:command-fixture", backendId: "openclaw", name: "Command fixture", enabled: true,
    schedule: { kind: "cron", expr: "0 2 * * *", staggerMs: 1_234 },
    payload: { kind: "command", argv: command.argv, cwd: "/fixtures/workspace", timeoutSeconds: 120 },
    delivery: { mode: "announce", channel: "telegram", threadId: "fixture-thread" },
  };
  const f = await fixture(undefined, [job], undefined, { useOpenClawForm: true });
  const commandField = () => f.formModal().findByProps({ label: command.label }).findByType("textarea");
  await f.edit(job.name);
  assert.equal(commandField().props.value, command.display(command.argv), "the command editor shows the saved command");
  await f.save();
  assert.deepEqual(f.state.updates, [], "saving an unchanged command job does not rewrite its definition");

  await f.edit(job.name);
  act(() => commandField().props.onChange({ target: { value: command.invalid } }));
  await f.save();
  assert.equal(f.state.errors.at(-1), command.error);
  assert.deepEqual(f.state.updates, [], "invalid command input stays in the editor");

  act(() => commandField().props.onChange({ target: { value: command.display(command.editedArgv) } }));
  await f.save();
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.updates)), [
    { id: job.id, input: { payload: { kind: "command", argv: command.editedArgv } } },
  ], "saving a command only patches its argv and retains argument boundaries");
  f.dispose();
}

{
  const f = await fixture(undefined, jobs, undefined, { dialogJob: jobs[0] });
  assert.equal(f.renderer.root.findAllByProps({ className: "cron-page management-page" }).length, 0);
  assert.deepEqual(f.state.pageRegistrations, [], "a chat dialog does not register or render the task page");
  assert.deepEqual(f.state.listRequests.map(value => ({ ...value })), [{ backend: "openclaw" }]);
  assert.equal(f.renderer.root.findByType("cron-form").props.draft.name, "A");
  await f.save();
  assert.deepEqual(f.state.updates.map(({ id }) => id), ["A"]);
  assert.equal(f.state.dialogChanges, 1, "saving refreshes the owning chat list");
  assert.deepEqual(f.state.refreshes, [], "saving does not refresh an unmounted task page");
  assert.equal(f.state.dialogCloses, 0, "the dialog host stays mounted for its exit transition");
  act(() => f.renderer.root.findByType("modal").props.onOpenChangeComplete(false));
  assert.equal(f.state.dialogCloses, 1);
  f.dispose();
}
{
  const f = await fixture(undefined, [nativeJob], undefined, { dialogJob: nativeJob, configure: state => {
    state.allJobs = [{ ...nativeJob, lastRunAt: Date.now() - 60000 }];
    state.details.set(nativeJob.id, { ...nativeJob, prompt: "Complete native task prompt" });
  } });
  const report = () => f.renderer.root.findByType("report-modal");
  assert.equal(report().props.open, true, "a chat dialog checks fresh run state before choosing the result");
  assert.equal(report().props.title, nativeJob.name);
  await act(async () => { report().props.onEdit(); await flush(); });
  assert.equal(f.renderer.root.findByType("native-form").props.draft.prompt, "Complete native task prompt");
  act(() => report().props.onOpenChangeComplete(false));
  assert.equal(f.state.dialogCloses, 0, "switching from report to editor keeps the same dialog host");
  f.dispose();
}
{
  const f = await fixture(undefined, jobs, undefined, { dialogJob: jobs[0], configure: state => {
    state.allJobs = [{ ...jobs[0], backendId: "hermes" }];
  } });
  assert.equal(f.formModal(), undefined);
  assert.equal(f.state.infos.at(-1), "notif.cronUnavailable");
  assert.equal(f.state.dialogCloses, 1, "an unavailable or wrong-backend task releases the chat selection for retry");
  f.dispose();
}
{
  const pending = gate();
  const f = await fixture(undefined, jobs, undefined, { dialogJob: jobs[0], configure: state => state.gates.set("list", pending) });
  f.dispose();
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.state.dialogCloses, 0, "a late response cannot dismiss a newer chat dialog");
  assert.deepEqual(f.state.deliveryRequests, []);
  assert.deepEqual(f.state.detailRequests, []);
}

{
  const f = await fixture();
  let form;
  act(() => { form = create(React.createElement(scheduleTypes.exports.CronScheduleType, { value: "cron" })); });
  const createLabels = form.root.findAllByType("button").map(button => button.children[0]);
  const menu = () => f.filterMenu("cronForm.filtersSchedules");
  assert.deepEqual(Array.from(menu().props.options, option => option.value), ["all", "cron", "every", "at"],
    "the filter offers All and the three creation modes");
  assert.deepEqual(Array.from(menu().props.options.slice(1), option => option.label), createLabels,
    "the filter uses the same labels as the creation form");
  for (const kind of ["cron", "every", "at", "all"]) {
    act(() => menu().props.onChange(kind));
    assert.equal(menu().props.value, kind);
    await f.state.fetchJobs();
    assert.equal(f.state.listRequests.at(-1).scheduleKind, kind);
  }
  act(() => form.unmount());
  f.dispose();
}
for (const [stored, expected] of [["rrule", "all"], ["on-exit", "all"], ["stream", "all"], ["every", "every"]]) {
  const savedFilters = { scheduleKind: stored, agentIds: ["fixture-agent"], enabled: "enabled", query: "saved search" };
  const f = await fixture(undefined, jobs, savedFilters);
  assert.equal(f.filterMenu("cronForm.filtersSchedules").props.value, expected);
  await f.state.fetchJobs();
  assert.deepEqual({ ...f.state.listRequests[0] }, { ...savedFilters, scheduleKind: expected },
    "discarding an old schedule filter preserves the other saved filters");
  f.dispose();
}

{
  const f = await fixture(undefined, [nativeJob, jobs[0]]);
  f.state.details.set(nativeJob.id, { ...nativeJob, prompt: "Full saved prompt" });
  const pending = gate(); f.state.gates.set(`detail:${nativeJob.id}`, pending);
  await f.click(f.row("Native"));
  assert.equal(f.formModal(), undefined, "native editing waits for the complete definition");
  await f.click(f.row("A"));
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.formModal().props.title, "cron.editOpenClawTitle", "a late row lookup cannot replace a newer editor");
  act(() => f.formModal().props.onClose());
  await f.click(f.row("Native"));
  assert.equal(f.formModal().props.title, "cron.editNativeTitle");
  assert.equal(f.renderer.root.findByType("native-form").props.draft.prompt, "Full saved prompt");
  assert.deepEqual(f.state.detailRequests, [nativeJob.id, nativeJob.id]);
  assert.deepEqual(f.state.runRequests, [], "opening a list row edits the job without loading the old run history");
  f.dispose();
}
{
  const job = { ...nativeJob, actions: { edit: false, delete: false, reason: "system-managed" } };
  const f = await fixture(undefined, [job]);
  assert.equal(f.row("Native").props.onClick, undefined, "protected rows are not editable");
  await f.notify(job.id, job.backendId);
  assert.equal(f.formModal(), undefined, "a protected deep link must not open an editor or the old details");
  assert.equal(f.state.infos.at(-1), "cron.systemManaged");
  f.dispose();
}
{
  const f = await fixture(undefined, [jobs[0]]);
  f.state.allJobs = jobs;
  await f.notify('B');
  assert.equal(f.formModal().props.title, 'cron.editOpenClawTitle');
  assert.equal(f.renderer.root.findByType('cron-form').props.draft.name, 'B', 'A notification edits a task outside the current list filter');
  assert.equal(f.state.listRequests[0].backend, 'openclaw');
  assert.equal(Object.keys(f.state.listRequests[0]).join(), 'backend', 'Notification lookup must ignore saved search/status filters');
  act(() => f.formModal().props.onClose());
  assert.equal(f.formModal(), undefined);
  await f.notify('B');
  assert.equal(f.renderer.root.findByType('cron-form').props.draft.name, 'B', 'Clicking another notification for the same task reopens its editor');
  await f.notify('B', 'wrong-backend');
  assert.equal(f.state.infos.at(-1), 'notif.cronUnavailable', 'A same-ID task from another backend must not be opened');
  await act(async () => { f.state.setSearchParams(new URLSearchParams({ job: 'A', backend: 'openclaw' })); await flush(); });
  assert.equal(f.renderer.root.findByType('cron-form').props.draft.name, 'A', 'A plain task link still edits directly');
  await act(async () => { f.state.setSearchParams(new URLSearchParams({ job: 'B', edit: '1' })); await flush(); });
  assert.equal(f.renderer.root.findByType('cron-form').props.draft.name, 'B', 'Existing Dashboard edit links still work');
  f.dispose();
}
{
  const f = await fixture(undefined, [jobs[0]]);
  f.state.allJobs = jobs;
  const pending = gate(); f.state.gates.set('list', pending);
  await f.notify('B');
  await f.notify('A');
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.renderer.root.findByType('cron-form').props.draft.name, 'A',
    'A slow filtered-task lookup cannot replace a later notification target');
  f.dispose();
}
{
  const unrun = { ...nativeJob, id: "shoggoth:unrun", name: "Never run" };
  const f = await fixture(undefined, [nativeJob, unrun]);
  f.state.allJobs = [{ ...nativeJob, lastRunAt: Date.now() - 60000 }, unrun];
  const openFromChat = async job => act(async () => {
    f.state.setSearchParams(new URLSearchParams({ backend: job.backendId, job: job.id, run: "latest" }));
    await flush();
  });
  await openFromChat(nativeJob);
  const report = () => f.renderer.root.findByType("report-modal");
  assert.equal(report().props.open, true, "a run found in the fresh task lookup opens its result even when the cached list predates it");
  assert.equal(report().props.title, nativeJob.name);
  assert.deepEqual(f.state.deliveryRequests, [{ id: nativeJob.id, at: undefined }], "chat requests the latest run without a calendar timestamp");
  assert.equal(f.formModal(), undefined);
  await act(async () => { report().props.onEdit(); await flush(); });
  assert.equal(report().props.open, false);
  assert.equal(f.renderer.root.findByType("native-form").props.draft.id, nativeJob.id, "the result's edit button opens the same task");
  await openFromChat(unrun);
  assert.equal(f.renderer.root.findByType("native-form").props.draft.id, unrun.id, "a task that has never run opens its editor");
  assert.equal(f.state.deliveryRequests.length, 1, "no report lookup is made for a task without a run");
  f.dispose();
}
{
  const past = Date.now() - 3600000;
  const job = { ...nativeJob, lastRunAt: past };
  const f = await fixture(undefined, [job]);
  act(() => f.renderer.root.findByProps({ ariaLabel: "cron.viewToggle" }).props.onChange("calendar"));
  const calendar = f.renderer.root.findByType("calendar");
  await act(async () => { await calendar.props.onJobClick(job, past); });
  const report = f.renderer.root.findByType("report-modal");
  assert.equal(report.props.open, true, "a past run still opens its report");
  assert.deepEqual(f.state.deliveryRequests, [{ id: job.id, at: past }]);
  assert.equal(f.formModal(), undefined);
  act(() => report.props.onClose());
  await act(async () => { await calendar.props.onJobClick(job, Date.now() + 60000); });
  assert.equal(f.formModal().props.title, "cron.editNativeTitle", "a future slot opens the editor");
  f.dispose();
}
{
  const now = Date.now();
  const visibleJobs = [
    { ...jobs[0], nextRunAt: now + 120000 },
    { ...jobs[1], name: "Memory Dreaming Promotion" },
  ];
  const systemJobs = [
    { ...jobs[2], payload: { kind: "skillCollectionReview" } },
    { ...jobs[0], id: "dreaming", name: "Internal memory sweep", systemManaged: true },
  ];
  const heartbeat = { ...jobs[2], id: "heartbeat", name: "heartbeat-vincent", nextRunAt: now + 60000,
    lastStatus: "error", payload: { kind: "heartbeat" } };
  const desktop = { ...heartbeat, id: "desktop", name: "Desktop schedule", origin: "codex-desktop", payload: { kind: "agentTurn" } };
  const f = await fixture(undefined, [heartbeat, desktop, ...systemJobs, ...visibleJobs]);
  assert.deepEqual(f.renderer.root.findAllByProps({ className: "job-name" }).map(node => node.children[0]), ["A", "Memory Dreaming Promotion"],
    "system jobs are hidden on the first render; a same-named user job remains visible");
  assert.deepEqual(Array.from(f.renderer.root.findByType("header").props.subtitle.props.children, node => node.props.children),
    ["cron.statTotal:2", "cron.statEnabled:2", "cron.statError:0"], "all counts use visible jobs");
  act(() => f.renderer.root.findByProps({ ariaLabel: "cron.viewToggle" }).props.onChange("calendar"));
  const calendar = f.renderer.root.findByType("calendar");
  assert.deepEqual(Array.from(calendar.props.jobs, row => row.id), ["A", "B"],
    "month/week/day calendars contain only user jobs");
  assert.equal(calendar.props.nextUp.id, "A", "the next-run highlight must skip earlier heartbeats");
  assert.equal(f.state.updates.length + f.state.creates.length, 0);
  f.dispose();
  const empty = await fixture(undefined, [heartbeat, desktop, ...systemJobs]);
  assert.equal(empty.renderer.root.findAllByProps({ className: "empty-hint" }).length, 1,
    "a heartbeat-only list shows the normal empty state");
  empty.dispose();
}

{
  const f = await fixture();
  await f.edit("A");
  const pending = gate(); f.state.gates.set("A", pending);
  const modalBefore = f.formModal();
  const saveBefore = f.buttons(modalBefore).find(button => button.children.includes("common.save"));
  await act(async () => {
    saveBefore.props.onClick(); saveBefore.props.onClick(); modalBefore.props.onClose(); await flush();
  });
  assert.equal(f.state.updates.length, 1, "double clicking before React commits must still create only one mutation");
  assert.equal(f.formModal().props.dismissible, false, "X, Escape and backdrop are locked during submission");
  assert.equal(f.formModal().props.open, true, "a stale close handler is also synchronously locked");
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.formModal(), undefined);
  assert.deepEqual(f.state.successes, ["cron.savedOpenClaw"]);
  assert.equal(f.state.refreshes.length, 1);
  f.dispose();
}
{
  const f = await fixture();
  await f.edit("A");
  const form = f.renderer.root.findByType("cron-form");
  act(() => form.props.setDraft({ ...form.props.draft, name: "Unsaved edit" }));
  const remove = () => f.buttons(f.formModal()).find(button => button.children.includes("common.delete"));
  const cancel = gate(); f.state.gates.set("confirm", cancel);
  await f.click(remove());
  assert.deepEqual(f.state.deletes, [], "opening confirmation must not delete");
  await act(async () => { cancel.resolve(false); await flush(); });
  assert.equal(f.renderer.root.findByType("cron-form").props.draft.name, "Unsaved edit", "canceling deletion keeps the draft");
  assert.deepEqual(f.state.deletes, []);

  const confirm = gate(); f.state.gates.set("confirm", confirm);
  const pending = gate(); f.state.gates.set("delete:A", pending);
  const deleteButton = remove();
  const saveButton = f.buttons(f.formModal()).find(button => button.children.includes("common.save"));
  await act(async () => {
    deleteButton.props.onClick(); deleteButton.props.onClick(); await flush();
    confirm.resolve(true); await flush();
    saveButton.props.onClick(); await flush();
  });
  assert.equal(f.state.confirmations.length, 2, "each deletion intent opens at most one confirmation");
  assert.deepEqual(f.state.deletes, ["A"], "only the confirmed job is deleted");
  assert.deepEqual(f.state.updates, [], "save cannot race a pending deletion");
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.formModal(), undefined);
  assert.deepEqual(f.state.successes, ["cron.deleted"]);
  assert.equal(f.state.refreshes.length, 1);
  f.dispose();
}
{
  const f = await fixture(undefined, [{ ...jobs[0], actions: { delete: false } }, jobs[1]]);
  await f.edit("A");
  const button = f.buttons(f.formModal()).find(item => item.children.includes("common.delete"));
  assert.equal(button.props.disabled, true, "jobs without delete permission cannot be removed from the edit form");
  await f.click(button);
  assert.deepEqual(f.state.confirmations, []);
  assert.deepEqual(f.state.deletes, []);
  await f.edit("B");
  const confirm = gate(); f.state.gates.set("confirm", confirm);
  await f.click(f.buttons(f.formModal()).find(item => item.children.includes("common.delete")));
  await f.notify("A");
  await act(async () => { confirm.resolve(true); await flush(); });
  assert.deepEqual(f.state.deletes, [], "a stale confirmation cannot delete after a newer selection takes over");
  f.dispose();
}
for (const rejectOld of [false, true]) {
  const f = await fixture();
  await f.edit("A"); const first = gate(); f.state.gates.set("A", first); await f.save();
  await f.notify("B"); await f.edit("B");
  const form = f.renderer.root.findByType("cron-form");
  act(() => form.props.setDraft({ ...form.props.draft, name: "B draft must survive" }));
  const second = gate(); f.state.gates.set("B", second); await f.save();
  await act(async () => { rejectOld ? first.reject(new Error("late A failure")) : first.resolve(); await flush(); });
  assert.equal(f.renderer.root.findByType("cron-form").props.draft.name, "B draft must survive");
  assert.equal(f.formModal().props.dismissible, false, "a late A completion cannot clear B's saving state");
  assert.deepEqual(f.state.successes, []); assert.deepEqual(f.state.errors, []);
  assert.equal(f.state.refreshes.length, 0, "a stale save cannot refresh a new selection's UI");
  await act(async () => { second.resolve(); await flush(); });
  assert.equal(f.state.successes.length, 1); assert.equal(f.state.refreshes.length, 1);
  assert.deepEqual(f.state.updates.map(call => call.id), ["A", "B"]);
  f.dispose();
}
for (const rejectOld of [false, true]) {
  const f = await fixture();
  await f.edit("A"); const pending = gate(); f.state.gates.set("A", pending); await f.save(); f.dispose();
  await act(async () => { rejectOld ? pending.reject(new Error("unmounted failure")) : pending.resolve(); await flush(); });
  assert.equal(f.state.successes.length + f.state.errors.length, 0, "an unmounted page cannot notify for a stale save");
  assert.equal(f.state.refreshes.length, 0, "an unmounted save cannot start a refresh through an old closure");
}
{
  const f = await fixture();
  await f.edit("A"); const pending = gate(); f.state.gates.set("A", pending); await f.save();
  act(() => f.filterMenu("cronForm.filtersStatuses").props.onChange("enabled"));
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.state.refreshes.length, 0, "changing the list scope prevents an old-key/new-fetcher refresh");
  assert.equal(f.state.successes.length, 0);
  assert.equal(f.formModal().props.open, true, "a stale scope completion cannot close a currently displayed form");
  f.dispose();
}
{
  const f = await fixture();
  await f.edit("A"); const pending = gate(); f.state.gates.set("A", pending); await f.save();
  await act(async () => { pending.reject(new Error("save failed")); await flush(); });
  assert.equal(f.formModal().props.dismissible, true);
  assert.equal(f.renderer.root.findByType("cron-form").props.draft.name, "A");
  assert.deepEqual(f.state.errors, ["save failed"]);
  assert.equal(f.state.refreshes.length, 0);
  f.state.gates.delete("A"); await f.save();
  assert.equal(f.state.updates.length, 2); assert.equal(f.state.successes.length, 1);
  f.dispose();
}
{
  const f = await fixture();
  await f.click(f.renderer.root.findByProps({ className: "btn-primary cron-new" }));
  assert.equal(f.formModal().props.title, "cron.createTitle", "New opens one neutral form directly");
  const form = f.renderer.root.findByType("create-form");
  const createButton = f.buttons(f.formModal()).find(button => button.children.includes("cronForm.createAction"));
  assert.equal(createButton.props.disabled, true, "assistant selection is required");
  await f.save();
  assert.equal(f.state.creates.length, 0, "the handler also guards missing assistants");
  act(() => form.props.setDraft({ ...form.props.draft, name: "New fixture", backendId: "openclaw", agentId: "not-in-roster" }));
  await f.save();
  assert.equal(f.state.creates.length, 0, "unknown assistant identities cannot be submitted");
  act(() => form.props.setDraft({ ...form.props.draft, name: "New fixture", backendId: "openclaw", agentId: "fixture-agent" }));
  act(() => f.formModal().findByType("switch").props.onChange(false));
  const pending = gate(); f.state.gates.set("new", pending); await f.save();
  assert.equal(f.formModal().props.dismissible, false);
  assert.equal(f.formModal().findByType("switch").props.disabled, true, "the footer toggle is locked while saving");
  assert.equal(f.state.creates[0].enabled, false, "the footer toggle updates the draft submitted on creation");
  await f.notify("B");
  await act(async () => { pending.resolve(); await flush(); });
  assert.equal(f.renderer.root.findByType("cron-form").props.draft.name, "B");
  assert.equal(f.state.creates.length, 1); assert.equal(f.state.refreshes.length, 0);
  f.dispose();
}
{
  const f = await fixture();
  assert.equal(f.row("System"), undefined, "system tasks have no list row");
  await f.notify("System");
  assert.equal(f.formModal(), undefined);
  assert.equal(f.renderer.root.findAllByType("modal").find(modal => modal.props.open), undefined,
    "an old notification cannot open a hidden system task");
  act(() => f.renderer.root.findByProps({ ariaLabel: "cron.viewToggle" }).props.onChange("calendar"));
  await act(async () => { await f.renderer.root.findByType("calendar").props.onJobClick(jobs[2], Date.now() + 60000); await flush(); });
  assert.equal(f.formModal(), undefined, "stale system calendar occurrences cannot reopen details");
  assert.deepEqual(f.state.runRequests, [], "hidden tasks never load run history");
  assert.equal(f.state.updates.length + f.state.creates.length, 0);
  f.dispose();
}
{
  const pending = gate();
  const f = await fixture(() => pending.promise);
  await f.click(f.renderer.root.findByProps({ className: "btn-primary cron-new" }));
  assert.equal(f.formModal().props.title, "cron.createTitle", "the create form opens before the roster request finishes");
  assert.equal(f.renderer.root.findByType("create-form").props.loading, true);
  await f.click(f.buttons(f.formModal()).find(button => button.children.includes("common.cancel")));
  await act(async () => { pending.resolve([{ id: "fixture-agent", backendId: "openclaw" }]); await flush(); });
  assert.equal(f.formModal(), undefined, "a late roster response cannot reopen a dismissed form");
  f.dispose();
}
{
  let calls = 0;
  const f = await fixture(async () => {
    if (++calls === 1) throw new Error("roster unavailable");
    return [{ id: "fixture-agent", backendId: "openclaw" }];
  });
  await f.click(f.renderer.root.findByProps({ className: "btn-primary cron-new" }));
  assert.equal(f.renderer.root.findByType("create-form").props.failedBackends[0], "openclaw");
  await act(async () => { f.renderer.root.findByType("create-form").props.onRetry(); await flush(); });
  assert.equal(f.renderer.root.findByType("create-form").props.failedBackends.length, 0);
  assert.equal(f.renderer.root.findByType("create-form").props.agents.openclaw.length, 1);
  f.dispose();
}
console.log("PASS Cron editor navigation, calendar reports, filters, visibility, and form mutation lifecycle");
