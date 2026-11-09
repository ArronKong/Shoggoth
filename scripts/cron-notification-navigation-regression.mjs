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
  /kind:\s*"cron",\s*jobId:\s*j\.id,\s*backendId:\s*j\.backendId/,
  "Cron 通知必须携带任务 ID 和后端身份",
);

// 点击事件需编码任务 ID 到 HashRouter 可解析的查询参数，特殊字符不能破坏路由。
assert.match(
  notifier,
  /#\/cron\?job=\$\{encodeURIComponent\(jobId\)\}/,
  "Cron 通知点击后必须跳转到携带编码 job 参数的任务深链",
);

// Cron 页面读取深链参数，任务匹配行为由 cron-save-lifecycle-ui-unit 覆盖。
assert.match(cronPage, /useSearchParams\(\)/, "Cron 页面必须读取通知深链中的 job 参数");
assert.match(cronPage, /searchParams\.get\("job"\)/);
assert.match(cronPage, /searchParams\.get\("backend"\)/);

console.log("cron notification navigation regression: PASS");
