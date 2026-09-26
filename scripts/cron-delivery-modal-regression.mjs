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
const trajectoryRequestIndex = openDeliveryBody.indexOf(
  "await getCronRunTrajectory(job.id, latest.sessionKey, latest.runId)",
);
const publishModalIndex = openDeliveryBody.indexOf("setDeliveryJob(job)");

assert.ok(deliveryRequestIndex >= 0, "必须加载对应 occurrence 的最终产出");
assert.ok(trajectoryRequestIndex >= 0, "有 sessionKey 时必须在打开前等待 trajectory");
assert.ok(publishModalIndex >= 0, "完整数据 ready 后必须发布弹窗 payload");
assert.ok(
  deliveryRequestIndex < trajectoryRequestIndex && trajectoryRequestIndex < publishModalIndex,
  "必须依次完成 delivery、trajectory，再打开 Modal",
);
assert.doesNotMatch(
  openDeliveryBody.slice(0, deliveryRequestIndex),
  /setDeliveryJob\(job\)/,
  "delivery 请求完成前不得先打开只有 loading 的小弹窗",
);
assert.match(
  openDeliveryBody,
  /if \(seq !== deliveryReqRef\.current\) return;[\s\S]*?setDelivery\(latest\);\s*setTrajectory\(nextTrajectory\);\s*setDeliveryJob\(job\);/,
  "只有最新请求可以一次提交正文、trajectory 和打开状态",
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
