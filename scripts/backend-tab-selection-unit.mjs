import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const ts = require("typescript");
const settle = async callback => act(async () => { callback?.(); await new Promise(setImmediate); });
const pages = [["usage", "usage"], ["skills", "skills"], ["tasks", "kanban"], ["agents", "agents"], ["models", "models"]];

function fixture({ storage = new Map(), disabled = [], descriptors = async () => [], config, desktop = true } = {}) {
  const modules = new Map(), timers = new Map(), listeners = new Map();
  let timerId = 0;
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (event, callback) => listeners.set(event, callback),
    ...(desktop ? { openclawDesktop: { getConfig: () => ({ disabledBackends: disabled }) } } : {}),
  };
  // Replace only the DOM-dependent Base UI shell. The production tab list,
  // ordering, click handlers, backend hooks and persisted state all run unchanged.
  const TabContext = React.createContext(null);
  const children = props => props.children;
  const Tabs = {
    Root: props => React.createElement(TabContext.Provider, { value: props }, props.children),
    List: props => React.createElement("div", { role: "tablist" }, props.children),
    Indicator: React.forwardRef(() => null),
    Tab: props => {
      const context = React.useContext(TabContext);
      return React.createElement("button", { role: "tab", value: props.value,
        "aria-selected": context.value === props.value, onClick: () => context.onValueChange(props.value) }, props.children);
    },
  };
  const stubs = {
    "react-i18next": { useTranslation: () => ({ t: key => key }) },
    "@base-ui/react/tabs": { Tabs },
    "@base-ui/react/tooltip": { Tooltip: { Provider: children, Root: children, Trigger: props => props.render,
      Portal: () => null, Positioner: children, Popup: children } },
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, window,
      require: name => {
        if (stubs[name]) return stubs[name];
        if (name === "../api/client") return { getBackendDescriptors: descriptors,
          getConfig: config ?? (async () => ({ disabledBackends: disabled })) };
        if (name.endsWith(".css")) return { __esModule: true, default: {} };
        if (!name.startsWith(".")) return require(name);
        const resolved = path.resolve(path.dirname(file), name);
        if (name.endsWith(".json")) return require(resolved);
        return load(fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : `${resolved}.tsx`);
      },
    }, { filename: file });
    return module.exports;
  }
  const backends = load(path.join(uiRoot, "src/lib/backends.ts"));
  const BackendTabs = load(path.join(uiRoot, "src/components/BackendTabs.tsx")).default;
  const flush = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  async function mount(name, surface = name, initial) {
    function Page() {
      const [backend, setBackend] = backends.useBackendState(name, initial, { surface });
      return React.createElement("main", { "data-backend": backend },
        React.createElement(BackendTabs, { value: backend, onChange: setBackend, surface }));
    }
    let renderer;
    await settle(() => { renderer = create(React.createElement(Page)); });
    return {
      backend: () => renderer.root.findByType("main").props["data-backend"],
      tabs: () => renderer.root.findAllByProps({ role: "tab" }).map(tab => ({ id: tab.props.value, selected: tab.props["aria-selected"] })),
      select: id => settle(() => renderer.root.findByProps({ role: "tab", value: id }).props.onClick()),
      unmount: () => settle(() => renderer.unmount()),
    };
  }
  return { ...backends, mount, storage, flush, pagehide: () => listeners.get("pagehide")?.() };
}

const savedStorage = values => new Map([["shoggoth.ui.v1", JSON.stringify({ version: 1, values })]]);
const savedValues = f => JSON.parse(f.storage.get("shoggoth.ui.v1")).values;

// Each page has its own preference, retained both across navigation and restart.
{
  const f = fixture();
  for (const [name, surface] of pages) {
    const page = await f.mount(name, surface);
    assert.deepEqual(page.tabs(), [
      { id: "shoggoth", selected: true }, { id: "hermes", selected: false }, { id: "openclaw", selected: false },
    ], `${name}: a fresh page selects its first visible tab`);
    assert.equal(page.backend(), "shoggoth");
    await page.select("hermes");
    assert.equal(page.backend(), "hermes");
    await page.unmount();
    const revisited = await f.mount(name, surface);
    assert.equal(revisited.backend(), "hermes", `${name}: returning restores the user's selection`);
    await revisited.unmount();
  }
  f.pagehide();
  const restarted = fixture({ storage: f.storage });
  for (const [name, surface] of pages) {
    const page = await restarted.mount(name, surface);
    assert.equal(page.backend(), "hermes", `${name}: restart restores localStorage`);
    await page.unmount();
  }
  const usage = await restarted.mount("usage");
  await usage.select("openclaw");
  const skills = await restarted.mount("skills");
  assert.equal(skills.backend(), "hermes", "a page selection does not overwrite other pages");
  await usage.unmount();
  await skills.unmount();
}

// Existing valid preferences remain authoritative; route targets override them.
for (const [name, surface] of pages) {
  const f = fixture({ storage: savedStorage({ [`backend.${name}`]: "openclaw" }) });
  let page = await f.mount(name, surface);
  assert.equal(page.backend(), "openclaw", `${name}: keep existing valid cached choices`);
  await page.unmount();
  page = await f.mount(name, surface, "hermes");
  assert.equal(page.backend(), "hermes", `${name}: an explicit deep link wins`);
  await page.unmount();
}

// Default selection stays derived from the visible list, including late config.
{
  let resolveConfig;
  const f = fixture({ desktop: false, config: () => new Promise(resolve => { resolveConfig = resolve; }) });
  const page = await f.mount("usage");
  assert.equal(page.backend(), "shoggoth");
  await settle(() => resolveConfig({ disabledBackends: ["shoggoth"] }));
  assert.deepEqual(page.tabs(), [{ id: "hermes", selected: true }, { id: "openclaw", selected: false }]);
  await page.unmount();
  f.flush();
  assert.equal(savedValues(f)["backend.usage"], "", "a computed default must not become a cached user choice");
  const restarted = fixture({ storage: f.storage });
  const restored = await restarted.mount("usage");
  assert.equal(restored.backend(), "shoggoth", "a fresh preference follows the current first tab after restart");
  await restored.unmount();
}

// Invalid or disconnected choices fall back in tab order, without losing intent.
for (const selected of ["missing", "shoggoth", "old-shoggoth", 42, null]) {
  const f = fixture({ disabled: ["shoggoth"], storage: savedStorage({ "backend.usage": selected }),
    descriptors: async () => f.FALLBACK_BACKEND_DESCRIPTORS.map(d => d.id === "shoggoth" ? { ...d, aliases: ["old-shoggoth"] } : d) });
  const page = await f.mount("usage");
  assert.equal(page.backend(), "hermes", `invalid/unavailable ${selected}: choose the first visible tab`);
  await settle(() => f.applyDisabledBackends([]));
  assert.equal(page.backend(), "shoggoth");
  await page.select("openclaw");
  await settle(() => f.applyDisabledBackends(["openclaw"]));
  assert.equal(page.backend(), "shoggoth");
  await settle(() => f.applyDisabledBackends([]));
  assert.equal(page.backend(), "openclaw", "a temporary disconnect preserves the user's preference");
  await page.unmount();
}

// Registry capabilities, aliases and delayed responses use the same visible tabs.
{
  let resolveDescriptors;
  const f = fixture({ descriptors: () => new Promise(resolve => { resolveDescriptors = resolve; }),
    storage: savedStorage({ "backend.usage": "legacy-hermes" }) });
  const page = await f.mount("usage");
  assert.equal(page.backend(), "shoggoth");
  await settle(() => resolveDescriptors(f.FALLBACK_BACKEND_DESCRIPTORS.map(d => ({ ...d,
    aliases: d.id === "hermes" ? ["legacy-hermes"] : [],
    surfaces: { ...d.surfaces, usage: d.id !== "shoggoth" },
  }))));
  assert.equal(page.backend(), "hermes", "an alias resolves once the registry arrives");
  assert.deepEqual(page.tabs(), [{ id: "hermes", selected: true }, { id: "openclaw", selected: false }]);
  const noPreference = await f.mount("fresh-usage", "usage");
  assert.equal(noPreference.backend(), "hermes", "unsupported surfaces cannot be the default");
  await settle(() => f.applyDisabledBackends(["hermes"]));
  assert.equal(page.backend(), "openclaw", "aliases cannot bypass availability checks");
  assert.equal(page.tabs().length, 0, "a single available backend keeps the tabs hidden");
  await page.unmount();
  await noPreference.unmount();
}

// New registry backends retain their identity; no implicit OpenClaw preference.
{
  const f = fixture({ descriptors: async () => ["future-b", "future-a"].map(id => ({
    ...f.FALLBACK_BACKEND_DESCRIPTORS[0], id, name: id,
  })) });
  const page = await f.mount("usage");
  assert.equal(page.backend(), "future-b");
  assert.equal(page.tabs()[0].selected, true);
  await page.select("future-a");
  assert.equal(page.backend(), "future-a");
  await page.unmount();
}

console.log("PASS backend tabs: five page preferences, first visible default, navigation/restart, cache isolation, deep links, disabled/invalid values, aliases and late registry/config");
