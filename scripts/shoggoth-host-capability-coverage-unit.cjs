#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { HOST_CAPABILITIES, assertUiHostOpsCoverage } = require("../app/host-capability-manifest");
const { PRODUCT_CAPABILITIES } = require("../app/agent-service/product-capability-manifest");

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

console.log(`PASS host capability coverage (${HOST_CAPABILITIES.length})`);
