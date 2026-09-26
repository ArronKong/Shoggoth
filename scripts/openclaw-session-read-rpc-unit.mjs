import assert from "node:assert/strict";
import backendModule from "../app/core/openclaw-backend.js";

const { OpenClawBackend } = backendModule;

function createBackend(respond) {
  const backend = new OpenClawBackend();
  const calls = [];
  backend._connect = async () => {};
  backend.request = async (method, params) => {
    calls.push({ method, params });
    return respond(method, params);
  };
  return { backend, calls };
}

{
  const { backend, calls } = createBackend((method) => {
    if (method === "sessions.list") {
      return {
        sessions: [
          { key: "agent:main:one" },
          { key: "agent:main:two" },
        ],
      };
    }
    if (method === "sessions.search") {
      return {
        indexing: true,
        truncated: true,
        results: [{
          sessionKey: "agent:main:two",
          sessionId: "session-2",
          messageId: "message-9",
          role: "assistant",
          timestamp: 1234,
          snippet: "needle in a reply",
          score: 0.91,
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });

  const result = await backend.searchChat("main", " needle ", { limit: 25 });
  assert.deepEqual(calls.map((call) => call.method), ["sessions.list", "sessions.search"]);
  assert.deepEqual(calls[0].params, {
    agentId: "main",
    configuredAgentsOnly: true,
    limit: 500,
  });
  assert.deepEqual(calls[1].params, {
    agentId: "main",
    sessionKeys: ["agent:main:one", "agent:main:two"],
    query: "needle",
    limit: 25,
  });
  assert.deepEqual(result, {
    supported: true,
    indexing: true,
    truncated: true,
    results: [{
      key: "agent:main:two",
      sessionId: "session-2",
      messageId: "message-9",
      role: "assistant",
      ts: 1234,
      snippet: "needle in a reply",
      score: 0.91,
    }],
  });
}

{
  const { backend, calls } = createBackend((method) => {
    if (method === "sessions.list") return { sessions: [] };
    throw new Error(`unexpected method ${method}`);
  });
  const result = await backend.searchChat("main", "nothing");
  assert.deepEqual(calls.map((call) => call.method), ["sessions.list"]);
  assert.deepEqual(result, { supported: true, results: [] });
}

{
  const keys = Array.from({ length: 201 }, (_, index) => ({ key: `agent:main:${index}` }));
  const { backend, calls } = createBackend((method, params) => {
    if (method === "sessions.list") return { sessions: [...keys, keys[0]] };
    if (method === "sessions.search") {
      const index = Number(String(params.sessionKeys[0]).split(":").pop());
      return {
        results: [{
          sessionKey: params.sessionKeys[0],
          role: "user",
          timestamp: index,
          snippet: `hit ${index}`,
          score: index === 200 ? 1 : 0.5,
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const result = await backend.searchChat("main", ` ${"x".repeat(5000)} `, { limit: 999 });
  const searches = calls.filter((call) => call.method === "sessions.search");
  assert.equal(searches.length, 2);
  assert.deepEqual(searches.map((call) => call.params.sessionKeys.length), [200, 1]);
  assert.ok(searches.every((call) => call.params.limit === 25));
  assert.ok(searches.every((call) => call.params.query.length === 4096));
  assert.equal(result.results[0].key, "agent:main:200");
}

{
  const { backend, calls } = createBackend((method) => {
    assert.equal(method, "sessions.preview");
    return {
      ts: 999,
      previews: [{
        key: "agent:main:one",
        status: "ok",
        items: [
          { role: "user", text: "first question" },
          { role: "assistant", text: "short answer" },
        ],
      }],
    };
  });
  const result = await backend.getSessionPreview("main", "agent:main:one", { limit: 30 });
  assert.deepEqual(calls[0], {
    method: "sessions.preview",
    params: { keys: ["agent:main:one"], limit: 30, maxChars: 2000 },
  });
  assert.deepEqual(result, {
    supported: true,
    title: "first question",
    totalMessages: 2,
    offset: 0,
    truncated: false,
    messages: [
      { role: "user", text: "first question" },
      { role: "assistant", text: "short answer" },
    ],
  });
}

{
  const { backend } = createBackend(() => ({
    previews: [{ key: "agent:main:missing", status: "missing", items: [] }],
  }));
  const result = await backend.getSessionPreview("main", "agent:main:missing");
  assert.deepEqual(result, {
    supported: true,
    reason: "not-found",
    messages: [],
    totalMessages: 0,
    offset: 0,
    truncated: false,
  });
}

console.log("openclaw session read RPC: PASS");
