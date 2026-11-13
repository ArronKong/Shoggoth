"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HermesBackend } = require("../app/core/hermes-backend");
const { transcriptHistoryItem } = require("../app/agent-service/chat-service-controller");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createDashboardJournal } = require("../app/core/dashboard-journal");

test("reconnect consumes a retained terminal error and releases observers without resubmitting", async () => {
  const backend = new HermesBackend({}), key = "agent:hermes-default:stored-lost";
  backend.profileById.set("hermes-default", "default"); backend.dashboards.set("default", { baseUrl: "http://127.0.0.1:9119" });
  backend.transcripts.set(key, [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "read notes" }] }]);
  const mapping = { runtimeId: "old-runtime", storedId: "stored-lost", profile: "default", generation: 0 };
  backend.gwRuntimeByKey.set(key, mapping); backend.gwKeyByRuntime.set(mapping.runtimeId, key);
  let released = false; const errors = [], requests = [];
  const turn = { sessionKey: key, hooks: { error: message => errors.push(message) }, observers: new Set(), resolve() { released = true; } };
  backend.gwTurns.set(mapping.runtimeId, turn);
  backend.gwSockets.set("default", { generation: 1, restoreServerRequests() {}, replayServerRequests() {},
    async request(method) { requests.push(method); return { session_id: "new-runtime", inflight: { status: "error", error: "HTTP 429" } }; } });
  backend._onGwReconnect("default"); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["session.resume"]);
  assert.equal(errors.length, 1); assert.match(errors[0], /429/u);
  assert.equal(released, true); assert.equal(backend.gwTurns.size, 0);
});

test("rate-limit failure preserves a partial answer while explaining its terminal cause", () => {
  const backend = new HermesBackend({}), key = "agent:hermes-default:partial";
  backend.profileById.set("hermes-default", "default"); backend.dashboards.set("default", { baseUrl: "http://fixture.invalid" });
  backend.transcripts.set(key, [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "read" }] }]);
  let message;
  backend._gwComplete(key, "runtime", { sessionKey: key, hooks: { error: value => { message = value; } }, observers: new Set() },
    { status: "error", partial: true, text: "已经查到的部分结果", error: "HTTP 429" });
  assert.match(message, /已经查到的部分结果/u); assert.match(message, /429/u);
});

test("terminal diagnostics are bounded, expire, and persist no untyped provider fields", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-failure-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json"); let now = Date.now();
  const journal = createDashboardJournal(file, { now: () => now });
  for (let i = 0; i < 260; i++) journal.recordChatFailure(i.toString(16).padStart(64, "0"),
    { code: "rate_limit", at: now + i, userAt: now - 1, userRowId: i + 1, error: "NeverPersistFixture987" });
  const data = JSON.parse(fs.readFileSync(file));
  assert.equal(Object.keys(data.chatFailures).length, 256);
  assert(!JSON.stringify(data).includes("NeverPersistFixture987"));
  const key = (259).toString(16).padStart(64, "0");
  assert.equal(journal.getChatFailure(key).code, "rate_limit");
  now += 8 * 24 * 3600000;
  assert.equal(createDashboardJournal(file, { now: () => now }).getChatFailure(key), null);
});

test("Hermes rate-limit errors survive full/paged history and App restart without replay", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-failure-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json"), key = "agent:hermes-default:stored-failure", now = Date.now();
  const user = { id: "hermes-msg-2", role: "user", content: [{ type: "text", text: "便签有多少" }], timestamp: now - 1000 };
  let rows = [user], requests = 0;
  const make = () => {
    const backend = new HermesBackend({});
    backend.profileById.set("hermes-default", "default"); backend.dashboards.set("default", { baseUrl: "http://127.0.0.1:9119" });
    backend.attachDashboardJournal(createDashboardJournal(file));
    backend._fetchHistoricalMessages = async () => rows.slice();
    backend._readHistoricalMessageResponse = async (_key, _id, page) => ({ session_id: "stored-failure",
      messages: rows.map(row => ({ ...row, id: Number(row.id.split("-").at(-1)), content: row.content[0].text,
        timestamp: row.timestamp / 1000 })), pagination: { ...page, returned: rows.length } });
    backend._gwSocket = () => { requests++; assert.fail("history cannot resume or resend"); };
    return backend;
  };
  const backend = make(); backend.transcripts.set(key, [user]);
  const errors = [];
  backend._gwComplete(key, "runtime-failure", { sessionKey: key, operationId: "failed-turn", userTimestamp: user.timestamp,
    hooks: { error: message => errors.push(message) }, observers: new Set() },
  { status: "error", text: "Your request was not processed.",
    error: "HTTP 429: model_concurrency_rate_limit_exceeded password: NeverPersistFixture987", // gitleaks:allow -- synthetic redaction fixture
    persisted_turn: { user_row_id: 2 }, usage: {} });
  assert.match(errors[0], /429/u, "use the provider failure rather than generic empty-response copy");
  const check = messages => {
    assert.equal(messages.filter(row => row.stopReason === "error").length, 1);
    assert.match(messages.at(-1).content[0].text, /429/u);
  };
  check((await backend.getHistory(key)).messages);
  const restored = make();
  check((await restored.getHistory(key)).messages);
  check((await restored.getHistoryPage(key, { limit: 50 })).messages);
  assert(!fs.readFileSync(file, "utf8").includes("NeverPersistFixture987"));
  restored.dashboards.set("default", { baseUrl: "http://remote-fixture.invalid" });
  assert.equal((await restored.getHistory(key)).messages.length, 1, "another host cannot inherit the failure");
  restored.dashboards.set("default", { baseUrl: "http://127.0.0.1:9119" });
  rows = [{ ...user, timestamp: Date.now() + 2000 }];
  assert.equal((await restored.getHistory(key)).messages.length, 1, "a replaced native row ID cannot inherit an old failure");
  rows = [user, { id: "hermes-msg-3", role: "user", content: [{ type: "text", text: "a later turn" }], timestamp: Date.now() + 2000 }];
  assert.equal((await restored.getHistory(key)).messages.at(-1).stopReason, undefined, "old error cannot trail a newer user message");
  assert.equal(requests, 0);
});

test("external Hermes reads refresh without replacing pending local transcripts", async () => {
  const backend = new HermesBackend({});
  const key = "agent:hermes-owl:cron_fixture";
  backend.profileById.set("hermes-owl", "owl");
  const prompt = { id: "prompt", role: "user", content: [{ type: "text", text: "cron prompt" }] };
  let rows = [prompt], reads = 0;
  backend._fetchHistoricalMessages = async () => { reads++; return rows.slice(); };
  backend.transcripts.set(key, [prompt]);
  assert.equal((await backend.getHistory(key)).messages.length, 1);
  rows = [prompt, { id: "final", role: "assistant", content: [{ type: "text", text: "completed report" }] }];
  assert.equal((await backend.getHistory(key)).messages.at(-1).id, "final", "cached prompt must not outlive the completed task");
  const local = [prompt, { role: "user", content: [{ type: "text", text: "new local send" }] }];
  backend.transcripts.set(key, local); backend.sendQueues.set(key, Promise.resolve());
  assert.equal((await backend.getHistory(key)).messages, local);
  assert.equal(reads, 2, "pending local sends retain their current transcript");
  backend.sendQueues.clear();
  backend._fetchHistoricalMessages = async () => { throw Error("fixture unavailable"); };
  await assert.rejects(backend.getHistory(key), /fixture unavailable/, "failure must not silently return a stale report");
});

test("Hermes history identifies producer continuations and preserves exact contents", () => {
  const backend = new HermesBackend({});
  const raw = [
    { id: 1, role: "user", content: "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: report] task", timestamp: 1000 },
    { id: 2, role: "assistant", content: "first half", timestamp: 1001 },
    { id: 3, role: "user", content: "[System: The previous response was cut off by a network error mid-stream — a transport interruption. Continue the task.]", timestamp: 1200 },
    { id: 4, role: "assistant", content: "second half", timestamp: 1500 },
    { id: 5, role: "user", content: "Explain this report", timestamp: 1501 },
  ];
  const before = JSON.stringify(raw), mapped = backend._mapHistoricalMessages(raw);
  assert(mapped.every(row => row.historySource === "hermes"));
  assert.equal(mapped[0].automation, "cron"); assert.equal(mapped[2].automation, "continuation");
  assert.equal(mapped[4].automation, undefined);
  assert.deepEqual(mapped.map(row => row.content[0].text), raw.map(row => row.content));
  assert.equal(JSON.stringify(raw), before, "projection cannot rewrite producer history");
});

test("native Cron inputs use WorkRun source, while human follow-ups remain chat", () => {
  const event = { id: "input", seq: 1, runId: "run", kind: "user", occurredAt: 1000, contextExcluded: false, content: { text: "same words" } };
  const cron = transcriptHistoryItem(event, "cron").payload.message;
  const chat = transcriptHistoryItem(event, "chat").payload.message;
  assert.equal(cron.shoggoth.source, "cron"); assert.equal(chat.shoggoth.source, "chat");
  assert.deepEqual(cron.content, chat.content, "same text is distinguished by its producer, never by task wording");
  assert.equal(event.content.cronOutputVersion, undefined, "legacy Cron events also retain source attribution");
});

test("background completion uses producer metadata without relabeling human text", () => {
  const backend = new HermesBackend({});
  const content = "[IMPORTANT: Background process proc_fixture completed normally (exit code 0).\n"
    + "Command: hermes update 2>&1 | tail -25\nOutput:\nOSError: [Errno 28] No space left on device]";
  const raw = [
    { id: 1, role: "user", content: "Update the runtime", timestamp: 1000 },
    { id: 2, role: "user", content, timestamp: 1001, display_kind: "process_complete",
      display_metadata: '{"display_text":"Background Process Finished: hermes update"}' },
    { id: 3, role: "assistant", content: "The command ended with a disk error.", timestamp: 1002 },
    { id: 4, role: "user", content, timestamp: 1003 },
    { id: 5, role: "user", content, timestamp: 1004, display_kind: "hidden" },
  ];
  const before = JSON.stringify(raw), mapped = backend._mapHistoricalMessages(raw);
  assert.deepEqual(mapped.map(row => row.role), ["user", "system", "assistant", "user"]);
  assert.deepEqual(mapped[1], { id: "hermes-msg-2", role: "system", notice: "processComplete",
    content: [{ type: "text", text: content }], timestamp: 1001000, historySource: "hermes" });
  assert.equal(mapped[3].notice, undefined, "identical human input retains its author");
  assert.equal(mapped[2].content[0].text, raw[2].content, "the agent's follow-up remains visible");
  assert.equal(JSON.stringify(raw), before, "display projection cannot change the stored conversation");
  for (const display_metadata of [undefined, null, {}, "not JSON"])
    assert.equal(backend._mapHistoricalMessages([{ ...raw[1], display_metadata }])[0].notice, "processComplete",
      "optional presentation text cannot undo the producer's notification identity");
});

test("background completion survives history refresh, older pages and backend recreation", async () => {
  const key = "agent:hermes-default:background-fixture";
  const raw = [
    { id: 1, role: "user", content: "Run the command", timestamp: 1000 },
    { id: 2, role: "user", content: "[IMPORTANT: Background process proc_fixture exited (exit code 1).]",
      display_kind: "process_complete", timestamp: 1001 },
    { id: 3, role: "assistant", content: "The background command failed.", timestamp: 1002 },
    { id: 4, role: "user", content: "Explain the failure", timestamp: 1003 },
  ];
  const make = () => {
    const backend = new HermesBackend({});
    backend.profileById.set("hermes-default", "default");
    backend.dashboards.set("default", { baseUrl: "http://fixture.invalid" });
    backend._gwSocket = () => assert.fail("reading notifications must not resume or submit a turn");
    backend._httpGet = async address => {
      const query = new URL(address).searchParams;
      const limit = Number(query.get("limit")), offset = Number(query.get("offset"));
      const end = raw.length - offset, messages = limit ? raw.slice(Math.max(0, end - limit), end) : raw;
      return { status: 200, body: JSON.stringify({ session_id: "background-fixture", messages,
        pagination: { limit, offset, order: "latest", returned: messages.length } }) };
    };
    return backend;
  };
  const backend = make();
  const check = result => {
    const message = result.messages.find(row => row.id === "hermes-msg-2");
    assert.equal(message?.notice, "processComplete"); assert.equal(message.role, "system");
    assert.equal(message.content[0].text, raw[1].content);
  };
  check(await backend.getHistory(key)); check(await backend.getHistory(key));
  const restored = make(); check(await restored.getHistory(key));
  const latest = await restored.getHistoryPage(key, { limit: 2 });
  assert.equal(latest.hasMore, true);
  check(await restored.getHistoryPage(key, { limit: 2, cursor: latest.nextCursor }));
});
