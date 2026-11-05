import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { loadConnectorDetails } from "./fixtures/connector-details-ui.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const React = require("react"), { create, act } = require("react-test-renderer");
const ts = require("typescript"), i18next = require("i18next");
const normalized = value => JSON.parse(JSON.stringify(value));
function load(relative, stubs = {}, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name in stubs) return stubs[name];
    if (name === "../productToolLabels") return load("app/manage-ui/src/i18n/productToolLabels.ts");
    return require(name);
  }, AbortController, ...globals });
  return module.exports;
}
const status = (overrides = {}) => ({ revision: 4, available: true, errorCode: null, resources: [
  { id: "calendar", authorization: "notDetermined", enabled: false, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: ["unknown-preserved"] },
  { id: "reminders", authorization: "notDetermined", enabled: false, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: [] },
], ...overrides });
const connected = () => { const value = status(); value.resources.forEach(resource => { resource.authorization = "fullAccess"; resource.enabled = true; }); return value; };


let checked = 0;
for (const language of ["zh-CN", "en"]) {
  const dictionary = { ...load(`app/manage-ui/src/i18n/locales/${language}.ts`).default, mcpConnectors: load("app/manage-ui/src/i18n/mcpConnectorResources.ts").mcpConnectorResources[language] };
  const translator = i18next.createInstance();
  await translator.init({ lng: language, resources: { [language]: { translation: dictionary } }, interpolation: { escapeValue: false } });
  const tr = (key, values) => translator.t(`appleDevices.${key}`, values);
  const surface = new EventTarget(), document = new EventTarget(); document.visibilityState = "visible";
  let current = status(), reads = 0, readFailed = false, delayedRead, connectResolve, policyResolve, subjectReads = 0;
  let saveError = null;
  const calls = { connect: [], policy: [], settings: [] };
  const api = {
    APPLE_DEVICE_CHANGE_EVENT: "device-change", appleDeviceErrorKey: error => error.code === "REVISION_CONFLICT" ? "conflict" : "failed",
    getAppleDeviceStatus: async () => { reads++; if (delayedRead) return delayedRead; if (readFailed) throw Error("offline"); return normalized(current); },
    connectAppleDevice: async (...args) => { calls.connect.push(args); return new Promise(resolve => { connectResolve = resolve; }); },
    saveAppleDevicePolicy: async input => {
      calls.policy.push(normalized(input));
      if (saveError) throw Object.assign(Error(saveError), { code: saveError });
      if (policyResolve === "defer") return new Promise(resolve => { policyResolve = resolve; });
      current = normalized(current); current.revision++;
      Object.assign(current.resources.find(resource => resource.id === input.resource), { enabled: input.enabled, readPolicy: input.readPolicy, writePolicy: input.writePolicy, disabledProfileIds: [...input.disabledProfileIds] });
      return normalized(current);
    },
    openAppleDeviceSettings: async resource => { calls.settings.push(resource); return { opened: true }; },
  };
  const components = load("app/manage-ui/src/components/AppleDeviceConnectors.tsx", {
    "react-i18next": { useTranslation: () => ({ t: translator.t.bind(translator) }) },
    "./ConnectorDetails": loadConnectorDetails(translator.t.bind(translator)),
    "../api/appleDevices": api,
    "../api/mcpConnectors": { listMcpSubjects: async () => { subjectReads++; return { items: [], unavailableBackends: [] }; } },
    "./Modal": { __esModule: true, default: ({ children, footer, subtitle }) => React.createElement("section", { role: "dialog" }, children, React.createElement("p", {}, subtitle), footer) },
    "./ConnectorTools": { __esModule: true, default: () => null },
    "./ui": { useConfirm: () => async () => true },
    "../lib/usePendingConnectors": { usePendingConnectors: () => ({ ids: ["device:calendar", "device:reminders"], add() {}, remove() {} }) },
    "../pages/ConnectorsPage.module.css": { __esModule: true, default: {} },
    "./AppleDeviceConnectors.module.css": new Proxy({}, { get: (_, name) => String(name) }),
    "../assets/apple-app-icons/calendar.png": { __esModule: true, default: "calendar-app-icon.png" },
    "../assets/apple-app-icons/reminders.png": { __esModule: true, default: "reminders-app-icon.png" },
  }, { window: surface, document });
  // Render each resource detail against the same real model so policy locking,
  // version receipts and late responses are tested across both resource views.
  function Page({ refreshKey = 0 }) {
    const model = components.useAppleDeviceConnectors(refreshKey);
    return React.createElement(React.Fragment, {}, ...["calendar", "reminders"].map(id => React.createElement(components.AppleDeviceRows, { key: id, model: { ...model, selected: id }, installed: true })));
  }
  let renderer;
  const event = async callback => act(async () => { callback(); for (let i = 0; i < 5; i++) await Promise.resolve(); });
  await event(() => { renderer = create(React.createElement(Page)); });
  for (const footer of renderer.root.findAllByProps({ "data-connector-footer": true })) assert.equal(footer.findAllByType("button").filter(node => node.children.join("") === translator.t("mcpConnectors.flow.remove")).length, 1, "each device uses one footer Delete action");
  const card = id => renderer.root.findAllByType("article").find(node => node.props["data-resource"] === id);
  const button = (id, key) => card(id).parent.findAllByType("button").find(node => node.children.join("") === (key === "disconnect" ? translator.t("mcpConnectors.flow.remove") : tr(key)));
  const select = (id, kind = "read") => card(id).findByProps({ "aria-label": tr(`${kind}For`, { name: tr(`resources.${id}.name`) }) });
  const state = id => card(id).find(node => typeof node.props["data-state"] === "string").props["data-state"];

  assert.equal(renderer.root.findAllByType("article").length, 2);
  assert.equal(subjectReads, 0, "device dialogs do not fetch an agent selector list");
  assert.equal(JSON.stringify(renderer.toJSON()).includes("appleDevices."), false, "all UI copy is localized");
  assert.deepEqual(select("calendar").findAllByType("option").map(node => node.props.value), ["allow", "ask", "deny"]);
  assert.equal(select("calendar").props.value, "ask"); assert.equal(select("calendar").props.disabled, true);
  for (const resource of ["calendar", "reminders"]) {
    assert.deepEqual(select(resource, "write").findAllByType("option").map(node => node.props.value), ["allow", "ask", "deny"]);
    assert.equal(select(resource, "write").props.value, "ask"); assert.equal(select(resource, "write").props.disabled, true);
  }
  assert.equal(renderer.root.findAllByType("input").length, 0, "device dialogs do not offer agent selection");
  await event(() => button("calendar", "connect").props.onClick());
  assert.deepEqual(calls.connect, [["calendar", 4]]); assert.equal(state("calendar"), "notDetermined", "request acceptance cannot grant access");
  assert.equal(button("reminders", "connect").props.disabled, true, "mutations are serialized across both cards");
  current.resources[0].authorization = "denied";
  await event(() => connectResolve(normalized(current)));
  assert.equal(state("calendar"), "denied"); assert.ok(button("calendar", "settings"));
  await event(() => button("calendar", "settings").props.onClick());
  assert.deepEqual(calls.settings, ["calendar"]); assert.equal(calls.connect.length, 1, "denial opens settings without repeatedly prompting");
  current = connected();
  await event(() => surface.dispatchEvent(new Event("focus")));
  assert.equal(state("calendar"), "connected"); assert.equal(select("calendar").props.disabled, false);
  policyResolve = "defer";
  await event(() => select("calendar").props.onChange({ target: { value: "allow" } }));
  assert.equal(select("calendar").props.value, "ask", "permission policy is not optimistically saved");
  assert.equal(select("calendar").props.disabled, true);
  current.resources[0].readPolicy = "allow"; current.revision++;
  const pendingPolicy = policyResolve; policyResolve = null;
  await event(() => pendingPolicy(normalized(current)));
  assert.equal(select("calendar").props.value, "allow");
  for (const value of ["ask", "deny", "allow"]) await event(() => select("calendar").props.onChange({ target: { value } }));
  assert.deepEqual(calls.policy.slice(-3).map(input => input.readPolicy), ["ask", "deny", "allow"]);
  assert.deepEqual(calls.policy.slice(-3).map(input => input.expectedRevision), [5, 6, 7]);
  policyResolve = "defer";
  await event(() => select("calendar", "write").props.onChange({ target: { value: "allow" } }));
  assert.equal(select("calendar", "write").props.value, "ask", "writing permission waits for the server receipt");
  assert.equal(select("reminders", "write").props.disabled, true, "both resource mutations share the revision lock");
  current.resources[0].writePolicy = "allow"; current.revision++;
  const pendingWriting = policyResolve; policyResolve = null;
  await event(() => pendingWriting(normalized(current)));
  for (const value of ["ask", "deny", "allow"]) await event(() => select("calendar", "write").props.onChange({ target: { value } }));
  assert.deepEqual(calls.policy.slice(-3).map(input => input.writePolicy), ["ask", "deny", "allow"]);
  assert.ok(calls.policy.slice(-3).every(input => input.readPolicy === "allow"), "writing edits retain the reading choice");
  assert.equal(select("reminders", "write").props.value, "ask", "Calendar choices never change Reminders");
  await event(() => select("reminders", "write").props.onChange({ target: { value: "deny" } }));
  assert.equal(select("calendar", "write").props.value, "allow");
  assert.equal(select("reminders").props.value, "ask");
  assert.ok(JSON.stringify(renderer.toJSON()).includes(tr("writeHints.deny")));
  saveError = "REVISION_CONFLICT";
  await event(() => select("calendar", "write").props.onChange({ target: { value: "ask" } }));
  assert.equal(select("calendar", "write").props.value, "allow", "a failed save cannot display a grant or revocation as confirmed");
  saveError = null;
  assert.equal(renderer.root.findAllByType("input").length, 0, "connected devices never display agent selectors");
  assert.deepEqual(calls.policy.at(-1).disabledProfileIds, ["unknown-preserved"], "read/write edits retain existing stored policy without UI migration");
  saveError = "REVISION_CONFLICT";
  await event(() => select("calendar").props.onChange({ target: { value: "deny" } }));
  assert.equal(select("calendar").props.value, "allow"); assert.ok(renderer.root.findAllByProps({ role: "alert" }).some(node => node.children.join("").includes(tr("errors.conflict"))));
  saveError = null;
  readFailed = true;
  await event(() => surface.dispatchEvent(new Event("focus")));
  assert.equal(select("calendar").props.disabled, true); assert.equal(state("calendar"), "unavailable", "a failed status read cannot display a stale grant");
  readFailed = false; current.resources[0].authorization = "restricted";
  await event(() => surface.dispatchEvent(new Event("focus")));
  assert.equal(state("calendar"), "restricted"); assert.equal(button("calendar", "connect").props.disabled, true);
  current = connected();
  document.visibilityState = "hidden"; const hiddenReads = reads;
  await event(() => { surface.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); surface.dispatchEvent(new Event("device-change")); });
  assert.equal(reads, hiddenReads, "hidden views do not perform background status reads");
  document.visibilityState = "visible";
  await event(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(state("calendar"), "connected");
  await event(() => renderer.update(React.createElement(Page, { refreshKey: 1 })));
  assert.ok(reads > hiddenReads + 1, "page refresh reloads permissions");
  let resolveStaleRead;
  delayedRead = new Promise(resolve => { resolveStaleRead = resolve; });
  await event(() => surface.dispatchEvent(new Event("focus")));
  assert.equal(select("calendar").props.disabled, false, "a background permission check cannot block policy revocation");
  // A real status read may ignore cancellation; a newer mutation still owns the UI.
  await event(() => select("calendar").props.onChange({ target: { value: "deny" } }));
  delayedRead = null;
  await event(() => resolveStaleRead(connected()));
  assert.equal(select("calendar").props.value, "deny", "an older status read cannot overwrite a saved policy");
  current.available = false; current.errorCode = "APPLE_DEVICE_HOST_UNAVAILABLE";
  await event(() => surface.dispatchEvent(new Event("focus")));
  assert.equal(state("calendar"), "unavailable");
  assert.equal(button("calendar", "disconnect").props.disabled, false, "users can revoke policy while native host is offline");
  await event(() => button("calendar", "disconnect").props.onClick());
  assert.equal(calls.policy.at(-1).enabled, false); assert.equal(select("calendar").props.disabled, true);
  assert.equal(calls.connect.length, 1, "status, focus, policy and refresh operations never prompt for system authorization");
  await event(() => renderer.unmount());
  const afterUnmount = reads;
  await event(() => { surface.dispatchEvent(new Event("focus")); surface.dispatchEvent(new Event("device-change")); document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(reads, afterUnmount, "event listeners are removed on unmount");
  checked += 29;
}

const calls = [], events = [];
const api = load("app/manage-ui/src/api/appleDevices.ts", { "./client": { jsonFetch: async (url, options) => { calls.push({ url, options }); return {}; } } }, { window: { dispatchEvent: event => events.push(event.type) }, Event });
await api.getAppleDeviceStatus(); await api.connectAppleDevice("calendar", 9);
await api.saveAppleDevicePolicy({ resource: "reminders", enabled: true, readPolicy: "deny", writePolicy: "allow", disabledProfileIds: ["preserved"], expectedRevision: 10 });
await api.openAppleDeviceSettings("reminders");
assert.deepEqual(calls.map(call => call.url), ["/__api/connectors/apple/status", "/__api/connectors/apple/connect", "/__api/connectors/apple/policy", "/__api/connectors/apple/settings"]);
assert.deepEqual(JSON.parse(calls[1].options.body), { resource: "calendar", expectedRevision: 9 });
assert.equal(JSON.parse(calls[2].options.body).readPolicy, "deny"); assert.equal(JSON.parse(calls[2].options.body).writePolicy, "allow"); assert.equal(events.length, 3);
assert.equal(api.appleDeviceErrorKey({ code: "APPLE_DEVICE_REVISION_CONFLICT" }), "conflict");
assert.equal(api.appleDeviceErrorKey({ code: "APPLE_DEVICE_HOST_UNAVAILABLE" }), "unavailable");
console.log(`Apple device UI: PASS (${checked} localized interaction groups; independent read/write policies, defaults, save/conflict receipts, agent retention, revocation, offline disconnect and stale read fencing)`);

const approvalHelpers = load("app/manage-ui/src/lib/mcpConnectorUi.ts");
const connectorApi = load("app/manage-ui/src/api/mcpConnectors.ts", { "./client": { jsonFetch() { throw Error("Unexpected real network request"); } } });
const { TOOL_OPERATIONS, APPLE_DEVICE_PUBLIC_MESSAGES } = require(path.join(root, "app/core/apple-device-contract.js"));
for (const language of ["zh-CN", "en"]) {
  const dictionary = { ...load(`app/manage-ui/src/i18n/locales/${language}.ts`).default, mcpConnectors: load("app/manage-ui/src/i18n/mcpConnectorResources.ts").mcpConnectorResources[language] };
  const translator = i18next.createInstance();
  await translator.init({ lng: language, resources: { [language]: { translation: dictionary } }, interpolation: { escapeValue: false } });
  const translate = translator.t.bind(translator);
  const approval = { requestId: "apple-device-fixture", backendId: "hermes", agentId: "agent-a", sessionId: "physical-session-a", toolName: "apple_calendar_create", serverId: "apple-calendar",
    argumentsPreview: JSON.stringify({ title: "Fixture meeting", start: "2026-10-27T09:00:00+08:00", end: "2026-10-27T10:00:00+08:00" }), argumentDigest: "a".repeat(64), reason: "Create the event you requested", createdAt: 1, expiresAt: Date.now() + 600000 };
  for (const toolName of Object.keys(TOOL_OPERATIONS)) {
    const value = { ...approval, toolName, serverId: toolName.startsWith("apple_calendar_") ? "apple-calendar" : "apple-reminders" };
    const display = approvalHelpers.mcpApprovalDisplay(value, translate), prompt = approvalHelpers.mcpApprovalPrompt(value, translate);
    assert.ok(display.title.includes(translate(`appleDevices.resources.${toolName.startsWith("apple_calendar_") ? "calendar" : "reminders"}.name`)));
    assert.equal(display.title.includes("apple_"), false, "known device actions use localized resource and action labels");
    assert.equal(display.title.includes("appleDevices."), false);
    assert.equal(prompt.approvalDetails.toolName, display.title); assert.equal(prompt.approvalDetails.serverName, display.serverName);
    assert.equal(prompt.approvalDetails.input, value.argumentsPreview, "display formatting cannot alter reviewed arguments");
    assert.equal(prompt.id, approvalHelpers.mcpApprovalPrompt(value).id, "locale cannot alter approval identity");
    assert.deepEqual(normalized(prompt.approvalChoices), ["once", "deny"]);
  }
  for (const backendId of ["openclaw", "hermes"]) {
    const value = { ...approval, backendId };
    assert.equal(approvalHelpers.mcpApprovalMatchesConversation(value, { backendId, agentId: value.agentId, sessionId: value.sessionId }), true);
    for (const changed of [{ backendId: "shoggoth" }, { agentId: "other" }, { sessionId: "other" }, { sessionId: undefined }]) {
      assert.equal(approvalHelpers.mcpApprovalMatchesConversation(value, { backendId, agentId: value.agentId, sessionId: value.sessionId, ...changed }), false);
    }
    assert.equal(approvalHelpers.canResolveMcpApproval(value, { ...value }, value.expiresAt - 1), true);
    assert.equal(approvalHelpers.canResolveMcpApproval(value, { ...value, argumentDigest: "b".repeat(64) }, value.expiresAt - 1), false);
    assert.equal(approvalHelpers.canResolveMcpApproval(value, { ...value, backendId: "shoggoth" }, value.expiresAt - 1), false);
    assert.equal(approvalHelpers.canResolveMcpApproval(value, { ...value }, value.expiresAt), false);
  }
  const errorKeys = { APPLE_DEVICE_APPROVAL_EXPIRED: "approvalExpired", APPLE_DEVICE_APPROVAL_INVALID: "approvalExpired", APPLE_DEVICE_APPROVAL_DENIED: "approvalDenied", APPLE_DEVICE_ACCESS_REVOKED: "revoked", APPLE_DEVICE_WRITE_UNCERTAIN: "writeUncertain", APPLE_DEVICE_HOST_UNAVAILABLE: "unavailable", APPLE_DEVICE_ACCESS_DENIED: "accessDenied", APPLE_DEVICE_UNKNOWN_PRIVATE_CANARY: "failed" };
  for (const [code, key] of Object.entries(errorKeys)) assert.equal(connectorApi.formatMcpError({ code, message: "private-error-canary" }, translate), dictionary.appleDevices.errors[key]);
  for (const code of Object.keys(APPLE_DEVICE_PUBLIC_MESSAGES)) {
    const value = connectorApi.formatMcpError({ code, message: "private-error-canary" }, translate);
    assert.equal(value.includes("appleDevices."), false, `${code} must have a localized fallback`);
    assert.equal(value.includes("private-error-canary"), false);
  }
}
console.log("Apple device approvals: PASS (12 localized actions, exact OpenClaw/Hermes conversation matching, digest/expiry fences and all public device error mappings)");
