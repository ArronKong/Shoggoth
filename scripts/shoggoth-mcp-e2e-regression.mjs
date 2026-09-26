#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, ["scripts/shoggoth-mcp-unit.cjs"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /PASS shoggoth MCP auth\/session unit/u);
assert.match(result.stdout, /完整 helper 入口通过 Service 握手后服务 stdio/u);
console.log("PASS MCP helper → authenticated Service → Product Controller 真实进程内端到端回归");
