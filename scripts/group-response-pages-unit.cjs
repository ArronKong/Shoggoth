"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { GroupResponsePages, unpackGroupResponse } = require("../app/group-response-pages");
const { validateParams } = require("../app/agent-service/group-chat-protocol");

test("large group responses use a fixed, digest-verified snapshot in bounded IPC pages", async () => {
  const pages = new GroupResponsePages();
  const value = { members: Array.from({ length: 32 }, (_, id) => ({ id, role: "职责🙂".repeat(1200) })),
    pendingInteractions: [{ requestId: "approval", command: "\u0001".repeat(12000) }] };
  const params = { groupId: "g" };
  const first = pages.pack("group.get", params, value);
  const read = [];
  value.members.pop();
  const actual = await unpackGroupResponse("group.get", params, first, async request => {
    validateParams("group.response.read", request);
    const page = pages.read(request); read.push(page);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 48 * 1024);
    return page;
  });
  assert.equal(actual.members.length, 32, "changing current state does not change the saved response");
  assert.equal(actual.pendingInteractions[0].command.length, 12000);
  assert.ok(read.length > 4);
});

test("response pages reject wrong group, method, digest, ordering, and expired cursors", async () => {
  let now = 1;
  const pages = new GroupResponsePages({ now: () => now });
  const first = pages.pack("group.get", { groupId: "g" }, { text: "字".repeat(50000) });
  const ref = first.groupResponse;
  const input = { cursor: ref.cursor, method: ref.method, groupId: ref.groupId,
    offset: ref.page.nextOffset, digest: ref.page.digest };
  for (const change of [{ groupId: "another" }, { method: "group.list" }, { digest: "0".repeat(64) }]) {
    assert.throws(() => pages.read({ ...input, ...change }));
  }
  await assert.rejects(unpackGroupResponse("group.get", { groupId: "g" }, first, async request => {
    const value = pages.read(request); value.groupResponse.page.text = "corrupt"; return value;
  }), { code: "GROUP_RESULT_MISMATCH" });
  now = 31_000;
  assert.throws(() => pages.read(input), { code: "GROUP_CHAT_RESPONSE_EXPIRED" });
  assert.equal(pages.rows.size, 0);
});

test("a small response stays inline and a lost page never replays the original write", async () => {
  const pages = new GroupResponsePages();
  const small = { group: { id: "g" } };
  assert.equal(pages.pack("group.get", { groupId: "g" }, small), small);
  const first = pages.pack("group.create", { operationId: "create-once" }, { text: "x".repeat(50000) });
  let reads = 0;
  await assert.rejects(unpackGroupResponse("group.create", { operationId: "create-once" }, first,
    async () => { reads++; throw Object.assign(new Error("offline"), { code: "OFFLINE" }); }), { code: "OFFLINE" });
  assert.equal(reads, 1);
});
