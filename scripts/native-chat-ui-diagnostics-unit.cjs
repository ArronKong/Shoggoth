#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const { test } = require("node:test");
const { createChatUiDiagnostics, diagnosticMetadata } = require("../app/agent-service/chat-ui-diagnostics");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
test("operational diagnostics allow metadata only and never expose an error message or untrusted code", () => {
  const records = [], secret = "PRIVATE_DIAGNOSTIC_SENTINEL_98317"; // gitleaks:allow -- Synthetic test-only marker
  const d = createChatUiDiagnostics({ sink: record => records.push(record), intervalMs: 0 });
  d.emit("publication.publish", { code: secret, artifactId: secret, htmlBytes: 4096, durationMs: 12,
    html: `<html>${secret}</html>`, state: { password: secret }, prompt: secret, errorMessage: secret, sourceFile: `/private/${secret}` });
  const text = JSON.stringify(records);
  assert.equal(records.length, 1); assert.equal(records[0].code, "UNKNOWN");
  assert.match(records[0].artifactIdHash, /^[a-f0-9]{32}$/u); assert.equal(records[0].htmlBytes, 4096);
  assert.equal(text.includes(secret), false); assert.equal(text.includes("password"), false); assert.equal(text.includes("sourceFile"), false);
  assert.equal(d.emit(secret, { code: "OK" }), null);
  const failed = { status: "unknown", errorCode: "UI_COMMIT_UNCERTAIN", operationId: "server-generated-operation" };
  assert.equal(d.measure("service.action", value => diagnosticMetadata({}, value), () => failed), failed);
  assert.equal(records.at(-1).code, "UI_COMMIT_UNCERTAIN"); assert.equal(records.at(-1).status, "unknown");
});
test("observation is bounded, throttled and cannot replace synchronous or asynchronous results", async () => {
  let at = 1000; const records = [];
  const d = createChatUiDiagnostics({ now: () => at, sink: record => records.push(record), intervalMs: 5000 });
  for (let i = 0; i < 500; i++) d.emit("service.read", { code: "OK", leaseId: `lease-${i}`, requestBytes: 90 });
  assert.equal(records.length, 1); assert.equal(d.snapshot().length, 128);
  at += 5000; d.emit("service.read", { code: "OK" }); assert.equal(records.length, 2); assert.equal(records[1].suppressed, 499);
  const original = { stateRevision: 1 }, failure = Object.assign(Error("private error text"), { code: "UI_STATE_CONFLICT" });
  const broken = createChatUiDiagnostics({ sink() { throw Error("observer failed"); }, clock() { throw Error("clock failed"); } });
  assert.equal(broken.measure("service.state.save", {}, () => original), original);
  assert.equal(await broken.measure("service.state.save", {}, async () => original), original);
  assert.throws(() => broken.measure("service.state.save", {}, () => { throw failure; }), error => error === failure);
  await assert.rejects(broken.measure("service.state.save", {}, async () => { throw failure; }), error => error === failure);
  const snapshot = d.snapshot(); snapshot[0].code = "modified"; assert.notEqual(d.snapshot()[0].code, "modified");
});
test("actual Service logs publication, confirmed state and CAS failure without HTML, form or prompt values", async () => {
  const records = [], f = await fixture({ chatUiDiagnosticSink: record => records.push(record) });
  const html = "private-ui-markup-73914", selection = "private-ui-selection-82736", title = "private-ui-title-61835";
  try {
    const args = declaration(); args.title = title; args.stateSchema.properties.selected.enum.push(selection);
    fs.writeFileSync(f.workspace + "/card.html", `<!doctype html><h1>${html}</h1>`);
    const part = (await f.call("render_ui", args)).part;
    const opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "diagnostics-native-mount" });
    await f.ipc("chat.ui.read", { ...f.owner, leaseId: opened.leaseId, offset: 0 });
    const saved = await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: selection } });
    assert.equal(saved.state.selected, selection);
    await assert.rejects(f.ipc("chat.ui.state.save", { ...f.owner, leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: "B" } }), { code: "UI_STATE_CONFLICT" });
    assert.equal((await f.call("get_ui_state", { artifactId: part.artifactId, revision: 1 })).state.selected, selection);
    for (const stage of ["publication.prepare", "publication.publish", "service.open", "service.read", "service.state.save", "publication.state.read"]) assert(records.some(record => record.stage === stage), stage);
    assert(records.some(record => record.stage === "service.state.save" && record.code === "UI_STATE_CONFLICT"));
    assert(records.every(record => Number.isFinite(record.durationMs) && record.durationMs >= 0));
    assert(records.some(record => record.htmlBytes > 0));
    const text = JSON.stringify(records);
    for (const value of [html, selection, title, part.artifactId, f.owner.sessionKey]) assert.equal(text.includes(value), false, value);
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0); assert.equal(f.service.productStore.listWorkRuns().length, 1);
  } finally { await f.remove(); }
});
test("a failing production observation sink cannot turn a committed publication or state save into failure", async () => {
  const f = await fixture({ chatUiDiagnosticSink() { throw Error("sink unavailable"); } });
  try {
    const part = (await f.call("render_ui", declaration())).part;
    const opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "throwing-diagnostics-mount" });
    const saved = await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: "B" } });
    assert.equal(saved.state.selected, "B"); assert.equal((await f.call("get_ui_state", { artifactId: part.artifactId, revision: 1 })).state.selected, "B");
    const session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    assert.equal(f.service.transcriptStore.listEvents(f.owner.profileId, session.id).filter(event => event.kind === "artifact").length, 1);
    assert.equal(f.service.chatUiStore.operationsForRecovery().length, 0);
  } finally { await f.remove(); }
});
