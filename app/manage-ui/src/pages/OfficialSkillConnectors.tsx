import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeOfficialConnector, getOfficialConnectors, officialAccount, officialConnectorErrorKey, OFFICIAL_CONNECTORS_CHANGE_EVENT, type OfficialConnectorId, type OfficialAccountStatus } from "../api/officialSkillConnectors";
import { listMcpConnectors, saveMcpCredentials, type McpServer } from "../api/mcpConnectors";
import { usePageCache } from "../lib/usePageCache";
import { mcpRecommendationText, type McpRecommendation } from "../lib/mcpConnectorUi";
import { mcpConnectorName } from "../lib/mcpRecommendationCatalog";
import ConnectorTools from "../components/ConnectorTools";
import McpConnectorIcon from "../components/McpConnectorIcon";
import Modal from "../components/Modal";
import { useConfirm } from "../components/ui";
import McpConnectorDialog from "./McpConnectorDialog";
import catalog from "../../../agent-service/data/official-skill-connectors.json";
import s from "./ConnectorsPage.module.css";

type Text = { "zh-CN": string; en: string };
export interface OfficialConnectorDefinition { id: OfficialConnectorId; name: string; description: Text; docsUrl: string; accessUrl?: string; version: string; fields: Array<{ name: string; required: boolean; secret: boolean; label: Text }>; note: Text }
export const officialConnectorDefinitions = catalog.map(definition => ({ ...definition, name: mcpConnectorName(definition.id, definition.name) })) as OfficialConnectorDefinition[];
export function useOfficialSkillConnectors() {
  const cache = usePageCache("official-skill-connectors", getOfficialConnectors);
  const [pending, setPending] = useState<OfficialConnectorId | null>(null), [actionError, setActionError] = useState<{ id: OfficialConnectorId; key: string } | null>(null);
  const locked = useRef(false);
  const busy = !!pending || !!cache.data?.items.some(item => ["installing", "removing"].includes(item.state));
  useEffect(() => { const changed = () => void cache.refresh(); window.addEventListener(OFFICIAL_CONNECTORS_CHANGE_EVENT, changed); return () => window.removeEventListener(OFFICIAL_CONNECTORS_CHANGE_EVENT, changed); }, [cache.refresh]);
  useEffect(() => { if (!busy) return; const timer = setInterval(() => void cache.refresh(), 1000); return () => clearInterval(timer); }, [busy, cache.refresh]);
  const change = async (id: OfficialConnectorId, action: "install" | "remove") => {
    const current = cache.data?.items.find(item => item.id === id);
    if (!current || locked.current || busy) return;
    locked.current = true; setPending(id); setActionError(null);
    try {
      await changeOfficialConnector(id, action, current.revision);
    } catch (error) { setActionError({ id, key: officialConnectorErrorKey(error) }); }
    finally { locked.current = false; setPending(null); await cache.refresh(); }
  };
  return { ...cache, busy, pending, actionError, change };
}
type Model = ReturnType<typeof useOfficialSkillConnectors>;
export function OfficialSkillRecommendation({ definition, model, onOpen, onAdd }: { definition: OfficialConnectorDefinition; model: Model; onOpen: () => void; onAdd?: () => void }) {
  const { t, i18n } = useTranslation(); const data = model.data?.items.find(item => item.id === definition.id);
  return <div className={s.service} data-official-recommendation={definition.id}>
    <button type="button" className={s.serviceOpen} onClick={onOpen}><McpConnectorIcon name={definition.name} identity={definition.id} />
      <span className={s.serviceText}><strong>{definition.name}</strong><small>{mcpRecommendationText(definition.description, i18n.resolvedLanguage || i18n.language)}</small></span></button>
    {!data?.canRemove && <button type="button" className={s.button} disabled={model.busy || !data || !!model.error} onClick={onAdd || onOpen}>{t("mcpConnectors.add")}</button>}
  </div>;
}
export function OfficialSkillInstalledRows({ model, servers, onOpen }: { model: Model; servers?: McpServer[]; onOpen: (id: OfficialConnectorId) => void }) {
  const { t } = useTranslation();
  return <>{model.data?.items.filter(item => item.canRemove).map(item => {
    const definition = officialConnectorDefinitions.find(value => value.id === item.id)!;
    const ready = item.state === "installed" && servers?.some(server => server.id === item.serverId && server.status === "ready");
    return <li key={item.id} className={s.installedItem} data-official-installed={item.id}>
      <button type="button" className={s.installedOpen} aria-label={`${t("mcpConnectors.manage")} ${definition.name}`} onClick={() => onOpen(item.id)}>
        <McpConnectorIcon name={definition.name} identity={item.id} />
        <span className={s.installedLabel}><strong>{definition.name}</strong>{!ready && <small className={s.connectionHint}>{t("mcpConnectors.flow.notConnected")}</small>}</span>
      </button></li>;
  })}</>;
}

export default function OfficialSkillDialog({ id, model, onClose, onChanged }: { id: OfficialConnectorId; model: Model; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation(), confirm = useConfirm(); const tr = (key: string) => t(`officialConnectors.${key}`);
  const definition = officialConnectorDefinitions.find(value => value.id === id)!;
  const serviceOnly = id === "fliggy" || id === "baidu-maps";
  const data = model.data?.items.find(item => item.id === id), installed = data?.state === "installed";
  const language = i18n.resolvedLanguage || i18n.language;
  const [values, setValues] = useState<Record<string, string>>({}), [code, setCode] = useState(""), [working, setWorking] = useState(false), [checking, setChecking] = useState(false);
  const [serviceCheckFailed, setServiceCheckFailed] = useState(false);
  const [authorizationQr, setAuthorizationQr] = useState<string | null>(null);
  const [codeFocused, setCodeFocused] = useState(false);
  const [account, setAccount] = useState<OfficialAccountStatus | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [server, setServer] = useState<McpServer | null>(null), [showTools, setShowTools] = useState(false);
  const [toolsRevision, setToolsRevision] = useState(0);
  const mounted = useRef(true), locked = useRef(false);
  const accountEpoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { accountEpoch.current++; setAccount(null); setChecking(false); setServiceCheckFailed(false); setError(""); setNotice(""); setCodeFocused(false); if (id === "quark-drive") setCode(""); }, [id, data?.revision]);
  useEffect(() => {
    let current = true;
    setAuthorizationQr(null);
    if (id === "meituan-paotui" && account?.state === "authorizing" && account.verificationUrl && !account.qrCode) {
      const url = account.verificationUrl;
      // The official auth_link opens the Meituan app rather than a desktop
      // page. Encode it locally; never send the authorization link elsewhere.
      void import("qrcode-generator").then(({ default: qrcode }) => {
        const qr = qrcode(0, "M"); qr.addData(url); qr.make();
        if (current) setAuthorizationQr(qr.createDataURL(6, 24));
      }).catch(() => {});
    }
    return () => { current = false; };
  }, [id, account?.state, account?.verificationUrl, account?.qrCode]);
  useEffect(() => {
    let current = true;
    const epoch = accountEpoch.current;
    setServer(null);
    if (serviceOnly && installed && data?.serverId) {
      // Read saved-field metadata only. Listing MCP tools does not prove that
      // the provider accepts the credential, and opening must not spend quota.
      void listMcpConnectors().then(snapshot => {
        if (current && mounted.current && epoch === accountEpoch.current) setServer(snapshot.servers.find(value => value.id === data.serverId) || null);
      }).catch(() => {});
    }
    return () => { current = false; };
  }, [id, installed, data?.serverId, data?.revision, toolsRevision]);
  const toolsChanged = () => {
    accountEpoch.current++;
    setToolsRevision(value => value + 1);
    if (mounted.current) { setAccount(null); setChecking(false); setServiceCheckFailed(false); setError(""); setNotice(""); }
    onChanged();
  };
  const act = async (operation: () => Promise<void>) => {
    if (locked.current || model.busy) return; locked.current = true; setWorking(true); setError(""); setNotice("");
    try { await operation(); } catch (error) { if (mounted.current) setError(tr(`errors.${officialConnectorErrorKey(error)}`)); }
    finally { locked.current = false; if (mounted.current) { setWorking(false); setChecking(false); } }
  };
  const accountAction = (action: "status" | "start" | "bind" | "logout") => act(async () => {
    if (!data) return;
    if (action === "logout" && !await confirm({ title: tr("logout"), message: tr("logoutConfirm"), confirmLabel: tr("logout") })) return;
    const retainPending = id === "quark-drive" && action === "status" && account?.state === "authorizing";
    if (!retainPending) setAccount(null);
    const epoch = ++accountEpoch.current;
    const authorizationCode = action === "bind" ? code.trim() : undefined;
    if (["doordash", "quark-drive"].includes(id) && action === "bind") setCode("");
    if (serviceOnly && action === "status") { setChecking(true); setServiceCheckFailed(false); }
    const result = await officialAccount(id, data.revision, action, authorizationCode).catch(error => {
      if (serviceOnly && mounted.current && epoch === accountEpoch.current) setServiceCheckFailed(true);
      if (retainPending && mounted.current && epoch === accountEpoch.current) setAccount(null);
      throw error;
    }).finally(() => { if (mounted.current && epoch === accountEpoch.current) setChecking(false); });
    if (mounted.current && epoch === accountEpoch.current) {
      setAccount(result);
      if (!(retainPending && result.state === "authorizing")) setCode("");
      if (result.errorCode) setError(tr(`errors.${officialConnectorErrorKey({ code: result.errorCode })}`));
    }
    onChanged();
  });
  useEffect(() => {
    if (!["shop", "quark-drive", "rollinggo-hotel"].includes(id) || account?.state !== "authorizing" || working || model.busy
      || id === "quark-drive" && (codeFocused || code.length > 0)) return;
    const timer = setTimeout(() => void accountAction("status"), 5000);
    return () => clearTimeout(timer);
  }, [id, account, working, model.busy, data?.revision, code, codeFocused]);
  const save = () => act(async () => {
    if (!data?.serverId) return;
    const epoch = ++accountEpoch.current; setAccount(null);
    if (serviceOnly) { setChecking(true); setServiceCheckFailed(false); }
    const snapshot = await listMcpConnectors();
    const credentials = Object.entries(values).filter(([, value]) => value.trim()).map(([name, value]) => [name, id === "netease-music" ? value.trim() : value]);
    const result = await saveMcpCredentials(data.serverId, { env: Object.fromEntries(credentials) }, snapshot.revision);
    if (mounted.current) setServer(result.server);
    if (mounted.current) { setValues({}); setNotice(tr(id === "fliggy" ? "fliggySavedCredentials" : id === "netease-music" ? "neteaseSavedCredentials" : "savedCredentials")); }
    if (serviceOnly && mounted.current && epoch === accountEpoch.current) {
      setChecking(true);
      try {
        const checked = await officialAccount(id, data.revision, "status").catch(error => {
          if (mounted.current && epoch === accountEpoch.current) setServiceCheckFailed(true);
          throw error;
        });
        if (mounted.current && epoch === accountEpoch.current) { setAccount(checked); if (checked.errorCode) setError(tr(`errors.${officialConnectorErrorKey({ code: checked.errorCode })}`)); }
      } finally { if (mounted.current && epoch === accountEpoch.current) setChecking(false); }
    }
    onChanged();
  });
  const toolSettings = () => act(async () => {
    const snapshot = await listMcpConnectors(); const found = snapshot.servers.find(value => value.id === data?.serverId);
    if (!found) throw { code: "OFFICIAL_CONNECTOR_UNAVAILABLE" };
    if (mounted.current) { setServer(found); setShowTools(true); }
  });
  const recommendation: McpRecommendation = { ...definition, setup: "local", fields: definition.fields.map(field => ({ ...field, location: "env" })) };
  const busy = working || model.busy;
  const installationError = model.actionError?.id === id ? model.actionError.key : data?.errorCode ? officialConnectorErrorKey({ code: data.errorCode }) : null;
  const supportsLogin = ["doordash", "shop", "quark-drive", "rollinggo-hotel", "meituan-paotui", "alipay", "netease-music"].includes(id);
  const credentialsDirty = Object.values(values).some(value => value.trim());
  const accountReady = account?.state === "ready";
  const credentialsSaved = definition.fields.some(field => server?.setup?.configuredFields.includes(`env:${field.name}`));
  const requiredCredentialsMissing = server?.setup && definition.fields.some(field => field.required && !server.setup.configuredFields.includes(`env:${field.name}`));
  const serviceStatus = checking ? "serviceChecking" : accountReady ? "serviceReady"
    : account?.state === "signedOut" ? "serviceNeedsCredentials" : serviceCheckFailed || account?.errorCode ? "serviceCheckFailed"
      : requiredCredentialsMissing ? "serviceNeedsCredentials" : "serviceUnknown";
  const footer = <div className={s.flowFooter}><p>{t(accountReady ? "mcpConnectors.flow.connectedHint" : "mcpConnectors.defaultAccess")}</p><div className={s.flowFooterActions}>
    {!installed ? <button type="button" className={s.primary} disabled={busy || !data || !!model.error} onClick={() => void model.change(id, "install")}>{data?.canRemove ? tr("repair") : t("mcpConnectors.add")}</button> : <>
      {definition.fields.length > 0 && <button type="button" className={credentialsDirty || !supportsLogin && !accountReady ? s.primary : s.button} disabled={busy || !credentialsDirty} onClick={() => void save()}>{t("mcpConnectors.flow.saveConnect")}</button>}
      {supportsLogin && <button type="button" className={!credentialsDirty && !accountReady ? s.primary : s.button} disabled={busy} onClick={() => void accountAction("start")}>{t(accountReady ? "mcpConnectors.flow.reconnect" : "mcpConnectors.flow.authorize")}</button>}
      {accountReady && <button type="button" className={s.primary} disabled={busy} onClick={onClose}>{t("mcpConnectors.flow.done")}</button>}
    </>}
    {!accountReady && <button type="button" className={s.button} disabled={busy} onClick={onClose}>{tr("close")}</button>}
  </div></div>;
  return <Modal open title={<span className={s.dialogIdentity}><McpConnectorIcon name={definition.name} identity={id} />{definition.name}</span>} width={640} variant="connector" subtitle={mcpRecommendationText(definition.description, language)} footer={footer} onClose={onClose} dismissible={!busy}>
    <div className={s.detail}>
      <ConnectorTools overview description={mcpRecommendationText(definition.description, language)} serverId={data?.serverId || undefined} status={server?.status} checkedAt={server?.lastCheck?.at} previewId={id} refreshKey={`${data?.revision}:${toolsRevision}`} />
      {!installed && <section className={s.connectionPanel}><div className={s.connectionHeading}><h3>{t("mcpConnectors.flow.connectionTitle", { name: definition.name })}</h3><span className={s.status}>{tr(data?.stage ? `stages.${data.stage}` : `states.${data?.state || "notInstalled"}`)}</span></div><p className={s.muted}>{t("mcpConnectors.flow.addHint")}</p></section>}
      {model.loading && !data && <p role="status">{tr("loading")}</p>}
      {model.error && <p className={s.error} role="alert">{tr("loadFailed")} <button className={s.textButton} onClick={() => void model.refresh()}>{tr("retry")}</button></p>}
      {installationError && <p className={s.error} role="alert">{tr(`errors.${installationError}`)}</p>}
      {installed && <section className={s.connectionPanel}>
        <h3>{t("mcpConnectors.flow.connectionTitle", { name: definition.name })}</h3><p className={s.muted}>{tr("localHint")}</p>
        {definition.fields.length > 0 && <details className={s.clientSetup} open={!accountReady || undefined}><summary>{t("mcpConnectors.flow.configure")}</summary><div className={s.fields}>{definition.fields.map(field => <label className={s.field} key={field.name}><span>{mcpRecommendationText(field.label, language)}{field.required ? " *" : ""}</span>{field.name === "NCM_PRIVATE_KEY" ? <textarea className={s.masked} rows={4} autoComplete="off" spellCheck={false} disabled={busy} value={values[field.name] || ""} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} /> : <input autoComplete="off" spellCheck={false} type={field.secret ? "password" : "text"} placeholder={serviceOnly && server?.setup?.configuredFields.includes(`env:${field.name}`) ? tr("credentialSavedPlaceholder") : undefined} disabled={busy} value={values[field.name] || ""} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} />}</label>)}</div><p className={s.muted}>{tr(serviceOnly && credentialsSaved ? "credentialSavedHint" : "credentialHint")}</p></details>}
        <p className={s.status} role="status">{tr(serviceOnly ? serviceStatus : `accountStates.${account?.state || "unknown"}`)}{account?.userName ? ` · ${account.userName}` : ""}</p>
        {account?.qrCode && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(account.qrCode) && account.qrCode.length < 350000 && <img src={account.qrCode} alt={tr("open")} width={192} height={192} />}
        {id === "meituan-paotui" && account?.state === "authorizing" && authorizationQr && <img src={authorizationQr} alt={tr("meituanScan")} width={192} height={192} />}
        {id === "meituan-paotui" && account?.state === "authorizing" && <p className={s.muted}>{tr("meituanAuthorizationHint")}</p>}
        {account?.verificationUrl && /^https:\/\//i.test(account.verificationUrl) && <a href={account.verificationUrl} target="_blank" rel="noreferrer">{tr("open")}</a>}
        {account?.userCode && <p><code>{account.userCode}</code></p>}
        {id === "alipay" && account?.state === "authorizing" && <label className={s.field}><span>{tr("code")}</span><input autoComplete="off" value={code} maxLength={32} disabled={busy} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        {id === "doordash" && account?.state === "authorizing" && <label className={s.field}><span>{tr("doordashCallback")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={8192} disabled={busy} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        {id === "quark-drive" && account?.state === "authorizing" && <label className={s.field}><span>{tr("quarkCode")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={4096} disabled={busy} onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        <div className={s.actions}>
          <button type="button" className={s.textButton} disabled={busy} onClick={() => void accountAction("status")}>{tr(serviceOnly ? "checkService" : "check")}</button>

        </div>
      </section>}
      {showTools && server && <div className={s.embeddedManagement}><McpConnectorDialog embedded server={server} recommendation={recommendation} managed onClose={() => setShowTools(false)} onChanged={toolsChanged} /></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}{error && <p className={s.error} role="alert">{error}</p>}
      <details className={s.management}><summary>{t("mcpConnectors.flow.advanced")}</summary>
          {installed && ["doordash", "shop", "quark-drive", "rollinggo-hotel", "meituan-paotui", "alipay", "netease-music"].includes(id) && <button type="button" className={s.button} disabled={busy} onClick={() => void accountAction("logout")}>{tr("logout")}</button>}
          {installed && <button type="button" className={s.button} disabled={busy} onClick={() => void toolSettings()}>{tr("toolSettings")}</button>}
        {installed && <button type="button" className={s.button} disabled={busy || !data || !!model.error} onClick={() => void model.change(id, "install")}>{tr("repair")}</button>}
        {data?.canRemove && <button type="button" className={s.danger} disabled={busy} onClick={() => void (async () => { if (await confirm({ title: tr("removeTitle"), message: tr("removeConfirm"), confirmLabel: tr("remove") })) { await model.change(id, "remove"); setAccount(null); onChanged(); } })()}>{t("mcpConnectors.flow.remove")}</button>}
      </details>
      <details className={s.management}><summary>{t("mcpConnectors.flow.help")}</summary>
      {(installed || ["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(id)) && <p className={s.notice}>{mcpRecommendationText(definition.note, language)}</p>}
      <a href={definition.docsUrl} target="_blank" rel="noreferrer">{tr("source")}</a>
      {definition.accessUrl && <a href={definition.accessUrl} target="_blank" rel="noreferrer">{tr("requestAccess")}</a>}
      <p className={s.muted}>{tr("version")} {data?.installedVersion || definition.version}{data?.canRemove && <> · {t("officialConnectors.skills", { count: data.skillCount })}</>}</p>
      {!data?.canRemove && <p className={s.muted}>{t("mcpConnectors.flow.addHint")}</p>}
      </details>
    </div>
  </Modal>;
}
