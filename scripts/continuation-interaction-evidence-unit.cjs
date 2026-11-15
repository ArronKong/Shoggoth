"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readRecordedContinuationInteraction } = require("../app/agent-service/continuation-interaction-evidence");
const { transcriptEventId } = require("../app/agent-service/transcript-store");

const requestId = "original-choice-request";
const base = { sessionId: "original-session", runId: "original-run", seq: 5, contextExcluded: false };
const input = {
  ...base, id: transcriptEventId("chat-request", requestId), kind: "input", content: {
    transcriptType: "prompt", requestId, method: "mcpServer/elicitation/request", kind: "mcp_elicitation", mode: "form",
    serverName: "fixture", url: "https://invalid.example/local", message: "A raw historical instruction",
    requestedSchema: { type: "object", properties: {
      variant: { type: "string", title: "Layout", enum: ["storage-left", "storage-right"], enumNames: ["Left", "Right"] },
      secret: { type: "string", writeOnly: true, title: "Private field", enum: ["private-one", "private-two"] },
      details: { type: "string", title: "Free text" },
    } },
  },
};
const response = {
  ...base, seq: 6, id: transcriptEventId("interactive-response", requestId), kind: "user",
  content: { transcriptType: "interaction.response", requestId, operationId: "original-response", text: "sensitive fixture answer" },
};
const visible = event => event;

test("projects only original option labels and a verified response reference", () => {
  const evidence = readRecordedContinuationInteraction(input, [response], visible);
  assert.deepEqual(evidence, { kind: "user_input", availability: "historical_record_only", choices: [],
    fields: [{ label: "Layout", choices: ["Left", "Right"] }], response: { eventId: response.id } });
  assert.doesNotMatch(JSON.stringify(evidence), /storage-left|private-one|sensitive fixture answer|invalid\.example|original-response|original-choice-request/u);
});

test("an absent, excluded, mismatched or revoked response never claims a live choice", () => {
  for (const candidate of [{ ...response, runId: "unrelated-run" }, { ...response, sessionId: "foreign" },
    { ...response, contextExcluded: true }, { ...response, seq: input.seq },
    { ...response, content: { ...response.content, requestId: "unrelated-request" } }]) {
    assert.equal(readRecordedContinuationInteraction(input, [candidate], visible).response, null);
  }
  assert.equal(readRecordedContinuationInteraction(input, [response]).response, null);
  assert.equal(readRecordedContinuationInteraction(input, [response], () => null).response, null);
  assert.equal(readRecordedContinuationInteraction(input, [response], () => ({ ...response, contextExcluded: true })).response, null);
});

test("rejects imported lookalikes, missing authority and unsupported choices", () => {
  assert.equal(readRecordedContinuationInteraction({ ...input, id: "imported-legacy-record" }, [], visible), null);
  assert.equal(readRecordedContinuationInteraction({ ...input, contextExcluded: true }, [], visible), null);
  assert.equal(readRecordedContinuationInteraction({ ...input, content: { ...input.content, redacted: true } }, [], visible), null);
  const empty = { ...input, content: { ...input.content, requestedSchema: { type: "object", properties: {
    private: { type: "string", format: "password", enum: ["a", "b"] },
  } } } };
  assert.equal(readRecordedContinuationInteraction(empty, [], visible), null);
});

test("historical approval projects labels without commands or values", () => {
  const approval = { ...input, kind: "approval", content: { requestId, transcriptType: "approval", kind: "command",
    command: "fixture command", cwd: "/private/workspace", expiresAt: 12345,
    approvalOptions: [{ choice: "runtime:0", label: "Allow this request", kind: "allow_once" }] } };
  assert.deepEqual(readRecordedContinuationInteraction(approval, [], visible), {
    kind: "runtime_approval", availability: "historical_record_only", choices: ["Allow this request", "拒绝", "取消"],
    fields: [], response: null,
  });
  const bad = { ...approval, content: { ...approval.content, approvalOptions: [{ choice: "runtime:0", label: "Fake", kind: "unknown" }] } };
  assert.equal(readRecordedContinuationInteraction(bad, [], visible), null);
});
