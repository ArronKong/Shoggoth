"use strict";

const crypto = require("node:crypto");
const { serviceError } = require("./security");

function fail() { throw serviceError("MCP_SERVER_RESPONSE_INVALID", "MCP 工具合同无效"); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value, depth = 0) {
  if (depth > 32) fail();
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  fail();
}

function mcpToolContractDigest(tool) { return digest(canonical(tool)); }

module.exports = { mcpToolContractDigest };
