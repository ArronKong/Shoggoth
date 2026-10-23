import i18n from "../../i18n";

const zh = {
  subtitle: "任务运行详情",
  task: "助理任务",
  started: "开始时间",
  elapsed: "已运行",
  duration: "总耗时",
  live: "实时更新中",
  paused: "等待恢复更新",
  finished: "运行已结束",
  loading: "正在读取任务动态…",
  empty: "助理正在准备任务，有新的进展会显示在这里。",
  emptyFinished: "本次运行没有留下可显示的助理动态。",
  stale: "动态更新暂时中断，已保留当前内容。正在自动重试。",
  retry: "重新加载",
  status: { queued: "排队中", starting: "准备中", running: "执行中", waiting_approval: "等待审批",
    waiting_input: "等待补充信息", completed: "已完成", failed: "执行失败", canceled: "已取消",
    interrupted: "已中断", skipped: "已跳过", unknown: "状态待确认" },
};
const en = {
  subtitle: "Task run details",
  task: "Assistant task",
  started: "Started",
  elapsed: "Elapsed",
  duration: "Duration",
  live: "Updating live",
  paused: "Waiting to reconnect",
  finished: "Run ended",
  loading: "Loading task activity…",
  empty: "The assistant is preparing this task. New activity will appear here.",
  emptyFinished: "No assistant activity was recorded for this run.",
  stale: "Updates are temporarily unavailable. Keeping the current activity and retrying automatically.",
  retry: "Reload",
  status: { queued: "Queued", starting: "Preparing", running: "Running", waiting_approval: "Awaiting approval",
    waiting_input: "Awaiting your input", completed: "Completed", failed: "Failed", canceled: "Canceled",
    interrupted: "Interrupted", skipped: "Skipped", unknown: "Status unconfirmed" },
} satisfies typeof zh;
i18n.addResourceBundle("zh-CN", "translation", { dashboardRun: zh }, true, true);
i18n.addResourceBundle("en", "translation", { dashboardRun: en }, true, true);
