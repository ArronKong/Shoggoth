#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import extension from "../resources/pi/shoggoth-pi-extension.mjs";
const require = createRequire(import.meta.url);
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../app/agent-service/mcp-product-tool-controller");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-"));
const relay = path.join(scratch, "relay.cjs");
fs.writeFileSync(relay, `const readline = require("node:readline");
const tools = ${JSON.stringify(MCP_PRODUCT_TOOL_DEFINITIONS)};
const mode = process.argv[2];
readline.createInterface({ input: process.stdin }).on("line", line => {
 const m = JSON.parse(line); if (!m.id) return;
 let result;
 if (m.method === "initialize") result = { capabilities: { tools: {} } };
 else if (m.method === "tools/list") {
   if (mode === "paged") { const offset = Number(m.params.cursor || 0); result = { tools: tools.slice(offset, offset + 40), ...(offset + 40 < tools.length ? { nextCursor: String(offset + 40) } : {}) }; }
   else if (mode === "loop") result = { tools: [], nextCursor: "same" };
   else if (mode === "duplicate") result = { tools: [tools[0], tools[0]] };
   else result = { tools };
 } else if (m.method === "tools/call") result = { content: [{ type: "text", text: "x".repeat(70 * 1024) }] };
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`);
const keys = ["SHOGGOTH_PI_MCP_COMMAND", "SHOGGOTH_PI_MCP_ARGS", "SHOGGOTH_PI_PERMISSION_POLICY"];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
try {
 process.env.SHOGGOTH_PI_MCP_COMMAND = process.execPath;
 process.env.SHOGGOTH_PI_PERMISSION_POLICY = JSON.stringify({ approvalPolicy: "on-request", sandbox: "workspace-write" });
 for (const mode of ["full", "paged", "loop", "duplicate"]) {
   process.env.SHOGGOTH_PI_MCP_ARGS = JSON.stringify([relay, mode]);
   const tools = [], handlers = new Map();
   const api = { registerTool: tool => tools.push(tool), on: (name, callback) => handlers.set(name, callback) };
   if (["loop", "duplicate"].includes(mode)) {
     await assert.rejects(() => extension(api), /catalog is invalid/u); assert.equal(tools.length, 0);
   } else {
     await extension(api); assert.equal(tools.length, MCP_PRODUCT_TOOL_DEFINITIONS.length);
     assert(tools.some(row => row.name === "app_manage")); assert(tools.some(row => row.name === "federation_agent_list"));
     await assert.rejects(() => tools[0].execute("call", {}, null, null, {}), /Oversized Shoggoth MCP frame/u);
     handlers.get("session_shutdown")();
   }
 }
 console.log("PASS Pi full >64KiB catalog, future pagination, cursor/duplicate rejection and ordinary frame limit");
} finally {
 for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
 fs.rmSync(scratch, { recursive: true, force: true });
}
