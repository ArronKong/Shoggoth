#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = require("typescript");
function load(file, parent = import.meta.url) {
  const url = new URL(file, parent);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name.startsWith(".") ? load(`${name}.ts`, url) : require(name) });
  return exports;
}
const { categorizeTool, createTimeline, reduceTimeline, stepsFromParts, toolActivityTitle } = load("../app/manage-ui/src/lib/turnTimeline.ts");
const { PRODUCT_CAPABILITIES } = require(new URL("../app/agent-service/product-capability-manifest.js", import.meta.url).pathname);
const productTools = PRODUCT_CAPABILITIES.filter(({ domain }) => ["cron", "inspiration"].includes(domain));
assert.ok(productTools.some(({ domain }) => domain === "cron"));
assert.ok(productTools.some(({ domain }) => domain === "inspiration"));
const fixtures = productTools.flatMap(({ tool, domain }) =>
  [tool, `shoggoth/${tool}`, `shoggoth__${tool}`, `mcp__shoggoth__${tool}`].map(name => [name, domain]));
fixtures.push(["cron", "cron"], ["cronjob", "cron"], ["cronjob_manage", "cron"], ["automations", "cron"],
  ["inspiration", "inspiration"], [" Shoggoth/CRON_LIST ", "cron"],
  ["mcp__shoggoth__INSPIRATION_CREATE", "inspiration"]);
for (const [name, category] of fixtures) {
  assert.equal(categorizeTool(name), category, `${name}: dedicated category`);
  const args = { title: "Daily note" };
  let live = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "call", name, args, phase: "start" }, 10);
  assert.equal(live.steps[0].category, category, `${name}: streaming start`);
  live = reduceTimeline(live, { kind: "tool", toolCallId: "call", phase: "result", result: { ok: true } }, 20);
  assert.equal(live.steps.length, 1);
  assert.equal(live.steps[0].category, category);
  assert.equal(live.steps[0].toolName, name, "display matching preserves the original live identity");
  assert.equal(live.steps[0].status, "ok");
  const parts = [{ type: "toolCall", toolCallId: "call", toolName: name, toolArgs: args },
    { type: "toolResult", toolCallId: "call", toolName: name, text: "done" }];
  const before = JSON.stringify(parts);
  const history = stepsFromParts(parts);
  assert.equal(history.length, 1);
  assert.equal(history[0].category, category, `${name}: history`);
  assert.equal(history[0].toolName, name.trim());
  assert.equal(history[0].status, "ok");
  assert.equal(JSON.stringify(parts), before, "history remains immutable");
  let late = reduceTimeline(createTimeline(), { kind: "tool", toolCallId: "late", phase: "start" }, 10);
  late = reduceTimeline(late, { kind: "tool", toolCallId: "late", name, phase: "result", isError: true, result: "denied" }, 20);
  assert.equal(late.steps[0].category, category, `${name}: late tool identity`);
  assert.equal(late.steps[0].status, "error", "a dedicated icon preserves the failure status");
  const resultOnly = stepsFromParts([{ type: "toolResult", toolCallId: "only", toolName: name, isError: true, text: "denied" }]);
  assert.equal(resultOnly[0].category, category);
  assert.equal(resultOnly[0].status, "error");
}
for (const name of ["cronology", "inspirational_search", "mcp__unrelated__cron_list", "mcp__unrelated__inspiration_create", "unknown_tool"]) {
  assert.equal(categorizeTool(name), "other", `${name}: unrelated tools keep the fallback`);
}
assert.equal(categorizeTool("exec"), "execute");
assert.equal(categorizeTool("kanban_card_create"), "workboard");
const english = load("../app/manage-ui/src/i18n/locales/en.ts").default;
const translate = key => key.split(".").reduce((value, field) => value?.[field], english) ?? key;
assert.equal(translate("nav.inspiration"), "Spark Notes");
for (const { tool, domain } of productTools) if (domain === "inspiration") {
  for (const name of [tool, `shoggoth/${tool}`, `shoggoth__${tool}`, `mcp__shoggoth__${tool}`]) {
    assert.match(toolActivityTitle(name, {}, translate), /Spark Notes/, `${name}: App product name`);
  }
}
const { TrajGlyph } = load("../app/manage-ui/src/components/TurnTimeline/trajectoryIcons.tsx");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const icon = kind => renderToStaticMarkup(React.createElement(TrajGlyph, { kind }));
const navigationSeed = fs.readFileSync(new URL("../app/manage-ui/src/assets/nav-icons/inspiration.svg", import.meta.url), "utf8");
const pathData = svg => Array.from(svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g), match => match[1]);
assert.deepEqual(pathData(icon("inspiration")), pathData(navigationSeed), "Inspiration reuses the App navigation seed outline");
assert.equal(icon("other"), icon("execute"), "unknown tools still share the terminal icon");
assert.equal(new Set(["cron", "inspiration", "execute", "workboard"].map(icon)).size, 4, "new categories have distinct icons");
for (const kind of ["cron", "inspiration"]) {
  const svg = icon(kind);
  assert.match(svg, /width="16" height="16" viewBox="0 0 16 16"/);
  assert.match(svg, /stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/);
}
console.log(`tool-activity-category: ${fixtures.length} tool identities, live/history/late/error parity, immutable history and distinct 16px/1px icons PASS`);
