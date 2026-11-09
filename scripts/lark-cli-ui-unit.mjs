import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadConnectorAddButton, loadConnectorDetails } from "./fixtures/connector-details-ui.mjs";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const React = require("react"), Renderer = require("react-test-renderer"), ts = require("typescript"), i18next = require("i18next");
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, Event, AbortController, require: name => name in imports ? imports[name] : require(name), ...globals });
  return module.exports;
}
const larkResources = load("../app/manage-ui/src/i18n/larkCliResources.ts").larkCliResources;
const mcpResources = load("../app/manage-ui/src/i18n/mcpConnectorResources.ts").mcpConnectorResources;
const styles = { __esModule: true, default: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const initial = () => ({ id: "lark-cli", revision: 0, state: "notInstalled", stage: null, version: "1.0.98", installedVersion: null, skillCount: 0, cliPath: null, canRemove: false, errorCode: null });
const setupInitial = () => ({ state: "idle", requestId: null, configured: false, appId: null, brand: null, userName: null, verificationUrl: null, userCode: null, qrCode: null, expiresAt: null, warning: null, errorCode: null });

for (const language of ["zh-CN", "en"]) {
  const translator = i18next.createInstance();
  const resources = Object.fromEntries(["zh-CN", "en"].map(locale => [locale, {
    translation: { larkCli: larkResources[locale], mcpConnectors: mcpResources[locale] },
  }]));
  await translator.init({ lng: language, resources, interpolation: { escapeValue: false } });
  const t = translator.t.bind(translator), events = new EventTarget(), document = new EventTarget(); document.visibilityState = "visible";
  let current = initial(), setupCurrent = setupInitial(), statusFailure = false, settleInstall, settleRemove, allowRemove = false, mutations = [], setupMutations = [];
  const api = load("../app/manage-ui/src/api/larkCliConnector.ts", { "./client": { jsonFetch: async (url, options) => {
    if (url.includes("/setup/")) {
      if (url.endsWith("/status")) return plain(setupCurrent);
      const input = JSON.parse(options.body); setupMutations.push({ url, input });
      if (url.endsWith("/cancel")) setupCurrent = { ...setupCurrent, state: "cancelled", verificationUrl: null, qrCode: null, errorCode: "LARK_CLI_AUTH_CANCELLED" };
      else {
        assert.equal(input.expectedRevision, current.revision);
        setupCurrent = { ...setupInitial(), state: "configuring", requestId: "00000000-0000-4000-8000-000000000001", configured: input.mode === "existing",
          verificationUrl: "https://open.feishu.cn/page/cli?user_code=test", qrCode: "data:image/png;base64,aGVsbG8=", brand: input.brand, appId: input.appId || null };
      }
      return plain(setupCurrent);
    }
    if (url.endsWith("/status")) { if (statusFailure) throw Error("private-status-canary"); return plain(current); }
    mutations.push({ url, options }); const input = JSON.parse(options.body);
    assert.equal(input.expectedRevision, current.revision); assert.deepEqual(Object.keys(input), ["expectedRevision"]);
    assert.equal(options.method, "POST");
    if (url.endsWith("/install")) {
      current = { ...current, revision: current.revision + 1, state: "installing", stage: "downloadCli", canRemove: true, installedVersion: current.version, errorCode: null };
      return new Promise((resolve, reject) => { settleInstall = { resolve, reject }; });
    }
    assert.ok(url.endsWith("/remove"));
    current = { ...current, revision: current.revision + 1, state: "removing", stage: null };
    return new Promise(resolve => { settleRemove = resolve; });
  } } }, { window: events });
  assert.equal(api.matchesLarkCli("飞书"), true); assert.equal(api.matchesLarkCli("Lark CLI"), true); assert.equal(api.matchesLarkCli("feishu"), true); assert.equal(api.matchesLarkCli("unknown"), false);
  assert.equal(api.larkCliErrorKey({ code: "toString" }), "failed");
  const cache = load("../app/manage-ui/src/lib/usePageCache.ts", {}, { window: events, document });
  const componentImports = {
    "react-i18next": { useTranslation: () => ({ t, i18n: translator }) }, "../api/larkCliConnector": api,
    "../components/ConnectorDetails": loadConnectorDetails(t),
    "../components/ConnectorAddButton": loadConnectorAddButton(t),
    "../lib/usePageCache": cache,
    "../components/Modal": { __esModule: true, default: ({ children, footer, subtitle, title, dismissible }) => React.createElement("section", { role: "dialog", "aria-label": typeof title === "string" ? title : "connector", "data-dismissible": dismissible }, children, React.createElement("p", {}, subtitle), footer) },
    "../components/ui": { useConfirm: () => async () => allowRemove },
    "../components/McpConnectorIcon": { __esModule: true, default: () => null }, "../components/ConnectorTools": { __esModule: true, default: ({ description }) => React.createElement("p", null, description) }, "./ConnectorsPage.module.css": styles,
  };
  const setup = load("../app/manage-ui/src/pages/LarkCliSetup.tsx", componentImports);
  const lark = load("../app/manage-ui/src/pages/LarkCliConnector.tsx", { ...componentImports, "./LarkCliSetup": setup }, { window: events, document });
  const page = load("../app/manage-ui/src/pages/ConnectorsPage.tsx", {
    ...componentImports, "react-router-dom": { useLocation: () => ({ search: "" }) }, "./LarkCliConnector": lark,
    "./OfficialSkillConnectors": { __esModule: true, default: () => null, useOfficialSkillConnectors: () => ({ data: { items: [] }, refresh: async () => {}, loading: false }), officialConnectorDefinitions: [], OfficialSkillInstalledRows: () => null, OfficialSkillRecommendation: () => null },
    "../api/mcpConnectors": { listMcpConnectors: async () => ({ servers: [], revision: 0 }), MCP_CHANGE_EVENT: "mcp-change", mcpPublicError: () => "registry-failed", searchMcpRegistry: async () => { throw Error("registry unavailable"); } },
    "../components/McpApprovalInbox": { __esModule: true, default: () => null },
    "../components/AppleDeviceConnectors": { AppleDeviceRows: () => null, useAppleDeviceConnectors: () => ({ count: 0 }) },
    "../lib/useMcpConnectorRefresh": { useMcpConnectorRefresh() {} },
    "../lib/usePendingConnectors": { usePendingConnectors: () => ({ ids: [], add() {}, remove() {} }) },
    "../components/PageHead": { PageHead: () => null }, "./McpConnectorDialog": { __esModule: true, default: () => null },
    "../lib/page-refresh": { useRegisterPageLoading() {}, useRegisterPageRefresh() {} },
    "../lib/mcpConnectorUi": load("../app/manage-ui/src/lib/mcpConnectorUi.ts"),
    "../lib/mcpRecommendationCatalog": load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts"),
    "../../../agent-service/data/mcp-featured-servers.json": { __esModule: true, default: ["test/unavailable"] },
    "../../../agent-service/data/mcp-featured-presets.json": { __esModule: true, default: [] },
  }, { window: events, document });
  let mounted;
  const button = text => mounted.root.findAllByType("button").find(item => item.props.children === text);
  const addRecommendation = () => mounted.root.findAllByType("button").find(item => item.props["aria-label"] === `${t("mcpConnectors.add")} ${t("larkCli.name")}`);
  const click = async target => Renderer.act(async () => { target.props.onClick(); await flush(); });
  const notify = async () => Renderer.act(async () => { events.dispatchEvent(new Event(api.LARK_CLI_CHANGE_EVENT)); await flush(); });
  const switchLanguage = async locale => Renderer.act(async () => {
    await translator.changeLanguage(locale);
    mounted.update(React.createElement(page.default));
  });
  try {
    await Renderer.act(async () => { mounted = Renderer.create(React.createElement(page.default)); await flush(); });
    const recommendation = mounted.root.findByProps({ "data-lark-recommendation": true });
    assert.ok(recommendation.findAllByType("strong").some(label => label.children.join("") === t("larkCli.name")), "static recommendation survives registry failure");
    assert.equal(t("larkCli.name"), language === "en" ? "Lark" : "飞书");
    assert.equal(recommendation.findByType("small").children.join(""), t("larkCli.description"));
    if (language === "en") assert.doesNotMatch(JSON.stringify(recommendation.findByType("small").children), /\p{Script=Han}/u, "English recommendations use the English description");
    assert.equal(mutations.length, 0, "browsing never installs");
    await click(recommendation.findAllByType("button")[0]);
    assert.equal(mutations.length, 0, "opening details never installs");
    const installButton = button(t("mcpConnectors.add")); assert.equal(installButton.props.disabled, false);
    await Renderer.act(async () => { installButton.props.onClick(); installButton.props.onClick(); await flush(); });
    assert.equal(mutations.length, 1, "duplicate click is fenced synchronously");
    await notify();
    assert.equal(mounted.root.findByProps({ role: "dialog" }).props["data-dismissible"], false);
    assert.ok(mounted.root.findAllByProps({ role: "status" }).some(item => item.children.includes(t("larkCli.stages.downloadCli"))));
    assert.equal(button(t("larkCli.reinstall")).props.disabled, true);
    current = { ...current, revision: current.revision + 1, state: "failed", stage: null, errorCode: "LARK_CLI_DOWNLOAD_FAILED" };
    await Renderer.act(async () => { settleInstall.reject(Object.assign(Error("private-download-canary"), { code: "LARK_CLI_DOWNLOAD_FAILED" })); await flush(); });
    assert.ok(JSON.stringify(mounted.toJSON()).includes(t("larkCli.errors.download"))); assert.equal(JSON.stringify(mounted.toJSON()).includes("private-download-canary"), false);
    await click(button(t("larkCli.reinstall"))); assert.equal(mutations.length, 2);
    current = { ...current, revision: current.revision + 1, state: "installed", stage: null, errorCode: null, cliPath: "/private/tmp/Lark user's files/bin/lark-cli", skillCount: 28 };
    await Renderer.act(async () => { settleInstall.resolve(plain(current)); await flush(); });
    assert.equal(mounted.root.findByProps({ role: "dialog" }).props["data-dismissible"], true);
    const installedRow = () => mounted.root.findByProps({ "data-lark-installed": true });
    assert.equal(installedRow().findAllByType("button").length, 1, "the app entry is the management button");
    assert.equal(installedRow().findByType("small").children.join(""), t("mcpConnectors.flow.notConnected"), "installation alone does not hide the not connected label");
    assert.equal(installedRow().findAllByType("strong").length, 1);
    assert.equal(installedRow().findAllByType("small").length, 1, "installed apps omit descriptions");
    await click(installedRow().findByType("button"));
    assert.equal(mounted.root.findByProps({ "data-connector-footer": true }).findAllByType("button").filter(node => node.props.children === t("mcpConnectors.flow.remove")).length, 1, "Lark uses the shared footer Delete action");
    assert.equal(mounted.root.findByProps({ "data-connector-footer": true }).findAllByType("button").some(node => node.props.children === t("larkCli.close")), false, "Lark has no duplicate footer Close button");
    assert.equal(mutations.length, 2, "opening the app entry never reinstalls it");
    assert.equal(mounted.root.findAllByProps({ "data-lark-recommendation": true }).length, 0, "installed Lark has no duplicate Add recommendation");
    assert.ok(JSON.stringify(mounted.toJSON()).includes(t("mcpConnectors.flow.larkCapabilities")));
    assert.equal(JSON.stringify(mounted.toJSON()).includes("config init"), false, "setup requires no terminal command copying");
    if (language === "en") assert.doesNotMatch(JSON.stringify(mounted.toJSON()), /\p{Script=Han}/u, "English Lark details use English copy");
    const defaultBrand = language === "en" ? "lark" : "feishu", chosenBrand = defaultBrand === "lark" ? "feishu" : "lark";
    assert.equal(mounted.root.findByType("select").props.value, defaultBrand, "a new account defaults to the App language's service region");
    assert.deepEqual(mounted.root.findAllByType("option").map(option => option.children.join("")), [language === "en" ? "Feishu" : "飞书", "Lark"], "region labels remain distinct from the connector display name");
    await switchLanguage(language === "en" ? "zh-CN" : "en");
    assert.equal(mounted.root.findByType("select").props.value, chosenBrand, "an untouched default follows App language changes");
    await switchLanguage(language);
    const connect = button(t("larkCli.connect"));
    await Renderer.act(async () => { connect.props.onClick(); connect.props.onClick(); await flush(); });
    assert.equal(setupMutations.length, 1, "setup double click starts one operation");
    assert.equal(setupMutations[0].input.brand, defaultBrand, "the connection request uses the displayed default region");
    assert.equal(mounted.root.findAllByType("img")[0].props.alt, t("larkCli.qrAlt"));
    assert.equal(mounted.root.findAllByType("a").find(item => item.props.href.includes("user_code")).props.rel, "noreferrer");
    assert.equal(button(t("mcpConnectors.flow.remove")).props.disabled, true, "cannot remove components during authorization");
    await click(button(t("larkCli.cancelSetup"))); assert.equal(setupMutations.length, 2);
    await Renderer.act(async () => { mounted.root.findByType("select").props.onChange({ target: { value: chosenBrand } }); });
    await switchLanguage(language === "en" ? "zh-CN" : "en");
    await switchLanguage(language);
    assert.equal(mounted.root.findByType("select").props.value, chosenBrand, "an explicit service-region choice survives language changes");
    await click(button(t("larkCli.existingApp")));
    await Renderer.act(async () => {
      mounted.root.findAllByType("input").find(item => item.props.placeholder === "cli_…").props.onChange({ target: { value: "cli_test_application" } });
      mounted.root.findAllByType("input").find(item => item.props.type === "password").props.onChange({ target: { value: "private-app-secret-canary" } }); await flush();
    });
    await click(button(t("larkCli.connect")));
    assert.equal(setupMutations[2].input.appSecret, "private-app-secret-canary");
    assert.equal(setupMutations[2].input.brand, chosenBrand, "existing-app setup uses the explicitly chosen region");
    assert.equal(JSON.stringify(mounted.toJSON()).includes("private-app-secret-canary"), false, "secret is cleared after submitting");
    setupCurrent = { ...setupCurrent, state: "ready", userName: "Test User", warning: "missingScopes", errorCode: null, verificationUrl: null, qrCode: null };
    await Renderer.act(async () => { cache.invalidatePageCache(); await flush(); });
    assert.ok(JSON.stringify(mounted.toJSON()).includes(t("larkCli.connected")));
    assert.equal(installedRow().findAllByType("small").length, 0, "an authorized app shows only its icon and name");
    assert.ok(JSON.stringify(mounted.toJSON()).includes(t("larkCli.missingScopes")));
    await click(button(t("mcpConnectors.flow.done")));
    await click(installedRow().findByType("button"));
    const configuredApp = mounted.root.findAllByType("p").find(node => node.findAllByType("code").some(code => code.children.join("") === "cli_test_application"));
    assert.equal(configuredApp.children.at(-1), t(`larkCli.regions.${chosenBrand}`), "saved region is labeled correctly after reopening the dialog");
    await click(button(t("larkCli.reauthorize")));
    assert.equal(setupMutations[3].input.mode, "reauthorize", "authorized users can grant additional permissions in the App");
    assert.equal(setupMutations[3].input.brand, chosenBrand, "reauthorization preserves the saved service region rather than applying the language default");
    await click(button(t("larkCli.cancelSetup")));
    await click(button(t("mcpConnectors.flow.remove"))); assert.equal(mutations.length, 2, "cancelled removal preserves installation");
    allowRemove = true; await click(button(t("mcpConnectors.flow.remove"))); assert.equal(mutations.length, 3);
    assert.ok(mounted.root.findAllByProps({ role: "status" }).some(item => item.children.includes(t("larkCli.states.removing"))), "removal feedback is immediate before the first status poll");
    current = { ...initial(), revision: current.revision + 1 };
    await Renderer.act(async () => { settleRemove(plain(current)); await flush(); });
    assert.equal(mounted.root.findAllByProps({ "data-lark-installed": true }).length, 0);
    assert.equal(mounted.root.findAllByProps({ "data-lark-recommendation": true }).length, 1, "removal returns the connector to recommendations in both languages");
    assert.equal(addRecommendation().props.disabled, false);
    statusFailure = true; await notify(); assert.equal(addRecommendation().props.disabled, true);
    assert.equal(JSON.stringify(mounted.toJSON()).includes("private-status-canary"), false);
    statusFailure = false;
    await Renderer.act(async () => { await cache.invalidatePageCache(); await flush(); });
    assert.equal(mounted.root.findAllByProps({ type: "search" }).length, 0);
    assert.equal(mounted.root.findAllByProps({ "data-lark-recommendation": true }).length, 1, "local connector remains recommended when MCP registry fails");
    console.log(`PASS ${language}: localized recommendations and details, locale-based region defaults, explicit and saved region preservation, install/retry/remove, setup/QR, cancel, secrets and authorization`);
  } finally { await Renderer.act(async () => mounted?.unmount()); }
}
