import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import LocalFileLinks from "../../app/manage-ui/src/components/LocalFileLinks";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import GroupChatMarkdown from "../../app/manage-ui/src/pages/GroupChatMarkdown";
import GroupChatPanel from "../../app/manage-ui/src/pages/GroupChatPanel";
import CronPage from "../../app/manage-ui/src/pages/CronPage";
import CodexCronRunResult from "../../app/manage-ui/src/pages/cron/CodexCronRunResult";
import { IdeaDetail } from "../../app/manage-ui/src/pages/InspirationPage";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import type { InspirationExecution, InspirationIdea, UnifiedCronJob } from "../../app/manage-ui/src/types";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";

// Real ChatPage and sanitizer; all transport and host calls stay in this fixture.
const state = window as any;
const key = "agent:files:files";
const paths = [
  "~/Documents/季度数据.csv",
  "/Users/example/Desktop/季度报告.pdf",
  "/Users/example/Documents/Quarterly Report/摘要.md",
  "~/Downloads/季度数据.csv",
  "/Users/example/Documents/report.ts",
  "/Users/example/Desktop/报告 备份.pdf",
  "/Users/example/Library/Application Support/Shoggoth/shoggoth-core/workspaces/abc/sessions/def/.artifacts/group-acceptance-0.8.211-20261016-L06-recheck/reminder-plan.md",
  "/Users/example/My Project Files/Quarterly Reports/最终 报告.md",
  "/Users/example/Library/Application Support/Shoggoth/shoggoth-core/workspaces/abc/sessions/def/.artifacts/group-acceptance-0.8.211-20261016-L06-recheck/reminder-plan.md",
  "/tmp/file-link-fixture/openclaw-agent.sqlite",
  "/tmp/file-link-fixture/agent",
];
const authError = `This turn ended before a reply: No API key found for provider "xiaomi-token-plan". Auth store: ${paths[9]} (agentDir: ${paths[10]}). Configure an API key. | missing-provider-auth`;
const chatAttachmentPath = "/tmp/single-chat-attachment.txt";
const sessions = [{ key, agentId: "files", agentName: "文件助手", updatedAt: Date.now() }];
const messages = [
  { id: "user-files", role: "user", content: `请整理 ${paths[0]}，完成后把报告和数据文件发给我。` },
  { id: "assistant-files", role: "assistant", content: [
    "已经整理好了，点击路径即可在 Finder 中定位对应文件。",
    `- 报告：${paths[1]}`,
    `- 摘要：\`${paths[2]}\``,
    `- 数据：\`${paths[3]}\``,
    `- 生成脚本：\`${paths[4]}:12:3\``,
    `- 备份："${paths[5]}"`,
    `- 文件：${paths[6]} 已生成。`,
    `- 含空格的目录和文件名：${paths[7]} saved successfully`,
    `- 原成果入口：[reminder-plan.md](<${paths[8]}>)`,
    "\n[查看说明](https://example.com/guide)",
  ].join("\n") },
  { id: "assistant-auth-error", role: "assistant", content: authError },
  { id: "user-attachment", role: "user", content: `已上传附件。\n\n--- Attached Context ---\n@file:${chatAttachmentPath}` },
];
const originalMessages = JSON.stringify(messages);
const completedAt = Date.now() - 60_000;
const detailPath = "/tmp/详情产物 报告.md";
const detailText = `结果已保存：\`${detailPath}\`。另见 [数据文件](~/Downloads/data.csv)。`;
const job: UnifiedCronJob = { id: "file-reveal-cron", backendId: "openclaw", name: "文件定位回归", enabled: false,
  schedule: { kind: "at", at: new Date(completedAt).toISOString() }, lastRunAt: completedAt, lastStatus: "ok" };
const execution: InspirationExecution = { id: "file-execution", ideaId: "file-idea", runId: "file-run", profileId: null,
  agentId: "files", backendId: "shoggoth", workspace: "/tmp", sessionKey: null, ideaRevision: 1, createdAt: completedAt,
  retryOf: null, status: "completed", resultSummary: detailText, errorCode: null, finishedAt: completedAt, attention: null };
const idea: InspirationIdea = { id: execution.ideaId, body: "文件定位测试", title: "灵感文件", revision: 1, favorite: false,
  archivedAt: null, acceptedAt: null, createdAt: completedAt, updatedAt: completedAt, status: "completed", latestExecution: execution,
  attachments: [{ id: "fixture-document", name: "灵感附件.txt", mimeType: "text/plain", size: 12 }] };
const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
const groupMember = (id: string, name: string) => ({ id, groupId: "file-group", backendId: "shoggoth", agentId: id,
  displayName: name, handle: id, state: "active", position: 0, joinedSeq: 0, leftSeq: null, card: null });
const groupAttachment = { id: "22222222-2222-4222-8222-222222222222", name: "群聊附件.txt", mimeType: "text/plain", size: 12 };
const groupHistory = [
  { id: "delivered-file", seq: 1, author: { kind: "member", memberId: "codex" },
    body: `文件已交付：${paths[6]}\n\n[原文件](<${paths[6]}>)`,
    attachments: [groupAttachment] },
  { id: "summary-file", seq: 2, author: { kind: "member", memberId: "shoggoth" },
    body: `正式文件和评审均已完成。\n\n原成果入口：[reminder-plan.md](<${paths[6]}>)` },
  { id: "attachment-only", seq: 3, author: { kind: "member", memberId: "codex" }, body: "", attachments: [groupAttachment] },
  { id: "not-files", seq: 4, author: { kind: "member", memberId: "shoggoth" },
    body: 'https://example.com/Users/example/report.md\n\n```text\n/tmp/not-a-button.md\n```\n\n<a data-local-path="%2Ftmp%2Finjected.md">literal HTML</a>' },
  { id: "same-filenames", seq: 5, author: { kind: "user" },
    body: "/tmp/one/report.md /tmp/two/report.md /tmp/one/report.md" },
  { id: "auth-error", seq: 6, author: { kind: "member", memberId: "shoggoth" }, body: authError },
].map(message => ({ ...message, groupId: "file-group", threadId: "main", createdAt: message.seq,
  mentions: { memberIds: [], broadcast: false, unresolved: [] } }));
const originalGroupHistory = JSON.stringify(groupHistory);
const groupView = { ownerScope: "file-owner", group: { id: "file-group", name: "正文文件与正式交付", status: "active", purpose: "",
  createdAt: 1, updatedAt: 1, metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: 6,
  mode: "independent", policyVersion: 1, protocolVersion: 1 }, members: [groupMember("codex", "Codex"), groupMember("shoggoth", "Shoggoth")],
  discussion: { id: "file-discussion", status: "idle", publicReplyCount: 2, opportunityCount: 0, deferredMemberIds: [] },
  activeTurns: [], queuedMemberIds: [], internalSessionKeys: [], pendingInteractions: [], tasks: [] };
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage("zh-CN");
state.revealCalls = [];
state.directOpens = [];
state.attachmentReveals = [];
state.groupWrites = [];
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => this.onopen?.(), 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: "files", name: "文件助手" }] }
      : request.method === "chat.history" ? { messages, hasMore: false, nextCursor: null, sourceId: "fixture-file-links" } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown, init?: RequestInit) => {
  const pathname = String(url);
  if (/\/__api\/host\/open-(path|attachment)/.test(pathname)) {
    state.directOpens.push(pathname);
    throw Error("Direct file opening is forbidden in this fixture");
  }
  if (pathname.endsWith("/__api/host/reveal-path")) {
    state.revealCalls.push(JSON.parse(String(init?.body)).path);
    return new Response(JSON.stringify(state.failReveal ? { error: "File not found" } : { ok: true }), {
      status: state.failReveal ? 500 : 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (pathname.startsWith("/__api/host/reveal-attachment?")) {
    state.attachmentReveals.push({ name: new URL(pathname, "http://fixture").searchParams.get("name"), bytes: await (init!.body as Blob).text() });
    return json({ ok: true });
  }
  if (pathname.startsWith("/__api/group-chats/")) {
    const url = new URL(pathname, "http://fixture");
    if (init?.method && init.method !== "GET") { state.groupWrites.push(pathname); throw Error("Unexpected group mutation"); }
    if (url.pathname.endsWith("/detail")) return json(groupView);
    if (url.pathname.endsWith("/messages")) return json({ messages: groupHistory.filter(message => message.seq > Number(url.searchParams.get("afterSeq") || 0)), hasMore: false });
    if (url.pathname.endsWith("/diagnostics")) return json({ collaborationEnabled: false });
    return json({});
  }
  if (pathname.startsWith("/__api/sessions/artifacts?")) return json({ artifacts: { supported: true, items: [{ path: detailPath, name: "详情产物 报告.md", kind: "doc", mtimeMs: completedAt }] } });
  if (pathname.startsWith("/__api/cron/jobs")) {
    const action = new URL(pathname, "http://fixture").searchParams.get("action");
    if (action === "delivery") return json({ source: "transcript", fullText: detailText, startedAt: completedAt, status: "ok" });
    if (action === "result") return json({ available: true, outputComplete: true, fullText: detailText, executionStatus: "completed" });
    if (action === "runs") return json({ runs: [] });
    return json({ jobs: [job], job });
  }
  if (pathname.startsWith("/__api/inspirations/detail?")) return json({ idea });
  if (pathname.startsWith("/__api/inspirations/executions?")) return json({ executions: [execution], total: 1, hasMore: false, nextCursor: null });
  if (pathname.startsWith("/__api/inspirations/agents")) return json({ agents: [] });
  if (pathname.startsWith("/__api/inspirations/activity?")) return json({ runId: execution.runId,
    trajectory: { parts: [], truncated: false }, artifacts: { items: [{ path: detailPath, name: "详情产物 报告.md", ext: ".md" }] } });
  if (pathname.startsWith("/__api/inspirations/media?")) return new Response("detail bytes");
  if (pathname.startsWith("/__api/agents?")) return json({ agents: [] });
  if (pathname === "/__api/config") return json({ config: { disabledBackends: [] } });
  const payload = pathname.includes("/__api/status") ? { backends: [{ id: "openclaw", connected: true }] }
    : pathname.includes("/__api/backends") ? { backends: FALLBACK_BACKEND_DESCRIPTORS.filter(({ id }) => id === "openclaw") }
    : pathname.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", (event) => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", (event) => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const links = (scope = ".chat-thread") => Array.from(document.querySelectorAll<HTMLAnchorElement>(`${scope} a[data-local-path]`));
const fileButtons = (scope = ".chat-thread") => Array.from(document.querySelectorAll<HTMLButtonElement>(`${scope} [data-chat-file-buttons] button`));
const attachments = (scope = ".chat-thread") => Array.from(document.querySelectorAll<HTMLButtonElement>(`${scope} .chat-file-button`));
const root = createRoot(document.getElementById("root")!);
const render = (content: React.ReactNode) => root.render(<HashRouter><NavigationGuardProvider><UiProvider>
  <LocalFileLinks /><ScrollbarProvider />{content}
</UiProvider></NavigationGuardProvider></HashRouter>);
render(<ChatPage />);

state.runFixture = async () => {
  await wait(() => links().length === paths.length, "user and assistant paths");
  check(fileButtons().length === 0, "body file links do not create duplicate buttons below single-chat bubbles");
  check(attachments().length === 1 && attachments()[0].textContent === "single-chat-attachment.txt", "single-chat uploaded attachment remains visible");
  const initialHash = window.location.hash;
  for (const [index, anchor] of links().entries()) {
    check(anchor.getAttribute("href") === "#" && !anchor.target, "local links stay in the app");
    check(decodeURIComponent(anchor.dataset.localPath!) === paths[index], "sanitizer preserves the exact path");
    check(anchor.textContent === paths[index].split("/").at(-1), "all local links display only the filename");
    check(anchor.title === paths[index], "hover preserves the complete path");
    (anchor.querySelector("code") || anchor).click();
    await wait(() => state.revealCalls.length === index + 1, "host reveal request");
    check(state.revealCalls[index] === paths[index], "click sends the exact path to the host");
  }
  check(window.location.hash === initialHash, "revealing files must not navigate the chat");
  const beforeChatAttachment = state.revealCalls.length;
  attachments()[0].click();
  await wait(() => state.revealCalls.length === beforeChatAttachment + 1, "single-chat attachment reveals");
  check(state.revealCalls.at(-1) === chatAttachmentPath, "single-chat attachment retains its original file path");
  const external = document.querySelector<HTMLAnchorElement>('.chat-thread a[href="https://example.com/guide"]')!;
  check(external.target === "_blank" && !external.hasAttribute("data-local-path"), "external links retain normal behavior");
  check(!toSanitizedMarkdownHtml(paths[1]).includes("data-local-path"), "chat-only linkification must not leak through the Markdown cache");
  check(!toSanitizedMarkdownHtml('[bad](javascript:alert(1))', true).includes("href="), "unsafe hrefs stay blocked");

  state.failReveal = true;
  links()[0].click();
  await wait(() => document.body.textContent?.includes("无法在 Finder 中定位文件：File not found"), "failed reveals show an error");
  state.failReveal = false;

  const streamingPath = "/tmp/streamed-report.md";
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, state: "delta", message: {
    role: "assistant", content: `生成中：\`${streamingPath}\``,
  } } });
  await wait(() => links().some((anchor) => anchor.title === streamingPath), "streaming path");
  check(fileButtons().length === 0, "streaming file links do not create duplicate buttons");
  links().find((anchor) => anchor.title === streamingPath)!.click();
  await wait(() => state.revealCalls.at(-1) === streamingPath, "streaming path reveals");
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, state: "final", message: { role: "assistant", content: "完成" } } });
  await wait(() => !document.querySelector(".chat-cursor"), "stream complete");

  Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
    .find((button) => button.title === i18n.t("chat.immersiveEnter"))!.click();
  const immersive = '[data-testid="immersive-chat"]';
  await wait(() => links(immersive).length >= paths.length, "immersive paths");
  check(fileButtons(immersive).length === 0, "immersive file links do not create duplicate buttons");
  check(attachments(immersive).length === 1 && attachments(immersive)[0].textContent === "single-chat-attachment.txt", "immersive uploaded attachment remains visible");
  check(links(immersive).slice(0, paths.length).every((anchor, index) =>
    anchor.textContent === paths[index].split("/").at(-1) && anchor.title === paths[index]), "immersive links retain filename labels and full-path hovers");
  const before = state.revealCalls.length;
  links(immersive)[1].click();
  await wait(() => state.revealCalls.length === before + 1, "immersive path reveals");
  check(state.revealCalls.at(-1) === paths[1], "immersive click uses the same host path");
  const beforeImmersiveButton = state.revealCalls.length;
  attachments(immersive)[0].click();
  await wait(() => state.revealCalls.length === beforeImmersiveButton + 1, "immersive attachment reveals");
  check(state.revealCalls.at(-1) === chatAttachmentPath, "immersive attachment sends the exact path");
  document.querySelector<HTMLButtonElement>(`${immersive} [aria-label="${i18n.t("chat.immersiveExit")}"]`)!.click();
  await wait(() => !document.querySelector(immersive), "return to normal chat");
  document.querySelector<HTMLButtonElement>(".chat-artifacts-trigger")!.click();
  await wait(() => document.querySelector(".chat-artifact-open"), "session artifacts");
  const beforeArtifact = state.revealCalls.length;
  document.querySelector<HTMLButtonElement>(".chat-artifact-open")!.click();
  await wait(() => state.revealCalls.length === beforeArtifact + 1, "artifact row reveals");
  check(state.revealCalls.at(-1) === detailPath, "artifact row reveals exact file");

  const checkDetailLinks = async (scope: string, label: string) => {
    await wait(() => links(scope).length >= 2, `${label} links`);
    check(!document.querySelector(".chat-thread"), "details work without a mounted ChatPage");
    const previousHash = location.hash;
    for (const anchor of links(scope).slice(0, 2)) {
      const before = state.revealCalls.length;
      const expected = decodeURIComponent(anchor.dataset.localPath!);
      (anchor.querySelector("code") || anchor).click();
      await wait(() => state.revealCalls.length === before + 1, `${label} reveal`);
      check(state.revealCalls.at(-1) === expected, `${label} preserves the exact path`);
    }
    check(location.hash === previousHash, `${label} must not navigate`);
  };
  render(<CronPage />);
  await wait(() => document.querySelector(".cal-ev"), "cron calendar occurrence");
  document.querySelector<HTMLButtonElement>(".cal-ev")!.click();
  await checkDetailLinks(".cron-delivery-md", "Cron delivery");
  render(<CodexCronRunResult job={job} run={{ runId: "codex-file-run" }} onClose={() => {}} onChanged={() => {}} />);
  await checkDetailLinks(".codex-run-output", "Codex Cron result");
  render(<IdeaDetail id={idea.id} onClose={() => {}} onChange={async () => {}} />);
  await checkDetailLinks('[role="dialog"]', "Inspiration result");
  await wait(() => document.querySelector(`[data-inspiration-run="${execution.runId}"] button`), "Inspiration artifact");
  const artifact = document.querySelector<HTMLButtonElement>(`[data-inspiration-run="${execution.runId}"] button`)!;
  const beforeInspiration = state.revealCalls.length;
  artifact.click();
  await wait(() => state.revealCalls.length === beforeInspiration + 1, "Inspiration artifact reveals");
  check(state.revealCalls.at(-1) === detailPath, "Inspiration artifact reveals exact path");
  document.querySelector<HTMLButtonElement>('[data-kind="file"] button')!.click();
  await wait(() => state.attachmentReveals.length === 1, "Inspiration attachment reveals");
  check(state.attachmentReveals[0].name === "灵感附件.txt" && state.attachmentReveals[0].bytes === "detail bytes", "Inspiration attachment preserves name and bytes");

  const groupText = `文件：${paths[6]}\n\n验证：已复读目标文件。\n\n原成果入口：[reminder-plan.md](<${paths[6]}>)`;
  render(<div className="chat-shell" style={{ display: "block", padding: 32, boxSizing: "border-box" }}>
    <h2>消息气泡中的文件链接只显示文件名</h2>
    <div style={{ display: "grid", gap: 24 }}>
      <GroupChatMarkdown className="chat-bubble chat-md file-link-group-direct" text={groupText} />
      <GroupChatMarkdown className="chat-bubble chat-md file-link-group-decorated" text={groupText} lead={<span>群聊文件交付 · </span>} />
    </div>
  </div>);
  for (const scope of [".file-link-group-direct", ".file-link-group-decorated"]) {
    await wait(() => links(scope).length === 2, "group paths with and without decorated text");
    for (const anchor of links(scope)) {
      check(decodeURIComponent(anchor.dataset.localPath!) === paths[6], "group path includes Application Support and the filename");
      const before = state.revealCalls.length;
      anchor.click();
      await wait(() => state.revealCalls.length === before + 1, "group path reveals");
      check(state.revealCalls.at(-1) === paths[6], "group host receives the whole path");
    }
    check(links(scope)[0].textContent === "reminder-plan.md", "bare path displays only the filename");
    check(links(scope)[1].textContent === "reminder-plan.md", "explicit Markdown retains its filename label");
    check(links(scope).every(anchor => anchor.title === paths[6]), "group link hovers preserve the full path");
    check(fileButtons(".chat-shell").length === 0, "group plain and decorated Markdown do not repeat body file links as buttons");
  }
  await wait(() => !document.body.textContent?.includes("无法在 Finder 中定位文件：File not found"), "test error toast dismisses before capture");
  render(<div className="chat-shell" style={{ display: "flex", flexDirection: "column" }}>
    <GroupChatPanel groupId="file-group" onArchived={() => {}} />
  </div>);
  const groupRow = (seq: number) => document.querySelector<HTMLElement>(`[data-group-timeline] [data-seq="${seq}"]`)!;
  await wait(() => groupRow(6), "real group message timeline");
  check(fileButtons("[data-group-timeline]").length === 0, "group messages do not create duplicate body file buttons");
  check(attachments('[data-seq="1"]').length === 1, "body links do not hide a separately uploaded group attachment");
  check(attachments('[data-seq="2"]').length === 0, "summary file path remains only inside the bubble");
  check(attachments('[data-seq="3"]').length === 1 && !groupRow(3).querySelector(".chat-bubble"), "attachment-only messages retain their file button");
  check(attachments('[data-seq="4"]').length === 0, "external URLs, fenced code and escaped HTML do not create file buttons");
  check(links('[data-seq="5"]').map(anchor => anchor.title).join("|") === "/tmp/one/report.md|/tmp/two/report.md|/tmp/one/report.md", "same filename in distinct directories retains every original body link");
  check(links('[data-seq="6"]').length === 2 && attachments('[data-seq="6"]').length === 0, "auth-error example shows both file links without duplicate buttons");
  const beforeSummary = state.revealCalls.length;
  links('[data-seq="2"]')[0].click();
  await wait(() => state.revealCalls.length === beforeSummary + 1, "summary body link reveals local file");
  check(state.revealCalls.at(-1) === paths[6], "summary body link retains its exact local path");
  for (const seq of [1, 3]) {
    const before = state.attachmentReveals.length;
    attachments(`[data-seq="${seq}"]`)[0].click();
    await wait(() => state.attachmentReveals.length === before + 1, "group uploaded attachment reveals");
    check(state.attachmentReveals.at(-1).name === groupAttachment.name && state.attachmentReveals.at(-1).bytes === "detail bytes", "group attachment preserves its name and bytes");
  }
  check(state.groupWrites.length === 0 && JSON.stringify(groupHistory) === originalGroupHistory, "file actions never create group actions or rewrite message history");
  for (const seq of [1, 3]) {
    const bounds = groupRow(seq).getBoundingClientRect();
    for (const button of attachments(`[data-seq="${seq}"]`)) {
      const rect = button.getBoundingClientRect();
      check(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, "file buttons fit inside the message width");
    }
  }
  groupRow(1).scrollIntoView({ block: "start" });
  await new Promise(requestAnimationFrame);
  const timelineBounds = document.querySelector<HTMLElement>("[data-group-timeline]")!.getBoundingClientRect();
  const firstButtonBounds = attachments('[data-seq="1"]')[0].getBoundingClientRect();
  check(timelineBounds.height > 160 && firstButtonBounds.bottom > timelineBounds.top && firstButtonBounds.top < timelineBounds.bottom,
    "the file button is visible in the message viewport");
  check(state.directOpens.length === 0, "no surface directly opens any file");
  check(JSON.stringify(messages) === originalMessages, "filename labels do not rewrite message history");
  return { passed: true, width: innerWidth, paths: paths.length, hostReveals: state.revealCalls.length, attachmentReveals: state.attachmentReveals.length,
    checks: "filename labels, no duplicate body file buttons, exact paths, no navigation, errors, streaming, immersive, details, group plain and decorated Markdown, uploaded attachments preserved, auth-error example, summary body link, no group writes" };
};
