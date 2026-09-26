#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { HermesBackend } = require("../app/core/hermes-backend");

const rows = Array.from({ length: 242 }, (_, index) => ({
  id: `session-${String(index).padStart(3, "0")}`,
  title: `Session ${index}`,
  started_at: 1_800_000_000 - index,
  last_active: 1_800_000_100 - index,
  source: index % 3 === 0 ? "cron" : "cli",
}));
let servedRows = rows;

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

(async () => {
  const calls = [];
  const fixture = await listen((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const limit = Number(url.searchParams.get("limit") || 20);
    const offset = Number(url.searchParams.get("offset") || 0);
    calls.push({ limit, offset });
    res.setHeader("content-type", "application/json");
    if (limit > 100) {
      res.statusCode = 422;
      res.end(JSON.stringify({ detail: [{ loc: ["query", "limit"], msg: "Input should be less than or equal to 100" }] }));
      return;
    }
    res.end(JSON.stringify({
      sessions: servedRows.slice(offset, offset + limit),
      total: servedRows.length,
      limit,
      offset,
    }));
  });

  try {
    const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local" }) });
    const firstTwoPages = await backend._fetchSessionsForDashboard(
      { baseUrl: fixture.baseUrl, token: "fixture" },
      "hermes-default",
      200,
    );
    assert.equal(firstTwoPages.length, 200, "Hermes 0.20.4 的 100 条上限不能让 session 列表降级为空");
    assert.deepEqual(calls, [{ limit: 100, offset: 0 }, { limit: 100, offset: 100 }]);
    assert.equal(new Set(firstTwoPages.map((row) => row.key)).size, 200, "分页不得产生重复 session");
    assert.deepEqual(firstTwoPages.map((row) => row.source), rows.slice(0, 200).map((row) => row.source),
      "会话分类需要保留 Hermes 的原始来源");
    assert.deepEqual(
      [...new Set(firstTwoPages.map((row) => `${row.backendId}:${row.agentId}`))],
      ["hermes:hermes-default"],
      "Hermes 历史会话必须声明 backend/agent 归属，否则 Chat 会回退成 OpenClaw",
    );

    calls.length = 0;
    const all = await backend._fetchSessionsForDashboard(
      { baseUrl: fixture.baseUrl, token: "fixture" },
      "hermes-default",
      250,
    );
    assert.equal(all.length, 242, "最后一页不足 100 条时应自然结束");
    assert.deepEqual(calls, [
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 50, offset: 200 },
    ]);

    calls.length = 0;
    const small = await backend._fetchSessionsForDashboard(
      { baseUrl: fixture.baseUrl, token: "fixture" },
      "hermes-default",
      25,
    );
    assert.equal(small.length, 25);
    assert.deepEqual(calls, [{ limit: 25, offset: 0 }]);

    servedRows = [];
    backend.profileById.set("hermes-default", "default");
    backend.agents = [{ id: "hermes-default", name: "default" }];
    backend.dashboards.set("default", { baseUrl: fixture.baseUrl, token: "fixture" });
    const emptyProfileRows = await backend.refreshSessions();
    assert.deepEqual(
      emptyProfileRows.map((row) => ({
        key: row.key,
        backendId: row.backendId,
        agentId: row.agentId,
      })),
      [{ key: "agent:hermes-default:main", backendId: "hermes", agentId: "hermes-default" }],
      "Hermes 零会话 profile 的 main 占位行也必须保留归属",
    );
    console.log("hermes session pagination regression: PASS");
  } finally {
    await fixture.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
