#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const require = createRequire(import.meta.url);
const pagePath = new URL("../app/manage-ui/src/pages/DashboardPage.tsx", import.meta.url);
const cssPath = new URL("../app/manage-ui/src/pages/dashboard/DashboardPage.css", import.meta.url);
const page = readFileSync(pagePath, "utf8");
const css = readFileSync(cssPath, "utf8");

function loadFunction(name) {
  const source = ts.createSourceFile("DashboardPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `${name} 必须是可回归的模块级纯函数`);
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require });
  return module.exports[name];
}

const aggregateKpiTrendPoints = loadFunction("aggregateKpiTrendPoints");
const trends = aggregateKpiTrendPoints([
  {
    daily: Array.from({ length: 8 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      totalTokens: (index + 1) * 10,
      totalCost: index + 1,
    })),
  },
  {
    daily: [
      { date: "2026-08-07", totalTokens: 7, totalCost: 0.7 },
      { date: "2026-08-08", totalTokens: 8, totalCost: 0.8 },
    ],
  },
  null,
]);

assert.deepEqual(Array.from(trends.tokens), [20, 30, 40, 50, 60, 77, 88], "Tokens 曲线只保留最近 7 天并跨后端求和");
assert.deepEqual(Array.from(trends.costs), [2, 3, 4, 5, 6, 7.7, 8.8], "Cost 曲线必须与 Tokens 共用最近 7 天窗口");

assert.match(page, /getUsageSeries\(id,\s*"7d"\)/, "趋势请求必须保持 7d");
assert.doesNotMatch(page, /function KpiCostBars\(/, "Today's cost 不应保留独立柱状趋势组件");
assert.match(page, /function KpiSpark\(\{ points, gradientId \}/, "Token 与 Cost 必须复用同一个曲线组件");
assert.match(page, /chart=\{<KpiSpark points=\{trendPoints\.tokens\} gradientId="kpi-token-spark-fill" \/>\}/, "Token 卡必须使用独立渐变 ID 的 KpiSpark");
assert.match(page, /chart=\{<KpiSpark points=\{trendPoints\.costs\} gradientId="kpi-cost-spark-fill" \/>\}/, "成本卡必须复用 KpiSpark 与文字遮罩");
assert.match(page, /<linearGradient id=\{gradientId\}/, "每张曲线卡必须使用自己的渐变定义");

const taskBoard = page.slice(page.indexOf("function TaskBoardCard("), page.indexOf("// 昨日环比"));
assert.doesNotMatch(taskBoard, /KpiMesh|kpi-mesh|kpi-scrim/, "Task Board 必须是设计稿中的纯白卡片");
assert.doesNotMatch(page, /MeshGradient|KPI_MESH_COLORS|function KpiMesh/, "Dashboard KPI 不应继续加载旧 mesh 背景");

assert.doesNotMatch(css, /\.kpi-cost-bars?\b/, "成本卡不应残留柱图样式");
assert.match(css, /\.tb-cols\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*149px\)\);/s, "Task Board 两列必须按最新 Figma 保持 149px");
assert.match(css, /\.tb-row\s*\{[^}]*gap:\s*4px;/s, "Task Board 头像与名称必须按最新 Figma 保持 4px 间距");

console.log("dashboard-kpi-design-regression: 13/13 passed");
