#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { validatePluginManagementResult } = require("../app/core/plugin-management-dto");

const preview = {
  sourceKind: "bundled", previewDigest: "a".repeat(64), expectedRevision: 0,
  specVersion: "1.0.0", name: "shoggoth-gogcli-gmail", declaredVersion: "1.0.0",
  installable: true, components: { skills: [], mcpServers: [{
    name: "shoggoth-gogcli-gmail", type: "shoggoth-gogcli-gmail-mcp",
    descriptorDigest: "b".repeat(64),
  }] }, diagnostics: [],
};
assert.deepEqual(validatePluginManagementResult("plugins.install.preview", preview), preview);
for (const candidate of [
  { ...preview, sourceKind: "directory" },
  { ...preview, name: "other" },
  { ...preview, components: { ...preview.components,
    mcpServers: [{ ...preview.components.mcpServers[0], name: "other" }] } },
]) assert.throws(() => validatePluginManagementResult("plugins.install.preview", candidate));
console.log("gogcli Gmail preview DTO: PASS");
