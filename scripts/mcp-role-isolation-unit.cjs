"use strict";
// The isolated MCP helper checks its module cache at startup. A product module
// in that graph fails every native turn with RUNTIME_START_MCP_INITIALIZE_FAILED.
const test = require("node:test"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("loading the real MCP helper keeps ProductStore and domain roots out of the isolated process", () => {
  const script = [
    'const bootstrap = require("./app/bootstrap-role")',
    'require("./app/shoggoth-mcp-helper")',
    'bootstrap.assertMcpRoleIsolation()',
  ].join(";");
  assert.doesNotThrow(() => execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 10_000, stdio: "pipe",
  }));
});
