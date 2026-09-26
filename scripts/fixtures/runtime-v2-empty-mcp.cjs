"use strict";

// S6 runner-only transport fixture. It has no filesystem/network access, no
// product credentials and no callable tools. This is not a business MCP test.
if (!/^\/(?:private\/)?tmp\/sglive-[^/]+$/u.test(process.env.HOME || "")
  || !process.argv.includes("--shoggoth-internal-role=mcp")) process.exit(1);
let pending = "", bytes = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  bytes += Buffer.byteLength(chunk);
  pending += chunk;
  if (bytes > 2 * 1024 * 1024 || pending.length > 64 * 1024) process.exit(1);
  for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    let request;
    try { request = JSON.parse(line); } catch { process.exit(1); }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") process.exit(1);
    if (request.id === undefined) continue;
    let result;
    if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "s6-empty-transport-fixture", version: "1" } };
    else if (request.method === "tools/list") result = { tools: [] };
    else if (request.method === "resources/list") result = { resources: [] };
    else if (request.method === "resources/templates/list") result = { resourceTemplates: [] };
    else if (request.method === "prompts/list") result = { prompts: [] };
    else if (request.method === "ping") result = {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
      ...(result === undefined ? { error: { code: -32601, message: "Fixture has no callable tools" } } : { result }) })}\n`);
  }
});
