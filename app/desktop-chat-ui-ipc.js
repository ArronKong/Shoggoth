"use strict";
const crypto = require("node:crypto");
const c = require("./agent-service/chat-ui-contract");
const { normalizeSpec } = require("./core/chat-ui-management");
const { normalizePluginSelection } = require("./agent-service/plugin-chat-selection");
const { createDesktopChatUiAuthority } = require("./desktop-chat-ui-authority");
const EVENTS = "shoggoth:chat-ui:event";
function registerDesktopChatUiIpc({ ipcMain, getMainWindow, getUiOrigin, getRegistry, host, now = Date.now }) {
  const entries = new Map(), handlers = [], pending = new Set(); let closed = false;
  const authority = createDesktopChatUiAuthority({ now }); let watchedRegistry = null;
  const onActivity = event => {
    const activity = event?.activity;
    if (activity?.kind !== "native.ui.revoked") return;
    for (const entry of entries.values()) if (entry.backend === event.backendId && entry.sessionKey === activity.sessionKey
      && event.agentIds?.includes(entry.agentId) && (!activity.artifactId || entry.part.artifactId === activity.artifactId && entry.part.revision === activity.revision)) {
      notify(entry, { type: "revoked", code: activity.reason }); void host.close(entry.mountId);
    }
  };
  const watchRegistry = () => {
    const registry = getRegistry(); if (registry === watchedRegistry) return;
    watchedRegistry?.off?.("backend.sessionActivity", onActivity); watchedRegistry = registry;
    watchedRegistry?.on?.("backend.sessionActivity", onActivity);
  };
  const ownRevision = entry => {
    entry.selfRevisions.add(entry.stateRevision);
    while (entry.selfRevisions.size > 256) entry.selfRevisions.delete(entry.selfRevisions.values().next().value);
  };
  const trusted = event => {
    const window = getMainWindow();
    if (closed || !window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw c.uiError("UI_HOST_REQUIRED");
    const origin = new URL(event.senderFrame.url).origin;
    if (origin !== new URL(getUiOrigin()).origin) throw c.uiError("UI_HOST_REQUIRED"); return window;
  };
  const notify = (entry, payload) => {
    if (!entry.window.isDestroyed()) entry.window.webContents.send(EVENTS, { mountId: entry.mountId, ...payload });
  };
  const resultState = entry => ({ state: structuredClone(entry.state), stateRevision: entry.stateRevision,
    readOnly: entry.readOnly, readOnlyReason: entry.readOnlyReason });
  const publishState = entry => { entry.draftId = crypto.randomUUID();
    const state = { ...entry.state, ...entry.localPatch };
    entry.drafts.set(entry.draftId, { snapshot: structuredClone(state), generation: entry.selectionGeneration });
    while (entry.drafts.size > 64) entry.drafts.delete(entry.drafts.keys().next().value);
    notify(entry, { type: "state", ...resultState(entry), localState: state, draftId: entry.draftId }); };
  const call = (entry, method, spec) => getRegistry()[method](entry.backend, entry.agentId, entry.sessionKey, spec);
  const write = (entry, task) => {
    const next = entry.writeTail.catch(() => {}).then(() => { if (entry.closed) throw c.uiError("UI_SOURCE_EXPIRED"); return task(); });
    entry.writeTail = next; return next;
  };
  const current = (event, raw, keys = ["mountId"]) => {
    const window = trusted(event); c.fields(raw, keys, keys); c.id(raw.mountId);
    const entry = entries.get(raw.mountId);
    if (!entry || entry.window !== window || entry.closed) throw c.uiError("UI_SOURCE_EXPIRED"); return entry;
  };
  const release = async entry => {
    if (entry.closed) return; entry.closed = true; clearInterval(entry.timer); entries.delete(entry.mountId);
    await call(entry, "closeChatUi", { leaseId: entry.leaseId }).catch(() => {});
    notify(entry, { type: "inactive" });
  };
  const apply = (entry, value) => {
    if (value.stateRevision < entry.stateRevision) return;
    entry.state = structuredClone(value.state); entry.stateRevision = value.stateRevision;
    if (value.readOnly !== undefined) { entry.readOnly = value.readOnly; entry.readOnlyReason = value.readOnlyReason; }
  };
  const syncConflict = async entry => {
    const synced = await call(entry, "renewChatUi", { leaseId: entry.leaseId });
    apply(entry, synced); entry.localPatch = {}; entry.selectionGeneration++; entry.drafts.clear();
    entry.selfRevisions = new Set([entry.stateRevision]); publishState(entry);
    host.update(entry.mountId, { type: "state", value: resultState(entry) }); return resultState(entry);
  };
  const bridge = async (entry, value) => {
    if (entry.closed || !entries.has(entry.mountId)) throw c.uiError("UI_SOURCE_EXPIRED");
    const fields = { ready: [], "state.patch": ["patch", "baseStateRevision"], "state.local": ["patch", "baseStateRevision"],
      resize: ["height"], requestAction: ["actionId"], historyPrompt: ["text"], status: ["code"], flushed: ["flushId", "stateRevision", "errorCode"] }[value.type];
    if (!fields) throw c.uiError("UI_REQUEST_INVALID");
    c.fields(value, ["id", "type", ...fields], ["type", ...(value.type === "flushed" ? ["flushId"] : fields)]);
    if (value.id !== undefined) c.positive(value.id);
    if (value.type === "ready") { publishState(entry); return resultState(entry); }
    if (value.type === "state.local") {
      c.positive(value.baseStateRevision, "UI_REQUEST_INVALID", true); c.bounded(c.record(value.patch), c.LIMITS.patch);
      if (!entry.selfRevisions.has(value.baseStateRevision)) throw c.uiError("UI_STATE_CONFLICT", { state: resultState(entry) });
      entry.localPatch = c.jsonValue(value.patch); publishState(entry); return null;
    }
    if (value.type === "state.patch") return write(entry, async () => {
      if (entry.readOnly) throw c.uiError(entry.readOnlyReason || "UI_SOURCE_EXPIRED");
      try {
        if (!entry.selfRevisions.has(value.baseStateRevision)) throw c.uiError("UI_STATE_CONFLICT");
        const saved = await call(entry, "saveChatUiState", { leaseId: entry.leaseId,
          baseStateRevision: entry.stateRevision, patch: value.patch });
        if (!saved.supported) throw c.uiError("UI_HOST_REQUIRED");
        apply(entry, saved);
        ownRevision(entry);
        for (const [key, item] of Object.entries(value.patch)) if (Object.hasOwn(entry.localPatch, key)
          && c.canonical(entry.localPatch[key]) === c.canonical(item)) delete entry.localPatch[key];
        publishState(entry); return resultState(entry);
      } catch (error) {
        if (error.code === "UI_STATE_CONFLICT") {
          error.state = await syncConflict(entry);
        }
        throw error;
      }
    });
    if (value.type === "resize") {
      if (!Number.isFinite(value.height) || value.height < 120 || value.height > 1200) throw c.uiError("UI_REQUEST_INVALID");
      notify(entry, { type: "resize", height: Math.ceil(value.height) }); return null;
    }
    if (value.type === "requestAction") {
      if (!entry.descriptor.actions.some(action => action.actionId === value.actionId)) throw c.uiError("UI_REQUEST_INVALID");
      notify(entry, { type: "action-hint", actionId: value.actionId }); return null;
    }
    if (value.type === "historyPrompt") {
      if (entry.descriptor.legacy !== true) throw c.uiError("UI_ACTION_INVALID");
      c.text(value.text, 4096, 8 * 1024); notify(entry, { type: "legacy-prompt", text: value.text }); return null;
    }
    if (value.type === "status") { c.id(value.code); notify(entry, { type: "status", code: value.code }); return null; }
    // Flushed receipts are lifecycle data only; they cannot submit a Run.
    if (value.type === "flushed") { c.id(value.flushId); return null; }
  };
  const register = (name, handle) => {
    const channel = `shoggoth:chat-ui:${name}`; handlers.push(channel);
    ipcMain.handle(channel, async (event, raw) => {
      try { return { ok: true, result: await handle(event, raw) }; }
      catch (error) { const code = Object.hasOwn(c.MESSAGES, error?.code || "") ? error.code : "UI_STORAGE_FAILED";
        return { ok: false, error: { code, message: c.MESSAGES[code] } }; }
    });
  };
  register("mount", async (event, raw) => {
    const window = trusted(event); watchRegistry();
    c.fields(raw, ["backend", "agentId", "sessionKey", "part", "mountId", "theme", "locale"], ["backend", "agentId", "sessionKey", "part", "mountId", "theme", "locale"]);
    for (const key of ["backend", "agentId", "mountId"]) c.id(raw[key]);
    if (typeof raw.sessionKey !== "string" || raw.sessionKey.length > 4096 || !["light", "dark"].includes(raw.theme)
      || !["zh-CN", "en"].includes(raw.locale)) throw c.uiError("UI_REQUEST_INVALID");
    const part = c.normalizePart(raw.part), old = entries.get(raw.mountId);
    if (old) {
      if (old.window !== window || old.backend !== raw.backend || old.agentId !== raw.agentId || old.sessionKey !== raw.sessionKey
        || c.canonical(old.part) !== c.canonical(part)) throw c.uiError("UI_SCOPE_MISMATCH");
      return { mountId: old.mountId, descriptor: old.descriptor, ...resultState(old), draftId: old.draftId };
    }
    const entry = { ...raw, part, window, closed: false, localPatch: {}, draftId: crypto.randomUUID(),
      drafts: new Map(), selectionGeneration: 0, selfRevisions: new Set(), writeTail: Promise.resolve(), actions: new Map(), activeAction: null };
    const reference = { artifactId: part.artifactId, revision: part.revision, sourceEventId: part.sourceEventId };
    normalizeSpec("openChatUi", { ...reference, mountId: raw.mountId });
    const descriptor = await call(entry, "describeChatUi", reference);
    if (!descriptor.supported || descriptor.enabled !== true) throw c.uiError(descriptor.readOnlyReason || "UI_FEATURE_DISABLED");
    if (c.canonical(descriptor.part) !== c.canonical(part)) throw c.uiError("UI_SCOPE_MISMATCH");
    const opened = await call(entry, "openChatUi", { ...reference, mountId: raw.mountId });
    if (!opened.supported) throw c.uiError("UI_HOST_REQUIRED");
    entry.leaseId = opened.leaseId; entry.descriptor = descriptor; apply(entry, opened);
    entry.state = opened.state; entry.stateRevision = opened.stateRevision;
    ownRevision(entry); publishState(entry);
    entries.set(entry.mountId, entry);
    try {
      const chunks = []; let offset = 0;
      do {
        const value = await call(entry, "readChatUi", { leaseId: entry.leaseId, offset });
        if (!value.supported || value.htmlHash !== descriptor.htmlHash || value.htmlBytes !== descriptor.htmlBytes || value.offset !== offset
          || value.nextOffset <= offset) throw c.uiError("UI_STORAGE_CORRUPT");
        chunks.push(Buffer.from(value.data, "base64")); offset = value.nextOffset;
        if (value.done) break;
      } while (offset < c.LIMITS.html);
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== descriptor.htmlBytes || c.hash(bytes) !== descriptor.htmlHash) throw c.uiError("UI_STORAGE_CORRUPT");
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      await host.mount({ ownerWindow: window, mountId: entry.mountId, html,
        descriptor: { title: part.title, theme: raw.theme, locale: raw.locale },
        onMessage: value => bridge(entry, value), onClose: () => release(entry),
        onNotify: payload => notify(entry, { type: "status", ...payload }) });
      entry.timer = setInterval(() => { if (entry.closed) return;
        const task = write(entry, () => call(entry, "renewChatUi", { leaseId: entry.leaseId })).then(value => {
          if (entry.closed) return;
          const changed = entry.stateRevision !== value.stateRevision || entry.readOnly !== value.readOnly;
          if (changed) { apply(entry, value); entry.localPatch = {}; entry.selectionGeneration++; entry.drafts.clear();
            entry.selfRevisions = new Set([entry.stateRevision]); publishState(entry); host.update(entry.mountId, { type: "state", value: resultState(entry) }); }
          else apply(entry, value);
        }).catch(error => { notify(entry, { type: "status", code: error.code || "UI_SOURCE_EXPIRED" }); void host.close(entry.mountId); });
        pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {});
      }, 10000); entry.timer.unref();
      return { mountId: entry.mountId, descriptor, ...resultState(entry), draftId: entry.draftId };
    } catch (error) { await host.close(entry.mountId); await release(entry); throw error; }
  });
  register("layout", (event, raw) => {
    const entry = current(event, raw, ["mountId", "layout"]);
    c.fields(raw.layout, ["generation", "rect", "clip", "occluded"], ["generation", "rect", "clip", "occluded"]);
    return { applied: host.layout(entry.mountId, raw.layout) };
  });
  register("theme", (event, raw) => {
    const entry = current(event, raw, ["mountId", "theme"]);
    if (!["light", "dark"].includes(raw.theme)) throw c.uiError("UI_REQUEST_INVALID");
    host.update(entry.mountId, { type: "theme", value: raw.theme }); return { applied: true };
  });
  register("release", async (event, raw) => {
    trusted(event); c.fields(raw, ["mountId"], ["mountId"]);
    const entry = entries.get(raw.mountId); if (entry && entry.window !== getMainWindow()) throw c.uiError("UI_SCOPE_MISMATCH");
    if (entry) { await host.close(entry.mountId); await release(entry); } return { closed: true };
  });
  register("operation", async (event, raw) => {
    const entry = current(event, raw, ["mountId", "actionRequestId"]); c.id(raw.actionRequestId);
    if (entry.activeAction !== raw.actionRequestId && !entry.actions.has(raw.actionRequestId)) throw c.uiError("UI_SCOPE_MISMATCH");
    try {
      const result = await call(entry, "getChatUiOperation", { actionRequestId: raw.actionRequestId });
      if (result.supported && result.actionRequestId === raw.actionRequestId && result.status !== "unknown"
        && entry.activeAction === raw.actionRequestId) entry.activeAction = null;
      return result;
    } catch (error) {
      if (error.code === "UI_OPERATION_EXPIRED" && entry.activeAction === raw.actionRequestId) entry.activeAction = null;
      throw error;
    }
  });
  register("action", async (event, raw) => {
    const entry = current(event, raw, ["mountId", "actionId", "actionRequestId", "draftId", "pluginSelection"]);
    for (const key of ["actionId", "actionRequestId", "draftId"]) c.id(raw[key]);
    const pluginSelection = normalizePluginSelection(Array.isArray(raw.pluginSelection) && raw.pluginSelection.length === 0 ? undefined : raw.pluginSelection);
    const fingerprint = c.hash({ actionId: raw.actionId, draftId: raw.draftId, ...(pluginSelection ? { pluginSelection } : {}) });
    const previous = entry.actions.get(raw.actionRequestId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw c.uiError("UI_OPERATION_CONFLICT"); return previous.promise; }
    if (entry.readOnly || !host.entries.get(entry.mountId)?.visible || entry.activeAction) throw c.uiError("UI_HOST_REQUIRED");
    const draft = entry.drafts.get(raw.draftId);
    if (!draft || draft.generation !== entry.selectionGeneration || !entry.descriptor.actions.some(action => action.actionId === raw.actionId)) throw c.uiError("UI_STATE_CONFLICT");
    const locked = structuredClone(draft); entry.activeAction = raw.actionRequestId;
    const promise = write(entry, async () => {
      if (locked.generation !== entry.selectionGeneration) { entry.activeAction = null; throw c.uiError("UI_STATE_CONFLICT"); }
      const spec = { leaseId: entry.leaseId, actionRequestId: raw.actionRequestId, actionId: raw.actionId,
        stateRevision: entry.stateRevision, snapshot: locked.snapshot, ...(pluginSelection ? { pluginSelection } : {}) };
      const hostProof = authority.issue(spec, () => !closed && !entry.closed && entries.get(entry.mountId) === entry
        && getMainWindow() === entry.window && host.entries.get(entry.mountId)?.visible === true);
      try {
        const result = await call(entry, "submitChatUiAction", { ...spec, hostProof });
        if (!result.supported) throw c.uiError("UI_HOST_REQUIRED");
        apply(entry, { state: locked.snapshot, stateRevision: result.stateRevision }); ownRevision(entry);
        for (const [key, item] of Object.entries(locked.snapshot)) if (Object.hasOwn(entry.localPatch, key)
          && c.canonical(entry.localPatch[key]) === c.canonical(item)) delete entry.localPatch[key];
        publishState(entry); host.update(entry.mountId, { type: "commit", value: resultState(entry) });
        if (result.status !== "unknown") entry.activeAction = null;
        return result;
      } catch (error) {
        if (error.code === "UI_STATE_CONFLICT") error.state = await syncConflict(entry);
        if (["CODEX_DESKTOP_BUSY", "UI_STATE_CONFLICT", "UI_HOST_REQUIRED", "UI_SOURCE_EXPIRED", "UI_ACTION_INVALID", "UI_FEATURE_DISABLED"].includes(error.code)) entry.activeAction = null;
        throw error;
      } finally { authority.revoke(hostProof); }
    });
    entry.actions.set(raw.actionRequestId, { fingerprint, promise });
    while (entry.actions.size > 64) entry.actions.delete(entry.actions.keys().next().value);
    return promise;
  });
  return { entries, verifyClick: value => authority.consume(value), async close() { closed = true; watchedRegistry?.off?.("backend.sessionActivity", onActivity); watchedRegistry = null; authority.close(); for (const channel of handlers) ipcMain.removeHandler(channel);
    await host.closeAll(); await Promise.allSettled([...entries.values()].map(release)); await Promise.allSettled([...pending]); } };
}
module.exports = { registerDesktopChatUiIpc, EVENTS };
