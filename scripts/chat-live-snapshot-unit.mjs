#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
const requireUi = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const ts = requireUi("typescript");
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../app/manage-ui/src/lib/chatHistoryRuntime.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const copy = value => JSON.parse(JSON.stringify(value));
for (const backend of ["hermes", "openclaw", "shoggoth"]) {
  const key = `agent:${backend}-a:main`, other = `agent:${backend}-b:main`;
  let visible = [], running = false, canonical = [{ id: "user" }];
  const controller = exports.createChatHistoryController({
    backendOfSession: () => backend, agentOfSession: () => "a", getCached: async () => undefined,
    putCached: async () => {}, deleteCached: async () => {}, clearCachedExcept: async () => {},
    prepare: async (_, rows) => rows, requestCanonical: async k => k === key ? canonical : [{ id: "other" }],
    isInFlight: k => k === key && running, commitOpen: (_, rows) => { visible = copy(rows); },
    commitCanonical: (_, rows) => { visible = copy(rows); }, commitFailure: (_, error) => { throw error; },
  });
  await controller.open(key); await tick();
  running = true; controller.markSend(key, [{ id: "user" }, { id: "pending" }]);
  controller.updateLive(key, [{ id: "user" }, { id: "sealed-1" }, { id: "pending", text: "partial" }]);
  await controller.open(other);
  controller.updateLive(key, previous => [...previous.slice(0, -1), { id: "sealed-2" }, { id: "approval" }]);
  for (let repeat = 0; repeat < 3; repeat++) {
    await controller.open(key); await tick();
    assert.deepEqual(visible.map(row => row.id), ["user", "sealed-1", "sealed-2", "approval"], `${backend}: visible and background segments survive return`);
    await controller.open(other);
  }
  running = false; canonical = [{ id: "user" }, { id: "sealed-1" }, { id: "sealed-2" }, { id: "final" }];
  await controller.open(key); await tick();
  assert.deepEqual(visible, canonical, `${backend}: terminal canonical history replaces the live snapshot`);
  // Once canonical history retires a snapshot, an unrelated delayed observation
  // cannot recreate a send fence or resurrect deleted text.
  controller.updateLive(key, [{ id: "late" }]);
  canonical = [];
  await controller.open(key); await tick(); assert.deepEqual(visible, []);
  running = true; controller.markSend(key, [{ id: "new-user" }]);
  await controller.delete(key); controller.updateLive(key, [{ id: "deleted-resurrection" }]);
  canonical = [{ id: "fresh-source" }]; running = false;
  await controller.open(key); await tick(); assert.deepEqual(visible, canonical);
  // An external run without a local send still needs its first canonical user.
  running = true; controller.updateLive(other, [{ id: "foreign" }]);
  await controller.open(other); await tick(); assert.deepEqual(visible, [{ id: "other" }]);
}
console.log("PASS live snapshots: three backends, background segments, repeated switches, terminal history, deletion and foreign-run fences");
