import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cronPage = fs.readFileSync(
  path.join(root, "app/manage-ui/src/pages/CronPage.tsx"),
  "utf8",
);

const openDeliveryBody = cronPage.match(
  /const openJobFromCalendar = async \(job: UnifiedCronJob, occurrenceMs\?: number\) => \{([\s\S]*?)\n  \};/,
)?.[1] || "";

assert.ok(openDeliveryBody, "必须找到 Cron 日历产出详情打开流程");

const deliveryRequestIndex = openDeliveryBody.indexOf(
  "await getCronLatestDelivery(job.id, occurrenceMs)",
);
const publishModalIndex = openDeliveryBody.indexOf("setDeliveryJob(job)");

assert.ok(deliveryRequestIndex >= 0, "必须加载对应 occurrence 的最终产出");
assert.ok(publishModalIndex >= 0, "完整数据 ready 后必须发布弹窗 payload");
assert.ok(deliveryRequestIndex < publishModalIndex, "必须先完成 delivery，再打开 Modal");
assert.doesNotMatch(
  openDeliveryBody.slice(0, deliveryRequestIndex),
  /setDeliveryJob\(job\)/,
  "delivery 请求完成前不得先打开只有 loading 的小弹窗",
);
// 运行结果弹窗不显示「助理实时动态」，打开时也不再请求运行轨迹。
assert.doesNotMatch(openDeliveryBody, /getCronRunTrajectory/);
assert.match(
  openDeliveryBody,
  /if \(seq !== deliveryReqRef\.current\) return;[\s\S]*?setDelivery\(latest\);\s*setDeliveryJob\(job\);/,
  "只有最新请求可以一次提交正文和打开状态",
);
assert.match(
  cronPage,
  /open=\{!!deliveryJob && !!delivery\}/,
  "Modal 必须同时具备 job 与 delivery 才能挂载",
);
assert.doesNotMatch(
  cronPage,
  /deliveryLoading\s*\?\s*\(/,
  "产出 Modal 不应再渲染会造成高度突变的一行 loading 内容",
);

console.log("cron delivery modal regression: PASS");
