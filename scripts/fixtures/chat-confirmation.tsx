import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../../app/manage-ui/src/pages/ChatPromptCard";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const query = new URLSearchParams(location.search);
const en = query.get("lang") === "en";
const narrow = query.get("width") === "390";
const productMessage = "Shoggoth 将操作 Computer Use 会话（ai.shoggoth.desktop）。是否继续？";
const deleteMessage = "已找到唯一名为“星帆”的本地 AI 助理。删除后其配置可能无法恢复，确定要删除吗？";
const base = { version: 1 as const, runId: "preview-run", approvalChoices: [], expiresAt: null };
const entries: ChatPromptEntry[] = [
  { ...base, id: "product", requestId: "product", kind: "product_confirmation", title: "确认产品操作", message: productMessage,
    fields: [{ id: "confirm_product_action", type: "choice", label: "确认修改", description: productMessage,
      required: true, secret: false, options: [
        { value: "确认执行", label: "确认执行", description: "执行这一次已明确列出的操作。" },
        { value: "取消", label: "取消", description: "不修改任何产品状态。" },
      ] }] },
  { ...base, id: "delete", requestId: "delete", kind: "user_input", title: "需要补充信息", message: deleteMessage,
    fields: [{ id: "confirm_delete", type: "choice", label: "确认删除", description: deleteMessage,
      required: true, secret: false, options: [
        { value: "确定删除 (Recommended)", label: "确定删除 (Recommended)", description: "永久删除“星帆”这个 AI 助理。" },
        { value: "取消", label: "取消", description: "保留“星帆”，不做任何更改。" },
      ] }] },
  { ...base, id: "form", requestId: "form", kind: "user_input", title: "需要补充信息", message: en ? "Complete the project details" : "请补充项目信息",
    fields: [
      { id: "name", type: "text", label: en ? "Project" : "项目名称", description: "", required: true, secret: false, options: [] },
      { id: "platform", type: "choice", label: en ? "Platform" : "运行平台", description: "", required: true, secret: false,
        options: [{ value: "mac", label: "macOS", description: en ? "Desktop application" : "桌面应用" },
          { value: "web", label: "Web", description: en ? "Browser" : "浏览器" }] },
    ] },
];

function Preview() {
  const [responses, setResponses] = useState<Record<string, ChatPromptResponse>>({});
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  return <main style={{ width: narrow ? 358 : "min(688px, calc(100% - 48px))", maxWidth: "calc(100% - 32px)", margin: "32px auto" }}>
    <h1 style={{ fontSize: 22, marginBottom: 8 }}>确认操作</h1>
    <p style={{ fontSize: 13, color: "var(--ui-text-2)", marginBottom: 24 }}>独立界面预览 · 所有按钮仅模拟响应</p>
    {entries.map((entry) => <section key={entry.id} data-preview={entry.id} style={{ marginBottom: 24 }}>
      <ChatPromptCard entry={entry} onRespond={async (_entry, response) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (query.get("fail") === "1" && !failed) {
          setFailed(true); setError("模拟网络失败，可以重试"); throw new Error("preview failure");
        }
        setError(""); setResponses((previous) => ({ ...previous, [entry.id]: response }));
      }} />
      <output data-response={entry.id} style={{ display: "block", overflowWrap: "anywhere", fontSize: 12, marginTop: 8 }}>
        {responses[entry.id] ? JSON.stringify(responses[entry.id]) : ""}
      </output>
    </section>)}
    {error ? <p role="alert">{error}</p> : null}
  </main>;
}

await applyConfiguredLocale(en ? "en" : "zh-CN");
createRoot(document.getElementById("root")!).render(<Preview />);
