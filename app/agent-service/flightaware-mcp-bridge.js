"use strict";

const { createFlightawareRuntime, VERSION } = require("./flightaware-runtime");
const SAFE_ERRORS = new Set(["MCP_AUTH_REQUIRED", "FLIGHTAWARE_PYTHON_REQUIRED", "FLIGHTAWARE_METERED_DISABLED", "FLIGHTAWARE_PLAN_REQUIRED", "MCP_SERVER_RESPONSE_INVALID", "MCP_SERVER_RESPONSE_TOO_LARGE", "MCP_SERVER_CONNECTION_FAILED", "MCP_SERVER_TIMEOUT", "FLIGHTAWARE_RATE_LIMITED", "FLIGHTAWARE_INVALID_ARGUMENT", "FLIGHTAWARE_CANCELLED", "FLIGHTAWARE_BUSY"]);

function serve({ input = process.stdin, output = process.stdout, runtime = createFlightawareRuntime() } = {}) {
  const pending = new Map(); let buffer = "", closed = false, stopping;
  const write = message => { if (!closed) output.write(`${JSON.stringify(message)}\n`); };
  const stop = () => stopping ||= (async () => { closed = true; for (const item of pending.values()) item.abort(); await runtime.close(); })();
  input.setEncoding("utf8"); input.on("end", stop); input.on("error", stop);
  const signalStop = () => { stop().finally(() => process.exit(0)); };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, signalStop);
  input.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) { stop(); input.destroy(); return; }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); continue; }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") { write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); continue; }
      if (message.method === "notifications/cancelled") { pending.get(message.params?.requestId)?.abort(); continue; }
      if (message.id === undefined) continue;
      if (!["string", "number"].includes(typeof message.id) || pending.has(message.id) || pending.size >= 32) { write({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid or duplicate request id" } }); continue; }
      const abort = new AbortController(); pending.set(message.id, abort);
      Promise.resolve().then(async () => {
        if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "shoggoth-flightaware", version: VERSION } };
        if (message.method === "ping") return {};
        if (message.method === "tools/list") return { tools: await runtime.listTools({ signal: abort.signal }) };
        if (message.method === "tools/call") {
          try {
            const result = await runtime.call(message.params?.name, message.params?.arguments ?? {}, { signal: abort.signal });
            return { content: message.params?.name === "flightaware_get_map" ? [{ type: "image", data: result.map, mimeType: result.mimeType }] : [{ type: "text", text: JSON.stringify(result) }] };
          }
          catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: SAFE_ERRORS.has(error.code) ? error.code : "MCP_SERVER_RESPONSE_INVALID", ...(error.status ? { status: error.status } : {}) } }) }] }; }
        }
        throw Object.assign(new Error(), { rpcCode: -32601 });
      }).then(result => write({ jsonrpc: "2.0", id: message.id, result }), error => write({ jsonrpc: "2.0", id: message.id,
        error: { code: error.rpcCode || -32001, message: SAFE_ERRORS.has(error.code) ? error.code : "MCP_SERVER_RESPONSE_INVALID" } }))
        .finally(() => pending.delete(message.id));
    }
  });
  return { close: async () => { for (const signal of ["SIGTERM", "SIGINT"]) process.removeListener(signal, signalStop); await stop(); } };
}

module.exports = { serve, SAFE_ERRORS };
if (require.main === module) { process.umask(0o077); serve(); }
