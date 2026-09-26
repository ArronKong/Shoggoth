#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { convertLegacyPluginContents } = require("../app/core/legacy-plugin-content-adapter");
const { previewPluginDirectory, readPluginMcpServer } = require("../app/agent-service/plugin-package-parser");

const skill = (name, extra = "") => `---\nname: ${name}\ndescription: Fixture Skill\n${extra}---\nRead references/guide.md.\n`;
function fixture(format = "claude-plugin", overrides = {}) {
  const manifest = { name: "legacy-fixture", version: "1.0.0", description: "Fixture package",
    author: { name: "Fixture" }, ...overrides };
  return { format, components: ["skills", "mcp-servers"], files: [
    { path: `.${format}/plugin.json`, content: JSON.stringify(manifest) },
    { path: "skills/review/SKILL.md", content: skill("review") },
    { path: "skills/review/references/guide.md", content: "Fixture reference" },
    { path: "bin/server", content: "#!/bin/sh\nexit 99\n", executable: true },
    { path: ".mcp.json", content: JSON.stringify({ mcpServers: {
      local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["${CLAUDE_PLUGIN_ROOT}/fixtures"], env: { MODE: "fixture" } },
      remote: { type: "http", url: "https://example.invalid/mcp", headers: { "X-Fixture": "true" } },
    } }) },
  ] };
}
function generatedMcp(result) {
  const file = result.generatedFiles.find((entry) => entry.path === "mcp.json");
  return file ? JSON.parse(file.content).mcpServers : {};
}
function replaceConfig(input, servers) {
  input.files.find((file) => file.path === ".mcp.json").content = JSON.stringify({ mcpServers: servers });
  return input;
}
function materialize(input, result, root) {
  const originals = new Map(input.files.map((file) => [file.path, file]));
  for (const file of [...result.retainedPaths.map((entry) => originals.get(entry)), ...result.generatedFiles]) {
    const output = path.join(root, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.content, { mode: file.executable ? 0o700 : 0o600 });
  }
}

test("Claude default Skills and MCP convert to a standard package without executing source code", () => {
  const input = fixture("claude-plugin", { hooks: "./hooks.json", defaultEnabled: true,
    commands: "./commands", lspServers: "./.lsp.json" });
  input.files.push({ path: "hooks.json", content: JSON.stringify({ command: "touch NEVER_EXECUTE" }) });
  const before = JSON.stringify(input);
  const result = convertLegacyPluginContents(input);
  assert.equal(result.installable, true);
  assert.equal(result.provenance.format, "claude-plugin");
  assert.deepEqual(result.skills, [{ name: "review", path: "skills/review/SKILL.md" }]);
  assert.deepEqual(generatedMcp(result).local, { type: "stdio", command: "./bin/server",
    args: ["${PLUGIN_ROOT}/fixtures"], env: { MODE: "fixture", CLAUDE_PLUGIN_ROOT: "${PLUGIN_ROOT}" } });
  assert.equal(generatedMcp(result).remote.type, "streamable-http");
  assert.ok(result.diagnostics.some((item) => item.name === "hooks" && item.reasonCode === "LEGACY_FIELD_NOT_IMPORTED"));
  assert.ok(!result.retainedPaths.includes(".mcp.json"));
  assert.ok(!result.retainedPaths.includes(".claude-plugin/plugin.json"));
  assert.equal(JSON.stringify(input), before, "pure adapter leaves source bytes untouched");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-plugin-conversion-"));
  try {
    materialize(input, result, root);
    const preview = previewPluginDirectory(root);
    assert.equal(preview.installable, true);
    assert.equal(preview.skills.length, 1);
    assert.equal(preview.mcpServers.length, 2);
    assert.equal(readPluginMcpServer(preview.root, "local").spec.command, "./bin/server");
    assert.equal(fs.existsSync(path.join(root, "NEVER_EXECUTE")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Codex inline MCP is projected explicitly while Apps/interface are not imported", () => {
  const input = fixture("codex-plugin", { skills: "./skills/", apps: "./.app.json",
    interface: { displayName: "Fixture" }, mcpServers: {
      remote: { type: "http", url: "https://example.invalid/inline" },
    } });
  replaceConfig(input, { remote: { type: "http", url: "https://example.invalid/default" } });
  const result = convertLegacyPluginContents(input);
  assert.equal(generatedMcp(result).remote.url, "https://example.invalid/inline");
  assert.ok(result.diagnostics.some((entry) => entry.name === "apps"));
  assert.ok(result.diagnostics.some((entry) => entry.name === "interface"));
  assert.equal(result.provenance.manifestPath, ".codex-plugin/plugin.json");
});

test("Codex package-root cwd and presentation-only MCP fields convert without importing host data", () => {
  const input = replaceConfig(fixture("codex-plugin"), {
    local: { command: "node", args: ["./mcp/server.mjs"], cwd: ".",
      title: "Local charts", description: "Preview local artifacts",
      icons: [{ src: "./assets/chart.svg", mimeType: "image/svg+xml" }] },
    remote: { type: "http", url: "https://example.invalid/mcp",
      note: "OAuth setup instructions belong to the host UI" },
    unsafe: { command: "node", args: ["./mcp/server.mjs"], cwd: ".." },
  });
  input.files.push({ path: "mcp/server.mjs", content: "process.exit(0);\n" });
  const result = convertLegacyPluginContents(input);
  assert.deepEqual(result.mcpServers.map(item => item.name), ["local", "remote"]);
  assert.equal(generatedMcp(result).local.cwd, "${PLUGIN_ROOT}");
  assert.equal(generatedMcp(result).local.args[0], "./mcp/server.mjs");
  assert.equal(generatedMcp(result).remote.url, "https://example.invalid/mcp");
  assert.ok(result.diagnostics.some(item => item.name === "unsafe"
    && item.reasonCode === "LEGACY_MCP_ENTRY_INVALID"));
  assert.equal(result.diagnostics.filter(item => item.reasonCode
    === "LEGACY_PRESENTATION_METADATA_OMITTED").length, 2);
  assert.doesNotMatch(JSON.stringify(generatedMcp(result)), /host UI|Local charts|chart.svg/u);
});

test("selection removes unselected component activation while preserving selected Skill resources", () => {
  const input = fixture();
  input.components = ["skills"];
  const skills = convertLegacyPluginContents(input);
  assert.deepEqual(skills.mcpServers, []);
  assert.equal(skills.generatedFiles.some((file) => file.path === "mcp.json"), false);
  assert.ok(skills.retainedPaths.includes("skills/review/references/guide.md"));
  input.components = ["mcp-servers"];
  const mcp = convertLegacyPluginContents(input);
  assert.deepEqual(mcp.skills, []);
  assert.ok(!mcp.retainedPaths.some((file) => file.startsWith("skills/")));
});

test("custom path and unsupported host behavior are diagnosed without guessing a standard equivalent", () => {
  const input = fixture("claude-plugin", { skills: "./custom-skills", mcpServers: ["./extra.json"],
    userConfig: { api_token: { sensitive: true } } });
  input.files.push({ path: "custom-skills/extra/SKILL.md", content: skill("extra") });
  input.files.push({ path: "skills/unsafe/SKILL.md", content: skill("unsafe", "disable-model-invocation: true\n") });
  input.files.push({ path: "skills/host-path/SKILL.md", content: skill("host-path") + "${CLAUDE_PLUGIN_DATA}/state" });
  const result = convertLegacyPluginContents(input);
  assert.deepEqual(result.skills.map((item) => item.name), ["review"]);
  assert.ok(result.diagnostics.some((item) => item.scope === "skills" && item.reasonCode === "LEGACY_CUSTOM_PATH_UNSUPPORTED"));
  assert.ok(result.diagnostics.some((item) => item.scope === "mcp" && item.reasonCode === "LEGACY_CUSTOM_PATH_UNSUPPORTED"));
  assert.ok(result.diagnostics.some((item) => item.name === "unsafe"));
  assert.ok(result.diagnostics.some((item) => item.name === "host-path"));
  assert.ok(!result.retainedPaths.includes("skills/unsafe/SKILL.md"));
  assert.ok(!result.retainedPaths.includes("skills/host-path/SKILL.md"));
});

test("MCP entries with secrets, helper commands, unsupported transports or variables fail in isolation", () => {
  const input = replaceConfig(fixture(), {
    good: { type: "http", url: "https://example.invalid/mcp", _meta: { icon: "secret-icon-path" } },
    credential: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer secret-credential" } },
    helper: { type: "http", url: "https://example.invalid/mcp", headersHelper: "touch NEVER_EXECUTE" },
    sse: { type: "sse", url: "https://example.invalid/sse" },
    data: { command: "./bin/server", args: ["${CLAUDE_PLUGIN_DATA}/cache"] },
    userConfig: { command: "./bin/server", env: { MODE: "${user_config.mode}" } },
    envToken: { command: "./bin/server", env: { API_TOKEN: "secret-plain-token" } },
    foreignVariable: { command: "./bin/server", args: ["${PLUGIN_ROOT}/fixture"] },
    headerVariable: { type: "http", url: "https://example.invalid/mcp", headers: { "X-Root": "${CLAUDE_PLUGIN_ROOT}" } },
    outside: { command: "/usr/bin/sh", args: ["-c", "touch NEVER_EXECUTE"] },
  });
  const result = convertLegacyPluginContents(input);
  assert.deepEqual(result.mcpServers, [{ name: "good", type: "streamable-http" }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-credential|secret-plain-token|secret-icon-path|touch NEVER_EXECUTE/);
  assert.ok(result.diagnostics.some((entry) => entry.reasonCode === "LEGACY_CREDENTIAL_UNSUPPORTED"));
  assert.ok(result.diagnostics.some((entry) => entry.reasonCode === "LEGACY_VARIABLE_UNSUPPORTED"));
  assert.ok(result.diagnostics.some((entry) => entry.reasonCode === "LEGACY_TRANSPORT_UNSUPPORTED"));
});

test("unsafe paths, standard collisions, invalid selections and unrepresentable names are rejected", () => {
  for (const pathValue of ["../outside", "/etc/passwd", "a//b", "a/./b", "a/../b", "C:/secret", "a\\b"]) {
    const input = fixture();
    input.files.push({ path: pathValue, content: "bad" });
    assert.throws(() => convertLegacyPluginContents(input), { code: "LEGACY_INVENTORY_INVALID" });
  }
  const collision = fixture();
  collision.files.push({ path: "SKILLS/review/SKILL.md", content: skill("review") });
  assert.throws(() => convertLegacyPluginContents(collision), { code: "LEGACY_INVENTORY_INVALID" });
  const standard = fixture();
  standard.files.push({ path: "plugin.json", content: "{}" });
  assert.throws(() => convertLegacyPluginContents(standard), { code: "LEGACY_FORMAT_AMBIGUOUS" });
  const ancestor = fixture();
  ancestor.files.push({ path: "bin", content: "collides with bin/server" });
  assert.throws(() => convertLegacyPluginContents(ancestor), { code: "LEGACY_INVENTORY_INVALID" });
  assert.throws(() => convertLegacyPluginContents({ ...fixture(), components: ["hooks"] }), { code: "LEGACY_SELECTION_INVALID" });
  assert.throws(() => convertLegacyPluginContents(fixture("codex-plugin", { name: "UPPER_case" })),
    { code: "LEGACY_MANIFEST_UNREPRESENTABLE" });
});

test("provenance binds original bytes, selected families and executable bits deterministically", () => {
  const input = fixture();
  const initial = convertLegacyPluginContents(input);
  const reversed = convertLegacyPluginContents({ ...input, files: [...input.files].reverse() });
  assert.deepEqual(initial.provenance, reversed.provenance);
  const selection = convertLegacyPluginContents({ ...input, components: ["skills"] });
  assert.equal(selection.provenance.inputDigest, initial.provenance.inputDigest);
  assert.notEqual(selection.provenance.conversionDigest, initial.provenance.conversionDigest);
  input.files.find((file) => file.path === "bin/server").executable = false;
  assert.notEqual(convertLegacyPluginContents(input).provenance.inputDigest, initial.provenance.inputDigest);
  input.files.find((file) => file.path === "bin/server").content += "# changed\n";
  assert.notEqual(convertLegacyPluginContents(input).provenance.inputDigest, initial.provenance.inputDigest);
});
