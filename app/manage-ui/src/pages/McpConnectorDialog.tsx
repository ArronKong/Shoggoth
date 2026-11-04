import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import McpConnectorIcon from "../components/McpConnectorIcon";
import ConnectorTools from "../components/ConnectorTools";
import { useConfirm } from "../components/ui";
import { addMcpConnector, cancelMcpSignIn, getMcpSignIn, getMcpOAuthInfo, importMcpConnectors, listMcpConnectors, formatMcpError, searchMcpRegistry, removeMcpConnector, rebindMcpConnector, saveMcpCredentials, startMcpSignIn, updateMcpConnector, verifyMcpConnector, type McpFields, type McpMutation, type McpRegistryItem, type McpServer, type McpSignIn, type McpSetupField, type McpTransport } from "../api/mcpConnectors";
import { FIGMA_DESKTOP_URL, FIGMA_REGISTRY_NAME, isFigmaDesktopConnector, mcpFieldsFromInputs, parseMcpArguments, mcpRecommendationText, mcpRemoteUrlsMatch, mcpRecommendationPackageTransport, mcpRecommendationMatchesServer, mcpServiceGroupEndpoints, mcpServiceGroupSummary, type McpRecommendation } from "../lib/mcpConnectorUi";
import { mcpBrandId, mcpConnectorName, mcpOfficialSkillBrand, mcpRegistrySummary } from "../lib/mcpRecommendationCatalog";
import featuredPresets from "../../../agent-service/data/mcp-featured-presets.json";
import s from "./ConnectorsPage.module.css";
import flightawarePolicy from "../../../core/flightaware-connector-policy.json";

function InlineFrame({ children }: { children?: ReactNode }) { return <div>{children}</div>; }

function McpServiceGroupDialog({ recommendation, server, catalogEntry, pending, autoAdd, onStage, onUnstage, onClose, onChanged }: McpConnectorDialogProps & { recommendation: McpRecommendation }) {
  const { t, i18n } = useTranslation(), confirm = useConfirm();
  const tr = (key: string) => t(`mcpConnectors.${key}`), language = i18n?.resolvedLanguage || i18n?.language || "en";
  const displayName = mcpConnectorName(recommendation.id, recommendation.name);
  const endpoints = mcpServiceGroupEndpoints(recommendation);
  const [servers, setServers] = useState<McpServer[]>(server ? [server] : []), [loaded, setLoaded] = useState(false);
  const [added, setAdded] = useState(!!pending), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [loadError, setLoadError] = useState("");
  const [accessToken, setAccessToken] = useState(""), [values, setValues] = useState<Record<string, string>>({}), [showSecrets, setShowSecrets] = useState(false);
  const [selected, setSelected] = useState<McpServer>();
  const mounted = useRef(true), actionLock = useRef(false), readGeneration = useRef(0), initialAdd = useRef(false);
  const summary = mcpServiceGroupSummary(recommendation, servers), ready = summary.ready === summary.total;
  const preAdd = !!catalogEntry && !added && !servers.length;
  const fields = recommendation.fields || [];
  const missingKey = recommendation.setup === "token" && !accessToken.trim()
    || fields.some(field => field.required && !(values[`${field.location}:${field.name}`] ?? field.default ?? "").trim());
  const load = async (signal?: AbortSignal) => {
    const generation = ++readGeneration.current;
    const snapshot = await listMcpConnectors(signal);
    if (mounted.current && !signal?.aborted && generation === readGeneration.current) {
      setServers(mcpServiceGroupSummary(recommendation, snapshot.servers).members); setLoaded(true); setLoadError("");
    }
    return snapshot;
  };
  const reload = () => void load().catch(error => { if (mounted.current) { setLoaded(false); setLoadError(formatMcpError(error, t)); } });
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void load(controller.signal).catch(error => { if (mounted.current && !controller.signal.aborted) setLoadError(formatMcpError(error, t)); });
    return () => { mounted.current = false; controller.abort(); readGeneration.current++; };
  }, []);
  const stage = () => {
    try { onStage?.(); setAdded(true); } catch { setError(tr("flow.storageError")); }
  };
  useEffect(() => { if (autoAdd && loaded && preAdd && !initialAdd.current) { initialAdd.current = true; stage(); } }, [autoAdd, loaded, preAdd]);
  const remember = (result: McpMutation) => {
    if (!mounted.current) return;
    setServers(previous => [...previous.filter(value => value.id !== result.server.id), result.server]); onChanged();
  };
  const run = async (action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError(""); readGeneration.current++;
    try { await action(); }
    catch (error) { if (mounted.current) setError(formatMcpError(error, t)); }
    finally {
      if (mounted.current) {
        setAccessToken(""); setValues({}); setShowSecrets(false);
        try { await load(); } catch (error) { if (mounted.current) { setLoaded(false); setLoadError(formatMcpError(error, t)); } }
        if (mounted.current) setBusy(false);
      }
      actionLock.current = false;
    }
  };
  const configure = () => run(async () => {
    if (missingKey) return;
    const credentials = mcpFieldsFromInputs({ env: "", headers: "", definitions: fields, values, includeDefaults: true });
    if (recommendation.setup === "token") {
      const token = accessToken.trim().replace(/^Bearer[ \t]+/i, "");
      if (!/^[\x21-\x7e]{1,16384}$/u.test(token)) throw { code: "MCP_SECRET_INVALID" };
      credentials.headers = { ...credentials.headers, Authorization: `Bearer ${token}` };
    }
    for (const endpoint of endpoints) {
      if (!mounted.current) return;
      const snapshot = await load();
      if (!mounted.current) return;
      const group = mcpServiceGroupSummary(recommendation, snapshot.servers);
      // Multiple accounts at one URL must be resolved explicitly, never guessed.
      if (group.ambiguous) throw { code: "MCP_REGISTRY_REVISION_CONFLICT" };
      const existing = group.members.find(value => value.transport.kind === "remote" && mcpRemoteUrlsMatch(value.transport.url, endpoint.url));
      if (existing && (!existing.enabled || existing.status === "disabled")) continue;
      remember(existing
        ? await saveMcpCredentials(existing.id, credentials, snapshot.revision)
        : await addMcpConnector({ source: { kind: "custom" }, option: { kind: "remote", protocol: "streamable-http", url: endpoint.url },
          name: `${recommendation.name} · ${mcpRecommendationText(endpoint.label, language)}`, fields: credentials, expectedRevision: snapshot.revision }));
    }
    if (mounted.current) { setEditing(false); try { onUnstage?.(); } catch { setError(tr("flow.storageError")); } }
  });
  const verify = () => run(async () => {
    for (const member of servers) {
      if (!mounted.current) return;
      const snapshot = await load(), current = snapshot.servers.find(value => value.id === member.id);
      if (!mounted.current) return;
      if (current?.enabled && current.status !== "disabled" && mcpRecommendationMatchesServer(recommendation, current)) remember(await verifyMcpConnector(current.id));
    }
  });
  const remove = () => run(async () => {
    if (!await confirm({ title: tr("group.remove"), message: t("mcpConnectors.group.removeConfirm", { count: servers.length }), confirmLabel: tr("flow.remove") })) return;
    for (const member of servers) {
      if (!mounted.current) return;
      const snapshot = await load(), current = snapshot.servers.find(value => value.id === member.id);
      if (!mounted.current) return;
      if (!current) continue;
      if (!mcpRecommendationMatchesServer(recommendation, current)) throw { code: "MCP_REGISTRY_REVISION_CONFLICT" };
      await removeMcpConnector(current.id, snapshot.revision);
      if (mounted.current) { setServers(previous => previous.filter(value => value.id !== current.id)); onChanged(); }
    }
    if (mounted.current) { onUnstage?.(); onChanged(); onClose(); }
  });
  if (selected) return <McpSingleConnectorDialog key={selected.id} server={selected} recommendation={recommendation} onClose={() => { setSelected(undefined); reload(); }} onChanged={() => { onChanged(); reload(); }} />;
  const footer = <div className={s.flowFooter}><p>{tr(ready ? "flow.connectedHint" : "defaultAccess")}</p><div className={s.flowFooterActions}>
    {preAdd ? <button type="button" className="btn-dark btn-sm" disabled={!loaded || busy} onClick={stage}>{tr("add")}</button>
      : !ready || editing ? <button type="button" className="btn-dark btn-sm" disabled={busy || !loaded || !!missingKey || summary.ambiguous} onClick={() => void configure()}>{tr(busy ? "working" : "group.connectAll")}</button>
      : <button type="button" className="btn-dark btn-sm" disabled={busy} onClick={onClose}>{tr("flow.done")}</button>}
  </div></div>;
  return <Modal open onClose={onClose} dismissible={!busy} title={<span className={s.dialogIdentity}><McpConnectorIcon name={displayName} identity={recommendation.id} iconId={recommendation.id} />{displayName}</span>} width={640} variant="connector" subtitle={mcpRecommendationText(recommendation.description, language)} footer={footer}>
    <div className={s.detail}>
      <ConnectorTools overview description={mcpRecommendationText(recommendation.description, language)} previewId={recommendation.id} />
      <section className={s.connectionPanel}>
      <div className={s.connectionHeading}><h3>{tr("flow.connectionStatus")}</h3><span className={s.status} data-state={ready ? "ready" : undefined} role="status" aria-live="polite">{busy ? tr("working") : !loaded ? tr("loading") : !servers.length ? tr(preAdd ? "flow.notAdded" : "flow.pending") : t("mcpConnectors.group.summary", { ready: summary.ready, total: summary.total })}</span></div><p className={s.muted}>{tr("group.hint")}</p></section>
      <details className={s.management}><summary>{tr("group.services")}</summary>
      <section className={s.connectionPanel}><h3>{tr("group.services")}</h3><p className={s.muted}>{tr("group.hint")}</p>
        {endpoints.map(endpoint => {
          const members = servers.filter(value => value.transport.kind === "remote" && mcpRemoteUrlsMatch(value.transport.url, endpoint.url));
          return <div key={endpoint.url}>
            <div className={s.accountRow}><strong className={s.accountLabel}>{mcpRecommendationText(endpoint.label, language)}</strong><span className={s.status} data-state={members.length === 1 ? members[0].status : undefined}>{members.length ? members.length > 1 ? tr("group.multiple") : tr(`statuses.${members[0].status}`) : tr("flow.notAdded")}</span></div>
            {members.map(member => <details key={member.id} className={s.management}><summary>{tr("flow.manage")}{members.length > 1 ? ` · ${member.name}` : ""}</summary>
              {member.lastCheck?.errorCode && <p className={s.error}>{formatMcpError({ code: member.lastCheck.errorCode }, t)}</p>}
              <ConnectorTools serverId={member.id} status={member.status} checkedAt={member.lastCheck?.at} />
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setSelected(member)}>{tr("group.manageService")}</button>
            </details>)}
          </div>;
        })}
        {summary.ambiguous && <p className={s.notice}>{tr("group.ambiguous")}</p>}
        {servers.some(value => !value.enabled || value.status === "disabled") && <p className={s.notice}>{tr("group.disabledHint")}</p>}
      </section>
      </details>
      {loadError && <p className={s.error} role="alert">{loadError} <button type="button" className={s.textButton} disabled={busy} onClick={reload}>{tr("retry")}</button></p>}
      {preAdd ? <section className={s.connectionPanel}><p className={s.muted}>{tr("flow.addHint")}</p></section> : <>
        {(!ready || editing) && <section className={s.connectionPanel}><h3>{tr("flow.setup")}</h3>
          {recommendation.note && <p className={s.notice}>{mcpRecommendationText(recommendation.note, language)}</p>}
          {recommendation.setupSteps && <ol className={s.setupSteps}>{recommendation.setupSteps.map((step, index) => <li key={index}>{mcpRecommendationText(step, language)}</li>)}</ol>}
          <p className={s.muted}>{tr("group.keyHint")}</p>
          <div className={s.fields}>
            {recommendation.setup === "token" && <label className={s.field}><span>{tr("accessTokenRequired")}</span><input type={showSecrets ? "text" : "password"} autoComplete="off" spellCheck={false} disabled={busy} value={accessToken} onChange={event => setAccessToken(event.target.value)} /></label>}
            {fields.map(field => <label className={s.field} key={`${field.location}:${field.name}`}><span>{field.label ? mcpRecommendationText(field.label, language) : field.name}{field.required ? " *" : ""}</span><input type={field.secret && !showSecrets ? "password" : "text"} autoComplete="off" spellCheck={false} required={field.required} disabled={busy} value={values[`${field.location}:${field.name}`] ?? field.default ?? ""} onChange={event => setValues(previous => ({ ...previous, [`${field.location}:${field.name}`]: event.target.value }))} /></label>)}
          </div>
          <p className={s.muted}>{tr("secretsHint")}</p><button type="button" className={s.textButton} disabled={busy} aria-pressed={showSecrets} onClick={() => setShowSecrets(value => !value)}>{tr(showSecrets ? "hideValue" : "showValue")}</button>

        </section>}
        {!!servers.length && <section className={s.connectionPanel}><div className={s.actions}><button type="button" className="btn-secondary btn-sm" disabled={busy || !loaded} onClick={() => void verify()}>{tr("group.verifyAll")}</button>{ready && <button type="button" className={s.textButton} disabled={busy} onClick={() => setEditing(value => !value)}>{tr("flow.configure")}</button>}</div></section>}
        {(!!servers.length || added) && <details className={s.management}><summary>{tr("flow.manage")}</summary><button type="button" className="btn-danger btn-sm" disabled={busy || !loaded} onClick={() => void remove()}>{tr("group.remove")}</button></details>}
      </>}
      <details className={s.management}><summary>{tr("flow.help")}</summary><a href={recommendation.docsUrl} target="_blank" rel="noreferrer">{tr("officialGuide")}</a></details>
      {error && <p className={s.error} role="alert">{error}</p>}
    </div>
  </Modal>;
}

type McpConnectorDialogProps = {
  embedded?: boolean; catalogEntry?: boolean; pending?: boolean; autoAdd?: boolean; onStage?: () => void; onUnstage?: () => void;
  server?: McpServer; item?: McpRegistryItem; latest?: McpRegistryItem; onLatest?: (item: McpRegistryItem) => void; recommendation?: McpRecommendation; initialUrl?: string; allowFigmaDesktop?: boolean; managed?: boolean; credentialsOnly?: boolean; onClose: () => void; onChanged: () => void; onReady?: (server: McpServer) => void;
};

export default function McpConnectorDialog(props: McpConnectorDialogProps) {
  return mcpServiceGroupEndpoints(props.recommendation).length && !props.managed && !props.credentialsOnly && !props.embedded
    ? <McpServiceGroupDialog key={props.recommendation!.id} {...props} recommendation={props.recommendation!} />
    : <McpSingleConnectorDialog {...props} />;
}

function McpSingleConnectorDialog({ server: initialServer, item, latest, onLatest, recommendation, initialUrl = "", allowFigmaDesktop = false, managed = false, credentialsOnly = false, embedded = false, catalogEntry = false, pending = false, autoAdd = false, onStage, onUnstage, onClose, onChanged, onReady }: McpConnectorDialogProps) {
  const confirm = useConfirm();
  const { t, i18n } = useTranslation(); const tr = (key: string) => t(`mcpConnectors.${key}`);
  const language = i18n?.resolvedLanguage || i18n?.language || "en";
  const flightaware = recommendation?.id === "flightaware";
  const builtinQuery = flightaware || recommendation?.id === "ticketmaster";
  const registryDescription = (entry: McpRegistryItem) => {
    const description = featuredPresets.find(value => value.registryName === entry.registryName)?.description || mcpRegistrySummary(entry.registryName)?.description;
    return description ? mcpRecommendationText(description, language) : entry.description;
  };
  const [server, setServer] = useState(initialServer), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [added, setAdded] = useState(pending), [editing, setEditing] = useState(false), [verifying, setVerifying] = useState(false);
  const actionLock = useRef(false), initialAdd = useRef(false);
  const [figmaMode, setFigmaMode] = useState<"desktop" | "remote">("desktop");
  const [desktopStepsOpen, setDesktopStepsOpen] = useState(initialServer?.status !== "ready");
  // Scoped chat connection requests keep their requested registry identity.
  const canChooseFigmaMode = !server && allowFigmaDesktop && item?.registryName === FIGMA_REGISTRY_NAME;
  const figmaDesktop = isFigmaDesktopConnector(server) || canChooseFigmaMode && figmaMode === "desktop";
  useEffect(() => { setDesktopStepsOpen(server?.status !== "ready"); }, [server?.status]);
  const presetCommand = recommendation?.transport?.kind === "stdio-command" ? recommendation.transport : undefined;
  const presetPackage = recommendation?.transport?.kind === "stdio-package" ? recommendation.transport : undefined;
  const [mode, setMode] = useState<"remote" | "command" | "paste">(initialServer?.transport.kind === "stdio-command" || presetCommand || presetPackage ? "command" : "remote");
  const [repair, setRepair] = useState(!managed && !credentialsOnly && initialServer?.status === "disabled");
  const [url, setUrl] = useState(initialServer?.transport.kind === "remote" ? initialServer.transport.url : recommendation?.url || initialUrl), [command, setCommand] = useState(initialServer?.transport.kind === "stdio-command" ? initialServer.transport.command : presetCommand?.command || ""), [args, setArgs] = useState(JSON.stringify(presetCommand?.args || [])), [cwd, setCwd] = useState("");
  const [name, setName] = useState(recommendation?.name || "");
  const [config, setConfig] = useState(""), [headers, setHeaders] = useState(""), [env, setEnv] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const savedMetered = !!server?.setup.configuredFields.includes(flightawarePolicy.METERED_MARKER);
  const [meteredConsent, setMeteredConsent] = useState(savedMetered), [meteredChanged, setMeteredChanged] = useState(false);
  useEffect(() => { setMeteredConsent(savedMetered); setMeteredChanged(false); }, [server?.id, savedMetered]);
  const [accessToken, setAccessToken] = useState("");
  const [clientRequired, setClientRequired] = useState(initialServer?.lastCheck?.errorCode === "MCP_OAUTH_CLIENT_REQUIRED");
  const [credentialsOpen, setCredentialsOpen] = useState(initialServer?.lastCheck?.errorCode === "MCP_OAUTH_CLIENT_REQUIRED" || recommendation?.setup === "oauth-client");
  const [clientId, setClientId] = useState(""), [clientSecret, setClientSecret] = useState(""), [oauthClient, setOAuthClient] = useState(initialServer?.auth?.kind === "oauth-client" || !initialServer && recommendation?.setup === "oauth-client");
  const [optionId, setOptionId] = useState((recommendation ? item?.options.find(value => value.transport.kind === "remote" && value.transport.protocol === "streamable-http" && mcpRemoteUrlsMatch(value.transport.url, recommendation.url)) : item?.options[0])?.id || ""), [values, setValues] = useState<Record<string,string>>({});
  const [signIn, setSignIn] = useState<McpSignIn | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  useEffect(() => { let active = true; if (oauthClient) void getMcpOAuthInfo().then(value => { if (active) setRedirectUri(value.redirectUri); }).catch(error => { if (active) setError(formatMcpError(error, t)); }); return () => { active = false; }; }, [oauthClient]);
  const [version, setVersion] = useState(latest?.version || initialServer?.availableUpdate || "");
  const [latestEntry, setLatestEntry] = useState(latest), [checkingUpdate, setCheckingUpdate] = useState(false), [updateError, setUpdateError] = useState("");
  const mounted = useRef(true), signInRef = useRef(signIn); signInRef.current = signIn;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const pending = signInRef.current; if (pending && !["completed", "authorized", "cancelled", "failed", "expired"].includes(pending.status || pending.phase || "")) void cancelMcpSignIn(pending.signInId).catch(() => {}); }; }, []);
  const registryName = server?.source.kind === "registry" ? server.source.registryName : null;
  const installedVersion = server?.source.kind === "registry" ? server.source.version : null;
  const checkUpdates = async (signal?: AbortSignal) => {
    if (!registryName) return;
    setCheckingUpdate(true); setUpdateError("");
    try {
      const page = await searchMcpRegistry(registryName, undefined, signal);
      if (!mounted.current || signal?.aborted) return;
      const found = page.items.find(value => value.registryName === registryName);
      if (!found) { setUpdateError(formatMcpError({ code: "MCP_REGISTRY_ENTRY_UNAVAILABLE" }, t)); return; }
      setLatestEntry(found); onLatest?.(found);
      if (found.version !== installedVersion) setVersion(previous => previous || found.version);
    } catch (error) { if (mounted.current && !signal?.aborted) setUpdateError(formatMcpError(error, t)); }
    finally { if (mounted.current && !signal?.aborted) setCheckingUpdate(false); }
  };
  useEffect(() => { const controller = new AbortController(); void checkUpdates(controller.signal); return () => controller.abort(); }, [registryName, installedVersion]);
  const option = item?.options.find(value => value.id === optionId);
  const clearValues = () => { setValues(previous => Object.fromEntries(Object.entries(previous).filter(([name]) => option?.fields.some(field => `${field.location}:${field.name}` === name && !field.secret && ["argument", "variable"].includes(field.location))))); setAccessToken(""); setHeaders(""); setEnv(""); setClientSecret(""); setClientId(""); setConfig(""); setShowSecrets(false); setMeteredChanged(false); };
  const accept = (result: McpMutation) => { if (!mounted.current) return; setServer(result.server); setEditing(false); try { onUnstage?.(); } catch { setError(tr("flow.storageError")); } onChanged(); if (result.server.status === "ready") onReady?.(result.server); };
  const signin = async (id: string) => {
    const result = await startMcpSignIn(id); if (!mounted.current) { void cancelMcpSignIn(result.signInId).catch(() => {}); return; }
    setClientRequired(false);
    setSignIn(result);
    const href = result.authorizationUrl || result.url; if (href && /^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
  };
  useEffect(() => {
    if (!signIn || ["completed", "authorized", "cancelled", "failed", "expired"].includes(signIn.status || signIn.phase || "")) return;
    let active = true, polling = false; const timer = setInterval(() => { if (polling) return; polling = true; void getMcpSignIn(signIn.signInId).then(async result => {
      if (!active) return;
      if (["completed", "authorized"].includes(result.status || result.phase || "") && server) { setVerifying(true); try { const check = await verifyMcpConnector(server.id); if (active) accept(check); } finally { if (active) setVerifying(false); } }
      if (active) setSignIn(result);
    }).catch(error => { if (active) setError(formatMcpError(error, t)); }).finally(() => { polling = false; }); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [signIn?.signInId, signIn?.status, signIn?.phase, server?.id]);
  const act = async (action: () => Promise<void>) => { if (actionLock.current) return; actionLock.current = true; setBusy(true); setError(""); try { await action(); } catch (error) { if (mounted.current) { if ((error as { code?: string })?.code === "MCP_OAUTH_CLIENT_REQUIRED") { setClientRequired(true); setCredentialsOpen(true); } setError((error as Error)?.message === "INVALID_JSON" || error instanceof SyntaxError || (error as { code?: string })?.code === "MCP_IMPORT_INVALID" ? tr("invalidJson") : formatMcpError(error, t)); } } finally { actionLock.current = false; if (mounted.current) setBusy(false); } };
  const checkDesktop = () => act(async () => {
    const snapshot = await listMcpConnectors();
    const current = server ? snapshot.servers.find(value => value.id === server.id) : snapshot.servers.find(isFigmaDesktopConnector);
    if (server && !current) throw { code: "MCP_SERVER_NOT_FOUND" };
    if (current) {
      if (!isFigmaDesktopConnector(current)) throw { code: "MCP_REGISTRY_REVISION_CONFLICT" };
      accept(current.status === "disabled"
        ? await rebindMcpConnector(current.id, current.transport, snapshot.revision)
        : await verifyMcpConnector(current.id));
    } else {
      accept(await addMcpConnector({ source: { kind: "custom" }, name: tr("figmaDesktop.name"),
        option: { kind: "remote", protocol: "streamable-http", url: FIGMA_DESKTOP_URL }, expectedRevision: snapshot.revision }));
    }
  });
  const fieldValues = (): McpFields => {
    const fields: McpFields = mcpFieldsFromInputs({ env, headers, definitions: setupFields, values, includeDefaults: !server });
    if (!server && recommendation?.defaults?.env) fields.env = { ...recommendation.defaults.env, ...fields.env };
    if (isRemote && accessToken.trim()) {
      const token = accessToken.trim().replace(/^Bearer[ \t]+/i, "");
      if (!/^[\x21-\x7e]{1,16384}$/u.test(token)) throw Object.assign(new Error("MCP_SECRET_INVALID"), { code: "MCP_SECRET_INVALID" });
      fields.headers = Object.fromEntries([...Object.entries(fields.headers || {}).filter(([key]) => key.toLowerCase() !== "authorization"), ["Authorization", `Bearer ${token}`]]);
    }
    if (oauthClient && (!accessToken.trim() || clientId.trim()) && (!server || clientId.trim() || clientSecret)) fields.oauthClient = { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) };
    if (flightaware && (!server || meteredChanged)) fields.env = { ...fields.env, [flightawarePolicy.METERED_FIELD]: meteredConsent ? flightawarePolicy.METERED_ENABLED : flightawarePolicy.METERED_DISABLED };
    return fields;
  };
  const save = () => act(async () => {
    if (recommendation?.setup === "restricted") return;
    if (recommendationMissingSetup) throw Object.assign(new Error("MCP_SETUP_REQUIRED"), { code: "MCP_SETUP_REQUIRED" });
    const snapshot = await listMcpConnectors();
    if (!server && !item && mode === "paste") { const result = await importMcpConnectors(config, snapshot.revision); clearValues(); onChanged(); if (result.errors?.length) setError(result.errors.map(value => formatMcpError({ code: value.errorCode }, t)).join(" · ")); else onClose(); return; }
    const fields = fieldValues();
    const packageArgumentsChanged = !!presetPackage && Object.keys(fields.arguments || {}).length > 0;
    const resolvedPackage = presetPackage && (!server || packageArgumentsChanged)
      ? mcpRecommendationPackageTransport(recommendation!, fields, server?.transport) : undefined;
    // Custom package arguments are resolved into private transport configuration;
    // credentials contain only the service's encrypted credential fields.
    if (!item && presetPackage) delete fields.arguments;
    // Home Assistant uses the client's URL as its public client ID. Its auth API
    // accepts a redirect with the same host and port, without app registration.
    if (!server && recommendation?.setup === "instance" && mode === "remote" && !accessToken.trim() && !oauthClient) {
      const callback = await getMcpOAuthInfo();
      fields.oauthClient = { clientId: new URL(callback.redirectUri).origin };
    }
    if (server) {
      let result: McpMutation;
      if (repair) {
        let replacement: McpTransport;
        if (builtinQuery && presetCommand) replacement = presetCommand;
        else if (server.transport.kind === "stdio-package") replacement = resolvedPackage || server.transport;
        else if (mode === "remote") replacement = { kind: "remote", protocol: server.transport.kind === "remote" ? server.transport.protocol : "streamable-http", url };
        else { const parsed = parseMcpArguments(args); replacement = { kind: "stdio-command", command, args: parsed, cwd }; }
        result = await rebindMcpConnector(server.id, replacement, snapshot.revision);
        if (Object.keys(fields).length) result = await saveMcpCredentials(server.id, fields, result.revision);
        setRepair(false);
      } else if (packageArgumentsChanged && resolvedPackage) {
        result = await rebindMcpConnector(server.id, resolvedPackage, snapshot.revision);
        if (Object.keys(fields).length) result = await saveMcpCredentials(server.id, fields, result.revision);
      } else if (item && (Object.keys(fields.arguments || {}).length || Object.keys(fields.variables || {}).length)) {
        result = await addMcpConnector({ source: server.source, option: { id: optionId }, fields, expectedRevision: snapshot.revision });
      } else result = Object.keys(fields).length ? await saveMcpCredentials(server.id, fields, snapshot.revision) : await verifyMcpConnector(server.id);
      clearValues(); accept(result); if (result.server.status === "signedOut" && canSignIn) await signin(result.server.id); return;
    }
    let transport: McpTransport | { id: string };
    if (item) transport = { id: optionId };
    else if (presetPackage) transport = resolvedPackage!;
    else if (mode === "remote") transport = { kind: "remote", protocol: "streamable-http", url };
    else { const parsed = parseMcpArguments(args); transport = { kind: "stdio-command", command, args: parsed, cwd }; }
    const result = await addMcpConnector({ source: item ? { kind: "registry", registryName: item.registryName, version: item.version } : { kind: "custom" }, option: transport, fields, expectedRevision: snapshot.revision, ...(name.trim() ? { name: name.trim() } : {}) });
    clearValues(); accept(result); if (result.server.status === "signedOut" && canSignIn) await signin(result.server.id);
  });
  const input = (label: string, value: string, set: (value: string) => void, secret = false, multiline = false) => <label className={s.field}><span>{label}</span>{multiline ? <textarea className={secret && !showSecrets ? s.masked : undefined} rows={4} value={value} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => set(event.target.value)} /> : <input type={secret && !showSecrets ? "password" : "text"} value={value} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => set(event.target.value)} />}</label>;
  const transport = server?.transport || option?.transport || presetPackage;
  const isRemote = server && repair && server.transport.kind !== "stdio-package" ? mode === "remote" : transport ? transport.kind === "remote" : mode === "remote";
  const presetFields = recommendation?.fields || (recommendation?.envKey ? [{ name: recommendation.envKey, location: "env" as const, required: true, secret: true }] : []);
  const explicitAuthorization = presetFields.some(field => field.location === "header" && field.name.toLowerCase() === "authorization");
  const requiredCredentials: McpSetupField[] = (server?.setup.requiredFields || []).flatMap(field => {
    if (typeof field !== "string") return [];
    const match = field.match(/^(env|header):(.+)$/);
    return match ? [{ name: match[2], location: match[1] === "header" ? "header" as const : "env" as const, required: true, secret: true }] : [];
  });
  const setupFields = [...new Map([...(option?.fields || presetFields), ...requiredCredentials].map(field => [`${field.location}:${field.name}`, field])).values()]
    .filter(field => !(isRemote && !explicitAuthorization && field.location === "header" && field.name.toLowerCase() === "authorization"));
  const setupFieldLabel = (field: McpSetupField) => {
    const label = recommendation?.fields?.find(value => value.location === field.location && value.name === field.name)?.label;
    return label ? mcpRecommendationText(label, language) : field.name;
  };
  const canSignIn = !["none", "token", "api-key", "local", "endpoint"].includes(recommendation?.setup || "");
  const recommendationMissingSetup = !!recommendation && !server && (
    (isRemote && !item && !url.trim())
    || setupFields.some(field => field.required && !(values[`${field.location}:${field.name}`] ?? field.default ?? "").trim())
    || recommendation.setup === "token" && !accessToken.trim()
    || recommendation.setup === "oauth-client" && !accessToken.trim() && (!oauthClient || !clientId.trim() || recommendation.clientSecretRequired && !clientSecret.trim())
    || recommendation.setup === "local" && !presetPackage && !command.trim()
  );
  const authUrl = signIn?.authorizationUrl || signIn?.url;
  const signingIn = !!signIn && !["completed", "authorized", "cancelled", "failed", "expired"].includes(signIn.status || signIn.phase || "");
  const locked = busy || verifying || signingIn;
  const ready = server?.status === "ready";
  const preAdd = catalogEntry && !server && !added;
  const setupVisible = !preAdd && (!ready || editing || credentialsOnly);
  const needsForm = setupFields.length > 0 || ["token", "api-key", "oauth-client", "instance", "endpoint", "local"].includes(recommendation?.setup || "") || !recommendation && !item;
  const title = mcpConnectorName(figmaDesktop ? "figma" : mcpOfficialSkillBrand(server) || recommendation?.id || (server?.source.kind === "registry" ? server.source.registryName : item?.registryName), server?.name || recommendation?.name || item?.name || tr("addTitle"));
  const previewIdentity = registryName || item?.registryName;
  const previewId = figmaDesktop ? "figma-desktop" : mcpOfficialSkillBrand(server) || recommendation?.id || (previewIdentity ? mcpBrandId(previewIdentity) : undefined);
  const description = recommendation ? mcpRecommendationText(recommendation.description, language)
    : item ? registryDescription(item) : server?.source.kind === "registry" ? mcpRegistrySummary(server.source.registryName)?.description[language.startsWith("zh") ? "zh-CN" : "en"] : "";
  const add = () => act(async () => {
    // Configuration-dependent entries only join the UI list at this stage.
    // Never invent an endpoint/path or persist credentials to make them installable.
    const deferred = canChooseFigmaMode || recommendation?.setup === "local" || recommendation?.setup === "instance"
      || recommendation?.setup === "endpoint" && !url.trim()
      || setupFields.some(field => field.required && !field.default)
      || recommendation?.setup === "token" || recommendation?.setup === "oauth-client"
      || !item && !presetPackage && !presetCommand && !url.trim();
    if (deferred) {
      try { onStage?.(); } catch { setError(tr("flow.storageError")); return; }
      setAdded(true); return;
    }
    const snapshot = await listMcpConnectors();
    const transport: McpTransport | { id: string } = item ? { id: optionId } : presetPackage || presetCommand || { kind: "remote", protocol: "streamable-http", url };
    accept(await addMcpConnector({ source: item ? { kind: "registry", registryName: item.registryName, version: item.version } : { kind: "custom" },
      option: transport, expectedRevision: snapshot.revision, ...(name.trim() ? { name: name.trim() } : {}),
      ...(recommendation?.defaults?.env ? { fields: { env: recommendation.defaults.env } } : {}) }));
  });
  useEffect(() => {
    if (autoAdd && preAdd && !initialAdd.current) { initialAdd.current = true; void add(); }
  }, [autoAdd]);
  const primary = () => {
    const changed = Object.keys(values).length > 0 || !!(accessToken || headers || env || clientId || clientSecret) || meteredChanged;
    if (server?.status === "signedOut" && server.transport.kind === "remote" && canSignIn && !needsForm && !repair && !editing && !changed) return act(() => signin(server.id));
    return save();
  };
  const remove = () => act(async () => {
    if (!await confirm({ title: tr("flow.remove"), message: tr("removeConfirm"), confirmLabel: tr("flow.remove") })) return;
    if (server) { const current = await listMcpConnectors(); await removeMcpConnector(server.id, current.revision); }
    onUnstage?.(); onChanged(); onClose();
  });
  const primaryAction = <button type="button" className="btn-dark btn-sm" disabled={locked || recommendationMissingSetup || !server && !!item && (!optionId || option?.available === false)} onClick={() => void (managed && server ? act(async () => accept(await verifyMcpConnector(server.id))) : primary())}>{tr(verifying ? "flow.verifying" : signingIn ? "flow.waiting" : busy ? "working" : needsForm || editing ? "flow.saveConnect" : isRemote && canSignIn ? "flow.authorize" : "flow.checkConnect")}</button>;
  const connectionState = <span className={s.status} data-state={server?.status} role="status" aria-live="polite">{verifying ? tr("flow.verifying") : signingIn ? tr("flow.waiting") : ready ? <>{tr("flow.connected")}{server.lastCheck ? ` · ${t("mcpConnectors.toolCount", { count: server.lastCheck.toolCount })}` : ""}</> : server ? tr(`statuses.${server.status}`) : tr(preAdd ? "flow.notAdded" : added ? "flow.pending" : "flow.notAdded")}</span>;
  const footer = <div className={s.flowFooter}><p>{tr(ready ? "flow.connectedHint" : "defaultAccess")}</p><div className={s.flowFooterActions}>
    {preAdd ? <button type="button" className="btn-dark btn-sm" disabled={busy || recommendation?.setup === "restricted" || !!item && (!option || option.available === false)} onClick={() => void add()}>{tr(busy ? "working" : "add")}</button>
      : ready && !editing && !credentialsOnly ? <button type="button" className="btn-dark btn-sm" disabled={locked} onClick={onClose}>{tr("flow.done")}</button> : recommendation?.setup === "restricted" ? <button type="button" className="btn-dark btn-sm" disabled={locked} onClick={onClose}>{tr("flow.done")}</button> : figmaDesktop ? <button type="button" className="btn-dark btn-sm" disabled={locked} onClick={() => void checkDesktop()}>{tr(busy ? "figmaDesktop.checking" : server?.status === "disabled" ? "figmaDesktop.reconnect" : server ? "verify" : "figmaDesktop.connect")}</button> : primaryAction}
  </div></div>;
  const Frame = embedded ? InlineFrame : Modal;
  return <Frame open onClose={onClose} dismissible={!busy && !verifying} title={<span className={s.dialogIdentity}><McpConnectorIcon name={title} identity={item?.registryName || recommendation?.id || (server?.source.kind === "registry" ? server.source.registryName : server?.id) || "custom"} iconId={recommendation?.id || mcpOfficialSkillBrand(server) || server?.recommendationId} />{title}</span>} width={640} variant="connector" subtitle={description} footer={footer}>
    <div className={s.detail}>
      {!embedded && <ConnectorTools overview description={description} serverId={server?.id} status={server?.status} checkedAt={server?.lastCheck?.at} previewId={previewId} />}
      {preAdd ? <section className={s.connectionPanel}><div className={s.connectionHeading}><h3>{t("mcpConnectors.flow.connectionTitle", { name: title })}</h3>{connectionState}</div><p className={s.muted}>{tr("flow.addHint")}</p></section> : <>
      {ready && !editing && !credentialsOnly && <section className={s.connectionPanel}><div className={s.connectionHeading}><h3>{tr("flow.connectionStatus")}</h3>{connectionState}</div><p className={s.muted}>{tr("flow.readyHint")}</p>
        <div className={s.actions}><button type="button" className={s.textButton} disabled={locked} onClick={() => void act(async () => accept(await verifyMcpConnector(server.id)))}>{tr(busy ? figmaDesktop ? "figmaDesktop.checking" : "working" : "verify")}</button>
        {!figmaDesktop && !managed && <button type="button" className={s.textButton} disabled={locked} aria-expanded={editing} onClick={() => setEditing(value => !value)}>{tr("flow.configure")}</button>}</div>
      </section>}
      {setupVisible && <section className={s.connectionPanel}><div className={s.connectionHeading}><h3>{t("mcpConnectors.flow.connectionTitle", { name: title })}</h3>{connectionState}</div>
      {added && !server && <p className={s.muted}>{tr("flow.pendingHint")}</p>}
      {canChooseFigmaMode && <div className={s.modeTabs} role="group" aria-label={tr("figmaDesktop.connectionMode")}>
        {(["desktop", "remote"] as const).map(value => <button type="button" key={value} className={figmaMode === value ? "btn-dark btn-sm" : "btn-secondary btn-sm"} aria-pressed={figmaMode === value} disabled={locked} onClick={() => { setFigmaMode(value); setError(""); clearValues(); }}>{tr(`figmaDesktop.${value}`)}</button>)}
      </div>}
      {figmaDesktop ? <section className={s.desktopConnection} aria-label={tr("figmaDesktop.desktop")}>
        {server?.status === "failed" && <p className={s.notice}>{tr("figmaDesktop.failedHint")}</p>}
        <p>{tr("figmaDesktop.description")}</p><p className={s.muted}>{tr(server?.status === "disabled" ? "figmaDesktop.disabledHint" : "figmaDesktop.setupHint")}</p>
        <details className={s.clientSetup} open={desktopStepsOpen} onToggle={event => setDesktopStepsOpen(event.currentTarget.open)}><summary>{tr("figmaDesktop.setupTitle")}</summary>
          <ol><li>{tr("figmaDesktop.stepOpen")}</li><li>{tr("figmaDesktop.stepEnable")}</li><li>{tr("figmaDesktop.stepCheck")}</li></ol>
          <a href="https://developers.figma.com/docs/figma-mcp-server/local-server-installation/" target="_blank" rel="noreferrer">{tr("figmaDesktop.guide")}</a>
        </details>
        {embedded && <div className={s.actions}><button type="button" className="btn-dark btn-sm" disabled={locked} onClick={() => void checkDesktop()}>{tr(busy ? "figmaDesktop.checking" : server?.status === "disabled" ? "figmaDesktop.reconnect" : server ? "verify" : "figmaDesktop.connect")}</button></div>}
      </section> : recommendation?.setup === "restricted" ? <p className={s.notice}>{recommendation.note && mcpRecommendationText(recommendation.note, language)}</p> : <>
      {canChooseFigmaMode && <p className={s.muted}>{tr("figmaDesktop.remoteHint")}</p>}
      {recommendation?.note && <p className={s.notice}>{mcpRecommendationText(recommendation.note, language)}</p>}
      {recommendation?.setupSteps && <ol className={s.setupSteps}>{recommendation.setupSteps.map((step, index) => <li key={index}>{mcpRecommendationText(step, language)}</li>)}</ol>}
      {server && ["failed", "needsSetup", "disabled"].includes(server.status) && <p className={s.notice}>{tr("failedHint")}{server.lastCheck?.errorCode && !clientRequired && <span> {formatMcpError({ code: server.lastCheck.errorCode }, t)}</span>}</p>}
      {clientRequired && !error && server?.status !== "ready" && <p className={s.notice}>{tr("errors.client")}</p>}
      {!managed && setupFields.length > 0 && <div className={s.fields}>{setupFields.map(field => <label key={`${field.location}:${field.name}`} className={s.field}><span>{setupFieldLabel(field)}{field.required ? " *" : ""}</span><input autoComplete="off" spellCheck={false} type={field.secret && !showSecrets ? "password" : "text"} required={field.required} disabled={locked} value={values[`${field.location}:${field.name}`] ?? (!server ? field.default : undefined) ?? ""} onChange={event => setValues(current => ({ ...current, [`${field.location}:${field.name}`]: event.target.value }))} /><small>{field.description}</small></label>)}</div>}
      {!builtinQuery && recommendation?.setup === "local" && !presetPackage && (!server || repair) && input(tr("commandLabel"), command, setCommand)}
      {!managed && recommendation?.setup === "token" && !explicitAuthorization && input(tr(!server ? "accessTokenRequired" : "accessToken"), accessToken, setAccessToken, true)}
      {!server && !item && (!!recommendation?.endpoints?.length || ["instance", "endpoint"].includes(recommendation?.setup || "")) && (recommendation?.endpoints?.length
        ? <label className={s.field}><span>{tr("url")}</span><select value={url} disabled={locked} onChange={event => setUrl(event.target.value)}>{recommendation.endpoints.map(endpoint => <option key={endpoint.url} value={endpoint.url}>{mcpRecommendationText(endpoint.label, language)}</option>)}</select></label>
        : input(tr(recommendation?.setup === "instance" ? "instanceUrl" : "url"), url, setUrl))}
      {flightaware && !managed && !credentialsOnly && <><label className={s.choice}><input type="checkbox" checked={meteredConsent} disabled={locked} onChange={event => { setMeteredConsent(event.target.checked); setMeteredChanged(true); }} /><span>{tr("flightawareMetered")}</span></label><p className={s.notice}>{tr("flightawareMeteredHint")}</p></>}
      {!managed && <details className={s.clientSetup} open={(!recommendation && !item && !server) || repair || credentialsOpen || undefined} onToggle={event => setCredentialsOpen(event.currentTarget.open)}><summary>{tr("flow.advanced")}</summary>
        {item && <><p className={s.muted}>{item.registryName} · {tr("version")} {item.version}</p>{!server && <label className={s.field}><span>{tr("transport")}</span><select value={optionId} onChange={event => { setOptionId(event.target.value); setValues({}); setAccessToken(""); }} disabled={locked}>{item.options.map(value => <option key={value.id} value={value.id} disabled={value.available === false}>{value.transport.kind === "remote" ? value.transport.url : value.transport.kind === "stdio-package" ? `${value.transport.registryType} · ${value.transport.identifier}@${value.transport.version}` : value.transport.command}</option>)}</select></label>}</>}
        {!builtinQuery && !server && !item && input(tr("name"), name, setName)}
        {!builtinQuery && (!server && !item && !presetPackage || server && repair && server.transport.kind !== "stdio-package") && <>
          {<div className={s.modeTabs}>{(["remote", "command", "paste"] as const).filter(value => recommendation?.setup === "local" ? value === "command" : !server || value !== "paste").map(value => <button type="button" key={value} disabled={locked} aria-pressed={mode === value} className={mode === value ? "btn-dark btn-sm" : "btn-secondary btn-sm"} onClick={() => { setMode(value); setAccessToken(""); }}>{tr(value)}</button>)}</div>}
          {mode === "remote" && !(recommendation && ["instance", "endpoint"].includes(recommendation.setup || "") && !server) && input(tr("url"), url, setUrl)}
          {mode === "command" && <>{recommendation?.setup !== "local" && input(tr("commandLabel"), command, setCommand)}{input(tr("args"), args, setArgs, false, true)}{input(tr("cwd"), cwd, setCwd)}</>}
          {mode === "paste" && input(tr("config"), config, setConfig, true, true)}
        </>}
        {transport?.kind === "stdio-package" && <p><code>{transport.registryType} · {transport.identifier} · {transport.version}</code></p>}
        {!builtinQuery && !credentialsOnly && server?.source.kind === "custom" && <label className={s.choice}><input type="checkbox" checked={repair} disabled={locked || server.status === "disabled"} onChange={event => setRepair(event.target.checked)} /><span>{tr("repair")}</span></label>}
        {isRemote && !explicitAuthorization && recommendation?.setup !== "token" && <>{input(tr("accessToken"), accessToken, setAccessToken, true)}<p className={s.muted}>{tr("accessTokenHint")}</p></>}
        {!builtinQuery && <>{input(tr("headers"), headers, setHeaders, true, true)}{input(tr("env"), env, setEnv, true, true)}</>}
        {isRemote && <><label className={s.choice}><input type="checkbox" disabled={locked} checked={oauthClient} onChange={event => setOAuthClient(event.target.checked)} /><span>{tr("oauthClient")}</span></label>
        {oauthClient && <>{input(tr("clientId"), clientId, setClientId)}{input(tr(recommendation?.clientSecretRequired ? "clientSecretRequired" : "clientSecret"), clientSecret, setClientSecret, true)}</>}</>}
      </details>}
      {!builtinQuery && !managed && (transport && transport.kind !== "remote" || !server && !item && mode === "command") && <p className={s.notice}>{tr("localWarning")} {!recommendation && tr("trustedCommand")}</p>}
      {!managed && (needsForm || credentialsOpen) && <><p className={s.muted}>{tr("secretsHint")}</p><button type="button" className={s.textButton} aria-pressed={showSecrets} onClick={() => setShowSecrets(value => !value)}>{tr(showSecrets ? "hideValue" : "showValue")}</button></>}
      {(signIn?.redirectUri || oauthClient && redirectUri) && <p className={s.muted}>{tr("callbackHint")} <code>{signIn?.redirectUri || redirectUri}</code></p>}
      {signIn?.flow === "device" && signIn.userCode && signingIn && <div className={s.notice} role="status"><p>{tr("deviceCodeHint")}</p><p><code data-device-user-code>{signIn.userCode}</code></p><p className={s.muted}>{tr("deviceWaiting")}{signIn.expiresAt ? ` · ${t("mcpConnectors.expires", { time: new Date(signIn.expiresAt).toLocaleTimeString() })}` : ""}</p></div>}
      {authUrl && /^https?:\/\//i.test(authUrl) && signingIn && <p><a href={authUrl} target="_blank" rel="noreferrer">{tr("openSignin")}</a> <button className={s.textButton} type="button" disabled={busy || verifying} onClick={() => void act(async () => { await cancelMcpSignIn(signIn!.signInId); setSignIn(null); })}>{tr("cancelSignin")}</button></p>}
      {signIn?.installationUrl && /^https:\/\//i.test(signIn.installationUrl) && <p><a href={signIn.installationUrl} target="_blank" rel="noreferrer">{tr("chooseRepositories")}</a><small className={s.muted}> {tr("repositoryAccessHint")}</small></p>}
      {embedded && <p className={s.muted}>{tr("defaultAccess")}</p>}
      <div className={s.actions}>
        {embedded && primaryAction}
        {editing && <button type="button" className={s.textButton} disabled={locked} onClick={() => setEditing(false)}>{t("common.cancel")}</button>}
        {clientRequired && server?.auth?.kind !== "oauth-client" && <button className="btn-secondary btn-sm" type="button" disabled={locked} onClick={() => { setCredentialsOpen(true); setOAuthClient(true); }}>{tr("configureOAuth")}</button>}
      </div>
      </>}
      </section>}
      {server && !credentialsOnly && <>
        <details className={s.management}><summary>{tr("flow.manage")}</summary>
          {figmaDesktop && ready && <details className={s.clientSetup} open={desktopStepsOpen} onToggle={event => setDesktopStepsOpen(event.currentTarget.open)}><summary>{tr("figmaDesktop.setupTitle")}</summary><ol><li>{tr("figmaDesktop.stepOpen")}</li><li>{tr("figmaDesktop.stepEnable")}</li><li>{tr("figmaDesktop.stepCheck")}</li></ol></details>}
          {server.transport.kind === "remote" && !figmaDesktop && canSignIn && <button type="button" className="btn-secondary btn-sm" disabled={locked} onClick={() => { setEditing(true); void act(() => signin(server.id)); }}>{tr("flow.reconnect")}</button>}
          <p className={s.muted}>{tr("currentTransport")} <code>{server.transport.kind === "remote" ? server.transport.url : server.transport.kind === "stdio-package" ? `${server.transport.identifier}@${server.transport.version}` : server.transport.command}</code></p>
          {server.source.kind === "registry" && <section className={s.updatePanel}><h3>{tr("update")}</h3><p className={s.muted}>{tr("installedVersion")} <strong>{server.source.version}</strong> · {server.source.registryName}</p>
            {latestEntry && <><p className={latestEntry.version !== server.source.version ? s.updateHint : s.muted}>{latestEntry.version !== server.source.version ? t("mcpConnectors.updateAvailable", { version: latestEntry.version }) : tr("upToDate")}</p><p className={s.muted}>{registryDescription(latestEntry)}</p>{latestEntry.repositoryUrl && /^https:\/\//i.test(latestEntry.repositoryUrl) && <a href={latestEntry.repositoryUrl} target="_blank" rel="noreferrer">{tr("repository")}</a>}<p className={s.muted}>{tr("targetTransport")} {latestEntry.options.map(option => option.transport.kind === "stdio-package" ? `${option.transport.registryType} · ${option.transport.identifier}@${option.transport.version}` : option.transport.kind === "remote" ? option.transport.url : option.transport.command).join(" · ")}</p></>}
            <button className={s.textButton} type="button" disabled={locked || checkingUpdate} onClick={() => void checkUpdates()}>{tr(checkingUpdate ? "loading" : "checkUpdates")}</button>{updateError && <p className={s.error} role="alert">{updateError}</p>}<p className={s.muted}>{tr("manualUpdateHint")}</p>{input(tr("newVersion"), version, setVersion)}<button className="btn-secondary btn-sm" disabled={locked || !version.trim() || version.trim() === server.source.version} type="button" onClick={() => void act(async () => { const current = await listMcpConnectors(); accept(await updateMcpConnector(server.id, version.trim(), current.revision)); })}>{tr("update")}</button>
          </section>}
          {!managed && !credentialsOnly && <button type="button" className="btn-danger btn-sm" disabled={locked} onClick={() => void remove()}>{tr("flow.remove")}</button>}
        </details>
      </>}
      {!server && added && !managed && !credentialsOnly && <details className={s.management}><summary>{tr("flow.manage")}</summary><button type="button" className="btn-danger btn-sm" disabled={locked} onClick={() => void remove()}>{tr("flow.remove")}</button></details>}
      </>}
      {!embedded && (recommendation?.docsUrl || item?.repositoryUrl) && <details className={s.management}><summary>{tr("flow.help")}</summary>{recommendation?.docsUrl ? <a href={recommendation.docsUrl} target="_blank" rel="noreferrer">{tr("officialGuide")}</a> : item?.repositoryUrl && /^https:\/\//i.test(item.repositoryUrl) && <a href={item.repositoryUrl} target="_blank" rel="noreferrer">{tr("repository")}</a>}</details>}
      {(error || signIn?.errorCode) && <p className={s.error} role="alert">{error || formatMcpError({ code: signIn?.errorCode }, t)}</p>}
    </div>
  </Frame>;
}
