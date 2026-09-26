import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getPluginCatalogPage, getPluginMcpStatus, getPluginMcpTools,
  getBundledPlugins, previewBundledPlugin,
  getPluginOperation,
  requestPluginMcpConsent, discoverPluginMcpTools, previewPluginUninstall, uninstallPlugin,
  installSelectedPlugin, listAgents, revokeAllPluginMcpGrants,
  revokePluginMcpGrant, selectPluginPackage, selectRemotePluginPackage,
  setPluginInstallationState,
  type PluginCatalogItem, type PluginCatalogPage, type PluginInstallPreview,
  type PluginMcpStatus, type PluginMcpTools, type PluginOperationReceipt,
  type PluginUninstallPreview } from "../api/client";
import type { BundledPluginItem } from "../api/client";
import type { UnifiedAgent } from "../types";
import { PageHead } from "../components/PageHead";
import BackendTabs from "../components/BackendTabs";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import { useNavigationRequest } from "../lib/navigation-guard";
import styles from "./PluginsPage.module.css";
import { ExternalPluginsPanel } from "./ExternalPluginsPanel";
import { PluginOAuthConnect } from "./PluginOAuthConnect";
import { PluginDependencyControl } from "./PluginDependencyControl";
import { PluginRollbackControl } from "./PluginRollbackControl";
import { PluginConnectionControl } from "./PluginConnectionControl";

const PENDING_INSTALL_KEY = "shoggoth.plugin.pending-install.v1";
const PENDING_MANAGEMENT_KEY = "shoggoth.plugin.pending-management.v1";
const LIBRARY_VIEW_KEY = "shoggoth.plugin.library-view.v1";
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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

export default function PluginsPage() {
  const { t } = useTranslation();
  const [backend, setBackend] = useBackendState("plugins");
  const backends = useBackendCatalog();
  const backendName = backends.find(item => item.id === backend)?.name || backend;
  return <div className={`page management-page ${styles.page}`}>
    <PageHead title={t("plugins.title")} subtitle={t("plugins.subtitle")} />
    <div className="ui-toolbar">
      <BackendTabs value={backend} onChange={setBackend} />
    </div>
    {/* Keep pending consent, connection and install receipts mounted across tabs. */}
    <div hidden={backend !== "shoggoth"} data-plugin-host="shoggoth">
      <NativePluginsPanel />
    </div>
    {backend !== "shoggoth" && <ExternalPluginsPanel key={backend} backend={backend} backendName={backendName} />}
  </div>;
}

function NativePluginsPanel() {
  const mcpStatusAgentId = useRef("");
  const { t } = useTranslation();
  const navigate = useNavigationRequest();
  const [catalog, setCatalog] = useState<PluginCatalogPage | null>(null);
  const [bundled, setBundled] = useState<BundledPluginItem[]>([]);
  const [bundledError, setBundledError] = useState(false);
  const [libraryView, setLibraryView] = useState<"available" | "installed">(() => {
    try { return localStorage.getItem(LIBRARY_VIEW_KEY) === "installed" ? "installed" : "available"; }
    catch { return "available"; }
  });
  const [libraryQuery, setLibraryQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState<{
    handle: string | null; preview: PluginInstallPreview; bundleId?: string;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [gitSourceOpen, setGitSourceOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitCommit, setGitCommit] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [installing, setInstalling] = useState(false);
  const [lastOperationId, setLastOperationId] = useState(storedInstallOperation);
  const [installNotice, setInstallNotice] = useState<"completed" | "failed"
    | "updateRequiresDisable" | "unknown" | null>(
    () => storedInstallOperation() ? "unknown" : null,
  );
  const [agents, setAgents] = useState<UnifiedAgent[]>([]);
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
    try { localStorage.setItem(LIBRARY_VIEW_KEY, libraryView); }
    catch { /* The in-memory tab selection remains usable. */ }
  }, [libraryView]);

  useEffect(() => {
    let active = true;
    void getBundledPlugins().then(result => {
      if (active) { setBundled(result.items); setBundledError(false); }
    }).catch(() => { if (active) setBundledError(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void getPluginCatalogPage().then((page) => {
      if (active) setCatalog(page);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!lastOperationId || installNotice !== "unknown") return;
    let active = true;
    void getPluginOperation(lastOperationId).then((receipt) => {
      if (!active) return;
      if (receipt.operation?.phase === "completed") {
        setInstallNotice("completed");
        saveInstallOperation(null);
        setLastOperationId(null);
        void getPluginCatalogPage().then((page) => {
          if (active) setCatalog(page);
        }).catch(() => { if (active) setError(true); });
      } else if (receipt.operation?.phase === "failed") {
        setInstallNotice(installFailureNotice(receipt.operation));
        saveInstallOperation(null);
        setLastOperationId(null);
      }
    }).catch(() => { /* Keep the receipt action available. */ });
    return () => { active = false; };
  }, [lastOperationId, installNotice]);

  useEffect(() => {
    if (!catalog?.supported) return;
    let active = true;
    void listAgents("shoggoth").then((rows) => {
      if (!active) return;
      setAgents(rows);
      setSelectedAgentId((current) => rows.some((agent) => agent.id === current)
        ? current : rows[0]?.id || "");
    }).catch(() => { if (active) setAgents([]); });
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
    const [page, bundledPage] = await Promise.all([getPluginCatalogPage(), getBundledPlugins()]);
    setCatalog(page);
    setBundled(bundledPage.items);
    setBundledError(false);
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

  const choosePackage = async (remote = false) => {
    if (previewing || installing || installNotice === "unknown" || managementPending) return;
    setPreviewing(true);
    setInstallNotice(null);
    try {
      const chosen = remote ? await selectRemotePluginPackage({ repositoryUrl: gitUrl.trim(),
        commit: gitCommit.trim(), subdir: gitSubdir.trim() || null }) : await selectPluginPackage();
      if (!chosen.canceled && chosen.preview) {
        setSelection({ handle: chosen.selectionHandle ?? null, preview: chosen.preview });
      }
    } catch {
      setInstallNotice("failed");
    } finally {
      setPreviewing(false);
    }
  };

  const chooseBundled = async (packageId: string) => {
    if (previewing || installing || installNotice === "unknown" || managementPending) return;
    setPreviewing(true);
    setInstallNotice(null);
    try {
      const chosen = await previewBundledPlugin(packageId);
      if (!chosen.canceled && chosen.preview) {
        setSelection({ handle: chosen.selectionHandle, preview: chosen.preview, bundleId: packageId });
        setLibraryView("installed");
      }
    } catch { setInstallNotice("failed"); }
    finally { setPreviewing(false); }
  };

  const selectedBundle = selection?.bundleId
    ? bundled.find(item => item.id === selection.bundleId) : null;
  const bundledCurrent = Boolean(selectedBundle?.installedReleaseDigest
    && selectedBundle.installedReleaseDigest === selection?.preview.previewDigest);
  const bundledNeedsDisable = Boolean(selectedBundle?.installationState === "enabled"
    && !bundledCurrent);

  const installPackage = async () => {
    if (!selection?.handle || !selection.preview.installable || installing
      || managementPending || bundledCurrent || bundledNeedsDisable) return;
    const operationId = window.crypto.randomUUID();
    setLastOperationId(operationId);
    saveInstallOperation(operationId);
    setInstalling(true);
    setInstallNotice(null);
    try {
      const result = await installSelectedPlugin({ selectionHandle: selection.handle,
        previewDigest: selection.preview.previewDigest,
        expectedRevision: selection.preview.expectedRevision, operationId });
      if (result.operation.phase === "completed") {
        setInstallNotice("completed");
        saveInstallOperation(null);
        setLastOperationId(null);
        await refreshCatalog();
      } else setInstallNotice("unknown");
    } catch (failure) {
      // A transport failure after Service acceptance has an unknown outcome.
      // Read the durable receipt; never resend the installation automatically.
      try {
        const receipt = await getPluginOperation(operationId);
        if (receipt.operation?.phase === "completed") {
          setInstallNotice("completed");
          saveInstallOperation(null);
          setLastOperationId(null);
          await refreshCatalog();
        } else if (receipt.operation?.phase === "failed") {
          setInstallNotice(installFailureNotice(receipt.operation));
          saveInstallOperation(null);
          setLastOperationId(null);
        } else if (failure instanceof ApiError
          && [400, 403, 404, 409, 413].includes(failure.status)) {
          setInstallNotice(failure.code === "PLUGIN_UPDATE_REQUIRES_DISABLE"
            ? "updateRequiresDisable" : "failed");
          saveInstallOperation(null);
          setLastOperationId(null);
        } else setInstallNotice("unknown");
      } catch {
        setInstallNotice("unknown");
      }
    } finally {
      setSelection(null);
      setInstalling(false);
    }
  };

  const checkOperation = async () => {
    if (!lastOperationId) return;
    try {
      const receipt = await getPluginOperation(lastOperationId);
      if (receipt.operation?.phase === "completed") {
        setInstallNotice("completed");
        saveInstallOperation(null);
        setLastOperationId(null);
        await refreshCatalog();
      } else if (receipt.operation?.phase === "failed") {
        setInstallNotice(installFailureNotice(receipt.operation));
        saveInstallOperation(null);
        setLastOperationId(null);
      }
      else setInstallNotice("unknown");
    } catch {
      setInstallNotice("unknown");
    }
  };

  const visibleBundled = bundled.filter(item => `${item.displayName} ${item.shortDescription} ${item.category}`
    .toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()));

  return <>
      <div className={styles.libraryTabs} role="tablist" aria-label={t("plugins.libraryTabsLabel")}
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = libraryView === "available" ? "installed" : "available";
          setLibraryView(next);
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=tab]");
          buttons[next === "available" ? 0 : 1]?.focus();
        }}>
        <button type="button" role="tab" aria-selected={libraryView === "available"}
          tabIndex={libraryView === "available" ? 0 : -1}
          onClick={() => setLibraryView("available")}>{t("plugins.availableLibrary")}</button>
        <button type="button" role="tab" aria-selected={libraryView === "installed"}
          tabIndex={libraryView === "installed" ? 0 : -1}
          onClick={() => setLibraryView("installed")}>{t("plugins.installedLibrary")}</button>
      </div>
      {libraryView === "available" && <section className={styles.bundledLibrary} aria-label={t("plugins.availableLibrary")}>
        <p className={styles.libraryIntro}>{t("plugins.bundledIntro", { count: bundled.length })}</p>
        <label className={styles.librarySearch} htmlFor="plugin-library-search">
          <span>{t("plugins.searchLibrary")}</span>
          <input id="plugin-library-search" type="search" value={libraryQuery}
            onChange={event => setLibraryQuery(event.target.value)} placeholder={t("plugins.searchLibraryPlaceholder")} />
        </label>
        {bundledError && <p role="status">{t("plugins.bundledUnavailable")}</p>}
        <div className={styles.bundledGrid}>
          {visibleBundled.map(item => <article className={styles.bundledCard} key={item.id}>
            <div className={styles.bundledCardTop}>
              {item.iconAvailable
                ? <img className={styles.bundledIcon} src={`/__api/plugins/bundled-icon/${item.id}`}
                  alt="" loading="lazy" />
                : <span className={styles.bundledIconFallback} aria-hidden="true" />}
              <div className={styles.bundledTitle}><strong>{item.displayName}</strong><span>{item.category}</span></div>
            </div>
            <p>{item.shortDescription}</p>
            <div className={styles.bundledMeta}>
              {item.components.skills > 0 && <span>{t("plugins.bundledSkillCoverage", {
                converted: item.converted.skills, total: item.components.skills })}</span>}
              {item.components.mcp > 0 && <span>{t("plugins.bundledMcpCoverage", {
                converted: item.converted.mcp, total: item.components.mcp })}</span>}
              {item.components.apps > 0 && <span>{t("plugins.bundledConnectorPending", {
                count: item.components.apps })}</span>}
            </div>
            {item.unconvertedMcp.length > 0 && <details className={styles.bundledGaps}>
              <summary>{t("plugins.bundledMcpGaps", { count: item.unconvertedMcp.length })}</summary>
              <ul>{item.unconvertedMcp.map(issue => <li key={issue.name}>
                <strong>{issue.name}</strong> · {t(issue.reasonCode === "LEGACY_MCP_FIELD_UNSUPPORTED"
                  ? "plugins.bundledMcpUnsupported" : "plugins.bundledMcpInvalid")}
              </li>)}</ul>
            </details>}
            <div className={styles.bundledCardBottom}>
              <span>{item.installationState === "not-installed"
                ? t("plugins.notInstalled") : item.installationState === "enabled"
                  ? t("plugins.desiredEnabled") : t("plugins.disabled")}</span>
              <button className="btn-secondary" type="button"
                disabled={item.importStatus !== "previewable" || previewing || installing
                  || installNotice === "unknown" || managementPending !== null}
                onClick={() => void chooseBundled(item.id)}>
                {item.importStatus !== "previewable" ? t("plugins.adapterPending")
                  : item.installationState !== "not-installed" ? t("plugins.checkBundledUpdate")
                    : t("plugins.installBundled")}
              </button>
            </div>
          </article>)}
        </div>
      </section>}
      <div className={styles.grid} hidden={libraryView !== "installed"}>
        <section className={styles.card} aria-labelledby="plugins-skills-heading">
          <div className={styles.cardHeading}>
            <h2 id="plugins-skills-heading">{t("plugins.skillsTitle")}</h2>
            <span className={styles.available}>{t("plugins.available")}</span>
          </div>
          <p>{t("plugins.skillsDescription")}</p>
          <button className="btn-secondary" type="button" onClick={() => navigate("/skills")}>
            {t("plugins.openSkills")}
          </button>
        </section>
        <section className={`${styles.card} ${styles.packages}`} aria-labelledby="plugins-packages-heading">
          <div className={styles.cardHeading}>
            <h2 id="plugins-packages-heading">{t("plugins.packagesTitle")}</h2>
            <span className={styles.pending}>{catalog?.supported
              ? t("plugins.localCatalog") : t("plugins.serviceUnavailable")}</span>
          </div>
          <p>{t("plugins.packagesDescription")}</p>
          {catalog?.supported && <div className={styles.previewActions}><button className="btn-secondary" type="button"
            disabled={previewing || installing || installNotice === "unknown"
              || managementPending !== null}
            onClick={() => void choosePackage()}>
            {previewing ? t("plugins.choosing") : t("plugins.choosePackage")}
          </button>
          <button className="btn-secondary" type="button" aria-expanded={gitSourceOpen}
            disabled={previewing || installing || installNotice === "unknown" || managementPending !== null}
            onClick={() => setGitSourceOpen(value => !value)}>{t("plugins.gitAdd")}</button></div>}
          {catalog?.supported && gitSourceOpen && <form className={styles.gitSourceForm} onSubmit={event => {
            event.preventDefault(); void choosePackage(true);
          }}>
            <label htmlFor="plugin-git-url">{t("plugins.gitUrl")}</label>
            <input id="plugin-git-url" type="url" value={gitUrl} required maxLength={2048} placeholder="https://example.org/team/plugin.git"
              onChange={event => setGitUrl(event.target.value)} disabled={previewing || installing} />
            <label htmlFor="plugin-git-commit">{t("plugins.gitCommit")}</label>
            <input id="plugin-git-commit" value={gitCommit} required pattern="(?:[a-f0-9]{40}|[a-f0-9]{64})" maxLength={64}
              onChange={event => setGitCommit(event.target.value)} disabled={previewing || installing} />
            <label htmlFor="plugin-git-subdir">{t("plugins.gitSubdir")}</label>
            <input id="plugin-git-subdir" value={gitSubdir} maxLength={512} placeholder="plugins/example"
              onChange={event => setGitSubdir(event.target.value)} disabled={previewing || installing} />
            <p>{t("plugins.gitScope")}</p>
            <button className="btn-secondary" type="submit" disabled={previewing || installing || installNotice === "unknown"
              || managementPending !== null}>{previewing ? t("plugins.choosing") : t("plugins.gitPreview")}</button>
          </form>}
          {selection && <div className={styles.previewPanel}>
            <h3>{selection.preview.name}</h3>
            {selectedBundle?.installationState !== "not-installed" && selectedBundle &&
              <p>{bundledCurrent ? t("plugins.bundledCurrentVersion")
                : bundledNeedsDisable ? t("plugins.bundledDisableBeforeUpdate")
                  : t("plugins.bundledUpdateReady")}</p>}
            <div className={styles.packageMeta}>
              {t("plugins.previewComponents", { count:
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
                  {` · ${item.reasonCode}`}
                </li>)}
              </ul>
            </>}
            <div className={styles.previewActions}>
              <button className="btn-secondary" type="button"
                disabled={!selection.handle || !selection.preview.installable || installing
                  || managementPending !== null || bundledCurrent || bundledNeedsDisable}
                onClick={() => void installPackage()}>
                {installing ? t("plugins.installing") : t(selection.preview.sourceKind === "bundled"
                  ? selectedBundle?.installationState !== "not-installed"
                    ? "plugins.installBundledUpdate" : "plugins.installBundledConfirm"
                  : "plugins.installDisabled")}
              </button>
              <button className="btn-secondary" type="button" disabled={installing}
                onClick={() => setSelection(null)}>{t("plugins.cancelPreview")}</button>
            </div>
          </div>}
          {installNotice && <div className={styles.catalogMessage} role="status">
            {installNotice === "completed" ? t("plugins.installCompleted")
              : installNotice === "updateRequiresDisable"
                ? t("plugins.updateRequiresDisable")
              : installNotice === "failed" ? t("plugins.installFailed")
                : t("plugins.installUnknown")}
            {installNotice === "unknown" && <button className="btn-secondary" type="button"
              onClick={() => void checkOperation()}>{t("plugins.checkOperation")}</button>}
          </div>}
          {uninstallPreview && <div className={styles.previewPanel}>
            <h3>{t("plugins.uninstallTitle")}</h3>
            <p>{t("plugins.uninstallImpact", { agents: uninstallPreview.affectedAgentCount,
              bindings: uninstallPreview.bindingCount })}</p>
            <p>{t("plugins.uninstallRetained")}</p>
            {uninstallPreview.requiresDisable && <p>{t("plugins.uninstallDisableFirst")}</p>}
            <button className="btn-secondary" type="button"
              disabled={uninstallPreview.requiresDisable || managementPending !== null}
              onClick={() => void confirmUninstall()}>{t("plugins.uninstallConfirm")}</button>
            <button className="btn-secondary" type="button"
              onClick={() => setUninstallPreview(null)}>{t("plugins.cancelPreview")}</button>
          </div>}
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
          {!loading && catalog?.supported && catalog.items.length === 0 && (
            <div className={styles.catalogMessage}>{t("plugins.noPackages")}</div>
          )}
          {catalog?.supported && catalog.items.length > 0 && (
            <div className={styles.agentChoice}>
              <label htmlFor="plugin-inspect-agent">{t("plugins.inspectAgent")}</label>
              <select id="plugin-inspect-agent" value={selectedAgentId}
                disabled={managementPending !== null || installing}
                onChange={(event) => setSelectedAgentId(event.target.value)}>
                {agents.length === 0 && <option value="">{t("plugins.noAgents")}</option>}
                {agents.map((agent) => <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>)}
              </select>
            </div>)}
          {catalog?.supported && catalog.items.length > 0 && (
            <ul className={styles.packageList}>
              {catalog.items.map((item) => (
                <li className={styles.packageItem} key={item.installationId}>
                  <div className={styles.packageHeading}>
                    <strong>{item.packageName}</strong>
                    <span>{item.desiredState === "enabled"
                      ? t("plugins.desiredEnabled") : t("plugins.disabled")}</span>
                  </div>
                  <div className={styles.packageMeta}>
                    {item.sourceKind === "bundled" ? t("plugins.bundledSource")
                      : item.sourceKind === "legacy-directory" ? t("plugins.legacySource")
                      : ["git", "remote-git"].includes(item.sourceKind) ? t("plugins.gitSource")
                      : t("plugins.localSource")}
                    {item.declaredVersion ? ` · ${item.declaredVersion}` : ""}
                    {` · ${t("plugins.componentCount", { count: item.components.length })}`}
                  </div>
                  <button className="btn-secondary" type="button"
                    disabled={managementPending !== null || installing || previewing
                      || installNotice === "unknown"}
                    onClick={() => void togglePackage(item)}>
                    {item.desiredState === "enabled" ? t("plugins.disablePackage")
                      : t("plugins.enablePackage")}
                  </button>
                  <button className="btn-secondary" type="button"
                    disabled={managementPending !== null || installing || previewing || installNotice === "unknown"}
                    onClick={() => void inspectUninstall(item)}>{t("plugins.uninstallTitle")}</button>
                  <PluginRollbackControl installationId={item.installationId} revision={item.revision}
                    enabled={item.desiredState === "enabled"} disabled={managementPending !== null || installing || previewing || installNotice === "unknown"}
                    onChanged={refreshCatalog} />
                  <ul className={styles.componentList}>
                    {item.components.slice(0, 6).map((component) => (
                      <li key={component.componentId}>{component.title}</li>
                    ))}
                  </ul>
                  {selectedAgentId && item.components.some((component) =>
                    component.kind === "mcp-server") && <ul className={styles.mcpStatusList}>
                    {item.components.filter((component) => component.kind === "mcp-server")
                      .map((component) => {
                        const status = mcpStatuses[item.installationId];
                        const current = status?.items.find((entry) =>
                          entry.componentId === component.componentId);
                        return <li key={component.componentId}>
                          <strong>{component.title}</strong>
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
                          {component.transport === "stdio" && (!current?.binding?.enabled
                            || current.binding.connectionState !== "ready") && <button className="btn-secondary" type="button"
                            disabled={item.desiredState !== "enabled" || managementPending !== null || installing || previewing}
                            onClick={() => void connectMcp(item, component.componentId)}>{t("plugins.mcpConnect")}</button>}
                          {component.transport === "streamable-http" && <PluginOAuthConnect
                            key={`${selectedAgentId}:${component.componentId}`} agentId={selectedAgentId}
                            installationId={item.installationId} componentId={component.componentId} revision={item.revision}
                            disabled={item.desiredState !== "enabled" || managementPending !== null || installing || previewing}
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
                </li>
              ))}
            </ul>
          )}
          {catalog?.supported && catalog.nextCursor !== null && !catalogUnavailable && (
            <button className="btn-secondary" type="button" disabled={loadingMore}
              onClick={() => void loadMore()}>
              {loadingMore ? t("plugins.loading") : t("plugins.loadMore")}
            </button>
          )}
        </section>
      </div>
  </>;
}
