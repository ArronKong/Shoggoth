import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import { putFiles, getFiles, fileCacheKey, imgCacheKey, putImages } from "../../app/manage-ui/src/lib/imageCache";
import "../../app/manage-ui/src/styles.css";

// Real composer and history; all transports stay in this isolated fixture.
const state = window as any;
const operationHistory = location.search === "?operation-history";
const agentId = operationHistory ? "attachment-fixture" : "shoggoth-native";
const backendId = operationHistory ? "openclaw" : "shoggoth";
const key = `agent:${agentId}:11111111-1111-4111-8111-111111111111`;
const sessions: any[] = [{ key, agentId, agentName: "Codex · 原生聊天验证", backendId, model: "gpt-fixture", updatedAt: Date.now() }];
let rejectSettings = false;
const refs = [
  { id: "11111111-1111-4111-8111-111111111111", name: "图片.png", mimeType: "image/png", size: 68 },
  { id: "22222222-2222-4222-8222-222222222222", name: "需求文档.pdf", mimeType: "application/pdf", size: 16 },
];
const pagesRef = { id: "33333333-3333-4333-8333-333333333333", name: "示例文档.pages", mimeType: "application/octet-stream", size: 14 };
const pages = "PK-pages-bytes";
let history: any[] = [
  { id: "user-original", role: "user", content: "结合这两个附件分析", shoggoth: { attachments: refs } },
  { id: "failed", role: "assistant", content: "", stopReason: "error", errorMessage: "测试用失败，可重试附件" },
];
const sent: any[] = [], slash: string[] = [];
const attachmentReveals: { name: string; content: string }[] = [];
let failAttachmentReveal = false;
let failMediaRead = false;
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
    if (request.method === "chat.history") payload = { messages: history, hasMore: false, nextCursor: null, sourceId: "attachment-fixture" };
    if (request.method === "chat.operation.get") {
      const known = sent.some(row => row.idempotencyKey === request.params.idempotencyKey);
      payload = known ? { status: "found", stateAuthority: "native-service", admissionAccepted: true, run: { status: "completed" } }
        : { status: "not_found" };
    }
    if (request.method === "chat.send") {
      sent.push(request.params);
      payload = { runId: request.params.idempotencyKey };
      if (sent.length === 3) {
        setTimeout(() => this.emit({ type: "res", id: request.id, ok: false,
          error: { code: "CHAT_ATTACHMENT_INVALID", message: "测试用上传失败，请重试" } }), 0);
        return;
      }
      const user = { id: `user-${sent.length}`, role: "user", content: request.params.message };
      const reply = { id: `reply-${sent.length}`, role: "assistant", content: "附件与消息已送达测试执行端。" };
      if (operationHistory) {
        history.push({ ...user, content: user.content || "[User sent media without caption]",
          idempotencyKey: `${request.params.idempotencyKey}:user`, __openclaw: { media: request.params.attachments?.map((item: any) => ({
            type: item.type, fileName: item.fileName, mimeType: item.mimeType,
          })) } }, reply);
      } else history = [user, reply];
      setTimeout(() => this.emit({ type: "event", event: "chat", payload: { sessionKey: key,
        runId: request.params.idempotencyKey, state: "final", message: reply } }), 30);
    }
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (pathname.startsWith("data:")) return originalFetch(pathname);
  if (pathname.startsWith("/__api/inspirations/media?")) {
    if (failMediaRead) return new Response(null, { status: 404 });
    const id = new URL(pathname, "http://fixture").searchParams.get("id");
    if (id === refs[0].id) {
      return new Response(Uint8Array.from(atob(png), c => c.charCodeAt(0)), { headers: { "Content-Type": "image/png" } });
    }
    if (id === pagesRef.id) return new Response(pages, { headers: { "Content-Type": pagesRef.mimeType } });
    return new Response("%PDF-1.7\nfixture", { headers: { "Content-Type": "application/pdf" } });
  }
  if (pathname.startsWith("/__api/host/reveal-attachment?")) {
    attachmentReveals.push({ name: new URL(pathname, "http://fixture").searchParams.get("name")!, content: await (init!.body as Blob).text() });
    return new Response(JSON.stringify(failAttachmentReveal ? { error: "Finder reveal failed" } : { ok: true }), {
      status: failAttachmentReveal ? 500 : 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (pathname.includes("/slash/exec")) slash.push(String(init?.body));
  const payload = pathname.endsWith("/chat/secrets/prepare") ? { text: JSON.parse(String(init?.body)).text, references: [], version: 1 }
    : pathname.includes("/chat/capabilities") ? { attachments: { image: { maxBytes: 10485760 }, pdf: { maxBytes: 52428800 }, file: { maxBytes: 52428800 } },
    slash: true, maxPromptBytes: 61440, maxAttachments: 8, maxAttachmentBytes: 52428800 }
    : pathname.includes("/chat/slash") ? { supported: true, commands: [{ name: "compact", source: "Codex", execution: "runtime", category: "tools", description: "Compact" }] }
    : pathname.includes("/__api/status") ? { backends: [{ id: backendId, connected: true, info: { readyAgentIds: [agentId] } }] }
    : pathname.includes("/__api/backends") ? { backends: [{ id: backendId, surfaces: { agentHarness: !operationHistory, chat: true } }] }
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
  const editor = input();
  editor.focus();
  editor.dispatchEvent(event);
  return event;
};
const pending = () => document.querySelectorAll(".chat-att-row--pending .chat-att-chip").length;
const submit = async (count: number) => {
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click();
  await wait(() => sent.length === count, `chat.send ${count}`).catch(error => {
    throw Error(`${error.message}; sent=${sent.length}; ${document.querySelector('.chat-toast')?.textContent ?? ""}`);
  });
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
    await pause(40);

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
state.runFileRevealFixture = async () => {
  await wait(() => input() && document.querySelector(".chat-retrybtn"), "native history");
  const historyFile = document.querySelector<HTMLButtonElement>(".chat-thread .chat-file-button")!;
  historyFile.click();
  await wait(() => attachmentReveals.length === 1, "history attachment reveals");
  check(attachmentReveals[0].name === "需求文档.pdf" && attachmentReveals[0].content === "%PDF-1.7\nfixture", "history click reveals the original bytes");
  const fileData = new DataTransfer();
  fileData.items.add(new File(["first content"], "11README.md", { type: "text/markdown" }));
  fileData.items.add(new File(["second content"], "11README.md", { type: "text/markdown" }));
  input().dispatchEvent(new ClipboardEvent("paste", { clipboardData: fileData, bubbles: true, cancelable: true }));
  await wait(() => pending() === 2, "file drafts");
  const fileButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-att-row--pending .chat-att-chip__open"));
  const chip = fileButtons[0].parentElement!;
  const style = getComputedStyle(chip);
  check(style.borderTopLeftRadius === "24px" && style.borderTopRightRadius === "24px"
    && style.borderBottomLeftRadius === "24px" && style.borderBottomRightRadius === "24px"
    && style.borderTopWidth === "0px" && style.backgroundColor !== "rgba(0, 0, 0, 0)", "file chips use the solid shared file surface");
  fileButtons[0].focus();
  check(getComputedStyle(chip).outlineStyle === "solid" && getComputedStyle(chip).outlineWidth === "2px", "focused files retain a visible keyboard indicator");
  fileButtons[0].click();
  await wait(() => attachmentReveals.length === 2, "first draft reveals");
  fileButtons[1].click();
  await wait(() => attachmentReveals.length === 3, "second draft reveals");
  check(attachmentReveals[1].content === "first content" && attachmentReveals[2].content === "second content", "same-name drafts reveal their own content");
  failAttachmentReveal = true;
  fileButtons[0].click();
  await wait(() => document.querySelector(".chat-toast--error")?.textContent?.includes("Finder reveal failed"), "failed reveal is visible");
  failAttachmentReveal = false;
  document.querySelector<HTMLButtonElement>(".chat-toast__dismiss")!.click();
  Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const immersive = '[data-testid="immersive-chat"]';
  await wait(() => document.querySelectorAll(`${immersive} .chat-att-row--pending .chat-file-button`).length === 2, "immersive file drafts");
  const immersiveFiles = Array.from(document.querySelectorAll<HTMLButtonElement>(`${immersive} .chat-att-row--pending .chat-file-button`));
  check(immersiveFiles.every(button => button.querySelector<HTMLImageElement>(".chat-file-icon")?.naturalWidth === 16
    && getComputedStyle(button.parentElement!).borderTopLeftRadius === "24px"), "immersive drafts share the original Figma icon and file surface");
  const luminance = (color: string) => {
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const foreground = luminance(getComputedStyle(immersiveFiles[0].querySelector(".chat-file-name")!).color);
  const background = luminance(getComputedStyle(immersiveFiles[0].parentElement!).backgroundColor);
  check((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5, "immersive filenames remain readable on the solid surface");
  const immersiveRevealCount = attachmentReveals.length;
  immersiveFiles[0].click();
  await wait(() => attachmentReveals.length === immersiveRevealCount + 1, "immersive draft reveals");
  check(attachmentReveals.at(-1)?.content === "first content", "immersive draft preserves its original bytes");
  document.querySelector<HTMLButtonElement>(`${immersive} .chat-att-row--pending .chat-att-x`)!.click();
  await wait(() => document.querySelectorAll(`${immersive} .chat-att-row--pending .chat-file-button`).length === 1, "immersive removal");
  check(attachmentReveals.length === immersiveRevealCount + 1, "immersive removal does not reveal a file");
  document.querySelector<HTMLButtonElement>(`${immersive} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(immersive) && pending() === 1, "remaining draft returns to normal mode");
  const openCount = attachmentReveals.length;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".chat-att-row--pending .chat-att-x")) button.click();
  await wait(() => pending() === 0, "draft removal");
  check(attachmentReveals.length === openCount, "remove never reveals a file");
  const repeatedTextKey = `files::fixture::${crypto.randomUUID()}`;
  const firstFiles = [{ name: "same.md", kind: "file", src: "data:text/plain;base64,Zmlyc3Q=" }];
  await putFiles(repeatedTextKey, firstFiles);
  check((await getFiles(repeatedTextKey))?.[0].src === firstFiles[0].src, "unambiguous cached file retains its source");
  await putFiles(repeatedTextKey, [{ ...firstFiles[0], src: "data:text/plain;base64,c2Vjb25k" }]);
  check(await getFiles(repeatedTextKey) === undefined, "repeated message text must not open another attachment's bytes");
  await putFiles(repeatedTextKey, firstFiles);
  check(await getFiles(repeatedTextKey) === undefined, "ambiguous history cache stays unavailable");
  return { passed: true, checks: ["history attachment reveals original bytes", "same-name drafts reveal distinct content", "Finder failure is visible", "immersive drafts share style, bytes and removal", "removal has no host action", "ambiguous attachment cache stays unavailable"] };
};
state.runFixture = async () => {
  await state.runFileRevealFixture();
  await wait(() => document.querySelector(".chat-pill--think"), "native thinking options");
  const thinking = document.querySelector<HTMLButtonElement>(".chat-pill--think")!;
  thinking.click();
  const slider = () => document.querySelector<HTMLElement>('.think-fast-menu [role="slider"]');
  await wait(() => slider()?.getAttribute("aria-valuenow") === "1", "thinking menu inherits medium effort");
  check(slider()?.getAttribute("aria-valuemax") === "2", "only advertised effort levels appear");
  slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await wait(() => sessions[0].thinkingLevel === "high" && slider()?.getAttribute("aria-valuenow") === "2", "persist high effort");
  slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await wait(() => sessions[0].thinkingLevel === "low" && slider()?.getAttribute("aria-valuenow") === "0", "persist low effort");
  const fast = document.querySelector<HTMLButtonElement>('.think-fast-menu [role="switch"]')!;
  fast.click(); await wait(() => fast.getAttribute("aria-checked") === "true", "persist fast mode");
  rejectSettings = true; fast.click(); await pause(100);
  check(fast.getAttribute("aria-checked") === "true", "failed fast change keeps the applied state");
  rejectSettings = false; fast.click(); await wait(() => fast.getAttribute("aria-checked") === "false", "reset fast mode");
  thinking.click();
  document.querySelector<HTMLButtonElement>(".chat-retrybtn")!.click();
  await wait(() => sent.length === 1, "attachment retry");
  check(JSON.stringify(sent[0].attachments) === JSON.stringify(refs.map(nativeRef => ({ nativeRef }))), "retry retains image AND PDF references");
  await wait(() => !document.querySelector(".chat-stop"), "retry complete"); await pause(120);
  await setInput("/Users/example/Downloads/中文 图片.png"); await submit(2);
  check(sent[1].message === "/Users/example/Downloads/中文 图片.png" && slash.length === 0, "absolute path must use chat.send");
  paste(true); await wait(() => pending() === 2, "image and PDF paste");
  await submit(3);
  check(sent[2].attachments.length === 2 && sent[2].attachments.some((item: any) => item.mimeType === "application/pdf"), "both pasted file types reach transport");
  await wait(() => pending() === 2, "rejected upload restores attachments");
  await submit(4);
  check(JSON.stringify(sent[3].attachments) === JSON.stringify(sent[2].attachments), "upload failure retains all original bytes");
  paste(false); await wait(() => pending() === 1, "Finder bridge paste"); await submit(5);
  check(sent[4].attachments[0].fileName === "Finder 文件.pdf", "Finder filename survives");
  await clipboardChecks();
  await setInput("中".repeat(22000));
  document.querySelector<HTMLButtonElement>(".chat-send:not(.chat-stop)")!.click(); await pause(100);
  check(sent.length === 5 && input().value.length === 22000, "oversized UTF-8 text must retain draft without sending");
  await setInput("请结合图片和 PDF，帮我分析需求。"); paste(true);
  await wait(() => pending() === 2, "preview draft");
  return { passed: true, checks: ["native thinking options and persistence", "fast settings and failure state", "history image/PDF retry", "absolute path routing", "mixed file paste", "failed-upload retry with original bytes", "Finder clipboard bridge", "plain text paste", "clipboard errors preserve drafts", "error dismissal and timer renewal", "late clipboard failure isolation", "UTF-8 budget and draft retention"] };
};
const mount = () => {
  const root = createRoot(document.getElementById("root")!);
  root.render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);
  return root;
};
const attachmentRows = () => Array.from(document.querySelectorAll<HTMLElement>(".chat-thread .is-user [data-mi]"));
const attachmentCounts = () => attachmentRows().map(row => [row.querySelectorAll(".chat-att-thumb").length, row.querySelectorAll(".chat-file-button").length]);
state.runOperationHistoryFixture = async () => {
  history = [];
  const root = mount();
  const select = async (file: File) => {
    const data = new DataTransfer();
    data.items.add(file);
    input().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await wait(() => pending() === 1, `paste ${file.name}`);
  };
  await wait(() => input(), "external composer");
  await select(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], refs[0].name, { type: "image/png" }));
  await submit(1);
  await select(new File(["%PDF-1.7\nfixture"], refs[1].name, { type: "application/pdf" }));
  await submit(2);
  root.unmount();
  mount();
  await wait(() => attachmentRows().length === 2, "authoritative history after remount");
  const contents = attachmentCounts();
  check(JSON.stringify(contents) === "[[1,0],[0,1]]", `two empty captions restore by operation: ${JSON.stringify(contents)}`);
  check(attachmentRows()[0].querySelector<HTMLImageElement>(".chat-att-thumb")?.src === `data:image/png;base64,${png}`,
    "first operation owns the original image bytes");
  attachmentRows()[1].querySelector<HTMLButtonElement>(".chat-file-button")!.click();
  await wait(() => attachmentReveals.length === 1, "file source survives remount");
  check(attachmentReveals[0].name === refs[1].name && attachmentReveals[0].content === "%PDF-1.7\nfixture",
    "second operation owns the original file bytes");
  return { passed: true, contents, history: "send, reconcile, remount, reveal" };
};
state.runAttachmentHistoryFixture = async () => {
  const imageSrc = `data:image/png;base64,${png}`;
  const pagesBytes = btoa(pages);
  const fileSrc = `data:application/octet-stream;base64,${pagesBytes}`;
  await putImages(imgCacheKey(key, ""), [imageSrc]);
  await putFiles(fileCacheKey(key, ""), [{ name: pagesRef.name, kind: "file", src: fileSrc }]);
  history = [
    { id: "image-only", role: "user", content: "", shoggoth: { transcriptSeq: 1, attachments: [refs[0]] } },
    { id: "image-reply", role: "assistant", content: "图片回复" },
    { id: "file-only", role: "user", content: "", shoggoth: { transcriptSeq: 3, attachments: [pagesRef] } },
    { id: "mixed", role: "user", content: "图文和文件一起发送", shoggoth: { transcriptSeq: 4, attachments: [refs[0], pagesRef] } },
    { id: "image-caption", role: "user", content: "只给图片加正文", shoggoth: { transcriptSeq: 5, attachments: [refs[0]] } },
  ];
  mount();
  const rows = attachmentRows;
  await wait(() => rows().length === 4, "four attachment messages in history").catch(error => {
    throw Error(`${error.message}; rows=${rows().length}; ${document.querySelector('.chat-thread')?.textContent?.slice(-400)}`);
  });
  const contents = attachmentCounts();
  check(JSON.stringify(contents) === "[[1,0],[0,1],[1,1],[1,0]]", `history must keep each message's own attachments: ${JSON.stringify(contents)}`);
  const bridge = state.fixtureClipboard;
  Object.assign(state.openclawDesktop, { writeChatClipboard: bridge.write, readChatClipboard: bridge.read });
  const textCopies: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { textCopies.push(value); } } });
  const menu = async (target: Element, action: string) => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
    const button = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-ctxmenu button"))
      .find(item => item.textContent === i18n.t(action));
    await wait(button, `${action} available for ${target.className}`);
    button()!.click();
  };
  const footer = (row: HTMLElement, action: string) => row.closest(".chat-group")!
    .querySelector<HTMLButtonElement>(`.chat-group__footer button[title="${i18n.t(action)}"]`);
  const copied = async (trigger: () => unknown) => {
    const before = (await bridge.inspect()).writes;
    await trigger();
    for (let index = 0; index < 100; index++) {
      const receipt = await bridge.inspect();
      if (receipt.writes === before + 1) return receipt;
      await pause(10);
    }
    throw Error(`clipboard write unavailable: ${document.querySelector('.chat-toast')?.textContent}`);
  };
  const [image, file, mixed, imageCaption] = rows();
  check(footer(image, "chat.copy") && footer(image, "chat.quote") && footer(file, "chat.copy") && footer(file, "chat.quote"),
    "adjacent attachment messages have separate copy and quote actions");
  const imageCopy = await copied(() => menu(mixed.querySelector(".chat-att-thumb")!, "chat.copy"));
  check(imageCopy.png === png && !imageCopy.text && !imageCopy.files.length, "right-click image writes its bitmap only");
  const fileCopy = await copied(() => menu(mixed.querySelector(".chat-file-icon")!, "chat.copy"));
  check(!fileCopy.text && JSON.stringify(fileCopy.files) === JSON.stringify([{ name: pagesRef.name, base64: pagesBytes }]),
    "right-click file writes the original named file only");
  await menu(mixed.querySelector(".chat-bubble p")!, "chat.copy");
  check(textCopies.at(-1) === "图文和文件一起发送", "right-click text copies only the clicked Markdown bubble");
  const captionedImage = await copied(() => footer(imageCaption, "chat.copy")!.click());
  check(captionedImage.png === png && captionedImage.text === "只给图片加正文" && captionedImage.files[0].name === refs[0].name,
    "the captioned image has bitmap, original file and text representations");
  const whole = await copied(() => footer(mixed, "chat.copy")!.click());
  check(whole.text === "图文和文件一起发送" && JSON.stringify(whole.files) === JSON.stringify([
    { name: refs[0].name, base64: png }, { name: pagesRef.name, base64: pagesBytes },
  ]), "footer writes the caption and the complete file list in one operation");
  paste(true);
  await wait(() => pending() === 2 && input().value === whole.text, "whole message pastes caption and both files without duplicates");
  failMediaRead = true;
  footer(mixed, "chat.copy")!.click();
  await wait(() => document.querySelector(".chat-toast--error")?.textContent?.includes(i18n.t("chat.copyFailed")), "missing bytes fail visibly");
  check((await bridge.inspect()).writes === whole.writes, "failed whole-message copy does not replace the clipboard with text alone");
  failMediaRead = false;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".chat-att-row--pending .chat-att-x")) button.click();
  await setInput("");
  const pureImage = await copied(() => footer(image, "chat.copy")!.click());
  check(pureImage.png === png && !pureImage.text, "pure-image footer writes image data");
  const pureFile = await copied(() => footer(file, "chat.copy")!.click());
  check(pureFile.files[0].name === pagesRef.name && pureFile.files[0].base64 === pagesBytes, "pure-file footer writes original file bytes");
  footer(image, "chat.quote")!.click();
  await wait(() => document.querySelector(".chat-quote-bar .chat-quote-image"), "pure-image quote includes a thumbnail");
  await menu(file.querySelector(".chat-file-button")!, "chat.quote");
  await wait(() => document.querySelector(".chat-quote-bar")?.textContent?.includes(pagesRef.name), "pure-file quote includes filename");

  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const immersive = () => document.querySelector('[data-testid="immersive-chat"]');
  await wait(() => immersive()?.querySelectorAll("[data-user-row]").length === 4, "separate attachment messages in immersive chat");
  const [immersiveImage, immersiveFile, immersiveMixed] = Array.from(immersive()!.querySelectorAll("[data-user-row]"));
  const immersiveCopy = await copied(() => menu(immersiveMixed.querySelector(".chat-file-button")!, "chat.copy"));
  check(immersiveCopy.files[0].base64 === pagesBytes && !immersiveCopy.text, "immersive right-click selects the attachment");
  await menu(immersiveImage.querySelector("img")!, "chat.quote");
  await wait(() => immersive()?.querySelector(".chat-quote-image"), "immersive quote shows the selected image");
  check(immersiveFile.querySelector(`button[title="${i18n.t('chat.copy')}"]`), "immersive file-only footer has Copy");
  immersive()!.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !immersive(), "return from immersive chat");
  await setInput("回复这张图");
  await submit(1);
  check(sent[0].message.includes(refs[0].name) && JSON.stringify(sent[0].attachments) === JSON.stringify([{ nativeRef: refs[0] }]),
    "reply sends the selected saved image reference and quote text");
  return { passed: true, contents, clipboard: "bitmap, named files, caption and round trip", quotes: "normal and immersive, native reference sent" };
};
if (!operationHistory && location.search !== "?attachment-history") mount();
document.getElementById("run-checks")!.onclick = async () => {
  const status = document.getElementById("status")!;
  try { status.textContent = JSON.stringify(await state.runFixture()); } catch (error) { status.textContent = String(error); }
};
