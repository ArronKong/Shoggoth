import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const React = require("react"), Renderer = require("react-test-renderer"), ts = require("typescript"), i18next = require("i18next");
function load(file, imports = {}) {
  const module = { exports: {} }, localRequire = createRequire(new URL(file, import.meta.url));
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, AbortController, URL, setInterval, clearInterval, setTimeout, clearTimeout, require: name => name in imports ? imports[name] : name.endsWith(".module.css") ? { __esModule: true, default: {} } : name.startsWith(".") ? localRequire(name) : require(name) });
  return module.exports;
}
const previewModule = load("../app/manage-ui/src/lib/connectorToolPreviews.ts");
const { getConnectorToolPreview } = previewModule;
const { mcpRecommendationOrder } = load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts");
const { TOOL_DEFS } = createRequire(import.meta.url)("../app/agent-service/official-skill-runtime.js");
const { SUPPORTED_TOOLS } = createRequire(import.meta.url)("../app/agent-service/shop-skill-runtime.js");
const exact = { ...Object.fromEntries(Object.entries(TOOL_DEFS).map(([id, tools]) => [id, tools.map(tool => tool[0])])), shop: SUPPORTED_TOOLS,
  ticketmaster: createRequire(import.meta.url)("../app/agent-service/ticketmaster-runtime.js").TOOLS.map(tool => tool.name),
  flightaware: createRequire(import.meta.url)("../app/agent-service/flightaware-runtime.js").TOOLS.map(tool => tool.name) };
for (const id of [...mcpRecommendationOrder, "figma-desktop"]) {
  const english = getConnectorToolPreview(id, "en"), chinese = getConnectorToolPreview(id, "zh-CN");
  assert.ok(english?.items.length, `${id}: preview is available before setup`);
  assert.equal(chinese.items.length, english.items.length);
  assert.match(english.sourceUrl, /^https:\/\//u, `${id}: includes a source guide`);
  assert.equal(english.sourceUrl, chinese.sourceUrl);
  assert.equal(new Set(english.items.map(tool => tool.name)).size, english.items.length, `${id}: unique names`);
  for (const [index, item] of english.items.entries()) {
    assert.ok(item.name && item.description && chinese.items[index].description);
    assert.notEqual(item.description, chinese.items[index].description, `${id}: bilingual purpose`);
    if (english.kind === "tools") {
      assert.ok(exact[id]?.includes(item.name), `${id}: ${item.name} exists in the owning runtime`);
      assert.equal(item.name, chinese.items[index].name, "actual tool identifiers are not translated");
    } else assert.notEqual(item.name, chinese.items[index].name, `${id}: operation labels follow the app language`);
  }
}
for (const id of ["unknown-custom", "__proto__", "constructor", "GitHub"]) assert.equal(getConnectorToolPreview(id), undefined);
assert.equal(JSON.stringify(getConnectorToolPreview("figma-desktop", "en")).includes("does not write to the canvas"), true);
console.log(`PASS bilingual preview catalog: ${mcpRecommendationOrder.length} identities, desktop Figma, sources and fixed-runtime tool names`);

const resources = load("../app/manage-ui/src/i18n/mcpConnectorResources.ts").mcpConnectorResources;
const translator = i18next.createInstance();
await translator.init({ lng: "en", resources: Object.fromEntries(["en", "zh-CN"].map(language => [language, { translation: { mcpConnectors: resources[language] } }])) });
let requests = [], previewLoads = 0;
let fetcher = async id => ({ id, available: false, items: [], totalCount: 0, checkedAt: null });
const Tools = load("../app/manage-ui/src/components/ConnectorTools.tsx", {
  "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator), i18n: translator }) },
  "../lib/connectorToolPreviews": new Proxy(previewModule, { get(target, key) { if (key === "getConnectorToolPreview") previewLoads++; return target[key]; } }),
  "../api/mcpConnectors": { listMcpTools: (id, signal) => { requests.push({ id, signal }); return fetcher(id, signal); } },
}).default;
let ui;
const render = async props => Renderer.act(async () => { if (ui) ui.update(React.createElement(Tools, props)); else ui = Renderer.create(React.createElement(Tools, props)); });
const toggle = async open => Renderer.act(async () => ui.root.findByType("details").props.onToggle({ currentTarget: { open } }));
const text = () => JSON.stringify(ui.toJSON());
const list = () => ui.root.findAllByType("ul")[0];
const names = () => ui.root.findAllByType("strong").map(node => node.props.children);
const unmount = async () => { await Renderer.act(async () => ui.unmount()); ui = null; };
const liveResult = (id, items = [{ name: "actual_account_tool", description: "Current account tool description" }]) => ({ id, available: true, items, totalCount: items.length, checkedAt: 2 });

await render({ previewId: "github" });
assert.equal(previewLoads, 0, "collapsed details do not load preview data");
assert.equal(requests.length, 0);
await toggle(true);
assert.equal(previewLoads, 1);
assert.equal(requests.length, 0, "unconnected preview never contacts a service");
assert.equal(list().props["data-tool-list"], "preview");
assert.ok(text().includes("Search repositories"));
assert.ok(text().includes(translator.t("mcpConnectors.flow.operationsPreviewHint")));
assert.ok(ui.root.findByType("a").props.href.startsWith("https://"));

await render({ previewId: "github", serverId: "installed", status: "signedOut" });
assert.equal(requests.length, 1);
assert.equal(list().props["data-tool-list"], "preview");
fetcher = async id => liveResult(id);
await render({ previewId: "github", serverId: "installed", status: "ready", checkedAt: 2 });
assert.equal(list().props["data-tool-list"], "live");
assert.deepEqual(names(), ["actual_account_tool"], "actual tools replace rather than merge with previews");
assert.ok(!text().includes("Search repositories"));
assert.ok(!text().includes(translator.t("mcpConnectors.flow.operationsPreviewHint")));

fetcher = async id => liveResult(id, []);
await render({ previewId: "github", serverId: "installed", status: "ready", checkedAt: 3 });
assert.equal(list().props["data-tool-list"], "live");
assert.equal(names().length, 0, "an actual empty list is authoritative");
assert.ok(!text().includes("Search repositories"));

fetcher = async id => ({ ...liveResult(id), available: false, items: [] });
await render({ previewId: "github", serverId: "installed", status: "ready", checkedAt: 4 });
assert.equal(list().props["data-tool-list"], "preview", "restart without an in-memory snapshot falls back to preview");
assert.ok(text().includes(translator.t("mcpConnectors.flow.refreshPreview")));
await render({ previewId: "github", serverId: "installed", status: "failed", checkedAt: 5 });
assert.equal(list().props["data-tool-list"], "preview");
assert.ok(!text().includes("actual_account_tool"), "failed checks do not preserve old live tools");

fetcher = async () => { throw Error("credential-canary-private-error"); };
await render({ previewId: "github", serverId: "installed", status: "failed", checkedAt: 6 });
assert.equal(list().props["data-tool-list"], "preview", "local API failures do not hide the preview");
assert.equal(ui.root.findAllByProps({ role: "alert" }).length, 1);
assert.ok(!text().includes("credential-canary"));
fetcher = async id => liveResult(id);
await Renderer.act(async () => ui.root.findByType("button").props.onClick());
assert.equal(ui.root.findAllByProps({ role: "alert" }).length, 0);
assert.equal(list().props["data-tool-list"], "live");
await unmount();

requests = [];
await render({ previewId: "quark-drive" }); await toggle(true);
assert.ok(text().includes("search_files"));
assert.ok(text().includes("Find files in Quark Drive."));
await translator.changeLanguage("zh-CN");
await render({ previewId: "quark-drive" });
assert.ok(text().includes("查找夸克网盘文件。"));
assert.equal(requests.length, 0, "language changes remain offline");
await render({ previewId: "github" });
assert.ok(text().includes("搜索代码仓库"));
assert.ok(!text().includes("search_files"), "changing connector cannot show a previous connector's preview");
await unmount();

await render({}); await toggle(true);
assert.equal(names().length, 0);
assert.ok(text().includes(translator.t("mcpConnectors.flow.toolsAfterCheck")), "unknown custom services do not get guessed tools");
await unmount();
const beforeDevice = requests.length, beforePreview = previewLoads;
await render({ items: [{ name: "apple_calendar_events", description: "Read events" }], previewId: "github", serverId: "unused" });
await toggle(true);
assert.equal(list().props["data-tool-list"], "device");
assert.equal(requests.length, beforeDevice);
assert.equal(previewLoads, beforePreview, "system-defined operations bypass MCP previews");
await unmount();

await translator.changeLanguage("en");
const pending = new Map();
fetcher = id => new Promise(resolve => pending.set(id, resolve));
await render({ previewId: "github", serverId: "old", status: "ready" }); await toggle(true);
await render({ previewId: "notion", serverId: "new", status: "ready" });
assert.equal(requests.find(value => value.id === "old").signal.aborted, true);
await Renderer.act(async () => pending.get("new")(liveResult("new", [{ name: "new_account_tool", description: "New account" }])));
await Renderer.act(async () => pending.get("old")(liveResult("old", [{ name: "stale_account_tool", description: "Old account" }])));
assert.deepEqual(names(), ["new_account_tool"], "late reads cannot replace the current account's list");
await toggle(false);
assert.equal(requests.find(value => value.id === "new").signal.aborted, true);
await unmount();

let refreshCount = 0;
fetcher = async id => liveResult(id, Array.from({ length: 8 }, (_, index) => ({ name: `tool_${++refreshCount}_${index}`, description: `Purpose ${index}` })));
await render({ previewId: "shop", serverId: "official", refreshKey: 0 }); await toggle(true);
const firstNames = names();
await render({ previewId: "shop", serverId: "official", refreshKey: 1 });
assert.notDeepEqual(names(), firstNames, "official tool-setting changes refresh the actual snapshot");
const beforeSearch = requests.length;
await Renderer.act(async () => ui.root.findByType("input").props.onChange({ target: { value: "Purpose 4" } }));
assert.equal(names().length, 1);
assert.equal(requests.length, beforeSearch, "tool search is local");
await unmount();
console.log("PASS actual React tool details: offline/lazy previews, live replacement, empty results, restart/failure fallback, safe retry, localization, identity changes, aborted late reads, official refresh and local search");

// Exercise the real dialog entry points so the catalog cannot silently become
// unreachable from recommended, installed, official or desktop connections.
let observedTools;
const helper = load("../app/manage-ui/src/lib/mcpConnectorUi.ts");
const shared = {
  "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator), i18n: translator }) },
  "../components/ConnectorTools": { __esModule: true, default: props => { observedTools = props; return null; } },
  "../components/McpConnectorIcon": { __esModule: true, default: () => null },
  "../components/Modal": { __esModule: true, default: ({ children, footer, subtitle }) => React.createElement("section", {}, children, React.createElement("p", {}, subtitle), footer) },
  "../components/ui": { useConfirm: () => async () => true },
  "../lib/mcpConnectorUi": helper,
  "../lib/mcpRecommendationCatalog": load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts"),
  "../lib/usePageCache": {},
  "../api/mcpConnectors": {
    listMcpSubjects: async () => ({ items: [], unavailableBackends: [] }),
    searchMcpRegistry: async () => ({ items: [] }),
    getMcpOAuthInfo: async () => ({ redirectUri: "http://127.0.0.1:18873/callback" }),
    formatMcpError: () => "safe-error",
  },
};
const Dialog = load("../app/manage-ui/src/pages/McpConnectorDialog.tsx", shared).default;
const mountDialog = async props => Renderer.act(async () => { ui = Renderer.create(React.createElement(Dialog, { onChanged() {}, onClose() {}, ...props })); });
const presetRows = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/mcp-featured-presets.json", import.meta.url)));
for (const recommendation of presetRows) {
  await mountDialog({ recommendation, catalogEntry: true });
  assert.equal(observedTools.previewId, recommendation.id, `${recommendation.id}: preview is wired before adding`);
  assert.equal(observedTools.serverId, undefined);
  await unmount();
}
const figma = { registryName: helper.FIGMA_REGISTRY_NAME, name: "Figma", options: [] };
await mountDialog({ item: figma, allowFigmaDesktop: true });
assert.equal(observedTools.previewId, "figma-desktop");
await Renderer.act(async () => ui.root.findAllByType("button").find(node => node.props.children === translator.t("mcpConnectors.figmaDesktop.remote")).props.onClick());
assert.equal(observedTools.previewId, "figma", "Figma mode switch updates the preview without connecting");
await unmount();
await mountDialog({ item: { registryName: "io.github.github/github-mcp-server", name: "GitHub", options: [] } });
assert.equal(observedTools.previewId, "github", "registry identity resolves preview metadata");
await unmount();
const custom = { id: "custom-server", name: "GitHub", source: { kind: "custom" }, transport: { kind: "remote", protocol: "streamable-http", url: "https://unrelated.example/mcp" }, auth: { kind: "none" }, status: "needsSetup", setup: { requiredFields: [], configuredFields: [] }, disabledProfileIds: [], lastCheck: null };
await mountDialog({ server: custom });
assert.equal(observedTools.previewId, undefined, "a custom display name cannot select an official preview");
await unmount();
await mountDialog({ server: { ...custom, source: { kind: "registry", registryName: "io.github.github/github-mcp-server", version: "1.0.0" } } });
assert.equal(observedTools.previewId, "github", "installed registry connections keep their preview without a catalog lookup");
await unmount();

const officialDefinitions = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/official-skill-connectors.json", import.meta.url)));
const officialModule = load("../app/manage-ui/src/pages/OfficialSkillConnectors.tsx", { ...shared, "../api/officialSkillConnectors": {}, "./McpConnectorDialog": { __esModule: true, default: () => null } });
for (const definition of officialDefinitions) {
  await Renderer.act(async () => { ui = Renderer.create(React.createElement(officialModule.default, { id: definition.id, model: { busy: false, data: { items: [{ id: definition.id, revision: 3, state: "notInstalled", canRemove: false }] } }, onClose() {}, onChanged() {} })); });
  assert.equal(observedTools.previewId, definition.id);
  assert.equal(observedTools.refreshKey, "3:0");
  await unmount();
}
const lark = load("../app/manage-ui/src/pages/LarkCliConnector.tsx", { ...shared, "../api/larkCliConnector": {}, "./LarkCliSetup": { useLarkCliSetup: () => ({ active: false, working: false }), useLarkCliSetupView: () => ({ content: null, actions: null }) } });
await Renderer.act(async () => { ui = Renderer.create(React.createElement(lark.default, { model: { busy: false, setup: {}, data: { state: "notInstalled", canRemove: false } }, onClose() {} })); });
assert.equal(observedTools.previewId, "lark-cli");
assert.equal(observedTools.serverId, undefined, "CLI capabilities do not fabricate an MCP service");
await unmount();
console.log(`PASS actual dialog integration: ${presetRows.length} presets, registry/installed identities, both Figma modes, custom-name isolation, ${officialDefinitions.length} official connectors and Lark CLI`);

// The compact overview must remain read-only; real tools are fetched only when
// requested and retain the same authoritative/abort semantics as disclosures.
requests = [];
fetcher = async id => liveResult(id, []);
await render({ overview: true, previewId: 'github', serverId: 'installed', status: 'ready', description: 'Connector summary' });
assert.equal(requests.length, 0, 'opening the overview does not probe or fetch actual tools');
assert.equal(ui.root.findAllByType('li').length, 3, 'overview shows at most three known capabilities');
assert.ok(text().includes('Search repositories'));
const switchView = () => Renderer.act(async () => ui.root.findAllByType('button').find(node => typeof node.props['aria-expanded'] === 'boolean').props.onClick());
await switchView();
assert.equal(requests.length, 1);
assert.equal(list().props['data-tool-list'], 'live');
assert.equal(ui.root.findAllByType('li').length, 0, 'an authoritative empty snapshot also replaces the overview preview in tool view');
assert.equal(ui.root.findAllByType('button')[0].props['aria-expanded'], true);
await switchView();
assert.equal(requests[0].signal.aborted, true, 'returning to overview cancels late reads');
assert.equal(ui.root.findAllByType('li').length, 3);
await render({ overview: true, previewId: 'unknown-custom', description: 'User supplied summary' });
assert.equal(ui.root.findAllByType('li').length, 0, 'unknown custom connectors do not invent capabilities');
assert.ok(text().includes('User supplied summary'));
await unmount();
console.log('PASS compact overview: bounded known capabilities, no implicit service requests, explicit tool view, empty live authority, cancellation and honest custom fallback');
