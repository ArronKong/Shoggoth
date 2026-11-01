"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CHANNELS, registerDesktopSecretIpc } = require("../app/desktop-secret-ipc");
const { localMediaPermission } = require("../app/local-media-permission");

function fixture() {
  const handlers = new Map(), calls = [], boxes = [];
  let window = { webContents: { mainFrame: {} } }, answer = async () => ({ response: 0 });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const row = { id: "a".repeat(64), recipient: "OpenAI", expiresAt: Date.now() + 90000 };
  const registry = { async chatSecretRequest(action, value) {
    calls.push({ action, value });
    if (action === "disclosures") return { items: [row] };
    assert.equal(action, "decide"); return { decided: true };
  } };
  let speech = async () => ({ authorized: false, onDevice: false, status: "not-determined" });
  const dispose = registerDesktopSecretIpc({
    ipcMain: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key) },
    getMainWindow: () => window, getRegistry: () => registry,
    dialog: { showMessageBox: async (owner, options) => { assert.equal(owner, window); boxes.push(options); return answer(); } },
    localSpeech: value => speech(value),
  });
  return { handlers, calls, boxes, row, event, dispose,
    decision: choice => handlers.get(CHANNELS.chatDecision)(event, { choice, sessionKey: "agent:a:one", disclosureId: row.id }),
    answer: value => { answer = value; }, speech: value => { speech = value; },
    replaceWindow: () => { window = { webContents: { mainFrame: {} } }; },
  };
}

test("only the live desktop main frame can request original content or speech permission", async () => {
  const f = fixture(); let speechCalls = 0; f.speech(async () => { speechCalls++; });
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: f.event.sender, senderFrame: {} }]) {
    const request = { choice: "original", sessionKey: "agent:a:one", disclosureId: f.row.id };
    assert.equal((await f.handlers.get(CHANNELS.chatDecision)(event, request)).error.code, "PRIVILEGED_RENDERER_REQUIRED");
    assert.equal((await f.handlers.get(CHANNELS.speechRequest)(event)).error.code, "PRIVILEGED_RENDERER_REQUIRED");
  }
  assert.equal(speechCalls, 0); assert.equal(f.boxes.length, 0); assert.equal(f.calls.length, 0); f.dispose();
});

test("retired original, retry and cancel decisions have no effect and never open a dialog", async () => {
  const f = fixture();
  for (const choice of ["original", "retry", "cancel"]) {
    assert.equal((await f.decision(choice)).error.code, "SECRET_DISCLOSURE_EXPIRED");
  }
  f.row.expiresAt = Date.now() - 1; f.row.recipient = "Unknown";
  assert.equal((await f.decision("original")).error.code, "SECRET_DISCLOSURE_EXPIRED");
  assert.equal(f.boxes.length, 0); assert.equal(f.calls.length, 0); f.dispose();
});
for (const retirement of ["window", "ipc"]) test("retired " + retirement + " rejects stale decision requests", async () => {
  const f = fixture(), handler = f.handlers.get(CHANNELS.chatDecision);
  if (retirement === "window") f.replaceWindow(); else f.dispose();
  assert.equal((await handler(f.event, { choice: "original", sessionKey: "agent:a:one", disclosureId: f.row.id })).error.code,
    "PRIVILEGED_RENDERER_REQUIRED");
  assert.equal(f.boxes.length, 0); assert.equal(f.calls.length, 0); f.dispose();
});

test("speech status does not request permission and repeated user requests share the active prompt", async () => {
  const f = fixture(); let release; const requests = [];
  f.speech(request => { requests.push(request); return request ? new Promise(resolve => { release = resolve; })
    : { authorized: false, onDevice: false, status: "denied" }; });
  assert.equal((await f.handlers.get(CHANNELS.speechStatus)(f.event)).value.status, "denied");
  const a = f.handlers.get(CHANNELS.speechRequest)(f.event), b = f.handlers.get(CHANNELS.speechRequest)(f.event);
  await new Promise(resolve => setImmediate(resolve));
  release({ authorized: true, onDevice: true, status: "authorized", private: "must not cross" });
  assert.deepEqual((await a).value, { authorized: true, onDevice: true, status: "authorized" });
  assert.equal((await b).value.authorized, true); assert.deepEqual(requests, [false, true]); f.dispose();
});

test("permission helper receives no media, account configuration or inherited credentials", async () => {
  for (const request of [false, true]) {
    const spawn = (binary, args, options) => {
      assert.equal(binary, "/synthetic/media"); assert.deepEqual(args, []);
      assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "PATH"]);
      const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      let input = ""; child.stdin.on("data", chunk => { input += chunk; });
      child.stdin.on("finish", () => {
        assert.deepEqual(JSON.parse(input), { action: request ? "requestSpeechPermission" : "capabilities" });
        child.stdout.write(JSON.stringify({ version: 1, speechAuthorized: false, speechOnDevice: true, speechStatus: "denied" }));
        child.emit("close", 0);
      });
      return child;
    };
    assert.deepEqual(await localMediaPermission("/synthetic/media", request, spawn), { authorized: false, onDevice: true, status: "denied" });
  }
});
