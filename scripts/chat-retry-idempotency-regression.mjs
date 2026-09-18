// R342 回归：失败后重发必须换新 idempotencyKey，否则整次重试在界面上「什么都没发生」。
//
// 事故复盘（2026-07-28 vincent DM）：一轮失败后用户在 15s 内重发同一句 →
// ChatPage 的双发去重分支判成「双触发」，复用上一次的 idempotencyKey；网关把
// chat.send 的结果（含失败）按 key 缓存 5 分钟，直接回放旧错误（日志 `cached=true`，
// 2ms 返回），不起新 run；而该分支在画气泡之前就 return、错误又被 catch 吞掉 →
// 界面对每次回车零反应。真凶不是去重本身，是「回合已终结后还认去重」。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("../app/manage-ui/node_modules/typescript/lib/typescript.js");

const chatPage = fs.readFileSync(
  path.join(process.cwd(), "app/manage-ui/src/pages/ChatPage.tsx"),
  "utf8",
);

function has(needle, message) {
  assert.ok(chatPage.includes(needle), message);
}

// 1) 回合终结（markInFlight off）必须丢掉该会话的去重记录 —— 修复的本体。
const sourceFile = ts.createSourceFile("ChatPage.tsx", chatPage, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let markInFlightNode = null;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "markInFlight") {
    markInFlightNode = node;
    return;
  }
  ts.forEachChild(node, visit);
};
visit(sourceFile);
assert.ok(markInFlightNode?.initializer, "必须能从 TypeScript AST 找到 markInFlight initializer");
const markInFlight = markInFlightNode.initializer.getText(sourceFile);
const clearsTerminalDedup = (source) =>
  /else\s*\{[\s\S]*inFlightRef\.current\.delete\(key\)[\s\S]*recentSendRef\.current\.delete\(key\)[\s\S]*\}/.test(source);
assert.ok(
  clearsTerminalDedup(markInFlight),
  "markInFlight 的 off 分支必须同时清掉 recentSendRef（否则失败后重试复用旧 key，网关回放缓存的失败）",
);
const withoutDedupClear = markInFlight.replace("recentSendRef.current.delete(key);", "");
assert.notEqual(withoutDedupClear, markInFlight, "mutation 自检必须实际删除 recentSendRef 清理行");
assert.equal(clearsTerminalDedup(withoutDedupClear), false, "回归必须能捕获 recentSendRef 清理行被删除");

// recentSendRef 必须声明在 markInFlight 之前（同一个组件体里的引用顺序）。
assert.ok(
  chatPage.indexOf("const recentSendRef =") < chatPage.indexOf("const markInFlight = useCallback("),
  "recentSendRef 需先于 markInFlight 声明",
);

// 2) 去重本体还在：双触发（一次 Enter 两条 submit / 重连后重发）仍要复用同一个 key。
has("if (recent && recent.text === text && nowTs - recent.at < DUP_SEND_WINDOW_MS)", "双发去重分支不得被删除");
has("idempotencyKey: recent.idem", "双触发仍需复用原 idempotencyKey 让网关折叠");

// 3) 重连清 in-flight 必须继续绕开 markInFlight（直接清 inFlightRef），
//    否则第 1 条会把重连后的折叠保护一起清掉 —— 那正是去重存在的理由。
const onReconnect = chatPage.slice(chatPage.indexOf("if (isReconnect) {"), chatPage.indexOf("if (isReconnect) {") + 700);
has("inFlightRef.current.clear()", "重连仍需直接清 inFlightRef");
assert.equal(
  onReconnect.includes("markInFlight("),
  false,
  "重连分支不得改走 markInFlight —— 那会连带清掉 recentSendRef，重连后的重发又会造出两条相同用户消息",
);

console.log("chat retry idempotency regression: PASS");
