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
const { act, create } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = type => props => React.createElement(type, props, props.children);
const fields = { Field: host("field"), Select: host("select"), Option: host("option"),
  TextInput: host("input"), TextArea: host("textarea"), Switch: host("switch") };
const modules = new Map();
let cronCatalog;
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Intl, Date,
    require: name => {
      if (name.endsWith(".css")) return {};
      if (name.endsWith(".svg")) return name;
      if (name.endsWith("/api/client")) return { getCodexAutomationModels: async () => ({ models: [] }) };
      if (name.endsWith("/usePageCache")) return { usePageCache: () => ({ data: cronCatalog }) };
      if (name === "react-i18next") return { useTranslation: () => ({ t: key => key, i18n: { resolvedLanguage: "en" } }) };
      if (name.endsWith("/Field")) return fields;
      if (name.endsWith("/i18n")) return { t: key => key };
      if (name === "./CronAgentPicker") return { __esModule: true, default: host("agent-picker") };
      if (name === "./CronModelPicker") return { CronTaskModelField: host("task-model-picker") };
      if (name === "../ChatModelMenu") return { __esModule: true, default: host("model-menu") };
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        return load(fs.existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`);
      }
      return require(name);
    },
  });
  modules.set(file, mod.exports);
  return mod.exports;
}
const openclaw = load(path.join(uiRoot, "src/pages/cron/OpenClawCronForm.tsx"));
const hermes = load(path.join(uiRoot, "src/pages/cron/HermesCronForm.tsx"));
const native = load(path.join(uiRoot, "src/pages/cron/ShoggothCronForm.tsx"));
function assertTaskLayout(renderer, assistantType) {
  const [nameRow, prompt, assistantAndModel, schedule] = renderer.toJSON().children;
  assert.equal(nameRow.children.length, 1, "task name takes the full first row");
  assert.equal(nameRow.children[0].props.label, "cronForm.taskNameLabel");
  assert.equal(prompt.props.label, "cronForm.taskPromptLabel");
  assert.equal(assistantAndModel.props.className, "field-row");
  assert.deepEqual(assistantAndModel.children.map(field => field.type), [assistantType, "task-model-picker"]);
  assert.equal(schedule.children[0].children[0], "cronForm.scheduleLabel");
}
const cases = [
  {
    name: "OpenClaw", mod: openclaw, empty: openclaw.emptyOpenClawDraft,
    toInput: openclaw.openClawInputFromDraft,
    advanced: { cronTz: "Europe/London", staggerSec: 30, description: "Keep this description",
      model: "preview/model", fallbacks: "preview/fallback", thinking: "high", timeoutSeconds: 120, wakeMode: "next-heartbeat",
      toolsAllow: "web, terminal", lightContext: true, deliveryMode: "webhook", webhookUrl: "https://example.invalid/result",
      failureEnabled: true, failureAfter: 5, failureCooldownMin: 30, failureChannel: "telegram", failureTo: "fixture", deleteAfterRun: true },
  },
  {
    name: "Hermes", mod: hermes, empty: () => hermes.emptyHermesDraft("fixture-agent"),
    toInput: hermes.hermesInputFromDraft,
    advanced: { repeat: "5", deliver: "telegram:fixture", model: "model", provider: "preview", baseUrl: "https://example.invalid/v1",
      skills: "research, web", contextFrom: "job-1, job-2", enabledToolsets: "web", workdir: "/tmp/project", profile: "fixture" },
  },
  {
    name: "Native", mod: native, empty: () => native.emptyNativeCronDraft("codex", "fixture-agent"),
    toInput: native.nativeCronInputFromDraft,
    advanced: { cronTz: "Europe/London", workspace: "/tmp/project", misfirePolicy: "all-bounded", maxCatchUp: 3,
      overlapPolicy: "queue", threadPolicy: "continue", threadId: "saved-thread" },
  },
];
{
  const input = openclaw.openClawInputFromDraft({ ...openclaw.emptyOpenClawDraft(), name: "New task", prompt: "Summarize" });
  assert.equal(input.wakeMode, "now", "new OpenClaw jobs request immediate wake-up");
  assert.equal(Object.hasOwn(input.payload, "thinking"), false, "default thinking leaves the backend configuration in control");
  const restored = openclaw.openClawDraftFromJob({ id: "existing", ...input, wakeMode: "next-heartbeat" });
  assert.equal(openclaw.openClawInputFromDraft(restored).wakeMode, "next-heartbeat", "existing jobs retain their saved wake-up mode");
  assert.equal(openclaw.openClawPatchFromDraft(restored, { ...input, model: "provider/previous" }).payload.model, null);
  const savedModel = { model: "preview", bindingId: "binding", modelProviderRef: "@chatgpt" };
  const nativeJob = { modelSelection: savedModel, backendId: "shoggoth", agentId: "fixture", schedule: { kind: "every", everyMs: 60000 } };
  const nativeDraft = native.nativeCronDraftFromJob(nativeJob);
  assert.equal(nativeDraft.modelSelection, savedModel);
  assert.equal(Object.hasOwn(native.nativeCronEditPlan(nativeDraft, nativeJob).patch, "modelSelection"), false);
  assert.equal(native.nativeCronEditPlan({ ...nativeDraft, modelSelection: null }, nativeJob).patch.modelSelection, null);
}
for (const test of cases) {
  for (const customized of [false, true]) {
    let draft = { ...test.empty(), name: "Original", prompt: "Keep this prompt", ...(customized ? test.advanced : {}) };
    const before = JSON.stringify(test.toInput(draft));
    function Harness() {
      const [value, setValue] = React.useState(draft);
      draft = value;
      return React.createElement(test.mod.default, { draft: value, setDraft: setValue, showTarget: true,
        assistant: React.createElement("assigned-agent"),
        agents: [{ id: "fixture-agent", name: "Fixture" }], models: [], modelsLoading: false });
    }
    let renderer;
    act(() => { renderer = create(React.createElement(Harness)); });
    assertTaskLayout(renderer, "assigned-agent");
    assert.equal(renderer.root.findAllByType("details").length, 0, `${test.name}: advanced settings have no entry point`);
    assert.equal(JSON.stringify(test.toInput(draft)), before, `${test.name}: rendering must not change any stored options`);
    const nameField = renderer.root.findAllByType("field").find(field => field.props.label === "cronForm.taskNameLabel");
    act(() => nameField.findByType("input").props.onChange({ target: { value: "Renamed" } }));
    const expected = JSON.parse(before); expected.name = "Renamed";
    assert.deepEqual(JSON.parse(JSON.stringify(test.toInput(draft))), expected,
      `${test.name}: a basic edit preserves all hidden advanced values`);
    const choose = kind => renderer.root.findAllByType("button").find(button => button.children.includes(`cronForm.scheduleType_${kind}`));
    act(() => choose("every").props.onClick());
    assert.equal(draft.schedKind, "every");
    act(() => choose("cron").props.onClick());
    assert.deepEqual(JSON.parse(JSON.stringify(test.toInput(draft))), expected,
      `${test.name}: switching schedule tabs preserves custom schedule and advanced options`);
    act(() => renderer.unmount());
  }
}
{
  const createForm = load(path.join(uiRoot, "src/pages/cron/CronCreateForm.tsx"));
  const createDraft = load(path.join(uiRoot, "src/pages/cron/cronCreateDraft.ts"));
  const ids = ["openclaw", "hermes", "shoggoth"];
  const backends = ids.map(id => ({ id }));
  const roster = Object.fromEntries(ids.map(id => [id, [{ id: `${id}-other` }, { id: `${id}-main`, isDefault: true }]]));
  const statuses = ids.map(id => ({ id, connected: true }));
  assert.equal(createDraft.defaultCronAssistant(backends, roster, statuses)?.agentId, "shoggoth-main");
  assert.equal(createDraft.defaultCronAssistant(backends, roster, statuses.filter(({ id }) => id === "hermes"))?.agentId, "hermes-main");
  assert.equal(createDraft.defaultCronAssistant(backends, roster, statuses.filter(({ id }) => id === "openclaw"))?.agentId, "openclaw-main");
  assert.equal(createDraft.defaultCronAssistant(backends, roster, statuses.map(status => ({ ...status, disabled: status.id === "shoggoth" })))?.agentId,
    "hermes-main", "explicitly disconnected backends must never prefill the form");
  assert.equal(createDraft.defaultCronAssistant(backends, { ...roster, shoggoth: [{ id: "archived", isDefault: true, archived: true }] }, statuses)?.agentId,
    "hermes-main", "an archived primary is not a create target");
  assert.equal(createDraft.defaultCronAssistant(backends, roster, []), undefined);
  let draft = { ...createDraft.emptyCronCreateDraft(), name: "Keep name", prompt: "Keep prompt", everyMin: 37, atLocal: "2026-09-18T09:00" };
  assert.throws(() => createDraft.cronCreateInputFromDraft(draft, "openclaw", key => key), /nativeValidateAgent/);
  function Harness() {
    const [value, setValue] = React.useState(draft); draft = value;
    return React.createElement(createForm.default, { draft: value, setDraft: setValue, backends: [],
      agents: { shoggoth: [{ id: "same-id", name: "Codex", backendId: "shoggoth", codexAutomationOwner: true }] },
      loading: false, failedBackends: [], onRetry() {}, disabled: false });
  }
  let renderer;
  act(() => { renderer = create(React.createElement(Harness)); });
  assertTaskLayout(renderer, "agent-picker");
  for (const [backendId, kind] of [["openclaw", "openclaw"], ["hermes", "hermes"], ["codex", "native"], ["shoggoth", "native"], ["antigravity", "native"]]) {
    act(() => renderer.root.findByType("agent-picker").props.onChange({ backendId, agentId: "same-id" }));
    assert.equal(draft.taskModel, null, "a different backend/assistant resets the old task model");
    assert.equal(draft.name, "Keep name"); assert.equal(draft.prompt, "Keep prompt");
    assert.equal(draft.everyMin, 37); assert.equal(draft.atLocal, "2026-09-18T09:00");
    for (const schedKind of ["cron", "every", "at"]) {
      const input = createDraft.cronCreateInputFromDraft({ ...draft, schedKind }, kind, key => key);
      assert.equal(input.backendId, backendId); assert.equal(input.agentId, "same-id");
      assert.equal(input.origin, undefined, "even the Desktop owner creates a local Cron job");
      assert.equal(input.schedule.kind, schedKind);
      if (schedKind === "cron") assert.equal(input.schedule.expr, "0 9 * * *");
      if (schedKind === "every") assert.equal(input.schedule.everyMs, 37 * 60000);
      if (schedKind === "at") assert.equal(input.schedule.at, new Date(draft.atLocal).toISOString());
      if (kind === "openclaw") { assert.equal(input.wakeMode, "now"); assert.equal(input.payload.thinking, undefined); }
    }
    const model = kind === "openclaw" ? { model: "provider/preview-model" }
      : kind === "hermes" ? { model: "preview-model", provider: "hermes-provider" }
      : { model: "preview-model", bindingId: "binding", modelProviderRef: "@chatgpt" };
    act(() => renderer.root.findByType("task-model-picker").props.onChange(model));
    const input = createDraft.cronCreateInputFromDraft(draft, kind, key => key);
    if (kind === "openclaw") assert.equal(input.payload.model, model.model);
    if (kind === "hermes") assert.equal(input.provider, model.provider);
    if (kind === "native") assert.equal(input.modelSelection, model);
    act(() => renderer.root.findByType("agent-picker").props.onChange({ backendId, agentId: "same-id" }));
    assert.equal(draft.taskModel, model, "reselecting the same assistant keeps its task model");
  }
  assert.equal(createDraft.cronAgentAvailable({ archived: true }), false);
  assert.equal(createDraft.cronAgentAvailable({ lifecycleState: "provisioning" }), false);
  assert.equal(createDraft.cronAgentAvailable({ lifecycleState: "active" }), true);
  assert.equal(renderer.root.findAllByType("details").length, 0);
  act(() => renderer.unmount());
}
{
  const { CronTaskModelField } = load(path.join(uiRoot, "src/pages/cron/CronModelPicker.tsx"));
  const primary = { id: "vendor/model", name: "Default model", provider: "primary" };
  const secondary = { ...primary, name: "Another source", provider: "secondary" };
  const nativeDefault = { ...primary, bindingId: "binding", modelProviderRef: "@chatgpt" };
  const nativeAlternate = { ...nativeDefault, name: "Custom endpoint", modelProviderRef: "endpoint" };
  for (const [kind, active, other, defaultSelection, override] of [
    ["native", nativeDefault, nativeAlternate, { model: primary.id, bindingId: "binding", modelProviderRef: "@chatgpt" },
      { model: primary.id, bindingId: "binding", modelProviderRef: "endpoint" }],
    ["hermes", primary, secondary, { model: primary.id, provider: primary.provider },
      { model: secondary.id, provider: secondary.provider }],
    ["openclaw", primary, secondary, { model: `primary/${primary.id}` }, { model: `secondary/${secondary.id}` }],
  ]) {
    cronCatalog = { models: [other, active], defaultSelection };
    const changes = [];
    const onChange = (value) => changes.push(value);
    const field = (value) => React.createElement(CronTaskModelField, { backendId: kind, agentId: "agent", kind, value, onChange });
    let renderer;
    act(() => { renderer = create(field(null)); });
    const menu = () => renderer.root.findByType("model-menu").props;
    assert.equal(menu().emptyLabel, undefined, `${kind}: only catalog rows are options`);
    assert.equal(menu().activeModel, active.id);
    assert.equal(menu().activeProvider, active.provider);
    assert.equal(menu().activeBindingId, active.bindingId);
    assert.equal(menu().activeModelProviderRef, active.modelProviderRef);
    const select = ({ id, provider, bindingId, modelProviderRef }) => {
      act(() => menu().onSelect(id, provider, bindingId, modelProviderRef));
    };
    select(active);
    assert.equal(changes.length, 0, "reselecting the inherited default preserves the draft");
    select(other);
    assert.deepEqual(JSON.parse(JSON.stringify(changes[0])), override, "same-ID alternatives retain their source");
    act(() => renderer.update(field(changes[0])));
    select(active);
    assert.equal(changes[1], null, "selecting the default clears the override");

    cronCatalog = { models: [other], defaultSelection };
    act(() => renderer.update(field(null)));
    assert.equal(menu().activeModel, "", "a missing default cannot activate another source with the same ID");
    act(() => renderer.unmount());
  }
}
console.log("PASS Cron simplified forms: advanced options stay hidden and survive edits; required assistant selection preserves common fields and routes all three schedule types to the selected backend");
