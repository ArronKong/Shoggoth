"use strict";

const CHANNELS = Object.freeze({
  mint: "shoggoth:board-widget:mint",
  ready: "shoggoth:board-widget:ready",
  revoke: "shoggoth:board-widget:revoke",
});

const BACKEND_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const WIDGET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TICKET = /^[A-Za-z0-9_-]{43}$/u;
const NONCE = /^[A-Za-z0-9_-]{32}$/u;
const MAX_ACTIVE_LEASES = 128;

function ownDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value !== undefined;
  });
}

function closedObject(value, required) {
  return ownDataObject(value)
    && Object.keys(value).length === required.length
    && required.every((key) => Object.hasOwn(value, key));
}

function data(value, key) {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function safeText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && value === value.trim() && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function trustedRenderer(event, getMainWindow) {
  let window;
  try { window = getMainWindow(); } catch { return false; }
  if (!window || window.isDestroyed?.() === true || !window.webContents
    || window.webContents.isDestroyed?.() === true) return false;
  return event?.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function parseMint(raw) {
  if (!closedObject(raw, ["backend", "agentId", "sessionKey", "spec"])) return null;
  const backend = data(raw, "backend");
  const agentId = data(raw, "agentId");
  const sessionKey = data(raw, "sessionKey");
  const spec = data(raw, "spec");
  if (!BACKEND_ID.test(backend) || !safeText(agentId, 256) || /[:\\/]/u.test(agentId)
    || !safeText(sessionKey, 4096)
    || !closedObject(spec, ["name", "revision", "instanceId"])) return null;
  const name = data(spec, "name");
  const revision = data(spec, "revision");
  const instanceId = data(spec, "instanceId");
  if (!WIDGET_NAME.test(name) || !Number.isSafeInteger(revision) || revision < 1
    || !safeText(instanceId, 1024)) return null;
  return { backend, agentId, sessionKey, spec: { name, revision, instanceId } };
}

function parseTicket(raw, withNonce) {
  const keys = withNonce ? ["ticketId", "nonce"] : ["ticketId"];
  if (!closedObject(raw, keys)) return null;
  const ticketId = data(raw, "ticketId");
  const nonce = withNonce ? data(raw, "nonce") : undefined;
  if (!TICKET.test(ticketId) || (withNonce && !NONCE.test(nonce))) return null;
  return { ticketId, ...(withNonce ? { nonce } : {}) };
}

function validFetched(value, requested) {
  const identity = value?.widgetIdentity;
  return value?.supported === true && value.ok === true && Buffer.isBuffer(value.html)
    && value.html.length <= 262_144
    && Number.isSafeInteger(value.boardRevision) && value.boardRevision >= 0
    && typeof value.viewGeneration === "string" && /^[a-f0-9]{32}$/u.test(value.viewGeneration)
    && ownDataObject(identity)
    && identity.name === requested.name
    && identity.revision === requested.revision
    && identity.instanceId === requested.instanceId;
}

function registerDesktopBoardWidgetIpc(options = {}) {
  const {
    ipcMain, getMainWindow, getRegistry, getHost, navigationGuard,
  } = options;
  if (!ipcMain || typeof ipcMain.handle !== "function" || typeof ipcMain.removeHandler !== "function"
    || typeof getMainWindow !== "function" || typeof getRegistry !== "function"
    || typeof getHost !== "function" || !navigationGuard
    || typeof navigationGuard.allowTicket !== "function"
    || typeof navigationGuard.revokeTicket !== "function") {
    throw new TypeError("registerDesktopBoardWidgetIpc requires desktop host dependencies");
  }

  const leases = new Map();
  const ownerGenerations = new Map();
  let pendingMints = 0;
  let disposed = false;
  const authorize = (event) => trustedRenderer(event, getMainWindow)
    ? null
    : failure("PRIVILEGED_RENDERER_REQUIRED", "仅桌面应用可加载 Board Widget");

  ipcMain.handle(CHANNELS.mint, async (event, raw) => {
    const denied = authorize(event);
    if (denied) return denied;
    const request = parseMint(raw);
    if (!request) return failure("INVALID_BOARD_WIDGET_REQUEST", "Board Widget 请求参数无效");
    let registry;
    let host;
    try {
      registry = getRegistry();
      host = getHost();
    } catch {
      return failure("BOARD_WIDGET_UNAVAILABLE", "Board Widget 宿主不可用");
    }
    if (!registry || typeof registry.fetchSessionBoardHtmlWidget !== "function"
      || !host || typeof host.issue !== "function") {
      return failure("BOARD_WIDGET_UNAVAILABLE", "Board Widget 宿主不可用");
    }
    for (const [ticketId, lease] of leases) {
      if (lease.expiresAt > Date.now()) continue;
      leases.delete(ticketId);
      navigationGuard.revokeTicket(ticketId);
      try { void Promise.resolve(host.revokeTicket?.(ticketId)).catch(() => {}); } catch {}
    }
    if (leases.size + pendingMints >= MAX_ACTIVE_LEASES) {
      return failure("BOARD_WIDGET_MINT_FAILED", "Board Widget 宿主容量不足");
    }
    // Reserve capacity before the first await so concurrent renderer requests
    // cannot fan out into unbounded board.get and upstream HTML fetches.
    pendingMints += 1;

    let fetched = null;
    const owner = event.sender.id;
    const ownerGeneration = ownerGenerations.get(owner) || 0;
    const scope = `${request.backend}\0${request.agentId}\0${request.sessionKey}`;
    try {
      fetched = await registry.fetchSessionBoardHtmlWidget(
        request.backend, request.agentId, request.sessionKey, request.spec,
      );
      if (!validFetched(fetched, request.spec)) {
        return failure("BOARD_WIDGET_FETCH_FAILED", "无法验证 Board Widget 内容");
      }
      if (disposed || (ownerGenerations.get(owner) || 0) !== ownerGeneration || authorize(event)) {
        return failure("BOARD_WIDGET_UNAVAILABLE", "Board Widget 宿主不可用");
      }
      const issued = await host.issue({
        owner,
        scope,
        html: fetched.html,
        identity: {
          backend: request.backend,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          boardRevision: fetched.boardRevision,
          viewGeneration: fetched.viewGeneration,
          ...fetched.widgetIdentity,
        },
      });
      if (!issued || !TICKET.test(issued.ticket) || !NONCE.test(issued.nonce)
        || typeof issued.url !== "string" || !Number.isFinite(issued.expiresAt)) {
        try { host.revokeTicket?.(issued?.ticket); } catch {}
        return failure("BOARD_WIDGET_MINT_FAILED", "无法创建 Board Widget 票据");
      }
      if (disposed || (ownerGenerations.get(owner) || 0) !== ownerGeneration || authorize(event)) {
        try { await host.revokeTicket?.(issued.ticket); } catch {}
        return failure("BOARD_WIDGET_UNAVAILABLE", "Board Widget 宿主不可用");
      }
      try {
        navigationGuard.allowTicket({
          ticket: issued.ticket,
          url: issued.url,
          ownerId: owner,
          expiresAt: issued.expiresAt,
        });
      } catch {
        try { host.revokeTicket?.(issued.ticket); } catch {}
        return failure("BOARD_WIDGET_MINT_FAILED", "无法创建 Board Widget 票据");
      }
      leases.set(issued.ticket, {
        owner,
        scope,
        nonce: issued.nonce,
        expiresAt: issued.expiresAt,
      });
      return {
        ok: true,
        value: {
          frameUrl: issued.url,
          ticketId: issued.ticket,
          nonce: issued.nonce,
          widgetIdentity: { ...fetched.widgetIdentity },
        },
      };
    } catch {
      return failure("BOARD_WIDGET_MINT_FAILED", "无法创建 Board Widget 票据");
    } finally {
      pendingMints -= 1;
      if (Buffer.isBuffer(fetched?.html)) fetched.html.fill(0);
    }
  });

  ipcMain.handle(CHANNELS.ready, async (event, raw) => {
    const denied = authorize(event);
    if (denied) return denied;
    const request = parseTicket(raw, true);
    if (!request) return failure("INVALID_BOARD_WIDGET_REQUEST", "Board Widget 请求参数无效");
    const lease = leases.get(request.ticketId);
    if (!lease || lease.owner !== event.sender.id || lease.nonce !== request.nonce) {
      return failure("BOARD_WIDGET_READY_FAILED", "Board Widget 票据无效");
    }
    try {
      const ready = await getHost().markReady({
        ticket: request.ticketId,
        nonce: request.nonce,
        owner: lease.owner,
        scope: lease.scope,
      });
      if (ready !== true && ready?.ok !== true) {
        return failure("BOARD_WIDGET_READY_FAILED", "Board Widget 票据无效");
      }
      if (disposed || leases.get(request.ticketId) !== lease || authorize(event)) {
        return failure("BOARD_WIDGET_READY_FAILED", "Board Widget 票据无效");
      }
      lease.nonce = null;
      lease.expiresAt = Number.POSITIVE_INFINITY;
      return { ok: true, value: { ready: true } };
    } catch {
      return failure("BOARD_WIDGET_READY_FAILED", "Board Widget 票据无效");
    }
  });

  ipcMain.handle(CHANNELS.revoke, async (event, raw) => {
    const denied = authorize(event);
    if (denied) return denied;
    const request = parseTicket(raw, false);
    if (!request) return failure("INVALID_BOARD_WIDGET_REQUEST", "Board Widget 请求参数无效");
    const lease = leases.get(request.ticketId);
    if (lease?.owner === event.sender.id) {
      leases.delete(request.ticketId);
      try { await getHost().revokeTicket(request.ticketId); } catch {}
      navigationGuard.revokeTicket(request.ticketId);
    }
    return { ok: true, value: { revoked: true } };
  });

  const revokeOwner = async (owner) => {
    // In-flight reservations deliberately remain counted until their backend
    // calls settle. Releasing them here without a cancellable Gateway RPC would
    // let repeated reloads exceed the hard upstream fan-out bound.
    ownerGenerations.set(owner, (ownerGenerations.get(owner) || 0) + 1);
    for (const [ticket, lease] of leases) {
      if (lease.owner !== owner) continue;
      leases.delete(ticket);
      navigationGuard.revokeTicket(ticket);
    }
    try { await getHost()?.revokeOwner?.(owner); } catch {}
    navigationGuard.revokeOwner?.(owner);
  };

  return Object.freeze({
    revokeOwner,
    async dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler(CHANNELS.mint);
      ipcMain.removeHandler(CHANNELS.ready);
      ipcMain.removeHandler(CHANNELS.revoke);
      leases.clear();
      ownerGenerations.clear();
      try { await getHost()?.revokeAll?.(); } catch {}
      navigationGuard.clear?.();
    },
  });
}

module.exports = {
  CHANNELS,
  registerDesktopBoardWidgetIpc,
};
