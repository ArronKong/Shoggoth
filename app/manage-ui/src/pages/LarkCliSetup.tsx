import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelLarkCliSetup, getLarkCliSetup, larkCliErrorKey, startLarkCliSetup, type LarkCliSetupInput } from "../api/larkCliConnector";
import { usePageCache } from "../lib/usePageCache";
import s from "./ConnectorsPage.module.css";

export function useLarkCliSetup(enabled: boolean) {
  const cache = usePageCache("lark-cli-setup", getLarkCliSetup, { enabled });
  const [working, setWorking] = useState(false), [actionError, setActionError] = useState("");
  const locked = useRef(false);
  const active = Boolean(enabled && cache.data && ["starting", "configuring", "authorizing"].includes(cache.data.state));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void cache.refresh(), 1000);
    return () => clearInterval(timer);
  }, [active, cache.refresh]);
  const perform = async (action: () => ReturnType<typeof startLarkCliSetup>) => {
    if (!enabled || locked.current) return;
    locked.current = true; setWorking(true); setActionError("");
    try { cache.replace(await action()); }
    catch (error) { setActionError(larkCliErrorKey(error)); await cache.refresh(); }
    finally { locked.current = false; setWorking(false); }
  };
  return { ...cache, active, working, actionError,
    start: (input: LarkCliSetupInput) => perform(() => startLarkCliSetup(input)),
    cancel: () => cache.data?.requestId ? perform(() => cancelLarkCliSetup(cache.data!.requestId!)) : Promise.resolve(),
  };
}

type Model = ReturnType<typeof useLarkCliSetup>;
export function useLarkCliSetupView({ model, revision, enabled = true }: { model: Model; revision: number; enabled?: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"auto" | "existing">("auto"), [brand, setBrand] = useState<"feishu" | "lark">("feishu");
  const [appId, setAppId] = useState(""), [appSecret, setAppSecret] = useState("");
  useEffect(() => { if (!enabled) { setMode("auto"); setBrand("feishu"); setAppId(""); setAppSecret(""); } }, [enabled]);
  const data = model.data, ready = data?.state === "ready", disabled = model.working || model.active;
  const errorKey = model.actionError || (data?.errorCode ? larkCliErrorKey({ code: data.errorCode }) : "");
  const start = () => {
    const input: LarkCliSetupInput = !data?.configured && mode === "existing"
      ? { expectedRevision: revision, mode, brand, appId: appId.trim(), appSecret }
      : { expectedRevision: revision, mode: ready ? "reauthorize" : "auto", brand };
    setAppSecret("");
    void model.start(input);
  };
  const content = <section className={s.connectionPanel} data-lark-setup>
    <h3>{t("larkCli.setupTitle")}</h3>
    {model.loading && !data && <p role="status" className={s.muted}>{t("larkCli.authLoading")}</p>}
    {model.error && <p role="alert" className={s.error}>{t("larkCli.errors.authStatus")}</p>}
    {data?.configured && <p className={s.muted}>{t("larkCli.configuredApp")} <code>{data.appId}</code> · {data.brand === "lark" ? "Lark" : t("larkCli.name")}</p>}
    {ready ? <p className={s.authReady} role="status">{t("larkCli.connected")}{data.userName ? ` · ${data.userName}` : ""}</p>
      : <p className={s.muted}>{t("larkCli.setupHint")}</p>}
    {errorKey && !ready && <p role="alert" className={s.error}>{t(`larkCli.errors.${errorKey}`)}</p>}
    {data?.warning && <p role="status" className={s.notice}>{t("larkCli.missingScopes")}</p>}
    {!ready && data && !data.configured && !model.active && <>
      <div className={s.modeTabs} role="group" aria-label={t("larkCli.configMode")}>
        <button type="button" className={mode === "auto" ? s.primary : s.button} disabled={disabled} aria-pressed={mode === "auto"} onClick={() => setMode("auto")}>{t("larkCli.createApp")}</button>
        <button type="button" className={mode === "existing" ? s.primary : s.button} disabled={disabled} aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>{t("larkCli.existingApp")}</button>
      </div>
      <div className={s.fields}>
        <label className={s.field}>{t("larkCli.brand")}<select value={brand} disabled={disabled} onChange={event => setBrand(event.target.value as "feishu" | "lark")}><option value="feishu">{t("larkCli.name")}</option><option value="lark">Lark</option></select></label>
        {mode === "existing" && <>
          <label className={s.field}>App ID<input value={appId} disabled={disabled} autoComplete="off" placeholder="cli_…" onChange={event => setAppId(event.target.value)} /></label>
          <label className={s.field}>App Secret<input type="password" value={appSecret} disabled={disabled} autoComplete="new-password" onChange={event => setAppSecret(event.target.value)} /><small>{t("larkCli.secretHint")}</small></label>
        </>}
      </div>
    </>}
    {model.active && <p role="status" className={s.notice}>{t(`larkCli.authStages.${data?.state || "starting"}`)}</p>}
    {model.active && data?.verificationUrl && <div className={s.authorization}>
      {data.qrCode && <img src={data.qrCode} alt={t("larkCli.qrAlt")} width={184} height={184} />}
      <div><p>{t("larkCli.scanHint")}</p>
        <a className={s.button} href={data.verificationUrl} target="_blank" rel="noreferrer">{t("larkCli.openAuthorization")}</a>
        {data.userCode && <p className={s.muted}>{t("larkCli.userCode")} <strong>{data.userCode}</strong></p>}
        <p className={s.muted}>{t("larkCli.autoContinue")}</p>
      </div>
    </div>}

  </section>;
  const actions = <div className={s.actions}>
      {ready && <button type="button" className={s.button} disabled={disabled} onClick={start}>{t("larkCli.reauthorize")}</button>}
      {!ready && !model.active && <button type="button" className={s.primary} disabled={disabled || !data || Boolean(model.error) || !data.configured && mode === "existing" && (!appId.trim() || !appSecret.trim())} onClick={start}>{model.working ? t("larkCli.authStages.starting") : t(data?.configured ? "larkCli.signIn" : "larkCli.connect")}</button>}
      {model.active && <button type="button" className={s.button} disabled={model.working} onClick={() => void model.cancel()}>{t("larkCli.cancelSetup")}</button>}
      {!model.active && <button type="button" className={s.button} disabled={model.working} onClick={() => void model.refresh()}>{t("larkCli.checkAuth")}</button>}
    </div>;
  return { content, actions };
}

export default function LarkCliSetup(props: { model: Model; revision: number }) {
  const view = useLarkCliSetupView(props);
  return <>{view.content}{view.actions}</>;
}
