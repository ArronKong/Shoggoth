import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const mod = { exports: {} };
const file = path.join(root, "app/manage-ui/src/lib/sessionKind.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, { exports: mod.exports });
const { sessionCategoryOf, isBackgroundSession } = mod.exports;
const uuid = "8b997cf2-6b82-4f14-a221-111111111111";
const cases = [
  [{ key: "agent:main:main" }, "app"],
  [{ key: `agent:main:dashboard:${uuid}` }, "app"],
  [{ key: `agent:native:${uuid}`, kind: "direct" }, "app"],
  [{ key: "agent:hermes-horse:20260919_123456_abcdef", kind: "direct" }, "app"],
  [{ key: `agent:native:${uuid}`, kind: "cron" }, "task"],
  [{ key: "agent:main:cron:job:run:id" }, "task"],
  [{ key: "agent:main:subagent:workboard-default-card-123" }, "task"],
  [{ key: "agent:horse:work:kanban:task:t_f526e222" }, "task"],
  [{ key: `agent:horse:${uuid}`, source: "kanban", kind: "direct" }, "task"],
  [{ key: `agent:horse:${uuid}`, title: "work kanban task t_f526e222" }, "task"],
  [{ key: `agent:native:${uuid}`, kind: "direct", inspirationId: "idea-1" }, "inspiration"],
  [{ key: "agent:main:dashboard:inspiration-abcdef" }, "inspiration"],
  [{ key: `agent:horse:${uuid}`, kind: "direct", sub: "这是用户当前委派的灵感任务。原文中的..." }, "inspiration"],
  [{ key: `agent:horse:${uuid}`, kind: "direct", sub: "The user has captured the following idea and entrusted you with moving it forward. It may include text..." }, "inspiration"],
  [{ key: "agent:main:telegram:group:@heartbeat" }, "channel"],
  [{ key: `agent:horse:${uuid}`, kind: "direct", source: "telegram" }, "channel"],
  [{ key: "agent:main:subagent:research" }, "subagent"],
  [{ key: "agent:main:dream:reflection" }, "dream"],
  [{ key: "agent:main:main:heartbeat" }, "system"],
  [{ key: "agent:main:explicit:model-run-test" }, "system"],
  [{ key: "agent:main:unrecognized" }, "other"],
  [{ key: `agent:horse:${uuid}`, kind: "direct", title: "讨论 kanban 任务和灵感便签", sub: "请介绍 inspiration task" }, "app"],
];
for (const [row, category] of cases) assert.equal(sessionCategoryOf(row), category, JSON.stringify(row));

// 菜单分类不改变后台会话的未读/代表会话语义。
assert.equal(isBackgroundSession("agent:main:subagent:workboard-default-card-123"), true);
assert.equal(isBackgroundSession(`agent:native:${uuid}`, "cron"), true);
assert.equal(isBackgroundSession(`agent:native:${uuid}`, "direct"), false);
assert.equal(isBackgroundSession("agent:main:telegram:group:@heartbeat"), false);
console.log(`chat session category unit: PASS (${cases.length} cases)`);
