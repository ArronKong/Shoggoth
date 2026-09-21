import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRunWait, chatRunWaitState } from "../../app/manage-ui/src/components/ChatRunWait";
import FusionLoader from "../../app/manage-ui/src/components/FusionLoader";
import ImmersiveStatusLine from "../../app/manage-ui/src/pages/immersive/ImmersiveStatusLine";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const require = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
function Fixture() {
  const [kind, setKind] = useState("queued");
  const [reason, setReason] = useState("RUNTIME_ACCOUNT_ACTIVE_LIMIT");
  const [since] = useState(Date.now() - 65000);
  const wait = chatRunWaitState({ statusKind: kind, queuedAt: since, reason });
  return <main style={{ padding: 24, maxWidth: 1024, margin: "0 auto" }}>
    <header className="chat-header" style={{ position: "relative", width: "100%" }}>
      <div className="chat-header__avatar" style={{ borderRadius: "50%", background: "#e3e9e1", width: 48, height: 48, flexShrink: 0 }} />
      <div className="chat-header__id"><div className="chat-header__name">Shoggoth</div>
        <div className="chat-header__statusline">
          {wait && <ChatRunWait state={wait} compact />}
          <div className="chat-header__meta">同时处理另一段会话并创建一个辅助助理的任务</div>
        </div>
      </div>
      <div className="chat-header__tools"><button type="button" aria-label="设置">···</button></div>
    </header>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "24px 0" }}>
      <button id="queue" onClick={() => { setKind("queued"); setReason("RUNTIME_ACCOUNT_ACTIVE_LIMIT"); }}>账号排队</button>
      <button id="backend" onClick={() => { setKind("queued"); setReason("BACKEND_ACTIVE_LIMIT"); }}>后端排队</button>
      <button id="background" onClick={() => { setKind("queued"); setReason("BACKEND_BACKGROUND_ACTIVE_LIMIT"); }}>后台排队</button>
      <button id="start" onClick={() => setKind("starting")}>连接</button>
      <button id="run" onClick={() => setKind("running")}>运行</button>
      <button id="english" onClick={() => void i18n.changeLanguage("en")}>English</button>
      <button id="chinese" onClick={() => void i18n.changeLanguage("zh-CN")}>中文</button>
    </div>
    <div className="chat-bubble" style={{ width: "fit-content" }}>
      {wait && <ChatRunWait state={wait} />}
      <FusionLoader size="sm" ariaLabel={i18n.t("chat.liveStatus.running")} />
    </div>
    <div style={{ marginTop: 40 }}>
      <ImmersiveStatusLine phase="thinking" live={wait ? { tools: [], wait } : null} />
    </div>
  </main>;
}
void i18n.changeLanguage("zh-CN").then(() => {
  createRoot(document.getElementById("root")!).render(<Fixture />);
});
(window as any).runNativeConcurrencyUi = async () => {
  await frame(); await frame();
  const click = async (id: string) => { (document.getElementById(id) as HTMLButtonElement).click(); await frame(); await frame(); };
  await click("queue");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("等待账号空位"), "queue reason visible");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("1m"), "elapsed queue time visible");
  await click("start");
  require(document.querySelector("[data-testid=chat-run-wait]") === null, "connecting label and timer are hidden across chat surfaces");
  require(document.querySelector(".chat-bubble")?.textContent === "", "connecting bubble contains no status text");
  require(!!document.querySelector(".chat-bubble [role=status] svg"), "connecting retains the waiting animation");
  await click("run");
  require(document.querySelector(".chat-header [data-testid=chat-run-wait]") === null, "header queue disappears when running");
  await click("queue"); await click("english");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("Waiting for account capacity"), "English queue localization");
  await click("backend");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("Waiting for this backend's capacity"), "English backend scope");
  await click("background");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("Waiting for this backend's background capacity"), "English background scope");
  await click("chinese");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("等待当前后端后台空位"), "Chinese background scope");
  await click("backend");
  require(document.querySelector(".chat-bubble")?.textContent?.includes("等待当前后端空位"), "Chinese backend scope");
  const before = document.querySelector(".chat-bubble")?.textContent;
  await new Promise(resolve => setTimeout(resolve, 1100));
  require(before !== document.querySelector(".chat-bubble")?.textContent, "elapsed time updates");
  require(chatRunWaitState({ statusKind: "running" }) === null, "running clears wait");
  require(chatRunWaitState({ statusKind: "queued", reason: "__proto__", queuedAt: -4 }, 200)?.since === 200, "invalid input falls back safely");
  require(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  const status = document.querySelector(".chat-header__statusline")!.getBoundingClientRect();
  const meta = document.querySelector(".chat-header__meta")!.getBoundingClientRect();
  require(meta.right <= status.right + 1, "long session title stays inside header");
  return { ok: true, width: innerWidth, height: innerHeight };
};
