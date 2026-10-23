"use strict";

const { CAPABILITIES, SHAREPOINT_ITEMS_TOOL, SHAREPOINT_ITEM_FIELDS_TOOL,
  capabilityFor, listRequest } =
  require("./plugin-microsoft-graph-capabilities");
const { serviceError } = require("./security");

const TOOLS = Object.freeze(Object.fromEntries(Object.entries(CAPABILITIES).map(([packageId, capability]) => [
  packageId, Object.freeze({ name: capability.toolName, description: capability.description,
    inputSchema: Object.freeze({ type: "object",
      properties: packageId === "sharepoint"
        ? Object.freeze({ siteId: Object.freeze({ type: "string",
          description: "Graph site ID of the SharePoint site to inspect" }) })
        : Object.freeze({}),
      required: Object.freeze(packageId === "sharepoint" ? ["siteId"] : []),
      additionalProperties: false }) }),
])));
const SHAREPOINT_ITEM_TOOL = Object.freeze({ name: SHAREPOINT_ITEMS_TOOL,
  description: "Return up to 20 item metadata rows from one SharePoint list's first page; no columns or file content.",
  inputSchema: Object.freeze({ type: "object",
    properties: Object.freeze({
      siteId: Object.freeze({ type: "string", description: "Graph site ID" }),
      listId: Object.freeze({ type: "string", description: "Graph list ID" }),
    }),
    required: Object.freeze(["siteId", "listId"]), additionalProperties: false }),
});
const SHAREPOINT_ITEM_FIELDS = Object.freeze({ name: SHAREPOINT_ITEM_FIELDS_TOOL,
  description: "Read up to 8 named scalar column values from one SharePoint list item; no file content.",
  inputSchema: Object.freeze({ type: "object",
    properties: Object.freeze({
      siteId: Object.freeze({ type: "string", description: "Graph site ID" }),
      listId: Object.freeze({ type: "string", description: "Graph list ID" }),
      itemId: Object.freeze({ type: "string", description: "Graph list item ID" }),
      fieldNames: Object.freeze({ type: "array", description: "Exact SharePoint column internal names",
        items: Object.freeze({ type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }),
        minItems: 1, maxItems: 8, uniqueItems: true }),
    }),
    required: Object.freeze(["siteId", "listId", "itemId", "fieldNames"]),
    additionalProperties: false }),
});
const TOOLS_BY_PACKAGE = Object.freeze(Object.fromEntries(Object.keys(CAPABILITIES).map(packageId => [
  packageId, Object.freeze(packageId === "sharepoint"
    ? [TOOLS[packageId], SHAREPOINT_ITEM_TOOL, SHAREPOINT_ITEM_FIELDS] : [TOOLS[packageId]]),
])));

function fail() {
  throw serviceError("CAPABILITY_FORBIDDEN", "Microsoft Graph 工具缺少当前连接与调用授权");
}

// A Service-owned MCP facade. It has neither ambient credentials nor direct
// network transport. The CapabilityDispatcher consumes the one-use ticket in
// authorizeEgress before the Graph account broker can make a request.
class MicrosoftGraphFamilyMcpClient {
  #broker;
  #packageId;
  #connectionId;
  #principalIdentity;
  #authorizeEgress;
  #assertCurrent;
  #closed = false;
  #calls = new Set();

  constructor({ broker, packageId, connectionId, principalIdentity,
    authorizeEgress, assertCurrent } = {}) {
    capabilityFor(packageId);
    if (typeof broker?.readCollectionForPrincipal !== "function"
      || typeof connectionId !== "string" || !connectionId
      || typeof principalIdentity !== "string"
      || !/^microsoft-graph:[a-f0-9]{64}$/u.test(principalIdentity)
      || typeof authorizeEgress !== "function" || typeof assertCurrent !== "function") fail();
    this.#broker = broker;
    this.#packageId = packageId;
    this.#connectionId = connectionId;
    this.#principalIdentity = principalIdentity;
    this.#authorizeEgress = authorizeEgress;
    this.#assertCurrent = assertCurrent;
  }

  #assert(options = {}) {
    if (this.#closed || options.signal?.aborted) fail();
    const first = this.#assertCurrent();
    const second = options.assertCurrent?.();
    if (first && typeof first.then === "function"
      || second && typeof second.then === "function") fail();
  }

  getProtocol() { this.#assert(); return { era: "internal", version: "shoggoth-graph-family-v1" }; }

  async listTools() {
    this.#assert();
    return TOOLS_BY_PACKAGE[this.#packageId];
  }

  async callTool(name, args, authority, options = {}) {
    if (!TOOLS_BY_PACKAGE[this.#packageId].some(tool => tool.name === name)
      || typeof authority?.ticketId !== "string") fail();
    listRequest(this.#packageId, args, name);
    this.#assert(options);
    const controller = new AbortController();
    this.#calls.add(controller);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    try {
      const decision = this.#authorizeEgress({ connectionId: this.#connectionId,
        principalIdentity: this.#principalIdentity, toolName: name,
        arguments: args, authority });
      if (decision && typeof decision.then === "function") fail();
      this.#assert(options);
      const result = await this.#broker.readCollectionForPrincipal({
        principalIdentity: this.#principalIdentity, packageId: this.#packageId,
        input: args, toolName: name, assertCurrent: () => this.#assert(options), signal,
      });
      this.#assert(options);
      return { content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result, isError: false };
    } finally { this.#calls.delete(controller); }
  }

  async release() {
    if (this.#closed) return;
    this.#closed = true;
    for (const call of this.#calls) call.abort();
  }
}

module.exports = { MicrosoftGraphFamilyMcpClient, TOOLS, TOOLS_BY_PACKAGE };
