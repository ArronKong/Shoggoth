"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SERVER, AUDIENCE } = require("./plugin-slack-oauth");

const PACKAGE_ID = "slack";
const SOURCE_IDENTITY = `bundled:${PACKAGE_ID}`;
// The original Codex OAuth client ID is deliberately not copied. A changed
// source requires a separate review before this independent entry is offered.
const SOURCE_DIGEST = "169278e00c4959011eb68fc9064c5e533028bb703e5bb31965bb76ea406e6f96";
const COMPONENT_NAME = "shoggoth-slack-public-search";
const READ_ONLY_TOOLS = Object.freeze(["slack_search_public"]);
function isSlackReadOnlyTool(name) { return READ_ONLY_TOOLS.includes(name); }

function materializeSlackOfficialSidecar(destination, sourceDigest) {
  if (sourceDigest !== SOURCE_DIGEST) {
    throw new TypeError("verified frozen Slack package revision required");
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: COMPONENT_NAME,
      version: "1.0.0",
      description: "Independent Shoggoth public-message search through Slack's official MCP server",
      author: { name: "Shoggoth" },
      homepage: "https://docs.slack.dev/ai/slack-mcp-server/",
      extensions: { shoggoth: { mcpOAuthResources: { [COMPONENT_NAME]: AUDIENCE } } },
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [COMPONENT_NAME]: { type: "streamable-http", url: SERVER } },
    },
    "sidecar-provenance.json": {
      version: 1,
      frozenPackageId: PACKAGE_ID,
      frozenSourceDigest: SOURCE_DIGEST,
      relationship: "independent-official-mcp-public-search",
      managedConnectorEquivalent: false,
      originalMcpEquivalent: false,
    },
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(destination, name), `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
  }
  return destination;
}

module.exports = { PACKAGE_ID, SOURCE_IDENTITY, SOURCE_DIGEST, COMPONENT_NAME,
  READ_ONLY_TOOLS, isSlackReadOnlyTool, materializeSlackOfficialSidecar };
