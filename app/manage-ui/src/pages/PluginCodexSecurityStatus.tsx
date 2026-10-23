import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCodexSecurityStatus, type CodexSecurityStatus } from "../api/client";
import styles from "./PluginCodexSecurityStatus.module.css";

export function PluginCodexSecurityStatus({ installationId, nativeAgentId }: {
  installationId: string | null; nativeAgentId: string | null;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexSecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setFailed(false); setStatus(null);
    void getCodexSecurityStatus({ installationId, agentId: nativeAgentId }).then(value => {
      if (active) setStatus(value);
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [installationId, nativeAgentId, retry]);

  const installed = status?.installation.integrity === "verified";
  const installationLabel = !installed ? "plugins.securityStatusNotInstalled"
    : status?.installation.pendingDisable ? "plugins.securityStatusDisabling"
      : status?.installation.state === "disabled" ? "plugins.securityStatusDisabled" : "plugins.securityStatusVerified";
  const accountLabel = status?.authentication === "authenticated" ? "plugins.securityStatusAccountConnected"
    : status?.authentication === "unauthenticated" ? "plugins.securityStatusAccountMissing" : "plugins.securityStatusAccountUnobserved";

  return <section className={styles.panel} aria-labelledby="codex-security-status-title">
    <div className={styles.heading}>
      <h3 id="codex-security-status-title">{t("plugins.securityStatusTitle")}</h3>
      <button className={styles.refresh} type="button" disabled={loading}
        onClick={() => setRetry(value => value + 1)}>{t("plugins.securityStatusRefresh")}</button>
    </div>
    {loading && <p className={styles.message} role="status">{t("plugins.securityStatusLoading")}</p>}
    {failed && <p className={styles.message} role="alert">{t("plugins.securityStatusUnavailable")}</p>}
    {status && <>
      <dl className={styles.rows}>
        <div><dt>{t("plugins.securityStatusInstallation")}</dt><dd>{t(installationLabel)}
          {installed && <small>{t("plugins.securityStatusComponents", {
            skills: status.installation.skillCount, mcp: status.installation.mcpCount,
          })}</small>}
        </dd></div>
        <div><dt>{t("plugins.securityStatusAccount")}</dt><dd>{t(accountLabel)}</dd></div>
        <div><dt>{t("plugins.securityStatusScan")}</dt><dd><span className={styles.pending}>{t("plugins.securityStatusScanPending")}</span></dd></div>
      </dl>
      <p className={styles.note}>{t("plugins.securityStatusScanExplanation")}</p>
      <p className={styles.source}>{t("plugins.securityStatusAccountExplanation")} {t("plugins.securityStatusSource", {
        version: status.source.version, files: status.source.fileCount,
      })}</p>
    </>}
  </section>;
}
