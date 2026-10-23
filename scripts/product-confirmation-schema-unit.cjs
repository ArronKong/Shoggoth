"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMcpStdioHandler, MCP_STDIO_PROTOCOL_VERSION } = require("../app/shoggoth-mcp-helper");
const { CodexSchemaContract } = require("../app/agent-service/codex-schema-contract");
const { productConfirmationIdentity } = require("../app/agent-service/cron-approval-policy");

const schema = new CodexSchemaContract();
const metadataKey = "shoggoth/product-confirmation";

for (const name of ["browser_session_open", "computer_session_open"]) {
  for (const decision of ["accept", "cancel", "decline"]) {
    test(`${name}: typed Codex form forwards identity and ${decision} preserves the execution boundary`, async () => {
      const calls = [];
      const args = { source: "chat", sourceId: "fixture-session",
        ...(name.startsWith("computer") ? { allowedApplications: ["com.apple.calculator"] } : {}) };
      const handler = createMcpStdioHandler({ runtimeProfileId: "fixture-runtime", runtimeAccountId: "fixture-account",
        sessionToken: Buffer.alloc(32, 1).toString("base64url"), paths: {},
        requestService: async (_paths, request) => {
          calls.push(request.params);
          if (request.params.name.endsWith("_status")) return { available: true, reason: null,
            permissions: { accessibility: true, screenRecording: true }, sessions: [] };
          return { id: "fixture-browser", opened: true };
        } });
      let captured;
      try {
        await handler({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: MCP_STDIO_PROTOCOL_VERSION, capabilities: { elicitation: {} },
          clientInfo: { name: "confirmation-fixture", version: "1" },
        } });
        const result = await handler({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, {
          requestClient: async (method, params) => {
            assert.equal(method, "elicitation/create");
            captured = structuredClone(params);
            // Mirror the actual app-server parse failure, without connecting to any Service.
            try {
              schema.validateServerRequest({ id: 3, method: "mcpServer/elicitation/request", params: {
                ...params, mode: "form", serverName: "shoggoth", threadId: "fixture-thread", turnId: "fixture-turn",
              } });
            } catch { return { action: "cancel" }; }
            return decision === "accept" ? { action: "accept", content: { confirm_product_action: "确认执行" } }
              : { action: decision };
          },
        });
        assert.ok(captured);
        schema.validateServerRequest({ id: 3, method: "mcpServer/elicitation/request", params: {
          ...captured, mode: "form", serverName: "shoggoth", threadId: "fixture-thread", turnId: "fixture-turn",
        } });
        assert.equal(captured.requestedSchema.description, undefined);
        assert.deepEqual(captured._meta, { [metadataKey]: productConfirmationIdentity(name, args) });
        assert.equal(result.result.isError, false);
        if (decision === "accept") {
          assert.equal(result.result.structuredContent.opened, true);
          assert.equal(calls.length, 2);
          assert.equal(calls[1].name, name);
          assert.equal(calls[1].confirmation, true);
        } else {
          assert.equal(result.result.structuredContent.canceled, true);
          assert.equal(calls.length, 1, "unconfirmed actions must never reach the controller");
          assert.equal(result.result.content[0].text, "操作未获确认，未执行。");
        }
      } finally { handler.close(); }
    });
  }
}
