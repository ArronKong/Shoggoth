#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const { HOST_CAPABILITIES, assertUiHostOpsCoverage } = require("../app/host-capability-manifest");
const { PRODUCT_CAPABILITIES } = require("../app/agent-service/product-capability-manifest");
const typescript = createRequire(path.join(__dirname, "../app/manage-ui/package.json"))("typescript");

const productTools = new Set(PRODUCT_CAPABILITIES.map((item) => item.tool));
const agentCapabilities = HOST_CAPABILITIES.filter((item) => item.exposure === "agent-tool");
const uiCapabilities = HOST_CAPABILITIES.filter((item) => item.exposure === "ui-only");

assert.deepEqual(agentCapabilities.map((item) => item.id), [
  "system.application-search",
  "system.application-launch",
  "system.open-url",
  "finder.open-folder",
]);
for (const item of agentCapabilities) {
  for (const tool of item.tools) assert.equal(productTools.has(tool), true, `${item.id}:${tool}`);
}

const validHostOps = Object.fromEntries(uiCapabilities.map((item) => [item.hostOp, () => {}]));
assert.equal(assertUiHostOpsCoverage(validHostOps), true);
assert.throws(() => assertUiHostOpsCoverage({ ...validHostOps, unclassifiedCapability() {} }),
  /显式标记/u);
const missing = { ...validHostOps };
delete missing.reveal;
assert.throws(() => assertUiHostOpsCoverage(missing), /显式标记/u);

// Parse the actual Electron source without starting the app. A hostOps key added
// there must also be classified in the manifest before the package is built.
const uiEntryPath = path.join(__dirname, "../app/ui-entry.js");
const uiEntry = typescript.createSourceFile(uiEntryPath, fs.readFileSync(uiEntryPath, "utf8"),
  typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
assert.equal(uiEntry.parseDiagnostics.length, 0, "ui-entry.js must parse without errors");
const hostOpsDeclarations = uiEntry.statements
  .filter(typescript.isVariableStatement)
  .flatMap((statement) => statement.declarationList.declarations)
  .filter((declaration) => typescript.isIdentifier(declaration.name) && declaration.name.text === "hostOps");
assert.equal(hostOpsDeclarations.length, 1, "ui-entry.js must declare exactly one hostOps object");
const hostOpsInitializer = hostOpsDeclarations[0].initializer;
assert.ok(typescript.isObjectLiteralExpression(hostOpsInitializer), "hostOps must be an object literal");
const actualHostOps = hostOpsInitializer.properties.map((property) => {
  assert.ok(typescript.isPropertyAssignment(property) || typescript.isMethodDeclaration(property),
    "hostOps must use explicit properties, without spreads or shorthand");
  assert.ok(typescript.isIdentifier(property.name) || typescript.isStringLiteral(property.name),
    "hostOps keys must be static names");
  return property.name.text;
});
assert.equal(new Set(actualHostOps).size, actualHostOps.length, "hostOps must not repeat keys");
assert.deepEqual(actualHostOps.sort(), uiCapabilities.map((item) => item.hostOp).sort(),
  "ui-entry.js hostOps keys must match the ui-only host capability manifest");

console.log(`PASS host capability coverage (${HOST_CAPABILITIES.length})`);
