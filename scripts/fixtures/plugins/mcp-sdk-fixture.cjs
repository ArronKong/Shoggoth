"use strict";

const readline = require("node:readline");

const TOOL = { name: "echo", description: "Echo fixture input", inputSchema: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"],
  additionalProperties: false,
} };

function handle(message, version = "2025-11-25", state = { calls: 0 }) {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "server/discover") {
    if (version !== "2026-07-28") return { jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "Method not found" } };
    return { jsonrpc: "2.0", id: message.id, result: {
      supportedVersions: [version], capabilities: { tools: state.notify
        ? { listChanged: true } : {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
    } };
  }
  if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: version, capabilities: { tools: state.notify
      ? { listChanged: true } : {} }, serverInfo: { name: "fixture", version: "1" },
  } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id,
    result: { ...(version === "2026-07-28"
      ? { resultType: "complete", ttlMs: 0, cacheScope: "private" } : {}),
    tools: [state.notify && state.calls > 0
      ? { ...TOOL, description: `Echo fixture input ${state.calls}` } : TOOL] } };
  if (message.method === "tools/call") {
    state.calls += 1;
    const value = message.params?.arguments?.value ?? "";
    return { jsonrpc: "2.0", id: message.id, result: {
      ...(version === "2026-07-28" ? { resultType: "complete" } : {}),
      content: [{ type: "text", text: String(value) }],
      structuredContent: { echoed: value,
        ...(value === "__scope__" && state.scope ? { scope: state.scope } : {}) },
      isError: false,
    } };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}

if (require.main === module) {
  const version = process.argv[2] || "2025-11-25";
  const state = { calls: 0, notify: process.argv[3] === "notify",
    scope: { pluginRoot: process.env.PLUGIN_ROOT || null,
      pluginData: process.env.PLUGIN_DATA || null,
      cwd: process.cwd(), arg3: process.argv[3] || null, arg4: process.argv[4] || null,
      envRootRef: process.env.FIXTURE_ROOT_REF || null } };
  const input = readline.createInterface({ input: process.stdin });
  for (const output of [process.stdout]) output.on("error", () => process.exit(0));
  input.on("line", (line) => {
    let response;
    let message;
    try { message = JSON.parse(line); response = handle(message, version, state); }
    catch { process.exitCode = 1; input.close(); return; }
    if (response && state.notify && message.method === "tools/call") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0",
        method: "notifications/tools/list_changed" })}\n`);
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

module.exports = { handle, TOOL };
