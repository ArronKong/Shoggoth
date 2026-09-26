"use strict";

const assert = require("node:assert/strict");
const { OpenClawBackend } = require("../app/core/openclaw-backend");
const {
  SESSION_BOARD_METHOD_NAMES,
  CANVAS_DOCUMENT_CAPABILITY,
} = require("../app/core/session-board-projection");

function hello({
  methods = SESSION_BOARD_METHOD_NAMES,
  scopes = ["operator.read", "operator.write", "operator.approvals"],
  capabilities = [CANVAS_DOCUMENT_CAPABILITY],
} = {}) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.8.1" },
    features: { methods, events: [], capabilities },
    auth: { role: "operator", scopes },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 2_000_000 },
  };
}

function snapshot(sessionKey, extra = {}) {
  return { sessionKey, revision: 1, tabs: [], widgets: [], ...extra };
}

async function main() {
  const backend = new OpenClawBackend();
  backend._connect = async () => {};
  backend._acceptGatewayHello(hello());
  const calls = [];
  backend.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "board.widget.put") {
      return {
        ...snapshot(params.sessionKey, {
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [{
            name: params.name,
            tabId: "main",
            contentKind: "html",
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "none",
            revision: 1,
          }],
        }),
        resolvedWidgetName: params.name,
        secret: "upstream-secret",
      };
    }
    return snapshot(params.sessionKey, { frameUrl: "https://secret.example" });
  };

  const key = "agent:main:branch/with/slash";
  const read = await backend.getSessionBoard("main", key);
  assert.equal(read.supported, true);
  assert.deepEqual(read.methods, Object.fromEntries(SESSION_BOARD_METHOD_NAMES.map((name) => [name, true])));
  assert.deepEqual(read.capabilities, { [CANVAS_DOCUMENT_CAPABILITY]: true });
  assert.deepEqual(calls.at(-1), { method: "board.get", params: { sessionKey: key, agentId: "main" } });
  assert.equal(JSON.stringify(read).includes("secret"), false);

  const ops = [{ kind: "widget_resize", name: "widget", sizeW: 12, sizeH: 20, heightMode: "fixed" }];
  const updated = await backend.updateSessionBoard("main", key, ops);
  assert.equal(updated.supported, true);
  assert.deepEqual(calls.at(-1), {
    method: "board.update",
    params: { sessionKey: key, agentId: "main", ops },
  });

  const pinSpec = {
    name: "canvas-widget",
    docId: "cv_0123456789abcdef",
    title: "Canvas",
    placement: { tabId: "main", size: "lg", after: "widget" },
  };
  const pinned = await backend.pinSessionBoardCanvas("main", key, pinSpec);
  assert.equal(pinned.supported, true);
  assert.equal(pinned.resolvedWidgetName, "canvas-widget");
  assert.deepEqual(calls.at(-1), {
    method: "board.widget.put",
    params: {
      sessionKey: key,
      agentId: "main",
      name: "canvas-widget",
      title: "Canvas",
      content: { kind: "canvas-doc", docId: "cv_0123456789abcdef" },
      placement: { tabId: "main", size: "lg", after: "widget" },
    },
  });

  const grantSpec = {
    name: "canvas-widget", revision: 2, instanceId: "instance-2", decision: "granted",
  };
  const granted = await backend.decideSessionBoardWidgetGrant("main", key, grantSpec);
  assert.equal(granted.supported, true);
  assert.deepEqual(calls.at(-1), {
    method: "board.widget.grant",
    params: { sessionKey: key, agentId: "main", ...grantSpec },
  });

  const beforeOwnerMismatch = calls.length;
  for (const result of [
    await backend.getSessionBoard("main", "agent:other:main"),
    await backend.updateSessionBoard("main", "agent:other:main", ops),
    await backend.pinSessionBoardCanvas("main", "agent:other:main", pinSpec),
    await backend.decideSessionBoardWidgetGrant("main", "agent:other:main", grantSpec),
  ]) {
    assert.equal(result.supported, false);
    assert.equal(result.reason, "invalid-request");
  }
  assert.equal(calls.length, beforeOwnerMismatch,
    "session ownership must be checked before every Board RPC");

  const beforeInvalid = calls.length;
  assert.equal((await backend.updateSessionBoard("main", key, [])).reason, "invalid-request");
  assert.equal((await backend.pinSessionBoardCanvas("main", key, {
    name: "canvas", docId: "cv_1", html: "<script>secret</script>",
  })).reason, "invalid-request");
  assert.equal((await backend.decideSessionBoardWidgetGrant("main", key, {
    ...grantSpec, decision: "allow-once",
  })).reason, "invalid-request");
  assert.equal(calls.length, beforeInvalid, "invalid mutations must not reach the Gateway");

  let wrongSessionCalls = 0;
  backend.request = async () => {
    wrongSessionCalls += 1;
    return snapshot("agent:other:main");
  };
  for (const result of [
    await backend.getSessionBoard("main", key),
    await backend.updateSessionBoard("main", key, ops),
    await backend.pinSessionBoardCanvas("main", key, pinSpec),
    await backend.decideSessionBoardWidgetGrant("main", key, grantSpec),
  ]) {
    assert.equal(result.supported, false);
    assert.equal(result.reason, "invalid-response");
  }
  assert.equal(wrongSessionCalls, 4, "every Board RPC must reject a mismatched response session");

  backend._acceptGatewayHello(hello({ scopes: ["operator.read"] }));
  let callsWithReadOnlyScope = 0;
  backend.request = async () => {
    callsWithReadOnlyScope += 1;
    return snapshot(key);
  };
  const readOnly = await backend.getSessionBoard("main", key);
  assert.equal(readOnly.supported, true);
  assert.equal(readOnly.methods["board.update"], false);
  const unavailableUpdate = await backend.updateSessionBoard("main", key, ops);
  const unavailableGrant = await backend.decideSessionBoardWidgetGrant("main", key, grantSpec);
  assert.equal(unavailableUpdate.reason, "unsupported");
  assert.equal(unavailableGrant.reason, "unsupported");
  assert.equal(callsWithReadOnlyScope, 1, "only the allowed read RPC may run");

  backend._acceptGatewayHello(hello({
    scopes: ["operator.write"],
    capabilities: [],
  }));
  let callsWithoutCanvasCapability = 0;
  backend.request = async (method, params) => {
    callsWithoutCanvasCapability += 1;
    return snapshot(params.sessionKey);
  };
  const writeImpliesRead = await backend.getSessionBoard("main", key);
  assert.equal(writeImpliesRead.methods["board.get"], true);
  const missingCanvasCapability = await backend.pinSessionBoardCanvas("main", key, pinSpec);
  assert.equal(missingCanvasCapability.supported, false);
  assert.equal(missingCanvasCapability.methods["board.widget.put"], true);
  assert.equal(missingCanvasCapability.capabilities[CANVAS_DOCUMENT_CAPABILITY], false);
  assert.equal(callsWithoutCanvasCapability, 1, "only the prior allowed read RPC may run");

  backend._acceptGatewayHello(hello({ scopes: ["operator.admin"] }));
  backend.request = async () => { throw new Error("raw upstream secret"); };
  const failed = await backend.decideSessionBoardWidgetGrant("main", key, grantSpec);
  assert.equal(failed.supported, false);
  assert.equal(failed.reason, "error");
  assert.equal(failed.methods["board.widget.grant"], true);
  assert.equal(JSON.stringify(failed).includes("raw upstream secret"), false);

  backend._acceptGatewayHello(hello({ methods: ["board.get"], scopes: ["operator.admin"] }));
  let calledWithoutMethod = false;
  backend.request = async () => {
    calledWithoutMethod = true;
    return snapshot(key);
  };
  const unavailablePin = await backend.pinSessionBoardCanvas("main", key, pinSpec);
  assert.equal(unavailablePin.supported, false);
  assert.equal(unavailablePin.methods["board.widget.put"], false);
  assert.equal(unavailablePin.capabilities[CANVAS_DOCUMENT_CAPABILITY], false);
  assert.equal(calledWithoutMethod, false);

  console.log("openclaw session board: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
