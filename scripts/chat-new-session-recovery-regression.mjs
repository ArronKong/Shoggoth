#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";

const policyPath = new URL("../app/manage-ui/src/lib/slashCommands.ts", import.meta.url);
const pagePath = new URL("../app/manage-ui/src/pages/ChatPage.tsx", import.meta.url);
const proxyPath = new URL("../app/core/proxy-gateway.js", import.meta.url);
const backendPath = new URL("../app/core/shoggoth-backend.js", import.meta.url);
const policySource = readFileSync(policyPath, "utf8");
const pageSource = readFileSync(pagePath, "utf8");
const proxySource = readFileSync(proxyPath, "utf8");
const backendSource = readFileSync(backendPath, "utf8");

const compiled = ts.transpileModule(policySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });

const {
  canRunSlashDuringTurn,
  mergeSlashCommands,
  nativeLocalSlashCommands,
  recoverySlashCommandsForBackend,
  shouldHandleSlashLocally,
} = module.exports;

assert.equal(typeof canRunSlashDuringTurn, "function", "必须导出 slash 执行中放行策略");
assert.equal(typeof shouldHandleSlashLocally, "function", "必须导出 slash 本地/服务端路由策略");
assert.equal(typeof nativeLocalSlashCommands, "function", "必须导出原生 Agent 本地命令目录");

assert.equal(canRunSlashDuringTurn("new"), true, "/new 必须能从卡住或失败中的旧轮次逃生");
assert.equal(canRunSlashDuringTurn("stop"), true, "既有 /stop 执行中放行语义必须保留");
assert.equal(canRunSlashDuringTurn("model"), false, "普通设置命令仍应等待当前轮次结束");

assert.equal(shouldHandleSlashLocally("hermes-bull", "new"), true, "Hermes /new 必须绕过旧会话 slash worker");
assert.equal(shouldHandleSlashLocally("hermes-bull", "model"), true, "Hermes 既有共享本地命令必须保留");
assert.equal(shouldHandleSlashLocally("hermes-bull", "help"), false, "Hermes 官方服务端命令仍走 slash.exec");
assert.equal(shouldHandleSlashLocally("main", "new"), true, "OpenClaw /new 继续走既有本地 sessions.create");
assert.equal(shouldHandleSlashLocally("shoggoth-codex", "help", true), true,
  "原生 Agent 的共享帮助命令必须留在 UI");
assert.equal(shouldHandleSlashLocally("shoggoth-codex", "compact", true), false,
  "原生 Runtime 命令必须交给服务端执行面");
assert.equal(
  JSON.stringify(recoverySlashCommandsForBackend(false).map((command) => command.name)),
  JSON.stringify(["new"]),
  "Shoggoth slash=false 时只保留本地 /new 恢复入口",
);
const nativeNew = recoverySlashCommandsForBackend(false)[0];
assert.equal(nativeNew.args, "[workspace]", "/new 必须提示可覆盖会话工作区");
assert.equal(nativeNew.instant, undefined, "/new 需要允许先输入工作区参数");
assert.equal(recoverySlashCommandsForBackend(true).length, 0,
  "slash worker 可用时不需要额外恢复命令池");
assert.equal(
  JSON.stringify(nativeLocalSlashCommands().map((command) => command.name)),
  JSON.stringify(["stop", "new", "clear", "model", "models", "status", "usage", "help", "commands"]),
  "原生 Agent 菜单只公开共享 UI/RPC 已真正实现的命令",
);
assert.deepEqual(
  Array.from(mergeSlashCommands(nativeLocalSlashCommands(), [{
    name: "compact", description: "native", category: "session", icon: "terminal",
  }]), (command) => command.name),
  [...Array.from(nativeLocalSlashCommands(), (command) => command.name), "compact"],
  "原生 Agent 菜单必须合并共享命令与 Runtime 专属命令",
);

assert.match(
  pageSource,
  /shouldHandleSlashLocally\(agentOf\(key\),\s*localName,\s*nativeAgent\)/,
  "ChatPage dispatchSlash 必须使用统一的本地路由策略",
);
assert.match(
  pageSource,
  /canRunSlashDuringTurn\(parsedSlash\.command\.name\)/,
  "ChatPage in-flight 门禁必须使用统一的执行中放行策略",
);
assert.match(
  pageSource,
  /parseSlashInput\(text,\s*\[\.\.\.visibleSlashPool,\s*\.\.\.recoverySlashPool\]\)/,
  "ChatPage 必须在解析阶段合入 Shoggoth 的本地 /new，而不是打开后端 slash",
);
assert.match(
  pageSource,
  /nativeAgent\) return mergeNativeSlashCommands\(server \|\| \[\]\)/,
  "原生 Agent 必须合并共享本地命令与会话级 Runtime 命令目录",
);
assert.match(
  pageSource,
  /hasServerSlashSurface[\s\S]{0,1800}await execServerSlash\(key, text\)/,
  "原生 Agent 在 capability 首次返回前也不能把未知 slash 当普通 prompt 发送",
);
assert.match(
  pageSource,
  /const slashCatalogSessionUpdatedAt =[\s\S]{0,1800}\[activeKey, slashCatalogSessionUpdatedAt, chatCaps, capsEpoch, slashCatalogStore\][\s\S]{0,300}value\.startsWith\("\/"\)[\s\S]{0,100}updateSlashMenu\(value\)/,
  "Runtime 命令目录返回或重试后必须即时刷新已打开的 slash 菜单",
);
assert.doesNotMatch(
  pageSource,
  /Runtime command catalogs[\s\S]{0,1800}\[activeKey, active\?\.updatedAt/,
  "Runtime 命令目录 effect 不得在 active 初始化前读取它并导致首帧白屏",
);
assert.match(
  pageSource,
  /case "new":[\s\S]{0,3000}send\("sessions\.create"/,
  "/new 必须通过 sessions.create 创建独立会话",
);
assert.doesNotMatch(
  pageSource,
  /case "new":[\s\S]{0,1800}requestPrompt\(/,
  "裸 /new 不得弹出工作区输入框",
);
assert.match(
  pageSource,
  /case "new":[\s\S]{0,3000}send\("sessions\.create",\s*\{[\s\S]{0,500}parentSessionKey:\s*key/,
  "/new 必须把当前会话作为继承来源",
);
assert.match(
  pageSource,
  /case "new":[\s\S]{0,1800}surfaces\.agentHarness === true[\s\S]{0,3000}nativeSession && workspace[\s\S]{0,100}\{ workspace \}/,
  "显式 /new [workspace] 仍必须覆盖原生 Agent 的工作区",
);
assert.match(
  proxySource,
  /createBackend\.createSession\(targetAgentId,\s*\{[\s\S]{0,500}parentSessionKey:\s*frame\.params\?\.parentSessionKey/,
  "代理必须把 parentSessionKey 传给原生后端",
);
assert.match(
  backendSource,
  /async createSession\(agentId, options = \{\}\)[\s\S]{0,500}workspace === undefined[\s\S]{0,300}_sessionTarget\(options\.parentSessionKey\)[\s\S]{0,300}parent\.session\.workspace/,
  "Shoggoth 后端必须在裸 /new 时继承父会话工作区",
);
assert.match(
  pageSource,
  /ensureSessionRow\(newKey,\s*Date\.now\(\),\s*\{[\s\S]{0,500}model:\s*active\?\.model[\s\S]{0,500}\}\);[\s\S]{0,120}openSession\(newKey\)/,
  "/new 必须先登记带模型元数据的 canonical synthetic row，再打开会话",
);
assert.match(
  pageSource,
  /function inheritedModelChoice\([\s\S]{0,500}candidates\.length === 1 \? candidates\[0\] : undefined/,
  "provider 缺失时只有唯一目录候选才允许推断",
);
assert.doesNotMatch(
  pageSource,
  /backendId === ["']hermes["'][\s\S]{0,300}(?:sessions\.create|creationHints)/,
  "ChatPage 的 /new 模型 hints 不得特判 Hermes",
);

console.log("chat-new-session-recovery-regression: native slash recovery passed");
