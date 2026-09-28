#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadAudit, renderReport } = require("./plugin-managed-connector-audit.cjs");

const audit = loadAudit();
const ref = (packageId, name) => audit.references.find(item => item.packageId === packageId && item.name === name);

test("frozen managed App inventory retains all references and deduplicated identities", () => {
  assert.equal(audit.references.length, 73);
  assert.equal(audit.ids.length, 53);
  assert.deepEqual(audit.emptyAppFiles, ["chatcut", "creative-production"]);
  assert.equal(Object.values(audit.referenceClasses).reduce((total, count) => total + count, 0), 73);
  assert.equal(Object.values(audit.idClasses).reduce((total, count) => total + count, 0), 53);
  assert.equal(audit.ids.find(item => item.id === ref("github", "github").id).references.length, 3);
  assert.deepEqual(audit.exactOverlapCounts, { "candidate-only": 37, unsupported: 36 });
  assert.equal(audit.references.filter(item => item.samePackageConverted.length).length, 47);
});

test("same-package converted MCP is listed without asserting managed functional overlap", () => {
  assert.deepEqual(ref("data-analytics", "mixpanel").samePackageConverted.map(item => item.name),
    ["dataAnalyticsWidgets"]);
  assert.equal(ref("data-analytics", "mixpanel").exactOverlapStatus, "unsupported");
  assert.deepEqual(ref("github", "github-enterprise").samePackageConverted.map(item => item.name),
    ["github"]);
  assert.equal(ref("github", "github-enterprise").exactOverlapStatus, "unsupported");
  assert.equal(ref("github", "github").exactOverlapStatus, "candidate-only");
});

test("exact shared App ID can point to an independent MCP candidate in another package", () => {
  assert.deepEqual(ref("data-analytics", "github").candidates.map(item => `${item.packageId}/${item.name}`),
    ["github/github"]);
  assert.deepEqual(ref("codex-security", "atlassian").candidates.map(item => `${item.packageId}/${item.name}`),
    ["atlassian-rovo/atlassian-rovo"]);
  assert.deepEqual(ref("public-equity-investing", "slack").candidates.map(item => `${item.packageId}/${item.name}`),
    ["slack/slack"]);
});

test("different managed IDs or tool names never inherit an unrelated MCP", () => {
  assert.equal(ref("github", "github-enterprise").classification, "needs-provider-adapter");
  assert.deepEqual(ref("github", "github-enterprise").candidates, []);
  assert.deepEqual(ref("data-analytics", "databricks").candidates, []);
  assert.deepEqual(ref("openai-developers", "openai-platform").candidates, []);
  assert.deepEqual(ref("adobe", "app-69312da8e4dc81919370cb86fd172b6c").candidates, []);
});

test("opaque App key only uses an exact package-name MCP candidate", () => {
  assert.deepEqual(ref("consensus", "app-6943e6f4a928819195962de16fb9ffe4")
    .candidates.map(item => `${item.packageId}/${item.name}`), ["consensus/consensus"]);
  assert.deepEqual(ref("dropbox", "app-69b31dc2110c8191b8b47dc98fe5a052")
    .candidates.map(item => `${item.packageId}/${item.name}`), ["dropbox/dropbox"]);
});

test("report enumerates every reference and preserves the fail-closed acceptance boundary", () => {
  const report = renderReport(audit);
  assert.match(report, /所有 73 次引用继续视为未适配/u);
  assert.match(report, /proven 0、candidate-only 37、unsupported 36/u);
  assert.match(report, /工具名、参数、结果和读写权限/u);
  const rows = report.split("## 每次引用（73）\n\n")[1]
    .split("\n\n## 去重托管 ID")[0].split("\n").filter(line => line.startsWith("| `"));
  assert.equal(rows.length, 73);
  for (const reference of audit.references) {
    assert.ok(report.includes(`\`${reference.packageId}/${reference.name}\``));
  }
});
