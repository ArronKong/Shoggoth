"use strict";
// Disposable adapters and transport pages; never starts a real Agent/Provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const uiRequire = createRequire(path.resolve(__dirname, "../app/manage-ui/package.json"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-pagination-"));
uiRequire("esbuild").buildSync({
  entryPoints: [path.resolve(__dirname, "../app/manage-ui/src/lib/chatHistoryPager.ts")],
  outfile: path.join(temp, "pager.cjs"), bundle: true, platform: "node", format: "cjs",
});
const { createChatHistoryPager } = require(path.join(temp, "pager.cjs"));
process.on("exit", () => fs.rmSync(temp, { recursive: true, force: true }));
const key = "agent:fixture:thread";
const body = (id, role = "user") => ({ id: String(id), role, content: [{ type: "text", text: `message-${id}` }] });
const rows = (count, prefix = "") => Array.from({ length: count }, (_, index) => body(`${prefix}${index}`));
const code = value => ({ code: value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const windowOf = (messages, size) => {
  const visible = messages.map((message, index) => ({ message, index })).filter(({ message }) => !message.noise);
  let start = visible[Math.max(0, visible.length - size)]?.index ?? 0;
  while (start > 0 && messages[start - 1].noise) start--;
  return { start, count: visible.length, needsEarlier: false };
};
function pagerFixture(initial = rows(260)) {
  const state = { rows: initial, source: "fixture", version: 1, fail: false, requests: [], gate: null };
  const pager = createChatHistoryPager({
    id: row => row.id, window: windowOf,
    request: async (sessionKey, cursor) => {
      state.requests.push({ sessionKey, cursor });
      if (state.gate) await state.gate.promise;
      if (state.fail) throw Error("offline");
      const position = cursor ? JSON.parse(cursor) : null;
      if (position && position.version !== state.version) throw Object.assign(Error("changed"), code("CHAT_HISTORY_CURSOR_INVALID"));
      const end = position ? position.end : state.rows.length, start = Math.max(0, end - 100);
      return { messages: state.rows.slice(start, end), hasMore: start > 0,
        nextCursor: start ? JSON.stringify({ end: start, version: state.version }) : null, sourceId: state.source };
    },
  });
  pager.reset(key);
  const refresh = async () => { const result = await pager.refresh(key); assert.equal(pager.commit(result), true); return result; };
  const earlier = async () => { const result = await pager.earlier(key); assert.equal(pager.commit(result), true); return result; };
  return { state, pager, refresh, earlier };
}

test("product windows: 50 -> 100 -> 150, then final partial page; no hidden quota", async () => {
  const f = pagerFixture(rows(157).flatMap(message => [message, { id: `noise-${message.id}`, noise: true }]));
  for (const expected of [50, 100, 150, 157]) {
    const result = expected === 50 ? await f.refresh() : await f.earlier();
    assert.equal(result.filter(row => !row.noise).length, expected);
    assert.equal(new Set(result.map(row => row.id)).size, result.length);
  }
  assert.equal(f.pager.hasMore, false);
  f.pager.reset(key);
  assert.equal((await f.refresh()).filter(row => !row.noise).length, 50, "reopen resets the display window");
});
test("expanded history survives refresh/new arrivals; replaced transcript returns to 50", async () => {
  const f = pagerFixture(); await f.refresh(); const expanded = await f.earlier();
  f.state.rows.push(...rows(7, "new-")); f.state.version++;
  const refreshed = await f.refresh();
  assert.equal(refreshed.length, 107);
  assert.deepEqual(refreshed.slice(0, 100), expanded);
  f.state.rows = rows(220, "replacement-"); f.state.version++;
  const replacement = await f.refresh();
  assert.equal(replacement.length, 50);
  assert.equal(replacement[0].id, "replacement-170");
});
test("append invalidates a cursor: rebase at loaded oldest message, then add exactly 50", async () => {
  const f = pagerFixture(); await f.refresh(); await f.earlier();
  f.state.rows.push(body("new")); f.state.version++;
  const rebased = await f.earlier();
  assert.equal(rebased.length, 151);
  assert.equal(rebased[0].id, "110");
  assert.equal(rebased.at(-1).id, "new");
  assert.equal(new Set(rebased.map(row => row.id)).size, rebased.length);
});
test("failed older read retains the exact committed window and can retry", async () => {
  const f = pagerFixture(); await f.refresh(); await f.earlier();
  const before = f.pager.current;
  f.state.fail = true;
  await assert.rejects(f.earlier(), /offline/);
  assert.equal(f.pager.current, before);
  assert.equal(f.pager.hasMore, true);
  f.state.fail = false;
  assert.equal((await f.earlier()).length, 150);
});
test("replacement source with reused message IDs cannot retain the previous source prefix", async () => {
  const f = pagerFixture(); await f.refresh(); await f.earlier();
  f.state.source = "replacement-source"; f.state.version++;
  const replacement = await f.pager.earlier(key);
  assert.equal(f.pager.sourceOf(replacement), "replacement-source");
  assert.equal(replacement.length, 50);
  assert.equal(f.pager.commit(replacement), true);
  assert.equal(f.pager.current.sourceId, "replacement-source");
});
test("late reads cannot commit after A -> B -> A, or after a newer operation", async () => {
  const f = pagerFixture(); await f.refresh(); await f.earlier();
  f.state.gate = deferred();
  const old = f.pager.earlier(key);
  f.pager.reset("agent:fixture:other"); f.pager.reset(key);
  f.state.gate.resolve();
  await assert.rejects(old);
  f.state.gate = null;
  const older = await f.pager.refresh(key);
  f.pager.release(older); // the controller discarded this candidate before commit
  const newer = await f.pager.refresh(key);
  assert.equal(f.pager.commit(older), false);
  assert.equal(f.pager.commit(newer), true);
});
test("background refresh and older paging wait for each other's authoritative commit", async () => {
  const f = pagerFixture(); await f.refresh(); await f.earlier();
  const refreshing = await f.pager.refresh(key);
  let olderFinished = false;
  const olderRead = f.pager.earlier(key).then(raw => { olderFinished = true; return raw; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(olderFinished, false, "older read must wait through preparation and authority checks");
  assert.equal(f.pager.commit(refreshing), true);
  const older = await olderRead;
  assert.equal(f.pager.commit(older), true);
  assert.equal(older.length, 150);

  const expanding = await f.pager.earlier(key);
  f.state.rows.push(body("new")); f.state.version++;
  let refreshFinished = false;
  const refreshRead = f.pager.refresh(key).then(raw => { refreshFinished = true; return raw; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshFinished, false, "refresh cannot discard a completed click while it is prepared");
  assert.equal(f.pager.commit(expanding), true);
  const refreshed = await refreshRead;
  assert.equal(f.pager.commit(refreshed), true);
  assert.equal(refreshed.length, 201);
});
test("discarded authority candidates release the reader without becoming visible", async () => {
  const f = pagerFixture(); await f.refresh();
  const before = f.pager.current;
  const discarded = await f.pager.refresh(key);
  const next = f.pager.earlier(key);
  f.pager.release(discarded);
  assert.equal(f.pager.current, before);
  const older = await next;
  assert.equal(older.length, 100);
  assert.equal(f.pager.commit(older), true);
});
test("malformed pagination, non-advancing cursors and oversized pages fail explicitly", async () => {
  for (const response of [
    { messages: rows(3) },
    { messages: [], hasMore: true, nextCursor: "same", sourceId: "fixture" },
    { messages: [body("x".repeat(8 * 1024 * 1024))], hasMore: false, nextCursor: null, sourceId: "fixture" },
  ]) {
    const pager = createChatHistoryPager({ request: async () => response, window: windowOf, id: row => row.id });
    pager.reset(key);
    await assert.rejects(pager.refresh(key));
    assert.equal(pager.current, null);
  }
});

function openclawFixture() {
  const state = { rows: rows(620), binding: { digest: "endpoint-a" }, requests: [], sessionId: "physical-a" };
  const backend = Object.create(OpenClawBackend.prototype);
  backend._endpointGuard = { capture: () => state.binding, isCurrent: binding => state.binding === binding };
  backend.request = async (method, params) => {
    state.requests.push({ method, params });
    assert.equal(method, "chat.history"); assert.equal(params.page, undefined); assert.equal(params.cursor, undefined);
    const end = state.rows.length - (params.offset || 0), start = Math.max(0, end - params.limit);
    return { messages: state.rows.slice(start, end), sessionId: state.sessionId,
      totalMessages: state.rows.length, hasMore: start > 0, ...(start ? { nextOffset: state.rows.length - start } : {}) };
  };
  return { backend, state };
}
test("OpenClaw adapter pages past 500, binds owner/session/total, never uses sessions.get", async () => {
  const f = openclawFixture(), all = [];
  let cursor = null;
  do {
    const page = await f.backend.getHistoryPage(key, { cursor, limit: 100 });
    all.unshift(...page.messages); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all, f.state.rows);
  const first = await f.backend.getHistoryPage(key);
  await assert.rejects(f.backend.getHistoryPage("agent:fixture:other", { cursor: first.nextCursor }), code("CHAT_HISTORY_CURSOR_INVALID"));
  f.state.rows.push(body("new"));
  await assert.rejects(f.backend.getHistoryPage(key, { cursor: first.nextCursor }), code("CHAT_HISTORY_CURSOR_INVALID"));
  f.state.rows.pop(); f.state.binding = { digest: "endpoint-b" };
  await assert.rejects(f.backend.getHistoryPage(key, { cursor: first.nextCursor }), code("CHAT_HISTORY_CURSOR_INVALID"));
});
test("OpenClaw follows raw nextOffset with hidden records and split boundary replay", async () => {
  const f = openclawFixture(); let count = 0;
  const part = { ...body("shared"), __openclaw: { id: "shared", seq: 40 } };
  f.backend.request = async (_method, params) => {
    if (count++ === 0) return { messages: [part, body("newer")], totalMessages: 200, sessionId: "physical",
      nextOffset: 161, hasMore: true };
    assert.equal(params.offset, 161, "never subtract a displayed-message overlap from a raw offset");
    return { messages: [body("old"), { ...part, content: [{ type: "text", text: "other sibling" }] }, part],
      totalMessages: 200, sessionId: "physical", hasMore: false };
  };
  const first = await f.backend.getHistoryPage(key);
  const second = await f.backend.getHistoryPage(key, { cursor: first.nextCursor });
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].content[0].text, "other sibling");
  f.backend.request = async () => ({ messages: rows(10) });
  await assert.rejects(f.backend.getHistoryPage(key), code("CHAT_HISTORY_UNSUPPORTED"));
});
for (const transport of ["gateway", "acp"]) test(`Hermes ${transport} /new has local history until its first accepted prompt`, async () => {
  const backend = new HermesBackend({});
  backend.profileById.set("hermes-fixture", "isolated");
  backend.dashboards.set("isolated", { baseUrl: "http://127.0.0.1:1", token: "fixture" });
  backend.getChatCacheScope = () => "isolated-source";
  backend._gatewayChatEnabled = () => transport === "gateway";
  backend._gwSocket = () => ({ generation: 1, request: async () => ({ session_id: "runtime", stored_session_id: "fresh" }) });
  backend._clientForProfile = () => ({ newSession: async () => "fresh", setSessionModel: async () => {} });
  let reads = 0;
  backend._httpGet = async () => { reads++; return { status: 404, body: "{}" }; };
  const session = await backend.createSession("hermes-fixture", { model: "fixture-model" });
  const page = await backend.getHistoryPage(session);
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.ok(page.sourceId);
  assert.equal(reads, 0, "an unpersisted new session must not query the messages endpoint");
  assert.deepEqual(await backend.getHistoryPage(session), page, "reopening a fresh session stays empty");
  backend.transcripts.get(session).push(body("local-first-prompt"));
  assert.equal((await backend.getHistoryPage(session)).messages[0].id, "local-first-prompt",
    "a first prompt waiting for acceptance must not disappear");
  backend.freshSessionKeys.delete(session);
  backend.freshSessionTransports.delete(session);
  await assert.rejects(backend.getHistoryPage(session), /HTTP 404/, "persisted history errors remain visible");
  backend._httpGet = async url => {
    const query = new URL(url).searchParams;
    return { status: 200, body: JSON.stringify({ session_id: "fresh",
      messages: [{ id: 1, role: "user", content: "persisted first prompt" }],
      pagination: { limit: Number(query.get("limit")), offset: 0, order: "latest", returned: 1 } }) };
  };
  assert.equal((await backend.getHistoryPage(session)).messages[0].id, "hermes-msg-1",
    "after acceptance the persisted transcript becomes authoritative");
});
test("Hermes explicit latest/offset pages exceed 500 and invalidate append/source changes", async () => {
  const backend = new HermesBackend({});
  backend.profileById.set("hermes-fixture", "isolated");
  backend.dashboards.set("isolated", { baseUrl: "http://127.0.0.1:1", token: "fixture" });
  backend.getChatCacheScope = () => "isolated-source";
  const messages = rows(627).map((message, index) => ({ id: index + 1, role: message.role, content: `body-${index}` }));
  const seen = [];
  backend._httpGet = async url => {
    const query = new URL(url).searchParams, limit = Number(query.get("limit")), offset = Number(query.get("offset"));
    assert.equal(query.get("order"), "latest"); assert.ok(limit <= 102);
    seen.push({ limit, offset });
    const end = messages.length - offset, start = Math.max(0, end - limit), result = messages.slice(start, end);
    return { status: 200, body: JSON.stringify({ session_id: "durable", messages: result,
      pagination: { limit, offset, order: "latest", returned: result.length } }) };
  };
  const session = "agent:hermes-fixture:durable", all = [];
  let cursor = null;
  do {
    const page = await backend.getHistoryPage(session, { cursor });
    all.unshift(...page.messages); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(all.length, 627); assert.equal(all[0].id, "hermes-msg-1");
  assert.equal(new Set(all.map(row => row.id)).size, 627);
  assert.ok(seen.some(page => page.offset > 500));
  const first = await backend.getHistoryPage(session);
  messages.push({ id: 628, role: "user", content: "new" });
  await assert.rejects(backend.getHistoryPage(session, { cursor: first.nextCursor }), code("CHAT_HISTORY_CURSOR_INVALID"));
  backend._httpGet = async () => ({ status: 200, body: JSON.stringify({ messages: [] }) });
  await assert.rejects(backend.getHistoryPage(session), code("CHAT_HISTORY_UNSUPPORTED"));
});
function nativeFixture(messages) {
  const backend = Object.create(ShoggothBackend.prototype), session = { runtimeBindingId: "binding", status: "idle" };
  backend._generation = 1; backend.maxPages = 1000; backend._nativeUiAvailable = true;
  backend._codexDesktopEntries = new Map();
  backend._sessionTarget = () => ({ profile: { id: "fixture" }, sessionKey: "native-key", session });
  const items = messages.flatMap(message => {
    const serialized = JSON.stringify(message);
    if (serialized.length <= 16000) return [{ fragment: null, payload: { message } }];
    const parts = serialized.match(/[\s\S]{1,16000}/g);
    return parts.map((data, index) => ({ fragment: { messageId: message.id, index, count: parts.length },
      payload: { encoding: "gateway-message-json-utf8", sha256: crypto.createHash("sha256").update(serialized).digest("hex"), data } }));
  });
  const calls = [];
  backend._call = async (method, params) => {
    calls.push({ method, params });
    const end = params.cursor ? Number(params.cursor) : items.length, start = Math.max(0, end - params.limit);
    return { messages: items.slice(start, end), hasMore: start > 0, nextCursor: start ? String(start) : null };
  };
  return { backend, calls, session };
}
test("native ordinary/Desktop reader completes long-message fragments across transport pages", async () => {
  const messages = rows(221); messages[112] = { ...body("112"), content: [{ type: "text", text: "long ".repeat(60000) }] };
  for (const desktop of [false, true]) {
    const f = nativeFixture(messages);
    if (desktop) f.backend._codexDesktopEntries.set("native-key", { threadId: "desktop-thread", homeIdentity: "isolated-home" });
    const all = []; let cursor = null;
    do {
      const page = await f.backend.getHistoryPage(key, { cursor });
      all.unshift(...page.messages); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(all, messages);
    assert.ok(f.calls.every(call => call.method === (desktop ? "codex.desktop.history" : "chat.history")));
    assert.ok(f.calls.every(call => call.params.limit <= 20));
  }
});
test("native rejects source changes, malformed pages and fragment corruption", async () => {
  const f = nativeFixture(rows(240));
  const first = await f.backend.getHistoryPage(key);
  f.session.runtimeBindingId = "different";
  await assert.rejects(f.backend.getHistoryPage(key, { cursor: first.nextCursor }), code("CHAT_HISTORY_CURSOR_INVALID"));
  f.backend._call = async () => ({ messages: [], hasMore: true, nextCursor: null });
  await assert.rejects(f.backend.getHistoryPage(key), code("CHAT_HISTORY_INVALID"));
  f.backend._call = async () => ({ messages: [{ fragment: { index: 1, count: 2, messageId: "broken" },
    payload: { encoding: "gateway-message-json-utf8", sha256: "0".repeat(64), data: "{}" } }], hasMore: false });
  await assert.rejects(f.backend.getHistoryPage(key), code("CHAT_HISTORY_FRAGMENT_INVALID"));
});
