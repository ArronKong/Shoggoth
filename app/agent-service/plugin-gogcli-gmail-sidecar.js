"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_ID = "gmail";
const SOURCE_IDENTITY = `bundled:${PACKAGE_ID}`;
const SOURCE_DIGEST = "a99b016a9613f5eb2e622181d7b55910e15f8cf79414bfc5c3ccbcc378a84d3e";
const COMPONENT_NAME = "shoggoth-gogcli-gmail";
const TRANSPORT = "shoggoth-gogcli-gmail-mcp";
const endpointIdentity = descriptorDigest => `${TRANSPORT}:${descriptorDigest}`;

const READ_TOOLS = Object.freeze([
  "gmail_search", "gmail_get_message", "gmail_get_thread", "gmail_list_drafts",
  "gmail_get_draft", "gmail_list_labels",
]);
const ORDINARY_WRITE_TOOLS = Object.freeze([
  "gmail_create_draft", "gmail_update_draft", "gmail_create_label",
  "gmail_modify_messages", "gmail_modify_thread", "gmail_mark_read",
  "gmail_mark_unread", "gmail_archive_messages", "gmail_trash_messages",
  "gmail_restore_messages",
]);
const SEND_TOOLS = Object.freeze(["gmail_send_message", "gmail_send_draft"]);
const DELETE_TOOLS = Object.freeze(["gmail_delete_draft", "gmail_delete_messages"]);
const REVIEWED_TOOLS = Object.freeze([
  ...READ_TOOLS, ...ORDINARY_WRITE_TOOLS, ...SEND_TOOLS, ...DELETE_TOOLS,
]);

function materializeGogGmailSidecar(destination, sourceDigest) {
  if (sourceDigest !== SOURCE_DIGEST) {
    throw new TypeError("verified frozen Gmail package revision required");
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  const files = {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: COMPONENT_NAME, version: "1.0.0",
      description: "Independent Shoggoth Gmail integration through pinned gogcli typed MCP tools",
      author: { name: "Shoggoth" }, homepage: "https://gogcli.sh/mcp.html",
    },
    "mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [COMPONENT_NAME]: { type: TRANSPORT } },
    },
    "sidecar-provenance.json": {
      version: 1, frozenPackageId: PACKAGE_ID, frozenSourceDigest: SOURCE_DIGEST,
      relationship: "independent-pinned-gogcli-typed-mcp",
      reviewedTools: [...REVIEWED_TOOLS], managedConnectorEquivalent: false,
      originalMcpEquivalent: false,
    },
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(destination, name), `${JSON.stringify(content, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
  }
  return destination;
}

module.exports = { PACKAGE_ID, SOURCE_IDENTITY, SOURCE_DIGEST, COMPONENT_NAME, TRANSPORT,
  READ_TOOLS, ORDINARY_WRITE_TOOLS, SEND_TOOLS, DELETE_TOOLS, REVIEWED_TOOLS,
  endpointIdentity, materializeGogGmailSidecar };
