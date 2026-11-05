#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import extension from "../resources/pi/shoggoth-pi-extension.mjs";
const require = createRequire(import.meta.url);
const { MCP_PRODUCT_TOOL_DEFINITIONS } = require("../app/agent-service/mcp-product-tool-controller");
const { residentToolDefinitions } = require("../app/agent-service/product-tool-exposure");
const resident = residentToolDefinitions(MCP_PRODUCT_TOOL_DEFINITIONS);
const longDescription = "完整说明🙂\n".repeat(5000) + "END_OF_DESCRIPTION";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-"));
const relay = path.join(scratch, "relay.cjs");
fs.writeFileSync(relay, `const readline = require("node:readline");
const tools = ${JSON.stringify(MCP_PRODUCT_TOOL_DEFINITIONS)};
const resident = ${JSON.stringify(resident)};
const boundary = { ...tools[0], description: "界".repeat(5461) + "a" };
const long = { ...tools[0], description: ${JSON.stringify(longDescription)} };
const mode = process.argv[2];
readline.createInterface({ input: process.stdin }).on("line", line => {
 const m = JSON.parse(line); if (!m.id) return;
 let result;
 if (m.method === "initialize") result = { capabilities: { tools: {} } };
 else if (m.method === "tools/list") {
   if (mode === "paged") { const offset = Number(m.params.cursor || 0); result = { tools: tools.slice(offset, offset + 40), ...(offset + 40 < tools.length ? { nextCursor: String(offset + 40) } : {}) }; }
   else if (mode === "loop") result = { tools: [], nextCursor: "same" };
   else if (mode === "duplicate") result = { tools: [tools[0], tools[0]] };
   else if (mode === "resident") result = { tools: resident };
   else if (mode === "exact") result = { tools: [boundary] };
   else if (mode === "over-16k") result = { tools: [{ ...boundary, description: "界".repeat(5462) }] };
   else if (mode === "long") result = { tools: [long] };
   else if (mode === "frame-boundary" || mode === "oversized") {
     result = { tools: [{ ...boundary, description: "" }] };
     const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
     result.tools[0].description = "x".repeat(256 * 1024 - overhead + (mode === "oversized" ? 1 : 0));
   }
   else if (mode === "count") result = { tools: Array.from({ length: 257 }, (_, i) => ({ ...boundary, name: "tool_" + i, description: "ok" })) };
   else if (mode === "invalid") result = { tools: [tools[1], { ...boundary, description: "bad\\0description" }] };
   else if (mode === "invalid-unicode") result = { tools: [tools[1], { ...boundary, description: "bad\\ud800description" }] };
   else if (mode === "invalid-type") result = { tools: [tools[1], { ...boundary, description: {} }] };
   else result = { tools };
 } else if (m.method === "tools/call") result = { content: [{ type: "text", text: "x".repeat(70 * 1024) }] };
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});`);
const keys = ["SHOGGOTH_PI_MCP_COMMAND", "SHOGGOTH_PI_MCP_ARGS", "SHOGGOTH_PI_PERMISSION_POLICY"];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
try {
 process.env.SHOGGOTH_PI_MCP_COMMAND = process.execPath;
 process.env.SHOGGOTH_PI_PERMISSION_POLICY = JSON.stringify({ approvalPolicy: "on-request", sandbox: "workspace-write" });
 for (const mode of ["full", "paged", "resident", "loop", "duplicate", "exact", "over-16k", "long", "frame-boundary", "oversized", "count", "invalid", "invalid-unicode", "invalid-type"]) {
   process.env.SHOGGOTH_PI_MCP_ARGS = JSON.stringify([relay, mode]);
   const tools = [], handlers = new Map();
   const api = { registerTool: tool => tools.push(tool), on: (name, callback) => handlers.set(name, callback) };
   if (["loop", "duplicate", "oversized", "count", "invalid", "invalid-unicode", "invalid-type"].includes(mode)) {
     await assert.rejects(() => extension(api), mode === "oversized" ? /catalog exceeds its transport size limit/u : /catalog is invalid/u);
     assert.equal(tools.length, 0);
   } else {
     await extension(api);
     try {
       if (mode === "exact") {
         assert.equal(tools.length, 1);
         assert.equal(Buffer.byteLength(tools[0].description), 16 * 1024);
       } else if (mode === "over-16k") {
         assert.equal(tools.length, 1);
         assert.equal(tools[0].description, "界".repeat(5462));
       } else if (mode === "long") {
         assert.equal(tools.length, 1);
         assert.equal(tools[0].description, longDescription);
       } else if (mode === "frame-boundary") {
         assert.equal(tools.length, 1);
         assert.ok(Buffer.byteLength(tools[0].description) > 250 * 1024);
       } else {
         const expected = mode === "resident" ? resident : MCP_PRODUCT_TOOL_DEFINITIONS;
         assert.deepEqual(tools.map(({ name, description }) => ({ name, description })),
           expected.map(({ name, description }) => ({ name, description })));
       }
       if (mode === "full") {
         await assert.rejects(() => tools[0].execute("call", {}, null, null, {}), /Oversized Shoggoth MCP frame/u);
       }
     } finally { handlers.get("session_shutdown")(); }
   }
 }
 console.log("PASS Pi production catalogs, full long descriptions, pagination, catalog capacity, invalid catalogs and ordinary frame limit");
} finally {
 for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
 fs.rmSync(scratch, { recursive: true, force: true });
}
