#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const requireUi = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = requireUi("typescript");
const pagePath = path.join(root, "app/manage-ui/src/pages/SettingsPage.tsx");
const source = fs.readFileSync(pagePath, "utf8");
const ast = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pureNames = new Set([
  "standingGrantView",
]);
const pureSource = ast.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && pureNames.has(statement.name.text))
  .map((statement) => statement.getText(ast))
  .join("\n");
assert.equal((pureSource.match(/function /g) || []).length, pureNames.size);

const compiled = ts.transpileModule(
  `${pureSource}\nmodule.exports = { ${[...pureNames].join(", ")} };`,
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: pagePath,
  },
).outputText;
const module = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${compiled}\n})(module, module.exports);`, {
  module,
  exports: module.exports,
});
const helpers = module.exports;

const secretCommand = "curl -H 'Authorization: Bearer top-secret'"; // gitleaks:allow -- synthetic test fixture; not a usable credential
const secretCwd = "/private/top-secret";
const grantView = helpers.standingGrantView({
  backendId: "backend-a",
  grantId: "grant-a",
  mintedByApprovalId: "approval-a",
  agentId: "agent-a",
  cronJobId: "cron-a",
  cronJobName: "Nightly",
  command: secretCommand,
  cwd: secretCwd,
  createdAtMs: 1,
  expiresAtMs: null,
  revokedAtMs: null,
  revokedBy: null,
  lastUsedAtMs: null,
  useCount: 2,
});
assert.equal(JSON.stringify(grantView).includes("top-secret"), false,
  "standing-grant UI projection must omit command and cwd");

// Settings shows Hermes/OpenClaw versions and update notices only; updating is not offered here.
assert.doesNotMatch(source, /runSelfUpdate|getSelfUpdates|startUpdate/,
  "Settings must not start backend self-updates");
assert.match(source, /listStandingGrants\(backend\.id\)/);
assert.match(source, /revokeStandingGrant\(backend\.id, grant\.grantId\)/);
assert.doesNotMatch(source, /standingGrantView\(grant\)[\s\S]{0,1200}view\.(command|cwd)/,
  "grant rendering must not reveal sensitive command/cwd fields");

console.log("openclaw settings 8.1 UI: PASS");
