#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "app/manage-ui/src/lib/chatWidget.ts");
const component = path.join(root, "app/manage-ui/src/components/ChatWidget.tsx");
const page = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const viteConfig = path.join(root, "app/manage-ui/vite.config.ts");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-widget-"));
const outFile = path.join(outDir, "chat-widget.cjs");

try {
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    helper, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outFile}`,
  ], { stdio: "pipe" });
  const widget = createRequire(import.meta.url)(outFile);
  const plain = (value) => JSON.parse(JSON.stringify(value));

  const raw = {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_123",
      url: "/__openclaw__/canvas/documents/cv_123/index.html",
      title: "Status",
      preferredHeight: 321.2,
      sandbox: "scripts",
      boardWidgetName: "status-board",
    },
    rawText: "[embed ref=\"cv_123\" /]",
  };
  assert.deepEqual(plain(widget.normalizeChatCanvasWidgetPart(raw)), {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "cv_123",
      url: "/__openclaw__/canvas/documents/cv_123/index.html",
      title: "Status",
      preferredHeight: 321.2,
      boardWidgetName: "status-board",
    },
    rawText: "[embed ref=\"cv_123\" /]",
  }, "Canvas normalization must retain only the closed browser DTO");
  const withSecrets = {
    ...raw,
    preview: { ...raw.preview, upstreamToken: "must-not-survive" },
    secret: "must-not-survive",
  };
  assert.equal(widget.normalizeChatCanvasWidgetPart(withSecrets), null,
    "the closed Canvas DTO must reject unknown fields instead of retaining secret-bearing extensions");

  for (const invalid of [
    { ...raw, type: "present_view" },
    { ...raw, preview: { ...raw.preview, surface: "node_panel" } },
    { ...raw, preview: { ...raw.preview, render: "html" } },
    { ...raw, preview: { ...raw.preview, sandbox: "strict" } },
    { ...raw, preview: { ...raw.preview, boardWidgetName: "Invalid/Board" } },
    { ...raw, preview: { ...raw.preview, viewId: "different" } },
    { ...raw, preview: { ...raw.preview, url: "/__openclaw__/canvas/documents/cv_123/../secret" } },
    { ...raw, preview: { ...raw.preview, url: "/__openclaw__/canvas/documents/cv_123/%2Fsecret" } },
    { ...raw, preview: { ...raw.preview, url: "/__openclaw__/canvas/documents/cv_123/index.html?token=x" } },
    { ...raw, preview: { ...raw.preview, url: "https://gateway.invalid/widget" } },
  ]) assert.equal(widget.normalizeChatCanvasWidgetPart(invalid), null);

  assert.deepEqual(widget.normalizeChatCanvasWidgetParts([
    { type: "text", text: "hello" }, raw, { type: "canvas", preview: null },
  ]).map((item) => item?.preview.viewId ?? null), ["cv_123", null],
  "live cumulative content must preserve valid and visibly-invalid Canvas positions");
  assert.equal(widget.normalizeChatCanvasWidgetParts(raw)[0]?.preview.viewId, "cv_123",
    "a single Canvas content object must normalize like an array item");
  assert.equal(
    widget.buildChatWidgetUrl("openclaw", raw.preview.url),
    "/__widget/openclaw/__openclaw__/canvas/documents/cv_123/index.html",
  );
  assert.equal(widget.buildChatWidgetUrl("openclaw/escape", raw.preview.url), null);
  assert.equal(widget.buildChatWidgetUrl("openclaw", "/etc/passwd"), null);
  assert.deepEqual(plain(widget.chatWidgetPinSpec(widget.normalizeChatCanvasWidgetPart(raw))), {
    name: "status-board",
    docId: "cv_123",
  }, "pinning must use only the Gateway-issued widget identity and Canvas document id");
  assert.equal(widget.chatWidgetPinSpec(widget.normalizeChatCanvasWidgetPart({
    ...raw,
    preview: { ...raw.preview, boardWidgetName: undefined },
  })), null, "a Canvas without a stable board widget identity cannot be pinned");

  assert.equal(widget.clampChatWidgetHeight(-1), 48);
  assert.equal(widget.clampChatWidgetHeight(123.1), 124);
  assert.equal(widget.clampChatWidgetHeight(99_999), 8_000);
  assert.equal(widget.clampChatWidgetHeight(Number.NaN), 320);

  const active = {
    documentVisible: true,
    documentFocused: true,
    frameFocused: true,
    userActivated: true,
  };
  assert.equal(widget.normalizeChatWidgetPrompt("  send this  ", active), "send this");
  assert.equal(widget.normalizeChatWidgetPrompt("/status", active), null, "widgets cannot invoke slash commands");
  assert.equal(widget.normalizeChatWidgetPrompt("x".repeat(4_001), active), null);
  assert.equal(widget.normalizeChatWidgetPrompt("ok", { ...active, userActivated: false }), null);
  assert.equal(widget.normalizeChatWidgetPrompt("ok", { ...active, frameFocused: false }), null);
  assert.equal(widget.normalizeChatWidgetPrompt("ok", { ...active, documentFocused: false }), null);
  assert.equal(widget.normalizeChatWidgetPrompt("ok", { ...active, documentVisible: false }), null);

  const timestamps = [];
  for (let index = 0; index < 10; index += 1) {
    assert.equal(widget.consumeChatWidgetPromptRate(timestamps, 10_000 + index), true);
  }
  assert.equal(widget.consumeChatWidgetPromptRate(timestamps, 20_000), false);
  assert.equal(widget.consumeChatWidgetPromptRate(timestamps, 70_001), true,
    "the oldest event must leave the rolling window after 60 seconds");

  const ownedWindow = {};
  assert.equal(widget.isOwnedChatWidgetWindowMessage(ownedWindow, "null", ownedWindow), true);
  assert.equal(widget.isOwnedChatWidgetWindowMessage({}, "null", ownedWindow), false);
  assert.equal(widget.isOwnedChatWidgetWindowMessage(ownedWindow, "http://127.0.0.1", ownedWindow), false);

  const componentSource = fs.readFileSync(component, "utf8");
  assert.match(componentSource, /sandbox="allow-scripts"/);
  assert.doesNotMatch(componentSource, /allow-same-origin/);
  assert.match(componentSource, /referrerPolicy="no-referrer"/);
  assert.match(componentSource, /method:\s*"HEAD"[\s\S]*credentials:\s*"omit"[\s\S]*referrerPolicy:\s*"no-referrer"/);
  assert.match(componentSource, /isOwnedChatWidgetWindowMessage\(event\.source, event\.origin, frame\.contentWindow\)/);
  assert.match(componentSource, /event\.ports\.length !== 1[\s\S]*port\.close\(\)/);
  assert.match(componentSource, /if \(promptPortRef\.current\)[\s\S]*offeredPort\.close\(\)/,
    "a second prompt port from the owning frame must be closed");
  assert.match(componentSource, /document\.visibilityState === "visible"/);
  assert.match(componentSource, /document\.activeElement === activeFrame/);
  assert.match(componentSource, /userActivation\?\.isActive === true/);
  assert.match(componentSource, /openclaw:widget-prompt-host-ready/);
  assert.match(componentSource, /openclaw:widget-theme/);
  assert.match(componentSource, /const pinSpec = chatWidgetPinSpec\(part\)/);
  assert.match(componentSource, /onPinCanvas\(pinSpec\)/);
  assert.match(componentSource, /promptTimestampsRef\.current = \[\][\s\S]*consumeChatWidgetPromptRate\(promptTimestampsRef\.current, Date\.now\(\)\)/,
    "each loaded widget document must own a fresh rolling prompt-rate window");
  assert.match(componentSource, /\}, \[attempt, sessionKey, widgetUrl\]\);/,
    "moving an identical persisted widget into a forked session must restart its document lifecycle");
  assert.match(componentSource, /key=\{`\$\{sessionKey\}:\$\{widgetUrl\}:\$\{attempt\}`\}/,
    "a forked session must remount an identical widget so it can offer a fresh prompt port");
  assert.match(componentSource, /openclaw:widget-prompt-host-ready[\s\S]*setLoadState\("ready"\)/,
    "an iframe load event alone must not mark an HTTP error document as ready");
  const iframeLoadBody = componentSource.slice(componentSource.indexOf("onLoad={() =>"), componentSource.indexOf("onError={() =>"));
  assert.doesNotMatch(iframeLoadBody, /setLoadState\("ready"\)/,
    "HTTP 4xx/5xx iframe documents still fire load and must time out into retry");

  const pageSource = fs.readFileSync(page, "utf8");
  assert.match(pageSource, /cc\?\.type === "canvas"[\s\S]*normalizeChatCanvasWidgetPart\(cc\)/,
    "history and final normalization must preserve Canvas parts");
  assert.match(pageSource, /p\.state === "delta"[\s\S]*canvasPartsFromContent\(p\.message\?\.content \?\? p\.message\)/,
    "live cumulative content must preserve Canvas parts");
  assert.match(pageSource, /finalMsg\.type === "canvas"[\s\S]*\{ role: "assistant", content: finalMsg \}/,
    "a final frame carrying one bare Canvas content block must normalize as assistant content");
  assert.match(pageSource, /activeKeyRef\.current !== ownerSessionKey[\s\S]*sendControllerRef\.current\.widget\(ownerSessionKey/,
    "widget prompts must stay bound to their owning active session and ordinary send readiness gate");
  assert.match(pageSource, /sendControllerRef\.current\.widget\(ownerSessionKey[\s\S]*sendChatMessageRef\.current\?\.\(text, \[\]\)/,
    "validated widget prompts must still pass through the ordinary chat sender");
  assert.match(pageSource, /<ChatWidget[\s\S]*key=\{`\$\{activeKey \?\? ""\}:\$\{k\}`\}[\s\S]*backendId=\{activeBackend\}[\s\S]*sessionKey=\{activeKey \?\? ""\}/,
    "an identical persisted widget must remount synchronously when the owner session changes");
  assert.match(fs.readFileSync(viteConfig, "utf8"), /"\/__widget":\s*"http:\/\/127\.0\.0\.1:18799"/,
    "Vite development must proxy widget documents to the static server");

  console.log("openclaw-chat-widget-unit: PASS");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
