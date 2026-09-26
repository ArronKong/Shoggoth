"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const PARAMS = { agentId: "main", sessionKey: "agent:main:dashboard:example",
  idempotencyKey: "run-1", message: "test" };

function fixture() {
  const sent = [];
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {} };
  const backend = new OpenClawBackend({ authResolver: {} });
  backend._ws = socket;
  function receive(payload, options = {}) {
    const frame = { type: "res", id: options.id || sent.at(-1).id, ok: true, payload };
    const from = options.socket || socket;
    backend._observeFinalResponse(frame, from);
    const pending = backend._pending.get(frame.id);
    if (pending?.socket === from) {
      backend._pending.delete(frame.id);
      pending.resolve(payload);
    }
  }
  return { backend, socket, sent, receive };
}

const accepted = () => ({ runId: PARAMS.idempotencyKey, sessionKey: PARAMS.sessionKey,
  agentId: PARAMS.agentId, status: "accepted" });
const final = () => ({ runId: PARAMS.idempotencyKey, status: "ok",
  result: { payloads: [{ text: "answer" }] } });

test("agent acceptance resolves immediately while its second exact RPC response remains observable", async t => {
  const { backend, receive } = fixture();
  t.after(() => backend.stop());
  const observed = [];
  const response = backend.requestWithFinalObservation("agent", PARAMS, { onFinal: value => observed.push(value) });
  receive(accepted());
  assert.equal((await response).status, "accepted");
  assert.equal(backend._pending.size, 0);
  assert.equal(backend._finalObservers.size, 1);
  receive(final());
  assert.equal(observed.length, 1);
  assert.equal(observed[0].payload.result.payloads[0].text, "answer");
  assert.equal(backend._finalObservers.size, 0);
  receive(final());
  assert.equal(observed.length, 1);
});

test("observer rejects wrong request, socket, run, session, or Agent identities", async t => {
  for (const mismatch of ["request", "socket", "run", "session", "agent"]) {
    const { backend, receive } = fixture();
    t.after(() => backend.stop());
    const observed = [], closed = [];
    const response = backend.requestWithFinalObservation("agent", PARAMS,
      { onFinal: value => observed.push(value), onClose: () => closed.push(true) });
    receive(accepted());
    await response;
    const payload = final(), options = {};
    if (mismatch === "request") options.id = "another-request";
    if (mismatch === "socket") options.socket = {};
    if (mismatch === "run") payload.runId = "another-run";
    if (mismatch === "session") payload.sessionKey = "another-session";
    if (mismatch === "agent") payload.agentId = "another-agent";
    receive(payload, options);
    assert.equal(observed.length, 0);
    if (["request", "socket"].includes(mismatch)) {
      assert.equal(closed.length, 0);
      receive(final());
      assert.equal(observed.length, 1);
    } else {
      assert.equal(closed.length, 1);
      assert.equal(backend._finalObservers.size, 0);
    }
  }
});

test("an acceptance timeout retains only its bounded observer so late output can reconcile", async t => {
  const { backend, receive } = fixture();
  t.after(() => backend.stop());
  const observed = [];
  const response = backend.requestWithFinalObservation("agent", PARAMS, { onFinal: value => observed.push(value) }, 5);
  await assert.rejects(response, /timeout/u);
  assert.equal(backend._pending.size, 0);
  assert.equal(backend._finalObservers.size, 1);
  receive(final());
  assert.equal(observed.length, 1);
  assert.equal(backend._finalObservers.size, 0);
});

test("old socket close does not flush new socket observations; stop and abort release callbacks", async t => {
  const { backend, socket, receive } = fixture();
  t.after(() => backend.stop());
  const controller = new AbortController();
  let closed = 0;
  const response = backend.requestWithFinalObservation("agent", PARAMS,
    { signal: controller.signal, onFinal() {}, onClose() { closed++; } });
  receive(accepted());
  await response;
  backend._flushPending(new Error("old socket closed"), {});
  assert.equal(backend._finalObservers.size, 1);
  controller.abort();
  assert.equal(closed, 1);
  assert.equal(backend._finalObservers.size, 0);
  const next = backend.requestWithFinalObservation("agent", PARAMS,
    { onFinal() {}, onClose() { closed++; } });
  receive(accepted(), { socket });
  await next;
  await backend.stop();
  assert.equal(closed, 2);
  assert.equal(backend._finalObservers.size, 0);
});

test("ordinary RPC behavior stays one-response and observer exceptions stay isolated", async t => {
  const { backend, receive } = fixture();
  t.after(() => backend.stop());
  const plain = backend.request("tasks.list", {});
  receive({ tasks: [] });
  assert.deepEqual(await plain, { tasks: [] });
  assert.equal(backend._finalObservers.size, 0);
  const observed = backend.requestWithFinalObservation("agent", PARAMS, { onFinal() { throw new Error("observer failure"); } });
  receive(accepted());
  await observed;
  assert.doesNotThrow(() => receive(final()));
  assert.equal(backend._finalObservers.size, 0);
});
