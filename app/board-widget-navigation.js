"use strict";

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function frameId(frame) {
  return positiveInteger(frame?.frameTreeNodeId) ? frame.frameTreeNodeId : null;
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return ""; }
}

function createBoardWidgetNavigationGuard(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const pending = new Map();
  const outerFrames = new Map();
  const childFrames = new Map();
  const widgetOrigins = new Set();

  const purgeExpired = () => {
    const current = now();
    for (const [ticket, entry] of pending) {
      if (entry.expiresAt <= current) pending.delete(ticket);
    }
  };

  const boardRootFor = (frame) => {
    const seen = new Set();
    let current = frame;
    while (current) {
      const id = frameId(current);
      if (id === null || seen.has(id)) return null;
      seen.add(id);
      if (outerFrames.has(id)) return id;
      const recordedRoot = childFrames.get(id)?.rootId;
      if (recordedRoot !== undefined && outerFrames.has(recordedRoot)) return recordedRoot;
      current = current.parent;
    }
    return null;
  };

  const prevent = (details, reason) => {
    try { details.preventDefault(); } catch { /* malformed test doubles fail closed below */ }
    return { allowed: false, reason };
  };

  return Object.freeze({
    allowTicket({ ticket, url, ownerId, expiresAt }) {
      if (typeof ticket !== "string" || ticket.length < 32 || typeof url !== "string"
        || !positiveInteger(ownerId) || !Number.isFinite(expiresAt) || expiresAt <= now()) {
        throw new TypeError("invalid board widget navigation allowance");
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
        || parsed.username || parsed.password || parsed.hash || parsed.search) {
        throw new TypeError("invalid board widget navigation URL");
      }
      widgetOrigins.add(parsed.origin);
      pending.set(ticket, { ticket, url: parsed.href, ownerId, expiresAt });
    },

    handle(details, { ownerId, mainFrame } = {}) {
      purgeExpired();
      if (!details || typeof details.url !== "string" || typeof details.preventDefault !== "function"
        || !positiveInteger(ownerId) || !mainFrame) return prevent(details || {}, "invalid");

      const target = details.frame || null;
      const targetId = frameId(target);
      const targetRoot = boardRootFor(target);
      const initiatorRoot = boardRootFor(details.initiator || null);
      const parentRoot = boardRootFor(target?.parent || null);

      if (details.isMainFrame === true) {
        return initiatorRoot !== null ? prevent(details, "board-top-navigation") : { allowed: true, reason: "unmanaged-main" };
      }

      for (const [ticket, entry] of pending) {
        if (entry.ownerId !== ownerId || entry.url !== details.url) continue;
        if (targetId === null || target?.parent !== mainFrame
          || (details.initiator && details.initiator !== mainFrame)) {
          return prevent(details, "invalid-ticket-frame");
        }
        pending.delete(ticket);
        outerFrames.set(targetId, { ticket, ownerId });
        return { allowed: true, reason: "ticket", ticket };
      }

      if (widgetOrigins.has(safeOrigin(details.url))) {
        return prevent(details, "unknown-ticket");
      }

      if (parentRoot !== null && targetId !== null
        && !outerFrames.has(targetId)
        && (details.url === "about:blank" || details.url === "about:srcdoc")) {
        const prior = childFrames.get(targetId);
        const phase = details.url === "about:blank" ? "blank" : "srcdoc";
        if (!prior) {
          childFrames.set(targetId, { rootId: parentRoot, phase });
          return { allowed: true, reason: phase };
        }
        if (prior.rootId === parentRoot && prior.phase === "blank" && phase === "srcdoc") {
          childFrames.set(targetId, { rootId: parentRoot, phase });
          return { allowed: true, reason: phase };
        }
        return prevent(details, "board-child-renavigation");
      }

      if (targetRoot !== null || initiatorRoot !== null) {
        return prevent(details, "board-renavigation");
      }

      if (parentRoot !== null || initiatorRoot !== null) {
        return prevent(details, "board-child-navigation");
      }
      return { allowed: true, reason: "unmanaged-subframe" };
    },

    isBoardFrame(frame) {
      return boardRootFor(frame) !== null;
    },

    revokeTicket(ticket) {
      pending.delete(ticket);
      for (const [id, entry] of outerFrames) {
        if (entry.ticket !== ticket) continue;
        outerFrames.delete(id);
        for (const [childId, child] of childFrames) {
          if (child.rootId === id) childFrames.delete(childId);
        }
      }
    },

    revokeOwner(ownerId) {
      for (const [ticket, entry] of pending) {
        if (entry.ownerId === ownerId) pending.delete(ticket);
      }
      for (const [id, entry] of outerFrames) {
        if (entry.ownerId !== ownerId) continue;
        outerFrames.delete(id);
        for (const [childId, child] of childFrames) {
          if (child.rootId === id) childFrames.delete(childId);
        }
      }
    },

    clear() {
      pending.clear();
      outerFrames.clear();
      childFrames.clear();
      widgetOrigins.clear();
    },
  });
}

function shouldOpenExternalUrl(url) {
  let target;
  try { target = new URL(url); } catch { return false; }
  return (target.protocol === "http:" || target.protocol === "https:")
    && !target.username
    && !target.password
    && target.href.length <= 8192;
}

module.exports = {
  createBoardWidgetNavigationGuard,
  shouldOpenExternalUrl,
};
