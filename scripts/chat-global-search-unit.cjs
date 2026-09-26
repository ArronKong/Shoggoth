#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { BackendRegistry } = require("../app/core/backend-registry");

function backend(id, agents, searchChat) {
  return {
    id,
    name: id,
    // Passthrough backends (notably OpenClaw) only expose the rich async list.
    listAgents: async () => agents,
    getAgents: () => [],
    searchChat,
  };
}

async function main() {
  const registry = new BackendRegistry();
  let calls = 0;
  registry.register(backend("alpha", [
    { id: "ada", name: "Ada" },
    { id: "ada", name: "duplicate" },
    { id: "", name: "invalid" },
  ], async (agentId, query, opts) => {
    calls += 1;
    assert.equal(agentId, "ada");
    assert.equal(query, "needle");
    assert.deepEqual(opts, { limit: 100 });
    return {
      supported: true,
      truncated: true,
      results: [
        { key: "agent:ada:older", sessionId: "session-old", messageId: "message-old", snippet: "older hit", ts: 10, role: "assistant" },
        { key: "agent:ada:newer", sessionId: "session-new", messageId: "message-new", snippet: "newer hit", ts: 30 },
        { key: "agent:ada:middle", sessionId: "session-mid", messageId: "message-mid", snippet: "middle hit", ts: 20 },
        { key: "", snippet: "invalid hit", ts: 99 },
      ],
    };
  }));
  registry.register(backend("beta", [{ id: "bob", name: "Bob" }], async () => {
    calls += 1;
    return { supported: false, reason: "unsupported", results: [] };
  }));
  registry.register(backend("gamma", [{ id: "cy", name: "Cy" }], async () => {
    calls += 1;
    throw new Error("offline");
  }));

  const result = await registry.searchAllChat("  needle  ", { limit: 2 });
  assert.equal(calls, 3, "每个有效 agent 只搜索一次");
  assert.equal(result.query, "needle");
  assert.equal(result.searchedAgents, 1);
  assert.equal(result.unsupportedAgents, 1);
  assert.equal(result.failedAgents, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.offset, 0);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 2);
  assert.deepEqual(result.results, [
    {
      backendId: "alpha",
      agentId: "ada",
      agentName: "Ada",
      key: "agent:ada:newer",
      sessionId: "session-new",
      messageId: "message-new",
      snippet: "newer hit",
      ts: 30,
    },
    {
      backendId: "alpha",
      agentId: "ada",
      agentName: "Ada",
      key: "agent:ada:middle",
      sessionId: "session-mid",
      messageId: "message-mid",
      snippet: "middle hit",
      ts: 20,
    },
  ]);

  const next = await registry.searchAllChat("needle", { limit: 2, offset: result.nextOffset });
  assert.equal(calls, 6, "每一页仍只对每个有效 agent 搜索一次");
  assert.equal(next.offset, 2);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextOffset, undefined);
  assert.deepEqual(next.results, [{
    backendId: "alpha",
    agentId: "ada",
    agentName: "Ada",
    key: "agent:ada:older",
    sessionId: "session-old",
    messageId: "message-old",
    snippet: "older hit",
    ts: 10,
    role: "assistant",
  }]);

  const empty = await registry.searchAllChat("   ");
  assert.equal(calls, 6, "空查询不触达 backend");
  assert.deepEqual(empty.results, []);
  assert.equal(empty.searchedAgents, 0);
  assert.equal(empty.hasMore, false);

  console.log("chat global search unit: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
