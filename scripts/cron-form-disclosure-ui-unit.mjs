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
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Intl, Date,
    require: name => {
      if (name === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
      if (name.endsWith("/Field")) return fields;
      if (name.endsWith("/i18n")) return { t: key => key };
      if (name === "./CronAgentPicker") return { __esModule: true, default: host("agent-picker") };
      if (name === "./CronModelPicker") return { OpenClawModelPicker: host("model-picker"), OpenClawFallbackPicker: host("fallback-picker"), HermesModelPicker: host("hermes-model-picker") };
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
}
for (const test of cases) {
  for (const customized of [false, true]) {
    let draft = { ...test.empty(), name: "Original", prompt: "Keep this prompt", ...(customized ? test.advanced : {}) };
    const before = JSON.stringify(test.toInput(draft));
    function Harness() {
      const [value, setValue] = React.useState(draft);
      draft = value;
      return React.createElement(test.mod.default, { draft: value, setDraft: setValue, showTarget: true,
        agents: [{ id: "fixture-agent", name: "Fixture" }], models: [], modelsLoading: false });
    }
    let renderer;
    act(() => { renderer = create(React.createElement(Harness)); });
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
  let draft = { ...createDraft.emptyCronCreateDraft(), name: "Keep name", prompt: "Keep prompt", everyMin: 37, atLocal: "2026-09-18T09:00" };
  assert.throws(() => createDraft.cronCreateInputFromDraft(draft, "openclaw", key => key), /nativeValidateAgent/);
  function Harness() {
    const [value, setValue] = React.useState(draft); draft = value;
    return React.createElement(createForm.default, { draft: value, setDraft: setValue, backends: [], agents: {},
      loading: false, failedBackends: [], onRetry() {}, disabled: false });
  }
  let renderer;
  act(() => { renderer = create(React.createElement(Harness)); });
  for (const [backendId, kind] of [["openclaw", "openclaw"], ["hermes", "hermes"], ["codex", "native"], ["antigravity", "native"]]) {
    act(() => renderer.root.findByType("agent-picker").props.onChange({ backendId, agentId: "same-id" }));
    assert.equal(draft.name, "Keep name"); assert.equal(draft.prompt, "Keep prompt");
    assert.equal(draft.everyMin, 37); assert.equal(draft.atLocal, "2026-09-18T09:00");
    for (const schedKind of ["cron", "every", "at"]) {
      const input = createDraft.cronCreateInputFromDraft({ ...draft, schedKind }, kind, key => key);
      assert.equal(input.backendId, backendId); assert.equal(input.agentId, "same-id");
      assert.equal(input.schedule.kind, schedKind);
      if (schedKind === "cron") assert.equal(input.schedule.expr, "0 9 * * *");
      if (schedKind === "every") assert.equal(input.schedule.everyMs, 37 * 60000);
      if (schedKind === "at") assert.equal(input.schedule.at, new Date(draft.atLocal).toISOString());
      if (kind === "openclaw") { assert.equal(input.wakeMode, "now"); assert.equal(input.payload.thinking, undefined); }
    }
  }
  assert.equal(createDraft.cronAgentAvailable({ archived: true }), false);
  assert.equal(createDraft.cronAgentAvailable({ lifecycleState: "provisioning" }), false);
  assert.equal(createDraft.cronAgentAvailable({ lifecycleState: "active" }), true);
  assert.equal(renderer.root.findAllByType("details").length, 0);
  act(() => renderer.unmount());
}
console.log("PASS Cron simplified forms: advanced options stay hidden and survive edits; required assistant selection preserves common fields and routes all three schedule types to the selected backend");
