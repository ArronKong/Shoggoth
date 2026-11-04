import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLarkCli, getLarkCliStatus, LARK_CLI_CHANGE_EVENT, larkCliErrorKey } from "../api/larkCliConnector";
import { usePageCache } from "../lib/usePageCache";
import McpConnectorIcon from "../components/McpConnectorIcon";
import ConnectorTools from "../components/ConnectorTools";
import Modal from "../components/Modal";
import { useConfirm } from "../components/ui";
import { useLarkCliSetup, useLarkCliSetupView } from "./LarkCliSetup";
import s from "./ConnectorsPage.module.css";

export function useLarkCliConnector() {
  const cache = usePageCache("lark-cli-connector", getLarkCliStatus);
  const setup = useLarkCliSetup(cache.data?.state === "installed");
  const [pendingAction, setPendingAction] = useState<"install" | "remove" | null>(null), [actionError, setActionError] = useState("");
  const locked = useRef(false);
  const operationState = pendingAction === "remove" ? "removing" : pendingAction === "install" ? "installing" : cache.data?.state;
  const busy = operationState === "installing" || operationState === "removing";
  useEffect(() => {
    const changed = () => void cache.refresh();
    window.addEventListener(LARK_CLI_CHANGE_EVENT, changed);
    return () => window.removeEventListener(LARK_CLI_CHANGE_EVENT, changed);
  }, [cache.refresh]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void cache.refresh(), 1000);
    return () => clearInterval(timer);
  }, [busy, cache.refresh]);
  const change = async (action: "install" | "remove") => {
    if (!cache.data || busy || locked.current) return;
    locked.current = true; setPendingAction(action); setActionError("");
    try { cache.replace(await changeLarkCli(action, cache.data.revision)); }
    catch (error) { setActionError(larkCliErrorKey(error)); }
    finally { locked.current = false; setPendingAction(null); await cache.refresh(); }
  };
  return { ...cache, busy, operationState, actionError, change, setup };
}
type Model = ReturnType<typeof useLarkCliConnector>;

export function LarkCliRecommendation({ model, onOpen, onAdd }: { model: Model; onOpen: () => void; onAdd?: () => void }) {
  const { t } = useTranslation();
  return <div className={s.service} data-lark-recommendation>
    <button type="button" className={s.serviceOpen} onClick={onOpen}><McpConnectorIcon name={t("larkCli.name")} identity="lark-cli" />
      <span className={s.serviceText}><strong>{t("larkCli.name")}</strong><small>{t("larkCli.description")}</small></span></button>
    {!model.data?.canRemove && <button type="button" className="btn-secondary btn-sm" disabled={model.busy || !model.data || !!model.error} onClick={onAdd || onOpen}>{t("mcpConnectors.add")}</button>}
  </div>;
}

export function LarkCliInstalledRow({ model, onOpen }: { model: Model; onOpen: () => void }) {
  const { t } = useTranslation();
  if (!model.data?.canRemove) return null;
  const ready = model.operationState === "installed" && model.setup.data?.state === "ready" && !model.setup.error;
  return <li className={s.installedItem} data-lark-installed>
    <button type="button" className={s.installedOpen} aria-label={`${t("mcpConnectors.manage")} ${t("larkCli.name")}`} onClick={onOpen}>
      <McpConnectorIcon name={t("larkCli.name")} identity="lark-cli" />
      <span className={s.installedLabel}><strong>{t("larkCli.name")}</strong>{!ready && <small className={s.connectionHint}>{t("mcpConnectors.flow.notConnected")}</small>}</span>
    </button>
  </li>;
}

export default function LarkCliDialog({ model, onClose }: { model: Model; onClose: () => void }) {
  const { t } = useTranslation(), confirm = useConfirm();
  const data = model.data, installed = data?.state === "installed";
  const setup = model.setup;
  const errorKey = (!installed && model.actionError) || (data?.errorCode ? larkCliErrorKey({ code: data.errorCode }) : "");
  const canInstall = data && !["LARK_CLI_STATE_UNAVAILABLE", "LARK_CLI_UNSUPPORTED", "LARK_CLI_OWNERSHIP_CONFLICT"].includes(data.errorCode || "");
  const setupView = useLarkCliSetupView({ model: setup, revision: data?.revision || 0, enabled: installed });
  const footer = <div className={s.flowFooter}><p>{t(setup.data?.state === "ready" ? "mcpConnectors.flow.connectedHint" : "mcpConnectors.defaultAccess")}</p><div className={s.flowFooterActions}>
    {!installed ? <button type="button" className="btn-dark btn-sm" disabled={model.busy || !canInstall || Boolean(model.error)} onClick={() => void model.change("install")}>{t(data?.canRemove ? "larkCli.reinstall" : "mcpConnectors.add")}</button> : setupView.actions}
    <button type="button" className={setup.data?.state === "ready" ? "btn-dark btn-sm" : "btn-secondary btn-sm"} disabled={model.busy} onClick={onClose}>{t("larkCli.close")}</button>
  </div></div>;
  return <Modal open title={<span className={s.dialogIdentity}><McpConnectorIcon name={t("larkCli.name")} identity="lark-cli" />{t("larkCli.name")}</span>} onClose={onClose} dismissible={!model.busy} width={640} variant="connector" subtitle={t("larkCli.description")} footer={footer}>
    <div className={s.detail}>
      <ConnectorTools overview previewId="lark-cli" description={t("mcpConnectors.flow.larkCapabilities")} />
      {!data?.canRemove && <section className={s.connectionPanel}><div className={s.connectionHeading}><h3>{t("mcpConnectors.flow.connectionTitle", { name: t("larkCli.name") })}</h3><span className={s.status}>{t("mcpConnectors.flow.notAdded")}</span></div><p className={s.muted}>{t("mcpConnectors.flow.addHint")}</p></section>}
      {model.loading && !data && <p className={s.muted} role="status">{t("larkCli.loading")}</p>}
      {model.error && <p className={s.error} role="alert">{t("larkCli.loadFailed")} <button type="button" className={s.textButton} onClick={() => void model.refresh()}>{t("larkCli.retry")}</button></p>}
      {errorKey && <p className={s.error} role="alert">{t(`larkCli.errors.${errorKey}`)}</p>}
      {model.busy && <p className={s.notice} role="status">{model.operationState === "installing" && data?.stage ? t(`larkCli.stages.${data.stage}`) : t(`larkCli.states.${model.operationState}`)}</p>}
      {installed && setupView.content}
      <details className={s.management}><summary>{t("mcpConnectors.flow.advanced")}</summary>
        {data && <p className={s.muted}>{t("larkCli.version")} {data.installedVersion || data.version}{data.canRemove && <> · {t("larkCli.skills", { count: data.skillCount })}</>}</p>}
        {data?.canRemove && <button type="button" className="btn-danger btn-sm" disabled={model.busy || setup.active || setup.working} onClick={() => void (async () => {
          if (await confirm({ title: t("larkCli.removeTitle"), message: t("larkCli.removeConfirm"), confirmLabel: t("larkCli.remove") })) await model.change("remove");
        })()}>{t("mcpConnectors.flow.remove")}</button>}
      </details>
      <details className={s.management}><summary>{t("mcpConnectors.flow.help")}</summary><p className={s.muted}>{t("mcpConnectors.flow.larkCapabilities")}</p><a href="https://github.com/larksuite/cli" target="_blank" rel="noreferrer">{t("larkCli.source")}</a></details>
    </div>
  </Modal>;
}
