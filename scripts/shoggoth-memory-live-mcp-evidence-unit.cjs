"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMcpEvidenceObserver } = require("./shoggoth-memory-live-mcp-evidence.cjs");

test("wire evidence retains the real error and request identity across UTF-8 frames", () => {
  const entries = [], observe = createMcpEvidenceObserver(entry => entries.push(entry));
  const input = observe("client"), output = observe("helper"); input.resume(); output.resume();
  input.write(JSON.stringify({ id: 1, method: "tools/call", params: { name: "memory_save", arguments: { content: "PRIVATE_ARGUMENT" } } }) + "\n");
  const error = { id: 1, result: { content: [{ type: "text", text: "会话错误 (MCP_SESSION_INVALID)" }], structuredContent: { error: { code: "MCP_SESSION_INVALID" } }, isError: true } };
  const bytes = Buffer.from(JSON.stringify(error) + "\n");
  for (const byte of bytes) output.write(Buffer.from([byte]));
  const entry = entries.at(-1);
  assert.equal(entry.toolName, "memory_save"); assert.equal(entry.requestId, 1);
  assert.equal(entry.errorCode, "MCP_SESSION_INVALID"); assert.equal(entry.errorTruncated, false);
  assert.deepEqual(JSON.parse(entry.errorBody), { result: error.result });
  assert.match(entry.errorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(entries).includes("PRIVATE_ARGUMENT"), false);
  input.end(); output.end();
});

test("successful results and secret-shaped error data never enter the evidence", () => {
  const entries = [], output = createMcpEvidenceObserver(entry => entries.push(entry))("helper"); output.resume();
  output.write(JSON.stringify({ id: 1, result: { content: [{ type: "text", text: "BORROWED_BODY" }] } }) + "\n");
  output.write(JSON.stringify({ id: 2, error: { code: -32000, message: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } }) + "\n");
  assert.equal(JSON.stringify(entries).includes("BORROWED_BODY"), false);
  assert.equal(JSON.stringify(entries).includes("abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(entries[1].errorCode, -32000); output.end();
});

test("observing a frame copies it before the source writer zeroes its buffer", () => {
  const output = createMcpEvidenceObserver(() => {})("helper");
  const bytes = Buffer.from('{"id":1,"result":{}}\n'), expected = Buffer.from(bytes);
  output.write(bytes); bytes.fill(0);
  assert.deepEqual(output.read(), expected); output.end();
});

test("memory read diagnostics compare returned references without retaining arguments or successful bodies", () => {
  const entries = [], observe = createMcpEvidenceObserver(entry => entries.push(entry));
  const input = observe("client"), output = observe("helper"); input.resume(); output.resume();
  const request = (id, name, args) => input.write(JSON.stringify({ id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const response = (id, value) => output.write(JSON.stringify({ id, result: { structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }] } }) + "\n");
  request(1, "memory_search", { query: "PRIVATE_QUERY" });
  response(1, { results: [{ id: "shared-memory:PRIVATE_REFERENCE", sourceRef: "shared-memory:PRIVATE_REFERENCE",
    path: "shared/PRIVATE_PATH/MEMORY.md", snippet: "PRIVATE_BORROWED_BODY", borrowed: true }] });
  request(2, "memory_get", { source: "chat", sourceId: "PRIVATE_SESSION", id: "shared-memory:PRIVATE_REFERENCE", from: 1, lines: 2 });
  response(2, { text: "PRIVATE_BORROWED_BODY", borrowed: true, citation: "PRIVATE_CITATION" });
  request(3, "memory_get", { path: "/PRIVATE_ABSOLUTE_PATH", PRIVATE_UNKNOWN_FIELD: "PRIVATE_VALUE" });
  const get = entries.find(row => row.direction === "client" && row.requestId === 2);
  assert.deepEqual(get.argumentShape.fields, ["source", "sourceId", "id", "from", "lines"]);
  assert.equal(get.argumentShape.idKind, "borrowed-id"); assert.equal(get.argumentShape.idFromSearch, true);
  const returned = entries.find(row => row.direction === "helper" && row.requestId === 2);
  assert.equal(returned.resultShape.borrowed, true); assert.equal(returned.resultShape.textBytes, 21);
  assert.equal(returned.resultShape.hasCitation, true); assert(returned.elapsedMs >= 0);
  assert.equal(entries.at(-1).argumentShape.pathKind, "absolute-path");
  assert.equal(entries.at(-1).argumentShape.pathFromSearch, false); assert.equal(entries.at(-1).argumentShape.unknownFields, 1);
  request(4, "memory_search", { query: "PRIVATE_QUERY" });
  assert.equal(entries.at(-1).lookupSeenBefore, true); assert.equal(entries.at(-1).querySeenBefore, true);
  request(5, "memory_search", { maxResults: 5, query: "PRIVATE_QUERY" });
  assert.equal(entries.at(-1).lookupSeenBefore, false); assert.equal(entries.at(-1).querySeenBefore, true);
  request(6, "memory_search", { query: "PRIVATE_QUERY", maxResults: 5 });
  assert.equal(entries.at(-1).lookupSeenBefore, true); assert.equal(entries.at(-1).searchTrackingSaturated, false);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_/u);
  input.end(); output.end();
});
