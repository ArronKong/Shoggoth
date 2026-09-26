#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "app/manage-ui/src/lib/chatRuntime.ts");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-search-anchor-"));
const outfile = path.join(outDir, "chat-runtime.cjs");

try {
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    helper, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outfile}`,
  ], { stdio: "pipe" });
  const { findChatSearchGroupKey, keyedChatGroups } = createRequire(import.meta.url)(outfile);

  const groups = keyedChatGroups([
    {
      msgs: [
        { id: "message-user", role: "user", parts: [{ type: "text", text: "重复关键词" }] },
      ],
    },
    {
      msgs: [
        { id: "message-assistant", role: "assistant", parts: [{ type: "text", text: "部署已经完成，服务运行正常。" }] },
      ],
    },
    {
      msgs: [
        { id: "message-later", role: "assistant", parts: [{ type: "text", text: "另一个完全不同的回复" }] },
      ],
    },
  ]);

  assert.equal(
    findChatSearchGroupKey(groups, {
      query: "ignored",
      snippet: "ignored",
      messageId: "message-later",
    }),
    groups[2].key,
    "OpenClaw messageId must select the exact visual group",
  );

  assert.equal(
    findChatSearchGroupKey(groups, {
      query: "部署",
      snippet: "...部署已经>>>完成<<<，服务运行正常。...",
      role: "assistant",
    }),
    groups[1].key,
    "Hermes FTS markers and edge ellipses must resolve against full message text",
  );

  assert.equal(
    findChatSearchGroupKey(groups, {
      query: "重复关键词",
      snippet: "短",
      role: "assistant",
    }),
    undefined,
    "role must prevent a user hit from landing on an assistant group",
  );

  console.log("chat search anchor unit: PASS");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
