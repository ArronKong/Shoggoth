"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { serviceError } = require("./security");
const { productToolRisk } = require("./product-capability-manifest");
const { SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { transcriptEventId } = require("./transcript-store");
const { isLegacyBorrowedToolContent, sanitizeBorrowedToolContent } = require("./shoggoth-memory/borrowed-memory-provenance.cjs");
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 20_000;
const MAX_HISTORY_TURNS = 4_096;
const fail = () => { throw serviceError("CODEX_HISTORY_INPUT_INVALID", "Codex history 分页超过协议限制"); };

// The native paginated store cannot hydrate a whole long thread into one RPC
// frame. Keep turn metadata separate and consume items in bounded native pages.
async function readCodexHistoryTurns(host, threadId, options) {
  const turns = new Map(), seen = new Set();
  let cursor = null;
  do {
    const page = await host.threadTurnsList({ threadId, cursor, limit: 100, itemsView: "notLoaded", sortDirection: "asc" }, options);
    for (const turn of page.data) {
      if (turns.has(turn.id) || turns.size >= MAX_HISTORY_TURNS) fail();
      turns.set(turn.id, { ...turn, items: [], itemsView: "full" });
    }
    cursor = page.nextCursor;
    if (cursor !== null && (seen.has(cursor) || seen.size >= MAX_HISTORY_TURNS)) fail();
    seen.add(cursor);
  } while (cursor !== null);
  return turns;
}

async function* readCodexHistoryItems(host, threadId, sortDirection = "asc", options) {
  let cursor = null, bytes = 0, count = 0;
  const seen = new Set();
  do {
    const page = await host.threadItemsList({ threadId, cursor, limit: 4, sortDirection }, options);
    for (const entry of page.data) {
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (++count > MAX_HISTORY_ITEMS || bytes > MAX_HISTORY_BYTES) fail();
      yield entry;
    }
    cursor = page.nextCursor;
    if (cursor !== null && (seen.has(cursor) || seen.size >= MAX_HISTORY_ITEMS)) fail();
    seen.add(cursor);
  } while (cursor !== null);
}

async function readCodexPaginatedThread(host, response, options) {
  const turns = await readCodexHistoryTurns(host, response.thread.id, options);
  for await (const entry of readCodexHistoryItems(host, response.thread.id, "asc", options)) {
    const turn = turns.get(entry.turnId);
    if (!turn) fail();
    turn.items.push(entry.item);
  }
  return { ...response, thread: { ...response.thread, turns: [...turns.values()] } };
}

// Scan the complete native item stream to prove an operation's presence or
// absence, but retain only its user markers and the accepted terminal turn.
// Unrelated tool output must not inflate the RuntimeHandle V1 response.
async function readCodexOperationThread(host, response, { operationId, turnId = null }, options) {
  const turns = await readCodexHistoryTurns(host, response.thread.id, options);
  for (const turn of turns.values()) turn.itemsView = turn.id === turnId ? "full" : "notLoaded";
  for await (const entry of readCodexHistoryItems(host, response.thread.id, "asc", options)) {
    const turn = turns.get(entry.turnId);
    if (!turn) fail();
    if (entry.turnId === turnId || (entry.item.type === "userMessage" && entry.item.clientId === operationId)) {
      turn.items.push(entry.item);
      if (turn.id !== turnId) turn.itemsView = "summary";
    }
  }
  return { ...response, thread: { ...response.thread, turns: [...turns.values()],
    historyScope: { operationId, complete: true, turnId } } };
}

function readLegacyTurnToolMetadata(paths, { sessionId, turnId }) {
  if (!paths.runtimeAccountsDir) return [];
  const relative = path.relative(paths.trustedRoot, paths.runtimeAccountsDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
  let db;
  try {
    const file = path.join(fs.realpathSync(paths.trustedRoot), relative, "codex",
      SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID, "home", "thread_history_1.sqlite");
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) return [];
    db = new (require("node:sqlite").DatabaseSync)(file, { readOnly: true });
    return db.prepare(
      "SELECT item_id AS id, item_type AS kind, "
      + "CASE item_type "
      + "WHEN 'mcpToolCall' THEN json_extract(item_json, '$.server') || '/' || json_extract(item_json, '$.tool') "
      + "WHEN 'dynamicToolCall' THEN COALESCE(NULLIF(json_extract(item_json, '$.namespace'), '') || '/', '') || json_extract(item_json, '$.tool') "
      + "WHEN 'commandExecution' THEN 'command' WHEN 'fileChange' THEN 'fileChange' END AS name, "
      + "CASE WHEN json_extract(item_json, '$.result.isError') = 1 OR json_extract(item_json, '$.success') = 0 "
      + "OR json_extract(item_json, '$.exitCode') <> 0 THEN 'failed' ELSE json_extract(item_json, '$.status') END AS status, "
      + "completed_at_ms - started_at_ms AS durationMs "
      + "FROM thread_items WHERE thread_id = ? AND turn_id = ? "
      + "AND item_type IN ('mcpToolCall', 'dynamicToolCall', 'commandExecution', 'fileChange') AND length(item_json) <= 262144 "
      + "ORDER BY rollout_ordinal DESC LIMIT 128",
    ).all(sessionId, turnId);
  } catch {
    // Missing, older or busy history storage cannot block Product history.
    return [];
  } finally { db?.close(); }
}

// Read-only compatibility for the already-selected page. The Product event ID
// commits to the native item ID even when the old redaction discarded it.
// Expose only tool identity and outcome when that exact proof matches.
function createLegacyBorrowedToolProjector(paths) {
  const turns = new Map();
  let proofBytesRemaining = 2 * 1024 * 1024;
  return (event) => {
    const { content, runtimeRef: ref } = event;
    if (!isLegacyBorrowedToolContent(content) || ref?.runtime !== "codex"
      || ref.runtimeAccountId !== SHOGGOTH_INTERNAL_CODEX_RUNTIME_ACCOUNT_ID
      || !event.runId || !ref.sessionId || !ref.turnId || proofBytesRemaining <= 0) return event;
    const result = event.kind === "tool_result";
    if (!result && event.kind !== "tool_call") return event;
    const key = JSON.stringify([ref.sessionId, ref.turnId]);
    if (!turns.has(key)) {
      if (turns.size >= 16) return event;
      turns.set(key, readLegacyTurnToolMetadata(paths, ref));
    }
    const method = result ? "item/completed" : "item/started";
    const transcriptType = result ? "tool.result" : "tool.start";
    const proofBytes = Buffer.byteLength(JSON.stringify(content));
    for (const row of turns.get(key)) {
      if (typeof row.name !== "string" || row.name.length > 256 || typeof row.id !== "string" || row.id.length > 256) continue;
      if ((proofBytesRemaining -= proofBytes) < 0) break;
      const receipt = { method, itemId: row.id, toolCallId: row.id, ...content };
      if (event.id !== transcriptEventId("runtime-event", event.runId, transcriptType, row.id, row.id, receipt)) continue;
      let name = content.tool.name;
      if (name === "memory_read") {
        if (!row.name.startsWith("shoggoth/") || !productToolRisk(row.name.slice("shoggoth/".length))) return event;
        name = row.name;
      }
      const tool = { kind: row.kind, name, ...(result ? { status: row.status, durationMs: row.durationMs } : {}) };
      return { ...event, content: sanitizeBorrowedToolContent({ tool, toolCallId: row.id, transcriptType }, content.borrowedMemoryRefs) };
    }
    return event;
  };
}

module.exports = { readCodexHistoryTurns, readCodexHistoryItems, readCodexPaginatedThread, readCodexOperationThread,
  createLegacyBorrowedToolProjector, MAX_HISTORY_BYTES };
