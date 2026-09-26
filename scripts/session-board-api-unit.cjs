"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentBackend } = require("../app/core/agent-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const {
  SESSION_BOARD_METHOD_NAMES,
  CANVAS_DOCUMENT_CAPABILITY,
  sessionBoardMethodMap,
  sessionBoardCapabilityMap,
} = require("../app/core/session-board-projection");

const methods = sessionBoardMethodMap(Object.fromEntries(
  SESSION_BOARD_METHOD_NAMES.map((name) => [name, true]),
));
const capabilities = sessionBoardCapabilityMap({ [CANVAS_DOCUMENT_CAPABILITY]: true });

function snapshot(sessionKey, extra = {}) {
  return {
    sessionKey,
    revision: 2,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [{
      name: "canvas-widget",
      tabId: "main",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 2,
      instanceId: "instance-2",
      declared: { netOrigins: ["https://api.example"], tools: ["prompt"] },
      frameUrl: "https://secret.example/frame",
      viewTicket: "secret-ticket",
      props: { token: "secret-prop" },
    }],
    ...extra,
  };
}

class BoardBackend extends AgentBackend {
  constructor(id) {
    super();
    this.backendId = id;
    this.calls = [];
  }

  get id() { return this.backendId; }
  get name() { return this.backendId; }
  getBackendDescriptor() {
    return {
      id: this.id,
      name: this.name,
      connectionMode: "gateway",
      disconnectable: true,
      surfaces: {
        chat: false, agents: false, models: false, skills: false, usage: false,
        oauth: false, dashboardRuns: false, agentHarness: false, cron: null, kanban: null,
      },
    };
  }
  ownsAgentId(agentId) { return agentId === `${this.id}-owned`; }

  async getSessionBoard(agentId, sessionKey) {
    this.calls.push(["getSessionBoard", agentId, sessionKey]);
    return { supported: true, methods, capabilities, snapshot: snapshot(sessionKey) };
  }

  async updateSessionBoard(agentId, sessionKey, ops) {
    this.calls.push(["updateSessionBoard", agentId, sessionKey, ops]);
    return { supported: true, methods, capabilities, snapshot: snapshot(sessionKey) };
  }

  async pinSessionBoardCanvas(agentId, sessionKey, spec) {
    this.calls.push(["pinSessionBoardCanvas", agentId, sessionKey, spec]);
    return {
      supported: true,
      methods,
      capabilities,
      snapshot: snapshot(sessionKey),
      resolvedWidgetName: spec.name,
      rawHtml: "<script>secret</script>",
    };
  }

  async decideSessionBoardWidgetGrant(agentId, sessionKey, spec) {
    this.calls.push(["decideSessionBoardWidgetGrant", agentId, sessionKey, spec]);
    return { supported: true, methods, capabilities, snapshot: snapshot(sessionKey) };
  }
}

class BrokenBackend extends BoardBackend {
  async getSessionBoard() { throw new Error("raw backend secret"); }
}

function request(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

async function main() {
  const registry = new BackendRegistry();
  const explicit = new BoardBackend("explicit");
  const owner = new BoardBackend("owner");
  const broken = new BrokenBackend("broken");
  registry.register(explicit);
  registry.register(owner);
  registry.register(broken);

  const key = "agent:owner-owned:branch/with/slash";
  const direct = await registry.getSessionBoard("explicit", "owner-owned", key);
  assert.equal(direct.snapshot.sessionKey, key, "registry must route by explicit backend id");
  assert.equal(explicit.calls.at(-1)[0], "getSessionBoard");
  assert.equal(owner.calls.length, 0, "agent ownership must not override the explicit backend route");
  assert.equal(JSON.stringify(direct).includes("secret-ticket"), false);
  assert.deepEqual(direct.snapshot.widgets[0].accessSummary, {
    networkOrigins: ["https://api.example"],
    tools: ["prompt"],
  });

  const beforeInvalid = explicit.calls.length;
  const invalidMutation = await registry.updateSessionBoard("explicit", "owner-owned", key, []);
  assert.equal(invalidMutation.reason, "invalid-request");
  assert.equal(explicit.calls.length, beforeInvalid);

  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  const failed = await registry.getSessionBoard("broken", "main", "agent:main:main");
  console.error = originalConsoleError;
  assert.equal(failed.supported, false);
  assert.equal(failed.reason, "error");
  assert.equal(JSON.stringify(failed).includes("raw backend secret"), false);
  assert.equal(logged.some((line) => line.includes("raw backend secret")), false);
  const unknown = await registry.getSessionBoard("missing", "main", "agent:main:main");
  assert.equal(unknown.reason, "unknown-backend");
  assert.equal(unknown.snapshot, null);

  const server = await startStaticServer(0, { registry });
  try {
    const query = new URLSearchParams({ backend: "explicit", agentId: "owner-owned", sessionKey: key });
    const get = await request(server.url, "GET", `/__api/session-board?${query}`);
    assert.equal(get.status, 200);
    assert.equal(get.json.snapshot.sessionKey, key);
    assert.equal(get.json.snapshot.widgets[0].content.kind, "html");
    assert.equal(get.json.snapshot.widgets[0].content.supported, false);
    assert.equal(get.text.includes("secret"), false);

    const ops = [{ kind: "widget_move", name: "canvas-widget", position: 0 }];
    const updated = await request(server.url, "POST", "/__api/session-board/ops", {
      backend: "explicit", agentId: "owner-owned", sessionKey: key, ops,
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(explicit.calls.at(-1), ["updateSessionBoard", "owner-owned", key, ops]);
    assert.equal(updated.text.includes("secret"), false);

    const canvasSpec = {
      name: "canvas-widget", docId: "cv_0123456789abcdef", title: "Canvas",
      placement: { tabId: "main", size: "md" },
    };
    const pinned = await request(server.url, "POST", "/__api/session-board/pin-canvas", {
      backend: "explicit", agentId: "owner-owned", sessionKey: key, spec: canvasSpec,
    });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.json.resolvedWidgetName, "canvas-widget");
    assert.deepEqual(explicit.calls.at(-1), [
      "pinSessionBoardCanvas", "owner-owned", key, canvasSpec,
    ]);
    assert.equal(pinned.text.includes("rawHtml"), false);

    const grantSpec = {
      name: "canvas-widget", revision: 2, instanceId: "instance-2", decision: "rejected",
    };
    const granted = await request(server.url, "POST", "/__api/session-board/grant", {
      backend: "explicit", agentId: "owner-owned", sessionKey: key, spec: grantSpec,
    });
    assert.equal(granted.status, 200);
    assert.deepEqual(explicit.calls.at(-1), [
      "decideSessionBoardWidgetGrant", "owner-owned", key, grantSpec,
    ]);

    const missing = await request(server.url, "GET", "/__api/session-board");
    assert.equal(missing.status, 400);
    const badAgent = await request(
      server.url,
      "GET",
      "/__api/session-board?backend=explicit&agentId=../bad&sessionKey=agent%3Amain%3Amain",
    );
    assert.equal(badAgent.status, 400);
    const controlKey = await request(
      server.url,
      "GET",
      "/__api/session-board?backend=explicit&agentId=owner-owned&sessionKey=agent%3Aowner-owned%3Amain%09bad",
    );
    assert.equal(controlKey.status, 400);
    const unknownQuery = await request(
      server.url,
      "GET",
      `/__api/session-board?${query}&extra=1`,
    );
    assert.equal(unknownQuery.status, 400);
    const duplicateQuery = await request(
      server.url,
      "GET",
      `/__api/session-board?${query}&backend=explicit`,
    );
    assert.equal(duplicateQuery.status, 400);
    const emptyOps = await request(server.url, "POST", "/__api/session-board/ops", {
      backend: "explicit", agentId: "owner-owned", sessionKey: key, ops: [],
    });
    assert.equal(emptyOps.status, 400);
    const unknownField = await request(server.url, "POST", "/__api/session-board/pin-canvas", {
      backend: "explicit", agentId: "owner-owned", sessionKey: key, spec: canvasSpec, token: "secret",
    });
    assert.equal(unknownField.status, 400);
    const rawHtml = await request(server.url, "POST", "/__api/session-board/pin-canvas", {
      backend: "explicit",
      agentId: "owner-owned",
      sessionKey: key,
      spec: { name: "canvas", docId: "cv_1", html: "<script>secret</script>" },
    });
    assert.equal(rawHtml.status, 400);
    const wrongMethod = await request(server.url, "DELETE", "/__api/session-board/ops");
    assert.equal(wrongMethod.status, 405);
  } finally {
    await server.close();
  }

  console.log("session board api: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
