import { measureTelemetry, startTelemetryOperation, type TelemetryOperation } from "../lib/productTelemetry";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeOfficialConnector, getOfficialConnectors, officialAccount, officialConnectorErrorKey, OFFICIAL_CONNECTORS_CHANGE_EVENT, type OfficialConnectorId, type OfficialAccountStatus } from "../api/officialSkillConnectors";
import { listMcpConnectors, saveMcpCredentials, type McpServer } from "../api/mcpConnectors";
import { usePageCache } from "../lib/usePageCache";
import { mcpRecommendationText, type McpRecommendation } from "../lib/mcpConnectorUi";
import { mcpConnectorDeveloper, mcpConnectorName } from "../lib/mcpRecommendationCatalog";
import ConnectorTools from "../components/ConnectorTools";
import ConnectorAddButton from "../components/ConnectorAddButton";
import { ConnectorConnectionHeading, ConnectorFooter, ConnectorInfo } from "../components/ConnectorDetails";
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
      await measureTelemetry(action === "install" ? "connector_add" : "connector_remove", "shoggoth",
        () => changeOfficialConnector(id, action, current.revision));
    } catch (error) { setActionError({ id, key: officialConnectorErrorKey(error) }); }
    finally { locked.current = false; setPending(null); await cache.refresh(); }
  };
  return { ...cache, busy, pending, actionError, change };
}
type Model = ReturnType<typeof useOfficialSkillConnectors>;
export function OfficialSkillRecommendation({ definition, model, onOpen, onAdd }: { definition: OfficialConnectorDefinition; model: Model; onOpen: () => void; onAdd?: () => void }) {
  const { i18n } = useTranslation(); const data = model.data?.items.find(item => item.id === definition.id);
  return <div className={s.service} data-official-recommendation={definition.id}>
    <button type="button" className={s.serviceOpen} onClick={onOpen}><McpConnectorIcon name={definition.name} identity={definition.id} />
      <span className={s.serviceText}><strong>{definition.name}</strong><small>{mcpRecommendationText(definition.description, i18n.resolvedLanguage || i18n.language)}</small></span></button>
    {!data?.canRemove && <ConnectorAddButton name={definition.name} disabled={model.busy || !data || !!model.error} onClick={onAdd || onOpen} />}
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
  const alipay = id === "alipay";
  const serviceOnly = id === "fliggy" || id === "baidu-maps";
  const data = model.data?.items.find(item => item.id === id), installed = data?.state === "installed";
  const language = i18n.resolvedLanguage || i18n.language;
  const [values, setValues] = useState<Record<string, string>>({}), [code, setCode] = useState("");
  const [working, setWorking] = useState<"interactive" | "background" | null>(null), [checking, setChecking] = useState(false);
  const [serviceCheckFailed, setServiceCheckFailed] = useState(false);
  const [authorizationQr, setAuthorizationQr] = useState<string | null>(null);
  const [codeFocused, setCodeFocused] = useState(false);
  const [account, setAccount] = useState<OfficialAccountStatus | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [server, setServer] = useState<McpServer | null>(null), [showTools, setShowTools] = useState(false);
  const [toolsRevision, setToolsRevision] = useState(0);
  const missingRequiredCredentials = (candidate: McpServer) => definition.fields.some(field => field.required && !candidate.setup.configuredFields.includes(`env:${field.name}`));
  const mounted = useRef(true), locked = useRef(false);
  const accountEpoch = useRef(0);
  const alipayAuthorization = useRef<"login" | "revocation" | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { accountEpoch.current++; alipayAuthorization.current = null; setAccount(null); setChecking(false); setServiceCheckFailed(false); setError(""); setNotice(""); setCodeFocused(false); if (id === "quark-drive") setCode(""); }, [id, data?.revision]);
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
      void listMcpConnectors().then(snapshot => {
        if (!current || !mounted.current || epoch !== accountEpoch.current) return;
        const found = snapshot.servers.find(value => value.id === data.serverId) || null;
        setServer(found);
      }).catch(() => {});
    }
    return () => { current = false; };
  }, [id, installed, data?.serverId, data?.revision, toolsRevision]);
  const toolsChanged = () => {
    accountEpoch.current++;
    alipayAuthorization.current = null;
    setToolsRevision(value => value + 1);
    if (mounted.current) { setAccount(null); setChecking(false); setServiceCheckFailed(false); setError(""); setNotice(""); }
    onChanged();
  };
  const act = async (operation: () => Promise<void>, background = false) => {
    if (locked.current || model.busy) return;
    locked.current = true;
    setWorking(background ? "background" : "interactive");
    if (!background) { setError(""); setNotice(""); }
    try { await operation(); }
    catch (error) { if (!background && mounted.current) setError(tr(`errors.${officialConnectorErrorKey(error)}`)); }
    finally { locked.current = false; if (mounted.current) { setWorking(null); setChecking(false); } }
  };
  const verificationUrl = account?.verificationUrl && /^https:\/\//i.test(account.verificationUrl) ? account.verificationUrl : null;
  const alipayWaiting = alipay && account?.state === "authorizing" ? alipayAuthorization.current : null;
  const alipayClosing = alipayWaiting === "revocation";
  const authorizationTelemetry = useRef<TelemetryOperation>();
  const accountAction = (intent: "status" | "start" | "bind" | "logout" | "reauthorize", background = false) => act(async () => {
    if (!data) return;
    if (intent === "start" && alipayWaiting && verificationUrl) {
      window.open(verificationUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (intent === "logout" && !await confirm({ title: tr("logout"), message: tr("logoutConfirm"), confirmLabel: tr("logout") })) return;
    const reauthorize = intent === "reauthorize";
    const action = reauthorize ? "logout" : intent;
    const pendingAlipay = alipayWaiting && action === "status";
    const retainPending = pendingAlipay || id === "quark-drive" && action === "status" && account?.state === "authorizing";
    if (!retainPending && !reauthorize) setAccount(null);
    if (action !== "status") alipayAuthorization.current = null;
    const epoch = ++accountEpoch.current;
    const authorizationCode = action === "bind" ? code.trim() : undefined;
    if (action === "start" || (action === "bind" && !authorizationTelemetry.current)) {
      authorizationTelemetry.current = startTelemetryOperation("connector_auth", "shoggoth");
    }
    if (action === "logout") {
      authorizationTelemetry.current?.finish("canceled");
      authorizationTelemetry.current = undefined;
    }
    if (["doordash", "quark-drive"].includes(id) && action === "bind") setCode("");
    if (serviceOnly && action === "status") { setChecking(true); setServiceCheckFailed(false); }
    const result = await officialAccount(id, data.revision, action, authorizationCode).catch(error => {
      if (action === "start" || action === "bind") {
        authorizationTelemetry.current?.finish("error", error);
        authorizationTelemetry.current = undefined;
      }
      if (serviceOnly && mounted.current && epoch === accountEpoch.current) setServiceCheckFailed(true);
      if (retainPending && !pendingAlipay && mounted.current && epoch === accountEpoch.current) setAccount(null);
      throw error;
    }).finally(() => { if (mounted.current && epoch === accountEpoch.current) setChecking(false); });
    if (mounted.current && epoch === accountEpoch.current) {
      if (result.state === "ready" || (action !== "status" && result.errorCode)) {
        authorizationTelemetry.current?.finish(result.errorCode ? "error" : "success", result.errorCode);
        authorizationTelemetry.current = undefined;
      }
      // Keep the page available until Alipay reports a definite change.
      if (pendingAlipay && (result.state === "unknown" || alipayClosing && result.state === "ready")) {
        if (!background && result.errorCode) setError(tr(`errors.${officialConnectorErrorKey({ code: result.errorCode })}`));
        return;
      }
      const resultUrl = result.verificationUrl && /^https:\/\//i.test(result.verificationUrl) ? result.verificationUrl : null;
      if (reauthorize && result.state === "authorizing" && (!resultUrl || result.errorCode)) {
        setError(tr(`errors.${officialConnectorErrorKey({ code: result.errorCode || "OFFICIAL_SKILL_AUTH_STATUS_FAILED" })}`));
        return;
      }
      alipayAuthorization.current = null;
      if (alipay && result.state === "authorizing") {
        if (reauthorize) alipayAuthorization.current = "revocation";
        else if (action === "start" || action === "status") alipayAuthorization.current = "login";
      }
      setAccount(pendingAlipay && !alipayClosing && result.state === "authorizing" ? {
        ...result, verificationUrl: result.verificationUrl ?? account?.verificationUrl ?? null,
      } : result);
      if (!(retainPending && result.state === "authorizing")) setCode("");
      if (result.errorCode) setError(tr(`errors.${officialConnectorErrorKey({ code: result.errorCode })}`));
      else if (pendingAlipay) setError("");
      if (alipay && (action === "start" || reauthorize) && result.state === "authorizing" && !result.errorCode && resultUrl) {
        window.open(resultUrl, "_blank", "noopener,noreferrer");
      }
    } else if (background) return;
    if (!(pendingAlipay && result.state === "authorizing")) onChanged();
  }, background);
  useEffect(() => {
    const pollAlipay = alipayAuthorization.current !== null;
    if (!(pollAlipay || ["shop", "quark-drive", "rollinggo-hotel"].includes(id)) || account?.state !== "authorizing" || working || model.busy
      || id === "quark-drive" && (codeFocused || code.length > 0)) return;
    let current = true, timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        await accountAction("status", pollAlipay);
        if (current && pollAlipay && alipayAuthorization.current) schedule();
      }, 5000);
    };
    schedule();
    return () => { current = false; clearTimeout(timer); };
  }, [id, account, working, model.busy, data?.revision, code, codeFocused]);
  const save = () => act(async () => {
    if (!data?.serverId) return;
    const epoch = ++accountEpoch.current; setAccount(null);
    if (serviceOnly) { setChecking(true); setServiceCheckFailed(false); }
    const snapshot = await listMcpConnectors();
    const credentials = Object.entries(values).filter(([, value]) => value.trim());
    const result = await saveMcpCredentials(data.serverId, { env: Object.fromEntries(credentials) }, snapshot.revision);
    if (mounted.current) setServer(result.server);
    if (mounted.current) {
      setValues({});
      setNotice(tr(id === "fliggy" ? "fliggySavedCredentials" : "savedCredentials"));
    }
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
  const busy = Boolean(working) || model.busy;
  const installationError = model.actionError?.id === id ? model.actionError.key : data?.errorCode ? officialConnectorErrorKey({ code: data.errorCode }) : null;
  const supportsLogin = ["doordash", "shop", "quark-drive", "rollinggo-hotel", "meituan-paotui", "alipay"].includes(id);
  const credentialsDirty = Object.values(values).some(value => value.trim());
  const accountReady = account?.state === "ready";
  const credentialsSaved = definition.fields.some(field => server?.setup?.configuredFields.includes(`env:${field.name}`));
  const requiredCredentialsMissing = server?.setup && missingRequiredCredentials(server);
  const serviceStatus = checking ? "serviceChecking" : accountReady ? "serviceReady"
    : account?.state === "signedOut" ? "serviceNeedsCredentials" : serviceCheckFailed || account?.errorCode ? "serviceCheckFailed"
      : requiredCredentialsMissing ? "serviceNeedsCredentials" : "serviceUnknown";
  const accountStatus = alipayClosing ? "alipayWaitingRevocation" : `accountStates.${account?.state || "unknown"}`;
  const guide = data?.canRemove || installed ? { url: definition.docsUrl, label: tr("source") } : undefined;
  const setupNotes = <>
    {(installed || ["doordash", "quark-drive", "rollinggo-hotel", "baidu-maps"].includes(id)) && <p className={s.notice}>{mcpRecommendationText(definition.note, language)}</p>}
    {definition.accessUrl && <p><a className={s.connectionGuide} href={definition.accessUrl} target="_blank" rel="noreferrer">{tr("requestAccess")}</a></p>}
  </>;
  const remove = async () => {
    if (await confirm({ title: tr("removeTitle"), message: tr("removeConfirm"), confirmLabel: tr("remove"), danger: true })) { await model.change(id, "remove"); setAccount(null); onChanged(); }
  };
  const footer = <ConnectorFooter hint={t(accountReady ? "mcpConnectors.flow.connectedHint" : "mcpConnectors.defaultAccess")} onRemove={data?.canRemove ? () => void remove() : undefined} removeDisabled={busy}>
    {!installed ? <button type="button" className="btn-dark btn-sm" disabled={busy || !data || !!model.error} onClick={() => void model.change(id, "install")}>{data?.canRemove ? tr("repair") : t("mcpConnectors.add")}</button> : <>
      {definition.fields.length > 0 && <button type="button" className={credentialsDirty || !supportsLogin && !accountReady ? "btn-dark btn-sm" : "btn-secondary btn-sm"} disabled={busy || !credentialsDirty} onClick={() => void save()}>{t("mcpConnectors.flow.saveConnect")}</button>}
      {supportsLogin && !accountReady && <button type="button" className={!credentialsDirty ? "btn-dark btn-sm" : "btn-secondary btn-sm"} disabled={busy} onClick={() => void accountAction("start")}>{alipayClosing ? tr("alipayOpenRevocation") : t("mcpConnectors.flow.authorize")}</button>}
      {(accountReady || !supportsLogin && !definition.fields.length) && <button type="button" className="btn-dark btn-sm" disabled={busy} onClick={onClose}>{t("mcpConnectors.flow.done")}</button>}
    </>}
  </ConnectorFooter>;
  return <Modal open title={<span className={s.dialogIdentity}><McpConnectorIcon name={definition.name} identity={id} />{definition.name}</span>} width={640} variant="connector" subtitle={mcpRecommendationText(definition.description, language)} footer={footer} onClose={onClose} dismissible={working !== "interactive" && !model.busy}>
    <div className={s.detail}>
      <ConnectorTools overview description={mcpRecommendationText(definition.description, language)} serverId={data?.serverId || undefined} status={server?.status} checkedAt={server?.lastCheck?.at} previewId={id} refreshKey={`${data?.revision}:${toolsRevision}`} />
      {!installed && <section className={s.connectionPanel}>
        <ConnectorConnectionHeading title={t("mcpConnectors.flow.connectionTitle", { name: definition.name })} guide={guide}
          status={<span className={s.status}>{tr(data?.stage ? `stages.${data.stage}` : `states.${data?.state || "notInstalled"}`)}</span>} />
        {!data?.canRemove && <p className={s.muted}>{t("mcpConnectors.flow.addHint")}</p>}
        {setupNotes}
      </section>}
      {model.loading && !data && <p role="status">{tr("loading")}</p>}
      {model.error && <p className={s.error} role="alert">{tr("loadFailed")} <button className={s.textButton} onClick={() => void model.refresh()}>{tr("retry")}</button></p>}
      {installationError && <p className={s.error} role="alert">{tr(`errors.${installationError}`)}</p>}
      {installed && <section className={alipay ? `${s.connectionPanel} ${s.alipayConnectionPanel}` : s.connectionPanel}>
        <ConnectorConnectionHeading title={t("mcpConnectors.flow.connectionTitle", { name: definition.name })} guide={guide}
          status={<span className={s.status} data-state={accountReady ? "ready" : undefined} role="status">{tr(serviceOnly ? serviceStatus : accountStatus)}{account?.userName ? ` · ${account.userName}` : ""}</span>} />
        <p className={s.muted}>{tr("localHint")}</p>
        {setupNotes}
        {definition.fields.length > 0 && <details className={s.clientSetup} open={!accountReady || undefined}>
          <summary>{t("mcpConnectors.flow.configure")}</summary>
          <div className={s.fields}>{definition.fields.map(field => {
            const placeholder = serviceOnly && server?.setup?.configuredFields.includes(`env:${field.name}`) ? tr("credentialSavedPlaceholder") : undefined;
            const input = { autoComplete: "off", spellCheck: false, disabled: busy, placeholder, value: values[field.name] || "",
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValues(previous => ({ ...previous, [field.name]: event.target.value })) };
            return <label className={s.field} key={field.name}>
              <span>{mcpRecommendationText(field.label, language)}{field.required ? " *" : ""}</span>
              <input type={field.secret ? "password" : "text"} {...input} />
            </label>;
          })}</div>
          <p className={s.muted}>{tr(serviceOnly && credentialsSaved ? "credentialSavedHint" : "credentialHint")}</p>
        </details>}
        {account?.qrCode && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(account.qrCode) && account.qrCode.length < 350000 && <img src={account.qrCode} alt={tr("open")} width={192} height={192} />}
        {id === "meituan-paotui" && account?.state === "authorizing" && authorizationQr && <img src={authorizationQr} alt={tr("meituanScan")} width={192} height={192} />}
        {id === "meituan-paotui" && account?.state === "authorizing" && <p className={s.muted}>{tr("meituanAuthorizationHint")}</p>}
        {verificationUrl && !alipayWaiting && <a href={verificationUrl} target="_blank" rel="noreferrer">{tr("open")}</a>}
        {account?.userCode && <p><code>{account.userCode}</code></p>}
        {id === "doordash" && account?.state === "authorizing" && <label className={s.field}><span>{tr("doordashCallback")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={8192} disabled={busy} onChange={event => setCode(event.target.value)} /><button type="button" className="btn-secondary btn-sm" disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        {id === "quark-drive" && account?.state === "authorizing" && <label className={s.field}><span>{tr("quarkCode")}</span><input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={4096} disabled={busy} onFocus={() => setCodeFocused(true)} onBlur={() => setCodeFocused(false)} onChange={event => setCode(event.target.value)} /><button type="button" className="btn-secondary btn-sm" disabled={busy || !code.trim()} onClick={() => void accountAction("bind")}>{tr("bind")}</button></label>}
        <div className={s.actions}>
          <button type="button" className={alipay ? "btn-secondary btn-sm" : s.textButton} disabled={busy} onClick={() => void accountAction("status")}>{tr(serviceOnly ? "checkService" : "check")}</button>
          {supportsLogin && accountReady && <button type="button" className={alipay ? "btn-secondary btn-sm" : s.textButton} disabled={busy} onClick={() => void accountAction(alipay ? "reauthorize" : "start")}>{t("mcpConnectors.flow.reconnect")}</button>}
        </div>
        <details className={s.clientSetup}><summary>{t("mcpConnectors.flow.advanced")}</summary>
          <div className={s.setupActions}>
            {supportsLogin && <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void accountAction("logout")}>{tr("logout")}</button>}
            <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void toolSettings()}>{tr("toolSettings")}</button>
            <button type="button" className="btn-secondary btn-sm" disabled={busy || !data || !!model.error} onClick={() => void model.change(id, "install")}>{tr("repair")}</button>
          </div>
        </details>
      </section>}
      {showTools && server && <div className={s.embeddedManagement}><McpConnectorDialog embedded server={server} recommendation={recommendation} managed onClose={() => setShowTools(false)} onChanged={toolsChanged} /></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}{error && <p className={s.error} role="alert">{error}</p>}
      <ConnectorInfo developer={mcpConnectorDeveloper(definition.id, definition.name)} version={data?.installedVersion || definition.version} />
    </div>
  </Modal>;
}
