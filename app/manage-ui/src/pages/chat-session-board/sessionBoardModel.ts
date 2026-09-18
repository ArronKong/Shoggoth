import type {
  SessionBoardMethodMap,
  SessionBoardResult,
  SessionBoardTab,
  SessionBoardWidget,
} from "../../types";

export type SessionBoardViewMode = "chat" | "split" | "dashboard";

export const EMPTY_SESSION_BOARD_METHODS: SessionBoardMethodMap = {
  "board.get": false,
  "board.update": false,
  "board.widget.put": false,
  "board.widget.grant": false,
};

export function sessionBoardScopeKey(backendId: string, agentId: string, sessionKey: string): string {
  return `${backendId}\0${agentId}\0${sessionKey}`;
}

export function canReadSessionBoard(result: SessionBoardResult | null | undefined): boolean {
  return result?.supported === true
    && result.methods?.["board.get"] === true
    && result.snapshot !== null;
}

export function canPinCanvasToBoard(result: SessionBoardResult | null | undefined): boolean {
  return canReadSessionBoard(result)
    && result?.methods?.["board.widget.put"] === true
    && result.capabilities?.["board-widget-put-canvas-doc"] === true;
}

export function shouldApplySessionBoardResult(
  requestTicket: number,
  currentTicket: number,
  expectedScope: string,
  currentScope: string,
): boolean {
  return requestTicket === currentTicket && expectedScope === currentScope;
}

/** A late read must never replace the newer snapshot returned by a mutation. */
export function shouldAdoptSessionBoardRevision(
  current: SessionBoardResult | null | undefined,
  incoming: SessionBoardResult,
): boolean {
  if (incoming.supported !== true && incoming.reason === "error" && canReadSessionBoard(current)) {
    return false;
  }
  const currentRevision = current?.snapshot?.revision;
  const incomingRevision = incoming.snapshot?.revision;
  return currentRevision === undefined
    || incomingRevision === undefined
    || incomingRevision >= currentRevision;
}

export function shouldRefreshSessionBoardEvent(
  advertisedEvents: readonly string[],
  eventName: string,
  payloadSessionKey: unknown,
  activeSessionKey: string | null,
): boolean {
  return advertisedEvents.includes("board.changed")
    && eventName === "board.changed"
    && typeof payloadSessionKey === "string"
    && activeSessionKey !== null
    && payloadSessionKey === activeSessionKey;
}

/** M7b.2 hosts only static HTML; every other content/grant state stays metadata-only. */
export function sessionBoardContentPresentation(
  widget: SessionBoardWidget,
): "host" | "placeholder" {
  return widget.content.kind === "html"
    && (widget.grantState === "none" || widget.grantState === "granted")
    && typeof widget.instanceId === "string"
    && widget.instanceId.length > 0
    ? "host"
    : "placeholder";
}

export function orderedSessionBoardTabs(tabs: readonly SessionBoardTab[]): SessionBoardTab[] {
  return [...tabs].sort((left, right) => left.position - right.position || left.tabId.localeCompare(right.tabId));
}

export function orderedSessionBoardWidgets(
  widgets: readonly SessionBoardWidget[],
  tabId: string,
): SessionBoardWidget[] {
  return widgets
    .filter((widget) => widget.tabId === tabId)
    .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

export function canRejectSessionBoardGrant(
  result: SessionBoardResult,
  widget: SessionBoardWidget,
): boolean {
  return result.methods["board.widget.grant"] === true
    && widget.grantState === "pending"
    && typeof widget.instanceId === "string"
    && widget.instanceId.length > 0;
}

export function canApproveSessionBoardGrant(
  result: SessionBoardResult,
  widget: SessionBoardWidget,
): boolean {
  return canRejectSessionBoardGrant(result, widget)
    && widget.accessSummary !== undefined
    && Array.isArray(widget.accessSummary.networkOrigins)
    && widget.accessSummary.networkOrigins.every((origin) => typeof origin === "string" && origin.length > 0)
    && Array.isArray(widget.accessSummary.tools)
    && widget.accessSummary.tools.every((tool) => typeof tool === "string" && tool.length > 0);
}

export function sameSessionBoardWidgetIdentity(
  left: SessionBoardWidget | null | undefined,
  right: SessionBoardWidget | null | undefined,
): boolean {
  return !!left && !!right
    && left.name === right.name
    && left.revision === right.revision
    && left.instanceId === right.instanceId;
}

export function safeSessionBoardSpan(value: number): number {
  return Number.isInteger(value) ? Math.min(12, Math.max(1, value)) : 1;
}
