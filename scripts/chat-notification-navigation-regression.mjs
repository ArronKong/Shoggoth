import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// 读取生产源码，锁定桌面通知到聊天会话的完整跳转契约。
function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const notifier = readSource("app/manage-ui/src/components/Notifier.tsx");
const chatPage = readSource("app/manage-ui/src/pages/ChatPage.tsx");

// 通知点击必须保留目标 sessionKey，并同时覆盖首次进入和聊天页已挂载两种情况。
assert.match(
  notifier,
  /sessionStorage\.setItem\(PENDING_CHAT_KEY,\s*target\)[\s\S]*?window\.location\.hash\s*=\s*"#\/chat"[\s\S]*?openclaw:open-chat-session/,
  "聊天通知点击必须保存目标 sessionKey、进入聊天页并派发页内定位事件",
);

// 未出现在 sessions.list 的通知目标也必须先补成可解析的行；否则 active 为 null，
// 即使 chat.history 成功返回，页面仍会表现为没有定位到对应会话。
const helperStart = chatPage.indexOf("const ensureSessionRow = useCallback");
const helperEnd = chatPage.indexOf("\n  const archiveLoadingRef", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "ChatPage 必须提供 session 行补全逻辑");
const ensureSessionRowSource = chatPage.slice(helperStart, helperEnd);
const syntheticSetIndex = ensureSessionRowSource.indexOf("syntheticRowsRef.current.set(key, row)");
const stateSetIndex = ensureSessionRowSource.indexOf("setSessions");
assert.ok(syntheticSetIndex >= 0, "补全逻辑必须把通知目标登记为持久合成行");
assert.ok(
  syntheticSetIndex < stateSetIndex,
  "合成行必须在 setSessions 前同步登记，避免缓存已有目标时提前返回或被实时列表竞态覆盖",
);
assert.match(
  chatPage,
  /if \(pending\) \{[\s\S]*?ensureSessionRow\(pending\)[\s\S]*?openSession\(pending\)/,
  "首次从通知进入聊天页时，必须先补 session 行再打开目标会话",
);
assert.match(
  chatPage,
  /typeof key === "string" && key[\s\S]*?ensureSessionRow\(key\)[\s\S]*?openSession\(key\)/,
  "聊天页已挂载时点击通知，也必须先补 session 行再打开目标会话",
);
assert.match(
  chatPage,
  /const named = applyChatSessionAgentNames\(\s*mergeSynthetic\(merged,\s*authoritative\s*\?\s*all\s*:\s*undefined\),[\s\S]*?setSessions\(named\);\s*writeSessionCache\(named\)/,
  "实时 sessions.list 刷新后必须保留尚未被服务端列表收录的通知目标",
);

console.log("chat notification navigation regression: PASS");
