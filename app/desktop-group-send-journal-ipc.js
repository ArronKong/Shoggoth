"use strict";

const { closed, safeTree, send } = require("./desktop-group-send-journal-store");
const CHANNEL = "shoggoth:group-send-journal", CHANGED = "shoggoth:group-send-journal:changed";
const METHODS = new Set(["read", "recover", "saveComposer", "prepare", "update", "accepted", "importLegacy"]);
const part = value => typeof value === "string" && value.length > 0 && value.length <= 512;
const failure = code => ({ ok: false, error: { code, message: "群发送记录尚未核实，请保留原输入并重新读取。" } });
function trustedRenderer(event, getMainWindow, getUiOrigin, getWindows) {
  try {
    const windows = getWindows ? getWindows() : [getMainWindow()];
    const window = windows.find(window => window && !window.isDestroyed?.() && window.webContents === event?.sender);
    if (!window || window.webContents.isDestroyed?.() || event.senderFrame !== window.webContents.mainFrame) return false;
    const actual = new URL(event.senderFrame.url), expected = new URL(getUiOrigin());
    return expected.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname)
      && actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search
      && actual.username === "" && actual.password === "";
  } catch { return false; }
}
function registerDesktopGroupSendJournalIpc({ ipcMain, getMainWindow, getUiOrigin, getStore, getAuthorityScope, lookupSend, getWindows }) {
  if (!ipcMain?.handle || !ipcMain?.removeHandler || [getMainWindow, getUiOrigin, getStore, getAuthorityScope, lookupSend].some(fn => typeof fn !== "function")) throw new TypeError("group journal IPC dependencies required");
  let disposed = false;
  const authorize = event => !disposed && trustedRenderer(event, getMainWindow, getUiOrigin, getWindows);
  const changed = (event, scope) => {
    const windows = getWindows ? getWindows() : [getMainWindow()];
    for (const window of windows) {
      if (window && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) {
        try { window.webContents.send(CHANGED, scope); } catch { /* observations re-read on focus / reconnect */ }
      }
    }
  };
  ipcMain.handle(CHANNEL, async (event, ...args) => {
    if (!authorize(event)) return failure("GROUP_JOURNAL_CALLER_REQUIRED");
    let method, value, scope;
    try {
      if (args.length !== 1) throw new Error("one DTO required");
      const request = closed(args[0], ["method", "value"]);
      method = request.method;
      if (!METHODS.has(method)) throw new Error("unknown journal operation");
      value = safeTree(request.value);
      if (Buffer.byteLength(JSON.stringify(value)) > 18 * 1024 * 1024) throw new Error("bounded journal input required");
      if (method === "update" || method === "accepted") {
        value.record = send(value.record); scope = { ownerScope: value.record.ownerScope, groupId: value.record.groupId };
        if (method === "update" && value.patch?.phase === "observed") throw new Error("accepted requires authoritative lookup");
      } else if (method !== "importLegacy") {
        if (!part(value.ownerScope) || !part(value.groupId)) throw new Error("scope required"); scope = { ownerScope: value.ownerScope, groupId: value.groupId };
      }
    } catch { return failure("GROUP_JOURNAL_INVALID"); }
    let store;
    try {
      store = await getStore({ readonlyRecovery: method === "recover" });
      if (!authorize(event)) return failure("GROUP_JOURNAL_CALLER_RETIRED");
      if (!store || typeof store[method] !== "function") throw new Error("journal unavailable");
      if (["read", "recover", "saveComposer", "prepare"].includes(method)) {
        const authority = await getAuthorityScope({ groupId: scope.groupId });
        if (!authorize(event)) return failure("GROUP_JOURNAL_CALLER_RETIRED");
        if (!part(authority)) return failure("GROUP_JOURNAL_SCOPE_UNAVAILABLE");
        if (authority !== scope.ownerScope) return failure("GROUP_JOURNAL_OWNER_CHANGED");
      }
      if (method === "accepted") {
        const original = value.record;
        const receipt = await lookupSend({ groupId: original.groupId, clientMessageId: original.clientMessageId,
          payloadDigest: original.payloadDigest, ownerScope: original.ownerScope });
        if (!authorize(event)) return failure("GROUP_JOURNAL_CALLER_RETIRED");
        if (receipt?.status !== "found" || receipt.ownerScope !== original.ownerScope || receipt.groupId !== original.groupId
          || receipt.clientMessageId !== original.clientMessageId || receipt.payloadMatches !== true || receipt.payloadDigest !== original.payloadDigest
          || !receipt.message || receipt.message.groupId !== original.groupId || receipt.message.author?.kind !== "user") return failure("GROUP_SEND_LOOKUP_UNVERIFIED");
        // The Renderer receipt cannot erase a draft. Only this Main-owned read can consume its exact revision.
        value = { record: original, message: { id: receipt.message.id, groupId: receipt.message.groupId, seq: receipt.message.seq }, discussionId: receipt.discussionId };
      }
      const result = await store[method](value);
      if (!authorize(event)) return failure("GROUP_JOURNAL_CALLER_RETIRED");
      if (!["read", "recover"].includes(method) && scope) changed(event, scope);
      if (method === "importLegacy") {
        const scopes = new Map();
        for (const row of [...value.sends, ...value.drafts]) scopes.set(JSON.stringify([row.ownerScope, row.groupId]), { ownerScope: row.ownerScope, groupId: row.groupId });
        for (const importedScope of scopes.values()) changed(event, importedScope);
      }
      return { ok: true, value: result };
    } catch (error) {
      return failure(typeof error?.code === "string" && /^GROUP_[A-Z_]+$/.test(error.code) ? error.code : "GROUP_JOURNAL_UNAVAILABLE");
    }
  });
  return { dispose() { if (disposed) return; disposed = true; ipcMain.removeHandler(CHANNEL); } };
}
module.exports = { CHANNEL, CHANGED, registerDesktopGroupSendJournalIpc, trustedRenderer };
