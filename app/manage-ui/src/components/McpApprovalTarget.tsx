import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { McpApprovalConversation } from "../lib/mcpConnectorUi";

interface ApprovalTarget {
  element: HTMLElement;
  conversation: McpApprovalConversation;
  agentName?: string;
}
let current: ApprovalTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;

// A renderer-only portal destination. Backend, Agent and physical session must
// all match; a cached logical key such as :main never grants ownership.
export function useMcpApprovalTarget(): ApprovalTarget | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export default function McpApprovalTarget({ conversation, agentName, enabled }: {
  conversation: McpApprovalConversation; agentName?: string; enabled: boolean;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const { backendId, agentId, sessionId } = conversation;
  useLayoutEffect(() => {
    if (!enabled || !element || !sessionId) return;
    const target = { element, conversation: { backendId, agentId, sessionId }, agentName };
    current = target; emit();
    return () => { if (current === target) { current = null; emit(); } };
  }, [element, enabled, backendId, agentId, sessionId, agentName]);
  return <div ref={setElement} data-testid="chat-mcp-approval-target" style={{ display: "contents" }} />;
}
