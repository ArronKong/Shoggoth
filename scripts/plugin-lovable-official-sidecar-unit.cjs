"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");
const { PACKAGE_ID, SOURCE_DIGEST, COMPONENT_NAME, SERVER,
  materializeLovableOfficialSidecar } = require("../app/agent-service/plugin-lovable-official-sidecar");

const catalog = new BundledPluginCatalog(bundledRoot());
const source = catalog.assertCurrent(PACKAGE_ID);
assert.equal(source.sourceDigest, SOURCE_DIGEST);
assert.equal(source.importStatus, "needs-adapter");
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(catalog.packagePath(PACKAGE_ID),
  ".app.json"), "utf8")), { apps: { lovable: {
  id: "asdk_app_693a0a79ffe48191901173077edcf914",
} } });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-sidecar-"));
try {
  const wrong = path.join(temp, "wrong");
  assert.throws(() => materializeLovableOfficialSidecar(wrong, "0".repeat(64)), TypeError);
  assert.equal(fs.existsSync(wrong), false);
  const root = path.join(temp, "sidecar");
  materializeLovableOfficialSidecar(root, source.sourceDigest);
  assert.equal(fs.existsSync(path.join(root, ".app.json")), false);
  const provenance = JSON.parse(fs.readFileSync(path.join(root,
    "sidecar-provenance.json"), "utf8"));
  assert.equal(provenance.frozenSourceDigest, SOURCE_DIGEST);
  assert.equal(provenance.managedConnectorEquivalent, false);
  const preview = previewPluginDirectory(root);
  assert.equal(preview.installable, true);
  assert.equal(preview.mcpServers.length, 1);
  assert.equal(preview.mcpServers[0].name, COMPONENT_NAME);
  assert.equal(preview.mcpServers[0].type, "streamable-http");
  const mcp = JSON.parse(fs.readFileSync(path.join(root, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers[COMPONENT_NAME].url, SERVER);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(manifest.extensions.shoggoth.mcpOAuthResources[COMPONENT_NAME], SERVER);
  assert.throws(() => materializeLovableOfficialSidecar(root, SOURCE_DIGEST));
  console.log("Lovable source-pinned independent sidecar: PASS");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
