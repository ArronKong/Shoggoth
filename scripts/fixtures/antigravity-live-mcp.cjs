"use strict";

// Minimal stdio MCP server for scripts/antigravity-acp-live-smoke.cjs. It records
// its parent chain (to check the harness-child ticket binding) and serves `ping`.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const readline = require("node:readline");

function processRow(pid) {
  try {
    const [ppid, ...command] = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" })
      .trim().split(/\s+/u);
    return { pid, ppid: Number(ppid), executable: command.join(" ") };
  } catch { return null; }
}

const parent = processRow(process.ppid);
const grandparent = parent ? processRow(parent.ppid) : null;
fs.appendFileSync(process.env.SMOKE_MCP_OUT, `${JSON.stringify({ pid: process.pid, parent, grandparent })}\n`);

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} }, serverInfo: { name: "shoggoth-live-smoke", version: "1" } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{ name: "ping", description: "Returns the smoke test token.",
      inputSchema: { type: "object", properties: {} } },
      ...(process.env.SMOKE_MCP_TOOL_RESULTS === "1" ? [{ name: "probe_error", description: "Returns a deliberately simulated tool failure for the isolated transport test.",
        inputSchema: { type: "object", properties: {} } }] : [])] });
  } else if (message.method === "tools/call") {
    if (message.params?.name === "probe_error" && process.env.SMOKE_MCP_TOOL_RESULTS === "1") {
      reply(message.id, { isError: true, content: [{ type: "text", text: "SYNTHETIC_TOOL_FAILURE: this is a simulated failure." }] });
      return;
    }
    reply(message.id, { content: [{ type: "text", text: `PONG-${process.env.SMOKE_MCP_NONCE}` }] });
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } })}\n`);
  }
});
