import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// 读取源码文本；本仓库的前端回归脚本以稳定的实现契约防止交互链路回退。
function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const notifier = readSource("app/manage-ui/src/components/Notifier.tsx");
const cronPage = readSource("app/manage-ui/src/pages/CronPage.tsx");

// Cron 轮询发现新运行记录时，通知必须携带统一任务 ID，点击后才能识别目标任务。
assert.match(
  notifier,
  /category:\s*"cron",[\s\S]*?target:\s*j\.id/,
  "Cron 通知必须把 job.id 作为 target 传给桌面端",
);

// 点击事件需编码任务 ID 到 HashRouter 可解析的查询参数，特殊字符不能破坏路由。
assert.match(
  notifier,
  /window\.location\.hash\s*=\s*target\s*\?\s*`#\/cron\?job=\$\{encodeURIComponent\(target\)\}`\s*:\s*"#\/cron"/,
  "Cron 通知点击后必须跳转到携带编码 job 参数的详情深链",
);

// Cron 页面应读取深链参数，在列表加载后寻找并打开现有详情弹窗。
assert.match(cronPage, /useSearchParams\(\)/, "Cron 页面必须读取通知深链中的 job 参数");
assert.match(
  cronPage,
  /jobs\.find\(\(job\)\s*=>\s*job\.id\s*===\s*notificationJobId\)/,
  "Cron 页面必须按通知目标定位任务",
);
assert.match(cronPage, /void openView\(notificationJob\)/, "定位到任务后必须复用现有详情弹窗打开逻辑");

console.log("cron notification navigation regression: PASS");
