import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import i18n from "../../app/manage-ui/src/i18n";
import immersiveStyles from "../../app/manage-ui/src/pages/immersive/ImmersiveChat.module.css";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

declare const __INPUT_FIXTURE__: { prompts: any[]; receipts: any[][] };
const { prompts, receipts } = __INPUT_FIXTURE__;
const state = window as any, now = Date.now(), runId = "input-run", key = "agent:shoggoth-default:input-fixture";
const immersive = new URLSearchParams(location.search).get("immersive") === "1";
const sessions = [{ key, agentId: "shoggoth-default", agentName: "Shoggoth", backendId: "shoggoth", updatedAt: now }];
const user = { id: "user-initial", role: "user", content: "帮我查询商品并确认订单。", timestamp: now };
const notes = ["先查询门店。", "已找到候选门店。", "请确认具体门店。", "已选门店，开始查询规格。", "已核对默认规格。", "请确认订单。", "按已确认规格创建订单。", "订单已生成，核对支付状态。"];
const toolTitles = ["检查候选门店", "核对商品规格", "核对订单状态"];
const answer = "订单已创建，待付款。[微信支付二维码](https://qr.fixture/transfer/qrcode?token=fixture-only)";
const canonical: any[] = [user];
const rawNote = (index: number) => ({ id: `note-${index}`, role: "assistant", timestamp: now + index + 1,
  content: [{ type: "text", text: notes[index], activity: true, segmentId: `note-${index}` }],
  shoggoth: { nativeUiVersion: 1, runId, displayId: `native-run:${runId}` } });
notes.forEach((_, index) => { canonical.push(rawNote(index)); if (index === 2) canonical.push(...receipts[0]); if (index === 5) canonical.push(...receipts[1]); });
const finalMessage = { id: "answer", role: "assistant", content: answer, timestamp: now + 100 };
canonical.push(finalMessage);
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", immersive ? "1" : "0");
void i18n.changeLanguage("zh-CN");
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await pause(10); }
};
const bodies = () => [...document.querySelectorAll<HTMLElement>(immersive ? `.${immersiveStyles.md}` : ".chat-thread .chat-bubble")]
  .flatMap(node => immersive && node.querySelector(".chat-md") ? [...node.querySelectorAll<HTMLElement>(".chat-md")] : [node])
  .filter(node => !node.closest(".chat-prompt") && !node.querySelector("[data-chat-activity-preview]") && node.textContent?.trim());
const sequence = () => bodies().map(node => node.textContent!.replace(/●/g, "").replace(/\s+/g, " ").trim());
const thread = () => document.querySelector<HTMLElement>(immersive ? `.${immersiveStyles.thread}` : ".chat-thread")!;
const previews = () => [...thread().querySelectorAll<HTMLElement>('[data-chat-activity-preview][data-status="running"]')];
const precedes = (first: HTMLElement, second: HTMLElement) => first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING;
const chat = (status: string, extra: any = {}) => state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId, state: status, ...extra } });
const tool = (index: number, phase: "start" | "result") => state.socket.emit({ type: "event", event: "session.tool", payload: {
  sessionKey: key, runId, data: { phase, toolCallId: `tool-${index}`, name: "shoggoth/memory_search",
    args: { activityTitle: toolTitles[index], query: "fixture" }, ...(phase === "result" ? { result: "完成" } : {}) },
} });
const emitNote = (index: number) => {
  chat("delta", { message: rawNote(index) });
  chat("interim", { message: rawNote(index) });
};
class Socket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(raw: string) {
    const req = JSON.parse(raw);
    if (req.method === "chat.respond") {
      const index = prompts.findIndex(prompt => prompt.requestId === req.params.requestId);
      check(req.params.answers.answer === (index === 0 ? "门店 A" : "确认下单"), "the original field answer is submitted once");
      state.replies = (state.replies || 0) + 1;
      // The Runtime can resume before the acknowledgement reaches the renderer.
      chat("promptExpire", { requestId: req.params.requestId });
      if (index === 1) { emitNote(6); state.earlyNote = true; }
      setTimeout(() => this.emit({ type: "res", id: req.id, ok: true, payload: {
        state: "responded", run: { id: runId, status: "running" }, requestId: req.params.requestId, messages: receipts[index],
      } }), 50);
      return;
    }
    const payload = req.method === "sessions.list" ? { sessions, hasMore: false }
      : req.method === "agents.list" ? { agents: [{ id: "shoggoth-default", name: "Shoggoth", backendId: "shoggoth" }] }
      : req.method === "chat.history" ? { messages: state.completed ? canonical : [user], hasMore: false, nextCursor: null, sourceId: key } : {};
    if (req.method === "chat.history" && state.completed) state.historyReloaded = true;
    setTimeout(() => this.emit({ type: "res", id: req.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = Socket;
state.fetch = async (url: unknown) => {
  const name = String(url);
  const payload = name.includes("/__api/status") ? { backends: [{ id: "shoggoth", connected: true }] }
    : name.includes("/__api/backends") ? { backends: [{ id: "shoggoth", surfaces: { agentHarness: true, chat: true } }] }
    : name.includes("runtime-models") ? { selection: { bindingId: "fixture", runtime: "codex", canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] }
    : name.includes("/archive") ? { archive: { supported: true, segments: [] } } : { items: [], servers: [] };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ChatPage /></UiProvider></HashRouter>);

state.runFixture = async () => {
  await wait(() => sequence().includes(user.content), "initial conversation");
  for (let index = 0; index < notes.length; index++) {
    if (!(index === 6 && state.earlyNote)) emitNote(index);
    await wait(() => sequence().includes(notes[index]), `progress ${index}`);
    if ([0, 3, 6].includes(index)) {
      const toolIndex = index / 3;
      tool(toolIndex, "start");
      await wait(() => previews()[0]?.textContent?.includes(toolTitles[toolIndex]), `live tool ${toolIndex}`);
      tool(toolIndex, "result");
    }
    if (index !== 2 && index !== 5) continue;
    const promptIndex = index === 2 ? 0 : 1;
    chat("prompt", { prompt: prompts[promptIndex] });
    await wait(() => document.querySelector(".chat-prompt__input"), "input card");
    const input = document.querySelector<HTMLTextAreaElement>(".chat-prompt__input")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, promptIndex === 0 ? "门店 A" : "确认下单");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pause(20);
    const submit = document.querySelector<HTMLButtonElement>(".chat-prompt__actions .is-primary")!;
    check(!submit.disabled, "the input can be submitted"); submit.click();
    const expectedAnswer = receipts[promptIndex][1].content[0].text;
    await wait(() => sequence().includes(expectedAnswer), "accepted answer is visible before the turn ends");
    const rows = sequence();
    check(rows.indexOf(notes[index]) < rows.indexOf(expectedAnswer), "pre-input progress stays before its answer");
    if (promptIndex === 1) check(rows.indexOf(expectedAnswer) < rows.indexOf(notes[6]), "early resumed output stays after its answer");
    const answerBubble = bodies()[rows.indexOf(expectedAnswer)];
    const [preview] = previews();
    check(previews().length === 1 && precedes(answerBubble, preview),
      `one live activity bubble follows accepted input ${promptIndex + 1}`);
    if (promptIndex === 1) check(precedes(preview, bodies()[rows.indexOf(notes[6])]),
      "the relocated activity appears before the early resumed progress bubble");
  }
  const scroller = thread();
  scroller.scrollTop = scroller.scrollHeight;
  const composer = document.querySelector("[data-chat-composer]")!;
  await wait(() => {
    const bubble = previews()[0]?.getBoundingClientRect();
    return bubble && bubble.height > 0 && bubble.top >= scroller.getBoundingClientRect().top
      && bubble.bottom <= composer.getBoundingClientRect().top;
  }, "the live activity is visible at the latest reply");
  previews()[0].click();
  const dialog = () => document.querySelector('[role="dialog"]');
  await wait(() => toolTitles.every(title => dialog()?.textContent?.includes(title)), "relocated activity opens the full turn timeline");
  dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("common.close")}"]`)?.click();
  await wait(() => !dialog(), "activity details close");
  chat("delta", { replyPhase: "final_answer", message: finalMessage });
  await wait(() => sequence().some(text => text.includes("订单已创建，待付款")), "streamed answer");
  check(previews().length === 0, "the final answer takes over from live activity");
  await pause(100);
  const before = sequence();
  check(notes.every(note => before.filter(text => text === note).length === 1), "all eight public progress bubbles remain exactly once");
  state.completed = true; chat("final", { message: finalMessage });
  await wait(() => state.historyReloaded, "canonical history refresh"); await pause(150);
  const after = sequence();
  check(JSON.stringify(before) === JSON.stringify(after), `completion preserves every body and its order: ${JSON.stringify({ before, after })}`);
  check(state.replies === 2, "each response is sent once");
  const image = document.querySelector<HTMLImageElement>(".markdown-qr-preview")!;
  check(image, "the final payment link has an inline image"); image.scrollIntoView({ block: "center" });
  await wait(() => image.complete && image.naturalWidth > 0, "QR preview loaded");
  image.click();
  await wait(() => document.querySelector(".chat-lightbox"), "the actual chat lightbox opens");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".chat-lightbox"), "lightbox closes");
  check(document.documentElement.scrollWidth <= innerWidth, "no page overflow");
  return { passed: true, immersive, width: innerWidth, progressBubbles: 8, inputBoundaries: 2, relocatedActivity: true,
    unchangedOrder: true, earlyResume: true, qrLightbox: true };
};
