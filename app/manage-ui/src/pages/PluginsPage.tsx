import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { ApiError, getPluginCatalogPage, getPluginMcpStatus, getPluginMcpTools,
  getBundledPlugins, previewBundledPlugin,
  getPluginOperation,
  requestPluginMcpConsent, discoverPluginMcpTools, previewPluginUninstall, uninstallPlugin,
  installSelectedPlugin, listAgents, revokeAllPluginMcpGrants,
  revokePluginMcpGrant,
  selectPluginAccount,
  setPluginInstallationState,
  type PluginCatalogItem, type PluginCatalogPage, type PluginInstallPreview,
  type PluginMcpStatus, type PluginMcpTools, type PluginOperationReceipt,
  type PluginUninstallPreview } from "../api/client";
import type { BundledPluginItem } from "../api/client";
import { PageHead } from "../components/PageHead";
import Modal from "../components/Modal";
import BackendTabs from "../components/BackendTabs";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import styles from "./PluginsPage.module.css";
import { ExternalPluginsPanel } from "./ExternalPluginsPanel";
import { PluginOAuthConnect } from "./PluginOAuthConnect";
import { PluginBearerConnect } from "./PluginBearerConnect";
import { PluginZoomRegistration } from "./PluginZoomRegistration";
import { PluginDropboxRegistration } from "./PluginDropboxRegistration";
import { PluginGraphRegistration, isGraphRegistrationPackage } from "./PluginGraphRegistration";
import { PluginLovableRegistration } from "./PluginLovableRegistration";
import { PluginHiggsfieldRegistration } from "./PluginHiggsfieldRegistration";
import { PluginSlackRegistration } from "./PluginSlackRegistration";
import { PluginGmailRegistration } from "./PluginGmailRegistration";
import { PluginGmailConnect } from "./PluginGmailConnect";
import { PluginDependencyControl } from "./PluginDependencyControl";
import { PluginRollbackControl } from "./PluginRollbackControl";
import { PluginQuickSetup } from "./PluginQuickSetup";
import { PluginConnectionControl } from "./PluginConnectionControl";
import { PluginExternalActivity } from "./PluginExternalActivity";
import { BundledPluginDetailDialog } from "./BundledPluginDetailDialog";
import { graphReadOnlyCopy } from "./graphReadOnlyCopy";

const PENDING_INSTALL_KEY = "shoggoth.plugin.pending-install.v1";
const PENDING_MANAGEMENT_KEY = "shoggoth.plugin.pending-management.v1";
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BUNDLED_GROUPS = [
  { id: "creative", label: "plugins.bundledGroupCreative", categories: ["Creativity"] },
  { id: "development", label: "plugins.bundledGroupDevelopment", categories: ["Developer Tools"] },
  { id: "collaboration", label: "plugins.bundledGroupCollaboration",
    categories: ["Productivity", "Communication", "Business & Operations"] },
  { id: "research", label: "plugins.bundledGroupResearch",
    categories: ["Scientific Research", "Education & Research", "Data & Analytics", "Finance", "Security"] },
  { id: "other", label: "plugins.bundledGroupOther", categories: [] },
] as const;
function bundledGroupId(category: string): string {
  return BUNDLED_GROUPS.find(group => (group.categories as readonly string[]).includes(category))?.id || "other";
}
type PendingManagement = { operationId: string;
  kind: "installation-state" | "skill-binding-set" | "grant-revoke"
    | "grants-revoke-all" | "mcp-connect" | "grant-allow" | "uninstall";
  uninstall?: { installationId: string; expectedRevision: number };
  installation?: { installationId: string; desiredState: "enabled" | "disabled";
    expectedRevision: number } };
function storedInstallOperation(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_INSTALL_KEY);
    return value && OPERATION_ID.test(value) ? value : null;
  } catch { return null; }
}
function saveInstallOperation(value: string | null): void {
  try {
    if (value) sessionStorage.setItem(PENDING_INSTALL_KEY, value);
    else sessionStorage.removeItem(PENDING_INSTALL_KEY);
  } catch { /* The in-memory operation ID still supports receipt lookup. */ }
}
function storedManagementOperation(): PendingManagement | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_MANAGEMENT_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.operationId !== "string" || !OPERATION_ID.test(candidate.operationId)
      || (candidate.kind !== "installation-state" && candidate.kind !== "skill-binding-set"
        && candidate.kind !== "grant-revoke"
        && candidate.kind !== "grants-revoke-all" && candidate.kind !== "mcp-connect"
        && candidate.kind !== "grant-allow" && candidate.kind !== "uninstall")) {
      return null;
    }
    const pending: PendingManagement = { operationId: candidate.operationId,
      kind: candidate.kind };
    if (candidate.kind === "uninstall") {
      const value = candidate.uninstall as Record<string, unknown> | undefined;
      if (!value || typeof value.installationId !== "string" || !OPERATION_ID.test(value.installationId)
        || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) return null;
      pending.uninstall = { installationId: value.installationId, expectedRevision: Number(value.expectedRevision) };
    }
    const input = candidate.installation;
    if (input !== undefined) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const state = input as Record<string, unknown>;
      if (typeof state.installationId !== "string" || !OPERATION_ID.test(state.installationId)
        || (state.desiredState !== "enabled" && state.desiredState !== "disabled")
        || !Number.isSafeInteger(state.expectedRevision) || Number(state.expectedRevision) < 1) {
        return null;
      }
      pending.installation = { installationId: state.installationId,
        desiredState: state.desiredState, expectedRevision: Number(state.expectedRevision) };
    }
    return pending;
  } catch { return null; }
}
function saveManagementOperation(value: PendingManagement | null): void {
  try {
    if (value) sessionStorage.setItem(PENDING_MANAGEMENT_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_MANAGEMENT_KEY);
  } catch { /* Current page still retains its operation ID. */ }
}
function installFailureNotice(receipt: PluginOperationReceipt | null):
  "failed" | "updateRequiresDisable" {
  return receipt?.result && "code" in receipt.result
    && receipt.result.code === "PLUGIN_UPDATE_REQUIRES_DISABLE"
    ? "updateRequiresDisable" : "failed";
}
function installationStatusKey(item: PluginCatalogItem): string {
  if (item.desiredState !== "enabled") return "plugins.disabled";
  if (item.components.some(component => component.state === "ready")) return "plugins.capabilityReady";
  if (item.components.some(component => component.state === "permission_required")) return "plugins.capabilityPermissionRequired";
  if (item.components.some(component => component.state === "connection_required")) return "plugins.capabilityConnectionRequired";
  if (item.components.some(component => component.state === "secret_required")) return "plugins.capabilitySecretRequired";
  return "plugins.adapterPending";
}

async function catalogThroughInstallation(installationId: string | null): Promise<PluginCatalogPage> {
  let page = await getPluginCatalogPage();
  if (!installationId || !page.supported || page.items.some(item => item.installationId === installationId)) {
    return page;
  }
  const items = [...page.items];
  for (let index = 0; index < 100 && page.nextCursor !== null; index += 1) {
    const cursor = page.nextCursor;
    if (!page.catalogRevision) throw new Error("plugin catalog revision missing");
    const next = await getPluginCatalogPage("shoggoth", cursor, 20, page.catalogRevision);
    if (!next.supported || next.catalogRevision !== page.catalogRevision
      || (next.nextCursor !== null && next.nextCursor <= cursor)) {
      throw new Error("plugin catalog changed during pagination");
    }
    items.push(...next.items);
    page = { ...next, items };
    if (items.some(item => item.installationId === installationId)) return page;
    if (index === 99 && page.nextCursor !== null) throw new Error("plugin catalog pagination limit exceeded");
  }
  return page;
}

export default function PluginsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const requestedId = new URLSearchParams(location.search).get("installationId");
  const targetInstallationId = requestedId && INSTALLATION_ID.test(requestedId) ? requestedId : null;
  const focusApprovals = new URLSearchParams(location.search).get("focus") === "approvals";
  const [backend, setBackend] = useBackendState("plugins");
  const [installDialogOpen, setInstallDialogOpen] = useState(() => Boolean(storedInstallOperation()));
  const backends = useBackendCatalog();
  const backendName = backends.find(item => item.id === backend)?.name || backend;
  useEffect(() => {
    if (targetInstallationId || focusApprovals) setBackend("shoggoth");
  }, [targetInstallationId, focusApprovals]);
  return <div className={`page management-page ${styles.page}`}>
    <PageHead title={t("plugins.title")} subtitle={t("plugins.subtitle")} />
    <div className="ui-toolbar">
      <BackendTabs value={backend} onChange={setBackend} />
    </div>
    {/* Keep pending consent, connection and install receipts mounted across tabs. */}
    <div hidden={backend !== "shoggoth"} data-plugin-host="shoggoth">
      <NativePluginsPanel targetInstallationId={targetInstallationId}
        focusApprovals={focusApprovals} active={backend === "shoggoth"}
        installDialogOpen={installDialogOpen} onInstallDialogOpenChange={setInstallDialogOpen} />
    </div>
    {backend !== "shoggoth" && <ExternalPluginsPanel key={backend} backend={backend} backendName={backendName} />}
  </div>;
}

function NativePluginsPanel({ targetInstallationId, focusApprovals, active,
  installDialogOpen, onInstallDialogOpenChange }: {
  targetInstallationId: string | null; focusApprovals: boolean; active: boolean;
  installDialogOpen: boolean; onInstallDialogOpenChange: (open: boolean) => void;
}) {
  const mcpStatusAgentId = useRef("");
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<PluginCatalogPage | null>(null);
  const [bundled, setBundled] = useState<BundledPluginItem[]>([]);
  const [bundledLoading, setBundledLoading] = useState(true);
  const [bundledError, setBundledError] = useState(false);
  const [detailItem, setDetailItem] = useState<BundledPluginItem | null>(null);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  const targetItemRef = useRef<HTMLLIElement | null>(null);
  const [managementTarget, setManagementTarget] = useState(targetInstallationId);
  const [managedPluginId, setManagedPluginId] = useState<string | null>(targetInstallationId);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState<{
    handle: string | null; preview: PluginInstallPreview; bundleId?: string;
  } | null>(null);
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installName, setInstallName] = useState("");
  const [checkingOperation, setCheckingOperation] = useState(false);
  const installStatusRef = useRef<HTMLDivElement>(null);
  const [lastOperationId, setLastOperationId] = useState(storedInstallOperation);
  const [installNotice, setInstallNotice] = useState<"completed" | "failed"
    | "updateRequiresDisable" | "unknown" | null>(
    () => storedInstallOperation() ? "unknown" : null,
  );
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, PluginMcpStatus | null>>({});
  const [expandedMcpBinding, setExpandedMcpBinding] = useState<string | null>(null);
  const [mcpTools, setMcpTools] = useState<PluginMcpTools | null>(null);
  const [mcpToolsLoading, setMcpToolsLoading] = useState(false);
  const [mcpToolsError, setMcpToolsError] = useState(false);
  const [uninstallPreview, setUninstallPreview] = useState<PluginUninstallPreview | null>(null);
  const mcpToolsRequest = useRef(0);
  const [managementPending, setManagementPending] = useState<PendingManagement | null>(
    storedManagementOperation,
  );
  const [managementRetrying, setManagementRetrying] = useState(false);
  const [managementNotice, setManagementNotice] = useState<"completed" | "failed"
    | "deferred" | "closeFailed" | "unknown" | null>(
    () => storedManagementOperation() ? "unknown" : null,
  );
  const catalogUnavailable = error || (catalog !== null && !catalog.supported
    && catalog.reasonCode !== "PLUGIN_UNAVAILABLE"
    && catalog.reasonCode !== "PLUGIN_UNSUPPORTED");

  useEffect(() => {
    setManagementTarget(targetInstallationId);
    if (targetInstallationId) {
      setManagedPluginId(targetInstallationId);
      setDetailItem(null);
      onInstallDialogOpenChange(true);
    }
  }, [targetInstallationId]);
  useEffect(() => {
    if (!focusApprovals || !active) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("plugins-external-approvals")?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusApprovals, active]);

  useEffect(() => {
    if (!active || !installDialogOpen || !managedPluginId || !targetItemRef.current) return;
    const details = targetItemRef.current.querySelector("details");
    if (details) details.open = true;
    targetItemRef.current.scrollIntoView({ block: "center" });
    targetItemRef.current.focus({ preventScroll: true });
  }, [active, installDialogOpen, managedPluginId, managementTarget, catalog?.items]);

  useEffect(() => {
    if (!active || !installDialogOpen) return;
    const frame = requestAnimationFrame(() => {
      if (previewing || installing || installNotice) installStatusRef.current?.focus();
      else if (selection) previewPanelRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, installDialogOpen, previewing, installing, installNotice, selection]);

  useEffect(() => {
    let active = true;
    void getBundledPlugins().then(result => {
      if (active) { setBundled(result.items); setBundledError(false); }
    }).catch(() => { if (active) setBundledError(true); })
      .finally(() => { if (active) setBundledLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setError(false);
    setLoading(true);
    void catalogThroughInstallation(managementTarget).then((page) => {
      if (active) { setCatalog(page); setError(false); }
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [managementTarget]);

  useEffect(() => {
    if (!lastOperationId || installNotice !== "unknown") return;
    let active = true;
    void getPluginOperation(lastOperationId).then(async (receipt) => {
      if (!active) return;
      if (receipt.operation?.phase === "completed") {
        await finishInstall("completed");
      } else if (receipt.operation?.phase === "failed") {
        await finishInstall(installFailureNotice(receipt.operation));
      }
    }).catch(() => { /* Keep the receipt action available. */ });
    return () => { active = false; };
  }, [lastOperationId, installNotice]);

  useEffect(() => {
    if (!catalog?.supported) return;
    let active = true;
    void listAgents("shoggoth").then((rows) => {
      if (!active) return;
      const available = rows.filter(agent => !agent.archived
        && (!agent.lifecycleState || agent.lifecycleState === "active"));
      setSelectedAgentId((current) => available.some((agent) => agent.id === current)
        ? current : available[0]?.id || "");
    }).catch(() => { if (active) setSelectedAgentId(""); });
    return () => { active = false; };
  }, [catalog?.supported]);

  useEffect(() => {
    const installations = catalog?.supported && selectedAgentId
      ? catalog.items.filter((item) => item.components.some((component) =>
        component.kind === "mcp-server")) : [];
    let active = true;
    // Preserve mounted connection controls during a same-Agent refresh so an
    // in-flight cleanup receipt and its retry operation are not discarded.
    const sameAgent = mcpStatusAgentId.current === selectedAgentId;
    mcpStatusAgentId.current = selectedAgentId;
    setMcpStatuses(current => sameAgent
      ? Object.fromEntries(Object.entries(current).filter(([installationId]) => installations.some(item => item.installationId === installationId)))
      : {});
    if (installations.length > 0) {
      void Promise.all(installations.map(async (item) => {
        try {
          return [item.installationId, await getPluginMcpStatus(selectedAgentId,
            item.installationId)] as const;
        } catch { return [item.installationId, null] as const; }
      })).then((entries) => {
        if (active) setMcpStatuses(Object.fromEntries(entries));
      });
    }
    return () => { active = false; };
  }, [selectedAgentId, catalog?.items, catalog?.supported]);

  useEffect(() => {
    mcpToolsRequest.current += 1;
    setExpandedMcpBinding(null);
    setMcpTools(null);
    setMcpToolsLoading(false);
    setMcpToolsError(false);
  }, [selectedAgentId, catalog?.catalogRevision]);

  const toggleMcpTools = async (bindingId: string) => {
    if (!selectedAgentId || mcpToolsLoading) return;
    if (expandedMcpBinding === bindingId) {
      setExpandedMcpBinding(null);
      setMcpTools(null);
      return;
    }
    setExpandedMcpBinding(bindingId);
    setMcpTools(null);
    setMcpToolsError(false);
    setMcpToolsLoading(true);
    const request = ++mcpToolsRequest.current;
    try {
      let result = await getPluginMcpTools(selectedAgentId, bindingId);
      if (!result.available) {
        await discoverPluginMcpTools(selectedAgentId, bindingId);
        result = await getPluginMcpTools(selectedAgentId, bindingId);
      }
      if (request === mcpToolsRequest.current) setMcpTools(result);
    } catch {
      if (request === mcpToolsRequest.current) setMcpToolsError(true);
    } finally {
      if (request === mcpToolsRequest.current) setMcpToolsLoading(false);
    }
  };

  const loadMore = async () => {
    if (!catalog?.supported || catalog.nextCursor === null
      || catalog.catalogRevision === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getPluginCatalogPage("shoggoth", catalog.nextCursor, 20,
        catalog.catalogRevision);
      if (!page.supported || page.catalogRevision !== catalog.catalogRevision) {
        setError(true);
        return;
      }
      setCatalog({ ...page, items: [...catalog.items, ...page.items] });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const refreshCatalog = async () => {
    const [page, bundledPage] = await Promise.allSettled([
      catalogThroughInstallation(managementTarget), getBundledPlugins(),
    ]);
    if (bundledPage.status === "fulfilled") {
      setBundled(bundledPage.value.items);
      setBundledError(false);
    } else setBundledError(true);
    if (page.status === "rejected") throw page.reason;
    setCatalog(page.value);
    setError(false);
  };

  const finishManagement = async (phase: "completed" | "failed"
    | "deferred" | "closeFailed") => {
    saveManagementOperation(null);
    setManagementPending(null);
    setManagementNotice(phase);
    mcpToolsRequest.current += 1;
    setExpandedMcpBinding(null);
    setMcpTools(null);
    setMcpToolsLoading(false);
    setMcpToolsError(false);
    try { await refreshCatalog(); }
    catch { setError(true); }
  };

  const checkManagementOperation = async (pending = managementPending) => {
    if (!pending) return;
    try {
      const receipt = await getPluginOperation(pending.operationId);
      if (receipt.operation?.kind !== pending.kind) {
        setManagementNotice("unknown");
      } else if (receipt.operation.phase === "completed") {
        await finishManagement("completed");
      } else if (receipt.operation.phase === "failed") {
        await finishManagement("failed");
      } else if (["created", "committed"].includes(receipt.operation.phase) && (pending.installation || pending.uninstall)) {
        setManagementNotice("deferred");
      } else setManagementNotice("unknown");
    } catch { setManagementNotice("unknown"); }
  };

  useEffect(() => {
    const pending = storedManagementOperation();
    if (pending) void checkManagementOperation(pending);
    // Recover only the operation stored before this page mounted. New writes
    // reconcile in their own catch path, without racing the first request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runManagement = async (kind: PendingManagement["kind"],
    submit: (operationId: string) => Promise<{ operation?: PluginOperationReceipt | null; canceled?: boolean }>,
    installation?: PendingManagement["installation"], uninstall?: PendingManagement["uninstall"]) => {
    if (managementPending || installing || previewing || installNotice === "unknown") return;
    const pending = { operationId: window.crypto.randomUUID(), kind, installation, uninstall };
    saveManagementOperation(pending);
    setManagementPending(pending);
    setManagementNotice(null);
    try {
      const result = await submit(pending.operationId);
      if (result.canceled) {
        saveManagementOperation(null); setManagementPending(null); setManagementNotice(null); return;
      }
      if (result.operation?.kind === kind && result.operation.phase === "completed") {
        await finishManagement("completed");
      } else if (result.operation?.kind === kind && result.operation.phase === "failed") {
        await finishManagement("failed");
      } else setManagementNotice("unknown");
    } catch (failure) {
      if (failure instanceof ApiError
        && ["ACTIVATION_DEFERRED", "PLUGIN_CONNECTION_CLOSE_FAILED"].includes(
          failure.code || "") && (installation?.desiredState === "disabled" || uninstall)) {
        setManagementNotice(failure.code === "ACTIVATION_DEFERRED" ? "deferred" : "closeFailed");
      } else if (failure instanceof ApiError
        && [400, 403, 404, 409, 413].includes(failure.status)) {
        await finishManagement("failed");
      } else await checkManagementOperation(pending);
    }
  };

  const togglePackage = async (item: PluginCatalogItem) => {
    const installation = { installationId: item.installationId,
      desiredState: item.desiredState === "enabled" ? "disabled" as const : "enabled" as const,
      expectedRevision: item.revision };
    await runManagement("installation-state", (operationId) =>
      setPluginInstallationState({ ...installation, operationId }), installation);
  };

  const retryManagement = async () => {
    const pending = managementPending;
    if (!pending || (!pending.uninstall && pending.installation?.desiredState !== "disabled")
      || managementRetrying) return;
    setManagementRetrying(true);
    setManagementNotice(null);
    try {
      const result = pending.uninstall ? await uninstallPlugin({ ...pending.uninstall, operationId: pending.operationId })
        : await setPluginInstallationState({ ...pending.installation!, operationId: pending.operationId });
      if (result.operation.phase === "completed") await finishManagement("completed");
      else if (result.operation.phase === "failed") await finishManagement("failed");
      else setManagementNotice("deferred");
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "ACTIVATION_DEFERRED") {
        setManagementNotice("deferred");
      } else if (failure instanceof ApiError
        && failure.code === "PLUGIN_CONNECTION_CLOSE_FAILED") {
        setManagementNotice("closeFailed");
      } else await checkManagementOperation(pending);
    } finally {
      setManagementRetrying(false);
    }
  };

  const connectMcp = async (item: PluginCatalogItem, componentId: string) => {
    await runManagement("mcp-connect", async operationId => {
      const result = await requestPluginMcpConsent({ action: "connect", agentId: selectedAgentId,
        installationId: item.installationId, componentId, expectedRevision: item.revision, operationId });
      if (result.canceled) return { canceled: true };
      if (result.receipt) {
        try { await discoverPluginMcpTools(selectedAgentId, result.receipt.bindingId); }
        catch { setMcpToolsError(true); }
      }
      return getPluginOperation(operationId);
    });
  };

  const allowTool = async (bindingId: string, tool: PluginMcpTools["items"][number], approvalMode: "always" | "each-call") => {
    if (!mcpTools?.catalogRevision) return;
    const catalogRevision = mcpTools.catalogRevision;
    await runManagement("grant-allow", async operationId => {
      const result = await requestPluginMcpConsent({ action: "allow", agentId: selectedAgentId,
        bindingId, toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
        catalogRevision, approvalMode, expectedRevision: tool.savedGrant?.revision || 0, operationId });
      return result.canceled ? { canceled: true } : getPluginOperation(operationId);
    });
  };

  const selectAccount = async (bindingId: string, connectionId: string, expectedRevision: number) => {
    if (!selectedAgentId) return;
    await runManagement("mcp-connect", async operationId => {
      const result = await selectPluginAccount({ agentId: selectedAgentId,
        bindingId, connectionId, expectedRevision, operationId });
      return result.canceled ? { canceled: true } : getPluginOperation(operationId);
    });
  };

  const inspectUninstall = async (item: PluginCatalogItem) => {
    try {
      setUninstallPreview(await previewPluginUninstall({ installationId: item.installationId,
        expectedRevision: item.revision }));
    } catch { setManagementNotice("failed"); }
  };

  const confirmUninstall = async () => {
    if (!uninstallPreview || uninstallPreview.requiresDisable) return;
    const input = { installationId: uninstallPreview.installationId,
      expectedRevision: uninstallPreview.expectedRevision };
    setUninstallPreview(null);
    await runManagement("uninstall", operationId => uninstallPlugin({ ...input, operationId }), undefined, input);
  };

  const revokeToolGrant = async (bindingId: string, toolIdentity: string,
    expectedRevision: number) => {
    if (!selectedAgentId) return;
    await runManagement("grant-revoke", (operationId) => revokePluginMcpGrant({
      agentId: selectedAgentId, bindingId, toolIdentity,
      expectedRevision, operationId,
    }));
  };

  const revokeAllToolGrants = async (bindingId: string, expectedRevision: number) => {
    if (!selectedAgentId) return;
    await runManagement("grants-revoke-all", (operationId) =>
      revokeAllPluginMcpGrants({ agentId: selectedAgentId, bindingId,
        expectedRevision, operationId }));
  };

  const focusDialogBeforeStep = () => {
    // Keep focus on a mounted element while replacing the popup's contents.
    // Base UI otherwise recovers focus from a removed button after our step focus.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.closest<HTMLElement>('[role="dialog"]')?.focus();
    }
  };

  const chooseBundled = async (packageId: string) => {
    if (previewing || installing || installNotice === "unknown" || managementPending) return;
    focusDialogBeforeStep();
    setDetailItem(null);
    setManagedPluginId(null);
    onInstallDialogOpenChange(true);
    setPreviewing(true);
    setInstallNotice(null);
    setInstallName("");
    setSelection(null);
    try {
      const chosen = await previewBundledPlugin(packageId);
      if (!chosen.canceled && chosen.preview) {
        setSelection({ handle: chosen.selectionHandle, preview: chosen.preview, bundleId: packageId });
      }
    } catch { setInstallNotice("failed"); }
    finally { focusDialogBeforeStep(); setPreviewing(false); }
  };

  const withInstallationState = (item: BundledPluginItem): BundledPluginItem => {
    const installed = catalog?.items.find(entry => entry.installationId === item.installationId
      || entry.sourceKind === "bundled" && entry.packageName === item.id);
    return installed ? { ...item, installationState: installed.desiredState } : item;
  };
  const selectedBundleItem = selection?.bundleId
    ? bundled.find(item => item.id === selection.bundleId) : null;
  const selectedBundle = selectedBundleItem ? withInstallationState(selectedBundleItem) : null;
  const bundledCurrent = Boolean(selectedBundle?.installedReleaseDigest
    && selectedBundle.installedReleaseDigest === selection?.preview.previewDigest);
  const bundledNeedsDisable = Boolean(selectedBundle?.installationState === "enabled"
    && !bundledCurrent);

  const finishInstall = async (notice: "completed" | "failed" | "updateRequiresDisable") => {
    setInstallNotice(notice);
    saveInstallOperation(null);
    setLastOperationId(null);
    if (notice === "completed") {
      try { await refreshCatalog(); }
      catch { setError(true); }
    }
  };

  const closeInstallDialog = () => {
    if (installing || previewing || checkingOperation) return;
    onInstallDialogOpenChange(false);
    setDetailItem(null);
    setManagedPluginId(null);
    setSelection(null);
    setUninstallPreview(null);
    if (installNotice !== "unknown") setInstallNotice(null);
  };

  const backToLibrary = () => {
    setSelection(null);
    setDetailItem(null);
    setInstallNotice(null);
    closeInstallDialog();
  };

  const openManagement = (installationId: string, opener?: HTMLButtonElement) => {
    if (opener) detailOpener.current = opener;
    setDetailItem(null);
    setManagementTarget(installationId);
    setManagedPluginId(installationId);
    onInstallDialogOpenChange(true);
  };

  const installPackage = async () => {
    if (!selection?.handle || !selection.preview.installable || installing || previewing
      || installNotice === "unknown" || managementPending || bundledCurrent || bundledNeedsDisable) return;
    focusDialogBeforeStep();
    const operationId = window.crypto.randomUUID();
    setLastOperationId(operationId);
    saveInstallOperation(operationId);
    setInstalling(true);
    setInstallName(selection.preview.name);
    setInstallNotice(null);
    try {
      const result = await installSelectedPlugin({ selectionHandle: selection.handle,
        previewDigest: selection.preview.previewDigest,
        expectedRevision: selection.preview.expectedRevision, operationId });
      if (result.operation.phase === "completed") {
        await finishInstall("completed");
      } else if (result.operation.phase === "failed") {
        await finishInstall(installFailureNotice(result.operation));
      } else setInstallNotice("unknown");
    } catch (failure) {
      // A transport failure after Service acceptance has an unknown outcome.
      // Read the durable receipt; never resend the installation automatically.
      try {
        const receipt = await getPluginOperation(operationId);
        if (receipt.operation?.phase === "completed") {
          await finishInstall("completed");
        } else if (receipt.operation?.phase === "failed") {
          await finishInstall(installFailureNotice(receipt.operation));
        } else if (failure instanceof ApiError
          && [400, 403, 404, 409, 413].includes(failure.status)) {
          await finishInstall(failure.code === "PLUGIN_UPDATE_REQUIRES_DISABLE"
            ? "updateRequiresDisable" : "failed");
        } else setInstallNotice("unknown");
      } catch {
        setInstallNotice("unknown");
      }
    } finally {
      focusDialogBeforeStep();
      setSelection(null);
      setInstalling(false);
    }
  };

  const checkOperation = async () => {
    if (!lastOperationId || checkingOperation) return;
    setCheckingOperation(true);
    try {
      const receipt = await getPluginOperation(lastOperationId);
      if (receipt.operation?.phase === "completed") {
        await finishInstall("completed");
      } else if (receipt.operation?.phase === "failed") {
        await finishInstall(installFailureNotice(receipt.operation));
      }
      else setInstallNotice("unknown");
    } catch {
      setInstallNotice("unknown");
    } finally { setCheckingOperation(false); }
  };

  const bundledGroups = BUNDLED_GROUPS.map(group => {
    const items = bundled.filter(item => bundledGroupId(item.category) === group.id)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "en"));
    return { id: group.id, label: t(group.label), items };
  }).filter(group => group.items.length > 0);

  const installBusy = previewing || installing || checkingOperation;
  const unlistedInstalled = catalog?.supported ? catalog.items.filter(item =>
    !bundled.some(bundle => bundle.installationId === item.installationId
      || item.sourceKind === "bundled" && item.packageName === bundle.id)) : [];
  const currentDetail = detailItem && withInstallationState(bundled.find(item => item.id === detailItem.id) || detailItem);
  const managementItem = catalog?.items.find(item => item.installationId === managedPluginId);

  return <>
      <Modal open={active && installDialogOpen}
        title={uninstallPreview ? t("plugins.uninstallTitle") : detailItem
          ? t("plugins.pluginDetails") : managedPluginId
            ? managementItem?.packageName || t("plugins.managePlugin") : t("plugins.installDialogTitle")}
        width={880} className={styles.installDialog}
        dismissible={!installBusy} onClose={closeInstallDialog}
        onOpenChangeComplete={open => {
          if (!open) {
            const opener = detailOpener.current;
            detailOpener.current = null;
            if (opener?.isConnected) opener.focus();
          }
        }}
        footer={uninstallPreview ? <>
          <button className="btn-secondary" type="button" onClick={() => setUninstallPreview(null)}>
            {t("plugins.cancelPreview")}</button>
          <button className="btn-danger" type="button"
            disabled={uninstallPreview.requiresDisable || managementPending !== null}
            onClick={() => void confirmUninstall()}>{t("plugins.uninstallConfirm")}</button>
        </> : !previewing && !installing && !detailItem && !managedPluginId && (selection && !installNotice
          ? <>
            <button className="btn-secondary" type="button" onClick={backToLibrary}>
              {t("plugins.backToLibrary")}</button>
            <button className="btn-primary" type="button"
              disabled={!selection.handle || !selection.preview.installable || installBusy
                || managementPending !== null || bundledCurrent || bundledNeedsDisable}
              onClick={() => void installPackage()}>
              {t(selection.preview.sourceKind === "bundled"
                ? selectedBundle?.installationState !== "not-installed"
                  ? "plugins.installBundledUpdate" : "plugins.installBundledConfirm"
                : "plugins.installDisabled")}
            </button>
          </>
          : installNotice && <>
            {installNotice === "unknown"
              ? <button className="btn-primary" type="button" disabled={checkingOperation}
                  onClick={() => void checkOperation()}>
                  {t(checkingOperation ? "plugins.checkingOperation" : "plugins.checkOperation")}</button>
              : <button className="btn-secondary" type="button" onClick={backToLibrary}>
                  {t(installNotice === "completed" ? "plugins.installAnother" : "plugins.retryInstall")}</button>}
            <button className={installNotice === "completed" ? "btn-primary" : "btn-secondary"}
              type="button" disabled={checkingOperation} onClick={closeInstallDialog}>
              {t(installNotice === "completed" ? "plugins.installDone" : "common.close")}</button>
          </>)}>
        {uninstallPreview && <>
          <p>{t("plugins.uninstallImpact", { agents: uninstallPreview.affectedAgentCount,
            bindings: uninstallPreview.bindingCount })}</p>
          <p>{t("plugins.uninstallRetained")}</p>
          {uninstallPreview.requiresDisable && <p>{t("plugins.uninstallDisableFirst")}</p>}
        </>}
        {!uninstallPreview && managedPluginId && !installNotice && <>
          <div className={styles.grid}>
            <section className={styles.installedCatalog} aria-label={t("plugins.myPlugins")}>
              {managementNotice && <div className={styles.catalogMessage} role="status">
                {managementNotice === "completed" ? t("plugins.managementCompleted")
                  : managementNotice === "deferred" ? t(managementPending?.kind === "uninstall"
                    ? "plugins.uninstallDeferred" : "plugins.managementDeferred")
                    : managementNotice === "closeFailed" ? t("plugins.managementCloseFailed")
                  : managementNotice === "failed" ? t("plugins.managementFailed")
                    : t("plugins.managementUnknown")}
                {managementNotice === "unknown" && <button className="btn-secondary" type="button"
                  onClick={() => void checkManagementOperation()}>
                  {t("plugins.checkOperation")}
                </button>}
                {(managementNotice === "deferred" || managementNotice === "closeFailed")
                  && (managementPending?.installation?.desiredState === "disabled" || managementPending?.uninstall)
                  && <button className="btn-secondary" type="button"
                    disabled={managementRetrying}
                    onClick={() => void retryManagement()}>
                    {managementRetrying ? t("plugins.retryingDisable") : managementPending?.uninstall
                      ? t("plugins.retryUninstall") : t("plugins.retryDisable")}
                  </button>}
              </div>}
              {loading && <div className={styles.catalogMessage}>{t("plugins.loading")}</div>}
              {catalogUnavailable && <div className={styles.catalogMessage} role="status">
                {t("plugins.catalogUnavailable")}
              </div>}
              {!loading && managementTarget && catalog?.supported && catalog.nextCursor === null
                && !catalog.items.some(item => item.installationId === managementTarget)
                && <div className={styles.catalogMessage} role="status">
                  {t("plugins.managementTargetMissing")}
                </div>}
              {!loading && catalog?.supported && managedPluginId
                && !catalog.items.some(item => item.installationId === managedPluginId)
                && <p className={styles.catalogMessage}>{t("plugins.managementTargetMissing")}</p>}
              {catalog?.supported && catalog.items.length > 0 && (
                <div className={styles.agentChoice}>
                  {selectedAgentId ? t("plugins.globalMcpConnections") : t("plugins.noAgentsForConnection")}
                </div>)}
              {catalog?.supported && catalog.items.length > 0 && (
                <ul className={styles.packageList}>
                  {catalog.items.filter(item => item.installationId === managedPluginId).map((item) => (
                    <li className={styles.packageItem} key={item.installationId}
                      ref={managementTarget === item.installationId ? targetItemRef : undefined}
                      tabIndex={managementTarget === item.installationId ? -1 : undefined}
                      data-targeted={managementTarget === item.installationId ? "true" : undefined}>
                      <div className={styles.packageHeading}>
                        <strong>{item.packageName}</strong>
                        <span>{t(installationStatusKey(item))}</span>
                      </div>
                      <div className={styles.packageMeta}>
                        {item.sourceKind === "bundled" ? t("plugins.bundledSource")
                          : item.sourceKind === "first-party" ? t("plugins.firstPartySource")
                          : item.sourceKind === "legacy-directory" ? t("plugins.legacySource")
                          : ["git", "remote-git"].includes(item.sourceKind) ? t("plugins.gitSource")
                          : t("plugins.localSource")}
                        {item.declaredVersion ? ` · ${item.declaredVersion}` : ""}
                        {` · ${t("plugins.componentCount", { count: item.components.length })}`}
                      </div>
                      <button className="btn-secondary btn-sm" type="button"
                        disabled={managementPending !== null || installing || previewing
                          || installNotice === "unknown"}
                        onClick={() => void togglePackage(item)}>
                        {item.desiredState === "enabled" ? t("plugins.disablePackage")
                          : t("plugins.enablePackage")}
                      </button>
                      <button className="btn-secondary btn-sm" type="button"
                        disabled={managementPending !== null || installing || previewing || installNotice === "unknown"}
                        onClick={() => void inspectUninstall(item)}>{t("plugins.uninstallTitle")}</button>
                      <details className={styles.packageDetails} open>
                        <summary>{t("plugins.managePlugin")}</summary>
                      <PluginRollbackControl installationId={item.installationId} revision={item.revision}
                        enabled={item.desiredState === "enabled"} disabled={managementPending !== null || installing || previewing || installNotice === "unknown"}
                        onChanged={refreshCatalog} />
                      {selectedAgentId && <PluginQuickSetup agentId={selectedAgentId} installationId={item.installationId}
                        revision={item.revision} disabled={managementPending !== null || installing || previewing || installNotice === "unknown"}
                        onChanged={() => { void refreshCatalog().catch(() => setError(true)); }} />}
                      <ul className={styles.componentList}>
                        {item.components.slice(0, 6).map((component) => (
                          <li key={component.componentId}>{component.title}</li>
                        ))}
                      </ul>
                      {item.sourceKind === "bundled" && item.packageName === "zoom"
                        && <PluginZoomRegistration />}
                      {item.sourceKind === "bundled" && item.packageName === "dropbox"
                        && <PluginDropboxRegistration />}
                      {item.sourceKind === "bundled" && ["google-calendar", "google-drive"].includes(item.packageName)
                        && <p id={`plugin-oauth-deferred-${item.installationId}`}>{t("plugins.googleWorkspaceDeferred")}</p>}
                      {item.sourceKind === "bundled" && item.packageName === "higgsfield"
                        && <><p>{t("plugins.higgsfieldAcceptancePending")}</p>
                          <PluginHiggsfieldRegistration /></>}
                      {item.sourceKind === "bundled" && item.packageName === "shopify"
                        && <p id={`plugin-oauth-deferred-${item.installationId}`}>{t("plugins.shopifyAuthorizationPending")}</p>}
                      {item.sourceKind === "bundled" && isGraphRegistrationPackage(item.packageName)
                        && <PluginGraphRegistration packageId={item.packageName} />}
                      {selectedAgentId && item.components.some((component) =>
                        component.kind === "mcp-server") && <ul className={styles.mcpStatusList}>
                        {item.components.filter((component) => component.kind === "mcp-server")
                          .map((component) => {
                            const status = mcpStatuses[item.installationId];
                            const current = status?.items.find((entry) =>
                              entry.componentId === component.componentId);
                            const oauthDeferred = item.sourceKind === "bundled"
                              && ["google-calendar", "google-drive", "shopify"]
                                .includes(item.packageName);
                            return <li key={component.componentId}>
                              <strong>{component.title}</strong>
                              {item.sourceKind === "bundled" && item.packageName === "figma"
                                && <p>{t("plugins.figmaDesktopMcpSetup")}</p>}
                              {component.transport === "stdio" && <PluginDependencyControl
                                installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                                enabled={item.desiredState === "enabled"}
                                disabled={managementPending !== null || installing || previewing} />}
                              <span>{status === undefined ? t("plugins.mcpStatusLoading")
                                : !current ? t("plugins.mcpStatusUnavailable")
                                  : t("plugins.mcpVerifiedConnections", {
                                    count: current.connections.verified })}</span>
                              {current && <span>{current.binding
                                ? `${t(current.binding.enabled ? "plugins.mcpBindingEnabled"
                                  : "plugins.mcpBindingDisabled")} · ${t(
                                    current.binding.connectionState === "ready"
                                      ? "plugins.mcpSelectedVerified"
                                      : "plugins.mcpSelectedUnverified")}`
                                : t("plugins.mcpUnbound")}</span>}
                              {current?.binding && current.accounts.length > 0 && <div className={styles.accountChoices}>
                                <span>{t("plugins.selectedAccount", { account:
                                  current.accounts.find(account => account.connectionId === current.binding!.connectionId)?.label
                                    || t("plugins.mcpSelectedUnverified") })}</span>
                                {current.accounts.filter(account => account.connectionId !== current.binding!.connectionId)
                                  .map(account => <button className="btn-secondary" type="button"
                                    key={account.connectionId}
                                    disabled={managementPending !== null || installing || previewing
                                      || item.desiredState !== "enabled"}
                                    onClick={() => void selectAccount(current.binding!.bindingId,
                                      account.connectionId, current.binding!.revision)}>
                                    {t("plugins.selectAccount", { account: account.label })}
                                  </button>)}
                              </div>}
                              {(component.transport === "stdio"
                                && !(item.sourceKind === "bundled" && item.packageName === "gmail")
                                || component.transport === "streamable-http"
                                && item.sourceKind === "bundled" && item.packageName === "figma")
                                && (!current?.binding?.enabled
                                || current.binding.connectionState !== "ready") && <button className="btn-secondary" type="button"
                                disabled={item.desiredState !== "enabled" || managementPending !== null || installing || previewing}
                                onClick={() => void connectMcp(item, component.componentId)}>{t("plugins.mcpConnect")}</button>}
                              {component.transport === "shoggoth-gogcli-gmail-mcp"
                                && item.sourceKind === "bundled" && item.packageName === "gmail"
                                && <PluginGmailRegistration showCapabilities
                                  onCapabilitiesChanged={() => { setExpandedMcpBinding(null); setMcpTools(null);
                                    void refreshCatalog().catch(() => setError(true)); }}>
                                  <PluginGmailConnect key={`${selectedAgentId}:${component.componentId}`}
                                    agentId={selectedAgentId} installationId={item.installationId}
                                    componentId={component.componentId} revision={item.revision}
                                    disabled={item.desiredState !== "enabled" || managementPending !== null
                                      || installing || previewing}
                                    connected={current?.binding?.connectionState === "ready"}
                                    onReady={() => { void refreshCatalog().catch(() => setError(true)); }} />
                                </PluginGmailRegistration>}
                              {component.transport === "streamable-http"
                                && item.sourceKind === "bundled" && item.packageName === "github"
                                && component.title === "github" && <PluginBearerConnect
                                key={`${selectedAgentId}:${component.componentId}`} agentId={selectedAgentId}
                                installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                                disabled={item.desiredState !== "enabled" || managementPending !== null || installing || previewing}
                                connected={current?.binding?.connectionState === "ready"}
                                onReady={() => { void refreshCatalog().catch(() => setError(true)); }} />}
                              {component.transport === "streamable-http"
                                && item.sourceKind === "bundled" && item.packageName === "cloudflare"
                                && component.title === "cloudflare-api" && <PluginBearerConnect
                                key={`${selectedAgentId}:${component.componentId}`} agentId={selectedAgentId}
                                installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                                provider="cloudflare"
                                disabled={item.desiredState !== "enabled" || managementPending !== null || installing || previewing}
                                connected={current?.binding?.connectionState === "ready"}
                                onReady={() => { void refreshCatalog().catch(() => setError(true)); }} />}
                              {component.transport === "shoggoth-graph" && <PluginOAuthConnect
                                key={`${selectedAgentId}:${component.componentId}`} agentId={selectedAgentId}
                                installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                                disabled={oauthDeferred || item.desiredState !== "enabled"
                                  || managementPending !== null || installing || previewing}
                                disabledReasonId={oauthDeferred ? `plugin-oauth-deferred-${item.installationId}` : undefined}
                                connected={current?.binding?.connectionState === "ready"}
                                onReady={() => { void refreshCatalog().catch(() => setError(true)); }} />}
                              {component.transport === "streamable-http"
                                && !(item.sourceKind === "bundled" && item.packageName === "github"
                                  && component.title === "github")
                                && !(item.sourceKind === "bundled" && item.packageName === "cloudflare"
                                  && component.title === "cloudflare-api")
                                && !(item.sourceKind === "bundled" && item.packageName === "figma")
                                && <PluginOAuthConnect
                                key={`${selectedAgentId}:${component.componentId}`} agentId={selectedAgentId}
                                installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                                disabled={oauthDeferred || item.desiredState !== "enabled"
                                  || managementPending !== null || installing || previewing}
                                disabledReasonId={oauthDeferred ? `plugin-oauth-deferred-${item.installationId}` : undefined}
                                connected={current?.binding?.connectionState === "ready"}
                                onReady={() => { void refreshCatalog().catch(() => setError(true)); }} />}
                              {current?.binding && <span>{t("plugins.mcpSavedGrants", {
                                allow: current.binding.grants.allow,
                                deny: current.binding.grants.deny })}</span>}
                              {current?.binding && <PluginConnectionControl
                                key={`${selectedAgentId}:${current.binding.bindingId}`} agentId={selectedAgentId}
                                bindingId={current.binding.bindingId} revision={current.binding.revision}
                                connected={current.binding.connectionState === "ready"}
                                disabled={managementPending !== null || installing || previewing}
                                onDisconnected={() => { setExpandedMcpBinding(null); setMcpTools(null);
                                  void refreshCatalog().catch(() => setError(true)); }} />}
                              {current?.binding && current.binding.grants.allow > 0
                                && <button className="btn-secondary" type="button"
                                  disabled={managementPending !== null || installing || previewing
                                    || installNotice === "unknown"}
                                  onClick={() => void revokeAllToolGrants(
                                    current.binding!.bindingId, current.binding!.revision)}>
                                  {t("plugins.mcpRevokeAllGrants")}
                                </button>}
                              {current?.binding && <button className="btn-secondary" type="button"
                                disabled={mcpToolsLoading}
                                onClick={() => void toggleMcpTools(current.binding!.bindingId)}>
                                {expandedMcpBinding === current.binding.bindingId
                                  ? t("plugins.mcpHideTools") : t("plugins.mcpShowTools")}
                              </button>}
                              {current?.binding && expandedMcpBinding === current.binding.bindingId
                                && <div className={styles.mcpTools}>
                                  {mcpToolsLoading && <span>{t("plugins.mcpToolsLoading")}</span>}
                                  {mcpToolsError && <span role="status">
                                    {t("plugins.mcpToolsUnavailable")}</span>}
                                  {mcpTools && !mcpTools.available && <span>
                                    {t("plugins.mcpCatalogNotReady")}</span>}
                                  {mcpTools?.available && mcpTools.items.length === 0 && <span>
                                    {t("plugins.mcpNoTools")}</span>}
                                  {mcpTools?.available && item.sourceKind === "bundled"
                                    && item.packageName === "github" && component.title === "github"
                                    && <p className={styles.packageMeta}>
                                      {mcpTools.referenceCoverage?.operations.length
                                        ? <>{t("plugins.githubMcpPortableScope")}{" "}
                                          {mcpTools.referenceCoverage.operations.map(capability =>
                                            capability.id === "repository-file-read"
                                              ? t("plugins.githubMcpFileRead")
                                              : capability.id === "repository-file-write"
                                                ? t("plugins.githubMcpFileWrite")
                                                : capability.id === "repository-issue-read"
                                                  ? t("plugins.githubMcpIssueRead")
                                                  : capability.id === "repository-issue-comment"
                                                    ? t("plugins.githubMcpIssueComment") : capability.id).join("、")}</>
                                        : t("plugins.githubMcpNoFileOperations")}
                                    </p>}
                                  {mcpTools?.available && mcpTools.items.length > 0 &&
                                    <ul className={styles.mcpToolList}>
                                      {mcpTools.items.map((tool) => <li key={tool.toolIdentity}>
                                        <span>{tool.name}</span>
                                        {(!tool.savedGrant || tool.savedGrant.effect !== "allow"
                                          || !tool.savedGrant.matchesCurrentContract || tool.savedGrant.expired)
                                          && <><button className="btn-secondary" type="button"
                                            disabled={managementPending !== null || installing || previewing}
                                            onClick={() => void allowTool(current.binding!.bindingId, tool, "each-call")}>
                                            {t("plugins.mcpAllowEachCall")}</button>
                                            <button className="btn-secondary" type="button"
                                              disabled={managementPending !== null || installing || previewing}
                                              onClick={() => void allowTool(current.binding!.bindingId, tool, "always")}>
                                              {t("plugins.mcpAllowTool")}</button></>}
                                        <span>{!tool.savedGrant
                                          ? t("plugins.mcpGrantNone")
                                          : !tool.savedGrant.matchesCurrentContract
                                            ? t("plugins.mcpGrantStale")
                                            : tool.savedGrant.expired
                                              ? t("plugins.mcpGrantExpired")
                                            : tool.savedGrant.effect === "allow"
                                              ? t(tool.savedGrant.approvalMode === "each-call"
                                                ? "plugins.mcpGrantEachCall"
                                                : "plugins.mcpGrantAllow")
                                              : t("plugins.mcpGrantDeny")}</span>
                                        {tool.savedGrant?.effect === "allow" &&
                                          <button className="btn-secondary" type="button"
                                            disabled={managementPending !== null || installing || previewing
                                              || installNotice === "unknown"}
                                            onClick={() => void revokeToolGrant(
                                              current.binding!.bindingId, tool.toolIdentity,
                                              tool.savedGrant!.revision)}>
                                            {t("plugins.mcpRevokeGrant")}
                                          </button>}
                                      </li>)}
                                    </ul>}
                                </div>}
                            </li>;
                          })}
                      </ul>}
                      {item.components.some(component => component.kind === "skill")
                        && <div className={styles.packageMeta}>{t("plugins.globalPluginSkills")}</div>}
                      {item.components.length > 6 && <div className={styles.packageMeta}>
                        {t("plugins.moreComponents", { count: item.components.length - 6 })}
                      </div>}
                      {item.diagnosticCount > 0 && <div className={styles.packageMeta}>
                        {t("plugins.diagnostics", { count: item.diagnosticCount })}
                      </div>}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>}
        {(previewing || installing) && <div ref={installStatusRef} tabIndex={-1}
          className={styles.installStatus} role="status" aria-live="polite">
          <span className={styles.installSpinner} aria-hidden="true" />
          <h3>{t(installing ? "plugins.installing" : "plugins.preparingInstall")}</h3>
          <p>{installing ? installName : t("plugins.preparingInstallHint")}</p>
        </div>}
        {!previewing && !installing && installNotice && <div ref={installStatusRef} tabIndex={-1}
          className={styles.installStatus} data-result={installNotice} role="status" aria-live="polite">
          <span className={styles.installResultIcon} aria-hidden="true">
            {installNotice === "completed" ? "✓" : installNotice === "unknown" ? "…" : "!"}</span>
          <h3>{t(installNotice === "completed" ? "plugins.installSuccessTitle"
            : installNotice === "unknown" ? "plugins.installUnknownTitle" : "plugins.installFailureTitle")}</h3>
          {installName && <strong>{installName}</strong>}
          <p>{installNotice === "completed" ? t("plugins.installCompleted")
            : installNotice === "updateRequiresDisable" ? t("plugins.updateRequiresDisable")
            : installNotice === "failed" ? t("plugins.installFailed") : t("plugins.installUnknown")}</p>
          {installNotice === "completed" && error && <p>{t("plugins.installedListRefreshFailed")}</p>}
        </div>}
        {!previewing && !installing && !installNotice && <>
          {selection && <div ref={previewPanelRef} tabIndex={-1} className={styles.previewPanel}>
            <h3>{selection.preview.name}</h3>
            {selectedBundle?.installationState !== "not-installed" && selectedBundle &&
              <p>{bundledCurrent ? t("plugins.bundledCurrentVersion")
                : bundledNeedsDisable ? t("plugins.bundledDisableBeforeUpdate")
                  : t("plugins.bundledUpdateReady")}</p>}
            <div className={styles.packageMeta}>
              {t(selection.preview.sourceKind === "bundled" ? "plugins.previewBundledComponents" : "plugins.previewComponents", { count:
                selection.preview.components.skills.length
                  + selection.preview.components.mcpServers.length })}
            </div>
            <ul className={styles.componentList}>
              {selection.preview.components.skills.map((item) => <li key={item.descriptorDigest}>
                {item.name}
              </li>)}
              {selection.preview.components.mcpServers.map((item) => <li key={item.descriptorDigest}>
                {item.name} · {item.type}
              </li>)}
            </ul>
            {selection.preview.diagnostics.length > 0 && <>
              <div className={styles.packageMeta}>
                {t("plugins.diagnostics", { count: selection.preview.diagnostics.length })}
              </div>
              <ul className={styles.diagnosticList}>
                {selection.preview.diagnostics.map((item, index) => <li key={`${index}-${item.reasonCode}`}>
                  {item.name ? `${item.scope} · ${item.name}` : item.scope}
                  {` · ${item.reasonCode === "CODEX_OAUTH_CLIENT_REGISTRATION_REQUIRED"
                    ? t(selectedBundle?.id === "zoom" ? "plugins.zoomRegistrationIntro"
                      : "plugins.oauthClientRegistrationRequired")
                    : item.reasonCode === "CODEX_GOOGLE_DESKTOP_OAUTH_REQUIRED"
                      ? t("plugins.googleDesktopOAuthRequired") : item.reasonCode}`}
                </li>)}
              </ul>
            </>}
            {selectedBundle?.id === "zoom" && selectedBundle.installationState === "not-installed"
              && <PluginZoomRegistration />}
            {selectedBundle?.id === "dropbox" && selectedBundle.installationState === "not-installed"
              && <PluginDropboxRegistration />}
            {selectedBundle?.id === "figma" && <p>{t("plugins.figmaDesktopMcpSetup")}</p>}
            {selectedBundle && ["google-calendar", "google-drive"].includes(selectedBundle.id)
              && <p>{t("plugins.googleWorkspaceDeferred")}</p>}
            {selectedBundle?.id === "higgsfield" && <p>{t("plugins.higgsfieldAcceptancePending")}</p>}
            {selectedBundle?.id === "higgsfield" && <PluginHiggsfieldRegistration />}
            {selectedBundle?.id === "shopify" && <p>{t("plugins.shopifyAuthorizationPending")}</p>}
            {selectedBundle?.localAdapter === "shoggoth-graph-read-only"
              && isGraphRegistrationPackage(selectedBundle.id)
              && <PluginGraphRegistration packageId={selectedBundle.id} />}
            {selectedBundle?.localAdapter === "shoggoth-lovable-official-mcp"
              && <PluginLovableRegistration />}
            {selectedBundle?.localAdapter === "shoggoth-slack-official-mcp"
              && <PluginSlackRegistration />}
            {selectedBundle?.localAdapter === "shoggoth-gogcli-gmail-mcp"
              && <PluginGmailRegistration />}
          </div>}
        </>}
        {!previewing && !installNotice && detailItem && <BundledPluginDetailDialog embedded
          key={detailItem.id} item={currentDetail!} nativeAgentId={selectedAgentId || null}
          busy={installBusy || managementPending !== null} returnFocusTo={detailOpener.current}
          onClose={closeInstallDialog}
          onPreview={id => void chooseBundled(id)}
          onManage={installationId => openManagement(installationId)} />}
      </Modal>
      <section className={styles.bundledLibrary} aria-label={t("plugins.myPlugins")}>
        {(bundledLoading || loading) && <p className={styles.catalogMessage} role="status">{t("plugins.loading")}</p>}
        {bundledError && <p className={styles.catalogMessage} role="status">{t("plugins.bundledUnavailable")}</p>}
        {catalogUnavailable && <p className={styles.catalogMessage} role="status">{t("plugins.catalogUnavailable")}</p>}
        {managementPending && <p className={styles.catalogMessage} role="status">
          {t("plugins.managementUnknown")}
          <button className="btn-secondary btn-sm" type="button" onClick={() => void checkManagementOperation()}>
            {t("plugins.checkOperation")}</button>
        </p>}
        {!bundledLoading && !loading && !bundledError && !catalogUnavailable && bundled.length + unlistedInstalled.length === 0
          && <p className={styles.libraryEmpty} role="status">{t("plugins.libraryEmpty")}</p>}
        <div className={styles.bundledGroups}>
          {bundledGroups.map(group =>
            <section className={styles.bundledGroup} key={group.id} data-plugin-group={group.id}
              aria-labelledby={`plugin-group-${group.id}`}>
              <div className={styles.bundledGroupHeading}>
                <h2 id={`plugin-group-${group.id}`}>{group.label}</h2>
                <span aria-label={t("plugins.bundledGroupCount", { count: group.items.length })}>{group.items.length}</span>
              </div>
              <div className={styles.bundledGrid}>
                {group.items.map(bundle => {
                  const item = withInstallationState(bundle);
                  const installed = item.installationState !== "not-installed";
                  const installable = item.importStatus === "previewable" || Boolean(item.localAdapter);
                  return <article className={styles.bundledCard} key={item.id} data-plugin-id={item.id}
                    data-installed={installed ? "true" : "false"}
                    data-installation-id={installed ? item.installationId : undefined}>
                    <button id={`plugin-card-${item.id}`} className={styles.bundledCardOpen} type="button"
                      aria-label={t("plugins.detailOpen", { name: item.displayName })}
                      disabled={installBusy || installNotice === "unknown"}
                      onClick={event => {
                        detailOpener.current = event.currentTarget;
                        setManagedPluginId(null); setDetailItem(item); onInstallDialogOpenChange(true);
                      }}>
                      {item.iconAvailable
                        ? <img className={styles.bundledIcon} src={`/__api/plugins/bundled-icon/${item.id}`} alt="" loading="lazy" />
                        : <span className={styles.bundledIconFallback} aria-hidden="true">{item.displayName.slice(0, 1)}</span>}
                      <span className={styles.bundledTitle}>
                        <span className={styles.bundledName}><strong>{item.displayName}</strong>
                          {installed && <span className={styles.installedMark}>{t("plugins.installed")}</span>}</span>
                        <span className={styles.bundledDescription}>{item.localAdapter === "shoggoth-graph-read-only"
                          ? t(graphReadOnlyCopy(item.id).short)
                          : item.localAdapter === "shoggoth-lovable-official-mcp" ? t("plugins.lovableOfficialShort")
                            : item.localAdapter === "shoggoth-slack-official-mcp" ? t("plugins.slackOfficialShort")
                              : item.localAdapter === "shoggoth-gogcli-gmail-mcp" ? t("plugins.gmailGogcliShort") : item.shortDescription}</span>
                      </span>
                    </button>
                    <button className={styles.rowAction} type="button" data-plugin-action={installed ? "manage" : "install"}
                      disabled={installBusy || installNotice === "unknown" || !installed && (!installable || !catalog?.supported
                        || managementPending !== null)}
                      aria-label={t(installed ? "plugins.manageNamedPlugin" : installable
                        ? "plugins.installNamedPlugin" : "plugins.adapterPending", { name: item.displayName })}
                      title={t(installed ? "plugins.manageNamedPlugin" : installable
                        ? "plugins.installNamedPlugin" : "plugins.adapterPending", { name: item.displayName })}
                      onClick={event => {
                        detailOpener.current = event.currentTarget;
                        if (installed) openManagement(item.installationId);
                        else void chooseBundled(item.id);
                      }}>
                      <span aria-hidden="true">{installed ? "…" : "+"}</span>
                    </button>
                  </article>;
                })}
              </div>
            </section>)}
          {unlistedInstalled.length > 0 && <section className={styles.bundledGroup} data-plugin-group="local"
            aria-labelledby="plugin-group-local">
            <div className={styles.bundledGroupHeading}>
              <h2 id="plugin-group-local">{t("plugins.localPlugins")}</h2><span>{unlistedInstalled.length}</span>
            </div>
            <div className={styles.bundledGrid}>{unlistedInstalled.map(item =>
              <article className={styles.bundledCard} key={item.installationId} data-installed="true"
                data-installation-id={item.installationId}>
                <button className={styles.bundledCardOpen} type="button"
                  aria-label={t("plugins.detailOpen", { name: item.packageName })}
                  disabled={installBusy || installNotice === "unknown"}
                  onClick={event => openManagement(item.installationId, event.currentTarget)}>
                  <span className={styles.bundledIconFallback} aria-hidden="true">{item.packageName.slice(0, 1)}</span>
                  <span className={styles.bundledTitle}>
                    <span className={styles.bundledName}><strong>{item.packageName}</strong>
                      <span className={styles.installedMark}>{t("plugins.installed")}</span></span>
                    <span className={styles.bundledDescription}>{t(installationStatusKey(item))}
                      {item.declaredVersion ? ` · ${item.declaredVersion}` : ""}</span>
                  </span>
                </button>
                <button className={styles.rowAction} type="button" data-plugin-action="manage"
                  aria-label={t("plugins.manageNamedPlugin", { name: item.packageName })}
                  disabled={installBusy || installNotice === "unknown"}
                  onClick={event => openManagement(item.installationId, event.currentTarget)}><span aria-hidden="true">…</span></button>
              </article>)}</div>
          </section>}
        </div>
        {catalog?.supported && catalog.nextCursor !== null && !catalogUnavailable && <button
          className="btn-secondary" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? t("plugins.loading") : t("plugins.loadMore")}</button>}
      </section>
      <PluginExternalActivity active={active} />
  </>;
}
