import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRuntimeAccounts } from "../../api/client";
import type {
  RuntimeAccountCardSnapshot,
  RuntimeAccountSnapshot,
} from "../../types";
import { BackendMark } from "./BackendOverview";
import "./RuntimeStorageCard.css";

const RUNTIME_LABELS: Record<string, string> = {
  codex: "Codex",
  "grok-build": "Grok",
  antigravity: "Antigravity",
  pi: "Pi",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  "deepseek-harness": "DeepSeek",
};

export function formatRuntimeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export default function RuntimeStorageCard({ onOpenService }: { onOpenService: () => void }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<RuntimeAccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getRuntimeAccounts();
      if (!mounted.current) return;
      setSnapshot(next);
      setUpdatedAt(new Date());
      setError(false);
    } catch {
      if (!mounted.current) return;
      setError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const accountName = (account: RuntimeAccountCardSnapshot) => account.kind === "shoggoth-managed"
    ? t("settings.runtimeBuiltinName", { runtime: RUNTIME_LABELS[account.runtime] || account.runtime })
    : RUNTIME_LABELS[account.runtime] || account.runtime;
  const renderAccount = (account: RuntimeAccountCardSnapshot) => (
    <details key={account.id} className="runtime-account-row">
      <summary>
        <BackendMark id={account.runtime} name={accountName(account)} />
        <div className="runtime-account-label"><strong>{accountName(account)}</strong><span>{t(account.kind === "native-user" ? "settings.runtimeNativeAccount" : "settings.runtimeManagedAccount")}</span></div>
        <span className="runtime-shared">{t("settings.runtimeSharedAgents", { count: account.sharedAgentCount })}</span>
        <span className="runtime-account-size">{!account.storage.available ? t("settings.runtimeStorageMissing") : `${account.storage.incomplete ? "≥ " : ""}${formatRuntimeBytes(account.storage.bytes)}`}</span>
        <span className="runtime-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="runtime-account-detail">
        <dl className="runtime-account-facts">
          <div><dt>{t("settings.runtimeInstallation")}</dt><dd>{t(account.installationKind === "system" ? "settings.runtimeSystemInstall" : "settings.runtimeBundledInstall")}</dd></div>
          <div><dt>{t("settings.runtimeHome")}</dt><dd>{t(account.homeKind === "system-default" ? "settings.runtimeSystemHome" : "settings.runtimeSharedHome")}</dd></div>
          <div><dt>{t("settings.runtimeAdmission")}</dt><dd>{t("settings.runtimeAdmissionValue", { active: account.admission.active, max: account.admission.maxActive })}</dd></div>
        </dl>
        {account.storage.incomplete && <p className="ui-hint">{t("settings.runtimeUsageIncomplete")}</p>}
        {(account.admission.mutationActive || account.admission.backoffUntil !== null) && <p className="ui-hint">{t(account.admission.mutationActive ? "settings.runtimeAuthBusy" : "settings.runtimeBackoff")}</p>}
      </div>
    </details>
  );

  return <section className="settings-section runtime-storage-section" id="settings-runtime-storage" aria-busy={loading}>
    <header className="settings-section-head settings-heading-row">
      <div><h3 className="settings-h">{t("settings.runtimeStorageTitle")}</h3><p className="settings-sech">{t("settings.runtimeStorageDesc")}</p></div>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => void refresh()} disabled={loading}>
        {t(loading ? "settings.runtimeRefreshing" : error ? "settings.retry" : "settings.runtimeRefresh")}
      </button>
    </header>
    {loading && !snapshot && <div className="settings-card"><p className="ui-hint" role="status">{t("settings.runtimeLoading")}</p></div>}
    {error && <div className="settings-card settings-inline-state" role="alert">
      <div><strong>{t("settings.runtimeStorageUnavailable")}</strong><p>{t(snapshot ? "settings.runtimeStorageStale" : "settings.runtimeStorageRetryHint")}</p></div>
      <button className="ui-cbtn ui-cbtn--sm" onClick={onOpenService}>{t("settings.viewServiceStatus")}</button>
    </div>}
    {snapshot && <>
      <article className="runtime-current-card">
        <header className="runtime-current-head"><div><h4>{t("settings.runtimeCurrentEnvironments")}</h4><p>{t("settings.runtimeCurrentHint")}</p></div><span className="settings-count">{t("settings.readOnly")}</span></header>
        {snapshot.accounts.length ? snapshot.accounts.map(renderAccount) : <p className="ui-hint runtime-accounts-empty">{t("settings.runtimeAccountsEmpty")}</p>}
      </article>
      {updatedAt && <p className="runtime-updated" role="status">{t("settings.runtimeUpdatedAt", { time: updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>}
    </>}
  </section>;
}
