#!/usr/bin/env node

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "app/manage-ui/src/pages/chat-session-advanced/sessionAdvancedModel.ts");
const component = path.join(root, "app/manage-ui/src/pages/chat-session-advanced/SessionAdvancedModal.tsx");
const page = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-advanced-ui-"));
const outFile = path.join(outDir, "session-advanced.cjs");

try {
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    helper, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outFile}`,
  ], { stdio: "pipe" });
  const model = createRequire(import.meta.url)(outFile);
  const methods = {
    "environments.list": true,
    "sessions.describe": true,
    "sessions.branches.list": true,
    "sessions.fork": true,
  };

  assert.equal(model.hasAdvancedSessionDetails(methods), true);
  assert.equal(model.hasAdvancedSessionDetails({ ...methods, "environments.list": false, "sessions.describe": false, "sessions.branches.list": false }), false,
    "fork-only support must not create an empty details modal");

  const grouped = [
    { role: "user", id: "entry-first" },
    { role: "user", id: "entry-clicked" },
    { role: "assistant", id: "entry-assistant" },
  ];
  assert.equal(model.forkEntryIdAt(grouped, 1, methods), "entry-clicked",
    "fork must use the exact clicked message id, never the first message in a visual group");
  assert.equal(model.forkEntryIdAt(grouped, 2, methods), null);
  assert.equal(model.forkEntryIdAt(grouped, undefined, methods), null);
  assert.equal(model.forkEntryIdAt([{ role: "user", id: "entry", local: true }], 0, methods), null);
  assert.equal(model.forkEntryIdAt(grouped, 1, { ...methods, "sessions.fork": false }), null);

  assert.equal(model.shouldApplySessionResult(4, 4, "agent:a:one", "agent:a:one"), true);
  assert.equal(model.shouldApplySessionResult(4, 5, "agent:a:one", "agent:a:one"), false);
  assert.equal(model.shouldApplySessionResult(4, 4, "agent:a:one", "agent:a:two"), false,
    "a late response from the previous session must be ignored");

  const draft = model.forkEditorDraft({
    supported: true,
    methods,
    sessionKey: "agent:a:fork",
    editorText: "continue here",
    editorAttachments: [
      { mimeType: "image/png", data: "aGVsbG8=" },
      { mimeType: "Image/PNG", data: "d29ybGQ=" },
      { mimeType: "text/plain", data: "not canonical base64" },
    ],
  });
  assert.equal(draft.text, "continue here");
  assert.equal(draft.attachments.length, 2);
  assert.equal(draft.attachments[0].dataUrl, "data:image/png;base64,aGVsbG8=");
  assert.equal(draft.attachments[0].kind, "image");
  assert.equal(draft.attachments[0].sizeBytes, 5);
  assert.equal(draft.attachments[1].kind, "image", "MIME matching must be case-insensitive");
  assert.equal(draft.attachmentsOmitted, true);

  const componentSource = fs.readFileSync(component, "utf8");
  assert.match(componentSource, /nextMethods\["environments\.list"\]/);
  assert.match(componentSource, /nextMethods\["sessions\.branches\.list"\]/);
  assert.match(componentSource, /new AbortController\(\)[\s\S]*requestEpochRef\.current === epoch/,
    "advanced detail reads must be abortable and stale-request fenced");
  assert.match(componentSource, /environmentItems[\s\S]*\.slice\(0, 50\)[\s\S]*environmentItems\.map/,
    "the modal must expose a bounded complete environment inventory");
  assert.doesNotMatch(componentSource, /backendId\s*===|backendId\s*!==|openclaw/i,
    "the advanced UI must not branch on a concrete backend id");

  const pageSource = fs.readFileSync(page, "utf8");
  assert.match(pageSource, /<SessionAdvancedModal\s+key=\{`\$\{advancedProbe\.backendId\}:\$\{advancedProbe\.key\}`\}/,
    "switching sessions must remount the details modal instead of flashing old state");
  assert.match(pageSource, /forkEntryIdAt\(menu\.group\.msgs, menu\.msgIndex, activeAdvancedMethods\)/);
  assert.match(pageSource, /forkSessionAtEntry\(backendId, agentId, sourceKey, entryId\)/);
  assert.match(pageSource, /await openSession\(newKey\)[\s\S]*setInput\(draft\.text\)[\s\S]*setComposerAttachments\(draft\.attachments\)/,
    "a successful fork must switch first and only then prefill the composer");
  const forkBody = pageSource.slice(pageSource.indexOf("const forkFromEntry ="), pageSource.indexOf("// export the open conversation"));
  assert.match(forkBody, /clearPendingToast\(\)[\s\S]*await openSession\(newKey\)[\s\S]*clearPendingToast\(\)/,
    "stale fork continuations must not leave a pending toast behind");
  assert.doesNotMatch(forkBody, /sendChatMessage|chat\.send/,
    "fork prefill must never auto-send the returned editor draft");

  console.log("openclaw-session-advanced-ui-unit: PASS");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
