import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatApprovalCard from "../../app/manage-ui/src/pages/ChatApprovalCard";
import ChatPromptCard from "../../app/manage-ui/src/pages/ChatPromptCard";
import ApprovalRow from "../../app/manage-ui/src/pages/dashboard/ApprovalRow";
import type { InteractiveRequestV1 } from "../../app/manage-ui/src/types";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import inspiration from "../../app/manage-ui/src/pages/InspirationRunBar.module.css";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPromptCard.css";

// Option order and labels as the ACP server 1.2.1 sends them, mapped by the host.
const approvalOptions = [
  { choice: "runtime:0", label: "Allow Always (risky) — Allowing always can be risky", kind: "allow_always" as const },
  { choice: "once", label: "Allow", kind: "allow_once" as const },
  { choice: "deny", label: "Deny", kind: "reject_once" as const },
];
// Captured from a native ACP question on 2026-10-23. Both answers are allow_once.
const taskOptions = [
  { choice: "once", kind: "allow_once" as const, label: "(Recommended) macOS 系统原生后台服务 (Launchd 脚本，最稳定轻量，直接复用你当前 Chrome 已登录账号打卡，加载后自动关闭，无需保持 Shoggoth 开启)" },
  { choice: "runtime:1", kind: "allow_once" as const, label: "Shoggoth 应用内 Cron 任务 (在 Shoggoth 中创建 Cron 任务，到点唤醒 Agent 执行)" },
];
const question = new URLSearchParams(location.search).has("question");
const query = new URLSearchParams(location.search);
const surface = query.get("surface");
const options = question ? taskOptions : approvalOptions;
if (surface === "dashboard") window.fetch = async (input, init) => {
  if (String(input) !== "/__api/dashboard/prompts/respond?backend=fixture") throw new Error("Unexpected fixture request");
  const response = JSON.parse(String(init?.body));
  window.dispatchEvent(new CustomEvent("fixture-response", { detail: response }));
  return new Response(JSON.stringify({ runId: response.runId, status: "running" }), { headers: { "Content-Type": "application/json" } });
};

function Preview() {
  const [choice, setChoice] = useState("");
  const [response, setResponse] = useState("");
  useEffect(() => {
    const receive = (event: Event) => setResponse(JSON.stringify((event as CustomEvent).detail));
    window.addEventListener("fixture-response", receive);
    return () => window.removeEventListener("fixture-response", receive);
  }, []);
  const compact = Boolean(surface);
  const wrap = (content: React.ReactElement<{ entry: InteractiveRequestV1 }>) => surface === "dashboard"
    ? <ApprovalRow agentName="Agent" canRespond onResponded={() => {}}
      item={{ id: content.props.entry.requestId, backendId: "fixture", agentId: "fixture", source: "chat",
        kind: content.props.entry.fields.length ? "input" : "approval", runId: content.props.entry.runId,
        requestId: content.props.entry.requestId, allowedDecisions: content.props.entry.approvalChoices,
        interactiveRequest: content.props.entry }} />
    : surface === "inspiration" ? <div style={{ position: "relative", height: 430, "--note-paper": "#fff9eb", "--note-ink": "#242424" } as React.CSSProperties}>
      <div className={inspiration.root} data-expanded="true" data-tone="attention" data-input="true">
        <div className={inspiration.header}>Agent · 等待回复</div><div className={inspiration.expansion}>{content}</div>
      </div></div> : content;
  return <main style={{ width: query.has("narrow") ? "min(340px, calc(100% - 32px))" : "min(680px, calc(100% - 48px))", margin: "36px auto", color: "var(--ui-text-1)" }}>
    <h2 style={{ fontSize: 22, marginBottom: 12 }}>交互卡片 · 选择与补充</h2>
    <p style={{ fontSize: 13, color: "var(--ui-text-2)", marginBottom: 28 }}>隔离界面预览 · 所有操作仅模拟响应</p>
    {wrap(<ChatApprovalCard compact={compact} submitting={false} onChoose={setChoice} entry={{
      id: "native-preview", version: 1, requestId: "native-request", runId: "native-run", kind: "runtime_approval",
      title: "需要授权", message: question ? "" : "File access\n\nRead: /Users/demo/Downloads/测试图片.png\nReason: outside workspace\n\nAllow access to this file?",
      fields: [], expiresAt: null, approvalChoices: [...new Set([...options.map((option) => option.choice), "deny"])], approvalOptions: options,
      approvalDetails: question ? { kind: "command", toolName: "你希望采用哪种方式实现该定时任务？" }
        : { kind: "command", toolName: "view_file", input: JSON.stringify({ AbsolutePath: "/Users/demo/Downloads/测试图片.png" }) },
    }} />)}
    <p role="status" style={{ marginTop: 20, fontSize: 13 }}>{choice ? `模拟响应：${options.find((option) => option.choice === choice)?.label || "拒绝"} (${choice})` : "等待选择"}</p>
    <div style={{ height: 20 }} />
    {wrap(<ChatPromptCard compactInput={compact} entry={{
      id: "input-preview", version: 1, requestId: "input-request", runId: "input-run", kind: "user_input",
      title: "需要补充信息", message: "请补充任务的执行方式和要求。", approvalChoices: [], expiresAt: null,
      fields: [
        { id: "schedule", type: "choice", label: "执行频率", description: "选择适合这项任务的执行频率。", required: true, secret: false,
          options: [{ value: "daily", label: "每天执行", description: "每天在指定时间运行一次，适合日常检查与整理。" },
            { value: "weekdays", label: "仅工作日", description: "周一至周五运行，周末暂停。" }] },
        { id: "instructions", type: "text", label: "补充要求", description: "可以补充时间、处理范围或完成标准。", required: false, secret: false, options: [] },
      ],
    }} onRespond={(_entry, data) => setResponse(JSON.stringify(data))} />)}
    <p role="status" style={{ marginTop: 20, fontSize: 13, overflowWrap: "anywhere" }}>{response || "等待补充"}</p>
  </main>;
}

await applyConfiguredLocale(query.get("locale") || "zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider><Preview /></UiProvider>);
