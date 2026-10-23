"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_ID = "outlook-calendar";
const SOURCE_IDENTITY = `bundled:${PACKAGE_ID}`;
const COMPONENT_NAME = "shoggoth-outlook-calendar-read";
const TRANSPORT = "shoggoth-graph";
const GRAPH_ENDPOINT_IDENTITY = descriptorDigest => `${TRANSPORT}:${descriptorDigest}`;

// The frozen Codex package has an .app.json managed connector declaration,
// not a portable MCP Server. These independent Shoggoth bytes are materialized
// only after the frozen source digest has been verified. No frozen file changes.
function materializeOutlookGraphSidecar(destination, sourceDigest) {
  if (!/^[a-f0-9]{64}$/u.test(sourceDigest)) throw new TypeError("frozen source digest required");
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "shoggoth-outlook-calendar-read",
      version: "1.0.0",
      description: "Independent Shoggoth read-only Microsoft Graph calendar adapter",
      author: { name: "Shoggoth" },
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [COMPONENT_NAME]: { type: TRANSPORT } },
    },
    "sidecar-provenance.json": {
      version: 1, frozenPackageId: PACKAGE_ID, frozenSourceDigest: sourceDigest,
      relationship: "independent-read-only-graph-capability",
      managedConnectorEquivalent: false,
    },
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(destination, name), `${JSON.stringify(content, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
  }
  return destination;
}

module.exports = { PACKAGE_ID, SOURCE_IDENTITY, COMPONENT_NAME, TRANSPORT,
  GRAPH_ENDPOINT_IDENTITY, materializeOutlookGraphSidecar };
