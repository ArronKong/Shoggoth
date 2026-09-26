#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const identityPath = path.join(root, "app/manage-ui/src/model-identity.ts");
const chatPagePath = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const typescriptPath = path.join(root, "app/manage-ui/node_modules/typescript/lib/typescript.js");

const ts = await import(pathToFileURL(typescriptPath).href);
const source = fs.readFileSync(identityPath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: identityPath,
});
const identity = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`
);
const { defaultModelForScope } = identity;

const scopedDefaults = [
  { id: "codex-default", provider: "codex", defaultModelScopes: ["profile-codex"] },
  { id: "grok-default", provider: "grok-build", defaultModelScopes: ["profile-grok"] },
];
assert.equal(defaultModelForScope(scopedDefaults, "profile-codex"), scopedDefaults[0]);
assert.equal(defaultModelForScope(scopedDefaults, "profile-grok"), scopedDefaults[1]);
assert.equal(defaultModelForScope(scopedDefaults, "profile-missing"), undefined);
assert.equal(
  defaultModelForScope([
    ...scopedDefaults,
    { id: "ambiguous", provider: "codex", defaultModelScopes: ["profile-codex"] },
  ], "profile-codex"),
  undefined,
  "同一 Agent scope 出现多个默认模型时必须拒绝猜测",
);

const chatPage = fs.readFileSync(chatPagePath, "utf8");
assert.match(
  chatPage,
  /defaultModelForScope\(selectableModels,\s*activeCaps\?\.modelScope\)/,
  "聊天首屏必须从当前 Agent scope 的目录解析继承默认模型",
);
assert.match(
  chatPage,
  /active\?\.model\s*\?\s*undefined\s*:\s*defaultModelForScope/,
  "显式会话/Profile 模型必须优先于运行时继承默认值",
);
assert.match(
  chatPage,
  /activeProvider=\{displayModelProvider\}/,
  "模型按钮必须同时使用继承默认模型的 provider 身份",
);

console.log("chat native default model regression: PASS");
