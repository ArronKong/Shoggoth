import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatPage = fs.readFileSync(path.join(__dirname, "..", "app/manage-ui/src/pages/ChatPage.tsx"), "utf8");

// 自动恢复只面向刚重置后消息很少的会话；超过门槛仍沿用用户主动上滑加载。
assert.match(
  chatPage,
  /const AUTO_ARCHIVE_MESSAGE_LIMIT = 5;/,
  "聊天页必须定义短尾会话的自动归档加载门槛",
);

// 仅在 idle 状态自动尝试一次：网络失败会进入 error，保留上滑手动重试，不能无限请求。
assert.match(
  chatPage,
  /if \(!historyLoaded \|\| messages\.length >= AUTO_ARCHIVE_MESSAGE_LIMIT \|\| archive\.status !== "idle"\) return;\s*maybeLoadArchive\(\);/,
  "短尾会话自动加载必须只在归档 idle 时触发",
);

console.log("chat archive autoload regression: PASS");
