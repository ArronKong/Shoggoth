import { createRoot } from "react-dom/client";
import HeartbeatSettings from "../../app/manage-ui/src/pages/agents/HeartbeatSettings";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import s from "../../app/manage-ui/src/pages/AgentsPage.module.css";
const state = window as any, calls: any[] = [];
let monitor = { revision: 2, config: { id: "heartbeat-fixture", kind: "heartbeat", profileId: "agent-a", enabled: true,
  schedule: { kind: "every", everyMs: 1800000, anchorMs: 0 }, timezone: "system", activeHours: { start: "08:00", end: "22:00" },
  push: true, budget: { maxRunsPerDay: 24, maxTokensPerDay: 10000000 }, checklist: [], scopes: { inspiration: false, runIds: [] }, target: { mode: "dedicated" }, review: null } };
let scratch = { revision: 3, content: "上次已检查版本 3；发布新版本时再提醒。", updatedAt: Date.now() };
const status = { reason: "model_silent", lastCheckAt: Date.now() - 1800000, lastNoticeAt: null,
  capabilities: { deterministic: true, semanticVerified: true, runtime: "codex", reason: null } };
state.heartbeatFixture = { calls, i18n, failNext: false };
window.fetch = async (_url, options) => {
  const request = JSON.parse(String(options?.body)); calls.push(request);
  if (state.heartbeatFixture.failNext) { state.heartbeatFixture.failNext = false; return new Response(JSON.stringify({ error: "PROACTIVE_REVISION_CONFLICT" }), { status: 409 }); }
  let payload;
  if (request.method === "proactive.monitor.get") payload = { monitor, status };
  else if (request.method === "proactive.scratch.get") payload = { scratch };
  else if (request.method === "proactive.monitor.set") {
    if (request.params.expectedRevision !== monitor.revision) throw Error("Lost settings revision");
    monitor = { config: request.params.config, revision: monitor.revision + 1 }; payload = { monitor, status };
  } else if (request.method === "proactive.scratch.set") {
    if (request.params.expectedRevision !== scratch.revision) throw Error("Lost scratch revision");
    scratch = { ...scratch, content: request.params.content, revision: scratch.revision + 1 }; payload = { scratch };
  } else throw Error("Unexpected UI operation: " + request.method);
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
void i18n.changeLanguage("zh-CN");
const rules = "---\nweb:\n  - kind: fetch\n    url: https://example.com/status\n---\n\n# 发布检查\n只在发布新版本时提醒，并记录已经通知过的版本。";
createRoot(document.getElementById("root")!).render(<UiProvider>
  <div className={s.tabPane}><h2>Agent · Setup</h2><div className={s.suLayout}>
    <nav className={s.suList}><span>IDENTITY</span><span>SOUL</span><strong>HEARTBEAT</strong></nav><div className={s.suDivider}/>
    <div className={s.suMain}><header className={s.suHead}><div><strong>HEARTBEAT.md</strong><p>心跳任务——定时唤醒时要检查的事项清单。</p></div></header>
      <HeartbeatSettings profileId="agent-a"/><textarea aria-label="HEARTBEAT.md" className={s.suEditor} defaultValue={rules} />
    </div></div></div>
</UiProvider>);
