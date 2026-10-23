#!/usr/bin/env node
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const bundle = buildSync({
  entryPoints: [new URL("../app/manage-ui/src/lib/chatPlan.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "cjs", write: false,
}).outputFiles[0].text;
const module = { exports: {} };
vm.runInNewContext(bundle, { module, exports: module.exports });
const { latestChatPlan, chatMessagesWithoutPlans, withoutPlanSteps } = module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const plan = [{ content: "Inspect", status: "completed" }, { content: "Verify", status: "in_progress" }];
const user = { id: "u", role: "user", parts: [{ type: "text", text: "Start" }] };
const snapshot = { id: "p", role: "assistant", parts: [{ type: "plan", planEntries: plan }] };
const answer = { id: "a", role: "assistant", parts: [{ type: "text", text: "Answer" }] };
const history = [user, snapshot, answer];
const before = JSON.stringify(history);
assert.deepEqual(plain(latestChatPlan(history)), plan);
assert.deepEqual(plain(latestChatPlan([...history, { ...snapshot, parts: [{ type: "plan", planEntries: [] }] }])), []);
assert.deepEqual(plain(latestChatPlan([...history, { ...user, id: "next" }])), [], "new input must not inherit a historical plan");
assert.deepEqual(plain(latestChatPlan([...history, { role: "system", divider: {}, parts: [] }])), [], "reset boundary retires the old plan");
assert.deepEqual(plain(chatMessagesWithoutPlans(history)), [user, answer], "plan-only history must not leave an empty bubble/footer");
assert.equal(JSON.stringify(history), before, "UI projection must not alter canonical history");
assert.equal(chatMessagesWithoutPlans(history)[1], answer, "unrelated answer identity stays stable");
const mixed = { ...answer, parts: [...snapshot.parts, ...answer.parts], images: ["image"], files: [{ name: "report.pdf" }] };
assert.deepEqual(plain(chatMessagesWithoutPlans([mixed])), [{ ...mixed, parts: answer.parts }]);
const tool = { id: "tool", kind: "tool", toolName: "read_file", status: "ok" };
const timeline = { ...snapshot, parts: [{ type: "timeline", steps: [
  tool, { kind: "plan", planEntries: plan }, { kind: "thinking", text: "Working" },
] }] };
assert.deepEqual(plain(latestChatPlan([user, timeline, answer])), plan);
assert.deepEqual(plain(chatMessagesWithoutPlans([timeline]))[0].parts[0].steps, [tool, { kind: "thinking", text: "Working" }]);
assert.deepEqual(plain(withoutPlanSteps([{ kind: "plan" }, tool])), [tool], "live/stiched timelines retain tools, not plan cards");
assert.deepEqual(plain(chatMessagesWithoutPlans([{ ...snapshot, ephemeral: "progressCard" }, answer])), [answer]);
assert.deepEqual(plain(latestChatPlan([user, { ...snapshot, ephemeral: "progressCard" }])), [], "old UI-only cache rows are not authoritative plans");
const completed = plan.map((entry) => ({ ...entry, status: "completed" }));
assert.deepEqual(plain(latestChatPlan([user, { ...snapshot, parts: [{ type: "plan", planEntries: completed }] }, answer])), completed);
assert.equal(chatMessagesWithoutPlans([{ ...snapshot, pending: true }]).length, 1, "a real in-flight response retains its waiting placeholder");
console.log("chat-plan-dock-unit: PASS (history, turn boundaries, empty clears, timeline projection, immutable identities)");
