import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { completeMcpRequest, listMcpConnectors, listMcpRequests, MCP_CHANGE_EVENT, formatMcpError, searchMcpRegistry, type McpConnectionRequest, type McpRegistryItem, type McpServer } from "../api/mcpConnectors";
import { mcpRecommendationText, mcpRecommendationForTarget, mcpRemoteUrlsMatch, mcpRequestFields, mcpRequestStatus, type McpRecommendation } from "../lib/mcpConnectorUi";
import { mcpBrandId, mcpConnectorName, mcpRegistrySummary } from "../lib/mcpRecommendationCatalog";
import { useStickyState } from "../lib/useStickyState";
import { usePendingConnectors } from "../lib/usePendingConnectors";
import featuredPresets from "../../../agent-service/data/mcp-featured-presets.json";
import McpConnectorIcon from "./McpConnectorIcon";
import Modal from "./Modal";
import McpConnectorDialog from "../pages/McpConnectorDialog";
import s from "../pages/ConnectorsPage.module.css";

type ConnectionDialog = { item?: McpRegistryItem; recommendation?: McpRecommendation; initialUrl?: string; servers: McpServer[]; serverId?: string };
const MAX_DISMISSED_REQUESTS = 512;
const recommendations = featuredPresets as McpRecommendation[];
const recommendationForRequest = (request: McpConnectionRequest) => mcpRecommendationForTarget(recommendations, {
  registryName: request.registryName, catalogId: request.registryName ? mcpBrandId(request.registryName) : undefined, url: request.url,
});

function matchesConnection(request: McpConnectionRequest, server: McpServer): boolean {
  if (request.registryName) return server.source.kind === "registry" && server.source.registryName === request.registryName;
  if (!request.url || server.transport.kind !== "remote") return false;
  // Request URLs use the Service's public endpoint identity.
  const url = new URL(server.transport.url);
  url.search = "";
  url.hash = "";
  return url.href === request.url;
}

// Credentials stay in the mounted forms and are never included in chat messages.
export default function McpConnectionRequests({ backendId, agentId, sessionKey, visible = true, group = false }: {
  backendId: string; agentId: string; sessionKey: string; visible?: boolean; group?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`mcpConnectors.${key}`);
  const language = i18n?.resolvedLanguage || i18n?.language;
  const pending = usePendingConnectors();
  const [items, setItems] = useState<McpConnectionRequest[]>([]);
  const [dismissedIds, setDismissedIds] = useStickyState<string[]>("chat.dismissedMcpConnectionRequests", []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connection, setConnection] = useState<ConnectionDialog | null>(null);
  const [setupServer, setSetupServer] = useState<McpServer | null>(null);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const scope = `${backendId}:${agentId}:${sessionKey}`;
  const activeScope = useRef<string | null>(null);
  activeScope.current = visible && !group ? scope : null;
  const lookup = useRef<AbortController | null>(null);
  const completing = useRef<object | null>(null);
  const visibleItems = items.filter(item => item.kind !== "connection" || !dismissedIds.includes(item.requestId));
  const request = visibleItems.find(item => item.requestId === selectedId);
  const activeConnection = connection && request?.kind === "connection" && mcpRequestStatus(request) === "pending" ? connection : null;
  const activeServer = activeConnection?.servers.find(server => server.id === activeConnection.serverId);
  const activeRecommendation = activeServer ? mcpRecommendationForTarget(recommendations, { server: activeServer,
    catalogId: activeServer.source?.kind === "registry" ? mcpBrandId(activeServer.source.registryName) : undefined }) : activeConnection?.recommendation;
  const pendingKey = activeConnection?.item ? `registry:${activeConnection.item.registryName}` : activeRecommendation ? `preset:${activeRecommendation.id}` : undefined;

  const closeRequest = useCallback(() => {
    setSelectedId(null);
    setValues({});
    setConnection(null);
    setSetupServer(null);
    setError("");
  }, []);
  const dismissRequest = (requestId: string) => {
    setDismissedIds(ids => [...ids, requestId].slice(-MAX_DISMISSED_REQUESTS));
    if (selectedId === requestId) {
      lookup.current?.abort();
      lookup.current = null;
      setOpening(false);
      closeRequest();
    }
  };
  useEffect(() => { setItems([]); }, [scope]);
  useEffect(() => {
    closeRequest();
    setOpening(false);
    setBusy(false);
    return () => {
      lookup.current?.abort();
      lookup.current = null;
      completing.current = null;
    };
  }, [scope, visible, group, closeRequest]);

  useEffect(() => {
    if (!visible || group || !sessionKey || !agentId) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await listMcpRequests({ backendId, agentId, sessionKey }, controller.signal);
        const installed = result.items.some(item => item.kind === "setup") ? await listMcpConnectors(controller.signal) : null;
        if (!controller.signal.aborted) {
          setItems(result.items);
          if (installed) setServers(installed.servers);
        }
      } catch {
        // Chat remains usable when the local management plane is unavailable.
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    const changed = () => void load();
    window.addEventListener(MCP_CHANGE_EVENT, changed);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(MCP_CHANGE_EVENT, changed);
    };
  }, [scope, visible, group, reload]);

  const openRequest = (item: McpConnectionRequest) => {
    setSelectedId(item.requestId);
    setValues({});
    setError("");
  };
  const openConnection = async (value: McpConnectionRequest) => {
    if (lookup.current || completing.current || activeScope.current !== scope) return;
    const controller = new AbortController();
    lookup.current = controller;
    openRequest(value);
    setOpening(true);
    try {
      const installed = await listMcpConnectors(controller.signal);
      const recommendation = recommendationForRequest(value);
      const catalogAlias = !!value.registryName && recommendation?.registryAliases?.includes(value.registryName);
      const matches = installed.servers.filter(server => catalogAlias ? server.source.kind === "custom" && server.transport.kind === "remote"
        && server.transport.protocol === "streamable-http" && mcpRemoteUrlsMatch(server.transport.url, recommendation?.url) : matchesConnection(value, server));
      let item: McpRegistryItem | undefined;
      if (!matches.length && value.registryName && !catalogAlias) {
        const page = await searchMcpRegistry(value.registryName, undefined, controller.signal);
        item = page.items.find(entry => entry.registryName === value.registryName);
        if (!item) throw { code: "MCP_REGISTRY_ENTRY_UNAVAILABLE" };
      }
      if (!controller.signal.aborted && activeScope.current === scope) {
        setConnection({ item, recommendation, initialUrl: value.url || recommendation?.url, servers: matches, serverId: matches[0]?.id });
      }
    } catch (error) {
      if (!controller.signal.aborted && activeScope.current === scope) setError(formatMcpError(error, t));
    } finally {
      if (lookup.current === controller) {
        lookup.current = null;
        setOpening(false);
      }
    }
  };
  const complete = async (serverId = request?.serverId || undefined) => {
    if (!request || completing.current || activeScope.current !== scope) return;
    const ticket = {};
    completing.current = ticket;
    const isCurrent = () => completing.current === ticket && activeScope.current === scope;
    setBusy(true);
    setError("");
    try {
      await completeMcpRequest({
        requestId: request.requestId,
        ...(serverId && request.kind !== "setup" ? { serverId } : {}),
        ...(request.kind === "secret" ? { fields: mcpRequestFields(request, values) } : {}),
      });
      if (isCurrent()) {
        closeRequest();
        setReload(value => value + 1);
      }
    } catch (error) {
      if (isCurrent()) setError(formatMcpError(error, t));
    } finally {
      if (isCurrent()) {
        completing.current = null;
        setBusy(false);
      }
    }
  };

  if (!visible) return null;
  if (group) return <div className={s.requestList} role="note"><p>{tr("privateOnly")}</p></div>;
  if (!visibleItems.length) return null;
  return <div className={s.requestList} aria-label={tr("request")}>
    {visibleItems.map(item => {
      const status = mcpRequestStatus(item);
      const actionable = status === "pending" && item.continuation !== "unknown";
      const statusLabel = status === "completed" ? tr("requestDone") : status === "expired" ? tr("requestExpired") : tr("errors.ackUnknown");
      if (item.kind === "connection") {
        const identity = item.registryName || item.url || item.title;
        const recommendation = recommendationForRequest(item);
        const summary = item.registryName ? mcpRegistrySummary(item.registryName) : undefined;
        const name = mcpConnectorName(recommendation?.id || identity, recommendation?.name || summary?.name || item.title);
        const description = recommendation ? mcpRecommendationText(recommendation.description, language) : summary ? mcpRecommendationText(summary.description, language) : item.purpose;
        const current = item.requestId === selectedId;
        const dismissLabel = t("mcpConnectors.requestDismiss", { name });
        return <section className={`${s.requestCard} ${s.requestConnection}`} key={item.requestId}>
          <McpConnectorIcon name={name} identity={identity} iconId={recommendation?.id || summary?.iconId} />
          <div className={s.requestIdentity}>
            <h3>{name}</h3>
            <p title={recommendation || summary ? item.purpose : undefined}>{description}</p>
            {!actionable && <p className={s.muted}>{statusLabel}</p>}
          </div>
          <div className={s.requestActions}>
            {actionable && <button type="button" className="btn-secondary btn-sm" disabled={opening || busy}
              title={t("mcpConnectors.expires", { time: new Date(item.expiresAt).toLocaleString() })}
              onClick={() => void openConnection(item)}>{tr(current && opening ? "loading" : "add")}</button>}
            <button type="button" className={s.requestDismiss} aria-label={dismissLabel} title={dismissLabel}
              onClick={() => dismissRequest(item.requestId)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          {current && !activeConnection && error && <p className={`${s.error} ${s.requestError}`} role="alert">{error}</p>}
        </section>;
      }

      const setup = item.kind === "setup";
      const targets = setup ? servers.filter(server => item.serverIds?.includes(server.id)) : [];
      const ready = setup && targets.length === item.serverIds?.length && targets.every(server => server.status === "ready");
      return <section className={s.requestCard} key={item.requestId}>
        <h3>{item.title}</h3><p>{item.purpose}</p>
        <p className={s.muted}>{!actionable ? statusLabel : setup ? tr(ready ? "setupResuming" : "setupUserAction")
          : t("mcpConnectors.expires", { time: new Date(item.expiresAt).toLocaleString() })}</p>
        {actionable && (setup ? targets.map(server => <div key={server.id} className={s.actions}>
          <span>{server.name} · {tr(`statuses.${server.status}`)}</span>
          {["needsSetup", "signedOut"].includes(server.status) && <button type="button" className={s.button} onClick={() => { openRequest(item); setSetupServer(server); }}>{tr(server.status === "signedOut" ? "signin" : "requestSecret")}</button>}
        </div>) : <button type="button" className={s.button} onClick={() => openRequest(item)}>{tr("requestSecret")}</button>)}
      </section>;
    })}
    <Modal open={request?.kind === "secret"} onClose={() => { if (!busy) closeRequest(); }}
      dismissible={!busy} title={request?.title || tr("request")} width={600} className={s.modal}>
      <div className={s.detail}>
        <p>{request?.purpose}</p><p className={s.muted}>{tr("secretsHint")}</p>
        <div className={s.fields}>{request?.requiredFields.map(field => {
          const key = `${field.kind}:${field.name}`;
          return <label className={s.field} key={key}>
            <span>{field.label}</span>
            <input type="password" autoComplete="off" spellCheck={false} disabled={busy} value={values[key] || ""}
              onChange={event => setValues(previous => ({ ...previous, [key]: event.target.value }))} />
          </label>;
        })}</div>
        {error && <p className={s.error} role="alert">{error}</p>}
        <div className={s.actions}><button type="button" className={s.primary} disabled={busy} onClick={() => void complete()}>{tr(busy ? "working" : "finish")}</button></div>
      </div>
    </Modal>
    {activeConnection && <McpConnectorDialog key={`${selectedId}:${activeConnection.serverId || "new"}`}
      server={activeServer} recommendation={activeRecommendation}
      item={activeConnection.item} initialUrl={activeConnection.initialUrl}
      catalogEntry={!!pendingKey} pending={!!pendingKey && pending.ids.includes(pendingKey)} autoAdd={!!pendingKey}
      onStage={pendingKey ? () => pending.add(pendingKey) : undefined} onUnstage={pendingKey ? () => pending.remove(pendingKey) : undefined}
      connectionRequest={{
        busy, error, servers: activeConnection.servers,
        onSelect: serverId => { setError(""); setConnection({ ...activeConnection, serverId }); },
      }}
      onClose={closeRequest} onChanged={() => setReload(value => value + 1)}
      onReady={server => void complete(server.id)} />}
    {setupServer && <McpConnectorDialog key={setupServer.id} server={setupServer}
      onClose={closeRequest} onChanged={() => setReload(value => value + 1)} onReady={() => void complete()} />}
  </div>;
}
