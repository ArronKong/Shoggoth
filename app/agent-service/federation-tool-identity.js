"use strict";

const FEDERATION_RESULT_TOOLS = new Set([
  "federation_agent_run",
  "federation_agent_message",
  "federation_task_get",
]);
const GENERIC_MCP_TOOL_WRAPPERS = new Set([
  "call_mcp_tool", "use_tool", "CallMcpTool", "UseTool",
]);
const TASK_STATUSES = new Set([
  "queued", "starting", "running", "waiting_approval", "waiting_input",
  "completed", "failed", "canceled", "interrupted", "skipped",
]);
const MAX_RAW_RESULT_BYTES = 128 * 1024;
const MAX_TASK_RESULT_BYTES = 32 * 1024;
const MAX_PLAIN_DISPLAY_BYTES = 20 * 1024;
const MAX_OUTPUT_NODES = 32;
const MAX_OUTPUT_DEPTH = 3;
const OUTPUT_WRAPPER_KEYS = Object.freeze([
  "OkayOutput", "okayOutput", "output", "structuredContent", "content", "result", "text",
]);

function ownRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function validString(value, maxBytes, allowEmpty = false) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0")
    && (allowEmpty || value.length > 0) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function parsedInput(value) {
  if (ownRecord(value)) return value;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return ownRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function scopedFederationToolName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  for (const toolName of FEDERATION_RESULT_TOOLS) {
    if (name === `shoggoth/${toolName}`
      || name === `shoggoth__${toolName}`
      || name === `mcp__shoggoth__${toolName}`) return toolName;
  }
  return null;
}

function directFederationToolName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return FEDERATION_RESULT_TOOLS.has(name) ? name : scopedFederationToolName(name);
}

function canonicalFederationResultToolName(tool) {
  if (!ownRecord(tool)) return null;
  const direct = directFederationToolName(tool.name);
  if (direct) return direct;
  if (typeof tool.name !== "string" || !GENERIC_MCP_TOOL_WRAPPERS.has(tool.name.trim())) {
    return null;
  }
  const input = parsedInput(tool.input);
  if (!input) return null;
  const referencedTool = input.toolName ?? input.tool_name ?? input.tool;
  const scoped = scopedFederationToolName(referencedTool);
  if (scoped) return scoped;
  const unscoped = directFederationToolName(referencedTool);
  if (!unscoped) return null;
  const server = input.server ?? input.serverName ?? input.server_name
    ?? input.mcpServer ?? input.mcp_server;
  return typeof server === "string" && server.trim().toLowerCase() === "shoggoth"
    ? unscoped : null;
}

function parseResultObject(rawText) {
  if (typeof rawText !== "string" || !rawText.isWellFormed()
    || rawText.includes("\0") || Buffer.byteLength(rawText, "utf8") > MAX_RAW_RESULT_BYTES) {
    return null;
  }
  const text = rawText.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (ownRecord(parsed)) return parsed;
  } catch {}

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let last = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (ownRecord(parsed)) last = parsed;
        } catch {}
        start = -1;
      }
    }
  }
  return last;
}

function publicFederationTaskResult(payload) {
  const agent = payload?.agent;
  const task = payload?.task;
  if (!ownRecord(agent) || !ownRecord(task)
    || !validString(agent.backendId, 64)
    || !validString(agent.agentId, 128)
    || !validString(agent.name, 256)
    || !validString(task.taskId, 256)
    || !TASK_STATUSES.has(task.status)
    || !Number.isSafeInteger(task.turn) || task.turn < 1 || task.turn > 1_000
    || (task.result !== null && !validString(task.result, MAX_TASK_RESULT_BYTES, true))
    || (task.errorCode !== null && !validString(task.errorCode, 128))) return null;
  return {
    agent: {
      backendId: agent.backendId,
      agentId: agent.agentId,
      name: agent.name,
    },
    task: {
      taskId: task.taskId,
      status: task.status,
      turn: task.turn,
      waitingFor: task.waitingFor === "approval" || task.waitingFor === "input"
        ? task.waitingFor : null,
      result: task.result,
      errorCode: task.errorCode,
    },
  };
}

function federationTaskResultFromOutput(toolName, rawOutput) {
  if (!directFederationToolName(toolName)) return null;
  const queue = [{ value: rawOutput, depth: 0 }];
  const visited = new Set();
  let inspected = 0;
  while (queue.length > 0 && inspected < MAX_OUTPUT_NODES) {
    const { value, depth } = queue.shift();
    inspected += 1;
    if (typeof value === "string") {
      const projected = publicFederationTaskResult(parseResultObject(value));
      if (projected) return projected;
      continue;
    }
    if ((!ownRecord(value) && !Array.isArray(value)) || visited.has(value)) continue;
    visited.add(value);
    if (ownRecord(value)) {
      const projected = publicFederationTaskResult(value);
      if (projected) return projected;
      if (depth >= MAX_OUTPUT_DEPTH) continue;
      for (const key of OUTPUT_WRAPPER_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          queue.push({ value: value[key], depth: depth + 1 });
        }
      }
    } else if (depth < MAX_OUTPUT_DEPTH) {
      for (const item of value.slice(0, MAX_OUTPUT_NODES - inspected)) {
        queue.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return null;
}

function serializeFederationTaskResult(value, maxBytes) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= Math.min(maxBytes, MAX_PLAIN_DISPLAY_BYTES)) {
    return serialized;
  }
  if (typeof value?.task?.result !== "string") return null;
  const characters = Array.from(value.task.result);
  const encoded = (length, truncated) => JSON.stringify({
    ...value,
    task: {
      ...value.task,
      result: null,
      resultEncoding: "base64-utf8",
      resultBase64: Buffer.from(
        `${characters.slice(0, length).join("")}${truncated ? "…" : ""}`,
        "utf8",
      ).toString("base64"),
    },
  });
  const complete = encoded(characters.length, false);
  if (Buffer.byteLength(complete, "utf8") <= maxBytes) return complete;
  let low = 0;
  let high = characters.length;
  let accepted = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = encoded(middle, true);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      accepted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return accepted;
}

module.exports = {
  canonicalFederationResultToolName,
  federationTaskResultFromOutput,
  serializeFederationTaskResult,
};
