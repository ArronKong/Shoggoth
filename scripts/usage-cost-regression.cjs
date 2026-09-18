"use strict";

// 成本口径回归：Hermes 的实际/估算成本选择，以及 Token hero 的成本展示契约。
// 运行：node scripts/usage-cost-regression.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HermesBackend } = require("../app/core/hermes-backend");

const ROOT = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const tests = [
  function hermesFallsBackToEstimatedWhenActualAggregateIsZero() {
    const backend = new HermesBackend({});
    assert.equal(backend._usageCost({ actual_cost: 0, estimated_cost: 0.0860030192 }), 0.0860030192);
  },
  function hermesPrefersNonZeroActualCost() {
    const backend = new HermesBackend({});
    assert.equal(backend._usageCost({ actual_cost: 0.08, estimated_cost: 0.1 }), 0.08);
  },
  function hermesSupportsSessionUsdCostFields() {
    const backend = new HermesBackend({});
    assert.equal(backend._usageCost({ actual_cost_usd: null, estimated_cost_usd: 1.25 }), 1.25);
  },
  function tokenHeroShowsRangeCostBelowTotalTokens() {
    const source = read("app/manage-ui/src/pages/UsagePage.tsx");
    assert.match(source, /fmtCost,/);
    const totalIndex = source.indexOf('t("usage.totalTokens")');
    const costIndex = source.indexOf('className="usage-cost-summary"', totalIndex);
    const gridIndex = source.indexOf('className="usage-stat-grid"', totalIndex);
    assert.ok(totalIndex >= 0 && costIndex > totalIndex && gridIndex > costIndex, "成本应位于总 token 与分项统计之间");
    assert.match(source.slice(costIndex, gridIndex), /t\("usage\.totalCost"\)/);
    assert.match(source.slice(costIndex, gridIndex), /CountUp value=\{tot\?\.totalCost \?\? 0\} fmt=\{fmtCost\}/);
  },
  function costLabelIsLocalized() {
    assert.match(read("app/manage-ui/src/i18n/locales/zh-CN.ts"), /totalCost:\s*"成本"/);
    assert.match(read("app/manage-ui/src/i18n/locales/en.ts"), /totalCost:\s*"Cost"/);
  },
];

let failed = 0;
for (const test of tests) {
  try {
    test();
    console.log(`  ✅ ${test.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${test.name}: ${error.message}`);
  }
}
console.log(failed ? `FAILED ${failed}/${tests.length}` : `PASS ${tests.length}/${tests.length}`);
process.exit(failed ? 1 : 0);
