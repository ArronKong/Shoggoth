"use strict";

const { serviceError } = require("./security");
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

module.exports = { readCodexHistoryTurns, readCodexHistoryItems, readCodexPaginatedThread, readCodexOperationThread, MAX_HISTORY_BYTES };
