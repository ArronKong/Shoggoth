"use strict";

// Some Runtimes load every MCP tool definition into every request. For them the
// Shoggoth MCP helper lists only RESIDENT_PRODUCT_TOOLS plus two entry tools;
// every other product tool stays callable through product_tool_call, which the
// helper routes as an ordinary call to that tool, with the same confirmations
// and permission checks. Runtimes not listed here discover MCP tools on demand
// themselves (Codex, Grok) or are not measured yet, and keep the full list.

const { PRODUCT_CAPABILITIES } = require("./product-capability-manifest");

const RESIDENT_TOOL_RUNTIMES = Object.freeze(new Set(["pi", "deepseek-harness", "opencode"]));
const PRODUCT_TOOL_SEARCH = "product_tool_search";
const PRODUCT_TOOL_CALL = "product_tool_call";
const MAX_SEARCH_RESULTS = 10;

// Chosen from recorded native tool calls and the flows that must not need a
// search first: user input, workspace execution, help/state, memory and
// definitions, Skills, web and browser, chat UI, the in-group tools (group
// capability proof requires them in tools/list), heartbeat replies and Kanban
// run reporting.
const RESIDENT_PRODUCT_TOOLS = Object.freeze(new Set([
  "request_user_input", "workspace_execute",
  "app_help_search", "app_help_get", "app_capabilities", "app_state_get",
  "runtime_context_get", "profile_get",
  "memory_search", "memory_get", "memory_save", "memory_forget", "conversation_search", "conversation_get",
  "agent_definition_read", "agent_definition_update",
  "skill_catalog", "skill_read", "skill_file_read",
  "web_search", "web_fetch",
  "browser_status", "browser_session_open", "browser_tool_list", "browser_tool_call",
  "browser_session_wait_for_user", "browser_session_close",
  "render_ui", "update_ui", "get_ui_state",
  "group_member_role_read", "group_messages_read",
  "proactive_respond",
  "kanban_update_progress", "kanban_add_comment", "kanban_request_complete",
]));

const ENTRY_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: PRODUCT_TOOL_SEARCH,
    description: "Find Shoggoth product tools that are not loaded directly. Search by keyword or domain, for example kanban, cron, inspiration, plugin, mcp, hook, heartbeat, federation, group, computer or notification; an empty query lists every tool name by domain. Each match returns its exact name, full description (including its workflow and rules) and input schema. Call a match with product_tool_call.",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false, required: ["query"], properties: Object.freeze({
      query: Object.freeze({ type: "string", maxLength: 200 }),
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS }),
    }) }),
    annotations: Object.freeze({ title: "Shoggoth product tool search", readOnlyHint: true, destructiveHint: false,
      idempotentHint: true, openWorldHint: false }),
  }),
  Object.freeze({
    name: PRODUCT_TOOL_CALL,
    description: "Call a Shoggoth product tool found with product_tool_search, using its exact name and an arguments object that matches its input schema. Confirmations, permissions, results and errors are exactly those of the named tool.",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false, required: ["name", "arguments"], properties: Object.freeze({
      name: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
      arguments: Object.freeze({ type: "object" }),
    }) }),
    annotations: Object.freeze({ title: "Shoggoth product tool call", readOnlyHint: false, destructiveHint: false,
      idempotentHint: false, openWorldHint: true }),
  }),
]);
const ENTRY_TOOL_NAMES = Object.freeze(new Set(ENTRY_TOOL_DEFINITIONS.map(tool => tool.name)));

function toolExposureFor(runtime) { return RESIDENT_TOOL_RUNTIMES.has(runtime) ? "resident" : "all"; }

function residentToolDefinitions(definitions) {
  return [...definitions.filter(definition => RESIDENT_PRODUCT_TOOLS.has(definition.name)), ...ENTRY_TOOL_DEFINITIONS];
}

function validSearchArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => key === "query" || key === "limit") && typeof value.query === "string"
    && value.query.length <= 200 && (value.limit === undefined
      || (Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= MAX_SEARCH_RESULTS));
}

function validCallArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return keys === "arguments,name" && typeof value.name === "string" && value.name.length > 0
    && value.name.length <= 128 && !ENTRY_TOOL_NAMES.has(value.name)
    && value.arguments !== null && typeof value.arguments === "object" && !Array.isArray(value.arguments);
}

const DOMAIN_BY_TOOL = new Map(PRODUCT_CAPABILITIES.map(capability => [capability.tool, capability.domain]));

// Lexical search over tools that are not resident. Names weigh most, then the
// domain, then the description; ties keep the registry order.
function searchProductTools(definitions, { query, limit = 5 }) {
  const candidates = definitions.filter(definition => !RESIDENT_PRODUCT_TOOLS.has(definition.name));
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/u).filter(term => term.length >= 2))];
  if (terms.length === 0) {
    const index = {};
    for (const definition of candidates) {
      const domain = DOMAIN_BY_TOOL.get(definition.name) || "other";
      (index[domain] ??= []).push(definition.name);
    }
    return { tools: [], index };
  }
  const scored = candidates.map((definition, order) => {
    const name = definition.name.toLowerCase(), domain = (DOMAIN_BY_TOOL.get(definition.name) || "").toLowerCase();
    const description = String(definition.description || "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.split("_").includes(term)) score += 6; else if (name.includes(term)) score += 4;
      if (domain === term) score += 3;
      if (description.includes(term)) score += 1;
    }
    return { definition, score, order };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  return { tools: scored.slice(0, limit).map(({ definition }) => ({ name: definition.name,
    description: definition.description, inputSchema: definition.inputSchema })), total: scored.length };
}

const RESIDENT_TOOL_INSTRUCTION = "Only core Shoggoth product tools are loaded directly. Find any other Shoggoth tool with product_tool_search (by keyword or domain) and call it with product_tool_call using its exact name.";

module.exports = { RESIDENT_TOOL_RUNTIMES, RESIDENT_PRODUCT_TOOLS, PRODUCT_TOOL_SEARCH, PRODUCT_TOOL_CALL,
  ENTRY_TOOL_DEFINITIONS, ENTRY_TOOL_NAMES, RESIDENT_TOOL_INSTRUCTION, toolExposureFor, residentToolDefinitions,
  validSearchArguments, validCallArguments, searchProductTools };
