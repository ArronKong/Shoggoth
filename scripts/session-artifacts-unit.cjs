"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentBackend } = require("../app/core/agent-backend");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const { HermesBackend } = require("../app/core/hermes-backend");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = `agent:codex-default:${SESSION_ID}`;

(async () => {
  assert.deepEqual(await new AgentBackend().listSessionArtifacts("agent", "session"), {
    supported: false,
    reason: "unsupported",
    items: [],
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-artifacts-"));
  const runtimeHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-artifacts-runtime-"));
  try {
    const oldPath = path.join(root, "old.txt");
    const newPath = path.join(root, "index.html");
    fs.writeFileSync(oldPath, "old");
    fs.writeFileSync(newPath, "new");
    fs.utimesSync(oldPath, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(newPath, new Date(3_000_000), new Date(3_000_000));

    const native = new ShoggothBackend({
      id: "codex",
      name: "Codex",
      paths: { tokenPath: "/tmp/token" },
      readToken: () => "token",
      requestService: async () => ({}),
    });
    native._profilesByAgent.set("codex-default", {
      id: "profile-codex",
      agentId: "codex-default",
      backendId: "codex",
      runtime: "grok-build",
      runtimeProfileId: "grok-runtime",
      runtimeAccountId: "grok-account",
    });
    native._sessionsByKey.set(SESSION_ID, {
      id: SESSION_ID,
      sessionKey: SESSION_ID,
      profileId: "profile-codex",
      workspace: root,
      createdAt: 2_000_000,
    });
    const nativeResult = await native.listSessionArtifacts("codex-default", SESSION_KEY, { limit: 50 });
    assert.deepEqual(nativeResult, {
      supported: false, reason: "provenance-unavailable", items: [],
    }, "An unavailable transcript must never fall back to workspace timestamps");

    const runtimeHome = path.join(runtimeHomeRoot, "grok-runtime");
    const exported = path.join(runtimeHome, "Downloads", "video-export");
    const failedExport = path.join(runtimeHome, "Downloads", "failed-export");
    fs.mkdirSync(exported, { recursive: true });
    fs.mkdirSync(failedExport, { recursive: true });
    fs.writeFileSync(path.join(exported, "clip-01.mp4"), "one");
    fs.writeFileSync(path.join(exported, "clip-02.mp4"), "two");
    fs.writeFileSync(path.join(failedExport, "must-not-appear.mp4"), "failed");
    native.runtimeCliAuth.set("grok-account", {
      runtime: "grok-build",
      processHome: runtimeHome,
    });
    const runStartedAt = Date.now() - 10_000;
    const runFinishedAt = Date.now();
    native._call = async (method, params) => {
      if (method === "run.list") {
        assert.equal(params.sessionKey, SESSION_ID);
        return {
          runs: [{ id: "run-grok", startedAt: runStartedAt, finishedAt: runFinishedAt }],
          nextCursor: null,
          hasMore: false,
        };
      }
      assert.equal(method, "harness.transcript.events");
      assert.equal(params.sessionId, SESSION_ID);
      return {
        revision: 7,
        items: [
          {
            kind: "tool_call",
            runId: "run-grok",
            occurredAt: runStartedAt + 1_000,
            content: {
              toolCallId: "tool-ok",
              tool: { name: "fileChange", displayArgs: { changes: [
                { path: "$HOME/Downloads/video-export/clip-01.mp4", kind: "add" },
                { path: "$HOME/Downloads/video-export/clip-02.mp4", kind: "add" },
              ] } },
            },
          },
          {
            kind: "approval",
            runId: "run-grok",
            occurredAt: runStartedAt + 2_000,
            content: {
              itemId: "tool-ok",
              command: 'mkdir -p "$HOME/Downloads/video-export"',
            },
          },
          {
            kind: "tool_result",
            runId: "run-grok",
            occurredAt: runFinishedAt,
            content: {
              toolCallId: "tool-ok",
              tool: { status: "completed", success: true },
            },
          },
          {
            kind: "tool_call",
            runId: "run-grok",
            occurredAt: runStartedAt + 1_000,
            content: {
              toolCallId: "tool-failed",
              tool: { name: "write", displayArgs: { path: "$HOME/Downloads/failed-export/must-not-appear.mp4" } },
            },
          },
          {
            kind: "tool_result",
            runId: "run-grok",
            occurredAt: runFinishedAt,
            content: {
              toolCallId: "tool-failed",
              tool: { status: "failed", success: false },
            },
          },
          {
            kind: "tool_call",
            runId: "run-grok",
            occurredAt: runStartedAt + 1_000,
            content: {
              toolCallId: "tool-broad",
              tool: { name: "command", displayArgs: { command: 'ls "$HOME/Downloads"' } },
            },
          },
          {
            kind: "tool_result",
            runId: "run-grok",
            occurredAt: runFinishedAt,
            content: {
              toolCallId: "tool-broad",
              tool: { status: "completed", success: true },
            },
          },
        ],
        nextCursor: 7,
        hasMore: false,
      };
    };
    const recovered = await native.listSessionArtifacts("codex-default", SESSION_KEY, { limit: 50 });
    assert.equal(recovered.total, 2);
    assert.equal(recovered.approximate, false);
    assert.deepEqual(new Set(recovered.items.map((item) => item.name)), new Set([
      "clip-01.mp4", "clip-02.mp4",
    ]));
    assert.equal(recovered.items.some((item) => item.name === "must-not-appear.mp4"), false);
    assert.equal(recovered.items.filter((item) => item.name.startsWith("clip-"))
      .every((item) => item.area === "session-reference"), true);
    const limited = await native.listSessionArtifacts("codex-default", SESSION_KEY, { limit: 1 });
    assert.equal(limited.total, 2);
    assert.equal(limited.items.length, 1);
    await assert.rejects(native.listSessionArtifacts("foreign-agent", SESSION_KEY), { code: "CHAT_SESSION_INVALID" });
    native._call = async (method) => method === "run.list"
      ? { runs: [], hasMore: false, nextCursor: null }
      : { items: [], hasMore: true, nextCursor: 0 };
    assert.deepEqual(await native.listSessionArtifacts("codex-default", SESSION_KEY), {
      supported: false, reason: "provenance-unavailable", items: [],
    }, "Incomplete history cannot enable unscoped fallback");

    const openclaw = new OpenClawBackend();
    openclaw._isLocalGateway = () => true;
    openclaw._connect = async () => {};
    fs.utimesSync(newPath, new Date(), new Date());
    const history = [
      { role: "user", timestamp: runStartedAt, content: [{ type: "text", text: "Create a page" }] },
      { role: "assistant", timestamp: Date.now(), content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: newPath } }] },
      { role: "toolResult", timestamp: Date.now(), toolCallId: "write-1", isError: false, content: [{ type: "text", text: "saved" }] },
    ];
    openclaw.request = async (method, params) => {
      if (method === "sessions.list") return { sessions: [{ key: "agent:main:session-1", createdAt: runStartedAt }] };
      if (method === "agents.list") return { agents: [{ id: "main", workspace: root }] };
      assert.equal(method, "chat.history");
      assert.equal(params.sessionKey, "agent:main:session-1");
      return { messages: history };
    };
    let openclawArtifactScans = 0;
    openclaw.listAgentArtifacts = async () => {
      openclawArtifactScans += 1;
      return {
        supported: true,
        total: 2,
        items: [
          { path: "/tmp/new.html", name: "new.html", area: "agents/main", mtimeMs: 3_000, kind: "doc" },
          { path: "/tmp/old.html", name: "old.html", area: "agents/main", mtimeMs: 1_000, kind: "doc" },
        ],
      };
    };
    const openclawResult = await openclaw.listSessionArtifacts("main", "agent:main:session-1", { limit: 50 });
    assert.equal(openclawResult.sinceMs, runStartedAt);
    assert.equal(openclawResult.approximate, false);
    assert.deepEqual(openclawResult.items.map((item) => item.name), ["index.html"]);
    openclaw.request = async () => ({ sessions: [] });
    assert.deepEqual(await openclaw.listSessionArtifacts("main", "agent:main:session-1"), {
      supported: false,
      reason: "session-time-unavailable",
      items: [],
    });
    assert.equal(openclawArtifactScans, 0);

    openclaw._isLocalGateway = () => false;
    assert.deepEqual(await openclaw.listSessionArtifacts("main", "agent:main:session-1"), {
      supported: false,
      reason: "remote",
      items: [],
    });

    const hermes = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
    hermes.profileById.set("hermes-default", "default");
    hermes.dashboards.set("default", { baseUrl: "http://fixture.invalid", token: "fixture" });
    hermes.sessionRows = [{ key: "agent:hermes-default:session-2", startedAt: runStartedAt }];
    hermes._artifactRoots = async () => [{ path: root, agentId: "hermes-default" }];
    hermes._httpGetJson = async (url) => {
      assert.equal(url, "http://fixture.invalid/api/sessions/session-2/messages");
      return { status: 200, json: { messages: history } };
    };
    hermes.listAgentArtifacts = async () => ({
      supported: true,
      total: 2,
      items: [
        { path: "/tmp/result.pdf", name: "result.pdf", area: "default/output", mtimeMs: 4_000, kind: "doc" },
        { path: "/tmp/old.pdf", name: "old.pdf", area: "default/output", mtimeMs: 1_500, kind: "doc" },
      ],
    });
    const hermesResult = await hermes.listSessionArtifacts(
      "hermes-default", "agent:hermes-default:session-2", { limit: 50 },
    );
    assert.equal(hermesResult.sinceMs, runStartedAt);
    assert.equal(hermesResult.approximate, false);
    assert.deepEqual(hermesResult.items.map((item) => item.name), ["index.html"]);
    hermes._httpGetJson = async () => ({ status: 503, json: {} });
    assert.deepEqual(await hermes.listSessionArtifacts("hermes-default", "agent:hermes-default:session-2"), {
      supported: false, reason: "provenance-unavailable", items: [],
    });
    hermes.sessionRows = [];
    assert.deepEqual(await hermes.listSessionArtifacts(
      "hermes-default", "agent:hermes-default:session-2",
    ), { supported: false, reason: "session-time-unavailable", items: [] });

    const remoteHermes = new HermesBackend({ getConfig: () => ({ hermesMode: "remote", hermesRemotes: [] }) });
    assert.deepEqual(await remoteHermes.listSessionArtifacts(
      "hermes-default", "agent:hermes-default:session-2",
    ), { supported: false, reason: "remote", items: [] });

    console.log("✓ session-artifacts-unit: all cases passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(runtimeHomeRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
