#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, "..");
const { buildSync } = createRequire(path.join(root, "app/manage-ui/package.json"))("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-client-"));
try {
  const file = path.join(dir, "pending.cjs");
  buildSync({ entryPoints: [path.join(root, "app/manage-ui/src/lib/chatUiPending.ts")], bundle: true, platform: "node", format: "cjs", outfile: file });
  const { createUiPendingStore, CHAT_UI_PENDING_KEY } = require(file);
  let raw = null, fail = false, writes = 0;
  const storage = () => ({ getItem: () => raw, setItem: (_, text) => { if (fail) throw Error("ENOSPC"); raw = text; writes++; } });
  let store = createUiPendingStore(storage, () => 123);
  const id = { backendId: "native", agentId: "p", sessionKey: "s", artifactId: "a", revision: 1, sourceEventId: "e", actionRequestId: "request-1" };
  assert(store.remember(id)); assert.equal(writes, 1); assert(store.remember(id)); assert.equal(writes, 1);
  assert(!store.remember({ ...id, sessionKey: "other" }));
  assert(store.remember({ ...id, actionRequestId: "request-2", artifactId: "second-card" }));
  store = createUiPendingStore(storage); assert.equal(store.read().length, 2);
  assert(!Object.keys(store.read()[0]).some(key => ["prompt", "patch", "actionId", "pluginSelection"].includes(key)));
  assert(store.accepted("request-1", "operation-1")); assert(!store.accepted("request-1", "other-operation"));
  fail = true; assert(!store.remember({ ...id, actionRequestId: "not-submitted" })); assert.equal(store.read().length, 2); fail = false;
  raw = '{"unexpected":"corrupt"}'; assert(!store.remember(id)); assert(!store.forget("request-1"));
  raw = null; assert(!store.remember({ ...id, prompt: "must never be persisted" }));
  assert.equal(CHAT_UI_PENDING_KEY, "shoggoth.chat.pending-ui-actions.v1");
  console.log("PASS UI pending identities: concurrent cards, crash recovery, conflicts, corruption and storage failure");
  const contentFile = path.join(dir, "content.cjs");
  buildSync({ entryPoints: [path.join(root, "app/manage-ui/src/lib/chatUiContent.ts")], bundle: true, platform: "node", format: "cjs", outfile: contentFile });
  const { groupNativeUiHistory, nativeUiLegacySources } = require(contentFile);
  const { legacyHtmlBlocks } = require("../app/manage-ui/src/lib/chatUiLegacy.mjs");
  const html = "```html\n<!doctype html><p>later source</p>\n```";
  const message = (source, text, extra = {}) => ({ id: `native-${source}`, role: "assistant", timestamp: 1,
    content: [{ type: "text", text }], shoggoth: { runId: "run", sourceEventId: source, ...extra } });
  const card = { ...message("card-source", ""), content: [{ type: "ui_artifact", schemaVersion: 1,
    artifactId: "card", revision: 1, sourceEventId: "card-source", segmentId: "card-segment", title: "Card", summary: "" }] };
  const history = [message("intro", "Earlier reply"), card, message("later-canonical", html)];
  const unchanged = structuredClone(history), grouped = groupNativeUiHistory(history);
  assert.equal(grouped.length, 1); assert.deepEqual(history, unchanged);
  assert.deepEqual(grouped[0].shoggoth.sourceEventIds, ["intro", "card-source", "later-canonical"]);
  assert.equal(grouped[0].content.at(-1).sourceEventId, "later-canonical");
  const normalized = value => ({ role: "assistant", canonicalSourceEventId: value.shoggoth.contextExcluded ? undefined : value.shoggoth.sourceEventId,
    sourceEventIds: value.shoggoth.sourceEventIds, parts: value.content });
  assert.deepEqual(nativeUiLegacySources(normalized(grouped[0])), [
    { sourceEventId: "intro", text: "Earlier reply" }, { sourceEventId: "later-canonical", text: html },
  ]);
  const excluded = groupNativeUiHistory([message("intro", html, { contextExcluded: true }), card,
    message("excluded-later", html, { contextExcluded: true }), message("valid-later", html)])[0];
  assert.deepEqual(nativeUiLegacySources(normalized(excluded)), [{ sourceEventId: "valid-later", text: html }]);
  const unknown = message("invalid source", html); unknown.content[0].sourceEventId = "intro";
  const unknownGroup = groupNativeUiHistory([message("intro", "Known"), card, unknown,
    { ...message("missing", html), shoggoth: { runId: "run" } }, { ...message("tool", html), role: "toolResult" }])[0];
  assert.deepEqual(nativeUiLegacySources(normalized(unknownGroup)), [{ sourceEventId: "intro", text: "Known" }]);
  const split = groupNativeUiHistory([message("open", "```html\n<!doctype html><p>incomplete"), card,
    message("close", "</p>\n```")])[0];
  assert(nativeUiLegacySources(normalized(split)).every(source => legacyHtmlBlocks(source.text).length === 0));
  const sameSource = { role: "assistant", sourceEventIds: ["same"], parts: [
    { type: "text", sourceEventId: "same", text: "```html\n<!doctype html><p>" },
    { type: "text", sourceEventId: "same", text: "</p>\n```" },
    { type: "text", sourceEventId: "unverified", text: html },
  ] };
  assert.equal(legacyHtmlBlocks(nativeUiLegacySources(sameSource)[0].text).length, 1);
  const standalone = { role: "assistant", canonicalSourceEventId: "old-canonical", parts: [{ type: "text", text: html }] };
  assert.deepEqual(nativeUiLegacySources(standalone), [{ sourceEventId: "old-canonical", text: html }]);
  assert.deepEqual(nativeUiLegacySources({ ...standalone, pending: true }), []);
  assert.deepEqual(nativeUiLegacySources({ ...standalone, role: "user" }), []);
  assert.deepEqual(nativeUiLegacySources({ ...standalone, sourceEventIds: [] }), []);
  assert.deepEqual(nativeUiLegacySources({ ...standalone, parts: [{ type: "text", text: html, sourceEventId: "different" }] }), []);
  console.log("PASS canonical legacy sources: later imported text, excluded prefixes, unknown sources, fence boundaries and standalone history");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
