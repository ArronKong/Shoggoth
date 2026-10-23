import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ChatThinkFastMenu from "../../app/manage-ui/src/pages/ChatThinkFastMenu";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

const labels: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", adaptive: "Adaptive" };
const initial = { scope: 0, value: "max", defaultValue: "low", levels: ["low", "medium", "high", "xhigh", "max", "ultra"], disabled: false, fastCapable: true };
const commits: string[] = [];
let manual = false;
let resolveNext: ((accepted?: boolean) => void) | undefined;
void i18n.changeLanguage("zh-CN");

function Fixture() {
  const [settings, setSettings] = useState(initial);
  const [fastOn, setFastOn] = useState(false);
  Object.assign(window, { thinkingFixture: {
    commits,
    configure: (patch: Partial<typeof initial>) => setSettings(previous => ({ ...previous, ...patch })),
    defer: (next: boolean) => { manual = next; },
    resolve: (accepted = true) => { const resolve = resolveNext; resolveNext = undefined; resolve?.(accepted); },
  } });
  return <main style={{ width: "min(560px, calc(100% - 48px))", margin: "190px auto 0", fontFamily: "system-ui", color: "var(--ui-text-1)" }}>
    <p style={{ marginBottom: 110, color: "var(--ui-text-2)", fontSize: 14 }}>拖动圆点或点击轨道，选择思考强度</p>
    <div className="chat-composer__bar" style={{ justifyContent: "flex-start", gap: 18 }}>
      <span style={{ fontSize: 13 }}>GPT-6.1-Sol</span>
      <ChatThinkFastMenu key={settings.scope} {...settings}
        defaultLabel="Default"
        levelLabel={level => labels[level] || level} fastOn={fastOn} onChangeFast={setFastOn}
        onChangeThinking={async level => {
          commits.push(level);
          const accepted = manual ? await new Promise<boolean>(resolve => { resolveNext = (ok = true) => resolve(ok); }) : true;
          if (accepted) setSettings(previous => previous.scope === settings.scope ? { ...previous, value: level } : previous);
          return accepted;
        }} />
      <span style={{ fontSize: 13 }}>完全访问权限</span>
    </div>
    <p style={{ color: "var(--ui-text-3)", fontSize: 12, marginTop: 48 }}>交互预览 · 设置仅保存在本页</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
