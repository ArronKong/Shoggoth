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
vm.runInNewContext(compile("pages/cron/cronPresets.tsx"), {
  exports: scheduleDisplay.exports, Intl, Date,
  require: name => name.endsWith("/Field") || name === "react-i18next" ? {} : require(name),
});
const pageCode = compile("pages/CronPage.tsx");
const flush = () => new Promise(setImmediate);
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const backendIds = ["openclaw"];
const backends = [{ id: "openclaw", name: "OpenClaw", surfaces: { cron: { kind: "openclaw" } } }];
const jobs = ["A", "B", "System"].map(name => ({ id: name, name, backendId: "openclaw", enabled: true,
  schedule: { kind: "every", everyMs: 60000 }, actions: name === "System" ? { edit: false, toggle: false, delete: false, run: true, reason: "system-managed" } : {} }));

async function fixture(agentsLoader = async () => [{ id: "fixture-agent", name: "Fixture", backendId: "openclaw" }], fixtureJobs = jobs) {
  const state = { updates: [], creates: [], refreshes: [], successes: [], errors: [], gates: new Map() };
  const form = { __esModule: true, default: host("cron-form"), emptyOpenClawDraft: () => ({ name: "", backendId: "openclaw" }),
    openClawDraftFromJob: job => ({ name: job.name, backendId: job.backendId }), openClawInputFromDraft: draft => ({ ...draft }),
    validateOpenClawDraft: () => null };
  const stubs = {
    "react-i18next": { useTranslation: () => ({ t: (key, params) => params?.n === undefined ? key : `${key}:${params.n}`, i18n: { resolvedLanguage: "zh-CN" } }) },
    "react-router-dom": { useNavigate: () => () => {}, useSearchParams: () => {
      const pair = React.useState(new URLSearchParams()); state.setSearchParams = pair[1]; return pair;
    } },
    "../components/PageHead": { PageHead: host("header") },
    "../components/BackendBadge": host("backend-badge"), "../components/PillTabs": host("pill-tabs"),
    "../components/BackendTabIcon": host("backend-icon"),
    "../components/Field": { Switch: host("switch") },
    "../components/Modal": { __esModule: true,
      default: props => React.createElement("modal", props, props.open ? props.children : null, props.open ? props.footer : null),
      DetailRow: host("detail-row"), ModalSection: host("section") },
    "../components/ui": { useConfirm: () => async () => true,
      useToast: () => ({ success: message => state.successes.push(message), error: message => state.errors.push(message) }) },
    "../components/TurnTimeline/TurnProcess": host("timeline"),
    "../lib/markdown": { toSanitizedMarkdownHtml: text => text },
    "../lib/turnTimeline": { stepsFromParts: () => [] },
    "../lib/backends": { useBackendCatalog: () => backends, useEnabledBackends: () => backendIds, cronForceRunResumesPaused: () => false },
    "../lib/usePageCache": { usePageCache: key => {
      const [error, setError] = React.useState(null);
      return { data: fixtureJobs, loading: false, error, setError, refresh: async () => { state.refreshes.push(key); } };
    } },
    "../lib/page-refresh": { useRegisterPageRefresh() {}, useRegisterPageLoading() {} },
    "../lib/useStickyState": { useStickyState: (key, initial) => React.useState(key === "cron.view" ? "list" : initial) },
    "../lib/lowUiLifecycle": lifecycle.exports,
    "../lib/cronVisibility": visibility.exports,
    "../lib/cronChatHandoff": { canonicalCronSessionKey: () => null, firstNonBlankText: () => null, writeCronChatHandoff() {} },
    "../model-catalog-store": { readModelCatalog: () => ({ models: [] }), subscribeModelCatalog: () => () => {},
      revalidateModelCatalog: async backendId => ({ backendId, models: [] }) },
    "./CronCalendar": { __esModule: true, default: host("calendar"), calendarRangeTitle: () => "Calendar", shiftCalendarCursor: date => date, startOfMonth: date => date },
    "./cron/CronFiltersBar": host("filters"), "./cron/cronIcons": { IconPlus: host("i"), IconSearch: host("i") },
    "./cron/CronRunHistoryPanel": host("run-history"),
    "./cron/cronPresets": scheduleDisplay.exports,
    "./cron/OpenClawCronForm": form,
    "./cron/CronCreateForm": { __esModule: true, default: host("create-form") },
    "./cron/cronCreateDraft": {
      emptyCronCreateDraft: () => ({ name: "", prompt: "", backendId: "", agentId: "", enabled: true }),
      cronAgentAvailable: agent => !agent.archived,
      cronCreateInputFromDraft: draft => ({ ...draft }),
    },
    "./cron/HermesCronForm": { __esModule: true, default: host("hermes-form"), emptyHermesDraft: () => ({}), hermesDraftFromJob: () => ({}), hermesInputFromDraft: () => ({}), validateHermesDraft: () => null },
    "./cron/ShoggothCronForm": { __esModule: true, default: host("native-form"), emptyNativeCronDraft: () => ({}), nativeCronDraftFromJob: () => ({}), nativeCronEditPlan: () => ({}), nativeCronInputFromDraft: () => ({}), validateNativeCronDraft: () => null },
    "../api/client": {
      listAgents: agentsLoader, getCronRuns: async () => [], listCronJobs: async () => fixtureJobs,
      getCronJobDetail: async id => fixtureJobs.find(job => job.id === id),
      getModelCatalog: async () => ({}),
      updateCronJob: async (id, input) => { state.updates.push({ id, input }); await state.gates.get(id)?.promise; },
      createCronJob: async input => { state.creates.push(input); await state.gates.get("new")?.promise; },
    },
  };
  const mod = { exports: {} };
  vm.runInNewContext(pageCode, { exports: mod.exports, URLSearchParams, Date, Error, setTimeout,
    window: { setTimeout: () => 1, clearTimeout() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    require: name => stubs[name] || require(name),
  });
  let renderer;
  await act(async () => { renderer = create(React.createElement(mod.exports.default)); await flush(); });
  const buttons = scope => scope.findAllByType("button");
  const click = async button => { await act(async () => { button.props.onClick(); await flush(); }); };
  const row = id => renderer.root.findAllByType("tr").find(node => node.findAllByProps({ className: "job-name" })[0]?.children[0] === id);
  const edit = async id => click(buttons(row(id)).find(button => button.children.includes("common.edit")));
  const formModal = () => renderer.root.findAllByType("modal").find(modal => modal.props.open && (String(modal.props.title).includes("OpenClawTitle") || modal.props.title === "cron.createTitle"));
  const save = async () => click(buttons(formModal()).find(button => button.children.includes("common.save") || button.children.includes("cronForm.createAction")));
  const notify = async id => { await act(async () => { state.setSearchParams(new URLSearchParams({ job: id, backend: "openclaw" })); await flush(); }); };
  const dispose = () => act(() => renderer.unmount());
  return { state, renderer, buttons, click, row, edit, formModal, save, notify, dispose };
}

{
  const now = Date.now();
  const visibleJobs = [
    { ...jobs[0], nextRunAt: now + 120000 },
    { ...jobs[2], payload: { kind: "skillCollectionReview" } },
  ];
  const heartbeat = { ...jobs[2], id: "heartbeat", name: "heartbeat-vincent", nextRunAt: now + 60000,
    lastStatus: "error", payload: { kind: "heartbeat" } };
  const f = await fixture(undefined, [heartbeat, ...visibleJobs]);
  assert.deepEqual(f.renderer.root.findAllByProps({ className: "job-name" }).map(node => node.children[0]), ["A", "System"],
    "cached heartbeat jobs must be hidden on the first list render");
  assert.deepEqual(Array.from(f.renderer.root.findByType("header").props.subtitle.props.children, node => node.props.children),
    ["cron.statTotal:2", "cron.statEnabled:2", "cron.statError:0"], "all counts use visible jobs");
  act(() => f.renderer.root.findByProps({ ariaLabel: "cron.viewToggle" }).props.onChange("calendar"));
  const calendar = f.renderer.root.findByType("calendar");
  assert.deepEqual(Array.from(calendar.props.jobs, row => row.id), ["A", "System"],
    "month/week/day calendars share the heartbeat-free list");
  assert.equal(calendar.props.nextUp.id, "A", "the next-run highlight must skip earlier heartbeats");
  assert.equal(f.state.updates.length + f.state.creates.length, 0);
  f.dispose();
  const empty = await fixture(undefined, [heartbeat]);
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
  act(() => { const filter = f.renderer.root.findByType("filters"); filter.props.onChange({ ...filter.props.filters, enabled: "enabled" }); });
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
  assert.equal(f.renderer.root.findAllByType("modal").find(modal => modal.props.open)?.props.title, "B");
  assert.equal(f.state.creates.length, 1); assert.equal(f.state.refreshes.length, 0);
  f.dispose();
}
{
  const f = await fixture();
  // Invoke the handler as well as checking disabled markup, so the calendar
  // path cannot bypass the per-job capability gate.
  await f.edit("System");
  assert.equal(f.formModal(), undefined);
  assert.equal(f.renderer.root.findAllByType("modal").find(modal => modal.props.open)?.props.title, "System");
  act(() => f.renderer.root.findByProps({ ariaLabel: "cron.viewToggle" }).props.onChange("calendar"));
  await act(async () => { await f.renderer.root.findByType("calendar").props.onJobClick(jobs[2], Date.now() + 60000); await flush(); });
  assert.equal(f.formModal(), undefined, "future system-managed calendar occurrences open read-only details");
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
console.log("PASS Cron save lifecycle and visibility: cached heartbeat list/calendar/counts, submit/dismiss lock, stale selection/filter/unmount results, direct create with required assistant, roster loading and retry, system-managed edit guard");
