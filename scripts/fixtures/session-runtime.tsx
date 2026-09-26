import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SessionRuntimeControl from "../../app/manage-ui/src/components/SessionRuntimeControl";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
const state = window as any;
const first = "11111111-1111-8111-8111-111111111111", second = "22222222-2222-8222-8222-222222222222", third = "33333333-3333-8333-8333-333333333333";
const sessionKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let snapshot = { sessionKey, revision: 1, bindingId: first, runtime: "codex", model: "model-old", contextUsage: null,
  canSwitch: true, candidates: [
    { bindingId: first, support: { supported: true }, adjustments: { clearModelOverride: false, permissionMode: null } },
    { bindingId: second, support: { supported: true }, adjustments: { clearModelOverride: true, permissionMode: "auto" } },
    { bindingId: third, support: { supported: false, code: "ACCOUNT_AUTH_UNKNOWN" }, adjustments: { clearModelOverride: false, permissionMode: null } },
  ] };
state.writes = []; state.interrupts = 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
state.fetch = async (input: string, init?: RequestInit) => {
  if (String(input).includes("runtime-bindings")) return Response.json({ bindings: [
    { id: first, runtime: "codex", label: "Codex" }, { id: second, runtime: "pi", label: "Pi" }, { id: third, runtime: "grok-build", label: "Grok" },
  ], defaultBindingId: first, revision: 1, canAdd: false });
  await pause(30);
  if (init?.method === "PUT") {
    const body = JSON.parse(String(init.body)); state.writes.push(body);
    if (state.failNext) { state.failNext = false; snapshot.revision++; return Response.json({ error: "fixture session revision conflict", code: "CHAT_SESSION_REVISION_CONFLICT" }, { status: 409 }); }
    if (body.revision !== snapshot.revision) throw Error("stale fixture CAS");
    if (body.bindingId === second && !body.acceptAdjustments) throw Error("unconfirmed adjustments");
    snapshot = { ...snapshot, bindingId: body.bindingId, runtime: body.bindingId === first ? "codex" : "pi", model: body.bindingId === first ? "model-new" : null as any, revision: snapshot.revision + 1 };
  }
  return Response.json(snapshot);
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => { const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(label); await pause(10); } };
function Fixture() {
  const [busy, setBusy] = useState(true); const [version, setVersion] = useState(0); state.reload = () => setVersion((value) => value + 1);
  return <UiProvider><main className="page management-page" style={{ maxWidth: 900, margin: "auto", paddingTop: 30, paddingLeft: 60 }}>
    <SessionRuntimeControl key={version} backend="fixture" agentId="agent-one" sessionKey={`agent:agent-one:${sessionKey}`} busy={busy} connected
      onInterrupt={async () => { state.interrupts++; await pause(20); setBusy(false); }} onChanged={() => { state.changes = (state.changes || 0) + 1; }} />
  </main></UiProvider>;
}
await applyConfiguredLocale("zh-CN"); createRoot(document.getElementById("root")!).render(<Fixture />);
const button = (name: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === name)!;
const candidate = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((entry) => entry.textContent?.startsWith(name))!;
const dialog = () => document.querySelector('[role="alertdialog"]')!;
const open = () => { document.querySelector<HTMLButtonElement>('button[aria-label="切换 Runtime"]')!.click(); };
const opened = () => document.querySelector('button[aria-label="切换 Runtime"]')?.getAttribute("aria-expanded") === "true";
state.runSessionRuntimeFixture = async () => {
  await wait(() => !!document.querySelector('button[aria-label="切换 Runtime"]'), "visible runtime switch"); open();
  await wait(() => !!candidate("Pi"), "load candidates");
  check(candidate("Pi").disabled, "busy cannot switch");
  button("等待完成").click(); await wait(() => document.body.textContent?.includes("正在等待任务结束"), "wait action");
  button("中断当前任务").click(); await wait(() => !candidate("Pi").disabled, "interrupt waits for inactive state");
  check(state.interrupts === 1 && !state.writes.length, "interrupt does not auto-switch");
  check(candidate("Grok").disabled && candidate("Grok").textContent?.includes("无法确认登录"), "unsupported reason shown");
  candidate("Pi").click(); await wait(dialog, "adjustment confirmation");
  check(dialog().textContent?.includes("清除当前会话的模型覆盖") && dialog().textContent?.includes("auto"), "all adjustments explicit");
  button("取消", dialog()).click(); await wait(() => !dialog(), "cancel confirmation");
  check(!state.writes.length, "cancel sends nothing");
  candidate("Pi").click(); await wait(dialog, "confirmation retry"); button("确认并续接", dialog()).click();
  await wait(() => snapshot.runtime === "pi" && !opened(), "handoff applied");
  check(state.writes[0].acceptAdjustments && state.changes === 1, "explicit confirmation and refresh");
  open(); await wait(() => !!candidate("Codex") && !candidate("Codex").disabled, "reopen"); state.failNext = true; candidate("Codex").click();
  await wait(() => document.body.textContent?.includes("fixture session revision conflict") && !candidate("Codex").disabled, "stale switch refresh");
  check(candidate("Pi").getAttribute("aria-pressed") === "true", "conflict preserves old runtime");
  candidate("Codex").click(); await wait(() => snapshot.runtime === "codex" && !opened(), "retry refreshed CAS");
  snapshot.canSwitch = false; state.reload(); await pause(80); open(); await wait(() => document.body.textContent?.includes("手动续接尚未启用"), "flag off");
  check(candidate("Pi").disabled, "flag off disables switching");
  return { writes: state.writes.length, interrupts: state.interrupts, confirmed: true, conflictRefresh: true };
};
state.checkSessionRuntimeGeometry = async (theme: string) => {
  document.documentElement.dataset.theme = theme; if (!opened()) open(); await pause(250); await new Promise(requestAnimationFrame);
  check(document.documentElement.scrollWidth <= innerWidth, "session runtime horizontal overflow");
  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!; close.focus(); check(document.activeElement === close, "dialog keyboard focus");
  return { width: innerWidth, theme, overflow: false };
};
