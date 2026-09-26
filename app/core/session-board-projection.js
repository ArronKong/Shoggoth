"use strict";

const SESSION_BOARD_METHOD_NAMES = Object.freeze([
  "board.get",
  "board.update",
  "board.widget.put",
  "board.widget.grant",
]);

const CANVAS_DOCUMENT_CAPABILITY = "board-widget-put-canvas-doc";
const BOARD_MAX_OPS = 100;
const BOARD_MAX_TABS = 256;
const BOARD_MAX_WIDGETS = 512;
const BOARD_MAX_POSITION = Number.MAX_SAFE_INTEGER;
const BOARD_MAX_NETWORK_ORIGINS = 32;
const BOARD_MAX_TOOLS = 64;

const CHAT_DOCKS = new Set(["left", "right", "bottom", "hidden"]);
const PRESENTATIONS = new Set(["card", "full-bleed", "frameless"]);
const HEIGHT_MODES = new Set(["auto", "fixed"]);
const BOARD_SIZES = new Set(["sm", "md", "lg", "xl", "full"]);
const GRANT_STATES = new Set(["none", "pending", "granted", "rejected"]);
const GRANT_DECISIONS = new Set(["granted", "rejected"]);
const CONTENT_KINDS = new Set(["html", "mcp-app", "plugin", "registered"]);
const FAILURE_REASONS = new Set([
  "unsupported",
  "unknown-backend",
  "invalid-request",
  "invalid-response",
  "error",
]);

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasClosedKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value, maxLength, { trim = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  if (/\p{Cc}/u.test(value)) return null;
  if (trim && value !== value.trim()) return null;
  return value;
}

function safeDisplayText(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return normalized || null;
}

function safeSessionKey(value) {
  return safeText(value, 4096, { trim: true });
}

function normalizeSessionBoardSessionKey(value) {
  return safeSessionKey(value);
}

function normalizeSessionBoardAgentId(value) {
  const agentId = safeText(value, 256, { trim: true });
  return agentId && agentId !== "." && agentId !== ".." && !/[:\\/]/.test(agentId)
    ? agentId
    : null;
}

function safeTabId(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : null;
}

function safeWidgetName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
    ? value : null;
}

function safeCanvasDocumentId(value) {
  return typeof value === "string"
    && value.length <= 128
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : null;
}

function safeInteger(value, min, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function sessionBoardMethodMap(methods = {}) {
  return Object.fromEntries(
    SESSION_BOARD_METHOD_NAMES.map((name) => [name, methods[name] === true]),
  );
}

function sessionBoardCapabilityMap(capabilities = {}) {
  return {
    [CANVAS_DOCUMENT_CAPABILITY]: capabilities[CANVAS_DOCUMENT_CAPABILITY] === true,
  };
}

function unsupportedSessionBoardResult(reason = "unsupported", methods, capabilities) {
  return {
    supported: false,
    reason,
    methods: sessionBoardMethodMap(methods),
    capabilities: sessionBoardCapabilityMap(capabilities),
    snapshot: null,
  };
}

function projectTab(value) {
  if (!isRecord(value)) return null;
  const tabId = safeTabId(value.tabId);
  const title = safeDisplayText(value.title, 80);
  const position = safeInteger(value.position, 0, BOARD_MAX_POSITION);
  if (!tabId || !title || position === null || !CHAT_DOCKS.has(value.chatDock)) return null;
  return { tabId, title, position, chatDock: value.chatDock };
}

function projectNetworkOrigin(value) {
  const source = safeText(value, 2048, { trim: true });
  if (!source) return null;
  try {
    const parsed = new URL(source);
    const supportedHostname = /^\[[0-9A-Fa-f:.]+\]$/u.test(parsed.hostname)
      || /^[A-Za-z0-9.-]+$/u.test(parsed.hostname);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !supportedHostname || parsed.hostname.includes("*") || parsed.hostname.endsWith(".")) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function projectToolCapability(value) {
  const tool = safeText(value, 269, { trim: true });
  return tool && !/[\p{Cc}\p{Cf}]/u.test(tool) ? tool : null;
}

function projectAccessList(value, maxItems, projector) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const projected = value.map(projector);
  if (projected.some((item) => item === null)) return null;
  return [...new Set(projected)].sort();
}

function projectDeclaredAccess(value) {
  if (!hasClosedKeys(value, [], ["netOrigins", "tools"])) return null;
  const networkOrigins = value.netOrigins === undefined
    ? [] : projectAccessList(value.netOrigins, BOARD_MAX_NETWORK_ORIGINS, projectNetworkOrigin);
  const tools = value.tools === undefined
    ? [] : projectAccessList(value.tools, BOARD_MAX_TOOLS, projectToolCapability);
  return networkOrigins === null || tools === null ? null : { networkOrigins, tools };
}

function projectExistingAccessSummary(value) {
  if (!hasClosedKeys(value, ["networkOrigins", "tools"])) return null;
  const networkOrigins = projectAccessList(
    value.networkOrigins,
    BOARD_MAX_NETWORK_ORIGINS,
    projectNetworkOrigin,
  );
  const tools = projectAccessList(value.tools, BOARD_MAX_TOOLS, projectToolCapability);
  return networkOrigins === null || tools === null ? null : { networkOrigins, tools };
}

function projectContentKind(value) {
  if (value.contentOwner === "registered") return "registered";
  if (CONTENT_KINDS.has(value.contentKind)) return value.contentKind;
  if (hasClosedKeys(value.content, ["kind", "supported"])
    && value.content.supported === false
    && (CONTENT_KINDS.has(value.content.kind) || value.content.kind === "unknown")) {
    return value.content.kind;
  }
  return "unknown";
}

function projectWidget(value) {
  if (!isRecord(value)) return null;
  const name = safeWidgetName(value.name);
  const tabId = safeTabId(value.tabId);
  const sizeW = safeInteger(value.sizeW, 1, 12);
  const sizeH = safeInteger(value.sizeH, 1, 20);
  const position = safeInteger(value.position, 0, BOARD_MAX_POSITION);
  const revision = safeInteger(value.revision, 1);
  if (!name || !tabId || sizeW === null || sizeH === null || position === null
    || revision === null || !GRANT_STATES.has(value.grantState)) {
    return null;
  }

  const contentKind = projectContentKind(value);
  const title = value.title === undefined ? null : safeDisplayText(value.title, 80);
  const instanceId = value.instanceId === undefined
    ? null
    : safeText(value.instanceId, 1024, { trim: true });
  const accessSummary = value.declared !== undefined
    ? projectDeclaredAccess(value.declared)
    : value.accessSummary !== undefined
      ? projectExistingAccessSummary(value.accessSummary)
      : undefined;
  if (accessSummary === null) return null;
  return {
    name,
    tabId,
    ...(title ? { title } : {}),
    content: { kind: contentKind, supported: false },
    ...(PRESENTATIONS.has(value.presentation) ? { presentation: value.presentation } : {}),
    ...(HEIGHT_MODES.has(value.heightMode) ? { heightMode: value.heightMode } : {}),
    sizeW,
    sizeH,
    position,
    grantState: value.grantState,
    revision,
    ...(instanceId ? { instanceId } : {}),
    ...(accessSummary ? { accessSummary } : {}),
  };
}

function projectSessionBoardSnapshot(value) {
  if (!isRecord(value)) return null;
  const sessionKey = safeSessionKey(value.sessionKey);
  const revision = safeInteger(value.revision, 0);
  if (!sessionKey || revision === null || !Array.isArray(value.tabs) || !Array.isArray(value.widgets)
    || value.tabs.length > BOARD_MAX_TABS || value.widgets.length > BOARD_MAX_WIDGETS) {
    return null;
  }
  const tabs = value.tabs.map(projectTab);
  const widgets = value.widgets.map(projectWidget);
  if (tabs.some((item) => item === null) || widgets.some((item) => item === null)) return null;
  if (new Set(tabs.map((tab) => tab.tabId)).size !== tabs.length
    || new Set(widgets.map((widget) => widget.name)).size !== widgets.length) {
    return null;
  }
  const tabIds = new Set(tabs.map((tab) => tab.tabId));
  if (widgets.some((widget) => !tabIds.has(widget.tabId))) return null;
  return { sessionKey, revision, tabs, widgets };
}

function projectSessionBoardResult(value, methods, capabilities, expectedSessionKey) {
  const source = isRecord(value?.snapshot) ? value.snapshot : value;
  const snapshot = projectSessionBoardSnapshot(source);
  if (!snapshot || (expectedSessionKey !== undefined && snapshot.sessionKey !== expectedSessionKey)) {
    return unsupportedSessionBoardResult("invalid-response", methods, capabilities);
  }
  const resolvedWidgetName = safeWidgetName(value?.resolvedWidgetName);
  if (value?.resolvedWidgetName !== undefined
    && (!resolvedWidgetName || !snapshot.widgets.some((widget) => widget.name === resolvedWidgetName))) {
    return unsupportedSessionBoardResult("invalid-response", methods, capabilities);
  }
  return {
    supported: true,
    methods: sessionBoardMethodMap(methods),
    capabilities: sessionBoardCapabilityMap(capabilities),
    snapshot,
    ...(resolvedWidgetName ? { resolvedWidgetName } : {}),
  };
}

function projectSessionBoardEnvelope(value, expectedSessionKey) {
  if (value?.supported !== true) {
    const reason = FAILURE_REASONS.has(value?.reason) ? value.reason : "unsupported";
    return unsupportedSessionBoardResult(reason, value?.methods, value?.capabilities);
  }
  return projectSessionBoardResult(value, value.methods, value.capabilities, expectedSessionKey);
}

function normalizeTabCreate(value) {
  if (!hasClosedKeys(value, ["kind", "tabId", "title"], ["chatDock"])
    || value.kind !== "tab_create") return null;
  const tabId = safeTabId(value.tabId);
  const title = safeText(value.title, 80);
  if (!tabId || !title || (value.chatDock !== undefined && !CHAT_DOCKS.has(value.chatDock))) return null;
  return { kind: value.kind, tabId, title, ...(value.chatDock ? { chatDock: value.chatDock } : {}) };
}

function normalizeTabUpdate(value) {
  if (!hasClosedKeys(value, ["kind", "tabId"], ["title", "chatDock", "position"])
    || value.kind !== "tab_update") return null;
  const tabId = safeTabId(value.tabId);
  const title = value.title === undefined ? undefined : safeText(value.title, 80);
  const position = value.position === undefined
    ? undefined : safeInteger(value.position, 0, BOARD_MAX_POSITION);
  if (!tabId || (value.title !== undefined && !title)
    || (value.chatDock !== undefined && !CHAT_DOCKS.has(value.chatDock))
    || (value.position !== undefined && position === null)
    || (title === undefined && value.chatDock === undefined && position === undefined)) return null;
  return {
    kind: value.kind,
    tabId,
    ...(title ? { title } : {}),
    ...(value.chatDock ? { chatDock: value.chatDock } : {}),
    ...(position !== undefined ? { position } : {}),
  };
}

function normalizeTabDelete(value) {
  if (!hasClosedKeys(value, ["kind", "tabId"]) || value.kind !== "tab_delete") return null;
  const tabId = safeTabId(value.tabId);
  return tabId ? { kind: value.kind, tabId } : null;
}

function normalizeTabsReorder(value) {
  if (!hasClosedKeys(value, ["kind", "tabIds"]) || value.kind !== "tabs_reorder"
    || !Array.isArray(value.tabIds) || value.tabIds.length > BOARD_MAX_TABS) return null;
  const tabIds = value.tabIds.map(safeTabId);
  if (tabIds.some((item) => !item) || new Set(tabIds).size !== tabIds.length) return null;
  return { kind: value.kind, tabIds };
}

function normalizeWidgetMove(value) {
  if (!hasClosedKeys(value, ["kind", "name"], ["tabId", "position", "after"])
    || value.kind !== "widget_move") return null;
  const name = safeWidgetName(value.name);
  const tabId = value.tabId === undefined ? undefined : safeTabId(value.tabId);
  const position = value.position === undefined
    ? undefined : safeInteger(value.position, 0, BOARD_MAX_POSITION);
  const after = value.after === undefined ? undefined : safeWidgetName(value.after);
  if (!name || (value.tabId !== undefined && !tabId)
    || (value.position !== undefined && position === null)
    || (value.after !== undefined && !after)
    || (position !== undefined && after !== undefined)) return null;
  return {
    kind: value.kind,
    name,
    ...(tabId ? { tabId } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(after ? { after } : {}),
  };
}

function normalizeWidgetResize(value) {
  if (!hasClosedKeys(value, ["kind", "name", "sizeW", "sizeH"], ["heightMode"])
    || value.kind !== "widget_resize") return null;
  const name = safeWidgetName(value.name);
  const sizeW = safeInteger(value.sizeW, 1, 12);
  const sizeH = safeInteger(value.sizeH, 1, 20);
  if (!name || sizeW === null || sizeH === null
    || (value.heightMode !== undefined && !HEIGHT_MODES.has(value.heightMode))) return null;
  return {
    kind: value.kind,
    name,
    sizeW,
    sizeH,
    ...(value.heightMode ? { heightMode: value.heightMode } : {}),
  };
}

function normalizeWidgetRemove(value) {
  if (!hasClosedKeys(value, ["kind", "name"]) || value.kind !== "widget_remove") return null;
  const name = safeWidgetName(value.name);
  return name ? { kind: value.kind, name } : null;
}

const OP_NORMALIZERS = new Map([
  ["tab_create", normalizeTabCreate],
  ["tab_update", normalizeTabUpdate],
  ["tab_delete", normalizeTabDelete],
  ["tabs_reorder", normalizeTabsReorder],
  ["widget_move", normalizeWidgetMove],
  ["widget_resize", normalizeWidgetResize],
  ["widget_remove", normalizeWidgetRemove],
]);

function normalizeSessionBoardOps(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > BOARD_MAX_OPS) return null;
  const result = [];
  for (const op of value) {
    if (!isRecord(op) || typeof op.kind !== "string") return null;
    const normalized = OP_NORMALIZERS.get(op.kind)?.(op);
    if (!normalized) return null;
    result.push(normalized);
  }
  return result;
}

function normalizeSessionBoardCanvasSpec(value) {
  if (!hasClosedKeys(value, ["name", "docId"], ["title", "placement"])) return null;
  const name = safeWidgetName(value.name);
  const docId = safeCanvasDocumentId(value.docId);
  const title = value.title === undefined ? undefined : safeText(value.title, 80);
  if (!name || !docId || (value.title !== undefined && !title)) return null;
  let placement;
  if (value.placement !== undefined) {
    if (!hasClosedKeys(value.placement, [], ["tabId", "size", "after"])) return null;
    const tabId = value.placement.tabId === undefined ? undefined : safeTabId(value.placement.tabId);
    const after = value.placement.after === undefined ? undefined : safeWidgetName(value.placement.after);
    if ((value.placement.tabId !== undefined && !tabId)
      || (value.placement.size !== undefined && !BOARD_SIZES.has(value.placement.size))
      || (value.placement.after !== undefined && !after)
      || Object.keys(value.placement).length === 0) return null;
    placement = {
      ...(tabId ? { tabId } : {}),
      ...(value.placement.size ? { size: value.placement.size } : {}),
      ...(after ? { after } : {}),
    };
  }
  return {
    name,
    docId,
    ...(title ? { title } : {}),
    ...(placement ? { placement } : {}),
  };
}

function normalizeSessionBoardGrantSpec(value) {
  if (!hasClosedKeys(value, ["name", "revision", "instanceId", "decision"])) return null;
  const name = safeWidgetName(value.name);
  const revision = safeInteger(value.revision, 1);
  const instanceId = safeText(value.instanceId, 1024, { trim: true });
  if (!name || revision === null || !instanceId || !GRANT_DECISIONS.has(value.decision)) return null;
  return { name, revision, instanceId, decision: value.decision };
}

module.exports = {
  SESSION_BOARD_METHOD_NAMES,
  CANVAS_DOCUMENT_CAPABILITY,
  BOARD_MAX_OPS,
  sessionBoardMethodMap,
  sessionBoardCapabilityMap,
  unsupportedSessionBoardResult,
  projectSessionBoardSnapshot,
  projectSessionBoardResult,
  projectSessionBoardEnvelope,
  normalizeSessionBoardOps,
  normalizeSessionBoardAgentId,
  normalizeSessionBoardSessionKey,
  normalizeSessionBoardCanvasSpec,
  normalizeSessionBoardGrantSpec,
};
