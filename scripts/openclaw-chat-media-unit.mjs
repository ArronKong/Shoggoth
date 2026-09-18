#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import backendModule from "../app/core/hermes-backend.js";

const { HermesBackend } = backendModule;

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "app/manage-ui/src/lib/chatRuntime.ts");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-media-"));
const outFile = path.join(outDir, "chat-runtime.cjs");

try {
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    helper, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outFile}`,
  ], { stdio: "pipe" });
  const runtime = createRequire(import.meta.url)(outFile);

  assert.deepEqual(runtime.buildOpenClawAttachment({
    id: "a1", kind: "audio", name: "voice.m4a", mimeType: "audio/mp4",
    dataUrl: "data:audio/mp4;base64,QUJD", sizeBytes: 3, durationMs: 1200,
  }), {
    type: "audio", mimeType: "audio/mp4", fileName: "voice.m4a", content: "QUJD",
    sizeBytes: 3, durationMs: 1200,
  }, "8.1 envelope must use raw top-level content, not the legacy source wrapper");

  const media = runtime.normalizeOpenClawMediaFacts([
    {
      type: "video", mimeType: "video/mp4", fileName: "/private/tmp/clip.mp4",
      sizeBytes: 4096, durationMs: 2500, width: 1920, height: 1080, uri: "media://opaque-token",
    },
    { mime_type: "audio/mpeg", filename: "note.mp3", duration_ms: 900 },
  ]);
  assert.deepEqual(media, [
    { name: "clip.mp4", kind: "video", mimeType: "video/mp4", sizeBytes: 4096, durationMs: 2500, width: 1920, height: 1080 },
    { name: "note.mp3", kind: "audio", mimeType: "audio/mpeg", durationMs: 900 },
  ]);
  assert.equal(JSON.stringify(media).includes("/private/"), false, "local media paths must never enter renderer facts");
  assert.equal(JSON.stringify(media).includes("media://"), false, "opaque gateway handles must not become browser URLs");

  const hermes = Object.create(HermesBackend.prototype);
  assert.deepEqual(hermes._parseAttachments([
    runtime.buildOpenClawAttachment({
      id: "a2", kind: "audio", name: "voice.m4a", mimeType: "audio/mp4",
      dataUrl: "data:audio/mp4;base64,QUJD",
    }),
  ]), {
    images: [], pdfs: [],
    files: [{ name: "voice.m4a", mimeType: "audio/mp4", data: "QUJD" }],
    bad: 0, total: 1,
  }, "the shared 8.1 envelope must remain deliverable by Hermes without losing name or audio kind");

  const tenMiBBase64 = "A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3));
  const mediaParams = runtime.buildChatSendParams(
    "agent:媒体:main",
    "发送两个文件",
    "00000000-0000-4000-8000-000000000000",
    [1, 2].map((index) => ({
      id: `large-${index}`,
      kind: "file",
      name: `资料-${index}.bin`,
      mimeType: "application/octet-stream",
      dataUrl: `data:application/octet-stream;base64,${tenMiBBase64}`,
      sizeBytes: 10 * 1024 * 1024,
    })),
  );
  const tooLarge = runtime.gatewayRequestPayloadBudget(
    "42", "chat.send", mediaParams, 25 * 1024 * 1024,
  );
  assert.equal(tooLarge.allowed, false, "two individually-valid 10 MiB files must not cross a 25 MiB total payload limit");
  assert.ok(tooLarge.payloadBytes > 25 * 1024 * 1024, "the budget must include base64, JSON envelope, and UTF-8 text bytes");
  assert.deepEqual(
    runtime.gatewayRequestPayloadBudget("42", "chat.send", mediaParams),
    { allowed: true, payloadBytes: 0 },
    "a transport without a negotiated frame limit must skip the expensive full-payload copy",
  );

  const legalParams = runtime.buildChatSendParams(
    "agent:媒体:main",
    "合法组合 ✓",
    "00000000-0000-4000-8000-000000000000",
    [{
      id: "legal",
      kind: "file",
      name: "资料.bin",
      mimeType: "application/octet-stream",
      dataUrl: `data:application/octet-stream;base64,${tenMiBBase64}`,
      sizeBytes: 10 * 1024 * 1024,
    }],
  );
  const legal = runtime.gatewayRequestPayloadBudget("43", "chat.send", legalParams, 25 * 1024 * 1024);
  assert.equal(legal.allowed, true, "a legal attachment combination must pass");
  assert.equal(
    legal.payloadBytes,
    Buffer.byteLength(JSON.stringify({ type: "req", id: "43", method: "chat.send", params: legalParams }), "utf8"),
    "payload accounting must equal the complete UTF-8 JSON request frame",
  );
  assert.equal(
    runtime.gatewayRequestPayloadBudget("43", "chat.send", legalParams, legal.payloadBytes).allowed,
    true,
    "a request exactly at maxPayload must pass",
  );
  assert.equal(
    runtime.gatewayRequestPayloadBudget("43", "chat.send", legalParams, legal.payloadBytes - 1).allowed,
    false,
    "one byte above maxPayload must fail",
  );

  const page = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/ChatPage.tsx"), "utf8");
  assert.match(page, /const params = buildChatSendParams\(key, text, idem, atts\)/);
  assert.doesNotMatch(page, /params\.attachments[\s\S]{0,600}source:\s*\{/);
  assert.match(page, /normalizeOpenClawMediaFacts\(raw\?\.__openclaw\?\.media\)/);
  assert.match(page, /caps\?\.gatewayPolicy[\s\S]{0,120}caps\?\.maxPayloadBytes/);
  assert.match(page, /chatCapsRef\.current\[ag\]\?\.notReady/);
  assert.doesNotMatch(page, /activeBackend\s*===\s*["']openclaw["'][\s\S]{0,240}maxPayload/);
  assert.match(page, /gatewayRequestPayloadBudget/);
  assert.match(page, /chat\.sendPayloadTooLarge/);
  console.log("openclaw-chat-media-unit: PASS");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
