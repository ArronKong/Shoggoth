"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { CURRENT_MEMORY_RULE, createDefaultDocuments } = require("../app/agent-service/agent-definition-defaults");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { PermissionEngine } = require("../app/agent-service/permission-engine");

test("tool catalog has no memory confirmation action and requires the user's quote", () => {
  const tools = DEFAULT_TOOL_REGISTRY.mcpDefinitions();
  assert.equal(tools.some((tool) => tool.name === "memory_confirm"), false);
  assert.doesNotMatch(DEFAULT_TOOL_REGISTRY.toolsMarkdown(), /memory_confirm|unconfirmed notes|inferred facts stay candidates/u);
  const schema = tools.find((tool) => tool.name === "memory_save").inputSchema;
  assert.deepEqual(schema.properties.classification.enum, ["explicit"]);
  assert.ok(schema.required.includes("sourceQuote"));
});
