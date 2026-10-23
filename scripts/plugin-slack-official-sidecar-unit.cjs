"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");
const { PACKAGE_ID, SOURCE_DIGEST, COMPONENT_NAME, READ_ONLY_TOOLS,
  materializeSlackOfficialSidecar } = require("../app/agent-service/plugin-slack-official-sidecar");
const { SERVER, AUDIENCE } = require("../app/agent-service/plugin-slack-oauth");

const catalog = new BundledPluginCatalog(bundledRoot());
const source = catalog.assertCurrent(PACKAGE_ID);
assert.equal(source.sourceDigest, SOURCE_DIGEST);
assert.equal(source.importStatus, "needs-adapter");
assert.deepEqual(source.converted, { skills: 0, mcp: 0 });
assert.deepEqual(READ_ONLY_TOOLS, ["slack_search_public"]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-sidecar-"));
try {
  const wrong = path.join(temp, "wrong");
  assert.throws(() => materializeSlackOfficialSidecar(wrong, "0".repeat(64)), TypeError);
  assert.equal(fs.existsSync(wrong), false);
  const root = path.join(temp, "sidecar");
  materializeSlackOfficialSidecar(root, source.sourceDigest);
  assert.equal(fs.existsSync(path.join(root, ".app.json")), false);
  const provenance = JSON.parse(fs.readFileSync(path.join(root,
    "sidecar-provenance.json"), "utf8"));
  assert.equal(provenance.frozenSourceDigest, SOURCE_DIGEST);
  assert.equal(provenance.managedConnectorEquivalent, false);
  assert.equal(provenance.originalMcpEquivalent, false);
  const preview = previewPluginDirectory(root, { trustedBundled: true });
  assert.equal(preview.installable, true);
  assert.deepEqual(preview.mcpServers.map(item => item.name), [COMPONENT_NAME]);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers[COMPONENT_NAME].url, SERVER);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(manifest.extensions.shoggoth.mcpOAuthResources[COMPONENT_NAME], AUDIENCE);
  assert.throws(() => materializeSlackOfficialSidecar(root, SOURCE_DIGEST));
  console.log("Slack source-pinned independent public-search sidecar: PASS");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
