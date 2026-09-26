"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  AgentBackend,
  SESSION_BOARD_HTML_MAX_BYTES,
} = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const SESSION_KEY = "agent:main:branch/with/slash";
const WIDGET_NAME = "dashboard.main";
const VIEW_GENERATION = "0123456789abcdef0123456789abcdef";
const VIEW_TICKET = `v1.${Buffer.from("ticket-payload").toString("base64url")}.signature`;
const SPEC = Object.freeze({
  name: WIDGET_NAME,
  revision: 3,
  instanceId: VIEW_GENERATION,
});

function boardPath(ticket = VIEW_TICKET) {
  return `/__openclaw__/board/${encodeURIComponent(SESSION_KEY)}`
    + `/${encodeURIComponent(WIDGET_NAME)}/index.html?bt=${encodeURIComponent(ticket)}`;
}

function hello({ methods = ["board.get"], scopes = ["operator.read"] } = {}) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.8.1" },
    features: { methods, events: [], capabilities: [] },
    auth: { role: "operator", scopes },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
  };
}

function boardSnapshot(widgetPatch = {}, snapshotPatch = {}) {
  return {
    sessionKey: SESSION_KEY,
    revision: 9,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [{
      name: WIDGET_NAME,
      tabId: "main",
      contentKind: "html",
      contentOwner: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: SPEC.revision,
      instanceId: SPEC.instanceId,
      frameUrl: boardPath(),
      viewTicket: VIEW_TICKET,
      viewGeneration: VIEW_GENERATION,
      ...widgetPatch,
    }],
    ...snapshotPatch,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  let responseMode = "success";
  const requests = [];
  const goodHtml = Buffer.from("<!doctype html><p>board widget</p>");
  const upstream = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (responseMode === "redirect") {
      res.writeHead(302, { Location: "https://evil.example/steal" });
      res.end();
      return;
    }
    if (responseMode === "not-found") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
      return;
    }
    if (responseMode === "wrong-type") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("not html");
      return;
    }
    if (responseMode === "invalid-utf8") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(Buffer.from([0xc3, 0x28]));
      return;
    }
    if (responseMode === "declared-large") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(SESSION_BOARD_HTML_MAX_BYTES + 1),
      });
      res.end();
      return;
    }
    if (responseMode === "stream-large") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(Buffer.alloc(SESSION_BOARD_HTML_MAX_BYTES + 1, 0x61));
      return;
    }
    if (responseMode === "exact-limit") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(SESSION_BOARD_HTML_MAX_BYTES),
      });
      res.end(Buffer.alloc(SESSION_BOARD_HTML_MAX_BYTES, 0x61));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Content-Length": String(goodHtml.length),
      "Set-Cookie": "upstream-secret=must-not-cross",
      "X-Upstream-Secret": "must-not-cross",
    });
    res.end(goodHtml);
  });
  const upstreamPort = await listen(upstream);

  const backend = new OpenClawBackend({
    getUpstreamUrl: () => `ws://127.0.0.1:${upstreamPort}/rpc?discard=yes`,
  });
  backend._connect = async () => {};
  backend._loadAuth = () => { throw new Error("Board HTML fetch must not read HTTP credentials"); };
  backend._acceptGatewayHello(hello());
  let boardResult = boardSnapshot();
  const boardCalls = [];
  backend.request = async (method, params) => {
    boardCalls.push({ method, params });
    return boardResult;
  };

  try {
    const success = await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC);
    assert.deepEqual(success, {
      supported: true,
      ok: true,
      html: goodHtml,
      boardRevision: 9,
      widgetIdentity: SPEC,
      viewGeneration: VIEW_GENERATION,
    });
    assert.deepEqual(boardCalls.at(-1), {
      method: "board.get",
      params: { sessionKey: SESSION_KEY, agentId: "main" },
    });
    assert.equal(requests.at(-1).method, "GET");
    assert.equal(requests.at(-1).url, boardPath());
    assert.equal(requests.at(-1).headers.authorization, undefined);
    assert.equal(requests.at(-1).headers.cookie, undefined);
    assert.equal(requests.at(-1).headers["x-openclaw-device-token"], undefined);

    const firstBoardReadCount = boardCalls.length;
    const second = await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC);
    assert.equal(second.ok, true);
    assert.equal(boardCalls.length, firstBoardReadCount + 1,
      "each local ticket mint must start from a fresh board.get");

    boardResult = boardSnapshot({ grantState: "granted" });
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).ok, true,
      "an exact already-granted HTML widget remains renderable");
    boardResult = boardSnapshot();

    const beforeOwnerMismatch = boardCalls.length;
    assert.deepEqual(
      await backend.fetchSessionBoardHtmlWidget("other", SESSION_KEY, SPEC),
      { supported: false, reason: "invalid-request" },
    );
    assert.equal(boardCalls.length, beforeOwnerMismatch,
      "owner mismatch must fail before board.get or HTTP fetch");

    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, {
      ...SPEC,
      revision: SPEC.revision + 1,
    })).reason, "widget-stale");
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, {
      ...SPEC,
      instanceId: "f".repeat(32),
    })).reason, "widget-stale");
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, {
      ...SPEC,
      extra: "closed-input",
    })).reason, "invalid-request");

    boardResult = boardSnapshot({ grantState: "pending" });
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "widget-not-renderable");
    boardResult = boardSnapshot({ contentKind: "mcp-app", contentOwner: "mcp-app" });
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "widget-not-renderable");
    boardResult = boardSnapshot({}, { widgets: [] });
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "widget-not-found");
    boardResult = boardSnapshot({}, { sessionKey: "agent:other:main" });
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "invalid-response");

    const ticketFailures = [
      { frameUrl: boardPath("different-ticket") },
      { frameUrl: `${boardPath()}&extra=1` },
      { frameUrl: `${boardPath()}&bt=${encodeURIComponent(VIEW_TICKET)}` },
      { frameUrl: `http://evil.example${boardPath()}` },
      { frameUrl: "/__openclaw__/board/wrong/widget/index.html?bt=" + encodeURIComponent(VIEW_TICKET) },
      { viewTicket: "raw-secret-without-version" },
      { viewGeneration: "f".repeat(32) },
      { frameUrl: undefined },
    ];
    for (const patch of ticketFailures) {
      boardResult = boardSnapshot(patch);
      assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
        "ticket-invalid");
    }

    boardResult = boardSnapshot();
    for (const [mode, reason] of [
      ["redirect", "redirect"],
      ["not-found", "not-found"],
      ["wrong-type", "content-type"],
      ["invalid-utf8", "invalid-utf8"],
      ["declared-large", "too-large"],
      ["stream-large", "too-large"],
    ]) {
      responseMode = mode;
      assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
        reason, mode);
    }
    responseMode = "exact-limit";
    const exactLimit = await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC);
    assert.equal(exactLimit.ok, true);
    assert.equal(exactLimit.html.length, SESSION_BOARD_HTML_MAX_BYTES,
      "the raw and strict-UTF-8 decoded limits are inclusive");

    responseMode = "success";
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    try {
      global.fetch = (_target, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("private timeout detail");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      global.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 5, ...args);
      assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
        "timeout");
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
    }

    backend.request = async () => { throw new Error("private board RPC URL and ticket"); };
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "upstream-error");
    backend.request = async () => { throw new Error("RPC timed out with private details"); };
    assert.equal((await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC)).reason,
      "timeout");

    backend._acceptGatewayHello(hello({ methods: [] }));
    let unsupportedRead = false;
    backend.request = async () => {
      unsupportedRead = true;
      return boardSnapshot();
    };
    assert.deepEqual(await backend.fetchSessionBoardHtmlWidget("main", SESSION_KEY, SPEC), {
      supported: false,
      reason: "unsupported",
    });
    assert.equal(unsupportedRead, false);
  } finally {
    await close(upstream);
  }

  const fixtureHtml = Buffer.from("<p>safe</p>");
  class FixtureBackend extends AgentBackend {
    get id() { return "fixture"; }
    get name() { return "Fixture"; }
    async fetchSessionBoardHtmlWidget(_agentId, _sessionKey, spec) {
      return {
        supported: true,
        ok: true,
        html: fixtureHtml,
        boardRevision: 4,
        widgetIdentity: spec,
        viewGeneration: spec.instanceId,
        frameUrl: "https://secret.example/private",
        viewTicket: "private-ticket",
        error: "private-error",
      };
    }
  }
  const registry = new BackendRegistry();
  registry.register(new FixtureBackend());
  const registryResult = await registry.fetchSessionBoardHtmlWidget(
    "fixture",
    "main",
    SESSION_KEY,
    SPEC,
  );
  assert.deepEqual(registryResult, {
    supported: true,
    ok: true,
    html: Buffer.from("<p>safe</p>"),
    boardRevision: 4,
    widgetIdentity: SPEC,
    viewGeneration: VIEW_GENERATION,
  });
  assert.equal(JSON.stringify(registryResult).includes("secret"), false);
  assert.equal(fixtureHtml.every((byte) => byte === 0), true,
    "registry must scrub the backend-owned HTML buffer after copying its projection");
  assert.deepEqual(
    await registry.fetchSessionBoardHtmlWidget("missing", "main", SESSION_KEY, SPEC),
    { supported: false, reason: "unknown-backend" },
  );

  class ThrowingBackend extends AgentBackend {
    get id() { return "throwing"; }
    get name() { return "Throwing"; }
    async fetchSessionBoardHtmlWidget() {
      throw new Error("https://private.example/?bt=secret-ticket");
    }
  }
  registry.register(new ThrowingBackend());
  const originalConsoleError = console.error;
  const logs = [];
  try {
    console.error = (...args) => logs.push(args);
    assert.deepEqual(
      await registry.fetchSessionBoardHtmlWidget("throwing", "main", SESSION_KEY, SPEC),
      { supported: true, ok: false, reason: "upstream-error" },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(logs, [["[registry] throwing fetchSessionBoardHtmlWidget failed"]]);
  assert.equal(JSON.stringify(logs).includes("private.example"), false);
  assert.equal(JSON.stringify(logs).includes("secret-ticket"), false);

  const staticServerSource = fs.readFileSync(
    path.join(__dirname, "../app/static-server.js"),
    "utf8",
  );
  assert.equal(staticServerSource.includes("fetchSessionBoardHtmlWidget"), false,
    "raw persistent Board HTML must not gain a management-plane HTTP route");

  console.log("openclaw board html widget: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
