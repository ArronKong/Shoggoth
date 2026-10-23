"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CAPABILITIES } = require("./plugin-microsoft-graph-capabilities");
const {
  PACKAGE_ID: CALENDAR_PACKAGE_ID,
  COMPONENT_NAME: CALENDAR_COMPONENT_NAME,
  TRANSPORT,
  GRAPH_ENDPOINT_IDENTITY,
  materializeOutlookGraphSidecar,
} = require("./plugin-outlook-graph-sidecar");

const FAMILY_IDS = Object.freeze(Object.keys(CAPABILITIES));
const GRAPH_IDS = Object.freeze([CALENDAR_PACKAGE_ID, ...FAMILY_IDS]);
const COMPONENTS = Object.freeze(Object.fromEntries(GRAPH_IDS.map(id => [id,
  id === CALENDAR_PACKAGE_ID ? CALENDAR_COMPONENT_NAME : `shoggoth-${id}-read`])));

function isGraphSidecar(packageId) {
  return Object.hasOwn(COMPONENTS, packageId);
}

function componentFor(packageId) {
  return COMPONENTS[packageId] || null;
}

// This independent first-party capability is installed beside the immutable
// Codex source. The source's .app.json remains an unconverted managed connector.
function materializeGraphSidecar(destination, packageId, sourceDigest) {
  if (!isGraphSidecar(packageId) || !/^[a-f0-9]{64}$/u.test(sourceDigest)) {
    throw new TypeError("verified frozen Graph package required");
  }
  if (packageId === CALENDAR_PACKAGE_ID) {
    return materializeOutlookGraphSidecar(destination, sourceDigest);
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const component = componentFor(packageId);
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: component,
      version: "1.0.0",
      description: `Independent Shoggoth read-only Microsoft Graph ${packageId} adapter`,
      author: { name: "Shoggoth" },
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [component]: { type: TRANSPORT } },
    },
    "sidecar-provenance.json": {
      version: 1,
      frozenPackageId: packageId,
      frozenSourceDigest: sourceDigest,
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

module.exports = { FAMILY_IDS, GRAPH_IDS, COMPONENTS, TRANSPORT,
  GRAPH_ENDPOINT_IDENTITY, isGraphSidecar, componentFor, materializeGraphSidecar };
