"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_ID = "lovable";
const SOURCE_IDENTITY = `bundled:${PACKAGE_ID}`;
// Pin the independently authored sidecar to the exact frozen Codex package.
// A catalog change requires an explicit review of the source relationship.
const SOURCE_DIGEST = "8cc06b23524e5dfe964f8efb63010bafe2b3a8f44098fae59c58527da7127c68";
const COMPONENT_NAME = "shoggoth-lovable-official";
const SERVER = "https://mcp.lovable.dev";
const READ_ONLY_TOOLS = Object.freeze(["get_me", "list_workspaces"]);
function isLovableReadOnlyTool(name) { return READ_ONLY_TOOLS.includes(name); }

function materializeLovableOfficialSidecar(destination, sourceDigest) {
  if (sourceDigest !== SOURCE_DIGEST) {
    throw new TypeError("verified frozen Lovable package revision required");
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: COMPONENT_NAME,
      version: "1.0.0",
      description: "Independent Shoggoth connection to Lovable's official MCP server",
      author: { name: "Shoggoth" },
      homepage: "https://docs.lovable.dev/integrations/lovable-mcp-server",
      extensions: { shoggoth: { mcpOAuthResources: { [COMPONENT_NAME]: SERVER } } },
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [COMPONENT_NAME]: { type: "streamable-http", url: SERVER } },
    },
    "sidecar-provenance.json": {
      version: 1,
      frozenPackageId: PACKAGE_ID,
      frozenSourceDigest: SOURCE_DIGEST,
      relationship: "independent-official-mcp-connection",
      managedConnectorEquivalent: false,
    },
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(destination, name), `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
  }
  return destination;
}

module.exports = { PACKAGE_ID, SOURCE_IDENTITY, SOURCE_DIGEST,
  COMPONENT_NAME, SERVER, READ_ONLY_TOOLS, isLovableReadOnlyTool,
  materializeLovableOfficialSidecar };
