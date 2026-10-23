"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");

const PACKAGE_ID = "higgsfield";
const SOURCE_IDENTITY = `bundled:${PACKAGE_ID}`;
const SOURCE_DIGEST = "fa4d8a326d810d1253b1497102037bf53edafd49ec030f457852c99d7e98dcae";
const COMPONENT_NAME = "higgsfield";
const SERVER = "https://mcp.higgsfield.ai/mcp";

function fail() {
  throw serviceError("PACKAGE_CHANGED", "Higgsfield 官方 MCP 来源合同已变化");
}

// The bundled Codex package already converts three Skills and one MCP server.
// Add only the Service-owned resource indicator to that converted staging tree.
// The frozen source files and converted Skills remain untouched.
function applyHiggsfieldOfficialOverlay(root, sourceDigest) {
  if (sourceDigest !== SOURCE_DIGEST) fail();
  const manifestPath = path.join(root, "plugin.json");
  const mcpPath = path.join(root, "mcp.json");
  let manifest;
  let mcp;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch { fail(); }
  if (manifest?.name !== PACKAGE_ID || manifest?.version !== "1.2.1"
    || manifest.extensions !== undefined || mcp?.mcpServers?.[COMPONENT_NAME]?.type !== "streamable-http"
    || mcp.mcpServers[COMPONENT_NAME].url !== SERVER
    || Object.keys(mcp.mcpServers).length !== 1) fail();
  manifest.extensions = { shoggoth: { mcpOAuthResources: { [COMPONENT_NAME]: SERVER } } };
  const temporary = path.join(root, ".higgsfield-plugin.json.tmp");
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, manifestPath);
  fs.writeFileSync(path.join(root, "official-overlay-provenance.json"),
    `${JSON.stringify({ version: 1, frozenPackageId: PACKAGE_ID,
      frozenSourceDigest: SOURCE_DIGEST, relationship: "original-official-mcp-resource",
      managedConnectorEquivalent: false }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const dirFd = fs.openSync(root, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  return root;
}

module.exports = { PACKAGE_ID, SOURCE_IDENTITY, SOURCE_DIGEST, COMPONENT_NAME, SERVER,
  applyHiggsfieldOfficialOverlay };
