"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { payloadPath, sha256 } = require("../app/agent-service/agent-file-store");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-native-files-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), sinceMs = now - 10_000;
  const profiles = ["a", "b", "archived"].map(id => ({ id, agentId: `agent-${id}`, name: `Writer ${id}`,
    enabled: id !== "archived", backendId: "shoggoth", runtime: "codex", runtimeAccountId: "codex" }));
  const sessions = profiles.flatMap(profile => ["chat", "cron", "inspiration"].map(kind => ({
    id: `${profile.id}-${kind}`, sessionKey: `${profile.id}-${kind}`, profileId: profile.id, workspace: root,
    status: "ready", createdAt: sinceMs - 100_000, updatedAt: now,
  })));
  const events = new Map(), calls = [];
  let clock = now;
  const backend = new ShoggothBackend({ paths: { tokenPath: "/tmp/unused-token" }, now: () => clock,
    readToken: () => "fixture", requestService: async () => { throw Error("unexpected real IPC"); } });
  backend._state = "started";
  backend._call = async (method, params) => {
    calls.push({ method, params });
    if (method === "profile.list") return { profiles, hasMore: false, nextCursor: null };
    if (method === "chat.session.list") {
      // Exercise real pagination instead of depending on the first sidebar page.
      const all = sessions.filter(session => session.profileId === params.profileId && (params.includeArchived || session.status !== "archived"));
      const cursor = Number(params.cursor || 0);
      return { sessions: all.slice(cursor, cursor + 1), hasMore: cursor + 1 < all.length, nextCursor: cursor + 1 < all.length ? String(cursor + 1) : null };
    }
    if (method === "run.list") return { runs: [{ id: `run-${params.sessionKey}`, startedAt: sinceMs - 100_000,
      finishedAt: now + 1000 }], hasMore: false, nextCursor: null };
    if (method === "harness.transcript.events") {
      const all = events.get(params.sessionId) || [];
      return { items: all.slice(params.cursor, params.cursor + 2), hasMore: params.cursor + 2 < all.length,
        nextCursor: params.cursor + 2, revision: all.length };
    }
    throw Error(`Unexpected ${method}`);
  };
  const file = (name, age = 0) => {
    const full = path.join(root, name); fs.writeFileSync(full, name);
    fs.utimesSync(full, new Date(now - age), new Date(now - age)); return full;
  };
  const output = (sessionId, full, { name = "write", success = true, input = false } = {}) => {
    const rows = events.get(sessionId) || [], id = String(rows.length);
    const event = (kind, content) => ({ kind, content, runId: `run-${sessionId}`, occurredAt: now });
    if (input) rows.push(event("user", { attachments: [{ path: full }] }));
    rows.push(event("tool_call", { toolCallId: id, tool: { name, displayArgs: { path: full } } }),
      event("tool_result", { toolCallId: id, tool: { success, status: success ? "completed" : "failed" } }));
    events.set(sessionId, rows);
  };
  return { root, backend, profiles, sessions, calls, events, file, output, sinceMs, now,
    advance: ms => { clock += ms; } };
}

test("native Dashboard aggregates all public Agent/session pages, excludes inputs, and limits after time filtering/dedup", async t => {
  const f = fixture(t);
  const first = f.file("first.txt"), second = f.file("second.md", 100), third = f.file("third.pdf", 200);
  f.output("a-chat", first); f.output("a-cron", second); f.output("b-inspiration", third);
  f.output("b-chat", first); // Same file referenced by two sessions, only one row.
  f.output("a-chat", f.file("uploaded.txt"), { input: true });
  f.output("a-chat", f.file("read.txt"), { name: "read" });
  f.output("a-chat", f.file("failed.txt"), { success: false });
  f.output("a-chat", f.file("old.txt", 50_000));
  f.output("archived-chat", f.file("archived.txt"));
  const result = await f.backend.getRecentArtifacts({ sinceMs: f.sinceMs, limit: 2 });
  assert.equal(result.supported, true); assert.equal(result.partial, false);
  assert.deepEqual(result.items.map(item => item.path), [first, second]);
  assert.equal(result.items[0].agentId, "agent-a"); assert.equal(result.items[0].agentName, "Writer a");
  assert.deepEqual((await f.backend.getRecentArtifacts({ sinceMs: f.sinceMs, limit: 20 })).items.map(item => item.path), [first, second, third]);
  assert.ok(!f.calls.some(call => call.params.profileId === "archived"));
});

test("concurrent reads share one scan; cached scopes refresh and removed sessions/Agents disappear immediately", async t => {
  const f = fixture(t), first = f.file("first.txt"), second = f.file("second.txt", 100);
  f.output("a-chat", first); f.output("b-chat", second);
  const query = { sinceMs: f.sinceMs };
  await Promise.all([f.backend.getRecentArtifacts(query), f.backend.getRecentArtifacts({ ...query, limit: 1 })]);
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 6);
  await f.backend.getRecentArtifacts(query);
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 6, "hot cache must not reread transcripts");
  f.advance(60_001);
  const stale = await f.backend.getRecentArtifacts(query);
  assert.equal(stale.items.length, 2);
  await f.backend._recentArtifactsScan?.promise;
  assert.equal(f.calls.filter(call => call.method === "run.list").length, 12);
  f.sessions.find(session => session.id === "a-chat").status = "archived";
  assert.deepEqual((await f.backend.getRecentArtifacts(query)).items.map(item => item.path), [second]);
  f.profiles[1].enabled = false;
  assert.deepEqual((await f.backend.getRecentArtifacts(query)).items, []);
});

test("one unreadable session/Agent keeps other files and exposes partial through Registry", async t => {
  const f = fixture(t), good = f.file("good.txt"); f.output("b-chat", good);
  const call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events" && params.sessionId === "a-chat") throw Error("unavailable transcript");
    return call(method, params);
  };
  const registry = new BackendRegistry(); registry.register(f.backend);
  let [result] = await registry._dashboardSection("getRecentArtifacts", b => b.getRecentArtifacts({ sinceMs: f.sinceMs }));
  assert.equal(result.partial, true); assert.deepEqual(result.items.map(item => item.path), [good]);
  f.backend._call = (method, params) => {
    if (method === "chat.session.list" && params.profileId === "a") throw Error("unavailable Agent");
    return call(method, params);
  };
  [result] = await registry._dashboardSection("getRecentArtifacts", b => b.getRecentArtifacts({ sinceMs: f.sinceMs }));
  assert.equal(result.partial, true); assert.deepEqual(result.items.map(item => item.path), [good]);
});

test("a changed Service generation cannot publish an in-flight native artifact snapshot", async t => {
  const f = fixture(t), call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events") f.backend._generation++;
    return call(method, params);
  };
  await assert.rejects(f.backend.getRecentArtifacts({ sinceMs: f.sinceMs }), /BACKEND_NOT_READY/);
  assert.equal(f.backend._recentArtifactsCache, undefined);
});

test("Agent outputs include only that Agent across paginated live and archived sessions, deduplicated before the limit", async t => {
  const f = fixture(t);
  const chat = f.file("chat.md"), cron = f.file("cron.pdf", 100), note = f.file("note.txt", 200);
  f.output("a-chat", chat); f.output("a-cron", cron); f.output("a-inspiration", note);
  f.output("a-cron", chat);
  f.sessions.find(session => session.id === "a-inspiration").status = "archived";
  f.output("b-chat", f.file("foreign-agent.md"));
  f.output("a-chat", f.file("user-upload.md"), { input: true });
  f.output("a-chat", f.file("read-only.md"), { name: "read" });
  f.output("a-chat", f.file("failed.md"), { success: false });
  f.file("unattributed-in-shared-workspace.md");
  const limited = await f.backend.listAgentArtifacts("agent-a", { limit: 1 });
  assert.equal(limited.total, 3);
  assert.equal(limited.partial, false);
  assert.deepEqual(limited.items.map(item => item.path), [chat]);
  assert.deepEqual((await f.backend.listAgentArtifacts("agent-a")).items.map(item => item.path), [chat, cron, note]);
  assert.ok(f.calls.filter(call => call.method === "chat.session.list").every(call => call.params.profileId === "a" && call.params.includeArchived));
  assert.ok(!f.calls.some(call => call.params.profileId === "b" || call.params.profileId === "archived"));
  await assert.rejects(() => f.backend.listAgentArtifacts("agent-archived"), /AGENT_NOT_FOUND/);
  await assert.rejects(() => f.backend.listAgentArtifacts("missing-agent"), /AGENT_NOT_FOUND/);
});

test("legacy Cron copies count once only while the workspace and published versions match", async t => {
  const f = fixture(t);
  const profile = f.profiles[0];
  f.backend.paths = resolveServicePaths({ homeDir: f.root, trustedRoot: f.root, stateRoot: path.join(f.root, "state") });
  const original = f.file("daily.md", 100);
  const content = fs.readFileSync(original);
  const file = { profileId: profile.id, fileId: "a".repeat(64), name: "daily.md", mimeType: "text/markdown",
    source: { kind: "cron", runId: "run-a-cron", sourceId: "job-a", sessionKey: "a-cron" },
    sizeBytes: content.length, sha256: sha256(content), createdAt: f.now, updatedAt: f.now, revision: 1, status: "available" };
  const savedPath = payloadPath(f.backend.paths, profile.id, file.fileId, file.name);
  fs.mkdirSync(path.dirname(savedPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(savedPath, content, { mode: 0o600 });
  f.output("a-cron", original);
  f.events.get("a-cron").push({ kind: "tool_result", runId: file.source.runId, occurredAt: f.now,
    content: { tool: { name: "shoggoth/artifact_publish", status: "completed",
      resultSummary: JSON.stringify({ file: { fileId: file.fileId, name: file.name } }) } } });
  const call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "agent.files.list") return { items: params.profileId === profile.id ? [file] : [], nextCursor: null };
    if (method === "agent.files.get" && params.profileId === profile.id && params.fileId === file.fileId) {
      return { file, path: savedPath };
    }
    return call(method, params);
  };
  const list = (options) => f.backend.listAgentArtifacts(profile.agentId, options);
  const result = await list();
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(item => item.path), [savedPath]);
  assert.deepEqual((await list({ includeManaged: false })).items, []);
  assert.ok(fs.existsSync(original));

  fs.writeFileSync(original, Buffer.alloc(content.length, "x"));
  fs.utimesSync(original, new Date(f.now - 100), new Date(f.now - 100));
  assert.deepEqual((await list()).items.map(item => item.path), [savedPath, original]);
});

test("Agent outputs distinguish partial and unavailable histories without a workspace fallback", async t => {
  const f = fixture(t), good = f.file("good.md"); f.output("a-chat", good);
  const call = f.backend._call;
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events" && params.sessionId === "a-cron") throw Error("unavailable transcript");
    return call(method, params);
  };
  const result = await f.backend.listAgentArtifacts("agent-a");
  assert.equal(result.supported, true); assert.equal(result.partial, true);
  assert.deepEqual(result.items.map(item => item.path), [good]);
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events") throw Error("unavailable transcript");
    return call(method, params);
  };
  assert.deepEqual(await f.backend.listAgentArtifacts("agent-a"), { supported: false, reason: "provenance-unavailable", items: [] });
});

test("Agent outputs reject foreign session ownership and a replaced Service generation", async t => {
  const f = fixture(t), call = f.backend._call;
  f.backend._call = (method, params) => method === "chat.session.list"
    ? { sessions: [f.sessions.find(session => session.profileId === "b")], hasMore: false, nextCursor: null }
    : call(method, params);
  await assert.rejects(() => f.backend.listAgentArtifacts("agent-a"), /CHAT_RESPONSE_INVALID/);
  f.backend._call = (method, params) => {
    if (method === "harness.transcript.events") f.backend._generation++;
    return call(method, params);
  };
  await assert.rejects(() => f.backend.listAgentArtifacts("agent-a"), /BACKEND_NOT_READY/);
});
