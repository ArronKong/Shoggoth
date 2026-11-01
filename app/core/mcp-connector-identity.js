"use strict";
const crypto = require("node:crypto");
function mcpConnectorSubjectId(backendId, agentId) {
  if (!["shoggoth", "openclaw", "hermes"].includes(backendId) || typeof agentId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(agentId)) throw new TypeError("Invalid MCP connector subject");
  return backendId === "shoggoth" ? agentId : `mcp-${backendId}-${crypto.createHash("sha256").update(agentId).digest("hex").slice(0, 40)}`;
}
module.exports = { mcpConnectorSubjectId };
