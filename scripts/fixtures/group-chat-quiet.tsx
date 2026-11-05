import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import GroupChatPanel from "../../app/manage-ui/src/pages/GroupChatPanel";
import { groupAttachmentsOutsideMarkdown } from "../../app/manage-ui/src/pages/GroupChatMarkdown";
import { emitGroupChanged } from "../../app/manage-ui/src/lib/groupChat";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

declare const GROUP_QUIET_BASELINE: boolean;
const state = window as any, options = new URLSearchParams(location.search);
const scene = options.get("scene") || "waiting", language = options.get("language") || "zh-CN";
const now = new Date("2026-11-01T10:30:00+08:00").getTime();
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const end = performance.now() + 8000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (performance.now() > end) throw Error(label);
    await pause();
  }
};
const file = (id: string, name: string, mimeType = "application/octet-stream") => ({ id, name, mimeType, size: 2048 });
const report = file("11111111-1111-4111-8111-111111111111", "群聊样式优化.md");
const checklist = file("22222222-2222-4222-8222-222222222222", "验收清单.xlsx");
const member = (id: string, name: string, position: number) => ({ id, groupId: "g", backendId: "shoggoth", agentId: id,
  displayName: name, handle: id, state: "active", position, joinedSeq: 0, leftSeq: null });
const message = (seq: number, author: any, body: string, attachments?: any[]) => ({ id: "message-" + seq, groupId: "g", seq,
  threadId: "main", author, body, attachments, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: now + seq * 1000 });
const messages = [message(1, { kind: "user" }, "帮我整理群聊样式优化建议，并把结果写入文件。")];
if (scene === "files") messages.push(message(2, { kind: "member", memberId: "alpha" },
  "已整理好建议，文档在这里：\n\n[群聊样式优化.md](/Users/preview/workspace/群聊样式优化.md)\n\n重点是保留回复正文、简化等待状态，以及合并重复的文件入口。", [report, checklist]));
else messages.push(message(2, { kind: "member", memberId: "alpha" }, "我会从消息层级和阅读节奏两方面整理建议。"));
if (scene === "scroll") {
  for (let seq = 3; seq <= 122; seq++) messages.push(message(seq, { kind: "member", memberId: "alpha" },
    `历史消息 ${seq}\n\n` + "检查群聊中长消息的阅读位置和返回底部行为。\n\n".repeat(2 + seq % 5)));
}
const activity = (id: string): any => ({ groupId: "g", discussionId: "d", memberId: id, opportunityId: id + "-turn", taskId: null,
  attemptId: null, phase: "tool", eventSeq: 1, lastProgressAt: now, recentTools: [], tool: { id: "tool-" + id,
    name: "exec_command", input: { command: "node scripts/check-chat-ui.mjs", title: "检查消息渲染" },
    output: null, error: null, status: "running", startedAt: now, updatedAt: now, finishedAt: null, durationMs: null } });
const turns = scene === "files" ? [] : ["alpha", "maya"].map((id, index) => ({ opportunityId: id + "-turn", memberId: id,
  discussionId: "d", startedAt: now + index, floor: index === 0, released: index !== 0, activity: activity(id),
  ...(scene === "streaming" && index === 0 ? { draft: "建议把群聊中的每条回复呈现为普通消息。\n\n等待时使用与单聊一致的加载动画，让阅读更连贯。" } : {}) }));
if (scene === "streaming") {
  turns[0].activity.phase = "text";
  turns[0].activity.textMessages = turns[0].draft!.split("\n\n").map((text, index) => ({ id: index ? "two" : "one", text,
    pending: index === 1, final: false }));
}
const view = { ownerScope: "quiet-preview-" + crypto.randomUUID(), group: { id: "g", name: "产品体验讨论", status: "active", purpose: "",
  createdAt: now, updatedAt: now, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: messages.length },
  members: [member("alpha", "Alpha", 0), member("maya", "Maya", 1)], activeTurns: turns,
  round: turns.length ? { id: "d", causeMessageId: "message-1", order: [] } : null,
  queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [] };
let writes = 0;
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  if (init.method && init.method !== "GET") { writes++; throw Error("Unexpected fixture write: " + url); }
  const pathname = new URL(String(url), location.href).pathname;
  const payload = pathname.includes("/detail") ? view : pathname.includes("/messages") ? { messages, hasMore: false } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
await i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", options.get("theme") || "light");
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider />
  <GroupChatPanel groupId="g" onArchived={() => {}} /></UiProvider></HashRouter>);

const runScrollFixture = async (timeline: HTMLElement) => {
  const jump = () => document.querySelector<HTMLButtonElement>("[data-group-jump-latest]");
  const gap = () => timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await paint();
  check(gap() <= 2 && !jump(), "long group history opens at the bottom without a jump button");
  timeline.scrollTop = timeline.scrollHeight / 2;
  await wait(jump, "scrolling up reveals the latest-message button");
  await paint();
  const position = timeline.scrollTop;
  const button = jump()!, composer = document.querySelector<HTMLElement>("[data-chat-composer]")!;
  const streamBounds = timeline.getBoundingClientRect(), composerBounds = composer.getBoundingClientRect();
  const headerBounds = document.querySelector<HTMLElement>(".chat-header")!.getBoundingClientRect();
  const buttonBounds = button.getBoundingClientRect();
  check(button.textContent?.includes(i18n.t("chat.latestMessage")), "button uses the existing latest-message translation");
  check(buttonBounds.bottom <= composerBounds.top,
    "jump button remains above the composer");
  check(streamBounds.top < headerBounds.top && streamBounds.bottom > composerBounds.bottom,
    "messages extend beneath both floating docks instead of ending above the jump button");
  check(timeline.contains(document.elementFromPoint(buttonBounds.left - 12, buttonBounds.top + buttonBounds.height / 2)),
    "the transparent space beside the jump button passes input to the message stream");
  const streamStyle = getComputedStyle(timeline);
  check(streamStyle.maskImage.includes("linear-gradient") && streamStyle.getPropertyValue("--chat-fade").trim() === "36px",
    "the stream uses the shared top and bottom fade");
  check(Math.abs(Number.parseFloat(streamStyle.getPropertyValue("--chat-fade-bottom")) - (streamBounds.bottom - composerBounds.top)) <= 1,
    "the bottom fade ends at the composer, leaving messages visible behind the jump button");
  messages.push(message(123, { kind: "member", memberId: "alpha" }, "阅读历史期间到达的新消息。"));
  view.group.lastSeq = 123; emitGroupChanged("g");
  await wait(() => timeline.querySelector('[data-seq="123"]'), "new group message arrives");
  await paint();
  check(Math.abs(timeline.scrollTop - position) <= 2 && jump(), "new messages preserve the reader's position and jump button");
  button.click();
  await wait(() => gap() <= 2 && !jump(), "one click reaches the latest message and hides the button");
  await paint();
  check(gap() <= 2, "removing the button leaves the timeline at the bottom");
  messages.push(message(124, { kind: "member", memberId: "alpha" }, "回到底部后自动跟随的新消息。\n\n".repeat(8)));
  view.group.lastSeq = 124; emitGroupChanged("g");
  await wait(() => timeline.querySelector('[data-seq="124"]'), "next group message arrives");
  await paint();
  check(gap() <= 2 && !jump(), "jumping to latest restores automatic following");
  const textarea = composer.querySelector<HTMLTextAreaElement>("textarea")!;
  const setDraft = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const composerHeight = composer.offsetHeight;
  setDraft("输入框增高后，最新回复仍完整显示。\n".repeat(12));
  await wait(() => composer.offsetHeight > composerHeight, "composer grows with a multiline draft");
  await paint();
  check(gap() <= 2 && !jump(), "a taller composer preserves the latest-message position");
  const clearance = timeline.getBoundingClientRect().bottom - composer.getBoundingClientRect().top;
  check(Math.abs(Number.parseFloat(timeline.style.getPropertyValue("--chat-fade-bottom")) - clearance) <= 1,
    "fade boundary follows composer height changes");
  setDraft("");
  await wait(() => composer.offsetHeight === composerHeight, "composer returns to its resting height");
  await paint();
  timeline.scrollTop = 0;
  await wait(jump, "jump button returns when reading older history");
  timeline.scrollTop = timeline.scrollHeight;
  await wait(() => !jump(), "manually scrolling to the bottom also hides the button");
  const root = document.getElementById("root")!;
  root.style.display = "none";
  await paint();
  root.style.display = "flex";
  await paint();
  await wait(() => gap() <= 2 && !jump(), "returning from a hidden page restores latest-message positioning");
  // Place a message behind the control to make an opaque dock or a hard cut visible.
  const previewMessage = timeline.querySelector<HTMLElement>('[data-seq="64"] .chat-bubble')!;
  timeline.scrollTop += previewMessage.getBoundingClientRect().top - (composer.getBoundingClientRect().top - 100);
  await wait(jump, "preview shows the latest-message button");
};

const runFixture = async () => {
  await wait(() => document.querySelector('[data-seq="2"]') && document.querySelector('[data-chat-composer] textarea:not(:disabled)'), "panel ready");
  const timeline = document.querySelector<HTMLElement>("[data-group-timeline]")!;
  if (!GROUP_QUIET_BASELINE) {
    check(!timeline.querySelector("[data-group-activity]"), "discussion and tool activity stay out of message bubbles");
    check(!timeline.textContent?.includes("node scripts/check-chat-ui.mjs"), "tool arguments stay out of the quiet conversation");
    if (scene === "scroll") {
      await runScrollFixture(timeline);
    } else if (scene === "waiting") {
      check(timeline.querySelectorAll('[data-group-execution] .chat-bubble [role="status"]').length === 2, "each working member has the single-chat loader");
    } else if (scene === "streaming") {
      const draft = timeline.querySelector('[data-group-reply-message="two"] .chat-md')!;
      const first = timeline.querySelector('[data-group-reply-message="one"]')!;
      const firstText = first.textContent;
      check(timeline.querySelectorAll('[data-group-execution="alpha-turn"] .chat-bubble').length === 2, "two source messages use two independent bubbles");
      check(draft.textContent?.includes("让阅读更连贯"), "streaming reply keeps its Markdown body");
      check(getComputedStyle(draft).opacity === "1", "reply text has normal message contrast");
      check(draft.querySelectorAll(".chat-cursor").length === 1, "reply uses the single-chat streaming cursor");
      check(timeline.querySelectorAll('[data-group-execution="maya-turn"] [role="status"]').length === 1, "background member retains its loader");
      const initial = turns[0].activity.textMessages[1].text;
      for (const text of ["检查 **消息气泡**", "请 @Maya", "状态 👩🏽‍💻", "正在检查 `README.md`", "- 检查配置\n- 核对文档"]) {
        turns[0].activity.textMessages[1].text = text; turns[0].activity.eventSeq++; emitGroupChanged("g");
        await wait(() => timeline.querySelector('[data-group-reply-message="two"] .chat-md')?.textContent?.includes(text.replace(/\*\*|`|@/g, "").split("\n").at(-1)!.replace(/^- /, "")), "streamed Markdown updates");
        check(timeline.querySelector('[data-group-reply-message="one"]') === first && first.textContent === firstText, "a later message never replaces the previous bubble or its content");
        check(timeline.querySelectorAll('[data-group-execution="alpha-turn"] .chat-cursor').length === 1, "cursor survives repeated Markdown updates");
        if (text.includes("@Maya")) check(Boolean(timeline.querySelector('[data-group-execution="alpha-turn"] button')), "streaming member mention remains interactive");
      }
      turns[0].activity.phase = "tool"; turns[0].activity.textMessages[1].pending = false; turns[0].activity.eventSeq++; emitGroupChanged("g");
      await wait(() => timeline.querySelectorAll('[data-group-execution="alpha-turn"] .chat-bubble').length === 3, "a tool stage keeps the two replies and adds a separate loading bubble");
      check(first.textContent === firstText, "tool stage preserves earlier reply text");
      turns[0].activity.textMessages[1].text = initial; turns[0].activity.textMessages[1].pending = true;
      turns[0].activity.phase = "text"; turns[0].activity.eventSeq++; emitGroupChanged("g");
      await wait(() => timeline.querySelector('[data-group-reply-message="two"] .chat-md')?.textContent?.includes("让阅读更连贯"), "restore preview reply");
    } else {
      const row = timeline.querySelector('[data-seq="2"]')!;
      check(row.querySelectorAll('.chat-md a[data-local-path]').length === 1, "inline file link remains available");
      check(row.querySelectorAll('.chat-att-row button').length === 1, "only the unmentioned attachment has a footer button");
      check(row.querySelector('.chat-att-row')?.textContent?.includes("验收清单.xlsx"), "other attachments remain available");
      const remaining = (text: string, files = [report, checklist]) => groupAttachmentsOutsideMarkdown(text, files).map(file => file.id).join(",");
      for (const text of ["群聊样式优化.md", "`群聊样式优化.md`", "```text\n/Users/preview/workspace/群聊样式优化.md\n```", "[网页](https://example.com/群聊样式优化.md)"]) {
        check(remaining(text) === [report.id, checklist.id].join(","), "plain names, fenced examples and unrelated web URLs retain file access");
      }
      for (const text of ["`/Users/preview/workspace/群聊样式优化.md`", "[打开](file:///Users/preview/workspace/群聊样式优化.md)"]) {
        check(remaining(text) === checklist.id, "visible file link suppresses only its duplicate: " + text + " => " + remaining(text));
      }
      const mediaLink = "[打开](/__api/inspirations/media?id=" + report.id + ")";
      check(remaining(mediaLink) === (location.protocol === "file:" ? [report.id, checklist.id].join(",") : checklist.id),
        "only an actionable same-origin media link suppresses its duplicate");
      const sameName = { ...report, id: "33333333-3333-4333-8333-333333333333" };
      check(remaining("/Users/preview/workspace/群聊样式优化.md", [report, sameName]) === [report.id, sameName.id].join(","), "ambiguous same-name attachments remain accessible");
      check(remaining(mediaLink, [report, sameName]) === (location.protocol === "file:" ? [report.id, sameName.id].join(",") : sameName.id),
        "actionable exact media identity disambiguates same-name files");
      const image = file("44444444-4444-4444-8444-444444444444", "图片.png", "image/png");
      check(remaining("/Users/preview/图片.png", [image]) === image.id, "image previews remain available");
    }
  }
  check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal overflow");
  check(document.querySelector('[data-chat-composer]')!.getBoundingClientRect().bottom <= innerHeight + 1, "composer remains in the viewport");
  check(writes === 0, "preview does not write to any service");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  state.previewReady = true;
  return { passed: true, scene, language, baseline: GROUP_QUIET_BASELINE, writes };
};
state.runFixture = () => state.fixtureRun ??= runFixture();
state.settleFixture = async () => {
  const result: any = message(3, { kind: "member", memberId: "alpha" }, "群聊消息样式已整理完成。");
  result.origin = { opportunityId: "alpha-turn" };
  result.replyMessages = [...turns[0].activity.textMessages.map(({ id, text }: any) => ({ id, text })), { id: "final", text: result.body }];
  messages.push(result); view.group.lastSeq = 3; view.activeTurns = []; view.round = null; emitGroupChanged("g");
  await wait(() => document.querySelectorAll('[data-seq="3"] .chat-bubble').length === 3 && !document.querySelector('[data-group-execution="alpha-turn"]'), "settlement retains each earlier message and appends the final reply");
  const bubbles = [...document.querySelectorAll('[data-seq="3"] .chat-bubble')];
  check(bubbles[0].textContent?.includes("每条回复呈现为普通消息"), "first reply survives final settlement");
  check(bubbles[1].textContent?.includes("让阅读更连贯"), "second reply survives final settlement");
  check(bubbles[2].textContent?.trim() === result.body, "final response occupies its own third bubble");
  check(!document.querySelector('[data-seq="3"] .chat-cursor'), "saved replies have no streaming cursor");
  return { passed: true, independentBubbles: bubbles.length };
};
void state.runFixture().then((result: unknown) => { state.fixtureResult = result; }).catch((error: Error) => { state.fixtureError = error.stack; });
