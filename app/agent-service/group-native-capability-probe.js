"use strict";

const GROUP_TOOLS = ["group_member_role_read", "group_messages_read", "group_task", "group_collaborate"];
const toolName = value => value.replace(/^(?:mcp__shoggoth__|shoggoth__|shoggoth\/)/u, "");
const INVENTORY_TIMEOUT_MS = 750;

/** Probe the acquired host's actual MCP connection/configuration. No Runtime names,
 * global availability flags, model calls, or permissions are used as evidence. */
async function probeGroupNativeToolSupport({ binding, host, issuer, factory = null, exposure = null, runId = null,
  mcpHelperLaunch = null, inventoryTimeoutMs = INVENTORY_TIMEOUT_MS }) {
  const proof = exposure?.capability({ ...binding, runId }) ?? { groupTools: false, collaborationActions: false };
  const native = host?.host;
  const identity = native?.binding ?? native;
  if (!native || identity.runtimeProfileId !== binding.runtimeProfileId || identity.runtimeAccountId !== binding.runtimeAccountId) {
    return { ...proof, collaborationSupport: proof.collaborationActions, protocolVersion: 2 };
  }
  // The configured issuer/factory belongs to this authenticated Service and to
  // this acquired host. It declares ability to bootstrap the helper; it is not
  // evidence that the model has received a tools/list page yet.
  const configured = issuer?.opened === true && (native.mcpGateIssuer === issuer
    || factory !== null && native.options?.createMcpServer === factory
    || mcpHelperLaunch !== null && require("./codex-runtime-config").validMcpBootstrapReceipt(native.groupMcpBootstrap,
      { binding, launch: mcpHelperLaunch }));
  let groupTools = proof.groupTools, collaborationActions = proof.collaborationActions;
  let collaborationSupport = configured || collaborationActions;
  if (typeof native.mcpServerStatusList === "function") {
    const budget = Number.isSafeInteger(inventoryTimeoutMs) && inventoryTimeoutMs > 0
      ? Math.min(INVENTORY_TIMEOUT_MS, inventoryTimeoutMs) : INVENTORY_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    let cursor = null; const seen = new Set();
    for (let page = 0; page < 5; page++) {
      const timeoutMs = deadline - Date.now(); if (timeoutMs <= 0) break;
      let result, timer;
      try { result = await Promise.race([
        native.mcpServerStatusList({ threadId: null, cursor, limit: 100, detail: "toolsAndAuthOnly" }, { timeoutMs }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("MCP inventory timeout"),
          { code: "REQUEST_TIMEOUT" })), timeoutMs); }),
      ]); }
      catch {
        // Inventory may be unsupported, slow or temporarily unavailable. It
        // cannot revoke authenticated tools/list proof or a configured helper,
        // and failure never supplies any additional tools or capabilities.
        break;
      }
      finally { clearTimeout(timer); }
      if (!Array.isArray(result?.data)) break;
      for (const server of result.data) {
        if (server?.name !== "shoggoth" || !server.tools || typeof server.tools !== "object" || Array.isArray(server.tools)) continue;
        const tools = new Set(Object.keys(server.tools).map(toolName));
        const legacy = GROUP_TOOLS.slice(0, 3).every(name => tools.has(name));
        groupTools ||= legacy; collaborationActions ||= legacy && tools.has("group_collaborate");
        collaborationSupport ||= legacy;
      }
      if (!result.nextCursor || seen.has(result.nextCursor)) break;
      cursor = result.nextCursor; seen.add(cursor);
    }
  }
  return { groupTools, collaborationActions, collaborationSupport, protocolVersion: 2 };
}
module.exports = { probeGroupNativeToolSupport, INVENTORY_TIMEOUT_MS };
