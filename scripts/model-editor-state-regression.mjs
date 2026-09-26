#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { build } from "../app/manage-ui/node_modules/esbuild/lib/main.js";

// 直接打包真实 TypeScript reducer，避免回归脚本复制业务规则。
async function loadStateModule() {
  const result = await build({
    entryPoints: [path.resolve("app/manage-ui/src/pages/models/model-editor-state.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

let stateModule;
try {
  stateModule = await loadStateModule();
} catch (error) {
  console.error(`model editor state regression: FAIL\n- load: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const {
  createInitialModelEditorState,
  isModelEditorDirty,
  modelEditorReducer,
  toModelChangeSpec,
  validateModelEditor,
} = stateModule;

const capabilities = {
  supported: true,
  create: true,
  update: true,
  rename: true,
  delete: true,
};
const providers = [{ key: "alpha", baseUrl: "https://api.example.com/v1", source: "config" }];
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test("create 默认已有 Provider，切到新 Provider 后渐进展开", () => {
  let state = createInitialModelEditorState("create", { providers }, capabilities);
  assert.equal(state.values.providerMode, "existing");
  assert.equal(state.values.providerKey, "alpha");
  assert.equal(state.values.baseUrl, "");
  state = modelEditorReducer(state, { type: "field", field: "providerMode", value: "new" });
  assert.equal(state.values.providerMode, "new");
  assert.equal(isModelEditorDirty(state), true);
});

test("edit 完整预填且只改 name 保留其余模型字段", () => {
  let state = createInitialModelEditorState("edit", {
    providers,
    model: {
      providerKey: "alpha",
      baseUrl: "https://api.example.com/v1",
      api: "openai-responses",
      id: "old-id",
      name: "Old",
      contextWindow: 8192,
      maxTokens: 2048,
      reasoning: false,
    },
  }, capabilities);
  assert.equal(state.providerLocked, true);
  assert.equal(isModelEditorDirty(state), false);
  state = modelEditorReducer(state, { type: "field", field: "name", value: "New" });
  const spec = toModelChangeSpec(state);
  assert.deepEqual(spec.model, {
    id: "old-id",
    name: "New",
    contextWindow: 8192,
    maxTokens: 2048,
    reasoning: false,
  });
  assert.equal(spec.sourceModelId, "old-id");
  assert.equal(spec.api, "openai-responses");
});

test("字段校验覆盖 Provider、URL、正整数与必填模型 ID", () => {
  let state = createInitialModelEditorState("create", { providers: [] }, capabilities);
  state = modelEditorReducer(state, { type: "field", field: "providerKey", value: "bad key" });
  state = modelEditorReducer(state, { type: "field", field: "baseUrl", value: "ftp://example.com" });
  state = modelEditorReducer(state, { type: "field", field: "contextWindow", value: "1.5" });
  state = modelEditorReducer(state, { type: "field", field: "maxTokens", value: "0" });
  const errors = validateModelEditor(state);
  assert.deepEqual(Object.keys(errors).sort(), ["baseUrl", "contextWindow", "id", "maxTokens", "providerKey"]);
});

test("未改动不可保存，API Key 不进入 baseline 但输入后会 dirty", () => {
  let state = createInitialModelEditorState("edit", {
    providers,
    model: { providerKey: "alpha", id: "m", name: "M", reasoning: true },
  }, capabilities);
  assert.equal("apiKey" in state.baseline, false);
  assert.equal(isModelEditorDirty(state), false);
  state = modelEditorReducer(state, { type: "field", field: "apiKey", value: "secret" });
  assert.equal(isModelEditorDirty(state), true);
  assert.equal(JSON.stringify(state.baseline).includes("secret"), false);
});

test("preview/apply/retry 复用 operationId，字段修改清空旧 preview/id", () => {
  let state = createInitialModelEditorState("create", { providers }, capabilities);
  state = modelEditorReducer(state, { type: "field", field: "id", value: "m" });
  state = modelEditorReducer(state, { type: "preview-started" });
  state = modelEditorReducer(state, {
    type: "preview-ready",
    preview: {
      previewToken: "preview-one",
      capabilities,
      references: [],
      blockers: [],
      runtimeApply: "hot",
      fingerprints: {},
    },
    confirmationRequired: false,
  });
  state = modelEditorReducer(state, { type: "apply-started", operationId: "operation-one" });
  state = modelEditorReducer(state, {
    type: "apply-result",
    result: { operationId: "operation-one", status: "partial", stage: "migrate" },
  });
  assert.equal(state.operationId, "operation-one");
  assert.equal(state.preview.previewToken, "preview-one");

  state = modelEditorReducer(state, { type: "apply-started", operationId: "operation-one" });
  assert.equal(state.operationId, "operation-one");
  state = modelEditorReducer(state, { type: "field", field: "name", value: "changed" });
  assert.equal(state.operationId, null);
  assert.equal(state.preview, null);
  assert.equal(state.phase, "idle");
});

test("blocked、cleanup_pending 与 needs_secret 都保留 operationId 供同请求续提", () => {
  for (const status of ["blocked", "cleanup_pending", "needs_secret"]) {
    let state = createInitialModelEditorState("create", { providers }, capabilities);
    state = modelEditorReducer(state, { type: "apply-started", operationId: `operation-${status}` });
    state = modelEditorReducer(state, {
      type: "apply-result",
      result: { operationId: `operation-${status}`, status, stage: "recovery" },
    });
    assert.equal(state.phase, "partial");
    assert.equal(state.operationId, `operation-${status}`);
  }
});

const failures = [];
for (const { name, run } of tests) {
  try { await run(); } catch (error) { failures.push(`${name}: ${error.stack || error}`); }
}
if (failures.length) {
  console.error(`model editor state regression: FAIL (${tests.length - failures.length}/${tests.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`model editor state regression: PASS (${tests.length}/${tests.length})`);
}
