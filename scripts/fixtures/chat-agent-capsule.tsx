import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import AgentsPage from "../../app/manage-ui/src/pages/AgentsPage";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import ChatPage from "../../app/manage-ui/src/pages/ChatPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import ScrollbarProvider from "../../app/manage-ui/src/components/ScrollbarProvider";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// The actual ChatPage, with all transports confined to synthetic records.
const state = window as any;
const previewParams = new URLSearchParams(location.search);
const avatarPreview = previewParams.has("avatar-preview");
const alpha = { id: "capsule-shrimp", name: avatarPreview ? "Shoggoth" : "虾长老", backendId: avatarPreview ? "shoggoth" : "openclaw" };
const beta = { id: "hermes-lotus", name: "莲叶", backendId: "hermes" };
const agents = [alpha, beta];
const sessions = [alpha, beta].map((agent, index) => ({ key: `agent:${agent.id}:main`,
  agentId: agent.id, agentName: agent.name, backendId: agent.backendId, updatedAt: Date.now() - index * 60_000 }));
const requests: string[] = [];
const writes: string[] = [];
const soulText = "# 我是谁\n\n我是虾长老，喜欢把复杂的事情讲清楚，也喜欢陪你把想法变成作品。\n\n## 我的工作方式\n\n- 先理解你的意图，再开始行动。\n- 认真核对细节，保留每一步有用的成果。\n- 遇到不确定的地方，坦诚说明。";
const idea = (id: string, body: string, archived = false) => ({ id, body, title: null, revision: 1,
  favorite: false, attachments: [], archivedAt: archived ? Date.now() : null, acceptedAt: null,
  createdAt: Date.now(), updatedAt: Date.now(), status: "completed", latestExecution: null });
const notes = [idea("capsule-note-1", "把清晨散步的声音，做成一张有温度的海报。"),
  idea("capsule-note-2", "给每周的复盘留一页空白，记录那些还没有答案的想法。")];
Object.assign(notes[1], { attachments: [{ id: "capsule-attachment", name: "设计参考.pdf",
  mimeType: "application/pdf", size: 256, textOffset: 0 }] });
const archived = idea("capsule-archived", "已经归档的旅行灵感。", true);
state.failCron = false;
state.longSoul = false;
state.deferSoul = false;
state.unsafeSoul = false;
state.deferArtifacts = false;
state.failArtifacts = false;
state.requests = requests;
state.writes = writes;
if (!avatarPreview) localStorage.clear();
localStorage.setItem("shoggoth.chat.sessions.v1", JSON.stringify(sessions));
localStorage.setItem("shoggoth.chat.lastActive.v1", sessions[0].key);
localStorage.setItem("shoggoth.chat.immersive.v1", "0");
document.documentElement.dataset.theme = previewParams.get("theme") === "dark" ? "dark" : "light";
void i18n.changeLanguage(previewParams.get("lang") === "en" ? "en" : "zh-CN");
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send(raw: string) {
    const request = JSON.parse(raw);
    if (["chat.send", "sessions.patch", "sessions.delete", "sessions.reset"].includes(request.method)) {
      writes.push(request.method);
      throw Error("This fixture must not mutate or send to an Agent");
    }
    const current = sessions.find(session => session.key === request.params?.sessionKey) || sessions[0];
    const payload = request.method === "sessions.list" ? { sessions, hasMore: false }
      : request.method === "agents.list" ? { agents }
        : request.method === "chat.history" ? { messages: [
          { id: "user", role: "user", content: "整理一下今天的想法。", timestamp: Date.now() - 60_000 },
          { id: "assistant", role: "assistant", content: `${current.agentName}：原有笔记都整理好了。点击顶部胶囊，可以查看我的资料、Cron 任务和灵感便签。`, timestamp: Date.now() },
        ], hasMore: false, nextCursor: null, sourceId: `capsule-${current.key}` } : {};
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, payload }) }), 0);
  }
  close() { this.readyState = 3; }
}
state.WebSocket = FixtureSocket;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  if (state.failAvatarLibrary && url.pathname === "/avatar/library/") return new Response(null, { status: 503 });
  if (state.failAvatarSave && url.pathname === `/avatar/${alpha.id}` && init?.method === "PUT") return new Response(null, { status: 507 });
  if (!url.pathname.startsWith("/__api")) return realFetch(input, init);
  requests.push(url.pathname + url.search);
  if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url.pathname}`);
  let payload: unknown = {};
  if (url.pathname === "/__api/status") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS.map(({ id }) => ({
    id, connected: true, info: { readyAgentIds: agents.filter(agent => agent.backendId === id).map(agent => agent.id) },
  })) };
  if (url.pathname === "/__api/backends") payload = { backends: FALLBACK_BACKEND_DESCRIPTORS };
  if (url.pathname === "/__api/agents") payload = { agents: url.searchParams.has("backend") ? agents.filter(agent => agent.backendId === url.searchParams.get("backend")) : agents };
  if (url.pathname.startsWith("/__api/agents/")) {
    const agent = agents.find(value => url.pathname.includes(value.id))!;
    if (url.pathname.endsWith("/artifacts")) {
      if (state.deferArtifacts) {
        state.deferArtifacts = false;
        await new Promise<void>(resolve => { state.releaseArtifacts = resolve; });
      }
      if (state.failArtifacts) return new Response(JSON.stringify({ error: "Artifacts fixture unavailable" }), { status: 503 });
      payload = { artifacts: { supported: true, total: agent.id === alpha.id ? 2 : 0, items: agent.id === alpha.id ? [
        { path: "/fixture/current-report.md", name: "本轮报告.md", kind: "doc", area: "session-output", mtimeMs: Date.now() },
        { path: "/fixture/older-session.pdf", name: "往期会话产出.pdf", kind: "doc", area: "session-output", mtimeMs: Date.now() - 86_400_000 },
      ] : [] } };
    } else if (url.pathname.endsWith("/runtime-models")) {
      payload = { selection: { bindingId: "fixture-binding", runtime: "codex", model: null, canSwitch: false, candidates: [] },
        capabilities: { attachments: {}, slash: false, steer: false }, models: [], runtimes: [] };
    } else if (url.pathname.endsWith("/file")) {
      if (url.searchParams.get("file") !== "SOUL.md") throw Error("Only SOUL should be loaded");
      if (agent.id === alpha.id && state.deferSoul) {
        state.deferSoul = false;
        await new Promise<void>(resolve => { state.releaseSoul = resolve; });
      }
      const content = state.longSoul ? Array(20).fill(soulText).join("\n\n") : soulText;
      payload = { file: { name: "SOUL.md", content: agent.id === alpha.id ? content
        + (state.unsafeSoul ? "\n\n<script>window.fixtureUnsafe = true;</script>" : "") : "", missing: agent.id === beta.id } };
    } else payload = { agent: { ...agent, files: [{ name: "SOUL.md" }] } };
  }
  if (url.pathname === "/__api/cron/jobs") {
    if (state.failCron) return new Response(JSON.stringify({ error: "Cron fixture unavailable" }), { status: 503 });
    const jobs = [
      { id: "capsule-daily", backendId: alpha.backendId, agentId: alpha.id, name: "每天早上的灵感整理",
        description: "把昨晚留下的零散想法整理成一份清晰的创作清单。", enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *" }, scheduleDisplay: "每天 09:00",
        nextRunAt: Date.now() + 86_400_000, lastRunAt: Date.now() - 3_600_000, lastStatus: "ok" },
      { id: "capsule-weekly", backendId: alpha.backendId, agentId: alpha.id, name: "周末阅读回顾",
        prompt: "回顾这一周收藏的文章和灵感。", enabled: false,
        schedule: { kind: "cron", expr: "0 18 * * 0" }, scheduleDisplay: "每周日 18:00",
        lastStatus: "error", lastError: "Fixture previous run failed" },
      { id: "foreign-agent", backendId: alpha.backendId, agentId: "someone-else", name: "其他 Agent 的任务", enabled: true },
      { id: "foreign-backend", backendId: beta.backendId, agentId: alpha.id, name: "其他后端的同名 Agent 任务", enabled: true },
    ];
    const job = jobs.find(value => value.id === url.searchParams.get("id"));
    payload = url.searchParams.get("action") === "delivery"
      ? { fullText: "今天整理出了三个创作方向，可以从清晨散步的声音开始。", status: "ok",
        startedAt: job?.lastRunAt, durationMs: 2500, source: "transcript", model: "fixture-model" }
      : url.searchParams.get("action") === "detail" ? { job } : { jobs };
  }
  if (url.pathname === "/__api/inspirations/agents") payload = { agents: agents.map(agent => ({ ...agent,
    backendName: agent.backendId, capabilities: { execute: true, session: true, respond: true, cancel: true, reason: null } })) };
  if (url.pathname === "/__api/inspirations/idle-agents") payload = { agents: [], busyAgents: [] };
  if (url.pathname === "/__api/inspirations/models") payload = { defaultModel: null, models: [] };
  if (url.pathname === "/__api/inspirations") {
    const isAlpha = url.searchParams.get("agentId") === alpha.id && url.searchParams.get("backendId") === alpha.backendId;
    const isArchived = url.searchParams.get("filter") === "archived";
    const more = url.searchParams.has("cursor");
    payload = !isAlpha ? { items: [], total: 0, hasMore: false, nextCursor: null }
      : isArchived ? { items: [archived], total: 1, hasMore: false, nextCursor: null }
        : { items: more ? [notes[1]] : [notes[0]], total: 2, hasMore: !more, nextCursor: more ? null : "capsule-next" };
  }
  if (url.pathname === "/__api/inspirations/detail") payload = { idea: [...notes, archived].find(value => value.id === url.searchParams.get("id")) };
  if (url.pathname === "/__api/inspirations/executions") payload = { executions: [], total: 0, hasMore: false, nextCursor: null };
  if (url.pathname === "/__api/sessions/artifacts") throw Error("Chat must request Agent outputs, not session artifacts");
  if (url.pathname.endsWith("/archive")) payload = { archive: { supported: false, segments: [] } };
  if (url.pathname === "/__api/chat/capabilities") payload = { slash: false, attachments: {} };
  if (url.pathname === "/__api/chat/cache-scope") payload = { backendId: url.searchParams.get("backend"), cacheScope: "capsule-fixture" };
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};
window.addEventListener("error", event => { state.fixtureError = event.error?.stack || event.message; });
window.addEventListener("unhandledrejection", event => { state.fixtureError = String(event.reason); });
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (state.fixtureError) throw Error(state.fixtureError);
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 240));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const header = () => document.querySelector<HTMLElement>(".chat-header")!;
const region = () => document.getElementById("chat-agent-panel")!;
const tools = () => Array.from(header().querySelectorAll<HTMLButtonElement>(".chat-header__tools > button:not([hidden])"));
const clickPanel = (kind: string) => {
  if (kind === "profile") header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!.click();
  else tools()[kind === "artifacts" ? 0 : kind === "cron" ? 1 : 2].click();
};
const switchAgent = async (agent: typeof alpha) => {
  const row = Array.from(document.querySelectorAll<HTMLElement>(".chat-agent"))
    .find(value => value.textContent?.includes(agent.name))!;
  row.click();
  await wait(() => header().querySelector(".chat-header__name")?.textContent === agent.name, `switch to ${agent.name}`);
};
const closePanel = async () => {
  if (header()?.dataset.agentPanel === "avatar") {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(() => header().dataset.agentPanel === "profile", "avatar picker returns to profile");
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => region().getAttribute("aria-hidden") === "true", "panel closed");
  await settle();
};
createRoot(document.getElementById("root")!).render(<HashRouter><UiProvider><NavigationGuardProvider><ScrollbarProvider /><Routes><Route path="/agents" element={<AgentsPage />} /><Route path="*" element={<ChatPage />} /></Routes></NavigationGuardProvider></UiProvider></HashRouter>);

const avatarEdit = () => region().querySelector<HTMLButtonElement>(`button[title="${i18n.t("chat.changeAvatar")}"]`);
const avatarPicker = () => region().querySelector<HTMLElement>("section[aria-labelledby]");
const avatarBack = () => header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!;
const openAvatarPicker = async () => {
  await wait(() => header(), "chat header ready");
  if (header().dataset.agentPanel !== "profile") clickPanel("profile");
  await wait(avatarEdit, "avatar edit entry");
  const trigger = avatarEdit()!;
  const avatar = trigger.querySelector(".chat-header__avatar")!.getBoundingClientRect();
  const name = trigger.nextElementSibling!.firstElementChild!.getBoundingClientRect();
  trigger.click();
  await wait(avatarPicker, "avatar picker page");
  return { avatar, name };
};
if (avatarPreview) void openAvatarPicker().catch(error => { state.fixtureError = String(error); });

state.runAvatarPickerFixture = async () => {
  await switchAgent(alpha);
  const button = (key: string) => Array.from(avatarPicker()!.querySelectorAll<HTMLButtonElement>("button"))
    .find(element => element.textContent?.trim() === i18n.t(key))!;
  const choices = () => Array.from(avatarPicker()?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []);
  const choiceImage = (choice: HTMLInputElement) => choice.closest("label")!.querySelector("img")!;
  const loaded = () => wait(() => choices().length === 20 && choices().every(choice => {
    const image = choiceImage(choice);
    return image.complete && image.naturalWidth > 0;
  }), "twenty preset images decoded");
  const currentImage = () => realFetch(`/avatar/${alpha.id}`, { cache: "reload" });
  state.failAvatarLibrary = true;
  await openAvatarPicker();
  check(avatarBack().title === i18n.t("chat.avatarPicker.back") && document.activeElement === avatarBack(),
    "the header has a focused Back button for the avatar page");
  check(header().querySelector("h2")?.textContent === i18n.t("chat.changeAvatar")
    && !header().querySelector(".chat-header__statusline") && !avatarPicker()?.querySelector("h2"),
    "the avatar title replaces session identity in the header and is shown only once");
  await wait(() => avatarPicker()?.querySelector('[role="alert"]'), "library error");
  check(!button("chat.avatarPicker.upload").disabled, "upload stays available if the gallery is unavailable");
  state.failAvatarLibrary = false;
  button("common.retry").click();
  await loaded();
  check(button("chat.avatarPicker.save").disabled, "opening the gallery doesn't select an image");
  const first = choices();
  check(new Set(first.map(choice => choice.value)).size === 20, "one batch has twenty distinct images");
  const selectedUrl = choiceImage(first[0]).src;
  first[0].click();
  await wait(() => avatarPicker()?.querySelector("img")?.src === selectedUrl, "preset preview");
  button("chat.avatarPicker.shuffle").click();
  await loaded();
  check(choices().every(choice => !first.some(previous => previous.value === choice.value)), "successive batches don't share images");
  check(avatarPicker()?.querySelector("img")?.src === selectedUrl, "shuffling keeps the preview selection");
  avatarBack().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(() => avatarEdit() && document.activeElement === avatarEdit(), "Escape returns focus to the profile avatar");
  check((await currentImage()).headers.get("content-type") === "image/jpeg", "preview and Escape don't change the saved image");

  await openAvatarPicker();
  avatarBack().click();
  await wait(() => avatarEdit() && document.activeElement === avatarEdit(), "header Back returns focus to the profile avatar");
  await openAvatarPicker();
  await loaded();
  choices()[0].click();
  await wait(() => !button("chat.avatarPicker.save").disabled, "preset ready to save");
  const sidebarAvatar = () => document.querySelector<HTMLImageElement>(`.chat-agent__avatar img[src^="/avatar/${alpha.id}"]`);
  const priorAvatarUrl = sidebarAvatar()?.src;
  state.failAvatarSave = true;
  button("chat.avatarPicker.save").click();
  await wait(() => avatarPicker()?.querySelector('[role="alert"]'), "failed save shows a retryable error");
  check(choices()[0].checked, "failed save keeps the selection");
  state.failAvatarSave = false;
  button("chat.avatarPicker.save").click();
  await wait(avatarEdit, "save returns to the profile");
  await wait(() => sidebarAvatar()?.src !== priorAvatarUrl && sidebarAvatar()?.naturalWidth === 640, "sidebar loads saved preset");
  const preset = await (await currentImage()).blob();
  check(preset.type === "image/png", "the preset was saved by the real avatar endpoint");

  await openAvatarPicker();
  const input = avatarPicker()!.querySelector<HTMLInputElement>('input[type="file"]')!;
  const upload = (file: File) => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  upload(new File(["bad image"], "invalid.png", { type: "image/png" }));
  await wait(() => avatarPicker()?.querySelector('[role="alert"]')?.textContent === i18n.t("chat.avatarPicker.imageFailed"), "invalid upload shows an error");
  upload(new File([preset], "custom.png", { type: "image/png" }));
  await wait(() => avatarPicker()?.querySelector("img")?.src.startsWith("blob:"), "uploaded image is previewed locally");
  button("chat.avatarPicker.save").click();
  await wait(avatarEdit, "custom image save returns to the profile");
  await wait(() => sidebarAvatar()?.naturalWidth === 768, "sidebar loads the uploaded image");
  await closePanel();
  return { passed: true, checks: "header title and Back, Escape focus, real preset gallery, retry, non-overlapping batches, preview, failed save, sidebar refresh, invalid and valid upload" };
};

state.prepareCapsuleShot = async (kind: string, theme = "light") => {
  document.documentElement.dataset.theme = theme;
  await closePanel();
  await switchAgent(alpha);
  if (kind === "avatar-picker") {
    const profile = await openAvatarPicker();
    await wait(() => {
      const images = Array.from(avatarPicker()?.querySelectorAll<HTMLImageElement>('[role="radiogroup"] img') ?? []);
      return images.length === 20 && images.every(img => img.complete && img.naturalWidth > 0);
    }, "avatar gallery ready for screenshot");
    const picker = avatarPicker()!;
    const grid = picker.querySelector('[role="radiogroup"]')!;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").map(value => parseFloat(value));
    check(columns.length === 5, "avatar gallery always shows five per row");
    const currentAvatar = picker.querySelector("img")!.getBoundingClientRect();
    const pickerName = picker.querySelector('[role="status"]')!.previousElementSibling!.getBoundingClientRect();
    check(Math.abs(pickerName.x - profile.name.x) <= 1 && Math.abs(pickerName.y - profile.name.y) <= 1,
      "avatar picker text aligns with profile text");
    check(currentAvatar.width === profile.avatar.width && currentAvatar.height === profile.avatar.height,
      "current avatar matches the profile at this width");
    const tiles = Array.from(grid.querySelectorAll("img"), image => image.getBoundingClientRect());
    check(tiles.every((tile, index) => tile.width === tile.height
      && Math.abs(tile.width - Math.min(140, columns[index % columns.length])) <= 0.1),
      "presets are 140px squares when the column has room and scale down to fit");
    check(tiles[1].left - tiles[0].right >= 16 && tiles[5].top - tiles[0].bottom >= 18,
      "presets have increased horizontal and vertical spacing");
    const buttons = Array.from(picker.querySelectorAll("button"));
    const shuffle = buttons.find(button => button.textContent?.trim() === i18n.t("chat.avatarPicker.shuffle"))!.getBoundingClientRect();
    const save = buttons.find(button => button.textContent?.trim() === i18n.t("chat.avatarPicker.save"))!.getBoundingClientRect();
    check(shuffle.right <= save.left && save.bottom <= grid.getBoundingClientRect().top
      && Math.abs((shuffle.top + shuffle.bottom) / 2 - (save.top + save.bottom) / 2) <= 1,
      "Save sits to the right of Shuffle on the gallery toolbar");
    const body = picker.parentElement!;
    const style = getComputedStyle(body);
    const availableWidth = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    check(Math.abs(grid.getBoundingClientRect().width - availableWidth) <= 1,
      "avatar gallery fills the available page width");
    picker.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
    await settle();
    return;
  }
  clickPanel(kind);
  await wait(() => kind === "profile" ? region().textContent?.includes("我的工作方式")
    : kind === "cron" ? region().textContent?.includes("每天早上的灵感整理")
      : kind === "artifacts" ? region().textContent?.includes("往期会话产出.pdf") : region().querySelector("[data-inspiration-id]"), "shot data");
  await settle();
};
state.runCapsuleMotionFixture = async (reduced = false) => {
  await switchAgent(alpha);
  await closePanel();
  const baseline = [header().querySelector(".chat-header__avatar-trigger")!,
    header().querySelector(".chat-header__id")!, ...tools()].map(element => element.getBoundingClientRect().toJSON());
  const collapsed = header().getBoundingClientRect().height;
  const expanded = parseFloat(header().style.getPropertyValue("--chat-agent-panel-height"));
  const pointerToggle = (kind: string) => {
    const trigger = kind === "profile" ? header().querySelector(".chat-header__avatar-trigger")!
      : tools()[kind === "artifacts" ? 0 : kind === "cron" ? 1 : 2];
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  };
  const sample = async () => {
    const heights: number[] = [];
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      const controls = [header().querySelector(".chat-header__avatar-trigger")!,
        header().querySelector(".chat-header__id")!, ...tools()];
      controls.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        for (const key of ["x", "y", "width", "height"] as const) {
          check(Math.abs(rect[key] - baseline[index][key]) < .1, `${index} ${key} moved during panel transition`);
        }
      });
      heights.push(header().getBoundingClientRect().height);
    } while (performance.now() - start < 300);
    return heights;
  };
  for (const kind of ["profile", "artifacts", "cron", "inspiration"]) {
    pointerToggle(kind);
    const opening = await sample();
    check(Math.abs(opening.at(-1)! - expanded) < 1, `${kind} reaches full height`);
    check(reduced || opening.some(height => height > collapsed + 1 && height < expanded - 1), `${kind} has intermediate opening frames`);
    if (reduced) check(opening.every(height => Math.abs(height - expanded) < 1), "reduced motion opens immediately");
    pointerToggle(kind);
    const closing = await sample();
    check(Math.abs(closing.at(-1)! - collapsed) < 1, `${kind} returns to collapsed height`);
    check(reduced || closing.some(height => height > collapsed + 1 && height < expanded - 1), `${kind} has intermediate closing frames`);
    if (reduced) check(closing.every(height => Math.abs(height - collapsed) < 1), "reduced motion closes immediately");
  }
  if (!reduced) {
    pointerToggle("profile");
    await new Promise(resolve => setTimeout(resolve, 45));
    const interrupted = header().getBoundingClientRect().height;
    check(interrupted > collapsed + 1 && interrupted < expanded - 1, "interrupt while the surface is moving");
    pointerToggle("profile");
    await wait(() => !header().dataset.agentPanel, "reverse state committed");
    const reverseStart = header().getBoundingClientRect().height;
    const reversing = await sample();
    check(reverseStart < expanded - 1 && reversing[0] <= reverseStart + 1
      && reversing.every((height, index) => index === 0 || height <= reversing[index - 1] + 1)
      && Math.abs(reversing.at(-1)! - collapsed) < 1,
    `closing reverses from the current height: ${JSON.stringify({ interrupted, reverseStart, reversing })}`);
  }
  const avatar = header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!;
  avatar.focus();
  await new Promise(resolve => setTimeout(resolve, 160));
  const avatarCss = { backgroundColor: getComputedStyle(avatar).backgroundColor, outlineColor: getComputedStyle(avatar).outlineColor };
  tools()[0].focus();
  await new Promise(resolve => setTimeout(resolve, 160));
  const toolCss = getComputedStyle(tools()[0]);
  check(avatarCss.backgroundColor === toolCss.backgroundColor && avatarCss.outlineColor === toolCss.outlineColor,
    `left and right controls share neutral keyboard feedback: ${JSON.stringify({ avatar: avatarCss,
      tool: { backgroundColor: toolCss.backgroundColor, outlineColor: toolCss.outlineColor },
      focusVisible: tools()[0].matches(":focus-visible") })}`);
  check(writes.length === 0, "motion review cannot execute Agent work");
  return { passed: true, reduced, viewport: [innerWidth, innerHeight], collapsed, expanded,
    checks: "fixed control and identity geometry on every frame, open/close intermediate frames, reversal, neutral focus" };
};
state.runCapsuleFixture = async () => {
  await wait(() => header() && document.querySelector(".chat-thread .chat-bubble"), "ChatPage ready");
  check(tools().length === 4, "exactly four visible actions");
  check(document.querySelector<HTMLButtonElement>("[data-testid=chat-immersive-enter]")?.getClientRects().length === 0, "immersive entry is hidden");
  check(tools().map(button => button.title).join("|") === [i18n.t("chat.agentArtifactsTitle"), i18n.t("chat.agentPanelCron"), i18n.t("agents.tabInspiration"), i18n.t("chat.agentOpenDetails")].join("|"), "Agent outputs / Cron / Spark Notes / Agent details order");
  check(!requests.some(url => /SOUL|\/__api\/cron|\/__api\/inspirations\?/.test(url)), "panels load on demand");
  await settle();
  const collapsedHeight = header().getBoundingClientRect().height;
  state.unsafeSoul = true;
  clickPanel("profile");
  await wait(() => region().textContent?.includes("我的工作方式"), "SOUL loaded");
  await wait(() => header().getBoundingClientRect().height > collapsedHeight + 100, "capsule expansion layout settled");
  check(header().getBoundingClientRect().height > collapsedHeight + 100, "the original capsule extends downward");
  check(region().querySelector(".chat-header__avatar"), "expanded profile includes avatar");
  check(region().querySelector('[data-backend-icon="openclaw"]')?.parentElement?.textContent === "OpenClaw",
    "profile shows the owning backend icon and display name");
  check(!region().textContent?.includes(`@${alpha.id}`), "profile omits the Agent ID");
  check(!region().querySelector(`button[aria-label='${i18n.t("common.refresh")}']`), "profile has no manual refresh");
  const fullHeight = header().getBoundingClientRect().height;
  const avatarTrigger = header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!;
  check(avatarTrigger.title === i18n.t("common.close") && avatarTrigger.querySelector("img")?.getAttribute("src")?.includes("svg"), "profile trigger becomes the close icon");
  check(document.querySelector(".chat-thread")?.hasAttribute("inert") && document.querySelector(".chat-botdock")?.hasAttribute("inert"), "covered chat controls cannot receive focus");
  check(!region().querySelector("script") && !state.fixtureUnsafe, "SOUL uses safe Markdown");
  state.unsafeSoul = false;
  header().querySelector<HTMLButtonElement>(".chat-header__avatar-trigger")!.click();
  await wait(() => region().getAttribute("aria-hidden") === "true", "avatar toggles profile closed");
  check(region().hasAttribute("inert"), "closed content is not focusable");
  await settle();
  check(Math.abs(header().getBoundingClientRect().height - collapsedHeight) < 2, "capsule returns to its original height");
  clickPanel("cron");
  await wait(() => region().querySelectorAll("button[data-cron-id]").length === 2, "scoped Cron jobs");
  const cronRows = Array.from(region().querySelectorAll<HTMLButtonElement>("button[data-cron-id]"));
  check(cronRows.every(row => row.getAttribute("aria-haspopup") === "dialog")
    && cronRows.map(row => row.dataset.cronId).join(",") === "capsule-daily,capsule-weekly",
  "chat task rows open dialogs for the exact tasks");
  check(Math.abs(header().getBoundingClientRect().height - fullHeight) < 2, "Cron uses the same full-height surface as the profile");
  check(tools()[1].title === i18n.t("common.close") && tools()[1].querySelector("img"), "Cron trigger becomes close");
  check(!region().textContent?.includes("其他"), "other Agent/backend jobs are excluded");
  check(region().textContent?.includes("下次"), "next scheduled time is shown");
  check(region().querySelector("h2")?.textContent === "定时任务"
    && region().textContent?.includes(i18n.t("cron.enabled")) && region().textContent?.includes(i18n.t("cron.disabled")),
  "scheduled tasks show their title and enabled/disabled state");
  check(!region().textContent?.includes("Fixture previous run failed")
    && !region().querySelector(`button[aria-label='${i18n.t("common.refresh")}']`),
  "scheduled task rows omit run errors and manual refresh");
  const cronRequest = new URL(requests.find(url => url.startsWith("/__api/cron/jobs?"))!, location.origin);
  check(cronRequest.searchParams.get("backend") === alpha.backendId && cronRequest.searchParams.get("agentIds") === alpha.id, "Cron request carries backend and Agent");
  const cronChatHref = location.href;
  const cronDialog = () => document.querySelector<HTMLElement>("[role='dialog']");
  cronRows[0].focus();
  cronRows[0].click();
  await wait(() => cronDialog()?.textContent?.includes("今天整理出了三个创作方向"), "latest Cron result opens in chat");
  check(location.href === cronChatHref && !document.querySelector(".cron-page"), "the task page is not mounted or navigated to");
  check(requests.some(url => {
    const parsed = new URL(url, location.origin);
    return parsed.pathname === "/__api/cron/jobs" && parsed.searchParams.get("action") === "delivery"
      && parsed.searchParams.get("id") === "capsule-daily" && !parsed.searchParams.has("at");
  }), "the current task's latest result is fetched");
  cronDialog()!.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.edit")}']`)!.click();
  await wait(() => document.querySelector(".cron-form-modal")?.textContent?.includes("每天早上的灵感整理"), "edit the same task from its result");
  await wait(() => document.querySelectorAll("[role='dialog']").length === 1, "report finishes closing before editor dismissal");
  document.querySelector(".cron-form-modal")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await wait(() => !cronDialog(), "Cron editor closed");
  check(header().dataset.agentPanel === "cron" && location.href === cronChatHref, "closing the editor preserves the chat task list");
  await wait(() => document.activeElement === cronRows[0], "Cron dialog restores focus to its row");
  const deliveriesBeforeUnrun = requests.filter(url => url.includes("action=delivery")).length;
  cronRows[1].focus();
  cronRows[1].click();
  await wait(() => document.querySelector(".cron-form-modal")?.textContent?.includes("周末阅读回顾"), "a task without runs opens its editor in chat");
  check(requests.filter(url => url.includes("action=delivery")).length === deliveriesBeforeUnrun,
    "an unrun task does not request a result");
  cronDialog()!.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.close")}']`)!.click();
  await wait(() => !cronDialog(), "unrun task editor closed");
  check(location.href === cronChatHref && header().dataset.agentPanel === "cron", "both task dialogs stay in the current chat");
  await wait(() => document.activeElement === cronRows[1], "unrun task restores focus to its row");
  clickPanel("inspiration");
  await wait(() => region().querySelector("[data-inspiration-id='capsule-note-1']"), "Agent notes loaded");
  check(region().querySelector("[data-inspiration-id='capsule-archived']"), "results and ordinary notes are shown together");
  check(!region().querySelector("[role='tablist']") && !region().textContent?.includes(i18n.t("common.refresh")),
    "notes have no filter tabs or manual refresh");
  check(!region().querySelector("a[href^='#/cron']"), "only one view is displayed");
  check(Math.abs(header().getBoundingClientRect().height - fullHeight) < 2, "notes use the same full-height surface");
  check(tools()[2].title === i18n.t("common.close"), "notes trigger becomes close");
  const loadMore = Array.from(region().querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === i18n.t("dashboard.loadMore"))!;
  loadMore.click();
  await wait(() => region().querySelectorAll("[data-inspiration-id]").length === 3, "combined notes pagination");
  check(requests.filter(url => url.startsWith("/__api/inspirations?")).every(url => {
    const params = new URL(url, location.origin).searchParams;
    return params.get("backendId") === alpha.backendId && params.get("agentId") === alpha.id;
  }), "every notes page carries the Agent scope");
  check(!region().querySelector("details, summary, [data-note-content]"), "note rows no longer expand inline");
  const noteDialog = () => document.querySelector<HTMLElement>("[role='dialog'][data-modal-variant='report']");
  const chatHref = location.href;
  for (const note of [...notes, archived]) {
    const row = region().querySelector<HTMLButtonElement>(`button[data-inspiration-id='${note.id}']`)!;
    check(row.getAttribute("aria-haspopup") === "dialog", "note rows announce the dialog");
    row.focus();
    row.click();
    await wait(() => noteDialog()?.textContent?.includes(note.body), `open the exact note ${note.id}`);
    check(requests.some(url => url === `/__api/inspirations/detail?id=${note.id}`), "the dialog reads the selected note");
    if (note.id === notes[1].id) {
      check(noteDialog()?.textContent?.includes("设计参考.pdf"), "note attachments appear in the shared detail dialog");
      await settle();
      const backdrop = document.elementFromPoint(2, 2) as HTMLElement;
      check(backdrop && !noteDialog()!.contains(backdrop), "the backdrop is outside the note dialog");
      backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
      backdrop.click();
    } else {
      const close = noteDialog()!.querySelector<HTMLButtonElement>(`button[aria-label='${i18n.t("common.close")}']`)!;
      if (note.id === notes[0].id) close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else close.click();
    }
    await wait(() => !noteDialog(), "note dialog closed");
    check(header().dataset.agentPanel === "inspiration" && location.href === chatHref,
      "closing the note keeps the current chat and Agent notes panel");
    check(region().querySelectorAll("[data-inspiration-id]").length === 3, "closing a note retains loaded pages");
    await wait(() => document.activeElement === row, "focus returns to the selected note");
  }
  await closePanel();
  check(document.activeElement === tools()[2], "Escape returns focus to the trigger");
  const noteReadsBeforeReopen = requests.length;
  clickPanel("inspiration");
  await wait(() => {
    const reads = requests.slice(noteReadsBeforeReopen).filter(url => url.startsWith("/__api/inspirations?"));
    return reads.some(url => url.includes("filter=all")) && reads.some(url => url.includes("filter=archived"));
  }, "notes revalidate both sets when reopened");
  await closePanel();
  clickPanel("profile");
  await settle();
  tools()[0].click();
  await wait(() => document.querySelector(".chat-artifacts-panel")?.textContent?.includes("往期会话产出.pdf"), "Agent outputs include previous sessions");
  check(region().querySelector("h2")?.textContent === "文件"
    && region().querySelectorAll("[data-chat-file-grid] [data-artifact-thumb]").length === 2
    && !region().querySelector(".chat-artifacts-refresh"), "files use the shared group file grid and have no refresh");
  check(region().getAttribute("aria-hidden") === "false" && !region().querySelector(".chat-md"), "artifacts replace the profile inside the common surface");
  check(Math.abs(header().getBoundingClientRect().height - fullHeight) < 2, "artifacts use the same full-height surface");
  check(tools()[0].title === i18n.t("common.close") && tools()[0].querySelector("img"), "artifacts trigger becomes close");
  check(!requests.some(url => url.startsWith("/__api/sessions/artifacts")), "no session-scoped output request");
  const artifactRequest = new URL(requests.find(url => url.includes(`/agents/${alpha.id}/artifacts`))!, location.origin);
  check(artifactRequest.searchParams.get("backend") === alpha.backendId, "output request carries the current Agent and backend");
  tools()[0].click();
  await wait(() => region().getAttribute("aria-hidden") === "true", "same output icon closes the panel");
  check(!document.querySelector(".chat-botdock")?.hasAttribute("inert"), "closing restores composer focusability");
  clickPanel("artifacts");
  await wait(() => document.querySelector(".chat-artifacts-panel"), "outputs reopened");
  clickPanel("cron");
  await wait(() => !document.querySelector(".chat-artifacts-panel"), "Cron closes artifacts");
  document.querySelector(".chat-thread")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await wait(() => region().getAttribute("aria-hidden") === "true", "outside click closes the capsule");
  await settle();
  state.deferSoul = true;
  clickPanel("profile");
  await wait(() => state.releaseSoul, "delayed SOUL refresh");
  await switchAgent(beta);
  check(region().getAttribute("aria-hidden") === "true", "Agent switch closes the panel immediately");
  clickPanel("profile");
  await wait(() => region().textContent?.includes(i18n.t("chat.agentSoulEmpty")), "missing SOUL state");
  check(region().querySelector('[data-backend-icon="hermes"]')?.parentElement?.textContent === "Hermes",
    "switching Agents shows the new backend identity");
  state.releaseSoul();
  await settle();
  check(!region().textContent?.includes("虾长老"), "old SOUL response cannot populate the new Agent");
  clickPanel("cron");
  await wait(() => region().textContent?.includes(i18n.t("chat.panelCronEmpty")), "empty Cron state");
  state.failCron = true;
  await closePanel();
  clickPanel("cron");
  await wait(() => region().textContent?.includes(i18n.t("chat.panelCronUnavailable")), "Cron uses a generic load notice");
  check(!region().textContent?.includes("Cron fixture unavailable"), "raw load failure is hidden");
  state.failCron = false;
  await closePanel();
  clickPanel("cron");
  await wait(() => region().textContent?.includes(i18n.t("chat.panelCronEmpty")), "Cron reopen recovers");
  clickPanel("inspiration");
  await wait(() => region().textContent?.includes(i18n.t("agents.inspirationEmpty")), "empty notes state");
  await closePanel();
  await switchAgent(alpha);
  state.longSoul = true;
  clickPanel("profile");
  await wait(() => (region().querySelector(".chat-md")?.textContent?.length || 0) > 1000, "long SOUL loaded");
  await settle();
  const scrollArea = region().firstElementChild!.firstElementChild as HTMLElement;
  check(scrollArea.scrollHeight > scrollArea.clientHeight, "long profile scrolls inside the capsule");
  scrollArea.scrollTop = 100;
  check(scrollArea.scrollTop === 100, "profile scrolling is available");
  state.longSoul = false;
  await closePanel();
  const requestsBeforeReopen = requests.length;
  clickPanel("profile");
  await wait(() => {
    const body = region().querySelector(".chat-md")?.textContent;
    return body?.includes("我的工作方式") && body.length < 1000;
  }, "reopening refreshes cached SOUL without user action");
  const reopenRequests = requests.slice(requestsBeforeReopen);
  check(reopenRequests.includes(`/__api/agents/${alpha.id}?backend=${alpha.backendId}`)
    && reopenRequests.includes(`/__api/agents/${alpha.id}/file?backend=${alpha.backendId}&file=SOUL.md`),
  "reopening fetches both profile and SOUL for the current backend and Agent");
  await closePanel();
  state.deferArtifacts = true;
  clickPanel("artifacts");
  await wait(() => state.releaseArtifacts, "delayed Agent output read");
  await switchAgent(beta);
  clickPanel("artifacts");
  await wait(() => region().textContent?.includes(i18n.t("chat.agentArtifactsEmpty")), "new Agent has its own empty outputs");
  state.releaseArtifacts();
  await settle();
  check(!region().textContent?.includes("往期会话产出"), "late outputs never cross Agent boundaries");
  state.failArtifacts = true;
  await closePanel();
  clickPanel("artifacts");
  await wait(() => region().textContent?.includes(i18n.t("chat.agentArtifactsUnavailable")), "failed outputs are unavailable, not empty");
  state.failArtifacts = false;
  await closePanel();
  clickPanel("artifacts");
  await wait(() => region().textContent?.includes(i18n.t("chat.agentArtifactsEmpty")), "file reopen recovers");
  await closePanel();
  tools()[3].click();
  await wait(() => document.querySelector(".agents-page[data-detail-open='true']")?.textContent?.includes(beta.name), "details shortcut selects the exact Agent in the correct backend");
  check(requests.some(url => url.startsWith(`/__api/agents/${beta.id}?`) && url.includes("backend=hermes")), "details read uses the linked backend, not a remembered backend");
  location.hash = "/chat";
  await wait(() => header() && document.querySelector(".chat-thread .chat-bubble"), "return to Chat");
  await switchAgent(alpha);
  check(writes.length === 0, "reviewing these views does not mutate or execute Agent work");
  return { passed: true, checks: "four actions, Agent outputs across sessions, scoped details deep link, on-demand loading, capsule height, avatar/name toggles, safe SOUL, Agent/backend Cron scope, notes pagination/detail, Escape focus, artifacts, outside click, late response isolation, empty states, retry", writes: writes.length };
};
