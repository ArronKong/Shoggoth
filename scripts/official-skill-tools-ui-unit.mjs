import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const React = require("react"), Renderer = require("react-test-renderer"), ts = require("typescript");
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, imports = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Event, AbortController, require: name => name in imports ? imports[name] : require(name) });
  return module.exports;
}
const catalog = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/official-skill-connectors.json", import.meta.url)));
const helpers = load("../app/manage-ui/src/lib/mcpConnectorUi.ts");
const Modal = ({ children }) => React.createElement("section", { role: "dialog" }, children);
const common = {
  "react-i18next": { useTranslation: () => ({ t: key => key, i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" } }) },
  "../components/Modal": { __esModule: true, default: Modal },
  "../components/McpConnectorIcon": { __esModule: true, default: props => React.createElement("span", { "data-icon": props.identity }) },
  "../../../core/flightaware-connector-policy.json": { __esModule: true, default: JSON.parse(fs.readFileSync(new URL("../app/core/flightaware-connector-policy.json", import.meta.url))) },
  "../components/ui": { useConfirm: () => async () => true },
  "../lib/mcpConnectorUi": helpers,
  "./ConnectorsPage.module.css": { __esModule: true, default: {} },
  "../lib/mcpRecommendationCatalog": load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts"),
  "../../../agent-service/data/mcp-featured-presets.json": { __esModule: true, default: [] },
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const receipts = [];

for (const definition of catalog) {
  const server = { id: `official-${definition.id}-test`, name: definition.name, enabled: true, status: "ready",
    source: { kind: "custom" }, transport: { kind: "stdio-command", command: "/managed/node" },
    disabledProfileIds: [], setup: { requiredFields: definition.fields.filter(field => field.required).map(field => `env:${field.name}`), configuredFields: definition.fields.map(field => `env:${field.name}`) },
    lastCheck: { toolCount: 5, errorCode: null }, auth: { kind: "none" } };
  let permissionChanges = 0, changed = 0, secretWrites = 0, toolReads = 0;
  const api = {
    listMcpConnectors: async () => ({ revision: 2, servers: [server] }),
    listMcpSubjects: async () => ({ items: [{ profileId: "profile-a", label: "Fixture agent", backendId: "shoggoth" }], unavailableBackends: [] }),
    setMcpAgents: async (id, disabledProfileIds, revision) => {
      assert.equal(id, server.id); assert.equal(revision, 2); assert.deepEqual(plain(disabledProfileIds), ["profile-a"]);
      permissionChanges++; return { revision: 3, server: { ...server, disabledProfileIds } };
    },
    listMcpTools: async (id, signal) => {
      assert.equal(id, server.id); assert.equal(signal.aborted, false); toolReads++;
      return { available: true, totalCount: 1, items: [{ name: "fixture_readonly", description: "Read-only fixture tool" }] };
    },
    saveMcpCredentials: async () => { secretWrites++; throw Error("Managed tools view must not write credentials"); },
    formatMcpError: () => "unexpected-mcp-error",
  };
  const ConnectorTools = load("../app/manage-ui/src/components/ConnectorTools.tsx", {
    ...common, "../api/mcpConnectors": api, "../pages/ConnectorsPage.module.css": { __esModule: true, default: {} },
  }).default;
  const McpDialog = load("../app/manage-ui/src/pages/McpConnectorDialog.tsx", {
    ...common, "../api/mcpConnectors": api, "../components/ConnectorTools": { __esModule: true, default: ConnectorTools },
  }).default;
  const accountName = `Checked account ${definition.id}`;
  let holdNextAccount = false, releaseAccount = null;
  const OfficialDialog = load("../app/manage-ui/src/pages/OfficialSkillConnectors.tsx", {
    ...common, "../api/mcpConnectors": api,
    "../api/officialSkillConnectors": {
      officialAccount: async () => {
        const result = { id: definition.id, state: "ready", verificationUrl: null, qrCode: null, userCode: null, userName: accountName, errorCode: null };
        if (holdNextAccount) { holdNextAccount = false; return new Promise(resolve => { releaseAccount = () => resolve(result); }); }
        return result;
      },
      officialConnectorErrorKey: () => "failed",
    },
    "../lib/usePageCache": {},
    "../components/McpConnectorIcon": { __esModule: true, default: () => null },
    "../components/ConnectorTools": { __esModule: true, default: ConnectorTools },
    "./McpConnectorDialog": { __esModule: true, default: McpDialog },
    "../../../agent-service/data/official-skill-connectors.json": { __esModule: true, default: catalog },
  }).default;
  // The official installation revision deliberately stays unchanged when MCP
  // permissions/credentials change. The nested callback must invalidate its
  // earlier account result independently of an installation-state refresh.
  const model = { data: { items: [{ id: definition.id, revision: 5, state: "installed", stage: null, version: definition.version,
    installedVersion: definition.version, skillCount: 1, serverId: server.id, canRemove: true, errorCode: null }] },
    busy: false, loading: false, error: null, refresh: async () => {}, change: async () => {} };
  let rendered;
  const checkLabel = ["fliggy", "baidu-maps"].includes(definition.id) ? "officialConnectors.checkService" : "officialConnectors.check";
  const button = key => rendered.root.findAllByType("button").find(node => node.props.children === key);
  const click = async key => Renderer.act(async () => { const target = button(key); assert.ok(target, key); target.props.onClick(); await flush(); });
  try {
    await Renderer.act(async () => { rendered = Renderer.create(React.createElement(OfficialDialog, {
      id: definition.id, model, onClose() {}, onChanged() { changed++; },
    })); await flush(); });
    await click(checkLabel);
    assert.ok(JSON.stringify(rendered.toJSON()).includes(accountName));
    await click("officialConnectors.toolSettings");
    assert.equal(rendered.root.findByType(McpDialog).props.managed, true);
    const managedView = rendered.root.findByType(McpDialog);
    const managedButton = key => managedView.findAllByType("button").find(node => node.props.children === key);
    assert.equal(managedView.findAllByType("textarea").length, 0);
    assert.equal(managedView.findAllByType("input").filter(node => node.props.type !== "checkbox").length, 0,
      `${definition.id}: the managed tools view must not offer a second credential form`);
    for (const key of ["mcpConnectors.save", "mcpConnectors.showValue", "mcpConnectors.hideValue"])
      assert.equal(managedButton(key), undefined, `${definition.id}: ${key}`);
    assert.ok(managedButton("mcpConnectors.verify"), "readiness verification remains available");
    assert.equal(rendered.root.findAllByType("input").filter(node => node.props.type !== "checkbox").length
      + rendered.root.findAllByType("textarea").length, definition.fields.length,
      "the original official setup form remains the only credential form while management is embedded");
    assert.equal(toolReads, 0, "tool metadata is lazy and does not run business tools on opening settings");
    await Renderer.act(async () => {
      rendered.root.findByType(ConnectorTools).findByType("details").props.onToggle({ currentTarget: { open: true } });
      await flush();
    });
    assert.equal(toolReads, 1); assert.equal(secretWrites, 0);
    assert.ok(JSON.stringify(rendered.toJSON()).includes("fixture_readonly"));
    const checkbox = managedView.findAllByType("input").find(node => node.props.type === "checkbox");
    assert.ok(checkbox, "per-agent access remains available");
    await Renderer.act(async () => { checkbox.props.onChange({ target: { checked: false } }); await flush(); });
    assert.equal(permissionChanges, 1); assert.equal(secretWrites, 0);
    assert.equal(JSON.stringify(rendered.toJSON()).includes(accountName), false,
      "a real nested permission change immediately invalidates the checked account");
    await click(checkLabel);
    assert.ok(JSON.stringify(rendered.toJSON()).includes(accountName));
    holdNextAccount = true;
    await click(checkLabel);
    assert.equal(typeof releaseAccount, "function", "a delayed read is actually pending");
    await Renderer.act(async () => { rendered.root.findByType(McpDialog).props.onChanged(); await flush(); });
    await Renderer.act(async () => { releaseAccount(); await flush(); });
    assert.equal(JSON.stringify(rendered.toJSON()).includes(accountName), false,
      "an account response started before a connection change cannot republish stale identity");
    await Renderer.act(async () => { rendered.root.findByType(McpDialog).props.onClose(); await flush(); });
    const text = JSON.stringify(rendered.toJSON());
    assert.equal(text.includes(accountName), false, "the old checked account must not survive a nested connection change");
    assert.ok(text.includes(["fliggy", "baidu-maps"].includes(definition.id) ? "officialConnectors.serviceUnknown" : "officialConnectors.accountStates.unknown"));
    assert.equal(model.data.items[0].revision, 5);
    assert.ok(changed >= 2);
    receipts.push({ id: definition.id, actualNestedComponents: true, noCredentialEntry: true, accessChange: true, staleAccountCleared: true, actualToolDetails: true, lazyReadOnlyToolList: true, lateAccountResponseFenced: true });
  } finally { await Renderer.act(async () => rendered?.unmount()); }
}
console.log(JSON.stringify({ outcome: "PASS", providers: receipts.length, receipts }));
