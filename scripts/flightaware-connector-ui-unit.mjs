import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const uiRequire = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const React = uiRequire("react"), Renderer = uiRequire("react-test-renderer");
const recommendations = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/mcp-featured-presets.json", import.meta.url), "utf8"));
const recommendation = recommendations.find(item => item.id === "flightaware");
function load(relative, customRequire) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: customRequire, AbortController, URL, setInterval, clearInterval });
  return module.exports;
}
const helpers = load("../app/manage-ui/src/lib/mcpConnectorUi.ts", uiRequire);
const catalog = load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts", uiRequire);
const policy = JSON.parse(fs.readFileSync(new URL("../app/core/flightaware-connector-policy.json", import.meta.url), "utf8"));
const resources = load("../app/manage-ui/src/i18n/mcpConnectorResources.ts", uiRequire).mcpConnectorResources;
assert.ok(catalog.mcpRecommendationOrder.includes("flightaware"));

for (const language of ["zh-CN", "en"]) {
  const mutations = [], verified = [], changed = [];
  let records = [], mounted, closed = false;
  let saved = { id: "mcp-flightaware-ui", name: "FlightAware", source: { kind: "custom" }, recommendationId: "flightaware", transport: { kind: "stdio-command", command: "/bundled/Shoggoth" }, status: "ready", auth: { kind: "none" }, setup: { requiredFields: ["env:FLIGHTAWARE_API_KEY"], configuredFields: ["env:FLIGHTAWARE_API_KEY"] }, lastCheck: { at: 1, toolCount: 20, errorCode: null }, disabledProfileIds: [] };
  const api = {
    listMcpSubjects: async () => ({ items: [], unavailableBackends: [] }), listMcpConnectors: async () => ({ revision: 12, servers: records }),
    addMcpConnector: async input => { mutations.push(input); records = [saved]; return { revision: 13, server: saved }; },
    verifyMcpConnector: async id => { verified.push(id); return { revision: 14, server: saved }; },
    formatMcpError: error => error.code || "fixture-error",
    saveMcpCredentials: async (id, fields) => { mutations.push({ id, fields }); if (fields.env?.[policy.METERED_FIELD]) saved = { ...saved, setup: { ...saved.setup, configuredFields: ["env:FLIGHTAWARE_API_KEY", ...(fields.env[policy.METERED_FIELD] === policy.METERED_ENABLED ? [policy.METERED_MARKER] : [])] } }; return { revision: 14, server: saved }; },
    rebindMcpConnector: async (id, option, revision) => { mutations.push({ id, option, revision }); return { revision: 14, server: saved }; },
    startMcpSignIn: async () => assert.fail("FlightAware must not attempt OAuth"),
  };
  const component = load("../app/manage-ui/src/pages/McpConnectorDialog.tsx", name => {

 if (['../components/McpConnectorIcon','../components/ConnectorTools'].includes(name)) return {__esModule:true,default:()=>null};
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return uiRequire(name);
    if (name === "react-i18next") return { useTranslation: () => ({ t: key => key, i18n: { resolvedLanguage: language } }) };
    if (name === "../components/Modal") return { __esModule: true, default: ({ children, footer, subtitle }) => React.createElement("section", {}, children, React.createElement("p", {}, subtitle), footer) };
    if (name === "../components/ui") return { useConfirm: () => async () => true };
    if (name === "../api/mcpConnectors") return api;
    if (name === "../lib/mcpConnectorUi") return helpers;
    if (name === "../lib/mcpRecommendationCatalog") return catalog;
    if (name === "../../../agent-service/data/mcp-featured-presets.json") return { __esModule: true, default: recommendations };
    if (name === "../../../core/flightaware-connector-policy.json") return { __esModule: true, default: JSON.parse(fs.readFileSync(new URL("../app/core/flightaware-connector-policy.json", import.meta.url), "utf8")) };
    if (name.endsWith(".module.css")) return { __esModule: true, default: {} };
    throw new Error("Unexpected import: " + name);
  }).default;
  const mount = async props => Renderer.act(async () => { mounted = Renderer.create(React.createElement(component, { recommendation, onChanged: () => changed.push(true), onClose: () => { closed = true; }, ...props })); });
  const button = key => mounted.root.findAllByType("button").find(node => node.props.children === `mcpConnectors.${key}` || (key === "save" && ["flow.saveConnect", "flow.authorize", "flow.checkConnect"].some(k => node.props.children === `mcpConnectors.${k}`)) || (key === "remove" && node.props.children === "mcpConnectors.flow.remove"));
  const keyField = () => mounted.root.findAllByType("input").find(node => node.props.type !== "checkbox");
  const permission = () => mounted.root.findAllByType("input").find(node => node.props.type === "checkbox");
  const renderText = () => JSON.stringify(mounted.toJSON());
  await mount({});
  assert.equal(mutations.length, 0, "opening a recommendation must not save or query");
  assert.equal(button("save").props.disabled, true, "a first connection requires a key");
  assert.equal(mounted.root.findAllByType("input").length, 2, "only the key and metered permission checkbox are shown");
  assert.equal(permission().props.checked, false, "metered queries are off by default");
  const keyInput = keyField();
  assert.equal(keyInput.props.type, "password"); assert.equal(keyInput.props.autoComplete, "off");
  for (const key of ["commandLabel", "args", "cwd", "headers", "env", "oauthClient"]) assert.equal(renderText().includes(`mcpConnectors.${key}"`), false);
  assert.ok(renderText().includes(helpers.mcpRecommendationText(recommendation.fields[0].label, language)));
  assert.ok(resources[language].errors.flightawarePython); assert.ok(resources[language].errors.flightawareRateLimit);
  await Renderer.act(async () => keyInput.props.onChange({ target: { value: "fixture-ui-aeroapi-key" } }));
  assert.equal(button("save").props.disabled, false);
  await Renderer.act(async () => { button("showValue").props.onClick(); });
  assert.equal(keyField().props.type, "text", "explicit reveal applies to the actual AeroAPI Key field");
  await Renderer.act(async () => { button("hideValue").props.onClick(); });
  assert.equal(keyField().props.type, "password");
  await Renderer.act(async () => { button("showValue").props.onClick(); });
  await Renderer.act(async () => { button("save").props.onClick(); });
  assert.equal(mutations.length, 1); assert.equal(mutations[0].option.command, "shoggoth-flightaware"); assert.deepEqual(Array.from(mutations[0].option.args), []);
  assert.equal(mutations[0].fields.env.FLIGHTAWARE_API_KEY, "fixture-ui-aeroapi-key");
  assert.equal(mutations[0].fields.env[policy.METERED_FIELD], policy.METERED_DISABLED);
  assert.equal(JSON.stringify(mutations[0].option).includes("fixture-ui-aeroapi-key"), false);
  assert.equal(renderText().includes("fixture-ui-aeroapi-key"), false, "secret draft clears after save");
  assert.equal(keyField(), undefined, "successful setup collapses the credential form");
  assert.ok(changed.length); assert.equal(closed, false); assert.equal(button("verify").props.disabled, false);
  assert.equal(helpers.mcpRecommendationMatchesServer(recommendation, saved), true);
  assert.equal(helpers.mcpRecommendationMatchesServer(recommendation, { ...saved, recommendationId: undefined }), false);
  await Renderer.act(async () => { button("verify").props.onClick(); }); assert.deepEqual(verified, [saved.id]);
  await Renderer.act(async () => button("flow.configure").props.onClick());
  assert.equal(keyField().props.type, "password", "reopened inputs return to their masked state");
  await Renderer.act(async () => permission().props.onChange({ target: { checked: true } }));
  const countBeforeSave = mutations.length;
  assert.equal(saved.setup.configuredFields.includes(policy.METERED_MARKER), false, "toggling a draft cannot enable queries");
  await Renderer.act(async () => { button("save").props.onClick(); });
  assert.equal(mutations.length, countBeforeSave + 1);
  assert.equal(mutations.at(-1).fields.env[policy.METERED_FIELD], policy.METERED_ENABLED);
  assert.equal(mutations.at(-1).fields.env.FLIGHTAWARE_API_KEY, undefined, "permission changes do not require re-entering the key");
  assert.equal(saved.setup.configuredFields.includes(policy.METERED_MARKER), true);
  await Renderer.act(async () => mounted.unmount());
  await mount({ server: saved }); await Renderer.act(async () => button("flow.configure").props.onClick()); assert.equal(permission().props.checked, true, "saved permission is shown after reopening");
  await Renderer.act(async () => permission().props.onChange({ target: { checked: false } }));
  await Renderer.act(async () => { button("save").props.onClick(); });
  assert.equal(mutations.at(-1).fields.env[policy.METERED_FIELD], policy.METERED_DISABLED);
  assert.equal(saved.setup.configuredFields.includes(policy.METERED_MARKER), false);
  await Renderer.act(async () => mounted.unmount());
  records = [{ ...saved, status: "signedOut" }];
  await mount({ server: records[0] });
  await Renderer.act(async () => keyField().props.onChange({ target: { value: "fixture-replacement-key" } }));
  await Renderer.act(async () => { button("save").props.onClick(); });
  assert.equal(mutations.at(-1).id, saved.id); assert.equal(mutations.at(-1).fields.env.FLIGHTAWARE_API_KEY, "fixture-replacement-key");
  await Renderer.act(async () => mounted.unmount());
  records = [{ ...saved, status: "disabled" }]; await mount({ server: records[0] });
  await Renderer.act(async () => { button("save").props.onClick(); });
  assert.equal(mutations.at(-1).option.command, "shoggoth-flightaware", "restore uses the bundled alias, never a stale application path");
  await Renderer.act(async () => mounted.unmount());
  console.log(`PASS FlightAware actual ${language} dialog: masked key, metered-off default, explicit permission save/revoke/reopen, check, retry and restore`);
}
