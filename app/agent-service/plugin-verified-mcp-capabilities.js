"use strict";

const { componentId } = require("./plugin-component-catalog");

const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/";
const GITHUB_ACCOUNT = /^github:[1-9][0-9]{0,19}$/u;
// Frozen .app.json provenance only. This ID is never an MCP endpoint, account,
// credential, or proof that the Codex-managed connector behaves the same way.
const GITHUB_MANAGED_REFERENCE = Object.freeze({ packageId: "github", referenceName: "github",
  managedAppId: "connector_76869538009648d5b282a4bb21c3d157" });

const GITHUB_FILE_OPERATIONS = Object.freeze([
  Object.freeze({ id: "repository-file-read", toolName: "get_file_contents",
    supplied: ["owner", "repo", "path"], optional: ["ref"], mandatory: ["owner", "repo"] }),
  Object.freeze({ id: "repository-file-write", toolName: "create_or_update_file",
    supplied: ["owner", "repo", "path", "branch", "content", "message"], optional: ["sha"],
    mandatory: ["owner", "repo", "path", "branch", "content", "message"] }),
]);
const GITHUB_ISSUE_OPERATIONS = Object.freeze([
  Object.freeze({ id: "repository-issue-read", toolName: "issue_read",
    supplied: ["method", "owner", "repo", "issue_number"],
    mandatory: ["method", "owner", "repo", "issue_number"],
    fields: Object.freeze({ method: "get", owner: "string", repo: "string", issue_number: "number" }) }),
  Object.freeze({ id: "repository-issue-comment", toolName: "add_issue_comment",
    supplied: ["owner", "repo", "issue_number", "body"],
    mandatory: ["owner", "repo", "issue_number"],
    fields: Object.freeze({ owner: "string", repo: "string", issue_number: "number", body: "comment" }) }),
]);

function own(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function acceptsString(schema) {
  return own(schema) && schema.type === "string"
    && Object.keys(schema).every(key => ["type", "title", "description"].includes(key));
}

function acceptsField(schema, kind) {
  if (kind === "string") return acceptsString(schema);
  if (!own(schema)) return false;
  if (kind === "number") return schema.type === "number"
    && Object.keys(schema).every(key => ["type", "title", "description"].includes(key));
  if (kind === "get") return schema.type === "string"
    && Array.isArray(schema.enum) && schema.enum.includes("get")
    && Object.keys(schema).every(key => ["type", "title", "description", "enum"].includes(key));
  if (kind === "comment") return schema.type === "string"
    && (schema.minLength === undefined || schema.minLength === 1)
    && Object.keys(schema).every(key => ["type", "title", "description", "minLength"].includes(key));
  return false;
}

function matchesOperation(tool, operation) {
  if (!own(tool) || tool.name !== operation.toolName
    || !own(tool.inputSchema) || tool.inputSchema.type !== "object"
    || Object.keys(tool.inputSchema).some(key => !["$schema", "type", "title",
      "description", "properties", "required", "additionalProperties"].includes(key))
    || !own(tool.inputSchema.properties)
    || !Array.isArray(tool.inputSchema.required)
    || tool.inputSchema.required.some(name => typeof name !== "string"
      || !operation.supplied.includes(name))
    || operation.mandatory.some(name => !tool.inputSchema.required.includes(name))) return false;
  return operation.supplied.every(name => acceptsField(tool.inputSchema.properties[name],
    operation.fields?.[name] || "string"))
    && (operation.optional || []).every(name => !Object.hasOwn(tool.inputSchema.properties, name)
      || acceptsString(tool.inputSchema.properties[name]));
}

// This describes a bounded independent MCP route, not equivalence with the
// opaque Codex .app.json managed connector. A matching name alone is never
// sufficient: the authenticated live tools/list must include compatible
// argument contracts, and ordinary per-tool Grants still decide execution.
function verifiedMcpCapabilities({ installation, connection, tools } = {}) {
  if (installation?.sourceIdentity !== "bundled:github"
    || connection?.installationId !== installation.installationId
    || connection.componentId !== componentId(installation.installationId, "mcp-server", "github")
    || connection.endpointIdentity !== GITHUB_MCP_ENDPOINT
    || !GITHUB_ACCOUNT.test(connection.principalIdentity || "")
    || connection.state !== "ready" || !Array.isArray(tools)) return [];
  const names = new Map(tools.filter(own).map(tool => [tool.name, tool]));
  return [...GITHUB_FILE_OPERATIONS, ...GITHUB_ISSUE_OPERATIONS].filter(operation =>
    matchesOperation(names.get(operation.toolName), operation))
    .map(operation => Object.freeze({ id: operation.id, toolName: operation.toolName }));
}

// Functional overlap with one frozen App reference, never a replacement or
// equivalence verdict. Each operation is present only after live tools/list
// passes the bounded schema check above; normal Grants still govern calls.
function managedReferenceCoverage({ installation, connection, tools } = {}) {
  const operations = verifiedMcpCapabilities({ installation, connection, tools });
  if (!operations.length) return null;
  return Object.freeze({ ...GITHUB_MANAGED_REFERENCE,
    relationship: "functional-overlap", equivalence: "unverified",
    operations: Object.freeze(operations) });
}

module.exports = { verifiedMcpCapabilities, managedReferenceCoverage };
