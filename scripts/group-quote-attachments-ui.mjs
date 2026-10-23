#!/usr/bin/env node
// Production Panel, CSS and real IndexedDB; local HTTP media and controlled APIs only.
// GROUP_QUOTE_UI_IMAGE=/path/to/photo.png node scripts/group-quote-attachments-ui.mjs [--serve]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, ".."), require = createRequire(path.join(root, "app/manage-ui/package.json"));
const { build } = require("esbuild");
const imageFile = process.env.GROUP_QUOTE_UI_IMAGE;
assert(imageFile, "Set GROUP_QUOTE_UI_IMAGE to the actual PNG being quoted; image icons are not acceptance evidence");
const temp = fs.mkdtempSync("/private/tmp/shoggoth-group-quote-ui-");
const output = path.resolve(process.env.GROUP_QUOTE_UI_OUTPUT || path.join(root, ".artifacts/group-quote-attachments-20261017"));
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import GroupChatPanel from "./app/manage-ui/src/pages/GroupChatPanel";
import { UiProvider } from "./app/manage-ui/src/components/ui";
import { groupSendJournal } from "./app/manage-ui/src/lib/groupSendJournal";
import i18n from "./app/manage-ui/src/i18n";
import "./app/manage-ui/src/styles.css";
import "./app/manage-ui/src/manage-skin.css";
import "./app/manage-ui/src/pages/ChatPage.css";
const state = window as any, options = new URLSearchParams(location.search);
const language = options.get("language") || "zh-CN", theme = options.get("theme") || "light";
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
window.addEventListener("error", event => state.fixtureError = event.error?.stack || event.message);
window.addEventListener("unhandledrejection", event => state.fixtureError = String(event.reason));
const wait = async (predicate: () => unknown, label: string) => {
  const until = Date.now() + 7000;
  while (!(await predicate())) { if (state.fixtureError) throw Error(state.fixtureError); if (Date.now() > until) throw Error(label); await pause(); }
};
const image = { id: "11111111-1111-4111-8111-111111111111", name: "图片.png", mimeType: "image/png", size: 128 };
const pdf = { id: "22222222-2222-4222-8222-222222222222", name: "说明.pdf", mimeType: "application/pdf", size: 256 };
const images = Array.from({ length: 8 }, (_, index) => ({ ...image, id: image.id.slice(0,-1) + index, name: "图片" + (index+1) + ".png" }));
const message = (seq: number, body: string, member = false, extra = {}) => ({ id: "m" + seq, groupId: "g", seq, body, threadId: "main",
  author: member ? { kind: "member", memberId: "alpha" } : { kind: "user" }, mentions: { memberIds: [], broadcast: false, unresolved: [] }, createdAt: seq, ...extra });
const quote = (seq: number, attachments = [image], member = false, excerpt = "") => ({ seq, messageId: "m" + seq,
  author: member ? { kind: "member", memberId: "alpha" } : { kind: "user" }, excerpt, attachments });
const rows = [message(2, "描述这张图", false, { replyTo: quote(1, [image, pdf]) }),
  message(3, "这是一张引用的图片。", true, { replyTo: quote(1) }),
  message(4, "图片说明", true, { attachments: [image] }),
  message(5, "文字和图片一起引用", false, { replyTo: quote(4, [image], true, "图片说明") }),
  message(6, "", false, { attachments: images }), message(7, "普通文字消息")];
const writes: any[] = [];
const view = (id: string) => ({ ownerScope: "quote-owner", group: { id, name: "图片引用验收 " + id, purpose: "", status: "active", createdAt: 1, updatedAt: 1,
  metadataRevision: 1, rosterRevision: 1, directoryRevision: 1, controlEpoch: 0, lastSeq: id === "g" ? rows.at(-1)!.seq : 0, ownerMemberId: "alpha" },
  currentOwnerId: "alpha", members: ["alpha", "beta"].map((memberId, position) => ({ id: memberId, groupId: id, backendId: "shoggoth", agentId: "quote-" + memberId,
    displayName: memberId === "alpha" ? "Alpha" : "Beta", handle: memberId, state: "active", position, joinedSeq: 0, leftSeq: null })),
  round: null, activeTurns: [], queuedMemberIds: [], pendingInteractions: [], internalSessionKeys: [] });
state.fetch = async (url: unknown, init: RequestInit = {}) => {
  const parsed = new URL(String(url), location.href), id = parsed.searchParams.get("id") || "g";
  const response = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  if (init.method && init.method !== "GET") {
    check(parsed.pathname === "/__api/group-chats/messages", "only explicit synthetic send is allowed");
    const input = JSON.parse(String(init.body)); writes.push(input);
    const source = rows.find(row => row.seq === input.replyTo)!;
    const sent = message(100 + writes.length, input.body, false, { replyTo: quote(source.seq, source.attachments, true, source.body) });
    rows.push(sent); return response({ message: sent, discussionId: null, duplicate: false });
  }
  if (parsed.pathname === "/__api/group-chats/detail") return response(view(id));
  if (parsed.pathname === "/__api/group-chats/messages") {
    const after = Number(parsed.searchParams.get("afterSeq")) || 0;
    return response({ messages: id === "g" ? rows.filter(row => row.seq > after) : [], hasMore: false });
  }
  if (parsed.pathname.endsWith("/lookup")) return response({ status: "not_found" });
  return response({});
};
await i18n.changeLanguage(language); window.document.documentElement.setAttribute("data-theme", theme);
let root = createRoot(window.document.getElementById("root")!), current = "g";
const mount = (id = current) => { current = id; root.render(<HashRouter><UiProvider><GroupChatPanel key={id} groupId={id} onArchived={() => {}} /></UiProvider></HashRouter>); };
const row = (seq: number) => window.document.querySelector<HTMLElement>('[data-group-timeline] [data-seq="' + seq + '"]');
const composer = () => window.document.querySelector<HTMLElement>(".chat-quote-bar");
const textarea = () => window.document.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea");
const ready = () => textarea()?.disabled === false;
const named = (label: string, parent: ParentNode = window.document) => Array.from(parent.querySelectorAll<HTMLButtonElement>("button"))
  .find(button => button.textContent === i18n.t(label) || button.getAttribute("aria-label") === i18n.t(label));
const type = async (value: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
  textarea()!.dispatchEvent(new Event("input", { bubbles: true })); await pause(); };
const selectQuote = async (seq: number) => { const button = named("groupChat.reply.action", row(seq)!); check(button && !button.disabled, "quote action enabled");
  button!.click(); await wait(() => composer(), "composer quote visible"); };
const loaded = (images: HTMLImageElement[]) => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
mount();
state.runFixture = async () => {
  const checks: string[] = [];
  await wait(() => ready() && row(7), "panel ready");
  check(!row(1), "quoted original is outside current history page");
  for (const seq of [2,3,5]) {
    const thumbnails = Array.from(row(seq)!.querySelectorAll<HTMLImageElement>('button[title="' + i18n.t("groupChat.reply.jump") + '"] img'));
    check(thumbnails.length === 1, "sent user/member image quote contains a thumbnail: " + seq);
    await wait(() => loaded(thumbnails), "quote image decoded");
    const bounds = thumbnails[0].getBoundingClientRect(), originalRatio = thumbnails[0].naturalWidth / thumbnails[0].naturalHeight;
    check(bounds.width > 0 && bounds.width <= 72 && bounds.height > 0 && bounds.height <= 48, "compact original image preview");
    check(Math.abs(bounds.width / bounds.height - originalRatio) < 0.03, "thumbnail preserves the original image ratio");
  }
  const sentQuote = row(2)!.querySelector("button")!.getBoundingClientRect(), stack = row(2)!.querySelector(".chat-group__stack")!.getBoundingClientRect();
  check(Math.abs(sentQuote.right - stack.right) <= 1, "user quote aligns with its message");
  checks.push("sent user/member and mixed-text image quotes; source outside page; media decode, size and alignment");
  await selectQuote(4);
  await wait(() => loaded(Array.from(composer()!.querySelectorAll<HTMLImageElement>("img"))), "composer image decoded");
  await type("描述这张图");
  await wait(async () => (await groupSendJournal.read("quote-owner", "g")).draft?.composer.text === "描述这张图", "draft persisted");
  const saved = await groupSendJournal.read("quote-owner", "g");
  check(saved.draft?.composer.replyTo?.attachments?.[0]?.id === image.id, "actual IndexedDB snapshot retains quoted attachment");
  mount("h"); await wait(() => ready() && !row(4) && !composer(), "other group has separate composer");
  mount("g"); await wait(() => ready() && textarea()!.value === "描述这张图" && composer()?.querySelector("img"), "return restores quoted image and draft");
  root.unmount(); root = createRoot(window.document.getElementById("root")!); mount();
  await wait(() => ready() && composer()?.querySelector("img") && textarea()!.value === "描述这张图", "full remount restores quoted image");
  check(writes.length === 0, "restoring a quote makes no server writes");
  checks.push("actual IndexedDB persistence, group switch/remount and zero replay");
  named("groupChat.send")!.click();
  await wait(() => writes.length === 1 && row(101) && !composer(), "synthetic image quote sent");
  check(writes[0].replyTo === 4 && writes[0].body === "描述这张图" && !writes[0].attachments?.length, "quote preserves source seq without resending attachment");
  await wait(() => loaded(Array.from(row(101)!.querySelectorAll<HTMLImageElement>("img"))), "echoed quote thumbnail loaded");
  checks.push("send uses existing quote identity; echoed thumbnail and composer clearing");
  await selectQuote(7); check(!composer()!.querySelector("img") && composer()!.textContent!.includes("普通文字消息"), "plain text quote unchanged");
  named("groupChat.reply.cancel")!.click(); await wait(() => !composer(), "quote cancelled");
  await selectQuote(6);
  await wait(() => loaded(Array.from(composer()!.querySelectorAll<HTMLImageElement>("img"))), "multi-image preview decoded");
  check(composer()!.querySelectorAll("img").length === 8, "all eight quoted images shown");
  check(composer()!.scrollWidth <= composer()!.clientWidth + 1, "multi-image composer has no overflow");
  check(window.document.documentElement.scrollWidth <= innerWidth + 1, "page has no horizontal overflow");
  checks.push("plain text, cancellation, all eight images and narrow layout");
  named("groupChat.reply.cancel")!.click(); await wait(() => !composer(), "multi quote cleared");
  await selectQuote(4); await type("描述这张图"); row(4)!.scrollIntoView({ block: "start" });
  const preview = composer()!.querySelector<HTMLImageElement>("img")!;
  return { passed: true, width: innerWidth, language, theme, checks, sends: writes.length, providerCalls: 0,
    sourceImage: { width: preview.naturalWidth, height: preview.naturalHeight, src: preview.getAttribute("src") } };
};
window.document.getElementById("run-fixture")!.onclick = async () => {
  try { const result = await state.runFixture(); window.document.getElementById("fixture-result")!.textContent = JSON.stringify(result); }
  catch (error) { window.document.getElementById("fixture-result")!.textContent = String(error); }
};
`;
let server, serving = false;
try {
  await build({ stdin: { contents: fixture, loader: "tsx", resolveDir: root }, bundle: true, format: "esm", jsx: "automatic",
    nodePaths: [path.join(root, "app/manage-ui/node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl", ".webp": "dataurl" }, outfile: path.join(temp, "fixture.js"), logLevel: "silent",
    plugins: process.env.GROUP_QUOTE_BASELINE_PANEL ? [{ name: "baseline-panel", setup(builder) {
      builder.onLoad({ filter: /\/GroupChatPanel\.tsx$/ }, ({ path: file }) => ({ contents: fs.readFileSync(process.env.GROUP_QUOTE_BASELINE_PANEL, "utf8"), loader: "tsx", resolveDir: path.dirname(file) }));
    } }] : [] });
  fs.writeFileSync(path.join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>群聊图片引用验收</title><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%;min-height:0}#root{display:flex;flex-direction:column}.fixture-controls{position:fixed;right:8px;top:8px;z-index:2000;background:var(--ui-surface-1);padding:6px;font-size:12px}</style><div id="root" class="chat-shell"></div><details class="fixture-controls"><summary>隔离验证</summary><button id="run-fixture">运行图片引用检查</button><p id="fixture-result"></p></details><script type="module" src="fixture.js"></script>');
  const image = fs.readFileSync(imageFile);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/__api/inspirations/media") { res.setHeader("Content-Type", "image/png"); res.end(image); return; }
    const file = { "/": "index.html", "/fixture.js": "fixture.js", "/fixture.css": "fixture.css" }[url.pathname];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(path.join(temp, file)));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port + "/";
  if (process.argv.includes("--serve")) {
    serving = true; console.log("PREVIEW " + origin);
    const close = () => { server.close(); server.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(); };
    process.on("SIGINT", close); process.on("SIGTERM", close);
  } else {
    fs.mkdirSync(output, { recursive: true });
    const run = async ({ temp, output, origin, baseline }) => {
      const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
      app.setPath("userData", path.join(temp, "profile")); await app.whenReady(); app.on("window-all-closed", () => {});
      let window, passed = false; const results = [];
      try {
        const cases = baseline ? [[1200, "zh-CN", "light"]] : [1200, 390].flatMap(width => ["zh-CN", "en"].flatMap(language => ["light", "dark"].map(theme => [width, language, theme])));
        for (const [width, language, theme] of cases) {
          window = new BrowserWindow({ show: false, width, height: 850, webPreferences: { backgroundThrottling: false, partition: "quotes-" + results.length } });
          await window.loadURL(origin + "?" + new URLSearchParams({ language, theme }));
          const result = await window.webContents.executeJavaScript("window.runFixture()");
          assert(result.passed); results.push(result); console.log(JSON.stringify(result));
          fs.writeFileSync(path.join(output, [width, language, theme].join("-") + ".png"), (await window.webContents.capturePage()).toPNG());
          window.destroy(); window = null;
        }
        fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2)); passed = results.length === cases.length;
      } catch (error) {
        console.error(error.stack || error);
        if (window && !window.isDestroyed()) fs.writeFileSync(path.join(output, "failed.png"), (await window.webContents.capturePage()).toPNG());
      } finally { if (window && !window.isDestroyed()) window.destroy(); app.exit(passed ? 0 : 1); }
    };
    // Keep all dependencies local to the serialized Electron entry.
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, "const assert=require('node:assert/strict');(" + run.toString() + ")(" + JSON.stringify({ temp, output, origin, baseline: Boolean(process.env.GROUP_QUOTE_BASELINE_PANEL) }) + ").catch(error=>{console.error(error);require('electron').app.exit(1)});");
    const child = spawn(require("electron"), [main], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
    let code; try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); } finally { clearTimeout(timeout); }
    assert.equal(code, 0, "group image quote UI acceptance failed");
  }
} finally { if (!serving) { server?.close(); server?.closeAllConnections(); fs.rmSync(temp, { recursive: true, force: true }); } }
