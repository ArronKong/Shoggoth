import type { InteractiveApprovalChoice, InteractiveRequestV1 } from "../types";

export type OpenClawExecApproval = InteractiveRequestV1 & {
  id: string;
  approvalSource: "openclaw_exec";
  sessionKey: string;
};

type GatewayContract = {
  features: { methods: string[]; events: string[] };
  auth: { scopes: string[] };
};

export function supportsExecApprovals(contract: GatewayContract | null): boolean {
  return !!contract && contract.auth.scopes.includes("operator.approvals")
    && ["exec.approval.list", "exec.approval.resolve"].every(method => contract.features.methods.includes(method))
    && ["exec.approval.requested", "exec.approval.resolved"].every(event => contract.features.events.includes(event));
}

export function isOpenClawExecApproval(value: unknown): value is OpenClawExecApproval {
  return !!value && typeof value === "object" && "approvalSource" in value
    && value.approvalSource === "openclaw_exec";
}

function text(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
}

export function normalizeExecApproval(raw: unknown, now = Date.now()): OpenClawExecApproval | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, any>;
  const request = row.request;
  if (!text(row.id) || !request || !text(request.sessionKey)
    || !Number.isSafeInteger(row.expiresAtMs) || row.expiresAtMs <= now
    || (row.status !== undefined && row.status !== "pending")) return null;
  // A preview or truncated command must never authorize the undisplayed action.
  const command = text(request.command) && new TextEncoder().encode(request.command).length <= 16 * 1024
    ? request.command : null;
  const decisions = Array.isArray(request.allowedDecisions) ? request.allowedDecisions : [];
  const approvalChoices: InteractiveApprovalChoice[] = [];
  if (command && decisions.includes("allow-once")) approvalChoices.push("once");
  if (command && decisions.includes("allow-always")) approvalChoices.push("runtime:0");
  approvalChoices.push("deny");
  return {
    id: `openclaw-exec:${row.id}`, approvalSource: "openclaw_exec", sessionKey: request.sessionKey,
    version: 1, requestId: row.id, runId: text(request.runId) ? request.runId : row.id,
    kind: "runtime_approval", title: "", message: text(request.warningText) ? request.warningText : "",
    fields: [], approvalChoices,
    ...(approvalChoices.includes("runtime:0") ? { approvalOptions: [
      { choice: "runtime:0" as const, label: "Always allow", kind: "allow_always" as const },
    ] } : {}),
    approvalDetails: { kind: "command", toolName: "exec", ...(command ? { command } : {}),
      ...(text(request.cwd) ? { cwd: request.cwd } : {}) },
    expiresAt: row.expiresAtMs,
  };
}

// This is only a transient projection of the Gateway's approvals. In particular,
// it never replays a command, grants session access, or stores approvals in history.
export function createExecApprovalController({ request, changed }: {
  request: (method: string, params: Record<string, unknown>) => Promise<{ payload?: any }>;
  changed: (sessionKey: string, entries: OpenClawExecApproval[]) => void;
}) {
  let contract: GatewayContract | null = null;
  let generation = 0;
  let refreshRevision = 0;
  let entries = new Map<string, OpenClawExecApproval>();
  const refreshes = new Set<Set<string>>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function publish(next: Map<string, OpenClawExecApproval>) {
    const sessions = new Set([...entries.values(), ...next.values()].map(entry => entry.sessionKey));
    entries = next;
    for (const sessionKey of sessions) changed(sessionKey, [...entries.values()].filter(entry => entry.sessionKey === sessionKey));
    clearTimeout(expiryTimer);
    const deadline = Math.min(...[...entries.values()].map(entry => entry.expiresAt!));
    if (Number.isFinite(deadline)) expiryTimer = setTimeout(() => {
      const next = new Map(entries);
      for (const [id, entry] of entries) if (entry.expiresAt! <= Date.now()) {
        next.delete(id);
        for (const touched of refreshes) touched.add(id);
      }
      publish(next);
    }, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)));
  }

  function remove(id: string) {
    for (const touched of refreshes) touched.add(id);
    const next = new Map(entries);
    next.delete(id);
    publish(next);
  }

  return {
    connect(nextContract: GatewayContract | null) {
      generation += 1;
      contract = supportsExecApprovals(nextContract) ? nextContract : null;
      refreshes.clear();
      publish(new Map());
    },
    async refresh() {
      if (!contract) return;
      const startedGeneration = generation;
      const revision = ++refreshRevision;
      const touched = new Set<string>();
      refreshes.add(touched);
      try {
        const response = await request("exec.approval.list", {});
        if (generation !== startedGeneration || revision !== refreshRevision) return;
        const value = response.payload;
        const rows = Array.isArray(value) ? value : value?.approvals ?? value?.items;
        if (!Array.isArray(rows)) return; // unavailable is not an authoritative empty list
        const next = new Map<string, OpenClawExecApproval>();
        for (const row of rows) {
          const entry = normalizeExecApproval(row);
          if (entry && !touched.has(entry.requestId)) next.set(entry.requestId, entry);
        }
        // Requested/resolved/expired events that raced the snapshot win by ID.
        for (const id of touched) if (entries.has(id)) next.set(id, entries.get(id)!);
        publish(next);
      } catch { /* Preserve live cards; the next connection/session refresh retries. */ }
      finally { refreshes.delete(touched); }
    },
    event(name: string, payload: unknown) {
      if (!contract) return;
      if (name === "exec.approval.requested") {
        const entry = normalizeExecApproval(payload);
        if (!entry) return;
        for (const touched of refreshes) touched.add(entry.requestId);
        publish(new Map(entries).set(entry.requestId, entry));
      } else if (name === "exec.approval.resolved" && payload && typeof payload === "object"
        && "id" in payload && text(payload.id)) remove(payload.id);
    },
    async respond(entry: OpenClawExecApproval, choice?: string) {
      if (!contract || entries.get(entry.requestId) !== entry || entry.expiresAt! <= Date.now()
        || !entry.approvalChoices.includes(choice as InteractiveApprovalChoice)) {
        throw new Error("Approval is no longer available. Refresh the session.");
      }
      const startedGeneration = generation;
      const decision = choice === "once" ? "allow-once" : choice === "runtime:0" ? "allow-always" : "deny";
      const response = await request("exec.approval.resolve", { id: entry.requestId, decision });
      if (response.payload?.ok !== true) throw new Error("Approval was not acknowledged. Refresh the session.");
      if (generation === startedGeneration) remove(entry.requestId);
    },
    dispose() {
      generation += 1;
      contract = null;
      refreshes.clear();
      clearTimeout(expiryTimer);
    },
  };
}
