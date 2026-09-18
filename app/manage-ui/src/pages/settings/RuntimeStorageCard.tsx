import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commitLegacyRuntimeHomeCleanup,
  commitRuntimeBackupCleanup,
  getRuntimeAccounts,
  prepareLegacyRuntimeHomeCleanup,
  prepareRuntimeBackupCleanup,
} from "../../api/client";
import { useConfirm, useToast } from "../../components/ui";
import type {
  LegacyRuntimeHomeSummary,
  RuntimeAccountCardSnapshot,
  RuntimeAccountSnapshot,
  RuntimeBackupCategory,
  RuntimeBackupSummary,
} from "../../types";
import { BackendMark } from "./BackendOverview";
import "./RuntimeStorageCard.css";

const RUNTIME_LABELS: Record<string, string> = {
  codex: "Codex",
  "grok-build": "Grok",
  antigravity: "Antigravity",
  pi: "Pi",
  "claude-code": "Claude Code",
  "deepseek-harness": "DeepSeek Harness",
};

const BACKUP_CATEGORY_KEYS: Record<RuntimeBackupCategory, string> = {
  "native-runtime-import": "settings.runtimeBackupNativeImport",
  "runtime-schema-history": "settings.runtimeBackupSchemaHistory",
  "runtime-schema-current": "settings.runtimeBackupSchemaCurrent",
  "native-capabilities": "settings.runtimeBackupNativeCapabilities",
  "memory-migration": "settings.runtimeBackupMemory",
  "permission-policy": "settings.runtimeBackupPermissionPolicy",
  staging: "settings.runtimeBackupStaging",
  unknown: "settings.runtimeBackupUnknown",
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
  const toast = useToast();
  const confirm = useConfirm();
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<RuntimeAccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);

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

  const clean = async (home: LegacyRuntimeHomeSummary) => {
    if (loading || error || cleaning || home.incomplete) return;
    setCleaning(home.id);
    try {
      // Prepare performs a fresh bounded scan and in-use check. The confirmation
      // must display this fresh plan, not values from the older card snapshot.
      const plan = await prepareLegacyRuntimeHomeCleanup(home.id);
      const accepted = await confirm({
        title: t("settings.runtimeCleanupTitle", {
          runtime: RUNTIME_LABELS[plan.runtime] || plan.runtime,
        }),
        message: (
          <div className="runtime-cleanup-confirm">
            <p>{t("settings.runtimeCleanupImpact", {
              agents: plan.affectedAgentCount,
              bytes: formatRuntimeBytes(plan.bytes),
            })}</p>
            <p className="runtime-cleanup-warning">{t("settings.runtimeCleanupWarning")}</p>
          </div>
        ),
        confirmLabel: t("settings.runtimeCleanupConfirm"),
        danger: true,
      });
      if (!accepted || !mounted.current) return;
      const result = await commitLegacyRuntimeHomeCleanup(plan.planId);
      toast.success(t("settings.runtimeCleanupDone", {
        bytes: formatRuntimeBytes(result.bytesReleased),
      }));
      await refresh();
    } catch {
      toast.error(t("settings.runtimeCleanupFailed"));
      await refresh();
    } finally {
      if (mounted.current) setCleaning(null);
    }
  };

  const cleanBackup = async (backup: RuntimeBackupSummary) => {
    if (loading || error || cleaning || backup.incomplete) return;
    setCleaning(backup.id);
    try {
      const plan = await prepareRuntimeBackupCleanup(backup.id);
      const accepted = await confirm({
        title: t("settings.runtimeBackupCleanupTitle"),
        message: (
          <div className="runtime-cleanup-confirm">
            <p>{t("settings.runtimeBackupCleanupImpact", {
              category: t(BACKUP_CATEGORY_KEYS[plan.category]),
              bytes: formatRuntimeBytes(plan.bytes),
            })}</p>
            <p className="runtime-cleanup-warning">
              {t("settings.runtimeBackupCleanupWarning")}
            </p>
          </div>
        ),
        confirmLabel: t("settings.runtimeCleanupConfirm"),
        danger: true,
      });
      if (!accepted || !mounted.current) return;
      const result = await commitRuntimeBackupCleanup(plan.planId);
      toast.success(t("settings.runtimeBackupCleanupDone", {
        bytes: formatRuntimeBytes(result.bytesReleased),
      }));
      await refresh();
    } catch {
      toast.error(t("settings.runtimeBackupCleanupFailed"));
      await refresh();
    } finally {
      if (mounted.current) setCleaning(null);
    }
  };

  const accountName = (account: RuntimeAccountCardSnapshot) => account.kind === "shoggoth-managed"
    ? t("settings.runtimeBuiltinName", { runtime: RUNTIME_LABELS[account.runtime] || account.runtime })
    : RUNTIME_LABELS[account.runtime] || account.runtime;
  const oldHomes = snapshot?.accounts.flatMap((account) => account.legacyHomes.filter((home) => home.role === "reclaimable")) || [];
  const oldBackups = snapshot?.backups.filter((backup) => backup.role === "reclaimable") || [];
  const retainedBackups = snapshot?.backups.filter((backup) => backup.role === "retained") || [];
  const candidates = [...oldHomes, ...oldBackups];
  const readyCandidates = candidates.filter((item) => !item.incomplete);
  const cleanableBytes = readyCandidates.reduce((total, item) => total + item.bytes, 0);
  const disabled = loading || error || cleaning !== null;

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
        {account.legacyHomes.filter((home) => home.role === "canonical").map((home) => <p className="ui-hint" key={home.id}>{t("settings.runtimeLegacyRetained", { bytes: formatRuntimeBytes(home.bytes) })}</p>)}
      </div>
    </details>
  );

  const renderCandidate = (item: LegacyRuntimeHomeSummary | RuntimeBackupSummary) => {
    const isBackup = "category" in item;
    return <div key={item.id} className="runtime-cleanup-row">
      <div><strong>{isBackup ? t(BACKUP_CATEGORY_KEYS[item.category]) : t("settings.runtimeOldEnvironment", { runtime: RUNTIME_LABELS[item.runtime] || item.runtime })}</strong>
        <span>{`${item.incomplete ? "≥ " : ""}${formatRuntimeBytes(item.bytes)}`} · {isBackup ? t("settings.runtimeBackupCanClean") : t("settings.runtimeLegacyAgents", { count: item.affectedAgentCount })}</span>
        {item.incomplete && <span className="runtime-incomplete">{t("settings.runtimeScanIncomplete")}</span>}
      </div>
      <button className="ui-cbtn ui-cbtn--sm" disabled={disabled || item.incomplete}
        onClick={() => void (isBackup ? cleanBackup(item) : clean(item))}>
        {t(cleaning === item.id ? "settings.runtimeCleaning" : isBackup ? "settings.runtimeBackupCleanup" : "settings.runtimeCleanup")}
      </button>
    </div>;
  };

  return <section className="settings-section runtime-storage-section" id="settings-runtime-storage" aria-busy={loading}>
    <header className="settings-section-head settings-heading-row">
      <div><h3 className="settings-h">{t("settings.runtimeStorageTitle")}</h3><p className="settings-sech">{t("settings.runtimeStorageDesc")}</p></div>
      <button className="ui-cbtn ui-cbtn--sm" onClick={() => void refresh()} disabled={loading || cleaning !== null}>
        {t(loading ? "settings.runtimeRefreshing" : error ? "settings.retry" : "settings.runtimeRefresh")}
      </button>
    </header>
    {loading && !snapshot && <div className="settings-card"><p className="ui-hint" role="status">{t("settings.runtimeLoading")}</p></div>}
    {error && <div className="settings-card settings-inline-state" role="alert">
      <div><strong>{t("settings.runtimeStorageUnavailable")}</strong><p>{t(snapshot ? "settings.runtimeStorageStale" : "settings.runtimeStorageRetryHint")}</p></div>
      <button className="ui-cbtn ui-cbtn--sm" onClick={onOpenService}>{t("settings.viewServiceStatus")}</button>
    </div>}
    {snapshot && <>
      <article className="settings-card runtime-cleanup-card">
        <div className="runtime-cleanup-overview">
          <span className="runtime-cleanup-symbol" aria-hidden="true">{candidates.length === 0 ? "✓" : "↗"}</span>
          <div><h4>{t("settings.runtimeCleanableSpace")}</h4>
            <strong className="runtime-cleanup-total">{readyCandidates.length ? formatRuntimeBytes(cleanableBytes) : t(candidates.length ? "settings.runtimeNeedsScan" : "settings.runtimeNothingToClean")}</strong>
            <p>{t(candidates.length ? "settings.runtimeCandidateCount" : "settings.runtimeCleanEmptyHint", { count: candidates.length })}</p>
          </div>
        </div>
        {candidates.length > 0 && <div className="runtime-cleanup-list">{oldHomes.map(renderCandidate)}{oldBackups.map(renderCandidate)}</div>}
        <p className="runtime-protection-note">{t("settings.runtimeCleanupScope")}</p>
        {retainedBackups.length > 0 && <details className="runtime-retained">
          <summary>{t("settings.runtimeRetainedCount", { count: retainedBackups.length })}</summary>
          <p className="ui-hint">{t("settings.runtimeBackupsDesc")}</p>
          {retainedBackups.map((backup) => <div key={backup.id}><span>{t(BACKUP_CATEGORY_KEYS[backup.category])}</span><span>{`${backup.incomplete ? "≥ " : ""}${formatRuntimeBytes(backup.bytes)}`}</span></div>)}
        </details>}
      </article>
      <article className="runtime-current-card">
        <header className="runtime-current-head"><div><h4>{t("settings.runtimeCurrentEnvironments")}</h4><p>{t("settings.runtimeCurrentHint")}</p></div><span className="settings-count">{t("settings.readOnly")}</span></header>
        {snapshot.accounts.length ? snapshot.accounts.map(renderAccount) : <p className="ui-hint runtime-accounts-empty">{t("settings.runtimeAccountsEmpty")}</p>}
      </article>
      {updatedAt && <p className="runtime-updated" role="status">{t("settings.runtimeUpdatedAt", { time: updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>}
    </>}
  </section>;
}
