import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import SessionRuntimeControl from "../../app/manage-ui/src/components/SessionRuntimeControl";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Only this framing and transcript view are fixtures. The runtime menu, client,
// confirmations and cache are the production React modules, with real HTTP.
const scope = window as any;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const until = performance.now() + 8000;
  while (!predicate()) { if (performance.now() > until) throw Error(label); await pause(10); }
};
const nativeFetch = window.fetch.bind(window);
let observedRevision = -1;
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await nativeFetch(...args);
  if (String(args[0]).includes("/session-runtime") && response.ok) {
    observedRevision = (await response.clone().json()).revision;
  }
  return response;
};
async function readState() {
  const response = await fetch("/__fixture/state");
  if (!response.ok) throw Error("fixture state unavailable");
  return response.json();
}
const initial = await readState();
function Fixture() {
  const [current, setCurrent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  scope.fixtureState = current; scope.fixtureBusy = busy; scope.fixtureError = error;
  const refresh = async () => setCurrent(await readState());
  const send = async () => {
    setBusy(true);
    try {
      const response = await fetch("/__fixture/send", { method: "POST" });
      if (!response.ok) throw Error((await response.json()).error);
      setCurrent(await response.json());
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <UiProvider><main className="page management-page" style={{ maxWidth: 900, margin: "auto", padding: 32 }}>
    <h1>Runtime 续接连续操作验收</h1>
    <p>本地 fixture：真实 React 控件、Service Controller 与持久化 Store；原生 Host 和回复为合成数据。</p>
    <p data-testid="identity">Agent: {current.agentId}<br />Conversation: {current.sessionId}</p>
    <SessionRuntimeControl backend="fixture" agentId={current.agentId} sessionKey={current.gatewayKey}
      busy={busy} connected onInterrupt={async () => { throw Error("unexpected interrupt"); }} onChanged={() => void refresh()} />
    <button className="ui-cbtn" data-testid="send" disabled={busy} onClick={() => void send()}>发送本地 fixture 轮次</button>
    <p data-testid="runtime-state">Runtime: {current.runtime}; native session: {current.nativeSessionId || "pending fresh session"}; retired: {current.retiredCount}</p>
    {error && <p role="alert">{error}</p>}
    <ol data-testid="transcript">{current.messages.map((message: any) => <li key={message.id}><b>{message.kind}</b>: {message.text}</li>)}</ol>
  </main></UiProvider>;
}
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<Fixture />);
const candidate = (runtime: string) => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
  .find(button => button.querySelector("span")?.firstChild?.textContent === runtime)!;
const settled = async () => {
  await wait(() => !scope.fixtureBusy && observedRevision === scope.fixtureState.revision, "runtime snapshot refreshed after native turn");
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  check(!scope.fixtureError, scope.fixtureError);
};
scope.runHandoffPreviewStep = async (index: number) => {
  const runtime = ["codex", "pi", "deepseek-harness", "codex"][index];
  await wait(() => !!document.querySelector('button[aria-label="切换 Runtime"]'), "visible runtime switch");
  await settled();
  let confirmed = false;
  if (index) {
    document.querySelector<HTMLButtonElement>('button[aria-label="切换 Runtime"]')!.click();
    await wait(() => !!candidate(runtime), "runtime candidates loaded");
    check(!candidate(runtime).disabled, "target candidate enabled");
    candidate(runtime).click();
    if (index === 1) {
      await wait(() => document.querySelector('[role="alertdialog"]'), "model adjustment confirmation");
      const dialog = document.querySelector('[role="alertdialog"]')!;
      check(dialog.textContent?.includes("清除当前会话的模型覆盖"), "clear model is explicit");
      const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "确认并续接")!;
      check(confirm, "confirm control exists"); confirm.click(); confirmed = true;
    }
    await wait(() => scope.fixtureState.runtime === runtime && document.querySelector('button[aria-label="切换 Runtime"]')?.getAttribute("aria-expanded") === "false",
      "runtime changed by production control");
    check(scope.fixtureState.nativeSessionId === null, "switch alone does not create a native session");
    check(scope.fixtureState.retiredCount === index, "one old native session retired per switch");
  }
  const before = scope.fixtureState.messages.length;
  document.querySelector<HTMLButtonElement>('[data-testid="send"]')!.click();
  await wait(() => scope.fixtureState.messages.length === before + 2 && !scope.fixtureBusy, "fixture native turn completed");
  await settled();
  const current = scope.fixtureState;
  check(current.agentId === initial.agentId && current.sessionId === initial.sessionId && current.profileId === initial.profileId,
    "same Agent and Conversation");
  document.querySelector<HTMLButtonElement>('button[aria-label="切换 Runtime"]')!.click();
  await wait(() => candidate(runtime)?.getAttribute("aria-pressed") === "true", "actual menu selected runtime");
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!.click();
  await pause(250);
  check(document.querySelectorAll('[data-testid="transcript"] li').length === (index + 1) * 2, "all transcript messages rendered");
  for (let prior = 0; prior <= index; prior++) {
    check(document.body.textContent?.includes(`UI HISTORY MARKER ${prior}`), "prior user text remains visible");
    check(document.body.textContent?.includes(`UI FIXTURE ANSWER ${prior}`), "prior assistant text remains visible");
  }
  return { index, runtime, agentId: current.agentId, profileId: current.profileId, sessionId: current.sessionId,
    nativeSessionId: current.nativeSessionId, retiredCount: current.retiredCount,
    messageCount: current.messages.length, confirmationAccepted: confirmed };
};
