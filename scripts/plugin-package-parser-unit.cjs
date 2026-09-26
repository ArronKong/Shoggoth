"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { previewPluginDirectory } = require("../app/agent-service/plugin-package-parser");

const fixture = path.join(__dirname, "fixtures/plugins/project-assistant");
const manifestPath = path.join(fixture, "plugin.json");
const mcpPath = path.join(fixture, "mcp.json");
const skillPath = path.join(fixture, "skills/issue-summary/SKILL.md");
const originalManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const originalMcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));

function withCopy(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-plugin-parser-"));
  const root = path.join(temp, "plugin");
  fs.cpSync(fixture, root, { recursive: true });
  try { run(root); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
function reason(preview, scope, name) {
  return preview.diagnostics.find((item) => item.scope === scope && item.name === name)?.reasonCode;
}

const base = previewPluginDirectory(fixture);
assert.equal(base.name, "project-assistant");
assert.equal(base.declaredVersion, null);
assert.equal(base.skills.length, 1);
assert.deepEqual(base.mcpServers.map((item) => item.name), ["local-issues", "remote-issues"]);
assert.equal(reason(base, "mcp-server", "bad-issue-server"), "COMPONENT_INVALID");
assert.equal(base.installable, true);
assert.equal(previewPluginDirectory(fixture).contentDigest, base.contentDigest);

withCopy((root) => {
  writeJson(path.join(root, "plugin.json"), { ...originalManifest, unknown: true, extensions: "bad" });
  const result = previewPluginDirectory(root);
  assert.equal(result.skills.length, 1);
  assert.equal(reason(result, "manifest", "unknown"), "UNKNOWN_FIELD_IGNORED");
  assert.equal(reason(result, "manifest", "extensions"), "INVALID_EXTENSION_IGNORED");
});

withCopy((root) => {
  writeJson(path.join(root, "plugin.json"), { ...originalManifest, name: "Bad--Name" });
  assert.throws(() => previewPluginDirectory(root), (error) => error.code === "PACKAGE_INVALID");
});

withCopy((root) => {
  writeJson(path.join(root, "mcp.json"), {
    ...originalMcp,
    mcpServers: {
      ...originalMcp.mcpServers,
      remote: { type: "streamable-http", url: "http://example.com/mcp" },
      legacy: { type: "sse", url: "https://example.com/mcp" },
    },
  });
  const result = previewPluginDirectory(root);
  assert.equal(result.skills.length, 1);
  assert.equal(reason(result, "mcp-server", "remote"), "COMPONENT_INVALID");
  assert.equal(reason(result, "mcp-server", "legacy"), "COMPONENT_UNSUPPORTED");
});

withCopy((root) => {
  writeJson(path.join(root, "mcp.json"), {
    ...originalMcp, "$schema": "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
  });
  const result = previewPluginDirectory(root);
  assert.equal(result.skills.length, 1);
  assert.equal(result.mcpServers.length, 0);
  assert.equal(result.diagnostics.find((item) => item.scope === "mcp")?.reasonCode,
    "FORMAT_UNSUPPORTED");
});

withCopy((root) => {
  writeJson(path.join(root, "mcp.json"), {
    ...originalMcp,
    mcpServers: {
      caseCollision: { type: "streamable-http", url: "https://example.com/mcp",
        headers: { "X-Key": "one", "x-key": "two" } },
      loopback: { type: "streamable-http", url: "http://127.0.0.1:39001/mcp" },
      leakedAuth: { type: "streamable-http", url: "https://example.com/mcp",
        headers: { Authorization: "Bearer embedded" } },
    },
  });
  const result = previewPluginDirectory(root);
  assert.deepEqual(result.mcpServers.map((entry) => entry.name), ["loopback"]);
  assert.equal(reason(result, "mcp-server", "caseCollision"), "COMPONENT_INVALID");
  assert.equal(reason(result, "mcp-server", "leakedAuth"), "COMPONENT_INVALID");
});

withCopy((root) => {
  fs.writeFileSync(path.join(root, "skills/issue-summary/SKILL.md"), "---\nname: wrong\ndescription: test\n---\n");
  const result = previewPluginDirectory(root);
  assert.equal(result.skills.length, 0);
  assert.equal(result.mcpServers.length, 2);
  assert.equal(reason(result, "skill", "issue-summary"), "COMPONENT_INVALID");
});

withCopy((root) => {
  fs.unlinkSync(path.join(root, "skills/issue-summary/SKILL.md"));
  fs.symlinkSync(path.join(os.tmpdir(), "outside-SKILL.md"), path.join(root, "skills/issue-summary/SKILL.md"));
  const result = previewPluginDirectory(root);
  assert.equal(result.skills.length, 0);
  assert.equal(result.installable, false);
  assert.equal(reason(result, "skill", "issue-summary"), "COMPONENT_INVALID");
});

withCopy((root) => {
  writeJson(path.join(root, "plugin.json"), { ...originalManifest, "$schema": "https://example.com/other" });
  assert.throws(() => previewPluginDirectory(root), (error) => error.code === "FORMAT_UNSUPPORTED");
});

assert.equal(fs.readFileSync(path.join(fixture, "bin/issue-fixture"), "utf8").includes("exit 87"), true);
console.log("plugin package parser: PASS");
