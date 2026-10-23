#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-optimistic-"));
try {
  const output = path.join(temp, "history.mjs");
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    path.join(root, "app/manage-ui/src/lib/chatOptimisticHistory.ts"),
    "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`,
  ], { stdio: "pipe" });
  const { createOptimisticChatHistory } = await import(pathToFileURL(output));
  const history = createOptimisticChatHistory();
  const key = "agent:main:main", other = "agent:other:main";
  const text = "你再随便创建 3 个";
  const older = [{ role: "user", text, idempotencyKey: "older:user" },
    { role: "assistant", text: "old response", idempotencyKey: "one:user" }];
  const prompts = ["one", "two", "three"].map(localSendId => ({ role: "user", text, localSendId }));
  for (const message of prompts) history.remember(key, message);
  assert.deepEqual(history.merge(key, older), [...older, ...prompts],
    "old identical text and another run's assistant cannot confirm accepted prompts");
  const localSnapshot = [...older, ...prompts];
  assert.equal(history.merge(key, localSnapshot), localSnapshot,
    "reopening a live local snapshot does not append duplicate placeholders");
  assert.deepEqual(history.merge(key, older), localSnapshot,
    "restoring a local snapshot does not falsely confirm unpersisted inputs");
  assert.deepEqual(history.merge(other, older), older, "local prompts belong only to their session");
  const first = [...older, { role: "user", text, idempotencyKey: "one:user" }];
  assert.deepEqual(history.merge(key, first), [...first, ...prompts.slice(1)],
    "one persisted request confirms only that request among repeated prompts");
  history.forget(key, "two");
  assert.deepEqual(history.merge(key, first), [...first, prompts[2]], "explicit rejection forgets only its request");
  const completed = [...first, { role: "user", text, idempotencyKey: "three" }];
  assert.equal(history.merge(key, completed), completed, "exact confirmation removes the local placeholder");
  assert.equal(history.merge(key, []).length, 0, "confirmed prompts cannot reappear on later history loads");
  history.remember(key, prompts[0]);
  history.remember(other, prompts[1]);
  history.forget(key);
  assert.deepEqual(history.merge(key, []), [], "reset/delete clear unresolved local prompts");
  assert.deepEqual(history.merge(other, []), [prompts[1]], "reset does not clear another session's prompt");
  console.log("chat optimistic history unit: PASS");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
