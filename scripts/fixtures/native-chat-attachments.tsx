import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import { putFiles, getFiles } from "../../app/manage-ui/src/lib/imageCache";
import "../../app/manage-ui/src/styles.css";

// Real composer and history; all transports stay in this isolated fixture.
const state = window as any;
const agentId = "shoggoth-native";
const backendId = "shoggoth";
const key = `agent:${agentId}:11111111-1111-4111-8111-111111111111`;
const sessions: any[] = [{ key, agentId, agentName: "Codex · 原生聊天验证", backendId, model: "gpt-fixture", updatedAt: Date.now() }];
let rejectSettings = false;
const refs = [
  { id: "11111111-1111-4111-8111-111111111111", name: "图片.png", mimeType: "image/png", size: 68 },
  { id: "22222222-2222-4222-8222-222222222222", name: "需求文档.pdf", mimeType: "application/pdf", size: 16 },
];
let history: any[] = [
  { id: "user-original", role: "user", content: "结合这两个附件分析", shoggoth: { attachments: refs } },
  { id: "failed", role: "assistant", content: "", stopReason: "error", errorMessage: "测试用失败，可重试附件" },
];
const sent: any[] = [], slash: string[] = [];
const attachmentOpens: { name: string; content: string }[] = [];
let failAttachmentOpen = false;
const originalFetch = window.fetch.bind(window);
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    let payload: any = {};
    if (request.method === "sessions.list") payload = { sessions, hasMore: false };
    if (request.method === "agents.list") payload = { agents: [{ id: agentId, name: sessions[0].agentName, backendId }] };
    if (request.method === "sessions.patch") {
      if (rejectSettings) {
        setTimeout(() => this.emit({ type: "res", id: request.id, ok: false, error: { message: "测试用设置失败" } }), 0);
        return;
      }
      Object.assign(sessions[0], request.params);
      payload = { entry: { thinkingLevel: sessions[0].thinkingLevel, fastMode: sessions[0].fastMode }, scope: "session" };
    }
    if (request.method === "chat.history") payload = { messages: history };
    if (request.method === "chat.send") {
      sent.push(request.params);
      payload = { runId: request.params.idempotencyKey };
      if (sent.length === 3) {
        setTimeout(() => this.emit({ type: "event", event: "chat", payload: { sessionKey: key,
          runId: request.params.idempotencyKey, state: "error", errorMessage: "测试用上传失败，请重试" } }), 30);
        setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
        return;
      }
      history = [{ id: `user-${sent.length}`, role: "user", content: request.params.message },
        { id: `reply-${sent.length}`, role: "assistant", content: "附件与消息已送达测试执行端。" }];
      setTimeout(() => this.emit({ type: "event", event: "chat", payload: { sessionKey: key,
        runId: request.params.idempotencyKey, state: "final", message: history[1] } }), 30);
    }
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.startsWith("data:")) return originalFetch(pathname);
  if (pathname.startsWith("/__api/inspirations/media?")) return new Response("%PDF-1.7\nfixture");
  if (pathname.startsWith("/__api/host/open-attachment?")) {
    attachmentOpens.push({ name: new URL(pathname, "http://fixture").searchParams.get("name")!, content: await (init!.body as Blob).text() });
    return new Response(JSON.stringify(failAttachmentOpen ? { error: "File opener failed" } : { ok: true }), {
      status: failAttachmentOpen ? 500 : 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (pathname.includes("/slash/exec")) slash.push(String(init?.body));
  const payload = pathname.includes("/chat/capabilities") ? { attachments: { image: { maxBytes: 10485760 }, pdf: { maxBytes: 52428800 }, file: { maxBytes: 52428800 } },
    slash: true, maxPromptBytes: 61440, maxAttachments: 8, maxAttachmentBytes: 52428800 }
    : pathname.includes("/chat/slash") ? { supported: true, commands: [{ name: "compact", source: "Codex", execution: "runtime", category: "tools", description: "Compact" }] }
    : pathname.includes("/__api/status") ? { backends: [{ id: backendId, connected: true, info: { readyAgentIds: [agentId] } }] }
    : pathname.includes("/__api/backends") ? { backends: [{ id: backendId, surfaces: { agentHarness: true, chat: true } }] }
    : pathname.includes("/__api/models?") ? { backendId, catalogRevision: "a".repeat(64), models: [{ id: "gpt-fixture", name: "GPT Fixture", provider: "codex", backendId,
      reasoning: true, fast: true, thinkingOptions: ["low", "medium", "high"], thinkingDefault: "medium" }] }
    : pathname.includes("/archive") ? { archive: { supported: false, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const pdf = btoa("%PDF-1.7\nfixture");
state.openclawDesktop = { readClipboardFiles: async () => [{ fileName: "Finder 文件.pdf", mimeType: "application/pdf", content: pdf }] };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string, timeoutMs = 7000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await pause(20); }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const input = () => document.querySelector<HTMLTextAreaElement>(".chat-composer__input")!;
const setInput = async (text: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new Event("input", { bubbles: true })); await pause(40);
};
const paste = (withFiles: boolean, text = "") => {
  const data = new DataTransfer();
  if (text) data.setData("text/plain", text);
  if (withFiles) {
    data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "中文 图片.png", { type: "image/png" }));
    data.items.add(new File(["%PDF-1.7\nfixture"], "需求文档.pdf", { type: "application/pdf" }));
  }
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  return event;
};
const pending = () => document.querySelectorAll(".chat-att-row--pending .chat-att-chip").length;
const submit = async (count: number) => {
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click();
  await wait(() => sent.length === count, "chat.send");
  await wait(() => !document.querySelector(".chat-stop"), "turn complete"); await pause(120);
};
const clipboardChecks = async () => {
  await wait(() => !document.querySelector(".chat-toast"), "earlier notices expire", 8500);
  const readFiles = state.openclawDesktop.readClipboardFiles;
  const errorToast = () => document.querySelector<HTMLElement>(".chat-toast--error");
  try {
    state.openclawDesktop.readClipboardFiles = async () => [];
    await setInput("保留草稿：");
    check(!paste(false, "复制的文字 /Users/example/report.pdf").defaultPrevented, "plain text keeps native paste behavior");
    // Synthetic paste events do not insert text, so model the browser's default edit.
    await setInput("保留草稿：复制的文字 /Users/example/report.pdf");
    check(!errorToast() && pending() === 0, "text paste creates no error or attachment");

    state.openclawDesktop.readClipboardFiles = async () => { throw Error("测试用剪贴板读取失败"); };
    paste(false);
    await wait(() => errorToast(), "clipboard failure notice");
    check(errorToast()?.getAttribute("role") === "alert", "errors announce an accessible alert");
    check(input().value === "保留草稿：复制的文字 /Users/example/report.pdf", "clipboard failure preserves the draft");
    const close = document.querySelector<HTMLButtonElement>(".chat-toast__dismiss")!;
    check(close.getAttribute("aria-label") === i18n.t("common.close"), "error close button has an accessible label");
    check(getComputedStyle(close).pointerEvents === "auto", "error close button accepts pointer input");
    close.click();
    await wait(() => !errorToast(), "manual error dismissal");

    paste(false);
    await wait(() => errorToast(), "first timed error");
    await pause(3700);
    paste(false);
    await pause(3600);
    check(errorToast(), "an earlier error timer must not dismiss an identical newer error");
    await wait(() => !errorToast(), "clipboard error automatically expires", 4500);

    let rejectRead!: (error: Error) => void;
    state.openclawDesktop.readClipboardFiles = () => new Promise((_resolve, reject) => { rejectRead = reject; });
    paste(false);
    window.location.hash = "/chat?session=agent:shoggoth-native:22222222-2222-4222-8222-222222222222";
    await pause(80);
    rejectRead(Error("另一个会话中已过期的剪贴板错误"));
    await pause(80);
    check(!errorToast(), "late clipboard failures must not appear in another conversation");
    window.location.hash = `/chat?session=${encodeURIComponent(key)}`;
    await pause(80);
  } finally {
    state.openclawDesktop.readClipboardFiles = readFiles;
  }
};
state.runFixture = async () => {
  await wait(() => input() && document.querySelector(".chat-retrybtn"), "native history");
  const historyFile = document.querySelector<HTMLButtonElement>(".is-sent .chat-att-chip__open")!;
  historyFile.click();
  await wait(() => attachmentOpens.length === 1, "history attachment opens");
  check(attachmentOpens[0].name === "需求文档.pdf" && attachmentOpens[0].content === "%PDF-1.7\nfixture", "history click opens the original bytes");
  const fileData = new DataTransfer();
  fileData.items.add(new File(["first content"], "11README.md", { type: "text/markdown" }));
  fileData.items.add(new File(["second content"], "11README.md", { type: "text/markdown" }));
  input().dispatchEvent(new ClipboardEvent("paste", { clipboardData: fileData, bubbles: true, cancelable: true }));
  await wait(() => pending() === 2, "file drafts");
  const fileButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-att-row--pending .chat-att-chip__open"));
  const chip = fileButtons[0].parentElement!;
  check(getComputedStyle(chip).borderRadius === "999px" && getComputedStyle(chip).backgroundColor === "rgba(0, 0, 0, 0)", "file chips are transparent capsules");
  fileButtons[0].focus();
  check(getComputedStyle(chip).backgroundColor === "rgba(0, 0, 0, 0.05)", "focused file has five percent black background");
  fileButtons[0].click();
  await wait(() => attachmentOpens.length === 2, "first draft opens");
  fileButtons[1].click();
  await wait(() => attachmentOpens.length === 3, "second draft opens");
  check(attachmentOpens[1].content === "first content" && attachmentOpens[2].content === "second content", "same-name drafts open their own content");
  failAttachmentOpen = true;
  fileButtons[0].click();
  await wait(() => document.querySelector(".chat-toast--error")?.textContent?.includes("File opener failed"), "failed open is visible");
  failAttachmentOpen = false;
  document.querySelector<HTMLButtonElement>(".chat-toast__dismiss")!.click();
  const openCount = attachmentOpens.length;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".chat-att-row--pending .chat-att-x")) button.click();
  await wait(() => pending() === 0, "draft removal");
  check(attachmentOpens.length === openCount, "remove never opens a file");
  const repeatedTextKey = `files::fixture::${crypto.randomUUID()}`;
  const firstFiles = [{ name: "same.md", kind: "file", src: "data:text/plain;base64,Zmlyc3Q=" }];
  await putFiles(repeatedTextKey, firstFiles);
  check((await getFiles(repeatedTextKey))?.[0].src === firstFiles[0].src, "unambiguous cached file retains its source");
  await putFiles(repeatedTextKey, [{ ...firstFiles[0], src: "data:text/plain;base64,c2Vjb25k" }]);
  check(await getFiles(repeatedTextKey) === undefined, "repeated message text must not open another attachment's bytes");
  await putFiles(repeatedTextKey, firstFiles);
  check(await getFiles(repeatedTextKey) === undefined, "ambiguous history cache stays unavailable");
  await wait(() => document.querySelector(".chat-pill--think"), "native thinking options");
  const thinking = document.querySelector<HTMLButtonElement>(".chat-pill--think")!;
  const inheritedThinking = i18n.t("chat.thinkingInherited", { level: i18n.t("chat.thinkLevel.medium") });
  const thinkingOptions = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .filter(option => option.getClientRects().length > 0);
  const optionLabel = (option: HTMLElement) => option.textContent?.replace(/✓/g, "").trim();
  thinking.click();
  await wait(() => thinking.getAttribute("aria-expanded") === "true" && thinkingOptions().length === 4, "thinking menu");
  check(thinkingOptions().map(optionLabel).join(",") === [inheritedThinking,
    ...["low", "medium", "high"].map(level => i18n.t(`chat.thinkLevel.${level}`))].join(","), "only advertised effort levels appear");
  thinkingOptions().find(option => optionLabel(option) === i18n.t("chat.thinkLevel.high"))!
    .dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "", detail: 0 }));
  await wait(() => sessions[0].thinkingLevel === "high", "persist thinking"); await pause(40);
  await wait(() => thinkingOptions().length === 0, "thinking menu closes after selection");
  thinking.click();
  await wait(() => thinking.getAttribute("aria-expanded") === "true" && thinkingOptions().length === 4, "reopen thinking menu");
  thinkingOptions().find(option => optionLabel(option) === inheritedThinking)!
    .dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "", detail: 0 }));
  await wait(() => sessions[0].thinkingLevel === null, "reset thinking"); await pause(40);
  check(thinking.textContent === inheritedThinking, "inherited thinking clears the old selection");
  const fast = document.querySelector<HTMLButtonElement>(".chat-pill--fast")!;
  fast.click(); await wait(() => fast.classList.contains("is-active"), "persist fast mode");
  rejectSettings = true; fast.click(); await pause(100);
  check(fast.classList.contains("is-active"), "failed fast change keeps the applied state");
  rejectSettings = false; fast.click(); await wait(() => !fast.classList.contains("is-active"), "reset fast mode");
  document.querySelector<HTMLButtonElement>(".chat-retrybtn")!.click();
  await wait(() => sent.length === 1, "attachment retry");
  check(JSON.stringify(sent[0].attachments) === JSON.stringify(refs.map(nativeRef => ({ nativeRef }))), "retry retains image AND PDF references");
  await wait(() => !document.querySelector(".chat-stop"), "retry complete"); await pause(120);
  await setInput("/Users/example/Downloads/中文 图片.png"); await submit(2);
  check(sent[1].message === "/Users/example/Downloads/中文 图片.png" && slash.length === 0, "absolute path must use chat.send");
  paste(true); await wait(() => pending() === 2, "image and PDF paste");
  await submit(3);
  check(sent[2].attachments.length === 2 && sent[2].attachments.some((item: any) => item.mimeType === "application/pdf"), "both pasted file types reach transport");
  await wait(() => document.querySelector(".chat-retrybtn"), "failed upload retry");
  document.querySelector<HTMLButtonElement>(".chat-retrybtn")!.click();
  await wait(() => sent.length === 4, "failed upload resend");
  check(JSON.stringify(sent[3].attachments) === JSON.stringify(sent[2].attachments), "upload failure retains all original bytes");
  await wait(() => !document.querySelector(".chat-stop"), "upload retry complete"); await pause(120);
  paste(false); await wait(() => pending() === 1, "Finder bridge paste"); await submit(5);
  check(sent[4].attachments[0].fileName === "Finder 文件.pdf", "Finder filename survives");
  await clipboardChecks();
  await setInput("中".repeat(22000));
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click(); await pause(100);
  check(sent.length === 5 && input().value.length === 22000, "oversized UTF-8 text must retain draft without sending");
  await setInput("请结合图片和 PDF，帮我分析需求。"); paste(true);
  await wait(() => pending() === 2, "preview draft");
  return { passed: true, checks: ["native thinking options and reset", "fast settings and failure state", "history image/PDF retry", "absolute path routing", "mixed file paste", "failed-upload retry with original bytes", "Finder clipboard bridge", "plain text paste", "clipboard errors preserve drafts", "error dismissal and timer renewal", "late clipboard failure isolation", "UTF-8 budget and draft retention"] };
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
document.getElementById("run-checks")!.onclick = async () => {
  const status = document.getElementById("status")!;
  try { status.textContent = JSON.stringify(await state.runFixture()); } catch (error) { status.textContent = String(error); }
};
