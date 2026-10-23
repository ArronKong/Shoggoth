"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { readPrivateFile } = require("./agent-service/private-file");
const { GROUP_MCP_TOOL_DEFINITIONS, validateGroupMcpArguments, explainGroupMcpArguments } = require("./agent-service/group-mcp-tools");
const p = require("./group-runtime-host-protocol");

function loadRuntimeConnection(file) {
  const value = JSON.parse(readPrivateFile(file, { maxBytes: 16 * 1024 }).toString("utf8"));
  if (!p.exact(value, ["version", "baseUrl", "hostId", "backendId", "agentId", "runtimeToken"]) || ![1, p.VERSION].includes(value.version)
    || !p.validPeer({ id: "runtime", baseUrl: value.baseUrl, hostId: value.hostId, backendId: value.backendId,
      agentId: value.agentId, token: value.runtimeToken })) p.fail("GROUP_HOST_CONFIG_INVALID");
  return value;
}
function runtimeRequest(connection, input, timeoutMs = 65_000) {
  const url = new URL("/group-host/runtime", connection.baseUrl);
  const body = Buffer.from(JSON.stringify(input));
  if (body.length > p.FRAME_BYTES) return Promise.reject(new Error("GROUP_HOST_REQUEST_INVALID"));
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: {
      authorization: `Bearer ${connection.runtimeToken}`, "content-type": "application/json", "content-length": body.length,
    } }, response => {
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > p.FRAME_BYTES) request.destroy(new Error("GROUP_HOST_RESPONSE_INVALID")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) p.fail("GROUP_HOST_AUTH_FAILED");
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || value.ok !== true) p.fail(/^GROUP_HOST_[A-Z_]+$/u.test(value?.error?.code ?? "") ? value.error.code : "GROUP_HOST_UNAVAILABLE");
          resolve(value.result);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("GROUP_HOST_TIMEOUT")));
    request.on("error", reject); request.end(body);
  });
}
function createGroupRuntimeMcpHandler({ connection, request = runtimeRequest }) {
  const instanceId = crypto.randomUUID();
  let ready = false;
  let collaborationSupported = false;
  const inventory = GROUP_MCP_TOOL_DEFINITIONS.map(tool => tool.name);
  const register = async () => {
    let value;
    try {
      value = await request(connection, { agentId: connection.agentId, register: true, instanceId,
        protocolVersion: 2, tools: inventory }, 5_000);
    } catch (error) {
      if (error?.code !== "GROUP_HOST_REQUEST_INVALID") throw error;
      // A legacy Host may register the old tool set. This is registration only, never execution replay.
      value = await request(connection, { agentId: connection.agentId, register: true, instanceId }, 5_000);
    }
    if (value.hostId !== connection.hostId || value.registered !== true) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
    collaborationSupported = value.protocolVersion === 2 && Array.isArray(value.tools) && value.tools.includes("group_collaborate");
    ready = true;
  };
  return { register,
    async close() { ready = false; collaborationSupported = false; try { await request(connection, { agentId: connection.agentId, register: false, instanceId }, 3_000); } catch {} },
    async handle(input) {
      if (!input || input.jsonrpc !== "2.0" || typeof input.method !== "string") return null;
      if (!Object.hasOwn(input, "id")) return null;
      try {
        let result;
        if (input.method === "initialize") {
          await register();
          result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "shoggoth-group-host", version: "2" },
            instructions: "Use groupToken only for its current group turn or task. Each Agent retains its own role, permissions and memory." };
        } else if (input.method === "ping") result = {};
        else if (input.method === "tools/list" && ready) result = { tools: GROUP_MCP_TOOL_DEFINITIONS.filter(tool => tool.name !== "group_collaborate" || collaborationSupported) };
        else if (input.method === "tools/call" && ready) {
          const { name, arguments: args } = input.params ?? {};
          if (name === "group_collaborate" && !collaborationSupported) p.fail("GROUP_HOST_TOOL_UNSUPPORTED");
          if (!validateGroupMcpArguments(name, args) || !Object.hasOwn(args, "groupToken")) {
            const { problems, hints } = explainGroupMcpArguments(name, args);
            if (args && typeof args === "object" && !Object.hasOwn(args, "groupToken")) problems.unshift("此通道必须使用本轮 groupToken，不能用 source/sourceId 代替");
            return { jsonrpc: "2.0", id: input.id, result: { content: [{ type: "text",
              text: `GROUP_HOST_TOOL_INVALID: ${[...problems, ...hints].join("；") || "群工具参数组合无效"}` }],
              structuredContent: { error: { code: "GROUP_HOST_TOOL_INVALID", problems } }, isError: true } };
          }
          const value = await request(connection, { agentId: connection.agentId, callId: `${instanceId}:${input.id}`, name, arguments: args });
          result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: value?.ok === false };
        } else return { jsonrpc: "2.0", id: input.id, error: { code: -32601, message: "Method unavailable" } };
        return { jsonrpc: "2.0", id: input.id, result };
      } catch (error) {
        return { jsonrpc: "2.0", id: input.id, error: { code: -32000,
          message: /^GROUP_HOST_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "GROUP_HOST_UNAVAILABLE" } };
      }
    },
  };
}
async function serveStdio(connection) {
  const handler = createGroupRuntimeMcpHandler({ connection });
  let buffer = "";
  const heartbeat = setInterval(() => { void handler.register().catch(() => {}); }, 60_000); heartbeat.unref();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > p.FRAME_BYTES) { process.stdin.destroy(); return; }
    let line;
    while ((line = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, line); buffer = buffer.slice(line + 1);
      let input;
      try { input = JSON.parse(raw); } catch { continue; }
      void handler.handle(input).then(value => {
        if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
      });
    }
  });
  process.stdin.on("end", () => { clearInterval(heartbeat); void handler.close(); });
}

module.exports = { loadRuntimeConnection, runtimeRequest, createGroupRuntimeMcpHandler, serveStdio };
