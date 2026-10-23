#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const ts = createRequire(path.join(root, "app/manage-ui/package.json"))("typescript");
const source = fs.readFileSync(path.join(root, "app/manage-ui/src/lib/openclawExecApprovals.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
let now = 1_000;
const timers = new Map();
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, TextEncoder,
  Date: class extends Date { static now() { return now; } },
  setTimeout: (callback, delay) => { const id = Symbol(); timers.set(id, { callback, at: now + delay }); return id; },
  clearTimeout: id => timers.delete(id),
});
const { normalizeExecApproval, supportsExecApprovals, createExecApprovalController } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const contract = { auth: { scopes: ["operator.approvals"] }, features: {
  methods: ["exec.approval.list", "exec.approval.resolve"],
  events: ["exec.approval.requested", "exec.approval.resolved"],
} };
const row = (id = "approval-a", sessionKey = "agent:main:main", extra = {}) => ({
  id, createdAtMs: 900, expiresAtMs: 30_000,
  request: { sessionKey, runId: "run-a", command: "python3 -c 'print(1)'",
    warningText: "Exec auto-review deferred to human approval: Request timed out.",
    allowedDecisions: ["allow-once", "deny"], ...extra },
});
const published = new Map();
const calls = [];
const requests = [];
const controller = createExecApprovalController({
  changed: (key, entries) => published.set(key, entries),
  request: (method, params) => {
    calls.push({ method, params: plain(params) });
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  },
});
const entries = key => published.get(key ?? "agent:main:main") ?? [];
const reply = payload => requests.shift().resolve({ payload });
const rejects = async promise => assert.rejects(promise);

assert.equal(supportsExecApprovals(contract), true);
assert.equal(supportsExecApprovals({ ...contract, auth: { scopes: ["operator.admin"] } }), false);
assert.equal(supportsExecApprovals({ ...contract, features: { ...contract.features, events: [] } }), false);
assert.equal(normalizeExecApproval(row("no-owner", "")), null);
assert.equal(normalizeExecApproval({ ...row(), expiresAtMs: now }), null);
assert.equal(normalizeExecApproval({ ...row(), status: "allowed" }), null);
assert.deepEqual(plain(normalizeExecApproval(row()).approvalChoices), ["once", "deny"]);
assert.deepEqual(plain(normalizeExecApproval(row("large", undefined, { command: "x".repeat(16385) })).approvalChoices), ["deny"]);
assert.deepEqual(plain(normalizeExecApproval(row("preview", undefined, { command: null, commandPreview: "safe" })).approvalChoices), ["deny"]);
assert.deepEqual(plain(normalizeExecApproval(row("unknown", undefined, { allowedDecisions: ["allow-session", "deny"] })).approvalChoices), ["deny"]);
assert.deepEqual(plain(normalizeExecApproval(row("permanent", undefined, { allowedDecisions: ["allow-always", "deny"] })).approvalChoices), ["runtime:0", "deny"]);

await controller.refresh();
assert.equal(calls.length, 0);
controller.connect(contract);
let recovery = controller.refresh();
reply([row()]); await recovery;
assert.equal(entries()[0].requestId, "approval-a", "cold entry recovers a pending approval");
assert.match(entries()[0].message, /Request timed out/);
controller.event("exec.approval.requested", row("other", "agent:other:main"));
assert.equal(entries("agent:other:main")[0].requestId, "other");
assert.equal(entries().length, 1, "owner sessions stay separate");

recovery = controller.refresh();
controller.event("exec.approval.resolved", { id: "approval-a" });
controller.event("exec.approval.requested", row("new"));
reply([row()]); await recovery;
assert.deepEqual(plain(entries().map(entry => entry.requestId)), ["new"], "racing snapshot cannot revive resolved or lose requested");
assert.equal(entries("agent:other:main").length, 0, "authoritative omission clears old cards");

recovery = controller.refresh();
const later = controller.refresh();
requests[1].resolve({ payload: [row("latest")] }); requests.splice(1, 1); await later;
reply([row("stale")]); await recovery;
assert.equal(entries()[0].requestId, "latest", "out of order snapshots cannot overwrite newer state");
recovery = controller.refresh(); requests.shift().reject(new Error("offline")); await recovery;
assert.equal(entries()[0].requestId, "latest", "failed list preserves pending state");
recovery = controller.refresh(); reply({ invalid: true }); await recovery;
assert.equal(entries()[0].requestId, "latest", "malformed list is not an empty list");

const entry = entries()[0];
const before = calls.length;
await rejects(controller.respond(entry, "session"));
assert.equal(calls.length, before, "unknown grants never reach the gateway");
let response = controller.respond(entry, "once");
assert.deepEqual(calls.at(-1), { method: "exec.approval.resolve", params: { id: "latest", decision: "allow-once" } });
requests.shift().reject(new Error("transport failed")); await rejects(response);
assert.equal(entries()[0], entry, "failed answer remains retryable");
response = controller.respond(entry, "deny"); reply({ ok: false }); await rejects(response);
assert.equal(entries()[0], entry, "missing acknowledgement preserves the request");
response = controller.respond(entry, "once"); reply({ ok: true }); await response;
assert.equal(entries().length, 0);

controller.event("exec.approval.requested", { ...row("expires"), expiresAtMs: now + 50 });
recovery = controller.refresh();
now += 51;
for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
reply([{ ...row("expires"), expiresAtMs: now - 1 }]); await recovery;
assert.equal(entries().length, 0, "expiry removes the card even without a resolved event");

recovery = controller.refresh();
controller.connect(null);
reply([row("old-connection")]); await recovery;
assert.equal(entries().length, 0, "old connection snapshot is discarded");
controller.event("exec.approval.requested", row("no-scope"));
assert.equal(entries().length, 0);
controller.connect(contract);
controller.event("exec.approval.requested", row("same-id"));
response = controller.respond(entries()[0], "once");
controller.connect(contract);
controller.event("exec.approval.requested", row("same-id"));
reply({ ok: true }); await response;
assert.equal(entries()[0].requestId, "same-id", "old acknowledgement cannot clear a new connection card");
recovery = controller.refresh(); reply([]); await recovery;
assert.equal(entries().length, 0);
controller.event("exec.approval.requested", row("permanent", undefined, { allowedDecisions: ["allow-always", "deny"] }));
response = controller.respond(entries()[0], "runtime:0");
assert.equal(calls.at(-1).params.decision, "allow-always", "permanent permission is never relabeled as a session grant");
reply({ ok: true }); await response;
controller.dispose();
assert.equal(timers.size, 0);
assert.equal(calls.some(call => call.method === "chat.send" || call.method === "chat.respond"), false);
console.log("PASS: OpenClaw exec approval contract, recovery, races, ownership, expiry, and response lifecycle");
