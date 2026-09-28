"use strict";

// This intentionally exercises only the frozen server's handshake and its
// no-Codex-thread rejection. It never starts a scan or borrows host secrets.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { convertLegacyPluginContents } = require("../app/core/legacy-plugin-content-adapter");

const repo = path.resolve(__dirname, "..");
const packageRoot = path.join(repo, "resources/bundled-plugins/packages/codex-security");
const frozen = JSON.parse(fs.readFileSync(path.join(packageRoot, ".mcp.json"), "utf8"))
  .mcpServers["codex-security"];

function assertImporterBoundary() {
  const manifest = { name: "codex-security", version: "1.0.0", description: "Boundary fixture" };
  const files = [
    { path: ".codex-plugin/plugin.json", content: JSON.stringify(manifest) },
    { path: "scripts/launch_codex_security_mcp", content: "#!/bin/sh\nexit 99\n", executable: true },
    { path: ".mcp.json", content: "" },
  ];
  const input = { format: "codex-plugin", bundledCodex: true,
    components: ["mcp-servers"], files };
  const check = (declaration, bundledCodex = true) => {
    input.bundledCodex = bundledCodex;
    files[2].content = JSON.stringify({ mcpServers: { "codex-security": declaration } });
    const result = convertLegacyPluginContents(input);
    assert.deepEqual(result.mcpServers, []);
    assert.equal(result.generatedFiles.some(file => file.path === "mcp.json"), false);
    assert.equal(result.retainedPaths.includes(".mcp.json"), false);
    assert(result.diagnostics.some(issue => issue.scope === "mcp-server"
      && issue.name === "codex-security"
      && issue.reasonCode === "LEGACY_MCP_FIELD_UNSUPPORTED"));
  };
  check(frozen);
  // Dropping every host-only field cannot erase the server's runtime needs.
  const { env_vars: _env, startup_timeout_sec: _startup,
    tool_timeout_sec: _tool, ...stripped } = frozen;
  check(stripped);
  check(stripped, false);
  check({ ...stripped, startup_timeout_sec: 120, tool_timeout_sec: 120 });
}

async function isolatedProbe(sandbox) {
  const { Client } = require("@modelcontextprotocol/client");
  const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
  const targetPath = path.join(sandbox, "target");
  fs.mkdirSync(targetPath, { mode: 0o700 });
  const client = new Client({ name: "shoggoth-security-boundary-fixture", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: path.join(packageRoot, frozen.command), args: frozen.args,
    cwd: packageRoot, stderr: "pipe",
    env: { HOME: sandbox, PATH: "/usr/bin:/bin", CODEX_MCP_NODE_PATH: process.execPath,
      CODEX_SECURITY_SCAN_ROOT: path.join(sandbox, "scans"),
      CODEX_SECURITY_STATE_DIR: path.join(sandbox, "state"),
      PYTHONDONTWRITEBYTECODE: "1" },
  });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const listed = await client.listTools({}, { timeout: 10_000 });
    assert.equal(listed.tools.length, 45);
    assert(listed.tools.every(tool => ["app", "model"].some(audience =>
      JSON.stringify(tool._meta?.ui?.visibility) === JSON.stringify([audience]))));
    assert(listed.tools.some(tool => tool.name === "start_codex_security_prompt_only_scan"));
    assert(listed.tools.some(tool => tool.name === "start_codex_security_deep_scan"));
    assert(listed.tools.some(tool => tool.name === "open_codex_security_workspace"
      && JSON.stringify(tool._meta?.ui?.visibility) === '["app"]'));
    const audienceCounts = Object.fromEntries(["app", "model"].map(audience => [audience,
      listed.tools.filter(tool => JSON.stringify(tool._meta.ui.visibility)
        === JSON.stringify([audience])).length]));
    assert.deepEqual(audienceCounts, { app: 25, model: 20 });
    const rejected = await client.callTool({ name: "start_codex_security_prompt_only_scan",
      arguments: { mode: "standard", targetPath, scope: "." } }, { timeout: 10_000 });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content.map(item => item.text || "").join("\n"),
      /requires the owning Codex thread context/u);
    assert.equal(fs.existsSync(path.join(sandbox, "scans")), false);
    process.stdout.write(`${JSON.stringify({ listed: listed.tools.length, audienceCounts,
      noCodexThreadRejected: true, scanStarted: false })}\n`);
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[2] === "--isolated-child") {
  isolatedProbe(process.argv[3]).catch(error => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  assert.equal(frozen.command, "./scripts/launch_codex_security_mcp");
  assert.deepEqual(frozen.args, ["--stdio"]);
  assert.equal(frozen.cwd, ".");
  assert.equal(frozen.env_vars.length, 43);
  assert.equal(frozen.startup_timeout_sec, 120);
  assert.equal(frozen.tool_timeout_sec, 349200);
  assertImporterBoundary();
  const report = fs.readFileSync(path.join(repo,
    "docs/architecture/codex-security-mcp-runtime-gap-2026-09-27.md"), "utf8");
  const table = report.split("## 43 个来源环境变量逐项归属")[1]?.split("上述各行分别覆盖")[0];
  assert(table, "Codex Security environment audit table missing");
  const auditedNames = [...table.matchAll(/`([A-Z][A-Z0-9_]+)`/gu)].map(match => match[1]);
  assert.equal(auditedNames.length, frozen.env_vars.length);
  assert.deepEqual([...auditedNames].sort(), [...frozen.env_vars].sort());
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-security-boundary-"));
  try {
    fs.chmodSync(sandbox, 0o700);
    const run = spawnSync(process.execPath, [__filename, "--isolated-child", sandbox], {
      cwd: repo, encoding: "utf8", timeout: 20_000,
      env: { HOME: sandbox, LOGNAME: "fixture", USER: "fixture", SHELL: "/bin/sh",
        PATH: "/usr/bin:/bin", CODEX_MCP_NODE_PATH: process.execPath,
        PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(run.status, 0, `isolated server probe failed: ${run.stderr.trim()}`);
    const result = JSON.parse(run.stdout.trim());
    assert(result.listed > 0);
    assert.equal(result.audienceCounts.app + result.audienceCounts.model, result.listed);
    assert.equal(result.noCodexThreadRejected, true);
    assert.equal(result.scanStarted, false);
    process.stdout.write(`Codex Security isolated MCP boundary: ${result.listed} tools `
      + `(${result.audienceCounts.app} app, ${result.audienceCounts.model} model); `
      + "owning Codex thread required; no scan started\n");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
