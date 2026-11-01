import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import GroupChatPanel from "../../app/manage-ui/src/pages/GroupChatPanel";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { emitGroupChanged } from "../../app/manage-ui/src/lib/groupChat";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

declare const GROUP_TIMELINE_DATA: any[];
const state = window as any, options = new URLSearchParams(location.search), snapshots = GROUP_TIMELINE_DATA;
const root = createRoot(document.getElementById("root")!);
let stage = Math.min(4, Math.max(0, Number(options.get("stage") ?? 3))), generation = 0;
let ownerScope = "timeline-preview-" + crypto.randomUUID(), writes = 0;
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = performance.now() + 8000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (performance.now() > deadline) throw Error(label); await pause(); }
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { state.copied = text; } } });
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected fixture write " + url); }
  const request = new URL(String(url), location.href), snapshot = snapshots[stage];
  let payload: any = {};
  if (request.pathname.endsWith("/detail")) payload = { ...snapshot.view, ownerScope };
  if (request.pathname.endsWith("/messages")) {
    const after = request.searchParams.get("afterSeq"), revision = request.searchParams.get("afterRevision"), limit = Number(request.searchParams.get("limit") || 50);
    const rows = snapshot.messages.filter((message: any) => after === null || message.seq > Number(after));
    payload = { messages: rows.slice(0, limit), hasMore: rows.length > limit, revision: snapshot.view.group.messageRevision };
    if (revision !== null) {
      const updates = snapshot.messages.filter((message: any) => message.revision > Number(revision)).sort((a: any, b: any) => a.revision - b.revision);
      payload.updates = updates.slice(0, limit); payload.hasMoreUpdates = updates.length > limit;
      payload.revision = payload.updates.at(-1)?.revision ?? Number(revision);
    }
  }
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
await i18n.changeLanguage(options.get("language") || "zh-CN");
document.documentElement.dataset.theme = options.get("theme") || "light";
const render = () => root.render(<HashRouter><UiProvider><ScrollbarProvider />
  <GroupChatPanel key={generation} groupId={snapshots[0].view.group.id} onArchived={() => {}} /></UiProvider></HashRouter>);
render();
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-group-timeline] [data-seq]")].filter(row => row.querySelector("[data-group-author]"));
const snapshotRows = () => rows().map(row => ({ seq: Number(row.dataset.seq), text: row.querySelector(".chat-md")?.textContent?.trim(),
  time: row.querySelector("time")?.getAttribute("datetime"), label: row.querySelector("time")?.textContent }));
state.advanceTimeline = async (next: number) => {
  stage = next; emitGroupChanged(snapshots[0].view.group.id);
  await wait(() => rows().length === [0, 1, 2, 3, 3][next], "independent messages arrive in order");
  if (next === 4) await wait(() => rows()[2].textContent?.includes("完成，结果已整理好") && !document.querySelector(".chat-cursor"), "final update reaches the existing A2 bubble");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return snapshotRows();
};
state.runTimelineFixture = async () => {
  await wait(() => document.querySelector('[data-chat-composer] textarea:not(:disabled)'), "panel ready");
  if (options.get("test") === "1") {
    await state.advanceTimeline(1);
    const first = rows()[0], firstTime = first.querySelector("time")?.getAttribute("datetime"), firstText = first.querySelector(".chat-md")?.textContent;
    await state.advanceTimeline(2); const second = rows()[1], secondTime = second.querySelector("time")?.getAttribute("datetime");
    check(rows()[0] === first && first.querySelector(".chat-md")?.textContent === firstText, "B1 does not replace A1 or its DOM identity");
    await state.advanceTimeline(3); const third = rows()[2], thirdTime = third.querySelector("time")?.getAttribute("datetime");
    check(snapshotRows().map(item => item.text?.slice(0, 2)).join(",") === "A1,B1,A2", "A1/B1/A2 interleave instead of grouping by Agent");
    check(Boolean(firstTime && secondTime && thirdTime && firstTime < secondTime && secondTime < thirdTime), "each bubble has an independent publication time");
    check(rows().every(row => row.querySelectorAll(".chat-bubble").length === 1), "each timestamp belongs to exactly one reply bubble");
    await state.advanceTimeline(4);
    check(rows()[0] === first && rows()[1] === second && rows()[2] === third, "terminal settlement preserves all message identities");
    check(rows()[0].querySelector("time")?.getAttribute("datetime") === firstTime && rows()[2].querySelector("time")?.getAttribute("datetime") === thirdTime,
      "final text cannot move a bubble or change its publication time");
    (rows()[1].querySelector('button.chat-copybtn') as HTMLButtonElement).click();
    await wait(() => state.copied?.startsWith("B1："), "copy belongs to the individual B1 message");
    check(!state.copied.includes("A1") && !state.copied.includes("A2"), "copy never includes the other Agent's replies");
    const before = snapshotRows(); ownerScope = "timeline-reopen-" + crypto.randomUUID(); generation++; render();
    await wait(() => rows().length === 3 && document.querySelector('[data-chat-composer] textarea:not(:disabled)'), "reopen group");
    check(JSON.stringify(snapshotRows()) === JSON.stringify(before), "reopening restores the same messages, order and times");
  }
  check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal overflow");
  check(writes === 0, "preview never writes to real APIs");
  state.previewReady = true;
  return { passed: true, stage, messages: snapshotRows(), writes };
};
state.timelinePromise = state.runTimelineFixture().catch((error: Error) => { state.fixtureError = error.stack; throw error; });
