#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { BackendRegistry } = require("../app/core/backend-registry");
const { HermesBackend } = require("../app/core/hermes-backend");

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

  await groupSessionScope();
  await hermesSessionScope();
  console.log("chat global search unit: PASS");
}

async function groupSessionScope() {
  const registry = new BackendRegistry();
  const hidden = ["agent:ada:current", "agent:ada:retired", "agent:ada:archived"];
  const internalSessions = hidden.map((key) => ({ backendId: "openclaw", key }));
  let searches = 0;
  let unavailable = false;
  registry.setInspirationOwner({ listGroupChats: async (opts) => {
    assert.equal(opts.includeArchived, true);
    if (unavailable) throw new Error("owner offline");
    // 完整作用域独立于可显示的群列表。
    return { groups: [], internalSessions };
  } });
  registry.register(backend("openclaw", [{ id: "ada", name: "Ada" }], async (_agentId, _query, opts) => {
    searches += 1;
    assert.deepEqual(opts.excludeSessionKeys, hidden);
    // 后端即使忽略排除参数，Registry 也在全局排序分页之前挡住内部回合。
    return { supported: true, results: [
      ...hidden.map((key) => ({ key, snippet: "internal input", ts: 100 })),
      { key: "agent:ada:direct", snippet: "ordinary chat", ts: 20 },
      { key: "agent:ada:older", snippet: "older chat", ts: 10 },
    ] };
  }));
  registry.register(backend("hermes", [{ id: "ada", name: "Ada" }], async (_agentId, _query, opts) => {
    searches += 1;
    assert.equal(opts.excludeSessionKeys, undefined, "keys from another backend never hide this backend's chat");
    return { supported: true, results: [{ key: hidden[0], snippet: "same key, different backend", ts: 30 }] };
  }));
  const first = await registry.searchAllChat("input", { limit: 2 });
  assert.deepEqual(first.results.map(({ backendId, key }) => [backendId, key]), [
    ["hermes", hidden[0]], ["openclaw", "agent:ada:direct"],
  ]);
  assert.equal(first.nextOffset, 2);
  const last = await registry.searchAllChat("input", { limit: 2, offset: first.nextOffset });
  assert.deepEqual(last.results.map((hit) => hit.key), ["agent:ada:older"]);
  assert.equal(last.hasMore, false);
  assert.equal((await registry.searchChat("openclaw", "ada", "input", { limit: 10 })).results.length, 2,
    "single-agent search uses the same scope");
  const before = searches;
  unavailable = true;
  const failed = await registry.searchAllChat("input");
  assert.deepEqual([failed.results, failed.failedAgents, searches], [[], 2, before],
    "an unavailable owner does not turn internal transcripts into public search hits");
  assert.equal((await registry.searchChat("openclaw", "ada", "input")).supported, false);
  assert.equal(searches, before);
}

async function hermesSessionScope() {
  const profile = {};
  let rows = [
    { session_id: "internal", snippet: "hidden" },
    { session_id: "direct", snippet: ">>>needle<<<", session_started: 10 },
  ];
  const source = {
    profileById: new Map([["ada", profile]]), dashboards: new Map([[profile, { baseUrl: "http://fixture.invalid" }]]),
    _httpGet: async (url) => {
      assert.equal(new URL(url).searchParams.get("limit"), "100", "excluded hits cannot consume the requested visible limit");
      return { status: 200, body: JSON.stringify({ results: rows }) };
    },
  };
  const search = () => HermesBackend.prototype.searchChat.call(source, "ada", "needle",
    { limit: 1, excludeSessionKeys: ["agent:ada:internal"] });
  const result = await search();
  assert.deepEqual(result.results.map((hit) => [hit.key, hit.snippet, hit.ts]), [["agent:ada:direct", "needle", 10000]]);
  rows = Array.from({ length: 100 }, () => ({ session_id: "internal", snippet: "hidden" }));
  const truncated = await search();
  assert.deepEqual([truncated.results, truncated.truncated], [[], true], "bounded source exhaustion remains explicit");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
