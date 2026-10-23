import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const uiRoot = path.resolve(import.meta.dirname, "../app/manage-ui");
const require = createRequire(path.join(uiRoot, "package.json"));
const ts = require("typescript");
function load(file, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(uiRoot, "src", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!name.startsWith(".")) return require(name);
    const relative = path.join(path.dirname(file), name);
    return relative.endsWith(".json") ? require(path.join(uiRoot, "src", relative))
      : load(`${relative}.ts`, globals);
  }, ...globals });
  return exports;
}

const visibility = load("lib/cronVisibility.ts");
const job = (id, fields = {}) => ({
  id, name: id, backendId: "openclaw", enabled: true,
  schedule: { kind: "every", everyMs: 1800000 }, ...fields,
});
const hidden = [
  job("desktop-cron", { origin: "codex-desktop", backendId: "shoggoth", payload: { kind: "agentTurn" } }),
  job("desktop-followup", { origin: "codex-desktop", backendId: "shoggoth", enabled: false, codex: { kind: "heartbeat" } }),
  job("heartbeat-vincent", { payload: { kind: "heartbeat" } }),
  job("renamed-system-task", { payload: { kind: "heartbeat" }, enabled: false, lastStatus: "error" }),
  job("tag-only", { backendDetails: { capabilityTags: ["heartbeat"] } }),
  job("legacy-tag-only", { rawCapabilities: ["heartbeat"] }),
];
const visible = [
  job("daily-report", { payload: { kind: "agentTurn", message: "Report" }, wakeMode: "next-heartbeat" }),
  job("heartbeat-metrics", { payload: { kind: "agentTurn", message: "Report heartbeat health" } }),
  job("heartbeat-name-only"),
  job("skill-review", { payload: { kind: "skillCollectionReview" }, actions: { reason: "system-managed" } }),
  job("hermes-report", { backendId: "hermes" }),
  job("native-report", { backendId: "shoggoth" }),
  job("Codex Desktop", { backendId: "shoggoth", agentId: "shoggoth-codex", payload: { kind: "agentTurn" } }),
  job("explicit-user-task", { payload: { kind: "systemEvent", text: "Reminder" }, rawCapabilities: ["heartbeat"] }),
];
const allJobs = [...hidden, ...visible];
const original = JSON.stringify(allJobs);
const calls = [];
let responseJobs = allJobs;
const api = load("api/client.ts", {
  URLSearchParams,
  fetch: async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    return new Response(JSON.stringify({ jobs: responseJobs, job: hidden[0] }));
  },
});

const result = await api.listCronJobs();
assert.deepEqual(Array.from(result, row => row.id), visible.map(row => row.id),
  "all cron list consumers hide system heartbeats while retaining user and other managed jobs");
assert.equal(JSON.stringify(allJobs), original, "visibility must not mutate scheduler records");
responseJobs = hidden;
assert.equal((await api.listCronJobs({ query: "heartbeat", agentIds: ["vincent"] })).length, 0,
  "search and assistant filters cannot make heartbeats visible again");
assert.match(calls[1].url, /query=heartbeat&agentIds=vincent/);
responseJobs = undefined;
assert.equal((await api.listCronJobs()).length, 0, "missing job lists remain empty");
assert.equal((await api.getCronJobDetail(hidden[0].id)).id, hidden[0].id,
  "the display filter does not remove access to the underlying job");
assert.ok(calls.every(call => call.method === "GET"), "hiding heartbeats performs no scheduler mutation");
console.log("PASS Cron visibility: Codex Desktop and system heartbeats hidden; native Codex jobs, user tasks and backend records preserved");
