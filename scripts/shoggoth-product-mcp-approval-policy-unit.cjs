#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { ProductMcpApprovalPolicy } = require(
  "../app/agent-service/product-mcp-approval-policy",
);

let registryRevision = "tools-1";
let permissionRevision = 7;
let profile = {
  id: "profile-a",
  enabled: true,
  runtimeProfileId: "runtime-a",
};
let effect = "allow";
const toolRegistry = {
  get(name) {
    return name === "computer_type" ? { tool: name, enabled: true } : null;
  },
  get revision() { return registryRevision; },
};
const permissionEngine = {
  profileProjection(profileId) {
    assert.equal(profileId, "profile-a");
    return {
      registryRevision,
      revision: permissionRevision,
      tools: [{ name: "computer_type", enabled: true, effect }],
    };
  },
};
const productStore = { getAgentProfile: () => profile };
const policy = new ProductMcpApprovalPolicy({ toolRegistry, permissionEngine, productStore });

function request(overrides = {}) {
  return {
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "shoggoth",
      mode: "form",
      message: 'Allow the shoggoth MCP server to run tool "computer_type"?',
      requestedSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    run: { id: "run-a", profileId: "profile-a" },
    executionContract: {
      runId: "run-a",
      profileId: "profile-a",
      runtimeProfileId: "runtime-a",
      toolRegistryRevision: "tools-1",
      toolPermissionRevision: 7,
    },
    ...overrides,
  };
}

assert.deepEqual(policy.evaluate(request()), { action: "accept", content: {} });

assert.equal(policy.evaluate(request({
  params: { ...request().params, serverName: "third-party" },
})), null);
assert.equal(policy.evaluate(request({
  params: {
    ...request().params,
    message: 'Allow the shoggoth MCP server to run tool "unknown_tool"?',
  },
})), null);
assert.equal(policy.evaluate(request({
  params: { ...request().params, requestedSchema: { type: "object", properties: { yes: {} } } },
})), null);

registryRevision = "tools-2";
assert.equal(policy.evaluate(request()), null);
registryRevision = "tools-1";
permissionRevision = 8;
assert.equal(policy.evaluate(request()), null);
permissionRevision = 7;
effect = "deny";
assert.equal(policy.evaluate(request()), null);
effect = "allow";
profile = { ...profile, runtimeProfileId: "runtime-b" };
assert.equal(policy.evaluate(request()), null);
profile = { ...profile, runtimeProfileId: "runtime-a", enabled: false };
assert.equal(policy.evaluate(request()), null);

console.log("Shoggoth Product MCP approval policy unit tests passed");
