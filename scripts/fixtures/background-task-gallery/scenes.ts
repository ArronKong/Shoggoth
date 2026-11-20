import type {
  BackgroundTaskDetail, BackgroundTaskMessage, BackgroundTaskReportState, BackgroundTaskStatus,
  InteractiveFieldV1, InteractiveRequestV1,
} from "../../../app/manage-ui/src/types";

export const statusTitles = {
  starting: "准备本周的资料目录", queued: "核对三款方案的成员上限、文件容量和团队版使用限制", running: "整理三款方案的定价",
  waiting_approval: "将对比表写入任务目录", waiting_input: "确认价格的展示口径", stopping: "停止上一轮资料收集",
  completed: "整理三款方案的定价", failed: "读取已失效的报价来源", canceled: "核对旧版套餐",
  interrupted: "汇总第三方资料", needs_verification: "核对上一次运行的结果",
} satisfies Record<BackgroundTaskStatus, string>;

export const reportCases = {
  none: { title: "尚无报告", note: "分身正在执行。", status: "running" },
  pending: { title: "等待投递", note: "分身已结束，报告等待送达。", status: "completed" },
  delivered: { title: "投递成功", note: "报告和附件出现在原私聊。", status: "completed" },
  held: { title: "归档暂存", note: "原私聊已归档，保留本轮报告。", status: "completed" },
  withheld: { title: "停止后不投递", note: "用户主动停止，本轮不产生报告消息。", status: "canceled" },
} satisfies Record<BackgroundTaskReportState, { title: string; note: string; status: BackgroundTaskStatus }>;

export const stamp = new Date(2026, 10, 20, 10, 24).getTime();
export const fileName = "定价对比.csv";
export const csv = "方案,基础版（元/月）,专业版（元/月）\nA,10,30\nB,8,28\nC,12,35\n";
const fileId = "1".repeat(64);
export const fileUrl = `/__api/agents/preview/managed-files/${fileId}/content?backend=shoggoth`;
export const conclusion = "方案 B 最划算，基础版每月 8 元，专业版每月 28 元。";

const option = (label: string, description = "") => ({ value: label, label, description });
const field = (id: string, label: string, extra: Partial<InteractiveFieldV1> = {}): InteractiveFieldV1 =>
  ({ id, label, type: "text", description: "", required: true, secret: false, options: [], ...extra });
export const interactions = {
  command: "命令审批", edit: "文件变更审批", permission: "权限审批", mcp: "工具审批", scope: "选择授权范围", confirmation: "操作确认",
  choice: "选项与自填", text: "自由输入", form: "多字段输入", masked: "掩码输入",
};
export type PromptId = keyof typeof interactions;
export function requestFor(id: PromptId): InteractiveRequestV1 {
  const base: InteractiveRequestV1 = { version: 1, requestId: `req-${id}`, runId: "preview-run", kind: "runtime_approval",
    title: interactions[id], message: "", fields: [], approvalChoices: [], expiresAt: null };
  switch (id) {
    case "command": return { ...base, approvalChoices: ["once", "deny"], approvalDetails: {
      kind: "command", command: "wc -l pricing.csv", cwd: "/workspace/pricing" } };
    case "edit": return { ...base, approvalChoices: ["once", "session", "deny"], approvalDetails: {
      kind: "file_change", grantRoot: "/workspace/pricing", cwd: "/workspace/pricing" } };
    case "permission": return { ...base, approvalChoices: ["once", "deny"], approvalDetails: {
      kind: "permissions", permissions: JSON.stringify({ network: { enabled: true } }), networkHost: "example.com" } };
    case "mcp": return { ...base, kind: "mcp_permission", approvalChoices: ["once", "session", "deny"],
      message: "将本轮生成的定价对比表发布到 Agent 私有文件库。",
      approvalDetails: { serverName: "shoggoth", toolName: "artifact_publish",
        input: JSON.stringify({ relativePath: "pricing.csv", name: fileName }) } };
    case "scope": return { ...base, approvalChoices: ["once", "runtime:1", "runtime:2", "deny"],
      approvalDetails: { kind: "file_change", grantRoot: "/workspace/pricing" }, approvalOptions: [
        { choice: "once", label: "仅本次", kind: "allow_once" },
        { choice: "runtime:1", label: "允许修改本次报告", kind: "allow_always" },
        { choice: "runtime:2", label: "允许修改本轮表格", kind: "allow_always" },
        { choice: "deny", label: "拒绝", kind: "reject_once" },
      ] };
    case "confirmation": return { ...base, kind: "product_confirmation", message: "要将本轮结果附到任务记录吗？",
      fields: [field("confirm_product_action", "确认操作", { type: "choice", options: [option("确认"), option("取消")] })] };
    case "choice": return { ...base, kind: "user_input", message: "价格应该按哪种周期展示？",
      fields: [field("cycle", "计费周期", { type: "choice_or_text", options: [option("按月", "便于比较单月成本"), option("按年", "便于比较全年预算")] })] };
    case "text": return { ...base, kind: "user_input", message: "还需要比较哪一项使用限制？",
      fields: [field("limit", "补充说明")] };
    case "masked": return { ...base, kind: "user_input", message: "输入任意演示字符，预览掩码效果。",
      fields: [field("sample", "演示字符", { secret: true })] };
    case "form": return { ...base, kind: "user_input", message: "请选择导出格式，并按需添加备注。",
      fields: [field("format", "文件格式", { type: "choice", options: [option("CSV"), option("Markdown")] }),
        field("notes", "备注", { required: false })] };
  }
}

export const detailCases = [
  { group: "执行过程", items: [["running", "任务说明与进度"], ["queued", "名额不足排队"], ["followups", "补充要求排队"], ["empty", "暂无输出"]] },
  { group: "结果与续做", items: [["completed", "回复与文件"], ["plain", "纯文字回复"], ["continued", "第二次执行"], ["failed", "失败回报"]] },
  { group: "等待用户", items: [["waiting_approval", "等待审批"], ["waiting_input", "等待补充"]] },
  { group: "操作反馈", items: [["slow-send", "正在发送补充"], ["slow-stop", "正在请求停止"], ["slow-answer", "正在提交回答"]] },
  { group: "加载与异常", items: [["loading", "正在读取"], ["load-error", "读取失败"], ["not-found", "任务不存在"],
    ["wait-error", "等待响应时发送"], ["stop-error", "停止过程中发送"], ["approval-error", "审批失败后重试"]] },
] as const;

const stopped = new Set<BackgroundTaskStatus>(["completed", "failed", "interrupted", "canceled"]);
const sampleRuntimes: Record<string, string> = {
  followups: "opencode", plain: "deepseek-harness", continued: "antigravity", waiting_input: "pi", "prompt-choice": "pi",
};
export const turnMessage = (id: string, role: "user" | "assistant", text: string, minutes: number, activity = false): BackgroundTaskMessage =>
  ({ id, role, text, at: stamp + minutes * 60_000, runId: "preview-run", activity });

export function makeDetail(scene: string): BackgroundTaskDetail {
  const delivery = scene.startsWith("report-") ? scene.slice(7) as BackgroundTaskReportState : null;
  const prompt = scene.startsWith("prompt-") ? scene.slice(7) as PromptId : null;
  const req = prompt ? requestFor(prompt) : null;
  const status: BackgroundTaskStatus = delivery && Object.hasOwn(reportCases, delivery) ? reportCases[delivery].status
    : req ? req.fields.length ? "waiting_input" : "waiting_approval"
    : Object.hasOwn(statusTitles, scene) ? scene as BackgroundTaskStatus
    : scene === "plain" ? "completed" : scene === "empty" ? "starting" : scene === "stop-error" ? "stopping"
    : scene === "approval-error" ? "waiting_approval" : scene === "wait-error" || scene === "slow-answer" ? "waiting_input" : "running";
  const title = statusTitles[status];
  const report = delivery || (status === "canceled" ? "withheld" : stopped.has(status) ? "delivered" : "none");
  const request = req || (status === "waiting_approval" ? requestFor("edit") : status === "waiting_input" ? requestFor("choice") : null);
  const blank = scene === "empty" || status === "starting";
  const brief = "比较 A、B、C 三款方案的月度定价和使用限制，整理为一张表，完成后发回这个对话。";
  const messages = blank ? [] : [turnMessage("brief", "user", title === statusTitles.completed ? brief : title + "，并把结果发回原对话。", 0)];
  if (!blank && status !== "queued") messages.push(turnMessage("activity", "assistant", "已收集三份公开价目表，正在逐项核对计费周期。", 1, true));
  if (scene === "continued" || scene === "followups") messages.push(turnMessage("supplement", "user", "请在表里区分基础版和专业版。", 2));
  const withFile = status === "completed" && scene !== "plain" || scene === "continued";
  if (status === "completed" || scene === "continued") messages.push(turnMessage("reply", "assistant", conclusion, 3));
  if (scene === "continued") messages.push(turnMessage("next", "user", "再核对一次各家的年付折扣。", 4));
  if (status === "failed" || status === "interrupted") messages.push(turnMessage("error", "assistant",
    status === "failed" ? "报价来源暂时无法读取，本轮未生成对比文件。" : "连接中断，已保留本轮完成的资料。", 3));
  return { task: { taskId: scene, title, status, report, runtime: sampleRuntimes[scene] || "codex",
    generation: scene === "continued" ? 2 : 1, sourceRunId: "source-preview", errorCode: status === "failed" ? "RUNTIME_UNAVAILABLE" : null,
    createdAt: stamp, updatedAt: stamp + 180_000, startedAt: blank || status === "queued" ? null : stamp,
    finishedAt: stopped.has(status) ? stamp + 180_000 : null }, messages,
    files: withFile ? [{ fileId, name: fileName, generation: 1, url: fileUrl }] : [],
    interaction: request ? { runId: request.runId, type: request.fields.length ? "prompt" : "approval", payload: request } : null,
    queueReason: status === "queued" ? "运行名额已满" : null, queuedFollowUps: scene === "followups" ? 2 : 0 };
}
