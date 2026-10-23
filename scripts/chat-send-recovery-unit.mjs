#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";
const source = fs.readFileSync(new URL("../app/manage-ui/src/lib/chatSendRecovery.ts", import.meta.url), "utf8");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports });
const { createPendingChatSendStore, shouldTrackChatSend, classifyChatSendObservation, isExplicitChatSendRejection, isUncertainChatSendReceipt,
  PENDING_CHAT_SENDS_KEY } = module.exports;
const values = new Map(), storage = { getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value) };
const store = createPendingChatSendStore(() => storage, () => 10);
const key = "agent:openclaw-fixture:session", idem = "operation-original";
for (const backend of ["openclaw", "hermes"]) {
  assert.equal(shouldTrackChatSend(backend, [{ installationId: "plugin", revision: 1 }]), true);
  assert.equal(shouldTrackChatSend(backend, []), false);
}
assert.equal(shouldTrackChatSend("shoggoth", []), true);
values.set(PENDING_CHAT_SENDS_KEY, JSON.stringify([{ key, idem, at: 1 }]));
assert.equal(store.has(key), true, "update must retain pre-existing native v1 records");
assert.equal(store.remember(key, "new-operation"), false, "a new operation cannot replace an unresolved one");
assert.equal(store.remember(key, idem), true);
assert.equal(store.accepted(key, idem), true); assert.equal(store.read()[0].accepted, true);
store.forget(key, idem);
const selected = [{ installationId: "plugin", revision: 1, secret: "never-store" }];
assert.equal(store.remember(key, idem, selected), true);
selected[0].revision = 2;
assert.equal(store.read()[0].selection[0].revision, 1);
assert.equal(values.get(PENDING_CHAT_SENDS_KEY).includes("never-store"), false);
store.forget(key, idem);
assert.equal(store.remember(key, idem, [{ installationId: "plugin", revision: 1 }], "openclaw"), true);
assert.equal(store.read()[0].backendId, "openclaw");
assert.equal(store.remember(key, idem, [], "hermes"), false, "same key cannot change the original operation owner");
assert.equal(store.read()[0].backendId, "openclaw");
assert.equal(store.observeTerminal(key, "foreign-run", "openclaw"), false);
assert.equal(store.observeTerminal(key, idem, "hermes"), false);
assert.equal(store.read()[0].terminalObserved, undefined);
assert.equal(store.observeTerminal(key, idem, "openclaw"), true);
assert.equal(createPendingChatSendStore(() => storage).read()[0].terminalObserved, true, "matching terminal hint survives full reload without replay payload");
for (const status of ["running", "queued", "accepted", "starting", "waiting_input", "waiting_approval"]) {
  assert.equal(classifyChatSendObservation({ status: "found", admissionAccepted: true, run: { status } }, true, true).state, "verification");
}
for (const status of ["running", "queued", "accepted", "starting", "waiting_input", "waiting_approval"]) {
  assert.equal(classifyChatSendObservation({ status: "found", run: { status } }, true, true, false, true).state, "active",
    "a fresh native Service receipt supersedes a historical terminal hint");
}
for (const result of [{ status: "unresolved" }, { status: "found", run: { status: "needs_verification" } },
  { status: "found", run: { status: "unknown" } }]) {
  assert.equal(classifyChatSendObservation(result, true, true, false, true).state, "verification");
}
assert.equal(store.clearTerminalObservation(key, "foreign-run", "openclaw"), false);
assert.equal(store.clearTerminalObservation(key, idem, "hermes"), false);
assert.equal(store.read()[0].terminalObserved, true);
assert.equal(store.clearTerminalObservation(key, idem, "openclaw"), true);
assert.equal(createPendingChatSendStore(() => storage).read()[0].terminalObserved, undefined);
assert.equal(store.read()[0].idem, idem, "active recovery retains the original operation and send fence");
assert.equal(store.observeTerminal(key, idem, "openclaw"), true);
const unwritable = createPendingChatSendStore(() => ({ getItem: storage.getItem,
  setItem: () => { throw new Error("quota exceeded"); } }));
assert.equal(unwritable.clearTerminalObservation(key, idem, "openclaw"), false);
assert.equal(store.read()[0].terminalObserved, true, "failed durable write preserves the original terminal hint");
assert.equal(classifyChatSendObservation({ status: "found", admissionAccepted: true, run: { status: "completed" } }, true, true).state, "terminal");
for (const value of [{ status: "not_found" }, { status: "found", admissionAccepted: true, run: { status: "needs_verification" } },
  { status: "found", run: { status: "unexpected" } }]) assert.equal(classifyChatSendObservation(value).state, "verification");
assert.equal(classifyChatSendObservation({ status: "found", admissionAccepted: true, run: { status: "failed" } }).accepted, true);
assert.equal(classifyChatSendObservation({ status: "found", run: { status: "running" } }).state, "active");
assert.equal(classifyChatSendObservation({ status: "not_admitted", run: null }).state, "verification");
assert.equal(classifyChatSendObservation({ status: "not_admitted", run: null }, false, true, true).state, "terminal");
assert.equal(classifyChatSendObservation({ status: "not_admitted", run: null }, true, true, true).state, "verification");
assert.equal(classifyChatSendObservation({ status: "not_admitted", run: { status: "running" } }, false, false, true).state, "verification");
assert.equal(classifyChatSendObservation({ status: "found", run: { status: "completed" } }).state, "terminal");
assert.equal(isExplicitChatSendRejection({ code: "PLUGIN_SELECTION_NEEDS_VERIFICATION" }), false);
assert.equal(isExplicitChatSendRejection({ code: "PLUGIN_SELECTION_NEEDS_VERIFICATION", admissionAccepted: false }), false);
assert.equal(isExplicitChatSendRejection({ receiptUncertain: true, requestNotSent: true }), false);
assert.equal(isExplicitChatSendRejection(new Error("unknown")), false);
assert.equal(isUncertainChatSendReceipt({ code: "UPSTREAM_NEEDS_VERIFICATION", admissionAccepted: false }), true);
assert.equal(isExplicitChatSendRejection({ code: "UPSTREAM_NEEDS_VERIFICATION", admissionAccepted: false }), false);
assert.equal(isUncertainChatSendReceipt({ receiptUncertain: "true" }), false);
assert.equal(isUncertainChatSendReceipt({ code: "UPSTREAM_CHANGED", admissionAccepted: false }), false);
assert.equal(isExplicitChatSendRejection({ code: "UPSTREAM_CHANGED", admissionAccepted: false }), true);
assert.equal(isExplicitChatSendRejection({ code: "PLUGIN_SELECTION_UNAVAILABLE", receiptUncertain: true }), false);
assert.equal(isExplicitChatSendRejection({ code: "PLUGIN_SELECTION_UNAVAILABLE" }), true);
assert.equal(isExplicitChatSendRejection({ requestNotSent: true }), true);
values.set(PENDING_CHAT_SENDS_KEY, "broken-json");
assert.equal(store.remember(key, idem), false); assert.equal(values.get(PENDING_CHAT_SENDS_KEY), "broken-json");
values.set(PENDING_CHAT_SENDS_KEY, JSON.stringify(Array.from({ length: 256 }, (_, index) => ({ key: `key-${index}`, idem: `op-${index}`, at: 1 }))));
assert.equal(store.remember(key, idem), false);
console.log(JSON.stringify({ outcome: "PASS", checks: 12, ordinaryDispatchedUncertaintyNotRetryable: true, terminalObservationSurvivesReload: true, terminalReceiptLagRetained: true, originalBackendPinned: true, legacyRecordsRetained: true, newOperationOverwrite: false,
  replayPayloadStored: false, unresolvedNeverRetryable: true, ordinaryExternalUnchanged: true }));
