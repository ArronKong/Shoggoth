import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import SettingsPage from "../../app/manage-ui/src/pages/SettingsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Isolated real SettingsPage and dialog. Every request stays in this fixture.
const scenario = new URLSearchParams(location.search).get("scenario") || "active";
let loaded = true;
let revision = "a".repeat(64);
let stopCalls = 0;
const runs = [
  { runId: "grok-approval", agentName: "Grok", title: "整理并补充灵感记录", source: "inspiration", status: "waiting_approval" },
  { runId: "codex-running", agentName: "Codex", title: "完成设置页的交互调整", source: "chat", status: "running" },
  { runId: "claude-input", agentName: "Claude Code", title: "生成本周项目总结", source: "cron", status: "waiting_input" },
];
const status = () => ({ service: { healthy: loaded, serviceVersion: "preview", startedAt: 1,
  domainAvailability: { kanban: true, cron: true }, pendingCommandsLocked: false, mcpCredentialsLocked: false },
background: { supported: true, installed: true, enabled: loaded, loaded, needsRepair: false } });
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { "Content-Type": "application/json" },
});
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  switch (url.pathname) {
    case "/__api/config": return response({ config: {
      gatewayUrl: "ws://127.0.0.1:1", token: "", locale: "zh-CN", theme: "light",
      hermesMode: "local", hermesRemotes: [], hermesKeepAlive: true, disabledBackends: [],
      notifications: { chat: true, cron: false, task: false }, setupCompletedAt: 1,
    } });
    case "/__api/shoggoth/status": return response(status());
    case "/__api/shoggoth/providers": return response({ profile: null, providers: [] });
    case "/__api/shoggoth/background/stop-impact": return response(scenario === "unknown"
      ? { availability: "unavailable", revision: "unavailable", totalCount: null, runs: [] }
      : { availability: "available", revision, totalCount: scenario === "empty" ? 0 : runs.length, runs: scenario === "empty" ? [] : runs });
    case "/__api/shoggoth/background/stop": {
      stopCalls += 1;
      document.getElementById("preview-calls")!.textContent = `模拟停止请求：${stopCalls} 次`;
      if (scenario === "changed" && stopCalls === 1) {
        revision = "b".repeat(64);
        runs.push({ ...runs[1], runId: "new-task", title: "刚开始的新任务" });
        return response({ error: "Task state changed", code: "SHOGGOTH_STOP_IMPACT_CHANGED" }, 409);
      }
      const expected = scenario === "unknown" ? "unavailable" : revision;
      if (JSON.parse(String(init?.body)).revision !== expected) return response({ code: "SHOGGOTH_STOP_IMPACT_CHANGED" }, 409);
      loaded = false;
      return response(status());
    }
    case "/__api/shoggoth/background/start": loaded = true; return response(status());
    case "/__api/backends": case "/__api/status": case "/__api/versions": case "/__api/self-updates":
      return response({ backends: [], versions: [], updates: [] });
    default: return response({ error: "Unavailable in isolated preview" }, 501);
  }
};
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<React.StrictMode><HashRouter><NavigationGuardProvider><UiProvider>
  <aside style={{ padding: "14px 40px", fontSize: 13, borderBottom: "1px solid var(--ui-hairline)" }}>
    停止后台确认 · 隔离预览　
    <a href="?scenario=active#/settings">活动任务</a>　
    <a href="?scenario=empty#/settings">无活动任务</a>　
    <a href="?scenario=unknown#/settings">状态未知</a>　
    <a href="?scenario=changed#/settings">确认时状态变化</a>　
    <span id="preview-calls">模拟停止请求：0 次</span>
  </aside>
  <SettingsPage />
</UiProvider></NavigationGuardProvider></HashRouter></React.StrictMode>);
