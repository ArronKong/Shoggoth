import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import ChatPermissionMenu from "../../app/manage-ui/src/pages/ChatPermissionMenu";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { displayedPermissionMode, localizePermissionMode } from "../../app/manage-ui/src/lib/permissionModeText";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { ChatPermissionModeOption } from "../../app/manage-ui/src/types";
import "../../app/manage-ui/src/styles.css";

const state = window as unknown as {
  permissionCatalog: Record<string, ChatPermissionModeOption[]>;
  runPermissionFixture: () => Promise<unknown>;
};
function Fixture() {
  const [runtime, setRuntime] = useState("codex");
  const [mode, setMode] = useState("request-approval");
  const [saves, setSaves] = useState(0);
  const { t } = useTranslation();
  return <main style={{ margin: "40px auto", width: "min(720px, calc(100% - 48px))" }}>
    <h2>Shoggoth 权限菜单</h2>
    <label>Runtime <select aria-label="Runtime" value={runtime} onChange={event => setRuntime(event.target.value)}>
      {Object.keys(state.permissionCatalog).map(id => <option key={id}>{id}</option>)}
    </select></label>
    <p>当前选择：<output data-mode>{mode}</output> · 保存次数：<output data-saves>{saves}</output></p>
    <button onClick={() => setMode("read-only")}>载入旧只读会话</button>
    <button onClick={() => { setRuntime("antigravity"); setMode("accept-edits"); }}>载入旧自动编辑会话</button>
    <div style={{ marginTop: 370, padding: 18, borderRadius: 18, background: "var(--ui-surface-1)" }}>
      <p style={{ color: "var(--ui-text-2)" }}>发送消息前选择本会话的权限</p>
      <ChatPermissionMenu options={state.permissionCatalog[runtime].map(option => localizePermissionMode(option, t))}
        activeMode={mode} onSelect={option => {
          setMode(option.id); setSaves(value => value + 1);
        }} />
    </div>
  </main>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider><Fixture /></UiProvider>);
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
};
const menu = () => document.querySelector('[role="menu"]');
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const trigger = () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const option = (index: number) => items()[index];
const selected = () => document.querySelector("[data-mode]")?.textContent;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find(entry => entry.textContent === text)!;
const open = async () => { trigger().click(); await wait(menu, "permission menu opens"); };
state.runPermissionFixture = async () => {
  await wait(trigger, "permission trigger exists");
  await open();
  check(items().map(item => item.querySelector(".permission-menu__name")?.textContent).join("|")
    === "请求批准|帮我批准|完全访问权限", "exactly three localized choices");
  option(1).click(); await wait(() => selected() === "auto-review" && !menu(), "automatic selection saved");
  for (const runtime of Object.keys(state.permissionCatalog)) {
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.value = runtime; select.dispatchEvent(new Event("change", { bubbles: true })); await pause();
    await open();
    check(items().length === 3 && option(1).getAttribute("aria-checked") === "true", `${runtime} preserves selected mode`);
    trigger().click(); await wait(() => !menu(), "menu closes");
  }
  await open(); option(2).click(); await wait(() => selected() === "full-access" && !menu(), "full access saved directly");
  check(!document.querySelector('[role="alertdialog"], [role="dialog"]'), "full access has no confirmation dialog");
  button("载入旧只读会话").click(); await wait(() => selected() === "read-only", "legacy restriction loaded");
  await open(); check(items().length === 3, "legacy modes do not add an option");
  check(menu()?.textContent?.includes("保留原有权限限制"), "legacy restriction remains visible");
  option(0).click(); await wait(() => selected() === "request-approval", "legacy-to-ask click is not discarded");
  check(document.querySelector("[data-saves]")?.textContent === "3", "each explicit choice is saved once");
  button("载入旧自动编辑会话").click(); await wait(() => selected() === "accept-edits", "legacy edit mode loaded");
  check(trigger().textContent?.includes("请求批准"), "legacy edit-only permissions must not claim automatic review is selected");
  for (const legacy of ["accept-edits", "acceptEdits", "workspace-auto"]) {
    check(displayedPermissionMode(legacy) === "request-approval", `${legacy} is not an automatic reviewer`);
  }
  await open();
  check(option(0).getAttribute("aria-checked") === "true" && option(1).getAttribute("aria-checked") === "false",
    "an unchanged Antigravity session does not show an automatic reviewer checkmark");
  check(option(1).textContent?.includes("自动执行工作区文件操作和命令"), "Antigravity describes automatic workspace execution");
  option(1).click(); await wait(() => selected() === "auto-review", "explicit automatic review selection saved");
  check(document.querySelector("[data-saves]")?.textContent === "4", "legacy edit permissions change only after an explicit choice");
  return { runtimes: 7, options: 3, saves: 4, fullAccessWithoutDialog: true, legacyRetained: true, legacyEditReviewerVerified: true };
};
