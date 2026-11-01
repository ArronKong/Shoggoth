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
  const [codeFocused, setCodeFocused] = useState(false);
  const [account, setAccount] = useState<OfficialAccountStatus | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [server, setServer] = useState<McpServer | null>(null), [showTools, setShowTools] = useState(false);
  const [toolsRevision, setToolsRevision] = useState(0);
  const mounted = useRef(true), locked = useRef(false);
  const accountEpoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { accountEpoch.current++; setAccount(null); setChecking(false); setError(""); setNotice(""); setCodeFocused(false); if (id === "quark-drive") setCode(""); }, [id, data?.revision]);
  const toolsChanged = () => {
    accountEpoch.current++;
    setToolsRevision(value => value + 1);
    if (mounted.current) { setAccount(null); setChecking(false); setError(""); setNotice(""); }
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
    if (serviceOnly && action === "status") setChecking(true);
    const result = await officialAccount(id, data.revision, action, authorizationCode).catch(error => {
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
    if (serviceOnly) setChecking(true);
    const snapshot = await listMcpConnectors();
    const credentials = Object.entries(values).filter(([, value]) => value.trim()).map(([name, value]) => [name, id === "netease-music" ? value.trim() : value]);
    const result = await saveMcpCredentials(data.serverId, { env: Object.fromEntries(credentials) }, snapshot.revision);
    if (mounted.current) setServer(result.server);
    if (mounted.current) { setValues({}); setNotice(tr(id === "fliggy" ? "fliggySavedCredentials" : id === "netease-music" ? "neteaseSavedCredentials" : "savedCredentials")); }
    if (serviceOnly && mounted.current && epoch === accountEpoch.current) {
      setChecking(true);
      try {
        const checked = await officialAccount(id, data.revision, "status");
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
  return <Modal open title={<span className={s.dialogIdentity}><McpConnectorIcon name={definition.name} identity={id} />{definition.name}</span>} width={680} onClose={onClose} dismissible={!busy}>
    <div className={s.detail}>
      <section className={s.overview}><h3>{t("mcpConnectors.flow.capabilities")}</h3><p>{mcpRecommendationText(definition.description, language)}</p></section>
      <ConnectorTools serverId={data?.serverId || undefined} status={server?.status} checkedAt={server?.lastCheck?.at} previewId={id} refreshKey={`${data?.revision}:${toolsRevision}`} />
      {(installed || ["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(id)) && <p className={s.notice}>{mcpRecommendationText(definition.note, language)}</p>}
      <a href={definition.docsUrl} target="_blank" rel="noreferrer">{tr("source")}</a>
      {definition.accessUrl && <a href={definition.accessUrl} target="_blank" rel="noreferrer">{tr("requestAccess")}</a>}
      <p className={s.muted}>{tr("version")} {data?.installedVersion || definition.version}{data?.canRemove && <> · {t("officialConnectors.skills", { count: data.skillCount })}</>}</p>
      {!data?.canRemove && <p className={s.muted}>{t("mcpConnectors.flow.addHint")}</p>}
      {model.loading && !data && <p role="status">{tr("loading")}</p>}
      {model.error && <p className={s.error} role="alert">{tr("loadFailed")} <button className={s.textButton} onClick={() => void model.refresh()}>{tr("retry")}</button></p>}
      {installationError && <p className={s.error} role="alert">{tr(`errors.${installationError}`)}</p>}
      {data && <p role="status" className={s.status}>{tr(data.stage ? `stages.${data.stage}` : `states.${data.state}`)}</p>}
      {installed && <>
        <h3>{t("mcpConnectors.flow.setup")}</h3><p className={s.muted}>{tr("localHint")}</p>
        {definition.fields.length > 0 && <><div className={s.fields}>{definition.fields.map(field => <label className={s.field} key={field.name}><span>{mcpRecommendationText(field.label, language)}{field.required ? " *" : ""}</span>{field.name === "NCM_PRIVATE_KEY" ? <textarea className={s.masked} rows={4} autoComplete="off" spellCheck={false} disabled={busy} value={values[field.name] || ""} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} /> : <input autoComplete="off" spellCheck={false} type={field.secret ? "password" : "text"} disabled={busy} value={values[field.name] || ""} onChange={event => setValues(previous => ({ ...previous, [field.name]: event.target.value }))} />}</label>)}</div><p className={s.muted}>{tr("credentialHint")}</p><button type="button" className={s.button} disabled={busy || !Object.values(values).some(value => value.trim())} onClick={() => void save()}>{t("mcpConnectors.flow.saveConnect")}</button></>}
        <p className={s.status} role="status">{tr(serviceOnly ? checking ? "serviceChecking" : account?.state === "ready" ? "serviceReady" : "serviceUnknown" : `accountStates.${account?.state || "unknown"}`)}{account?.userName ? ` · ${account.userName}` : ""}</p>
        {account?.qrCode && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(account.qrCode) && account.qrCode.length < 350000 && <img src={account.qrCode} alt={tr("open")} width={192} height={192} />}
        {account?.verificationUrl && /^https:\/\//i.test(account.verificationUrl) && <a href={account.verificationUrl} target="_blank" rel="noreferrer">{tr("open")}</a>}
        {account?.userCode && <p><code>{account.userCode}</code></p>}
        {id === "alipay" && account?.state === "authorizing" && <label className={s.field}><span>{tr("code")}</span><input autoComplete="off" value={code} maxLength={32} disabled={busy} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        {id === "doordash" && account?.state === "authorizing" && <label className={s.field}><span>{tr("doordashCallback")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={8192} disabled={busy} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        {id === "quark-drive" && account?.state === "authorizing" && <label className={s.field}><span>{tr("quarkCode")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={4096} disabled={busy} onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)} onChange={event => setCode(event.target.value)} /><button type="button" className={s.button} disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        <div className={s.actions}>
          {["doordash", "shop", "quark-drive", "rollinggo-hotel", "meituan-paotui", "alipay", "netease-music"].includes(id) && <button type="button" className={s.primary} disabled={busy} onClick={() => void accountAction("start")}>{t(account?.state === "ready" ? "mcpConnectors.flow.reconnect" : "mcpConnectors.flow.authorize")}</button>}
          <button type="button" className={s.button} disabled={busy} onClick={() => void accountAction("status")}>{tr(serviceOnly ? "checkService" : "check")}</button>
          {["doordash", "shop", "quark-drive", "rollinggo-hotel", "meituan-paotui", "alipay", "netease-music"].includes(id) && <button type="button" className={s.button} disabled={busy} onClick={() => void accountAction("logout")}>{tr("logout")}</button>}
          <button type="button" className={s.button} disabled={busy} onClick={() => void toolSettings()}>{tr("toolSettings")}</button>
        </div>
      </>}
      {showTools && server && <div className={s.embeddedManagement}><McpConnectorDialog embedded server={server} recommendation={recommendation} managed onClose={() => setShowTools(false)} onChanged={toolsChanged} /></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}{error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.actions}>
        <button type="button" className={installed ? s.button : s.primary} disabled={busy || !data || !!model.error} onClick={() => void model.change(id, "install")}>{data?.canRemove ? tr("repair") : t("mcpConnectors.add")}</button>
        {data?.canRemove && <button type="button" className={s.danger} disabled={busy} onClick={() => void (async () => { if (await confirm({ title: tr("removeTitle"), message: tr("removeConfirm"), confirmLabel: tr("remove") })) { await model.change(id, "remove"); setAccount(null); onChanged(); } })()}>{t("mcpConnectors.flow.remove")}</button>}
        <button type="button" className={s.button} disabled={busy} onClick={onClose}>{tr("close")}</button>
      </div>
    </div>
  </Modal>;
}
