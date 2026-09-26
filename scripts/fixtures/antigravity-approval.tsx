import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ChatApprovalCard from "../../app/manage-ui/src/pages/ChatApprovalCard";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPromptCard.css";

const approvalOptions = [
  { choice: "runtime:antigravity-1", label: "Yes, allow access", kind: "allow_once" as const },
  { choice: "runtime:antigravity-2", label: "Yes, and always allow non-workspace access", kind: "allow_always" as const },
  { choice: "deny", label: "No, deny access", kind: "reject_once" as const },
];

function Preview() {
  const [choice, setChoice] = useState("");
  return <main style={{ width: "min(680px, calc(100% - 48px))", margin: "64px auto", color: "var(--ui-text-1)" }}>
    <h2 style={{ fontSize: 22, marginBottom: 12 }}>Antigravity · 原生工具授权</h2>
    <p style={{ fontSize: 13, color: "var(--ui-text-2)", marginBottom: 28 }}>界面预览 · 使用实测的原生选项，按钮仅模拟响应。</p>
    <ChatApprovalCard submitting={false} onChoose={setChoice} entry={{
      id: "native-preview", version: 1, requestId: "native-request", runId: "native-run", kind: "runtime_approval",
      title: "需要授权", message: "File access\n\nRead: /Users/demo/Downloads/测试图片.png\nReason: outside workspace\n\nAllow access to this file?",
      fields: [], expiresAt: null, approvalChoices: approvalOptions.map((option) => option.choice), approvalOptions,
      approvalDetails: { kind: "command", toolName: "view_file", input: JSON.stringify({ AbsolutePath: "/Users/demo/Downloads/测试图片.png" }) },
    }} />
    <p role="status" style={{ marginTop: 20, fontSize: 13 }}>{choice ? `模拟响应：${approvalOptions.find((option) => option.choice === choice)?.label}` : "等待选择"}</p>
  </main>;
}

await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Preview />);
