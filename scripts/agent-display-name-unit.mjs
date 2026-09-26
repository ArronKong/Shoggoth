#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const ts = createRequire(path.join(root, "app/manage-ui/package.json"))("typescript");
const helperPath = path.join(root, "app/manage-ui/src/lib/agentDisplay.ts");
const helperSource = fs.readFileSync(helperPath, "utf8");
const helperJavaScript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: helperPath,
}).outputText;
const helperModule = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${helperJavaScript}\n})(module, module.exports);`, {
  module: helperModule,
  exports: helperModule.exports,
});

const { createAgentNameIndex, findAgentDisplayName, resolveAgentDisplayName } = helperModule.exports;

const oldIndex = createAgentNameIndex([{ id: "ada", name: "Ada", backendId: "openclaw" }]);
const renamedIndex = createAgentNameIndex([{ id: "ada", name: "Product Manager", backendId: "openclaw" }]);
assert.equal(resolveAgentDisplayName(oldIndex, "ada", "openclaw"), "Ada");
assert.equal(resolveAgentDisplayName(renamedIndex, "ada", "openclaw", "Ada"), "Product Manager",
  "当前 Agent 名称必须覆盖统计记录中的旧快照名称");
assert.equal(resolveAgentDisplayName(renamedIndex, "ada", "hermes", "Ada"), "Ada",
  "不同 backend 的相同 agentId 不能串名");
assert.equal(resolveAgentDisplayName({}, "ada", "openclaw", "Ada"), "Ada",
  "名称请求失败时保留调用方已有展示名");
assert.equal(resolveAgentDisplayName({}, "ada", "openclaw"), "ada",
  "没有当前名称或旧展示名时安全回退 agentId");

const chatIndex = createAgentNameIndex([{ id: "ada", identity: { name: "Product Manager" } }]);
assert.equal(findAgentDisplayName(chatIndex, "ada"), "Product Manager",
  "Chat agents.list 的 identity.name 必须可作为当前名称");

const chatPage = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/ChatPage.tsx"), "utf8");
const dashboardPage = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/DashboardPage.tsx"), "utf8");
const activityFeed = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/dashboard/ActivityFeed.tsx"), "utf8");
const usagePage = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/UsagePage.tsx"), "utf8");
assert.match(chatPage, /send\("agents\.list",\s*\{\}\)/,
  "Chat 刷新会话时必须同时读取当前 Agent roster");
assert.match(chatPage, /const named = applyChatSessionAgentNames\([\s\S]{0,250}agentNamesRef\.current/,
  "Chat 必须统一覆盖服务端行和新会话临时行的旧名称");
assert.match(chatPage, /setSessions\(named\);\s*writeSessionCache\(named\)/,
  "状态与缓存必须写入同一份已补全名称的会话列表");
assert.match(dashboardPage, /listAgents\(backendId\)/,
  "Dashboard 必须读取各后端当前 Agent 名称");
assert.match(activityFeed, /getAgentDisplayName\(e\.agentId,\s*e\.backendId\)/,
  "Dashboard 活动流不得直接展示 agentId");
assert.match(usagePage, /resolveAgentDisplayName\(agentNames,\s*source\.id/,
  "Token 排行必须以当前 Agent 名称覆盖历史 label");

console.log("agent display name unit: PASS");
