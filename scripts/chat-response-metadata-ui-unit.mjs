import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
const ui = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(ui, "package.json"));
const React = require("react"), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const module = { exports: {} }, t = key => key;
const code = ts.transpileModule(fs.readFileSync(path.join(ui, "src/pages/ChatResponseMetadata.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(code, { exports: module.exports, module, require: name => name === "react-i18next" ? { useTranslation: () => ({ t }) } : require(name) });
const { default: Footer } = module.exports;
const render = (metadata, fallbackModel) => renderToStaticMarkup(React.createElement(Footer, { metadata, fallbackModel }));
const known = { models: ["runtime-model"], modelSource: "reported", usage: { inputTokens: 36800, outputTokens: 584, cachedInputTokens: 2000, cacheWriteInputTokens: 1000, totalTokens: 37384 },
  context: { usedTokens: 8000, windowTokens: 200000, quality: "estimated" } };
const before = JSON.stringify(known), html = render(known);
assert.ok(html.includes('class="chat-response-model"') && html.includes("runtime-model"));
assert.ok(html.includes('<span class="dot" aria-hidden="true">·</span>'), "separator shares the model's visibility");
for (const value of ["↑", "↓", "R2k", "W1k", "ctx", " tok", "8,000", "36.8k"])
  assert.ok(!html.includes(value), "usage and context never render: " + value);
assert.equal(JSON.stringify(known), before, "hiding metrics does not mutate response facts");
assert.equal(render(null), "");
assert.equal(render({}), "");
assert.equal(render({ usage: { inputTokens: 99999, outputTokens: 1 } }), "");
assert.equal(render({ usage: { inputTokens: 0, outputTokens: 0 } }), "");
assert.equal(render({ usage: { totalTokens: 99999 } }), "");
assert.equal(render({ context: known.context }), "");
assert.ok(render(null, "openclaw-model").includes("openclaw-model"), "legacy OpenClaw model stays available");
assert.ok(render(null, "hermes-model").includes("hermes-model"), "legacy Hermes model stays available");
assert.equal(render(null, "gateway-injected"), "");
assert.ok(render({ models: ["chosen"], modelSource: "selected" }).includes("chat.responseSelectedModel"));
assert.ok(render({ models: ["a", "b"], modelSource: "reported" }).includes("chat.responseMultipleModels"));
assert.ok(render({ models: ["a", "b"] }).includes("a\nb"), "all reported model IDs remain accessible");
console.log("PASS response metadata UI: model-only footer, hidden usage/context, preserved facts, legacy models, missing/zero/total, selected and multiple models");
