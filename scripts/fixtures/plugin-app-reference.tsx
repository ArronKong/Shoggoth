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
window.fetch = async (input, init) => {
  writes.push({ route: String(input), method: init?.method || "GET", body: null });
  throw Error("Retired plugin history must not request an interactive App or execute a tool");
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
  <h1 style={{ fontSize: 20 }}>历史插件记录</h1>
  <p>保留原引用和工具文本；旧交互界面已退役，不能从历史重新执行。</p>
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
  await wait(() => document.querySelector("#live [data-legacy-plugin-call]"), "keyboard expands the retained historical reference");
  document.querySelector<HTMLButtonElement>("#history button[aria-expanded=false]")!.click();
  await wait(() => document.querySelector("#history [data-legacy-plugin-call]"), "truncated history retains its original reference");
  document.querySelector<HTMLButtonElement>("#invalid button[aria-expanded=false]")!.click();
  document.querySelector<HTMLButtonElement>("#unbound button[aria-expanded=false]")?.click();
  await pause();
  check(document.querySelector("#live [data-legacy-plugin-call]")?.getAttribute("data-legacy-plugin-call") === callId, "live reference remains exact");
  check(document.querySelector("#history [data-legacy-plugin-call]")?.getAttribute("data-legacy-plugin-call") === historyId, "history reference remains exact");
  check(!document.querySelector("#invalid [data-legacy-plugin-call]"), "invalid reference remains unavailable");
  check(!document.querySelector("#unbound [data-legacy-plugin-call]"), "an unbound conversation cannot gain an interactive capability");
  check(appButtons().length === 0 && writes.length === 0 && scope.fixtureErrors.length === 0, "retired history never offers an execution action or makes a request");
  return { checks: ["keyboard expansion", "exact historical IDs", "truncated-text reference", "retirement message", "no execution control", "zero network or writes"], writes };
};
scope.preparePluginAppCapture = async (theme: string) => {
  document.documentElement.dataset.theme = theme; await pause(300);
  const bounds = Array.from(document.querySelectorAll<HTMLElement>("[data-legacy-plugin-call]")).map(button => {
    const rect = button.getBoundingClientRect();
    check(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth, "retirement message stays within viewport");
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  check(document.documentElement.scrollWidth <= innerWidth, "no horizontal overflow");
  check(bounds.length === 2, "both live and history cards visible");
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bounds };
};
