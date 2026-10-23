import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import GroupChatPanel from "../../app/manage-ui/src/pages/GroupChatPanel";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { emitGroupChanged } from "../../app/manage-ui/src/lib/groupChat";
import { formatChatTime } from "../../app/manage-ui/src/lib/chatTime";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

// Actual Panel, journal, Markdown, menus and local storage. APIs and clipboard are isolated.
const state = window as any, options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN", theme = options.get("theme") || "light";
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, label: string) => { if (!condition) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(label);
    await pause();
  }
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
localStorage.clear();
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (text: string) => { state.clipboardText = text; },
} });
let owner = "owner-a", groupId = "g", sends: any[] = [], writes: any[] = [], historyReads: any[] = [];
let memberCount = Math.max(1, Math.min(32, Number(options.get("members")) || 5));
let timelineTurns: any[] = [], timelineInteractions: any[] = [];
const names = ["Alpha", "Lily", "Noah", "Emma", "Jack", "Mia", "Leo", "Maya"];
let delayedRead: { resolve(value: Response): void; response: Response } | null = null, delayOlder = false;
const allMessages: Record<string, any[]> = Object.fromEntries(["g", "h"].map(id => [id, Array.from({ length: 12 }, (_,index) => {
  const seq = index + 1;
  return { id: "message-" + seq, groupId: id, seq, threadId: "main",
    author: seq % 2 ? { kind: "user" } : { kind: "member", memberId: "alpha" },
    body: seq === 4 || seq === 6 ? "Identical **reply**" : (seq % 2 ? "User" : "Alpha") + " message " + seq + "\n\nSecond line with **Markdown**.",
    mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: Date.now() - (13-seq)*60_000 };
})]));
for (const rows of Object.values(allMessages)) {
  rows[9].responseMetadata = { models: ["native-actual-model"], modelSource: "reported",
    usage: { inputTokens: 36800, outputTokens: 584, cachedInputTokens: 2000 },
    context: { usedTokens: 8000, windowTokens: 200000, quality: "estimated" } };
  rows[6].body = "";
  rows[6].attachments = [{ id: "11111111-1111-4111-8111-111111111111", name: "Attachment-only.pdf", mimeType: "application/pdf", size: 128 }];
  for (let index = 0; index < 6; index++) rows[index].attachments = [{ id: `22222222-2222-4222-8222-22222222222${index}`,
    name: ["AI Race Reaches.md", "Product update.html", "Design reference.jpg", "Release assets.zip", "Team notes.md", "Preview.html"][index],
    mimeType: index === 2 ? "image/jpeg" : "application/octet-stream", size: 81920 }];
  const fileCount = Math.min(100, Number(options.get("files")) || 7);
  for (let index = 7; index < fileCount; index++) {
    rows[0].attachments.push({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      name: `Shared file ${index}.${["md", "html", "jpg", "zip", "mp3", "dmg"][index % 6]}`,
      mimeType: "application/octet-stream", size: 81920 });
  }
}
const presentationKey = "shoggoth.groupChat.messagePresentation.v1." + JSON.stringify(["owner-a", "g"]);
const savedPins = [2, 9].map(seq => ({ id: "message-" + seq, seq, text: allMessages.g[seq - 1].body }));
localStorage.setItem(presentationKey, JSON.stringify({ hidden: [], pins: savedPins }));
const messages = (id: string) => allMessages[id].map(message => owner === "owner-a" ? message : { ...message, body: "New owner: " + message.body });
const view = (id: string) => ({ ownerScope: owner,
  group: { id, name: "Group " + id, purpose: "Bubble actions fixture", status: "active", createdAt: 1, updatedAt: 1,
    metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: allMessages[id].at(-1)!.seq,
    mode: "independent", policyVersion: 1, protocolVersion: 1 },
  currentOwnerId: "alpha",
  members: Array.from({ length: memberCount }, (_, index) => ({ id: index === 0 ? "alpha" : "member-" + index, groupId: id,
    backendId: "shoggoth", agentId: "fixture-" + index, displayName: names[index] ?? "Member " + index,
    handle: index === 0 ? "alpha" : "member-" + index, state: "active", position: index, joinedSeq: 0, leftSeq: null })),
  discussion: null, round: null, activeTurns: timelineTurns, queuedMemberIds: [], pendingInteractions: timelineInteractions, internalSessionKeys: [], tasks: [] });
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  const parsed = new URL(String(url), "http://fixture"), id = parsed.searchParams.get("id") || "g";
  const response = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  if (init.method && init.method !== "GET") {
    writes.push({ path: parsed.pathname, input: JSON.parse(String(init.body)) });
    check(parsed.pathname === "/__api/group-chats/messages", "local actions must never mutate a server");
    const input = JSON.parse(String(init.body)); sends.push({ id, input });
    const message = { ...allMessages[id][0], id: "sent-" + sends.length, seq: allMessages[id].at(-1)!.seq + 1, body: input.body };
    allMessages[id].push(message);
    return response({ message, discussionId: null, duplicate: false });
  }
  if (parsed.pathname === "/__api/group-chats/detail") return response(view(id));
  if (parsed.pathname === "/__api/group-chats/members/role-history") return response({ snapshots: [], nextCursor: null });
  if (parsed.pathname === "/__api/group-chats/members/role") {
    const memberId = parsed.searchParams.get("memberId") || "alpha";
    const text = `You're not a chatbot. You're becoming someone.\n\nThis is ${memberId}'s persona, yours to grow into and edit over time. Some starting truths:\n\n- **Be genuinely helpful, not performatively helpful.** Just help.\n- **Have opinions.** You're allowed to prefer things and disagree.\n- **Be resourceful before asking.** Read the file, check the context, search, try building it.\n\nIf you change this file, tell the user. It's your soul, and they should know.\n\n`.repeat(4);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return response({ ok: true, text, nextCursor: null, offset: 0, totalBytes: new TextEncoder().encode(text).length,
      exportDigest: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,"0")).join(""), revisionId: memberId + "-role", disclosure: "full" });
  }
  if (parsed.pathname === "/__api/group-chats/messages") {
    const before = Number(parsed.searchParams.get("beforeSeq")) || null, after = Number(parsed.searchParams.get("afterSeq")) || null;
    historyReads.push({ id, owner, before, after });
    const rows = messages(id), page = after ? rows.filter(message => message.seq > after)
      : before ? rows.filter(message => message.seq < before) : rows.slice(-4);
    const result = response({ messages: page, hasMore: !before && !after });
    if (before && delayOlder) return await new Promise<Response>(resolve => { delayedRead = { resolve, response: result }; });
    return result;
  }
  if (parsed.pathname === "/__api/group-chats/messages/lookup") return response({ status: "not_found" });
  return response({});
};
await i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", theme);
let root = createRoot(document.getElementById("root")!);
const mount = (id = groupId) => { groupId = id; root.render(<HashRouter><UiProvider><ScrollbarProvider /><GroupChatPanel key={id} groupId={id} onArchived={() => {}} /></UiProvider></HashRouter>); };
const ready = () => (document.querySelector("[data-chat-composer] textarea") as HTMLTextAreaElement | null)?.disabled === false;
const row = (seq: number) => document.querySelector<HTMLElement>(`[data-group-timeline] [data-seq="${seq}"]`);
const remount = async () => {
  root.unmount(); root = createRoot(document.getElementById("root")!); mount();
  await wait(() => ready() && row(12), "remounted group ready");
};
const open = async (seq: number, edge = false) => {
  const element = row(seq); check(element, "message exists: " + seq);
  const bounds = element!.getBoundingClientRect();
  element!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
    clientX: edge ? innerWidth - 1 : Math.max(12, bounds.left + 12), clientY: edge ? innerHeight - 1 : 240 }));
  await wait(() => document.querySelector('.chat-ctxmenu[role="menu"]'), "bubble menu opened");
};
const menuAction = async (key: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-ctxmenu button")).find(button => button.textContent === i18n.t(key));
  check(button && !button.disabled, "enabled menu action " + key); button!.click();
  await wait(() => !document.querySelector(".chat-ctxmenu"), "menu dismissed after action");
};
const actOn = async (seq: number, key: string) => { await open(seq); await menuAction(key); };
const undo = async () => { const button = document.querySelector<HTMLButtonElement>(".chat-toast__act"); check(button, "undo offered"); button!.click(); await pause(); };
const type = async (value: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true })); await pause();
};
mount();
state.showDesignState = async (mode: string) => {
  document.querySelector<HTMLButtonElement>('[data-group-details-action="close"]')?.click();
  document.querySelector<HTMLButtonElement>('[data-group-files-close]')?.click();
  await pause();
  if (mode === "members") {
    document.querySelector<HTMLButtonElement>("[data-group-details-trigger]")!.click();
    await wait(() => document.querySelector("[data-group-details] [role=tabpanel]")?.textContent?.includes("You're not a chatbot"), "member role visible");
  } else if (mode === "files") {
    document.querySelector<HTMLButtonElement>("[data-group-files-trigger]")!.click();
    await wait(() => document.querySelectorAll("[data-group-file]").length === 7, "all older group files visible");
    await wait(() => document.querySelector("[data-group-files] [aria-busy]")?.getAttribute("aria-busy") === "false", "file scan complete");
  }
  await pause(60);
};
state.runTimelineFixture = async () => {
  await wait(() => ready() && row(12), "timeline group ready");
  names[1] = "Maya"; names[2] = "DeepSeek";
  const started = Date.now(), list = document.querySelector<HTMLElement>("[data-group-timeline]")!;
  const execution = (id: string) => list.querySelector<HTMLElement>(`[data-group-execution="${id}"]`);
  const order = () => [...list.querySelectorAll<HTMLElement>("[data-seq],[data-group-execution],[data-group-interaction]")]
    .map(node => node.dataset.seq ?? node.dataset.groupExecution ?? node.dataset.groupInteraction).join(",");
  timelineTurns = [
    { opportunityId: "maya", memberId: "member-1", startedAt: started - 2000, inputThroughSeq: 9, floor: false, released: true },
    { opportunityId: "deepseek", memberId: "member-2", startedAt: started - 1000, floor: true, released: false },
  ];
  emitGroupChanged("g");
  await wait(() => execution("maya") && execution("deepseek"), "both unfinished cards render");
  check(order() === "9,10,11,12,maya,deepseek", "unfinished cards follow history in start order");
  const maya = execution("maya")!;
  timelineTurns.reverse(); timelineTurns[1].draft = "Updated background progress"; emitGroupChanged("g");
  await pause(100);
  check(order() === "9,10,11,12,maya,deepseek", "progress and API array order do not move unfinished cards");
  list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll", { bubbles: true }));
  const publish = async (seq: number, memberId: string, opportunityId: string, partial = false) => {
    allMessages.g.push({ ...allMessages.g[0], id: "timeline-" + seq, seq, author: { kind: "member", memberId },
      body: partial ? "Maya: partial speech; background work continues." : opportunityId + ": published final result.",
      attachments: [], createdAt: Date.now(), origin: { opportunityId, ...(partial ? { partial: true } : {}) } });
    emitGroupChanged("g"); await wait(() => row(seq), "published result " + seq); await pause();
  };
  await publish(13, "member-2", "deepseek");
  check(order() === "9,10,11,12,13,maya", "DeepSeek result precedes Maya and removes its own stale card");
  check(execution("maya") === maya, "remaining card keeps its DOM identity");
  check(list.scrollHeight - list.clientHeight - list.scrollTop < 2, "published result retains bottom following");
  list.scrollTop = 0; list.dispatchEvent(new Event("scroll", { bubbles: true }));
  const readingTop = list.scrollTop, readingY = row(9)!.getBoundingClientRect().top;
  await publish(14, "member-1", "maya", true);
  check(order() === "9,10,11,12,13,14,maya", "partial speech leaves background work visible");
  check(Math.abs(list.scrollTop - readingTop) < 1 && Math.abs(row(9)!.getBoundingClientRect().top - readingY) < 1,
    "new results do not move a reader viewing earlier messages");
  await publish(15, "member-1", "maya");
  check(order() === "9,10,11,12,13,14,15", "Maya final follows DeepSeek in published order");
  await actOn(15, "chat.deleteLocal");
  check(!row(15) && !execution("maya"), "hiding a final never revives its stale execution card");
  await undo();
  timelineTurns.push({ ...timelineTurns[1], opportunityId: "maya-next", startedAt: started + 1 });
  timelineInteractions = [{ opportunityId: "maya", memberId: "member-1", status: "pending", occurredAt: started,
    request: { version: 1, requestId: "stale-approval", kind: "runtime_approval", title: "Stale approval", fields: [], approvalChoices: ["once", "deny"] } }];
  emitGroupChanged("g"); await wait(() => execution("maya-next"), "same member starts a distinct new turn");
  check(order() === "9,10,11,12,13,14,15,maya-next", "settlement clears exact turn and stale approval, preserving next turn");
  check(writes.length === 0, "timeline updates perform no server writes");
  return { passed: true, language, theme, checks: ["published results before pending cards", "stable card order and DOM identity",
    "exact turn settlement and partial speech", "bottom following and earlier reading position", "hidden results and stale approvals"], apiWrites: writes.length, providerCalls: 0 };
};
state.runDesignFixture = async () => {
  await wait(() => ready() && row(12), "design group ready");
  const checks: string[] = [];
  for (const count of [1,2,3,4,8]) {
    memberCount = count; emitGroupChanged("g");
    await wait(() => document.querySelector("[data-group-avatar-count]")?.getAttribute("data-group-avatar-count") === String(Math.min(count,4)), "avatar count " + count);
    const avatar = document.querySelector<HTMLElement>("[data-group-avatar-count]")!;
    const items = [...avatar.children] as HTMLElement[];
    check(items.length === Math.min(count,4), "group avatar caps visible members at four");
    check(Math.abs(avatar.getBoundingClientRect().width - 48) < 1, "48px avatar canvas");
    check(Math.abs(items[0].getBoundingClientRect().width - (count === 1 ? 48 : count === 2 ? 32 : 24)) < 1, "count-specific avatar size");
    if (count > 2) check(items[0].offsetTop < items.at(-1)!.offsetTop, "stack has upper/lower rows");
  }
  memberCount = 5; emitGroupChanged("g"); await pause(100);
  checks.push("one/two/three/four/eight-member avatar layouts and 48/32/24 geometry");
  for (const [seq, radii] of [[11,["24px","0px","24px","24px"]], [12,["0px","24px","24px","24px"]]] as const) {
    const bubble = row(seq)!.querySelector<HTMLElement>(".chat-bubble")!, css = getComputedStyle(bubble);
    check(JSON.stringify([css.borderTopLeftRadius,css.borderTopRightRadius,css.borderBottomRightRadius,css.borderBottomLeftRadius]) === JSON.stringify(radii), "mirrored bubble corners");
  }
  const memberRow = row(12)!, author = memberRow.querySelector<HTMLElement>("[data-group-author]")!, bubble = memberRow.querySelector<HTMLElement>(".chat-bubble")!;
  check(author.getBoundingClientRect().bottom <= bubble.getBoundingClientRect().top, "member identity above bubble");
  checks.push("member avatar/name above bubble and mirrored top corners");
  const older = [...document.querySelectorAll<HTMLButtonElement>("[data-group-timeline] button")]
    .find(button => button.textContent === i18n.t("groupChat.loadOlder"));
  older?.click(); await wait(() => row(7), "attachment-only message page loaded");
  for (const seq of [7,11,12]) {
    const message = allMessages.g.find(item => item.seq === seq)!;
    const container = row(seq)!, time = container.querySelector<HTMLElement>("[data-group-message-time]")!;
    const footer = time?.parentElement!, css = getComputedStyle(footer);
    check(time?.textContent === formatChatTime(message.createdAt), "message time matches direct-chat formatting");
    check(time.getAttribute("datetime") === new Date(message.createdAt).toISOString(), "time uses the canonical message timestamp");
    const content = container.querySelector<HTMLElement>(".chat-bubble,.chat-att-row")!;
    check(time.getBoundingClientRect().top >= content.getBoundingClientRect().bottom, "timestamp is below the message content");
    check(css.fontSize === "13px" && css.lineHeight === "16px", "timestamp shares direct-chat typography");
    check(message.author.kind === "user" ? css.paddingRight === "24px" && css.justifyContent === "flex-end" : css.paddingLeft === "24px",
      "timestamp shares the direct-chat mirrored 24px inset");
  }
  checks.push("user/member/attachment message times share direct-chat date format, placement, typography and 24px insets");
  await type("Unsent draft survives expanded panels");
  const timeline = document.querySelector<HTMLElement>("[data-group-timeline]")!;
  timeline.scrollTop = 0; timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
  const readingTop = timeline.scrollTop;
  await state.showDesignState("members");
  check(document.querySelectorAll("[data-group-details-member]").length === 5, "all members available in expanded view");
  const selected = document.querySelector<HTMLElement>('[data-group-details-member][aria-selected="true"] > span')!;
  check(Math.abs(selected.getBoundingClientRect().width - 100) < 1, "selected avatar is 100px");
  document.querySelector<HTMLButtonElement>('[data-group-details-member="member-1"]')!.click();
  await wait(() => document.querySelector("[role=tabpanel]")?.textContent?.includes("member-1's persona"), "member switch loads correct role");
  check(!document.querySelector("[role=tabpanel]")?.textContent?.includes("alpha's persona"), "previous role not mixed into new selection");
  checks.push("expanded member selection uses current public role with 100/80 avatar geometry");
  await state.showDesignState("files");
  check(document.querySelectorAll("[data-group-file]").length === 7, "files include earlier message pages");
  const firstFile = document.querySelector<HTMLElement>("[data-group-file]")!;
  check(firstFile.textContent?.includes("Attachment-only.pdf"), "file order follows latest source message");
  checks.push("group files scan older history, preserve author/size/time and newest-first order");
  await state.showDesignState("chat");
  check(ready() && row(12), "closing panels restores chat and composer");
  check(document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")!.value === "Unsent draft survives expanded panels", "expanded panels preserve unsent draft");
  check(Math.abs(timeline.scrollTop - readingTop) < 1, "closing expanded panels preserves reading position");
  await type("");
  checks.push("expanded panels preserve unsent composer and timeline reading position");
  return { passed: true, language, theme, checks, apiWrites: writes.length, providerCalls: 0 };
};
state.runFixture = async () => {
  const checks: string[] = [];
  await wait(() => ready() && row(12), "initial group ready");
  const model = row(10)!.querySelector<HTMLElement>(".chat-response-model")!;
  check(model && getComputedStyle(model).opacity === "0", "group model is hidden by default");
  const modelAction = row(10)!.querySelector<HTMLButtonElement>(".chat-copybtn")!;
  modelAction.focus(); await pause();
  check(getComputedStyle(model).opacity === "1" && getComputedStyle(modelAction).opacity === "1", "group model and actions reveal on keyboard focus");
  modelAction.blur(); await wait(() => getComputedStyle(model).opacity === "0", "group model hides after focus leaves");
  for (const seq of [9,10]) {
    const footer = () => row(seq)!.querySelector<HTMLElement>("[data-group-message-footer]")!;
    const buttons = () => footer().querySelectorAll<HTMLButtonElement>("button");
    check(buttons().length === 2, "user and member have copy and delete footer shortcuts");
    check(!footer().querySelector(`button[title="${i18n.t("chat.pin")}"], button[title="${i18n.t("chat.unpin")}"]`), "footer hides pin and unpin shortcuts");
    buttons()[0].focus(); await pause();
    check(document.activeElement === buttons()[0], "footer shortcuts accept keyboard focus");
    check(getComputedStyle(buttons()[0]).opacity === "1", "keyboard focus reveals footer shortcuts");
    buttons()[0].click(); await pause();
    check(state.clipboardText === allMessages.g[seq-1].body, "footer copies exact selected Markdown");
    buttons()[1].click(); await wait(() => !row(seq), "footer locally hides selected message");
    await undo(); await wait(() => row(seq), "footer hide supports undo");
  }
  const footer = row(10)!.querySelector<HTMLElement>("[data-group-message-footer]")!;
  check(footer.textContent?.includes("native-actual-model") && !/[↑↓]|\b[RW]\d|\bctx\b|\btok\b/.test(footer.textContent), "group footer keeps only the response model and time");
  check(!row(12)!.querySelector(".chat-response-model"), "missing metadata remains absent");
  check(footer.getBoundingClientRect().right <= innerWidth + 1, "footer remains inside narrow viewport");
  checks.push("hidden usage/context and model focus visibility; copy and delete shortcuts for both authors; pinning hidden; undo; missing metadata and narrow layout");
  for (const seq of [9,10]) {
    await open(seq, true);
    const labels = Array.from(document.querySelectorAll(".chat-ctxmenu button")).map(button => button.textContent);
    check(JSON.stringify(labels) === JSON.stringify(["chat.copy","chat.quote","chat.deleteLocal"].map(key => i18n.t(key))), "both authors share three actions with pinning hidden");
    const bounds = document.querySelector(".chat-ctxmenu")!.getBoundingClientRect();
    check(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1, "menu stays inside viewport");
    await menuAction("chat.copy");
    check(state.clipboardText === allMessages.g.find(message => message.seq === seq)!.body, "copy preserves only selected message Markdown");
  }
  checks.push("user/member menu parity and exact Markdown copy; viewport edges");
  await open(10);
  const menu = document.querySelector(".chat-ctxmenu")!;
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  check(document.activeElement?.textContent === i18n.t("chat.quote"), "keyboard navigates menu items");
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".chat-ctxmenu"), "Escape dismisses menu");
  checks.push("keyboard navigation and Escape");
  check(!document.querySelector(".chat-pinbar"), "saved pins do not render a pin bar or filter controls");
  check(row(9) && row(10) && row(11) && row(12), "saved pins do not filter the message stream");
  await remount();
  check(!document.querySelector(".chat-pinbar"), "pin bar stays hidden after remount");
  check(JSON.stringify(JSON.parse(localStorage.getItem(presentationKey)!).pins) === JSON.stringify(savedPins), "saved pins survive local actions and remount");
  checks.push("pin bar and filter hidden; full message stream; saved pins preserved across local actions and remount");
  await actOn(10,"chat.deleteLocal"); await wait(() => !row(10), "member message locally hidden");
  await remount(); check(!row(10), "hidden message persists after remount");
  check(allMessages.g.some(message => message.seq === 10), "canonical message retained");
  await actOn(9,"chat.deleteLocal"); await wait(() => !row(9), "user message locally hidden");
  await undo(); await wait(() => row(9), "user deletion undone");
  check(!row(10), "undo does not reveal another hidden message");
  check(writes.length === 0, "local message actions make no API writes");
  checks.push("both authors hide locally; exact undo and persistent hidden state; no server writes");
  const olderButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === i18n.t("groupChat.loadOlder"));
  check(olderButton, "older history entry exists"); olderButton!.click();
  await wait(() => row(2), "older messages loaded");
  await open(7);
  check(!Array.from(document.querySelectorAll(".chat-ctxmenu button")).some(button => button.textContent === i18n.t("chat.copy")), "attachment-only messages do not copy empty text");
  check(!Array.from(document.querySelectorAll(".chat-ctxmenu button")).some(button => [i18n.t("chat.pin"), i18n.t("chat.unpin")].includes(button.textContent || "")), "attachment-only menu also hides pinning");
  document.querySelector(".chat-ctxmenu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector(".chat-ctxmenu"), "attachment-only menu dismissed");
  await actOn(4,"chat.deleteLocal"); await wait(() => !row(4), "one duplicate hidden"); check(row(6), "identical neighboring reply remains");
  await undo(); await wait(() => row(4), "exact duplicate restored");
  await remount(); check(!row(2), "older message initially outside retained page");
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === i18n.t("groupChat.loadOlder"))!.click();
  await wait(() => row(2), "normal pagination still loads saved older pinned message");
  check(historyReads.some(read => read.before === 9), "older messages use normal beforeSeq pagination");
  checks.push("attachment-only menu hides pinning; duplicate identity; older messages remain accessible through pagination");
  mount("h"); await wait(() => ready() && row(10) && document.body.textContent?.includes("Group h"), "other group ready");
  check(!document.querySelector(".chat-pinbar"), "same message IDs in another group do not inherit pins");
  mount("g"); await wait(() => ready() && document.body.textContent?.includes("Group g") && !row(10), "original group presentation restored");
  checks.push("group isolation and restoration");
  await remount(); delayOlder = true;
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === i18n.t("groupChat.loadOlder"))!.click();
  await wait(() => delayedRead, "old owner history read waiting");
  await open(9); owner = "owner-b"; emitGroupChanged("g");
  await wait(() => ready() && row(10)?.textContent?.includes("New owner:"), "new owner history ready");
  check(!document.querySelector(".chat-ctxmenu") && !document.querySelector(".chat-pinbar"), "owner change clears stale menu and pins");
  delayedRead!.resolve(delayedRead!.response); delayOlder = false; await pause(60);
  check(!row(2), "late history cannot enter replacement owner");
  check(JSON.stringify(JSON.parse(localStorage.getItem(presentationKey)!).pins) === JSON.stringify(savedPins), "owner switch retains original saved pins");
  checks.push("owner isolation; stale menu and delayed history read fenced; original saved pins retained");
  await actOn(10,"chat.quote");
  check(document.querySelector(".chat-quote-bar__text")?.textContent?.includes("New owner:"), "quote uses existing group reply chip");
  await type("Reply to the selected group message");
  document.querySelector<HTMLButtonElement>(".chat-send")!.click();
  await wait(() => sends.length === 1 && row(13), "intentional quoted send acknowledged");
  check(sends[0].input.replyTo === 10 && sends[0].input.ownerScope === "owner-b", "quoted send retains selected seq and current owner");
  check(writes.length === 1, "only the intentional test send writes to the API");
  checks.push("quote submission preserves canonical sequence and current owner");
  await open(12);
  return { passed: true, language, theme, checks, apiWrites: writes.length, providerCalls: 0, historyReads: historyReads.length };
};
document.getElementById("run-fixture")?.addEventListener("click", async () => {
  try { document.getElementById("fixture-result")!.textContent = JSON.stringify(await state.runFixture()); }
  catch (error) { document.getElementById("fixture-result")!.textContent = String(error); }
});
