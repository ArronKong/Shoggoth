import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), { act, create } = require("react-test-renderer"), ts = require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pending = [];
let guard;
const deferred = (kind, args) => new Promise((resolve, reject) => pending.push({ kind, args, resolve, reject }));
const api = { getNativeMemoryContext: () => deferred("context"), getNativeMemoryConfig: () => deferred("read"),
  updateNativeMemoryConfig: input => deferred("write", structuredClone(input)) };
const element = (tag, props, children) => React.createElement(tag, props, children);
const fields = {
  Field: ({ label, children, hint }) => element("label", {}, [element("span", { key: "label" }, label), children, hint]),
  TextInput: props => element("input", props), TextArea: props => element("textarea", props),
  Select: ({ children, ...props }) => element("select", props, children),
  Option: props => element("option", props, props.children),
  Switch: ({ label, checked, onChange, disabled }) => element("input", { type: "checkbox", title: label, checked, onChange, disabled }),
};
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(ui, relative), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, structuredClone, Set, Object, Error,
    require: name => {
      if (name.endsWith('/NativeMemorySharingSettings')) return { __esModule: true, default: () => null };
      if (name.endsWith('/MemoryProviderAccounts')) return { __esModule: true, default: () => null };
      if (name.endsWith(".css")) return {};
      if (name.endsWith("/api/client")) return api;
      if (name.endsWith("/components/Field")) return fields;
      if (name.endsWith("/navigation-guard")) return { useNavigationGuard: value => { guard = value; } };
      if (name.endsWith("/nativeMemoryForm")) return load("src/lib/nativeMemoryForm.ts");
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key, args) => args?.id ? `${key}:${args.id}` : key }) };
      return require(name);
    },
  });
  cache.set(relative, module.exports); return module.exports;
}
const { changeMemorySetting, sameMemorySettings } = load("src/lib/nativeMemoryForm.ts");
const initial = { memory: { search: { enabled: true, query: { minScore: 0.3 } } }, agents: { entries: {
  "profile-a": { memory: { search: { query: { maxResults: 4 }, extraPaths: [{ path: "/fixture/a", pattern: "notes/*.md" }] } } },
  "profile-b": { memory: { search: { provider: "none" } } } } },
  plugins: { entries: { "memory-core": { config: { dreaming: { phases: { deep: { maxPriorEntryLossFraction: 0.15 } } } } } } } };
const next = changeMemorySetting(initial, ["agents", "entries", "profile-a", "memory", "search", "query", "maxResults"], undefined);
assert.equal(next.agents.entries["profile-a"].memory.search.query, undefined);
assert.deepEqual(next.agents.entries["profile-b"], initial.agents.entries["profile-b"]);
assert.equal(initial.agents.entries["profile-a"].memory.search.query.maxResults, 4);
assert.ok(sameMemorySettings({ agents: {}, memory: {} }, { memory: {}, agents: {} }));
assert.equal(sameMemorySettings({ agents: { defaults: { models: { "z/z": { alias: "same" }, "a/a": { alias: "same" } } } } },
  { agents: { defaults: { models: { "a/a": { alias: "same" }, "z/z": { alias: "same" } } } } }), false);
assert.throws(() => changeMemorySetting({}, ["__proto__", "changed"], true));

const Component = load("src/pages/settings/SettingsMemory.tsx").default;
const context = { owner: "shoggoth-memory-core", agents: [
  { profileId: "profile-a", agentId: "public-a", name: "Agent A" }, { profileId: "profile-b", agentId: "public-b", name: "Agent B" }] };
let renderer;
const mount = async () => { await act(async () => { renderer = create(React.createElement(Component)); }); };
const expand = async () => { await act(async () => { renderer.root.findByProps({ id: "settings-memory" }).props.onToggle({ currentTarget: { open: true } }); }); };
const settle = async (kind, value, reject = false) => {
  const request = pending.shift(); assert.equal(request?.kind, kind);
  await act(async () => { request[reject ? "reject" : "resolve"](value); }); return request;
};
const input = id => renderer.root.findByProps({ id: `memory-setting-${id}` });
const button = key => renderer.root.findAllByType("button").find(node => node.children.includes(key));
const choose = async (title, value) => { await act(async () => { renderer.root.findByProps({ title }).props.onChange(value); }); };
const edit = async (id, value) => { await act(async () => { input(id).props.onChange({ target: { value } }); }); };
const submit = async valid => { await act(async () => { void renderer.root.findByType("form").props.onSubmit({ preventDefault() {}, currentTarget: { reportValidity: () => valid } }); }); };

await mount(); assert.equal(pending.length, 0, "collapsed settings do not read or write config");
await expand(); await settle("context", { owner: "legacy", agents: [] });
assert.equal(pending.length, 0, "legacy owner must not load or expose inactive policy editing");
assert.equal(renderer.root.findAllByType("form").length, 0);
await act(async () => { renderer.unmount(); });
await mount(); await expand(); await settle("context", context); await settle("read", { revision: 7, config: initial });
assert.equal(guard.dirty, false);
await choose("nativeMemory.scope", "profile-a");
await edit("agents-entries-profile-a-memory-search-query-maxResults", "8");
assert.equal(guard.dirty, true);
await choose("nativeMemory.scope", "profile-b");
assert.equal(input("agents-entries-profile-b-memory-search-query-maxResults").props.value, "");
await choose("nativeMemory.scope", "profile-a");
assert.equal(input("agents-entries-profile-a-memory-search-query-maxResults").props.value, "8");
await choose("nativeMemory.aliasScope", "profile-a");
await edit("alias-target", "fixture/alpha");
assert.equal(button("common.save").props.disabled, true, "unadded model text must not be silently discarded by save");
await submit(true); assert.equal(pending.length, 0);
await act(async () => { button("nativeMemory.addAlias").props.onClick(); });
assert.equal(input("alias-target").props.value, "");
await edit("alias-value-fixture%2Falpha", "recall");
await edit("alias-target", "fixture/alpha");
assert.equal(button("nativeMemory.addAlias").props.disabled, true, "adding a duplicate must not overwrite its existing alias");
await edit("alias-target", "");
await choose("nativeMemory.aliasScope", "profile-b");
assert.equal(renderer.root.findAllByProps({ id: "memory-setting-alias-value-fixture%2Falpha" }).length, 0);
await choose("nativeMemory.aliasScope", "profile-a");
assert.equal(input("alias-value-fixture%2Falpha").props.value, "recall");
await choose("nativeMemory.active", "true");
await choose("Agent B", false);
await edit("plugins-entries-active-memory-config-modelFallback", "fixture-fallback");
await choose("nativeMemory.fields.thinking", "max");
await choose("nativeMemory.fields.fastMode", "true");
await choose("nativeMemory.fields.fastMode", "false");
await choose("nativeMemory.fields.fastMode", "auto");
await choose("nativeMemory.fields.persistTranscripts", "true");
await edit("plugins-entries-active-memory-config-transcriptDir", "recall/diagnostics");
await submit(false); assert.equal(pending.length, 0, "invalid browser fields block save");
await submit(true);
assert.equal(guard.busy, true);
const write = pending[0]; assert.equal(write.kind, "write"); assert.equal(write.args.expectedRevision, 7);
assert.equal(write.args.config.agents.entries["profile-a"].memory.search.query.maxResults, 8);
assert.equal(write.args.config.agents.entries["profile-a"].models["fixture/alpha"].alias, "recall");
assert.deepEqual(write.args.config.agents.entries["profile-b"], initial.agents.entries["profile-b"]);
assert.deepEqual(write.args.config.plugins.entries["memory-core"], initial.plugins.entries["memory-core"]);
assert.equal(write.args.config.plugins.entries["active-memory"].enabled, true);
assert.equal(write.args.config.plugins.entries["active-memory"].config.modelFallback, "fixture-fallback");
assert.equal(write.args.config.plugins.entries["active-memory"].config.thinking, "max");
assert.equal(write.args.config.plugins.entries["active-memory"].config.fastMode, "auto");
assert.equal(write.args.config.plugins.entries["active-memory"].config.persistTranscripts, true);
assert.equal(write.args.config.plugins.entries["active-memory"].config.transcriptDir, "recall/diagnostics");
assert.equal(Object.hasOwn(write.args.config.plugins.entries["active-memory"].config, "agents"), false, "default all must not snapshot current Profiles into an allowlist");
assert.deepEqual(write.args.config.plugins.entries["active-memory"].config.excludedAgents, ["profile-b"], "store excluded Profile identity, never public Agent ID");
await edit("agents-entries-profile-a-memory-search-query-maxResults", "18");
assert.equal(input("agents-entries-profile-a-memory-search-query-maxResults").props.value, "8", "pending write freezes edits");
await edit("alias-value-fixture%2Falpha", "ignored"); await edit("alias-target", "fixture/beta");
assert.equal(input("alias-value-fixture%2Falpha").props.value, "recall");
assert.equal(input("alias-target").props.value, "", "pending write also freezes alias drafts");
await settle("write", { revision: 8, config: write.args.config });
assert.equal(guard.dirty, false); assert.equal(guard.busy, false);
await choose("nativeMemory.fields.fastMode", "false");
await choose("nativeMemory.fields.persistTranscripts", "false");
await edit("agents-entries-profile-a-memory-search-query-maxResults", "9");
await edit("alias-value-fixture%2Falpha", "");
await submit(true); assert.equal(pending[0].args.config.plugins.entries["active-memory"].config.fastMode, false);
assert.equal(pending[0].args.config.plugins.entries["active-memory"].config.persistTranscripts, false);
assert.equal(pending[0].args.config.agents.entries["profile-a"].models["fixture/alpha"].alias, "", "blank alias explicitly clears an inherited value");
await settle("write", Object.assign(Error("private transport payload"), { code: "NATIVE_MEMORY_CONFIG_STALE" }), true);
assert.equal(guard.dirty, true); assert.equal(input("agents-entries-profile-a-memory-search-query-maxResults").props.value, "9");
assert.equal(input("alias-value-fixture%2Falpha").props.value, "", "a conflict retains alias edits");
assert.equal(button("common.save").props.disabled, true);
assert.equal(renderer.root.findByProps({ role: "alert" }).children[0], "nativeMemory.conflict");
assert.equal(JSON.stringify(renderer.toJSON()).includes("private transport payload"), false);
await act(async () => { button("nativeMemory.discardReload").props.onClick(); });
await settle("context", context); await settle("read", { revision: 12, config: initial });
assert.equal(input("agents-entries-profile-a-memory-search-query-maxResults").props.value, "4");
assert.equal(renderer.root.findAllByProps({ id: "memory-setting-alias-value-fixture%2Falpha" }).length, 0);
await edit("alias-target", "fixture/unsaved"); assert.equal(guard.dirty, true);
await act(async () => { guard.onDiscard(); });
assert.equal(input("alias-target").props.value, ""); assert.equal(guard.dirty, false);
await edit("alias-target", "fixture/remove");
await act(async () => { button("nativeMemory.addAlias").props.onClick(); });
await act(async () => { renderer.root.findByProps({ "aria-label": "nativeMemory.removeAlias" }).props.onClick(); });
assert.equal(guard.dirty, false, "removing a new override restores inherited configuration");
await edit("agents-entries-profile-a-memory-search-query-maxResults", "5"); await submit(true);
await settle("write", Object.assign(Error("invalid schedule"), { code: "NATIVE_MEMORY_CONFIG_INVALID" }), true);
assert.equal(button("common.save").props.disabled, false, "known validation failures remain editable at the same revision");
await edit("agents-entries-profile-a-memory-search-query-maxResults", "6"); await submit(true);
assert.equal(pending[0].args.expectedRevision, 12);
const pendingConfig = pending[0].args.config;
await act(async () => { renderer.unmount(); });
await mount(); await expand();
assert.equal(pending.length, 1, "reopened instance waits for an outstanding write before reading");
await settle("write", { revision: 13, config: pendingConfig });
await settle("context", context); await settle("read", { revision: 13, config: pendingConfig });
assert.equal(guard.dirty, false);
await choose("nativeMemory.scope", "profile-a");
assert.equal(input("agents-entries-profile-a-memory-search-query-maxResults").props.value, "6");
await act(async () => { renderer.unmount(); });
await mount(); await expand();
await act(async () => { renderer.unmount(); });
await settle("context", context);
assert.equal(pending.length, 0, "unmounted context cannot begin a config read");
await mount(); await expand(); await settle("context", context); await settle("read", { revision: 13, config: pendingConfig });
await edit("memory-search-query-maxResults", "10"); await submit(true);
await act(async () => { renderer.unmount(); });
await mount(); await expand();
await act(async () => { renderer.unmount(); });
await settle("write", { revision: 14, config: pendingConfig });
assert.equal(pending.length, 0, "unmount while awaiting an older write cannot start a context read");
// GGUF controls use the same lazy owner/CAS boundary and preserve resources
// when changing providers. Every source, executable and endpoint is fictional.
const localResources = { baseUrl: "http://127.0.0.1:19432/v1", models: [
  { id: "shared-chat", name: "Prepared model", params: { modelPath: "/fixture/chat.gguf" } }],
  params: { modelCacheDir: "/fixture/cache" }, localService: { command: "/fixture/llama-server",
    args: ["--host", "127.0.0.1", "--port", "19432"], cwd: "/fixture", healthUrl: "http://127.0.0.1:19432/health",
    readyTimeoutMs: 30000, idleStopMs: 600000 } };
const localInitial = { ...structuredClone(initial), memory: { search: { provider: "local",
  local: { modelPath: "/fixture/global.gguf" }, outputDimensionality: 384, query: { minScore: 0.3 } } },
  models: { providers: { "llama-cpp": localResources } } };
await mount(); await expand(); await settle("context", context); await settle("read", { revision: 50, config: localInitial });
assert.equal(input("memory-search-local-modelPath").props.value, "/fixture/global.gguf");
assert.equal(input("models-providers-llama-cpp-localService-args").props.value, "--host\n127.0.0.1\n--port\n19432");
await choose("nativeMemory.scope", "profile-a");
assert.equal(input("agents-entries-profile-a-memory-search-local-modelPath").props.value, "");
assert.equal(input("agents-entries-profile-a-memory-search-local-modelPath").props.placeholder, "nativeMemory.inherit");
await edit("agents-entries-profile-a-memory-search-local-modelPath", "/fixture/personal.gguf");
await edit("agents-entries-profile-a-memory-search-outputDimensionality", "768");
await choose("nativeMemory.scope", "profile-b");
assert.equal(renderer.root.findAllByProps({ id: "memory-setting-agents-entries-profile-b-memory-search-local-modelPath" }).length, 0);
await choose("nativeMemory.scope", "profile-a");
assert.equal(input("agents-entries-profile-a-memory-search-local-modelPath").props.value, "/fixture/personal.gguf");
assert.equal(input("agents-entries-profile-a-memory-search-outputDimensionality").props.value, "768");
await edit("agents-entries-profile-a-memory-search-local-modelPath", "");
await edit("agents-entries-profile-a-memory-search-outputDimensionality", "");
await choose("nativeMemory.scope", "");
await edit("memory-search-local-modelPath", "/fixture/global-new.gguf");
await edit("memory-search-outputDimensionality", "512");
await edit("models-providers-llama-cpp-localService-args", "--host\n127.0.0.1\n--embedding");
await choose("nativeMemory.fields.provider", "none");
await submit(true);
const localWrite = pending[0];
assert.equal(localWrite.args.expectedRevision, 50);
assert.equal(localWrite.args.config.memory.search.provider, "none");
assert.equal(localWrite.args.config.memory.search.local.modelPath, "/fixture/global-new.gguf");
assert.equal(localWrite.args.config.memory.search.outputDimensionality, 512);
assert.equal(localWrite.args.config.agents.entries["profile-a"].memory.search.local, undefined);
assert.equal(localWrite.args.config.agents.entries["profile-a"].memory.search.outputDimensionality, undefined);
assert.deepEqual(localWrite.args.config.agents.entries["profile-b"], localInitial.agents.entries["profile-b"]);
assert.deepEqual(localWrite.args.config.models.providers["llama-cpp"].models, localResources.models);
assert.deepEqual(localWrite.args.config.models.providers["llama-cpp"].params, localResources.params);
assert.deepEqual(localWrite.args.config.models.providers["llama-cpp"].localService.args, ["--host", "127.0.0.1", "--embedding"]);
await edit("models-providers-llama-cpp-localService-command", "/fixture/ignored");
assert.equal(input("models-providers-llama-cpp-localService-command").props.value, "/fixture/llama-server");
await settle("write", { revision: 51, config: localWrite.args.config });
assert.equal(guard.dirty, false);
assert.equal(input("memory-search-local-modelPath").props.value, "/fixture/global-new.gguf");
await choose("nativeMemory.fields.provider", "local");
await edit("memory-search-local-modelPath", "/fixture/conflict.gguf");
await edit("models-providers-llama-cpp-localService-args", "--host=::1\n--embedding");
await submit(true);
await settle("write", Object.assign(Error("private payload"), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" }), true);
assert.equal(input("memory-search-local-modelPath").props.value, "/fixture/conflict.gguf");
assert.equal(input("models-providers-llama-cpp-localService-args").props.value, "--host=::1\n--embedding");
assert.equal(guard.dirty, true); assert.equal(button("common.save").props.disabled, true);
await act(async () => { renderer.unmount(); });

await mount(); await expand(); await settle("context", context); await settle("read", { revision: 60,
  config: { memory: { search: { provider: "local" } } } });
assert.equal(input("models-providers-llama-cpp-baseUrl").props.value, "", "choosing GGUF never seeds an endpoint or executable");
assert.equal(input("models-providers-llama-cpp-localService-command").props.value, "");
await edit("models-providers-llama-cpp-baseUrl", "http://localhost:19432/v1");
await edit("models-providers-llama-cpp-localService-command", "/fixture/new-llama-server");
await edit("models-providers-llama-cpp-localService-args", "--host\nlocalhost\n--embedding");
await edit("models-providers-llama-cpp-localService-idleStopMs", "0");
await submit(true);
const newLocalWrite = pending[0];
assert.equal(newLocalWrite.args.expectedRevision, 60);
assert.deepEqual(newLocalWrite.args.config.models.providers["llama-cpp"], { baseUrl: "http://localhost:19432/v1", models: [],
  localService: { command: "/fixture/new-llama-server", args: ["--host", "localhost", "--embedding"], idleStopMs: 0 } });
assert.equal(newLocalWrite.args.config.memory.search.local, undefined, "default model source remains omitted");
await settle("write", { revision: 61, config: newLocalWrite.args.config });
assert.equal(guard.dirty, false);
assert.equal(input("models-providers-llama-cpp-localService-idleStopMs").props.value, "0");
await act(async () => { renderer.unmount(); });
// Exercise default-all and legacy policies through the rendered Settings page
// and serialized CAS replies, rather than assuming current Profiles are fixed.
const activeConfig = config => config.plugins?.entries?.["active-memory"]?.config;
const selected = name => renderer.root.findByProps({ title: name }).props.checked;
const policyLoad = async (config, revision = 100, nextContext = context) => {
  await mount(); await expand(); await settle("context", nextContext); await settle("read", { revision, config });
};
const policySave = async revision => {
  await submit(true);
  const request = pending[0]; assert.equal(request?.kind, "write"); assert.equal(request.args.expectedRevision, revision);
  const persisted = JSON.parse(JSON.stringify(request.args.config));
  await settle("write", { revision: revision + 1, config: persisted });
  assert.equal(guard.dirty, false); return persisted;
};
const allAgents = async () => { await act(async () => { button("nativeMemory.enableAllActiveAgents").props.onClick(); }); };
const newContext = { ...context, agents: [...context.agents, { profileId: "profile-c", agentId: "public-c", name: "Agent C" }] };
let policyCases = 0;
await policyLoad({});
assert.equal(selected("Agent A"), true); assert.equal(selected("Agent B"), true); assert.equal(guard.dirty, false);
assert.equal(renderer.root.findByProps({ title: "nativeMemory.active" }).props.value, "");
assert.ok(renderer.root.findAllByType("option").some(node => node.children.includes("nativeMemory.activeDefaultEnabled")));
assert.ok(renderer.root.findAllByType("option").some(node => node.children.includes("nativeMemory.activeModeDefault")));
assert.ok(JSON.stringify(renderer.toJSON()).includes("nativeMemory.activeAgentsAllHint"));
await choose("Agent B", false);
assert.equal(selected("Agent A"), true); assert.equal(selected("Agent B"), false);
await submit(true); const firstPolicyWrite = pending[0];
assert.deepEqual(activeConfig(firstPolicyWrite.args.config), { excludedAgents: ["profile-b"] });
await choose("Agent A", false); await allAgents();
assert.equal(selected("Agent A"), true); assert.equal(selected("Agent B"), false, "pending saves freeze checkbox and enable-all handlers");
const savedExclusion = JSON.parse(JSON.stringify(firstPolicyWrite.args.config));
await settle("write", { revision: 101, config: savedExclusion });
await act(async () => { renderer.unmount(); }); policyCases++;

await policyLoad(savedExclusion, 101, newContext);
assert.equal(selected("Agent A"), true); assert.equal(selected("Agent B"), false); assert.equal(selected("Agent C"), true, "new Profiles inherit participation after an exclusion was persisted");
await choose("Agent B", true);
const savedAll = await policySave(101);
assert.equal(savedAll.plugins?.entries?.["active-memory"], undefined, "reenabling the last exclusion restores default all without an explicit list");
await act(async () => { renderer.unmount(); }); policyCases++;

// Explicit old empty lists keep everyone out, even when new Profiles appear.
const legacyEmpty = { plugins: { entries: { "active-memory": { enabled: true, config: { agents: [], model: "fixture-recall" } } } } };
await policyLoad(legacyEmpty, 110, newContext);
for (const name of ["Agent A", "Agent B", "Agent C"]) assert.equal(selected(name), false);
assert.ok(JSON.stringify(renderer.toJSON()).includes("nativeMemory.activeAgentsLegacyHint"));
await edit("plugins-entries-active-memory-config-model", "fixture-new-recall");
const retainedEmpty = await policySave(110); assert.deepEqual(activeConfig(retainedEmpty).agents, []);
await allAgents(); const upgradedEmpty = await policySave(111);
assert.equal(Object.hasOwn(activeConfig(upgradedEmpty), "agents"), false);
assert.equal(Object.hasOwn(activeConfig(upgradedEmpty), "excludedAgents"), false);
assert.equal(activeConfig(upgradedEmpty).model, "fixture-new-recall");
for (const name of ["Agent A", "Agent B", "Agent C"]) assert.equal(selected(name), true);
await act(async () => { renderer.unmount(); }); policyCases++;

const legacyPartial = { memory: { search: { rememberAcrossConversations: false } }, plugins: { entries: {
  "active-memory": { enabled: true, config: { agents: ["profile-a", "unavailable-profile"], excludedAgents: ["profile-a", "profile-b"], mode: "escalate" } } } } };
await policyLoad(legacyPartial, 120, newContext);
assert.equal(selected("Agent A"), false); assert.equal(selected("Agent B"), false); assert.equal(selected("Agent C"), false);
assert.equal(selected("nativeMemory.unavailableAgent:unavailable-profile"), true);
await choose("Agent A", true); const enabledOld = await policySave(120);
assert.deepEqual(activeConfig(enabledOld).agents, ["profile-a", "unavailable-profile"], "reenabling an excluded allowed Agent preserves the legacy list");
assert.deepEqual(activeConfig(enabledOld).excludedAgents, ["profile-b"]);
await choose("Agent B", true); const enabledNew = await policySave(121);
assert.deepEqual(activeConfig(enabledNew).agents, ["profile-a", "unavailable-profile", "profile-b"]);
assert.equal(Object.hasOwn(activeConfig(enabledNew), "excludedAgents"), false, "enabling a previously excluded Agent also removes its exclusion");
await choose("nativeMemory.unavailableAgent:unavailable-profile", false); const disabledOld = await policySave(122);
assert.deepEqual(activeConfig(disabledOld).agents, activeConfig(enabledNew).agents, "turning off a legacy member does not rewrite the original allowlist");
assert.deepEqual(activeConfig(disabledOld).excludedAgents, ["unavailable-profile"]);
assert.deepEqual(disabledOld.memory, legacyPartial.memory, "Agent participation does not change cross-conversation recall");
await act(async () => { renderer.unmount(); }); policyCases++;

// Enable-all controls participation only; either explicit global off field and
// mode off remain authoritative, with unrelated settings intact.
for (const off of [{ enabled: false, config: { enabled: true } }, { enabled: true, config: { enabled: false } }]) {
  const globalOff = { memory: { search: { rememberAcrossConversations: false } }, plugins: { entries: { "active-memory": {
    ...off, config: { ...off.config, mode: "off", agents: ["profile-a"], excludedAgents: ["profile-a"], model: "fixture-model" } } } } };
  await policyLoad(globalOff, 130, newContext);
  assert.equal(renderer.root.findByProps({ title: "nativeMemory.active" }).props.value, "false");
  await allAgents(); const allWhileOff = await policySave(130);
  assert.deepEqual(allWhileOff, { memory: globalOff.memory, plugins: { entries: { "active-memory": {
    ...off, config: { ...off.config, mode: "off", model: "fixture-model" } } } } });
  assert.equal(renderer.root.findByProps({ title: "nativeMemory.active" }).props.value, "false");
  for (const name of ["Agent A", "Agent B", "Agent C"]) assert.equal(selected(name), true);
  await act(async () => { renderer.unmount(); }); policyCases++;
}

await policyLoad(savedExclusion, 140);
await allAgents(); await submit(true);
await settle("write", Object.assign(Error("private conflict"), { code: "NATIVE_MEMORY_CONFIG_CONFLICT" }), true);
assert.equal(button("nativeMemory.enableAllActiveAgents").props.disabled, true);
await choose("Agent A", false); assert.equal(selected("Agent A"), true, "a conflict freezes policy changes until reload");
await act(async () => { renderer.unmount(); }); policyCases++;
assert.equal(pending.length, 0);
console.log(`PASS active memory participation: ${policyCases} rendered policy scenarios (default/new Profiles, persistent exclusions, legacy empty/partial, explicit off preservation, conflict guards)`);
console.log("PASS native memory settings: lazy owner gate, Profile identity, scoped edits, alias drafts and inheritance, CAS, validation, conflict retention, unmount/write races, GGUF resource round-trip and provider/source inheritance");
