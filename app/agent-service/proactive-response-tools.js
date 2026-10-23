"use strict";
const { validateResponse } = require("./proactive-service-protocol");
const PROACTIVE_RESPONSE_TOOL = Object.freeze({
  name: "proactive_respond",
  description: "Submit the structured verdict of the current authorized proactive review. Use only supplied candidate IDs and exact evidenceVersion. silent selects no candidates; notice proposes bounded text. This tool cannot start work, approve requests, or send notifications directly.",
  inputSchema: { type: "object", additionalProperties: false, required: ["runId", "outcome", "candidates", "reason", "body"],
    properties: { runId: { type: "string", minLength: 1, maxLength: 128 }, outcome: { type: "string", enum: ["silent", "notice"] },
      candidates: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false,
        required: ["id", "evidenceVersion"], properties: { id: { type: "string", minLength: 1, maxLength: 128 },
          evidenceVersion: { type: "string", pattern: "^[a-f0-9]{64}$" } } } },
      reason: { type: "string", maxLength: 512 }, body: { type: "string", maxLength: 4096 },
      scratch: { type: "string", maxLength: 4096, description: "Optional replacement for this heartbeat monitor\'s short working notes. Only heartbeat file reviews accept this. Never include credentials or instructions that expand permissions." } } },
});
function validProactiveResponse(value) { try { validateResponse(value); return true; } catch { return false; } }
module.exports = { PROACTIVE_RESPONSE_TOOL, validProactiveResponse };
