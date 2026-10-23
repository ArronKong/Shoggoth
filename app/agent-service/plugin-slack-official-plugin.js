"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { SOURCE_DIGEST, PACKAGE_ID } = require("./plugin-slack-official-sidecar");
const { SERVER, AUDIENCE } = require("./plugin-slack-oauth");
const { FULL_COMPONENT, REVIEWED_TOOLS } = require("./plugin-slack-access-policy");
function materializeSlackMcpPlugin(destination, sourceDigest) {
  if (sourceDigest !== SOURCE_DIGEST) throw new TypeError("verified frozen Slack package revision required");
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: FULL_COMPONENT, version: "1.1.0",
      description: "Independent Slack official MCP integration with explicit user scopes and reviewed tools",
      author: { name: "Shoggoth" }, homepage: "https://docs.slack.dev/ai/slack-mcp-server/",
      extensions: { shoggoth: { mcpOAuthResources: { [FULL_COMPONENT]: AUDIENCE } } },
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [FULL_COMPONENT]: { type: "streamable-http", url: SERVER } },
    },
    "sidecar-provenance.json": {
      version: 1, frozenPackageId: PACKAGE_ID, frozenSourceDigest: SOURCE_DIGEST,
      relationship: "independent-official-mcp-reviewed-tools", reviewedTools: [...REVIEWED_TOOLS],
      managedConnectorEquivalent: false, originalMcpEquivalent: false,
    },
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(destination, name),
    `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return destination;
}
module.exports = { materializeSlackMcpPlugin };
