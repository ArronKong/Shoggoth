import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import GroupChatPanel from "../../app/manage-ui/src/pages/GroupChatPanel";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import { getSnapshot, groupId, first, second } from "./group-message-stop-preview-data.cjs";
import { createPreviewSendApi } from "./group-message-stop-preview-api";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

const state = window as any, options = new URLSearchParams(location.search);
const scene = options.get("scene") || "messages", step = Number(options.get("step") || 0);
const snapshot = getSnapshot(scene, step), view = snapshot.view;
view.ownerScope = "isolated-preview-" + crypto.randomUUID();
const messages = snapshot.messages;
const sendApi = createPreviewSendApi(view, messages);
const quietTurn = (turn: any) => turn.stopping || turn.recovery?.cancelRequested || turn.recovery?.type === "execution"
  || ["idle", "stopped"].includes(turn.releasedReason);
let localActions = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 15));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 8000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (performance.now() > deadline) throw Error(label); await pause(); }
};
const notify = (type: string, extra = {}) => parent.postMessage({ source: "shoggoth-group-preview", scene, step,
  token: options.get("token"), type, ...extra }, location.origin);
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  const request = new URL(String(url), location.href), pathname = request.pathname;
  const receipt = await sendApi(request, init);
  if (receipt) {
    if (init.method === "POST") localActions++;
    return receipt;
  }
  let payload: any = {};
  if (init.method && init.method !== "GET") {
    localActions++;
    if (pathname.endsWith("/discussion/stop")) {
      if (snapshot.pendingRequest) return new Promise<Response>(() => {});
      notify("action", { action: "stop-group" });
      return new Response(JSON.stringify(view), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "这是界面预览，请使用外层流程控件查看状态。" }), { status: 409,
      headers: { "Content-Type": "application/json" } });
  }
  if (pathname.endsWith("/detail")) payload = view;
  else if (pathname.endsWith("/members/role-history")) payload = { snapshots: [], nextCursor: null, hasMore: false };
  else if (pathname.endsWith("/members/role")) payload = { ok: true, text: "隔离预览中的示例成员，不读取真实角色文档。",
    disclosure: "verbatim", revisionId: "preview-role", nextCursor: null };
  else if (pathname.endsWith("/messages")) {
    const after = request.searchParams.get("afterSeq"), revision = request.searchParams.get("afterRevision");
    payload = { messages: messages.filter((item: any) => after === null || item.seq > Number(after)), hasMore: false,
      revision: view.group.messageRevision, ...(revision !== null ? { updates: messages.filter((item: any) => item.revision > Number(revision)), hasMoreUpdates: false } : {}) };
  }
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
await i18n.changeLanguage("zh-CN");
document.documentElement.dataset.theme = options.get("theme") || "light";
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider />
  <GroupChatPanel groupId={groupId} onArchived={() => {}} />
</UiProvider></HashRouter>);

state.previewPromise = (async () => {
  await wait(() => document.querySelector("[data-group-timeline]")
    && document.querySelector('[data-group-composer-input][contenteditable="plaintext-only"]'), "production group panel ready");
  if (snapshot.pendingRequest) {
    (document.querySelector("button.chat-stop") as HTMLButtonElement).click();
    await wait(() => document.querySelector('button.chat-stop[aria-busy="true"]'), "stop request busy state");
  }
  await wait(() => [...document.querySelectorAll<HTMLImageElement>("[data-avatar-state] img")].every(item => item.complete), "bundled avatar load");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  state.previewReady = true;
  const result = state.inspectPreview(); notify("ready", { result }); return result;
})().catch((error: Error) => { state.fixtureError = error.stack; notify("error", { text: error.message }); throw error; });

state.inspectPreview = () => {
  const timeline = document.querySelector<HTMLElement>("[data-group-timeline]")!;
  check(Boolean(timeline), "timeline exists");
  check(!document.body.textContent?.includes("GROUP_JOURNAL_FULL") && !document.body.textContent?.includes("发送日志暂不可写"),
    "preview journal is isolated and writable");
  check(!document.querySelector("[data-group-status]"), "composer contains no member execution status strip");
  check(!timeline.querySelector("[data-group-stop-turn], button.chat-stop"), "the timeline has no stop button");
  const stopButtons = document.querySelectorAll<HTMLButtonElement>("button.chat-stop");
  check(stopButtons.length <= 1 && [...stopButtons].every(button => button.closest("[data-chat-composer]")),
    "the composer is the only stop entry point");
  if (!snapshot.pendingRequest && view.activeTurns.some((turn: any) => !turn.stopping && !turn.recovery?.cancelRequested)) {
    check(stopButtons.length === 1 && !stopButtons[0].disabled, "running turns can be stopped from the composer");
  }
  check(!document.querySelector("[data-chat-composer] [role=status], [data-chat-composer] [role=alert], [data-chat-composer] [data-group-send-journal]"),
    "composer contains no operational status or send recovery records");
  check(!timeline.textContent?.includes("接下来："), "queued speaker names stay out of the message area");
  check(![...document.querySelectorAll("button")].some(button => ["重新核对", "重新读取"].includes(button.textContent?.trim() || "")),
    "recovery has no manual reconciliation action");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "fixture has no horizontal overflow");
  check(document.querySelector("[data-chat-composer]")!.getBoundingClientRect().bottom <= innerHeight + 1, "composer stays in frame");
  for (const item of messages) {
    if (item.author.kind === "system") {
      const text = item.system.eventType === "turn_failed" ? item.system.errorCode : "已结束 虾长老 的本次发言";
      check(timeline.textContent?.includes(text), "system result remains visible: " + item.system.eventType);
    } else check(Boolean(timeline.querySelector(`[data-seq="${item.seq}"]`)), "message survives projection: " + item.seq);
  }
  for (const item of view.activeTurns.filter((turn: any) => !quietTurn(turn))) check(Boolean(timeline.querySelector(`[data-group-execution="${item.opportunityId}"]`))
    || Boolean(timeline.querySelector(`[data-seq] .is-streaming`)), "active reply or recovery remains visible");
  const bubbles = [...timeline.querySelectorAll<HTMLElement>(".chat-md")].map(item => item.textContent?.trim());
  if (scene === "messages") {
    check(bubbles.filter(text => text === first).length === 1, "first source segment appears exactly once");
    if (step > 0) check(bubbles.filter(text => text === second).length === 1, "second source segment appears exactly once");
  }
  if (scene === "group-stop" && step === 3) {
    check(!document.querySelector("button.chat-stop"), "completed whole-group stop restores Send");
    check(!timeline.querySelector("[data-group-execution]"), "whole-group stop leaves no next speaker");
  }
  for (const turn of view.activeTurns) {
    if (quietTurn(turn)) {
      check(!timeline.querySelector(`[data-group-execution="${turn.opportunityId}"]`), "quiet recovery and stopping leave no bubble or orphan author row");
      check(!/原任务状态异常已持续|启动回执暂未收到|暂时无法获取原任务状态|正在停止原任务/.test(timeline.textContent || ""), "execution recovery copy stays out of the timeline");
    }
    if (turn.releasedReason === "stopped") {
      check(!document.querySelector("[data-chat-composer]")!.textContent?.includes("正在确认任务是否已退出"), "member cleanup does not create a composer confirmation notice");
    }
  }
  if (scene === "failure" && step > 0) {
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "重试")!;
    check(Boolean(retry), "failure keeps Retry");
    check(parseFloat(getComputedStyle(retry).borderRadius) >= retry.getBoundingClientRect().height / 2, "Retry has fully rounded ends");
  }
  if (snapshot.pendingRequest) check(document.querySelector<HTMLButtonElement>("button.chat-stop")?.disabled, "in-flight stop button is disabled");
  return { passed: true, scene, step, localActions, realProviderCalls: 0,
    requiredHeight: innerHeight + Math.max(0, timeline.scrollHeight - timeline.clientHeight),
    active: view.activeTurns.map((item: any) => item.memberId), queued: view.queuedMemberIds,
    firstCount: bubbles.filter(text => text === first).length, secondCount: bubbles.filter(text => text === second).length,
    messages: messages.length, stopVisible: Boolean(document.querySelector("button.chat-stop")), text: timeline.textContent?.trim() };
};
