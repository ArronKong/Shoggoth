"use strict";

const assert = require("node:assert/strict");
const { buildPluginToolCatalog } = require("../app/agent-service/plugin-tool-contract");

const identity = { installationId: "a".repeat(64),
  componentId: "b".repeat(64), connectionId: "account-a" };
const read = { name: "issues/read", description: "Read one issue",
  inputSchema: { type: "object", properties: { issueId: { type: "string" } },
    required: ["issueId"] }, annotations: { readOnlyHint: true } };
const write = { name: "issues/create", description: "Create one issue",
  inputSchema: { type: "object", properties: { title: { type: "string" } },
    required: ["title"] }, annotations: { destructiveHint: false } };
const initial = buildPluginToolCatalog({ ...identity, tools: [read, write] });
const reordered = buildPluginToolCatalog({ ...identity, tools: [
  { annotations: { destructiveHint: false }, inputSchema: { required: ["title"],
    properties: { title: { type: "string" } }, type: "object" },
  description: "Create one issue", name: "issues/create" },
  { annotations: { readOnlyHint: true }, inputSchema: { required: ["issueId"],
    properties: { issueId: { type: "string" } }, type: "object" },
  description: "Read one issue", name: "issues/read" },
] });
assert.equal(initial.generationDigest, reordered.generationDigest);
assert.deepEqual(initial.entries, reordered.entries);

const accountB = buildPluginToolCatalog({ ...identity, connectionId: "account-b",
  tools: [read, write] });
assert.notEqual(initial.entries[0].toolIdentity, accountB.entries[0].toolIdentity);
assert.equal(initial.entries[0].contractDigest, accountB.entries[0].contractDigest);
const opaqueInstallation = buildPluginToolCatalog({ ...identity,
  installationId: "local-plugin-1", tools: [read] });
assert.ok(opaqueInstallation.entries[0].toolIdentity.includes("local-plugin-1"));

const changed = buildPluginToolCatalog({ ...identity, tools: [read,
  { ...write, inputSchema: { ...write.inputSchema,
    properties: { title: { type: "string", maxLength: 100 } } } }] });
assert.notEqual(initial.generationDigest, changed.generationDigest);
assert.notEqual(initial.entries[0].contractDigest, changed.entries[0].contractDigest);
assert.equal(initial.entries[0].toolIdentity, changed.entries[0].toolIdentity);

assert.throws(() => buildPluginToolCatalog({ ...identity, tools: [read, read] }),
  (error) => error.code === "MCP_SERVER_RESPONSE_INVALID");
assert.throws(() => buildPluginToolCatalog({ ...identity, tools: [
  { ...read, annotations: { readOnlyHint: undefined } }] }),
(error) => error.code === "MCP_SERVER_RESPONSE_INVALID");
assert.throws(() => buildPluginToolCatalog({ ...identity, tools: [
  { ...read, description: "x".repeat(140_000) },
  { ...write, description: "y".repeat(140_000) }] }),
(error) => error.code === "MCP_SERVER_RESPONSE_INVALID");
console.log("plugin tool contract catalog: PASS");
