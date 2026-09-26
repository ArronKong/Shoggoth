"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../app/manage-ui/node_modules/typescript");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/ModelsPage.tsx"), "utf8");
const start = source.indexOf("const openAuthManage =");
const end = source.indexOf("const doSaveAuthKey =", start);
assert.ok(start > 0 && end > start);
const code = ts.transpileModule(`${source.slice(start, end)}\nglobalThis.openAuthManage = openAuthManage;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

(async () => {
  for (const supported of [false, undefined, true]) {
    const state = { calls: 0, provider: null, profiles: null };
    const context = vm.createContext({
      canManageAuthProfiles: supported,
      backendEpoch: { current: 1 }, backend: "fixture-backend",
      setAuthManage: (value) => { state.provider = value; },
      setAuthKeyInput: () => {}, setAuthProfiles: (value) => { state.profiles = value; }, setAuthSupported: () => {},
      listModelAuthProfiles: async () => {
        state.calls += 1;
        return { supported: true, profiles: [{ id: "provider:cli", provider: "provider" }, { id: "other:key", provider: "other" }] };
      },
    });
    vm.runInContext(code, context);
    await context.openAuthManage("provider");
    assert.equal(state.calls, supported ? 1 : 0, "缺省或不支持能力时不能调用授权REST");
    assert.equal(state.provider, supported ? "provider" : null, "不支持能力时不能打开授权弹窗");
    if (supported) assert.equal(state.profiles.length, 1, "支持的授权管理继续按精确provider过滤");
  }
  assert.match(source, /canManageAuthProfiles = capabilities\.manageAuthProfiles === true/);
  assert.match(source, /canManageAuthProfiles && authProviderSet\.has\(editProvider\.key\)/,
    "端点编辑页内的授权入口也必须按能力门控");
  assert.match(source, /\) : canManageAuthProfiles \? \([\s\S]*?openAuthManage\(provider\)[\s\S]*?\) : null\}/,
    "虚拟或CLI目录provider不能无条件显示授权按钮");
  assert.match(source, /open=\{canManageAuthProfiles && !!authManage\}/);
  console.log("PASS model auth capability UI: unsupported/default no dialog or REST, supported flow preserved");
})().catch((error) => { console.error(error); process.exitCode = 1; });
