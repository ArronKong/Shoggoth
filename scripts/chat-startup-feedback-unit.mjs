import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const ts = createRequire(new URL("../app/manage-ui/package.json", import.meta.url))("typescript");
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../app/manage-ui/src/lib/chatRunWait.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const { updateChatRunWait: update, chatRunWaitState: fromStatus, withStartupWait, CHAT_WAIT_REASONS } = exports;
for (const [reason, label] of Object.entries({ GLOBAL_CAPACITY: "global", STARTUP_BACKPRESSURE: "startup",
  HOST_CAPACITY: "host", RUNTIME_HOST_CAPACITY: "host", SERVICE_QUIESCED: "service",
  PROFILE_WORKSPACE_WRITE_LIMIT: "agentWorkspace" })) {
  assert.equal(fromStatus({ statusKind: "queued", reason }, 200).reason, reason, `${reason} survives projection`);
  assert.equal(CHAT_WAIT_REASONS[reason], label, `${reason} has a specific explanation`);
}
for (const stage of ["context", "compacting", "capabilities"]) {
  assert.equal(fromStatus({ statusKind: "starting", stage }).stage, stage, "pre-admission work has its own startup stage");
}
let state = fromStatus({ statusKind: "starting", stage: "preparing" }, 1000);
for (const stage of ["connecting", "reconnecting", "compacting", "restoring", "waiting"]) {
  state = update(state, { state: "status", statusKind: stage === "waiting" ? "running" : "starting", stage }, false, 5000);
  assert.equal(state.stage, stage);
  assert.equal(state.since, 1000, "phase changes retain the original startup timestamp");
}
assert.equal(update(state, { state: "accepted" }, false), state);
assert.equal(update(state, { state: "delta" }, false), state, "empty runtime chunks are not visible progress");
assert.equal(update(state, { state: "delta" }, true), undefined);
assert.equal(update(undefined, { state: "status", statusKind: "running", stage: "waiting" }, true), undefined, "late lifecycle events cannot revive startup after output");
for (const terminal of ["final", "error", "aborted", "prompt"]) assert.equal(update(state, { state: terminal }), undefined);
for (const statusKind of ["idle", "needs_verification", "reconnecting", "waiting_approval", "waiting_input"])
  assert.equal(update(state, { state: "status", statusKind }), undefined);
assert.equal(fromStatus({ statusKind: "running" }), null, "legacy status without startup evidence remains unchanged");
assert.equal(fromStatus({ statusKind: "starting", stage: "private details" }).stage, "connecting");
assert.equal(fromStatus({ statusKind: "queued", reason: "__proto__", queuedAt: -4 }, 200).since, 200);
const queued = fromStatus({ statusKind: "queued", reason: "CHAT_SESSION_BUSY", queuedAt: 150 }, 200);
assert.equal(queued.kind, "queued");assert.equal(queued.since, 150);
assert.equal(update(queued, { state: "accepted" }), queued, "a receipt does not end actual queuing");
assert.equal(update(state, { state: "status", statusKind: "retrying" }, true).kind, "retrying", "real retries still appear after output");
const steps = [];
const projected = withStartupWait(steps, state);
assert.equal(steps.length, 0, "startup display must not mutate the saved activity list");
assert.equal(projected.length, 1);
assert.equal(projected[0].startupWait, state);
const nextStage = { ...state, stage: "restoring" };
assert.equal(withStartupWait(steps, nextStage)[0].id, projected[0].id, "a phase update must keep its row identity");
assert.equal(withStartupWait(steps), steps, "real output removes the transient row");
assert.equal(withStartupWait(steps, queued), steps, "queue feedback keeps its existing presentation");
console.log("PASS startup feedback: phases, elapsed clock, empty events, first content, terminal, queue, retry and unknown fields");
