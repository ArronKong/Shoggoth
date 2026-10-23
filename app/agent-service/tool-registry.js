"use strict";

const crypto = require("node:crypto");
const { VIEW_HEADERS } = require("./agent-definition-defaults");

const MAX_TOOLS_MARKDOWN_BYTES = 32 * 1024;
function descriptionExcerpt(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function clone(value) { return structuredClone(value); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function modelVisible(tool) { return tool.modelVisible !== false; }

function buildState({ capabilities, definitions, domainNotes = [], lifecycle = {} }) {
  if (!Array.isArray(capabilities) || !Array.isArray(definitions)
    || capabilities.length === 0 || capabilities.length !== definitions.length) {
    throw new TypeError("Tool Registry 能力与 schema 数量不一致");
  }
  const capabilityByName = new Map();
  for (const capability of capabilities) {
    if (!capability || typeof capability.tool !== "string" || capability.tool.length === 0
      || !["read", "write", "confirm", "destructive"].includes(capability.risk)
      || capabilityByName.has(capability.tool)) throw new TypeError("Tool Registry capability 无效");
    capabilityByName.set(capability.tool, clone(capability));
  }
  const tools = definitions.map((definition) => {
    const capability = capabilityByName.get(definition?.name);
    if (!capability || !definition.inputSchema || typeof definition.description !== "string") {
      throw new TypeError("Tool Registry definition 无效");
    }
    return { ...clone(capability), definition: clone(definition), enabled: true };
  });
  if (new Set(tools.map((tool) => tool.tool)).size !== tools.length) {
    throw new TypeError("Tool Registry definition 重复");
  }
  const material = { schemaVersion: 1, tools, domainNotes: clone(domainNotes), lifecycle: clone(lifecycle) };
  const revision = crypto.createHash("sha256").update(canonicalJson(material)).digest("hex");
  return deepFreeze({ ...material, revision });
}

class ToolRegistry {
  constructor(input) { this.state = buildState(input); }
  get revision() { return this.state.revision; }
  get(name) {
    const tool = this.state.tools.find((candidate) => candidate.tool === name);
    return tool ? clone(tool) : null;
  }
  list() { return this.state.tools.map(clone); }
  replace(input) {
    const next = buildState(input);
    this.state = next;
    return this.revision;
  }
  mcpDefinitions() {
    return this.state.tools.filter((tool) => tool.enabled && modelVisible(tool)).map((tool) => ({
      ...clone(tool.definition),
      _meta: {
        ...(tool.definition._meta || {}),
        "shoggoth/toolRegistryRevision": this.revision,
      },
    }));
  }
  publicProjection() {
    return {
      revision: this.revision,
      capabilities: this.state.tools.filter((tool) => tool.enabled && modelVisible(tool) && tool.uiVisible !== false).map((tool) => ({
        domain: tool.domain, feature: tool.feature, tool: tool.tool, risk: tool.risk,
      })),
      uiOnly: clone(this.state.domainNotes),
      lifecycle: clone(this.state.lifecycle),
    };
  }
  // Every Runtime already receives the full tool list (or a tool search over
  // it), so the policy names only the domains to search, not every tool.
  developerSummary() {
    const domains = new Set();
    for (const tool of this.state.tools) {
      if (tool.enabled && modelVisible(tool)) domains.add(tool.domain);
    }
    return [
      `Shoggoth Tool Registry revision: ${this.revision}`,
      `Shoggoth product tool domains: ${[...domains].join(", ")}. Exact tool names, descriptions and input schemas come from the runtime's tool list or tool search; this summary never grants permissions.`,
    ].join("\n");
  }
  toolsMarkdown() {
    const visible = this.state.tools.filter(tool => tool.enabled && modelVisible(tool));
    const render = budget => [
      VIEW_HEADERS.TOOLS.trimEnd(), "", `Registry revision: \`${this.revision}\``, "",
      ...(Number.isFinite(budget) ? ["This is a bounded capability index. Descriptions may be excerpts; MCP tools/list supplies the full descriptions and input schemas for this same revision. This index never grants permissions.", ""] : []),
      "| Tool | Domain | Risk | Description |", "|---|---|---|---|",
      ...visible.map(tool => `| \`${tool.tool}\` | ${tool.domain} | ${tool.risk} | ${descriptionExcerpt(tool.description, budget).replace(/\|/gu, "\\|")} |`), "",
    ].join("\n");
    for (const budget of [Infinity, 512, 384, 256, 128, 64, 0]) {
      const document = render(budget);
      if (Buffer.byteLength(document, "utf8") <= MAX_TOOLS_MARKDOWN_BYTES) return document;
    }
    throw new RangeError("Tool Registry capability index exceeds its document limit");
  }}

module.exports = { ToolRegistry, canonicalJson, MAX_TOOLS_MARKDOWN_BYTES };
