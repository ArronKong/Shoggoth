"use strict";

const assert = require("node:assert/strict");
const { componentId } = require("../app/agent-service/plugin-component-catalog");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { verifiedMcpCapabilities, managedReferenceCoverage } =
  require("../app/agent-service/plugin-verified-mcp-capabilities");
const { validatePluginManagementResult } = require("../app/core/plugin-management-dto");
const { loadAudit } = require("./plugin-managed-connector-audit.cjs");

const installationId = "github-fixture";
const mcpComponentId = componentId(installationId, "mcp-server", "github");
const installation = { installationId, sourceIdentity: "bundled:github",
  activeReleaseDigest: "a".repeat(64) };
const connection = { installationId, componentId: mcpComponentId,
  connectionId: "github-connection", endpointIdentity: "https://api.githubcopilot.com/mcp/",
  principalIdentity: "github:42", authRevision: 1, state: "ready" };
const binding = { componentId: mcpComponentId, connectionId: connection.connectionId };
const readTool = { name: "get_file_contents", description: "Read repository content",
  inputSchema: { type: "object", properties: {
    owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" },
    ref: { type: "string" } }, required: ["owner", "repo"] } };
const writeTool = { name: "create_or_update_file", description: "Create or update a file",
  inputSchema: { type: "object", properties: {
    owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" },
    branch: { type: "string" }, content: { type: "string" }, message: { type: "string" },
    sha: { type: "string" } },
  required: ["owner", "repo", "path", "branch", "content", "message"] } };
const issueReadTool = { name: "issue_read", description: "Get issue details",
  inputSchema: { type: "object", properties: {
    method: { type: "string", enum: ["get", "get_comments", "get_labels"] },
    owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" },
    page: { type: "number", minimum: 1 },
  }, required: ["method", "owner", "repo", "issue_number"] } };
const issueCommentTool = { name: "add_issue_comment", description: "Comment on issue",
  inputSchema: { type: "object", properties: {
    owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" },
    body: { type: "string", minLength: 1 }, reaction: { type: "string" },
  }, required: ["owner", "repo", "issue_number"] } };

async function main() {
  const tools = [readTool, writeTool, issueReadTool, issueCommentTool];
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools }), [
    { id: "repository-file-read", toolName: "get_file_contents" },
    { id: "repository-file-write", toolName: "create_or_update_file" },
    { id: "repository-issue-read", toolName: "issue_read" },
    { id: "repository-issue-comment", toolName: "add_issue_comment" },
  ]);
  const coverage = managedReferenceCoverage({ installation, connection, tools });
  assert.deepEqual(coverage, { packageId: "github", referenceName: "github",
    managedAppId: "connector_76869538009648d5b282a4bb21c3d157",
    relationship: "functional-overlap", equivalence: "unverified",
    operations: verifiedMcpCapabilities({ installation, connection, tools }) });
  const frozen = loadAudit();
  assert.equal(frozen.references.length, 73);
  assert.equal(frozen.references.find(item => item.packageId === "github"
    && item.name === "github").id, coverage.managedAppId);
  assert.notEqual(frozen.references.find(item => item.packageId === "github"
    && item.name === "github-enterprise").id, coverage.managedAppId,
  "GitHub Enterprise's templated managed ID is outside this GitHub.com projection");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools: [] }), [],
    "tool names absent from the authenticated live catalog cannot be claimed");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools: [readTool] }),
    [{ id: "repository-file-read", toolName: "get_file_contents" }],
    "read-only catalogs cannot claim file-write capability");
  for (const changed of [
    { installation: { ...installation, sourceIdentity: "bundled:codex-security" } },
    { connection: { ...connection, componentId: componentId(installationId, "mcp-server", "other") } },
    { connection: { ...connection, endpointIdentity: "https://example.invalid/mcp/" } },
    { connection: { ...connection, principalIdentity: "github:other" } },
    { connection: { ...connection, state: "disconnected" } },
  ]) {
    assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools, ...changed }), [],
      "name matches cannot turn another source, endpoint or account into this profile");
    assert.equal(managedReferenceCoverage({ installation, connection, tools, ...changed }), null);
  }
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection,
    tools: [{ ...readTool, inputSchema: { ...readTool.inputSchema,
      required: ["owner", "repo", "unexpected"] } },
    { ...writeTool, inputSchema: { ...writeTool.inputSchema, properties: {
      ...writeTool.inputSchema.properties, content: { type: "object" } } } }] }), [],
  "missing or changed tool argument contracts do not produce a portable capability");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection,
    tools: [{ ...readTool, inputSchema: { ...readTool.inputSchema, properties: {
      owner: { type: "string" }, repo: { type: "string" }, ref: { type: "string" } } } },
    writeTool] }).map(item => item.id), ["repository-file-write"],
  "a file-read profile needs the path argument even when the server marks it optional");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection,
    tools: [{ ...readTool, inputSchema: { ...readTool.inputSchema,
      oneOf: [{ required: ["owner"] }] } },
    { ...writeTool, inputSchema: { ...writeTool.inputSchema, properties: {
      ...writeTool.inputSchema.properties, path: { type: "string", pattern: "^blocked$" } } } }] }), [],
  "unreviewed root or field restrictions cannot be treated as a compatible contract");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools: [
    { ...issueReadTool, inputSchema: { ...issueReadTool.inputSchema, properties: {
      ...issueReadTool.inputSchema.properties,
      method: { type: "string", enum: ["get_comments"] } } } },
    { ...issueCommentTool, inputSchema: { ...issueCommentTool.inputSchema, properties: {
      ...issueCommentTool.inputSchema.properties, body: { type: "string", pattern: "^blocked$" } } } },
  ] }), [], "method drift and restricted comment bodies remove issue coverage");
  assert.deepEqual(verifiedMcpCapabilities({ installation, connection, tools: [
    { ...issueReadTool, inputSchema: { ...issueReadTool.inputSchema,
      required: [...issueReadTool.inputSchema.required, "page"] } },
    { ...issueCommentTool, inputSchema: { ...issueCommentTool.inputSchema, properties: {
      ...issueCommentTool.inputSchema.properties, issue_number: { type: "string" } } } },
  ] }), [], "new required arguments and changed issue number types remove issue coverage");

  const registry = new PluginToolCatalogRegistry();
  let liveTools = tools;
  const client = { listTools: async () => liveTools };
  const initial = await registry.refresh({ installation, connection, client });
  assert.equal(initial.portableCapabilities.length, 4);
  assert.deepEqual(initial.referenceCoverage, coverage);
  const current = registry.listForBinding({ installation, binding, connection });
  assert.deepEqual(current.portableCapabilities, initial.portableCapabilities);
  assert.deepEqual(current.referenceCoverage, coverage);
  assert.deepEqual(validatePluginManagementResult("plugins.mcp.tools.list", {
    profileId: "profile-fixture", bindingId: "binding-fixture", available: true,
    catalogRevision: current.catalogRevision,
    portableCapabilities: current.portableCapabilities,
    referenceCoverage: current.referenceCoverage,
    items: current.entries.map(entry => ({ toolIdentity: entry.toolIdentity,
      name: entry.downstreamName, contractDigest: entry.contractDigest, savedGrant: null })),
  }).portableCapabilities, initial.portableCapabilities);
  assert.throws(() => validatePluginManagementResult("plugins.mcp.tools.list", {
    profileId: "profile-fixture", bindingId: "binding-fixture", available: true,
    catalogRevision: current.catalogRevision, portableCapabilities: current.portableCapabilities,
    referenceCoverage: { ...current.referenceCoverage, equivalence: "verified" },
    items: current.entries.map(entry => ({ toolIdentity: entry.toolIdentity,
      name: entry.downstreamName, contractDigest: entry.contractDigest, savedGrant: null })),
  }), /invalid plugin management result/u,
  "the Backend cannot turn functional overlap into managed connector equivalence");
  assert.throws(() => validatePluginManagementResult("plugins.mcp.tools.list", {
    profileId: "profile-fixture", bindingId: "binding-fixture", available: true,
    catalogRevision: current.catalogRevision,
    portableCapabilities: [{ id: "repository-file-write", toolName: "missing_write_tool" }],
    items: current.entries.map(entry => ({ toolIdentity: entry.toolIdentity,
      name: entry.downstreamName, contractDigest: entry.contractDigest, savedGrant: null })),
  }), /invalid plugin management result/u,
  "Backend rejects a capability that names a tool absent from the returned catalog");
  liveTools = [readTool, { ...writeTool, inputSchema: { ...writeTool.inputSchema,
    required: [...writeTool.inputSchema.required, "sha"] } }, issueReadTool, issueCommentTool];
  const changed = await registry.refresh({ installation, connection, client });
  assert.deepEqual(changed.portableCapabilities,
    [{ id: "repository-file-read", toolName: "get_file_contents" },
      { id: "repository-issue-read", toolName: "issue_read" },
      { id: "repository-issue-comment", toolName: "add_issue_comment" }],
    "a changed file-write contract removes only that operation from the current catalog");
  assert.notEqual(changed.catalogRevision, initial.catalogRevision);
  registry.invalidate(connection.connectionId);
  assert.equal(registry.listForBinding({ installation, binding, connection }), null);
  console.log("verified independent GitHub MCP capability profile / changed contract / invalidation: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
