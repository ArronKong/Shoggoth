import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage, { chatHistoryWindow } from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { runPageRefresh } from "../../app/manage-ui/src/lib/page-refresh";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __HISTORY_CASES__: Array<{ id: string; key: string; agentId: string; backendId: string; name: string }>;
const state = window as any, cases = __HISTORY_CASES__, now = 1800000000000;
const sessions = cases.map(row => ({ key: row.key, agentId: row.agentId, agentName: row.name, backendId: row.backendId, updatedAt: now }));
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", cases[0].key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
// These are already-read conversations: opening unread history intentionally
// pages to its first unread reply (covered by chat-cron-display-ui instead).
localStorage.setItem("shoggoth.chat.sessionUnread.v2", JSON.stringify({ since: now - 1000,
  read: Object.fromEntries(cases.map(row => [row.key, now + 1_000_000])), replies: {} }));
void i18n.changeLanguage("zh-CN");
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason?.stack || event.reason); });
const select = (key: string) => window.dispatchEvent(new CustomEvent("openclaw:open-chat-session", { detail: key }));
const control = async (key: string, action: string) => {
  const response = await fetch(`/fixture/control?${new URLSearchParams({ key, action })}`, { method: "POST" });
  if (!response.ok) throw Error("fixture control failed");
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider />
  <div className="history-fixture-toolbar"><strong>隔离历史分页验收</strong>
    {cases.map(row => <button key={row.key} type="button" onClick={() => select(row.key)}>{row.name}</button>)}
    <button type="button" onClick={() => void runPageRefresh("/chat")}>刷新</button>
    <span>181 条正文 · 工具、思考、心跳及隐藏输入</span>
  </div>
  <ChatPage />
</UiProvider></HashRouter>);

const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const thread = () => document.querySelector<HTMLElement>(".chat-thread")!;
const count = (id: string, element: Element = thread()) => new Set(element?.textContent?.match(new RegExp(`HIST_${id}_\\d{3}`, "g")) ?? []).size;
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out ${label}; current text: ${thread()?.textContent?.slice(0, 450)}`);
    await pause(15);
  }
  await frame();
};
const pageButton = (element: Element = thread()) => element.querySelector<HTMLButtonElement>('[data-testid="chat-history-earlier"]');
const stats = async () => (await fetch("/fixture/stats")).json();
const visibleAnchor = (element: HTMLElement, selector: string) => {
  const bounds = element.getBoundingClientRect();
  const node = Array.from(element.querySelectorAll<HTMLElement>(selector)).find(node => {
    const rect = node.getBoundingClientRect();
    return /HIST_/.test(node.textContent || "") && rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  return node ? { marker: node.textContent!.match(/HIST_\w+_\d{3}/)![0], top: node.getBoundingClientRect().top } : null;
};
async function earlier(id: string, expected: number, element: HTMLElement = thread(), immersive = false) {
  const button = pageButton(element)!;
  check(!!button && !button.disabled, `${id}: earlier button available`);
  button.scrollIntoView({ block: "start" }); await frame(); await pause(80);
  const selector = immersive ? "[data-immersive-message]" : ".chat-bubble";
  const anchor = visibleAnchor(element, selector);
  button.click();
  await wait(() => count(id, element) === expected && !pageButton(element)?.disabled, `${id}: ${expected} visible messages`);
  await pause(120); await frame();
  if (anchor) {
    const node = Array.from(element.querySelectorAll<HTMLElement>(selector)).find(node => node.textContent?.includes(anchor.marker));
    check(node && Math.abs(node.getBoundingClientRect().top - anchor.top) < 8,
      `${id}: prepend moved visible anchor by ${node ? node.getBoundingClientRect().top - anchor.top : "missing"}px`);
  }
  return !!anchor;
}
state.runNewSessionHistoryFixture = async () => {
  const results = [];
  for (const row of cases.slice(0, 3)) {
    select(row.key);
    await wait(() => count(row.id) === 50 && !!pageButton(), `${row.id}: parent history`);
    const input = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "/new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(() => !document.querySelector<HTMLButtonElement>('[data-send-entry="composerButton"]')?.disabled,
      `${row.id}: composer ready for /new`);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    let created;
    for (let attempt = 0; attempt < 150; attempt++) {
      created = (await stats()).created.find((item: any) => item.agentId === row.agentId);
      if (created && localStorage.getItem("shoggoth.chat.lastActive.v1") === created.key) break;
      await pause();
    }
    check(created && localStorage.getItem("shoggoth.chat.lastActive.v1") === created.key,
      `${row.id}: /new opens canonical session; created=${JSON.stringify(created)}; ${document.querySelector(".chat-shell")?.textContent?.slice(-800)}`);
    await pause(400); await frame();
    const checkEmpty = (element: Element = thread()) => {
      check(!element.querySelector(".chat-archive-bar"), `${row.id}: new session contains a history status: ${element.textContent}`);
      check(!element.querySelector(".chat-bubble, [data-immersive-message]"), `${row.id}: new session inherited old messages`);
    };
    checkEmpty();
    document.querySelector<HTMLButtonElement>('[data-testid="chat-immersive-enter"]')!.click();
    await wait(() => !!document.querySelector("[data-glass-clip]"), `${row.id}: empty immersive view`);
    checkEmpty(document.querySelector("[data-glass-clip]")!);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(() => !document.querySelector("[data-glass-clip]"), `${row.id}: exit immersive`);
    select(row.key); await wait(() => count(row.id) === 50, `${row.id}: old history preserved`);
    select(created.key); await wait(() => count(row.id) === 0, `${row.id}: reopen empty session`);
    await pause(400); checkEmpty();
    if (row.id === "hermes") check(!(await stats()).requests.some((request: any) => request.key === created.key),
      "fresh Hermes history must not query its unpersisted transcript");
    await control(created.key, "append");
    await wait(() => count(row.id) === 1 && !!thread().querySelector('[data-testid="chat-history-complete"]'),
      `${row.id}: first persisted message loads normally`);
    results.push({ backend: row.backendId, newSession: true, empty: true, immersive: true, reopened: true, firstMessage: true });
  }
  return results;
};
state.runHistoryFixture = async () => {
  // Exercise the production counter against body-less process and attachment rows.
  const boundary = Array.from({ length: 55 }, (_, index) => ({ id: `body-${index}`, role: "assistant", content: `body ${index}` }));
  boundary.splice(5, 0, { id: "process" , role: "assistant", content: [{ type: "thinking", thinking: "process" }] } as any);
  const window = chatHistoryWindow(boundary, 50, cases[0].key);
  check(window.count === 55 && window.start === 5, "counting retains process before the first selected answer");
  const results = [];
  for (const row of cases) {
    select(row.key);
    await wait(() => count(row.id) === 50 && !!pageButton() && !pageButton()!.disabled, `${row.id}: initial 50`);
    await pause(150);
    const initialWatches = (await stats()).watches.filter((key: string) => key === row.key).length;
    const anchored = await earlier(row.id, 100);
    check((await stats()).watches.filter((key: string) => key === row.key).length === initialWatches,
      `${row.id}: older page restarted a live watcher`);
    await control(row.key, "fail");
    pageButton()!.click();
    await wait(() => pageButton()?.textContent?.includes("重试"), `${row.id}: retry state`);
    check(count(row.id) === 100, `${row.id}: failed page erased existing messages`);
    await control(row.key, "retry");
    await earlier(row.id, 150);
    const oldest = thread().textContent!.match(new RegExp(`HIST_${row.id}_\\d{3}`))![0];
    await control(row.key, "append");
    await wait(() => count(row.id) === 151 && thread().textContent?.includes(`HIST_${row.id}_999`), `${row.id}: new arrival preserves expansion`);
    check(thread().textContent?.includes(oldest), `${row.id}: refresh lost expanded prefix`);
    await earlier(row.id, 182);
    check(!!thread().querySelector('[data-testid="chat-history-complete"]') && !pageButton(), `${row.id}: all-loaded state`);
    const other = cases.find(item => item.key !== row.key)!;
    select(other.key); await wait(() => count(other.id) === 50, "switch away");
    const observed: number[] = [];
    const observer = new MutationObserver(() => { if (thread()) observed.push(count(row.id)); });
    observer.observe(document.getElementById("root")!, { subtree: true, childList: true, characterData: true });
    select(row.key);
    await wait(() => count(row.id) === 50 && !!pageButton(), `${row.id}: reopen 50`);
    await pause(400); observer.disconnect();
    check(observed.every(value => value === 0 || value <= 50), `${row.id}: cached reopen flashed expanded history`);
    results.push({ reader: row.name, initial: 50, pages: [100, 150], afterArrival: 151, all: 182, reopen: 50, anchored });
  }
  const openclaw = cases[0];
  await control(openclaw.key, "fail");
  select(openclaw.key);
  await wait(() => count(openclaw.id) === 50 && !!thread().querySelector('[data-testid="chat-history-retry"]'),
    "cached history survives a failed first canonical page with a retry entry");
  check(!thread().querySelector('[data-testid="chat-history-complete"]'), "cached tail must not claim all history loaded");
  await control(openclaw.key, "retry");
  thread().querySelector<HTMLButtonElement>('[data-testid="chat-history-retry"]')!.click();
  await wait(() => count(openclaw.id) === 50 && !!pageButton()
    && !!thread().querySelector('[data-testid="chat-history-archive"]'), "archive session");
  for (const expected of [50, 100, 123]) {
    const button = thread().querySelector<HTMLButtonElement>('[data-testid="chat-history-archive"]')!;
    check(!!button, `archive paging entry retained before ${expected}`); button.click();
    await wait(() => count("archive") === expected, `archive ${expected}`);
    check(count(openclaw.id) === 50, "archive paging changed current transcript size");
  }
  const native = cases[2];
  select(native.key); await wait(() => count(native.id) === 50 && !!pageButton(), "immersive source");
  document.querySelector<HTMLButtonElement>('[data-testid="chat-immersive-enter"]')!.click();
  await wait(() => !!document.querySelector("[data-glass-clip] [data-testid=chat-history-earlier]"), "immersive history control");
  const immersiveThread = document.querySelector<HTMLElement>("[data-glass-clip]")!;
  check(count(native.id, immersiveThread) === 50, "immersive first page");
  await earlier(native.id, 100, immersiveThread, true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector("[data-glass-clip]"), "exit immersive");
  // A deliberately slow page completes after a session switch; it must not leak.
  select(native.key); await wait(() => count(native.id) === 50 && !!pageButton(), "race source reopened");
  await control(native.key, "slow");
  pageButton()!.click();
  select(cases[1].key);
  await wait(() => count("hermes") === 50, "switch during older read");
  await pause(1800);
  check(count(native.id) === 0 && count("hermes") === 50, "late older page overwrote another session");
  await control(native.key, "fast");
  select(native.key); await wait(() => count(native.id) === 50, "final initial window");
  return { passed: true, results, archive: [50, 100, 123], immersive: [50, 100], lateSwitch: true };
};
