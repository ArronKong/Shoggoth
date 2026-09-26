import React from "react";
import { createRoot } from "react-dom/client";
import TurnTimeline from "../../app/manage-ui/src/components/TurnTimeline/TurnTimeline";
import { createTimeline, reduceTimeline, stepsFromParts } from "../../app/manage-ui/src/lib/turnTimeline";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const callId = `runtime-${"a".repeat(64)}`;
const historyId = `runtime-${"b".repeat(64)}`;
const conversation = { backendId: "shoggoth", sessionKey: "fixture-conversation" };
const writes: Array<{ route: string; method: string; body: unknown }> = [];
scope.fixtureWrites = writes;
let completeRequest: ((success: boolean) => void) | null = null;
window.fetch = async (input, init) => {
  const route = String(input);
  if (route !== "/__api/plugins/app-open" || init?.method !== "POST") throw Error(`Unexpected I/O: ${route}`);
  writes.push({ route, method: init.method, body: JSON.parse(String(init.body)) });
  const success = await new Promise<boolean>(resolve => { completeRequest = resolve; });
  return new Response(JSON.stringify(success ? { opened: true } : { error: "PLUGIN_APP_UNAVAILABLE" }),
    { status: success ? 200 : 409, headers: { "content-type": "application/json" } });
};
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
async function wait(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 3000;
  while (!predicate()) { if (performance.now() > deadline) throw Error(message); await pause(); }
}
function appButtons(section = document) {
  return Array.from(section.querySelectorAll<HTMLButtonElement>("button"))
    .filter(button => /打开交互界面|正在打开/.test(button.textContent || ""));
}
const live = reduceTimeline(createTimeline(), { kind: "tool", phase: "result", toolCallId: "live-note",
  name: "mcp_server_call", result: "", pluginAppCallId: callId }, 1).steps;
const history = stepsFromParts([{ type: "toolResult", toolName: "mcp_server_call",
  text: "历史摘要已截断，无法作为 JSON 解析…", pluginAppCallId: historyId }]);
const invalid = reduceTimeline(createTimeline(), { kind: "tool", phase: "result", toolCallId: "invalid",
  name: "mcp_server_call", result: "普通文本结果", pluginAppCallId: "runtime-invalid" }, 1).steps;
applyConfiguredLocale("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 840, margin: "0 auto", padding: 20 }}>
  <h1 style={{ fontSize: 20 }}>能力包交互界面</h1>
  <p>应用入口独立于文本摘要，打开时由 Service 重新验证当前授权。</p>
  <section id="live"><h2 style={{ fontSize: 15 }}>实时结果 · 空摘要</h2>
    <TurnTimeline steps={live} status="done" autoFollow={false} pluginConversation={conversation} /></section>
  <section id="history"><h2 style={{ fontSize: 15 }}>历史结果 · 已截断摘要</h2>
    <TurnTimeline steps={history} status="done" autoFollow={false} pluginConversation={conversation} /></section>
  <section id="invalid"><h2 style={{ fontSize: 15 }}>无效引用</h2>
    <TurnTimeline steps={invalid} status="done" autoFollow={false} pluginConversation={conversation} /></section>
  <section id="unbound"><h2 style={{ fontSize: 15 }}>没有会话上下文</h2>
    <TurnTimeline steps={live} status="done" autoFollow={false} /></section>
</main>);
scope.preparePluginAppKeyboard = async () => {
  await wait(() => document.querySelector("#live button[aria-expanded=false]"), "empty summary remains expandable");
  const button = document.querySelector<HTMLButtonElement>("#live button[aria-expanded=false]")!;
  button.focus(); return { focused: document.activeElement === button };
};
scope.runPluginAppReferenceFixture = async () => {
  await wait(() => appButtons(document.querySelector("#live") as any).length === 1, "keyboard expands live App card");
  const liveButton = appButtons(document.querySelector("#live") as any)[0];
  liveButton.click();
  await wait(() => writes.length === 1 && liveButton.disabled, "App open request is pending and cannot be duplicated");
  liveButton.click(); check(writes.length === 1, "disabled pending button prevents duplicate requests");
  check(JSON.stringify(writes[0].body) === JSON.stringify({ ...conversation, callId }), "independent live reference is exact API payload");
  completeRequest!(true); await wait(() => !liveButton.disabled, "successful native open releases button");
  document.querySelector<HTMLButtonElement>("#history button[aria-expanded=false]")!.click();
  await wait(() => appButtons(document.querySelector("#history") as any).length === 1, "history App card survives invalid JSON summary");
  const historyButton = appButtons(document.querySelector("#history") as any)[0];
  historyButton.click(); await wait(() => writes.length === 2 && historyButton.disabled, "history open awaits Service");
  check(JSON.stringify(writes[1].body) === JSON.stringify({ ...conversation, callId: historyId }), "history reference is exact API payload");
  completeRequest!(false); await wait(() => !!document.querySelector("#history [role=status]"), "stale Service receipt reports unavailable");
  check(!historyButton.disabled, "failure allows a later explicit retry");
  document.querySelector<HTMLButtonElement>("#invalid button[aria-expanded=false]")!.click();
  document.querySelector<HTMLButtonElement>("#unbound button[aria-expanded=false]")?.click();
  await pause();
  check(appButtons(document.querySelector("#invalid") as any).length === 0, "invalid reference never offers open");
  check(appButtons(document.querySelector("#unbound") as any).length === 0, "missing conversation never offers open");
  check(writes.length === 2 && scope.fixtureErrors.length === 0, "exact two explicit requests and no render errors");
  return { checks: ["keyboard expansion with empty summary", "independent live reference opens exact conversation",
    "pending duplicate prevention", "history reference with truncated non-JSON summary", "Service failure remains visible",
    "invalid reference rejected", "conversation required"], writes };
};
scope.preparePluginAppCapture = async (theme: string) => {
  document.documentElement.dataset.theme = theme; await pause(300);
  const bounds = appButtons().map(button => {
    const rect = button.getBoundingClientRect();
    check(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, "App button stays within viewport");
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  check(bounds.length === 2, "both live and history cards visible");
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bounds };
};
