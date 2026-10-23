import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Real ChatPage, isolated API/WS data. No commands, providers or user stores.
const state = window as any;
const options = new URLSearchParams(location.search);
const backend = options.get("backend") || "openclaw";
const language = options.get("language") || "zh-CN";
const runtime = options.get("runtime") || "codex";
const agentId = backend === "openclaw" ? "main" : `${backend}-activity`;
const key = `agent:${agentId}:main`;
const now = Date.now();
const sessions = [{ key, agentId, agentName: `${backend} · ${runtime}`, backendId: backend, updatedAt: now }];
const intro = { id: "activity-user", role: "user", content: language === "en" ? "Check Agents and scheduled tasks." : "核对助理与定时任务。", timestamp: now - 1000 };
let history: any[] = options.get("scenario") === "openclaw-long" ? openClawLongToolHistory()
  : options.get("scenario") === "native-progress-cold" ? nativeProgressHistory()
  : options.get("scenario") === "native-long" ? nativeLongToolHistory()
  : options.get("scenario") === "nested" ? nestedToolHistory() : [intro];
const zh = language === "zh-CN";
const text = {
  directory: zh ? "查看助理列表" : "View the Agent directory",
  command: zh ? "核对聊天回归" : "Check chat regressions",
  read: zh ? "读取文件 · report.md" : "Read file · report.md",
  cron: zh ? "查看定时任务" : "View scheduled tasks",
  failed: zh ? "运行 Python 脚本" : "Run Python script",
  empty: zh ? "读取技能说明" : "Read Skill instructions",
  xSemantic: zh ? "搜索 X 相关讨论 · AI discussions" : "Search related X discussions · AI discussions",
  xKeyword: zh ? "搜索 X 关键词 · AI filter:links" : "Search X keywords · AI filter:links",
  xThread: zh ? "读取 X 讨论串 · 1234567890123456789" : "Read X thread · 1234567890123456789",
};
const xCalls = [
  ["xSemantic", { operation: "x_semantic_search", query: "AI discussions" }],
  ["xKeyword", { operation: "x_keyword_search", query: "AI filter:links" }],
  ["xThread", { operation: "x_thread_fetch", post_id: "1234567890123456789" }],
] as const;
localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
void i18n.changeLanguage(language);
document.documentElement.setAttribute("data-theme", options.get("theme") || "light");
state.requests = [];
const ready = { type: "event", event: "gateway.ready", payload: {
  protocol: 4, server: { version: "2026.8.1" },
  features: { methods: [], events: [], capabilities: [] },
  auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  policy: { maxPayload: 1048576, maxBufferedBytes: 1048576 },
} };
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { state.socket = this; setTimeout(() => { this.onopen?.(); this.emit(ready); }, 0); }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  send(data: string) {
    const request = JSON.parse(data); state.requests.push(request);
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents: [{ id: agentId, name: sessions[0].agentName, backendId: backend }] }
      : request.method === "chat.history" ? { messages: history, hasMore: false, nextCursor: null, sourceId: `fixture:${key}` } : {};
    setTimeout(() => this.emit({ type: "res", id: request.id, ok: true, payload }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
state.fetch = async (url: unknown) => {
  const path = String(url);
  const payload = path.includes("/__api/status") ? { backends: [{ id: backend, connected: true }] }
    : path.includes("/__api/backends") ? { backends: [] }
    : path.includes("runtime-models") ? { selection: { bindingId: "fixture", runtime, model: null, canSwitch: false, candidates: [] }, capabilities: { attachments: {}, slash: false }, models: [], runtimes: [] }
    : path.includes("/archive") ? { archive: { supported: true, segments: [] } } : {};
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await pause(10);
  }
  await pause();
};
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const thread = () => document.querySelector<HTMLElement>(".chat-thread")!;
const titles = () => Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]')).map(element => element.textContent);
const outcome = (title: string) => Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
  .find(element => element.textContent === title)?.closest("button")?.querySelector<HTMLElement>("[data-st]")?.dataset.st;
const tool = (id: string, name: string, phase: string, data: object = {}) => state.socket.emit({ type: "event", event: "session.tool",
  payload: { sessionKey: key, runId: "activity-run", data: { toolCallId: id, name, phase, ...data } } });
const processButton = () => Array.from(thread().querySelectorAll<HTMLButtonElement>("button"))
  .find(button => button.textContent?.includes(i18n.t("turnLab.processLabel")))!;
const expand = async () => {
  await wait(() => processButton(), "process header");
  if (processButton().getAttribute("aria-expanded") !== "true") processButton().click();
  await wait(() => titles().length, "tool activity rows");
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><ScrollbarProvider /><ChatPage /></UiProvider></HashRouter>);

function nativeProgressHistory(): any[] {
  const zh = language === "zh-CN";
  const shoggoth = { nativeUiVersion: 1, runId: "activity-run", displayId: "native-run:activity-run" };
  const msg = (id: string, content: any, n: number) => ({ id, role: "assistant", shoggoth, content, timestamp: now + n });
  return [intro,
    msg("progress-note", [{ type: "text", activity: true, segmentId: "progress-note", text: zh ? "先核对官方资源限制。" : "First, check the official resource limits." }], 1),
    msg("progress-calls", [
      { type: "toolCall", toolCallId: "search", toolName: "shoggoth/web_search", arguments: { query: "Oracle free limits", activityTitle: zh ? "核对官方资源限制" : "Check official resource limits" } },
      { type: "toolCall", toolCallId: "fetch", toolName: "shoggoth/web_fetch", arguments: { url: "https://example.com/docs", activityTitle: zh ? "核对官方资源限制" : "Check official resource limits" } },
    ], 2),
    { id: "progress-results", role: "toolResult", shoggoth, timestamp: now + 3, content: [
      { type: "toolResult", toolCallId: "fetch", name: "shoggoth/web_fetch", content: "fixture timeout", is_error: true },
      { type: "toolResult", toolCallId: "search", name: "shoggoth/web_search", content: "quota document", is_error: false },
    ] },
    msg("progress-note-next", [{ type: "text", activity: true, segmentId: "progress-note-next", text: zh ? "配额已查到，回收规则页面暂时未能读取。" : "The quotas are available; the reclamation page could not be read." }], 4),
    msg("progress-answer", zh ? "这是最终核对结果。" : "Here are the final findings.", 5),
  ];
}

state.runNativeProgressFixture = async () => {
  const sample = nativeProgressHistory();
  const calls = sample[2].content;
  const expectedTitles = [
    `${calls[0].arguments.activityTitle} · Oracle free limits`,
    `${calls[1].arguments.activityTitle} · example.com/docs`,
  ];
  const notes = [sample[1].content[0], sample[4].content[0]];
  const summaries = () => Array.from(thread().querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))
    .filter(button => button.textContent?.includes(i18n.t("turnLab.processLabel")));
  const verify = async () => {
    await expand();
    check(summaries().length === 1, `public progress must share one activity timeline, got ${summaries().length}`);
    check(JSON.stringify(titles()) === JSON.stringify(expectedTitles), "equal model titles show each parallel call's own target");
    for (const note of notes) {
      const rows = Array.from(thread().querySelectorAll<HTMLButtonElement>("button")).filter(b => b.querySelector("[data-st]") && b.textContent?.includes(note.text));
      check(rows.length === 1, `progress appears once inside the timeline: ${note.text}; got ${rows.length}`);
      check(Array.from(thread().querySelectorAll(".chat-bubble.chat-md")).filter(p => p.textContent?.trim() === note.text).length === 1,
        "each completed public progress message remains in its own bubble");
    }
    check(outcome(expectedTitles[0]) === "ok" && outcome(expectedTitles[1]) === "error", "labels cannot change result statuses");
  };
  const reload = async (messages: any[]) => {
    const reads = state.requests.filter((r: any) => r.method === "chat.history").length;
    history = messages;
    state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: key } });
    await wait(() => state.requests.filter((r: any) => r.method === "chat.history").length > reads, "progress history reload");
    await pause(150);
  };
  if (options.get("scenario") === "native-progress-cold") {
    await wait(() => state.socket && thread()?.textContent?.includes(sample.at(-1).content), "cold public progress history");
    await verify();
    return { language, width: innerWidth, coldHistory: true, tools: 2, progressNotes: 2 };
  }
  await wait(() => state.socket && thread()?.textContent?.includes(intro.content), "fresh public progress session");
  const progress = (part: any) => state.socket.emit({ type: "event", event: "chat", payload: {
    sessionKey: key, runId: "activity-run", state: "interim", message: { role: "assistant", content: [part], shoggoth: sample[1].shoggoth } } });
  progress(notes[0]);
  for (const call of calls) tool(call.toolCallId, call.toolName, "start", { args: call.arguments });
  await expand();
  check(titles().includes(expectedTitles[0]) && titles().includes(expectedTitles[1]), "parallel actions show their targets while running");
  for (const result of sample[3].content) tool(result.toolCallId, result.name, "result", { result: result.content, isError: result.is_error });
  const requestMessage = zh ? "确认 Oracle 实际操作范围与账号状态" : "Confirm the Oracle scope and account status";
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "activity-run", state: "prompt",
    prompt: { version: 1, requestId: "progress-confirmation", runId: "activity-run", kind: "user_input",
      title: zh ? "需要补充信息" : "More information needed", message: requestMessage,
      fields: [{ id: "scope", label: requestMessage, type: "text", required: true }], approvalChoices: [], expiresAt: null } } });
  await expand();
  await wait(() => Array.from(thread().querySelectorAll("button")).some(button => button.querySelector("[data-st]")
    && button.textContent?.includes(requestMessage)), "approval activity uses the card's public message");
  check(Array.from(thread().querySelectorAll(".chat-bubble.chat-md")).filter(p => p.textContent?.trim() === notes[0].text).length === 1,
    "the first public progress bubble survives the approval card");
  if (options.get("scenario") === "native-progress-approval") return {
    backend, runtime, language, width: innerWidth, approvalTitle: requestMessage, progressBubblePreserved: true, providerCalls: 0,
  };
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "activity-run", state: "promptExpire",
    requestId: "progress-confirmation" } });
  progress(notes[1]);
  await pause(100); await verify();
  if (innerWidth >= 1000) {
    const enter = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn")).find(b => b.title === i18n.t("chat.immersiveEnter"))!;
    enter.click(); await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "progress immersive view");
    const immersive = () => document.querySelector('[data-testid="immersive-chat"]')!;
    await wait(() => immersive().textContent?.includes(notes[1].text), "immersive activity keeps progress notes");
    for (const note of notes) check(Array.from(immersive().querySelectorAll("button")).filter(b => b.querySelector("[data-st]") && b.textContent?.includes(note.text)).length === 1,
      "immersive progress appears once inside its timeline");
    for (const note of notes) check(Array.from(immersive().querySelectorAll(".chat-md")).some(p => p.textContent?.trim() === note.text),
      "immersive progress bubbles remain alongside the timeline");
    check(immersive().querySelectorAll('[data-action="1"]').length === 2, "immersive activity keeps per-call titles");
    document.querySelector<HTMLButtonElement>("[data-exit-immersive]")?.click();
    if (document.querySelector('[data-testid="immersive-chat"]')) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "return from progress immersive view");
  }
  history = sample;
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "activity-run", state: "final", message: sample.at(-1) } });
  await wait(() => thread()?.textContent?.includes(sample.at(-1).content), "public progress final answer");
  await reload(sample); await verify();
  check(state.requests.every((r: any) => r.method !== "chat.send"), "progress fixture never dispatches work");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "progress has no horizontal overflow");
  return { backend, runtime, language, width: innerWidth, tools: 2, progressNotes: 2, coldHistory: true, liveToHistory: true, providerCalls: 0 };
};

state.prepareActivityFixture = async () => {
  await wait(() => thread()?.textContent?.includes(intro.content) && state.socket, "ChatPage history");
  tool("directory", "shoggoth/app_state_get", "start", { args: { section: "agents" } });
  tool("directory", "shoggoth/app_state_get", "result", { result: { agents: [] }, isError: false });
  tool("command", "Bash", "start", { args: {} });
  tool("command", "Bash", "update", { args: { command: "npm test", description: text.command }, partialResult: "partial output" });
  await expand();
  await wait(() => titles().includes(text.command), "late command description");
  check(outcome(text.command) === "running", "partial output keeps the tool running");
  check(!thread().textContent?.includes("npm test"), "raw command stays out of the collapsed headline");
  if (innerWidth >= 1000) {
    const enter = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find(button => button.title === i18n.t("chat.immersiveEnter"))!;
    check(enter, "immersive entry exists"); enter.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "immersive view");
    const detail = () => document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.liveDetail")}"]`);
    await wait(() => detail()?.textContent?.includes(text.command), "immersive keeps partial output running");
    tool("command", "Bash", "result", { args: { command: "npm test" }, isError: false });
    await wait(() => detail()?.textContent?.includes("2"), "empty result completes immersive tool");
    document.querySelector<HTMLButtonElement>("[data-exit-immersive]")?.click();
    if (document.querySelector('[data-testid="immersive-chat"]')) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(() => thread(), "return from immersive");
  } else tool("command", "Bash", "result", { args: { command: "npm test" }, isError: false });
  tool("read", "read_file", "start", { args: {} });
  tool("read", "read_file", "result", { args: { path: "/tmp/report.md" }, result: "report", isError: false });
  tool("cron", "cronjob_manage", "start", { args: { action: "list" } });
  tool("cron", "cronjob_manage", "result", { result: { jobs: [{ status: "error" }] }, isError: false });
  tool("failed", "command", "start", { args: { command: "python3 report.py" } });
  tool("failed", "command", "result", { result: "fixture exit 1", isError: true });
  tool("empty", "skill_view", "start", { args: { name: "fixture" } });
  tool("empty", "skill_view", "result", { isError: false });
  for (const [id, args] of xCalls) {
    tool(id, "X search:", "start");
    tool(id, "X search:", "result", { args, isError: false });
  }
  await expand();
  await wait(() => titles().length === Object.keys(text).length, "paired tool rows");
  for (const title of Object.values(text)) check(titles().includes(title), `readable action: ${title}`);
  check(outcome(text.command) === "ok" && outcome(text.empty) === "ok", "empty output still completes a tool");
  check(outcome(text.cron) === "ok" && outcome(text.failed) === "error", "actual and nested errors stay distinct");
  check(!thread().textContent?.includes("federation_agent") && !titles().includes("Bash"), "technical identities stay in details");
  const commandButton = Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
    .find(element => element.textContent === text.command)!.closest("button")!;
  commandButton.click(); await wait(() => thread().textContent?.includes("npm test"), "original command detail");
  commandButton.click(); await pause();
  const threadButton = Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
    .find(element => element.textContent === text.xThread)!.closest("button")!;
  check(!threadButton.disabled, "X receipt input enables details even without output text");
  threadButton.click(); await wait(() => thread().textContent?.includes("post_id"), "X post details");
  threadButton.click(); await pause();
  return { backend, runtime, language, titles: titles(), outcomes: Object.fromEntries(Object.values(text).map(title => [title, outcome(title)])) };
};
state.runActivityFixture = async () => {
  const live = await state.prepareActivityFixture();
  const definitions = [
    ["directory", "shoggoth/app_state_get", { section: "agents" }, { agents: [] }, false],
    ["command", "Bash", { command: "npm test", description: text.command }, "", false],
    ["read", "read_file", { path: "/tmp/report.md" }, "report", false],
    ["cron", "cronjob_manage", { action: "list" }, { jobs: [{ status: "error" }] }, false],
    ["failed", "command", { command: "python3 report.py" }, "fixture exit 1", true],
    ["empty", "skill_view", { name: "fixture" }, "", false],
    ...xCalls.map(([id, args]) => [id, "X search:", args, "", false]),
  ];
  history = [intro, ...definitions.flatMap(([id, name, args, result, isError]) => [
    { id: `call-${id}`, role: "assistant", content: [{ type: "toolCall", id, toolName: name, arguments: args }], timestamp: now + 1 },
    backend === "shoggoth"
      ? { id: `result-${id}`, role: "toolResult", content: [{ type: "toolResult", toolCallId: id, name,
        arguments: args, content: typeof result === "string" ? result : JSON.stringify(result), is_error: isError }], timestamp: now + 2 }
      : { id: `result-${id}`, role: "toolResult", toolCallId: id, toolName: name,
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], isError, timestamp: now + 2 },
  ]), { id: "activity-final", role: "assistant", content: zh ? "检查完成。" : "Checks complete.", timestamp: now + 3 }];
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "activity-run", state: "final", message: history.at(-1) } });
  await wait(() => thread()?.textContent?.includes(history.at(-1).content), "final response");
  await wait(() => state.requests.filter((request: any) => request.method === "chat.history").length > 1, "canonical history reload");
  await pause(180);
  await expand(); await wait(() => titles().length === Object.keys(text).length, "history activity rows");
  for (const title of Object.values(text)) check(titles().includes(title), `history keeps ${title}`);
  check(outcome(text.cron) === "ok" && outcome(text.failed) === "error", "history keeps exact failures");
  check(outcome(text.empty) === "ok", "empty history output stays complete");
  check(state.requests.every((request: any) => request.method !== "chat.send"), "the fixture never dispatches work");
  check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal viewport overflow");
  Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
    .find(element => element.textContent === text.xThread)?.scrollIntoView({ block: "nearest" });
  await pause();
  return { ...live, historyTitles: titles(), providerCalls: 0 };
};

// Same shape as the reported OpenClaw turn, using synthetic identities/content.
// Two custom nested receipts sit between an outer tool call and its result.
function nestedToolHistory(): any[] {
  const call = (id: string, name: string, args: object, offset: number) => ({
    id: `call-${id}`, role: "assistant", timestamp: now + offset,
    content: [{ type: "toolCall", id, name, arguments: args }],
  });
  const result = (id: string, name: string, text: string, offset: number, isError = false) => ({
    id: `result-${id}`, role: "toolResult", toolCallId: id, toolName: name,
    timestamp: now + offset, content: [{ type: "text", text }], isError,
  });
  const nested = (id: string, offset: number, isError: boolean) => ({
    id: `nested-${id}`, role: "custom", customType: "openclaw.nested-tool.v1",
    display: true, excludeFromContext: true, content: "", timestamp: now + offset,
    details: { runId: "nested-run", scopeId: "nested-scope", parentToolCallId: id,
      toolCallId: `nested:${id}`, toolName: "automations", isError },
  });
  return [
    { id: "nested-user", role: "user", content: "Check again tomorrow.", timestamp: now },
    call("add-first", "tool_call", { id: "openclaw:core:automations", args: { action: "add", jobId: "old-job" } }, 1000),
    nested("add-first", 12000, true),
    result("add-first", "tool_call", '{"status":"error","error":"job required"}', 12100, true),
    call("describe", "tool_describe", { id: "openclaw:core:automations" }, 12200),
    result("describe", "tool_describe", "add requires job", 18100),
    call("add-retry", "tool_call", { id: "openclaw:core:automations", args: { action: "add", job: { name: "tomorrow-check" } } }, 18200),
    nested("add-retry", 56000, false),
    result("add-retry", "tool_call", '{"id":"new-job","enabled":true}', 56200),
    call("record", "exec", { command: "echo recorded", description: "Record the verification schedule" }, 56300),
    result("record", "exec", "recorded", 85900),
    { id: "nested-final", role: "assistant", content: "Tomorrow's verification is scheduled.", timestamp: now + 86000 },
  ];
}

state.runNestedToolHistoryFixture = async () => {
  const sample = nestedToolHistory();
  const summaries = () => Array.from(thread().querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))
    .filter(button => button.textContent?.includes(i18n.t("turnLab.processLabel")));
  const reload = async (messages: any[]) => {
    const reads = state.requests.filter((r: any) => r.method === "chat.history").length;
    history = messages;
    state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: key } });
    await wait(() => state.requests.filter((r: any) => r.method === "chat.history").length > reads, "history reload");
    await pause(100);
  };
  const checkSingleTurn = async () => {
    check(summaries().length === 1, `nested metadata must keep one timeline; got ${summaries().length}`);
    await expand();
    check(titles().length === 4, `four outer calls, without duplicate result steps; got ${titles().length}`);
    const statuses = Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
      .map(element => element.closest("button")?.querySelector<HTMLElement>("[data-st]")?.dataset.st);
    check(JSON.stringify(statuses) === JSON.stringify(["error", "ok", "ok", "ok"]), `preserve failure/retry outcomes: ${statuses}`);
    check(thread().querySelectorAll(".chat-group.is-user").length === 1, "nested receipts are not user bubbles");
  };
  await wait(() => state.socket && thread()?.textContent?.includes(sample.at(-1).content), "cold nested history");
  await checkSingleTurn();
  await reload(sample); await checkSingleTurn();
  // The live process must stay singular when final reloads canonical history
  // containing the nested receipts, including its failed first attempt.
  await reload([sample[0]]);
  for (const message of sample) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === "toolCall") {
        tool(part.id, part.name, "start", { args: part.arguments });
      }
    } else if (message.role === "toolResult") {
      tool(message.toolCallId, message.toolName, "result", { result: message.content, isError: message.isError === true });
    }
  }
  await wait(() => summaries().length === 1, "single live process");
  history = sample;
  state.socket.emit({ type: "event", event: "chat", payload: {
    sessionKey: key, runId: "activity-run", state: "final", message: sample.at(-1),
  } });
  await wait(() => thread()?.textContent?.includes(sample.at(-1).content), "settled nested history");
  await reload(sample); await checkSingleTurn();
  const nextReply = "The next request is complete.";
  await reload([...sample,
    { id: "custom-hidden", role: "custom", customType: "fixture.context", display: false, content: "fixture-hidden-context", timestamp: now + 86100 },
    { id: "custom-visible", role: "custom", customType: "fixture.note", display: true, content: "Verification note.", timestamp: now + 86200 },
    { id: "next-user", role: "user", content: "Now read the report.", timestamp: now + 87000 },
    { id: "next-call", role: "assistant", content: [{ type: "toolCall", id: "next-read", name: "read", arguments: { path: "/tmp/report.md" } }], timestamp: now + 87100 },
    { id: "next-result", role: "toolResult", toolCallId: "next-read", toolName: "read", content: "report", timestamp: now + 87200 },
    { id: "next-final", role: "assistant", content: nextReply, timestamp: now + 87300 },
  ]);
  await wait(() => thread()?.textContent?.includes(nextReply), "next user turn");
  check(summaries().length === 2, "a real user input must still separate the two timelines");
  check(thread().querySelectorAll(".chat-group.is-user").length === 2, "only real user inputs render as user bubbles");
  check(!thread().textContent?.includes("fixture-hidden-context"), "custom display:false stays hidden");
  check(thread().textContent?.includes("Verification note."), "visible custom text is preserved");
  await reload(sample); await checkSingleTurn();
  check(state.requests.every((r: any) => r.method !== "chat.send"), "history fixture never dispatches work");
  thread().scrollTop = thread().scrollHeight;
  await pause();
  return { language, width: innerWidth, timelines: 1, outerCalls: 4, errors: 1, liveToHistory: true, nextUserTimelines: 2, providerCalls: 0 };
};


// Compaction follows the real ChatPage WS path, including status-only turns.
state.runCompactionFixture = async () => {
  await wait(() => thread()?.textContent?.includes(intro.content) && state.socket, "ChatPage history");
  const status = (statusKind: string, message?: string, sessionKey = key) => state.socket.emit({ type: "event", event: "chat",
    payload: { sessionKey, backendId: backend, runId: "compaction-run", state: "status", statusKind, text: message } });
  const rows = () => Array.from(thread().querySelectorAll<HTMLButtonElement>("button"))
    .filter(button => button.querySelector("[data-st]") && button.textContent?.includes(i18n.t("turnLab.stepStatus")));
  const chips = () => rows().map(button => button.querySelector<HTMLElement>("[data-st]")!.dataset.st);
  const noToast = () => check(!document.querySelector(".chat-toast"), "automatic compaction must not create a floating toast");
  status("compacting", "Background compaction", "agent:background-fixture:main");
  await pause();
  noToast();
  check(!processButton(), "background compaction must not appear in the active conversation");

  const rawStart = "Compacting context — summarizing earlier conversation so I can continue...";
  status("compacting", rawStart);
  await wait(() => processButton(), "status-only compaction activity");
  noToast();
  if (processButton().getAttribute("aria-expanded") !== "true") processButton().click();
  await wait(() => rows().length === 1 && chips()[0] === "running", "running compaction row");
  check(rows()[0].textContent?.includes(i18n.t("chat.compactingCtx")), "compaction progress uses the UI language");
  check(!rows()[0].textContent?.includes(rawStart), "raw backend wording stays in details");
  rows()[0].click();
  await wait(() => thread().textContent?.includes(rawStart), "raw progress detail");
  rows()[0].click();
  status("compacting", "Summarizing the remaining messages");
  await pause();
  check(rows().length === 1 && chips()[0] === "running", "repeated progress stays running in one row");
  noToast();
  status("compacted", "Context compacted: 128k → 48k tokens");
  await wait(() => chips()[0] === "ok", "confirmed compaction completion");
  check(rows()[0].textContent?.includes(i18n.t("chat.compactedCtx")), "completion uses the UI language");
  noToast();
  status("compacted");
  await pause();
  check(rows().length === 1 && chips()[0] === "ok", "duplicate completion keeps a single row");
  rows()[0].click();
  await wait(() => thread().textContent?.includes("128k → 48k"), "completion receipt detail");
  rows()[0].click();

  status("compacting", "A new compaction cycle");
  await wait(() => rows().length === 2 && chips()[1] === "running", "new compaction cycle");
  status("compacting", "Still summarizing");
  await pause();
  check(chips().join() === "ok,running", "new cycle does not change the completed cycle");
  const terminal = options.get("terminal") || "error";
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, backendId: backend,
    runId: "compaction-run", state: terminal, errorMessage: terminal === "error" ? "Fixture compaction failed" : undefined } });
  await wait(() => processButton(), "terminal compaction activity");
  if (processButton().getAttribute("aria-expanded") !== "true") processButton().click();
  await wait(() => chips()[1] === (terminal === "error" ? "error" : "aborted"), "terminal compaction state");
  check(chips()[0] === "ok", "later failure must preserve confirmed completion");
  check(!rows()[1].textContent?.includes(i18n.t("chat.compactedCtx")), "interrupted compression cannot claim completion");
  noToast();
  check(state.requests.every((request: any) => request.method !== "chat.send" && request.method !== "sessions.compact"),
    "automatic status display must not send or replay work");
  const terminalOutcomes = chips();
  // The terminal snapshot survives history refresh, respects the visibility
  // toggle, and cannot become the live activity of a later user turn.
  if (terminal === "aborted") {
    await wait(() => state.requests.filter((request: any) => request.method === "chat.history").length > 2, "terminal history refresh");
    await pause(100);
    if (processButton().getAttribute("aria-expanded") !== "true") processButton().click();
    await wait(() => chips()[1] === "aborted", "refreshed terminal receipt");
  }
  const toggle = () => document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.hideTrajectory")}"]`);
  check(toggle(), "trajectory toggle exists"); toggle()!.click();
  await wait(() => !processButton(), "hidden compaction activity");
  noToast();
  document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.showTrajectory")}"]`)!.click();
  await wait(() => processButton(), "restored compaction activity");

  const nextInput = language === "en" ? "Continue with the next task." : "继续下一个任务。";
  history = [intro, { id: "compaction-next-user", role: "user", content: nextInput, timestamp: now + 1000 }];
  state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: key } });
  await wait(() => thread().textContent?.includes(nextInput), "next canonical user turn");
  status("compacting", "Next turn compaction");
  await wait(() => processButton(), "next turn process");
  if (processButton().getAttribute("aria-expanded") !== "true") processButton().click();
  await wait(() => rows().length === 1 && chips()[0] === "running", "next turn owns one fresh compaction row");
  noToast();
  thread().scrollTop = thread().scrollHeight;
  await pause(400);
  return { backend, runtime, language, width: innerWidth, terminal, cycles: terminalOutcomes.length,
    outcomes: terminalOutcomes, nextTurnSteps: rows().length, floatingToast: false, providerCalls: 0 };
};

// Recorded ACP shapes with synthetic content and timestamps: long execution,
// command-as-title, a bounded-title fallback, and genuine MCP calls.
function nativeLongToolHistory(runId = "activity-run", start = now): any[] {
  const meta = { nativeUiVersion: 1, runId, displayId: `native-run:${runId}` };
  const calls = [
    ["ls -la /tmp/report", { command: "ls -la /tmp/report", cwd: "/tmp/report" }, 125000],
    ["tool", { command: "python3 report.py", cwd: "/tmp/report" }, 194000],
    ["view_file", { path: "/tmp/report.md" }, 115000],
    ["mcp__shoggoth__app_state_get", { section: "agents" }, 600000],
    ["mcp__other__execute", { command: "python3 other.py" }, 1000],
  ] as const;
  const messages: any[] = [{ id: `${runId}-user`, role: "user", content: "Check the report.", timestamp: start }];
  let timestamp = start + 1000;
  calls.forEach(([name, args, duration], index) => {
    const id = `${runId}-call-${index}`;
    messages.push({ id: `${id}-start`, role: "assistant", timestamp, shoggoth: meta,
      content: [{ type: "toolCall", toolCallId: id, toolName: name, arguments: args }] });
    timestamp += duration;
    messages.push({ id: `${id}-result`, role: "toolResult", timestamp, shoggoth: meta,
      content: [{ type: "toolResult", toolCallId: id, name, arguments: args,
        content: index === 1 ? "Fixture command failed" : "done", is_error: index === 1, durationS: duration / 1000 }] });
    timestamp += 1000;
  });
  messages.push({ id: `${runId}-final`, role: "assistant", timestamp, shoggoth: meta, content: `Report checked: ${runId}.` });
  return messages;
}

// The Gateway's history owner belongs to __openclaw, not to native UI metadata.
// Include a custom tool receipt as well as ordinary assistant/toolResult rows.
function openClawLongToolHistory(runId = "activity-run", start = now): any[] {
  return nativeLongToolHistory(runId, start).map((message, index) => {
    const { shoggoth: _nativeMetadata, id, ...raw } = message;
    return { ...raw, role: index === 6 ? "custom" : raw.role,
      __openclaw: { id, ...(message.role !== "user" ? { runId } : {}) } };
  });
}

state.runOpenClawLongHistoryFixture = state.runNativeLongHistoryFixture = async () => {
  const external = options.get("scenario") === "openclaw-long";
  const makeHistory = external ? openClawLongToolHistory : nativeLongToolHistory;
  const sample = makeHistory();
  const summaries = () => Array.from(thread().querySelectorAll<HTMLButtonElement>("button[aria-expanded]"))
    .filter(button => button.textContent?.includes(i18n.t("turnLab.processLabel")));
  const reload = async (messages: any[]) => {
    const reads = state.requests.filter((r: any) => r.method === "chat.history").length;
    history = messages;
    state.socket.emit({ type: "event", event: "session.message", payload: { sessionKey: key } });
    await wait(() => state.requests.filter((r: any) => r.method === "chat.history").length > reads, "long history reload");
    await pause(100);
  };
  const expected = [i18n.t("turnLab.activity.listDirectory"), i18n.t("turnLab.activity.runScript", { language: "Python" }),
    `${i18n.t("turnLab.activity.readFile")} · report.md`, i18n.t("turnLab.appStateSections.agents"), i18n.t("turnLab.activity.externalTool")];
  const checkSingle = async () => {
    check(summaries().length === 1, `one canonical Run must keep one timeline; got ${summaries().length}`);
    await expand();
    check(JSON.stringify(titles()) === JSON.stringify(expected), `native command and MCP titles: ${JSON.stringify(titles())}`);
    const statuses = Array.from(thread().querySelectorAll<HTMLElement>('[data-action="1"]'))
      .map(element => element.closest("button")?.querySelector<HTMLElement>("[data-st]")?.dataset.st);
    check(statuses.join() === "ok,error,ok,ok,ok", `exact completed outcomes: ${statuses}`);
    check(thread().querySelectorAll(".chat-group.is-user").length === 1, "one actual user message");
  };
  await wait(() => state.socket && thread()?.textContent?.includes(sample.at(-1).content), "cold long native history");
  await checkSingle();
  await reload(sample); await checkSingle();
  await reload([sample[0]]);
  for (const message of sample) for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part.type === "toolCall") tool(part.toolCallId, part.toolName, "start", { args: part.arguments });
    if (part.type === "toolResult") tool(part.toolCallId, part.name, "result", { args: part.arguments, result: part.content, isError: part.is_error, durationS: part.durationS });
  }
  await wait(() => summaries().length === 1, "one live native timeline");
  await expand();
  check(JSON.stringify(titles()) === JSON.stringify(expected), "live titles match completed history");
  if (external && innerWidth >= 1000) {
    const enter = Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-headbtn"))
      .find(button => button.title === i18n.t("chat.immersiveEnter"))!;
    check(enter, "immersive entry exists"); enter.click();
    await wait(() => document.querySelector('[data-testid="immersive-chat"]'), "long-turn immersive view");
    const detail = () => document.querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.liveDetail")}"]`);
    await wait(() => detail()?.textContent?.includes("5"), "immersive retains five tools in the live activity");
  }
  history = sample;
  state.socket.emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "activity-run", state: "final", message: sample.at(-1) } });
  if (external && innerWidth >= 1000) {
    await wait(() => document.querySelector('[data-testid="immersive-chat"]')?.textContent?.includes(sample.at(-1).content), "immersive final text");
    document.querySelector<HTMLButtonElement>("[data-exit-immersive]")?.click();
    if (document.querySelector('[data-testid="immersive-chat"]')) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(() => !document.querySelector('[data-testid="immersive-chat"]'), "return to ordinary long history");
  }
  await wait(() => thread()?.textContent?.includes(sample.at(-1).content), "native final reply");
  await reload(sample); await checkSingle();
  const next = makeHistory("next-run", sample.at(-1).timestamp + 1000);
  await reload([...sample, ...next.slice(1)]);
  check(summaries().length === 2, "different native Runs remain separate even without an intervening user message");
  await reload([...sample, ...next]);
  check(summaries().length === 2 && thread().querySelectorAll(".chat-group.is-user").length === 2, "next user retains its own activity");
  await reload(sample); await checkSingle();
  const firstRow = thread().querySelector<HTMLElement>('[data-action="1"]')!.closest("button")!;
  firstRow.click();
  await wait(() => thread().textContent?.includes("ls -la /tmp/report"), "raw command remains available in details");
  firstRow.click();
  check(state.requests.every((r: any) => r.method !== "chat.send"), "native history fixture never dispatches work");
  thread().scrollTop = thread().scrollHeight;
  await pause();
  return { backend, runtime, language, width: innerWidth, timelines: 1, tools: 5, errors: 1,
    liveToHistory: true, differentRunTimelines: 2, nextUserTimelines: 2, providerCalls: 0 };
};
