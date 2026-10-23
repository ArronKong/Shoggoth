"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { createMcpStdioHandler, runMcpStdioSession } = require("../app/shoggoth-mcp-helper");
const { normalizeInteractiveRequestV1 } = require("../app/core/shoggoth-interaction-contract");

const args = { groupId: "group", ownerScope: "owner", expectedRosterRevision: 1, expectedPolicyVersion: 1,
  clientRequestId: "request", targetMemberIds: ["member"], instruction: "大家好啊，出来打个招呼", source: "chat", sourceId: "direct" };
async function fixture(t, members = [{ id: "member", displayName: "成员", state: "active" }]) {
  const input = new PassThrough(), frames = []; let writes = 0;
  const output = new Writable({ write(chunk, _encoding, done) { frames.push(JSON.parse(chunk.toString())); done(); } });
  const handler = createMcpStdioHandler({ runtimeProfileId: "fixture", runtimeAccountId: "fixture-account", sessionToken: Buffer.alloc(32, 1).toString("base64url"),
    requestService: async (_paths, request) => {
      if (request.params.name === "group_chat_get") return { ok: true, ownerScope: "owner",
        group: { id: "group", name: "测试群", status: "active", rosterRevision: 1, policyVersion: 1 },
        members };
      assert.equal(request.params.name, "group_chat_dispatch"); assert.equal(request.params.confirmation, true);
      writes++; return { ok: true, status: "submitted" };
    } });
  const session = runMcpStdioSession({ input, output, handler, clientRequestTimeoutMs: 20 });
  t.after(async () => { input.end(); await session; handler.close(); output.destroy(); });
  const send = value => input.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const next = async predicate => {
    for (let i = 0; i < 200; i++) { const found = frames.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 5)); }
    throw Error("missing wire response");
  };
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "fixture", version: "1" } } });
  await next(frame => frame.id === 1);
  return { send, next, input, frames, writes: () => writes };
}

test("group confirmation remains answerable after the ordinary input deadline and sends exactly once", async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: "tools/call", params: { name: "group_chat_dispatch", arguments: args } });
  const card = await f.next(frame => frame.method === "elicitation/create");
  await new Promise(r => setTimeout(r, 80));
  assert.equal(f.frames.some(frame => frame.id === 2), false, "product approval must still be waiting");
  f.send({ id: card.id, result: { action: "accept", content: { confirm_product_action: "确认执行" } } });
  assert.equal((await f.next(frame => frame.id === 2)).result.isError, false);
  assert.equal(f.writes(), 1);
});

test("closing the client while a product confirmation is pending never sends", async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: "tools/call", params: { name: "group_chat_dispatch", arguments: args } });
  await f.next(frame => frame.method === "elicitation/create");
  f.input.end();
  assert.equal((await f.next(frame => frame.id === 2)).result.isError, true);
  assert.equal(f.writes(), 0);
});

test("ordinary input keeps its finite deadline", async t => {
  const f = await fixture(t);
  f.send({ id: 2, method: "tools/call", params: { name: "request_user_input", arguments: { questions: [
    { id: "choice", header: "选择", question: "选哪个？", options: [{ label: "甲", description: "第一个" }, { label: "乙", description: "第二个" }] },
  ] } } });
  await f.next(frame => frame.method === "elicitation/create");
  assert.equal((await f.next(frame => frame.id === 2)).result.isError, true);
  assert.equal(f.writes(), 0);
});

test("full 32-member confirmation fits transport and remains complete in the product card", async t => {
  const members = Array.from({ length: 32 }, (_, i) => ({ id: `member-${i}`,
    displayName: "这是不能被省略的完整群成员名字".repeat(3) + i, state: "active" }));
  const f = await fixture(t, members);
  const instruction = "正文也必须完整。".repeat(70);
  f.send({ id: 2, method: "tools/call", params: { name: "group_chat_dispatch",
    arguments: { ...args, targetMemberIds: members.map(member => member.id), instruction } } });
  const card = await f.next(frame => frame.method === "elicitation/create");
  assert.ok(Buffer.byteLength(card.params.message) > 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(card.params)) < 16 * 1024);
  const payload = { ...card.params, requestId: "request", method: "mcpServer/elicitation/request",
    kind: "mcp_elicitation", mode: "form", serverName: "shoggoth" };
  const normalized = normalizeInteractiveRequestV1({ runId: "run", eventType: "prompt", payload, expiresAt: null });
  assert.equal(normalized.message, card.params.message);
  for (const member of members) assert.ok(normalized.message.includes(member.displayName));
  assert.ok(normalized.message.includes(instruction));
  assert.throws(() => normalizeInteractiveRequestV1({ runId: "run", eventType: "prompt",
    payload: { ...payload, message: "x".repeat(16 * 1024 + 1) } }), { code: "INTERACTION_REQUEST_INVALID" });
  f.send({ id: card.id, result: { action: "accept", content: { confirm_product_action: "确认执行" } } });
  assert.equal((await f.next(frame => frame.id === 2)).result.isError, false);
  assert.equal(f.writes(), 1);
});

test("runtime binding proofs keep a finite deadline even though they use an empty consent schema", async t => {
  const input = new PassThrough(), frames = [];
  const output = new Writable({ write(chunk, _encoding, done) { frames.push(JSON.parse(chunk.toString())); done(); } });
  const handler = async (message, { requestClient }) => {
    await assert.rejects(requestClient("elicitation/create", { message: "Bind this runtime call",
      requestedSchema: { type: "object", properties: {}, required: [] }, _meta: { "shoggoth/runtime-call-binding": {} } }),
    { code: "MCP_HELPER_CLIENT_REQUEST_FAILED" });
    return { jsonrpc: "2.0", id: message.id, result: { bounded: true } };
  };
  const session = runMcpStdioSession({ input, output, handler, clientRequestTimeoutMs: 20 });
  t.after(async () => { input.end(); await session; output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n");
  for (let i = 0; i < 100 && !frames.some(frame => frame.id === 1); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(frames.find(frame => frame.id === 1)?.result.bounded, true);
});
