"use strict";

const { serviceError } = require("./security");

// An independent Shoggoth Graph tool contract. It does not implement or
// impersonate the Codex-managed outlook-calendar connector_* declaration.
const VIEW_TOOL = Object.freeze({
  name: "outlook_calendar_view",
  description: "Read a bounded time range from the connected Microsoft calendar.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      startDateTime: Object.freeze({ type: "string", description: "ISO 8601 time with an explicit offset" }),
      endDateTime: Object.freeze({ type: "string", description: "ISO 8601 time with an explicit offset" }),
    }),
    required: Object.freeze(["startDateTime", "endDateTime"]),
    additionalProperties: false,
  }),
});

function fail() {
  throw serviceError("CAPABILITY_FORBIDDEN", "Outlook Calendar 工具缺少当前连接与调用授权");
}

// This client has no ambient credentials and no network transport of its own.
// A Service-owned CapabilityDispatcher consumes its one-use ticket before the
// Graph controller receives a read request. Every await rechecks the current
// Store/Run/lease authority through assertCurrent.
class OutlookCalendarGraphMcpClient {
  #calendar;
  #authorizeEgress;
  #connectionId;
  #principalIdentity;
  #assertCurrent;
  #closed = false;
  #calls = new Set();

  constructor({ calendar, authorizeEgress, connectionId, principalIdentity, assertCurrent } = {}) {
    if (typeof calendar?.calendarViewForPrincipal !== "function"
      || typeof authorizeEgress !== "function"
      || typeof connectionId !== "string" || !connectionId
      || typeof principalIdentity !== "string"
      || !/^microsoft-graph:[a-f0-9]{64}$/u.test(principalIdentity)
      || typeof assertCurrent !== "function") fail();
    this.#calendar = calendar;
    this.#authorizeEgress = authorizeEgress;
    this.#connectionId = connectionId;
    this.#principalIdentity = principalIdentity;
    this.#assertCurrent = assertCurrent;
  }

  #assert(options = {}) {
    if (this.#closed || options.signal?.aborted) fail();
    const first = this.#assertCurrent();
    const second = options.assertCurrent?.();
    if (first && typeof first.then === "function"
      || second && typeof second.then === "function") fail();
  }

  getProtocol() { this.#assert(); return { era: "internal", version: "shoggoth-graph-v1" }; }

  async listTools() {
    this.#assert();
    return [VIEW_TOOL];
  }

  async callTool(name, args, authority, options = {}) {
    if (name !== VIEW_TOOL.name || !args || Object.getPrototypeOf(args) !== Object.prototype
      || Object.keys(args).sort().join(",") !== "endDateTime,startDateTime"
      || typeof args.startDateTime !== "string" || typeof args.endDateTime !== "string"
      || typeof authority?.ticketId !== "string") fail();
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
      const result = await this.#calendar.calendarViewForPrincipal({
        principalIdentity: this.#principalIdentity,
        startDateTime: args.startDateTime, endDateTime: args.endDateTime,
        assertCurrent: () => this.#assert(options), signal,
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

module.exports = { OutlookCalendarGraphMcpClient, VIEW_TOOL };
