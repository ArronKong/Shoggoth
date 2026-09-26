import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useTranslation } from "react-i18next";
import { ApiError, getShoggothProductStatus, getShoggothStopImpact, runShoggothBackgroundAction } from "../../api/client";
import type { ShoggothProductStatus, ShoggothStopImpact } from "../../types";
import modal from "../../components/ui.module.css";
import styles from "./BackgroundStopDialog.module.css";

export function BackgroundStopImpact({ impact }: { impact: ShoggothStopImpact }) {
  const { t } = useTranslation();
  return <>
    {(impact.availability === "unavailable" || impact.totalCount === 0) && <p>
      {t(impact.availability === "unavailable" ? "settings.stopImpactUnknown" : "settings.stopImpactEmpty")}
    </p>}
    {impact.runs.length > 0 && <ul className={styles.runs}>
      {impact.runs.map((run) => <li key={run.runId}>
        <div className={styles.runHeading}>
          <strong>{run.title || t(`settings.stopSource.${run.source}`) + " · " + run.runId.slice(0, 8)}</strong>
          <span className={styles.status}>{t(`settings.stopState.${run.status}`)}</span>
        </div>
        <div className={styles.metadata}>{run.agentName || t("settings.stopUnknownAgent")} · {t(`settings.stopSource.${run.source}`)}</div>
      </li>)}
    </ul>}
    {(impact.totalCount ?? 0) > impact.runs.length && <p>{t("settings.stopImpactMore", {
      count: impact.totalCount! - impact.runs.length,
    })}</p>}
    {(impact.totalCount ?? 0) > 0 && <p className={styles.note}>{t("settings.stopImpactInterrupted")}</p>}
    <p className={styles.note}>{t("settings.stopImpactRetained")}</p>
  </>;
}

export default function BackgroundStopDialog({ onCancel, onStopped }: {
  onCancel: () => void;
  onStopped: (status: ShoggothProductStatus) => void;
}) {
  const { t } = useTranslation();
  const [impact, setImpact] = useState<ShoggothStopImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(false);
  const [changed, setChanged] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const busy = useRef(false);
  const reads = useRef(0);
  const sequence = useRef(0);

  const refresh = useCallback(async (showLoading = false) => {
    if (!showLoading && reads.current > 0) return;
    reads.current += 1;
    const request = ++sequence.current;
    if (showLoading) setLoading(true);
    try {
      const next = await getShoggothStopImpact();
      if (!active.current || sequence.current !== request) return;
      setImpact(next);
      setError(false);
    } catch {
      if (!active.current || sequence.current !== request) return;
      // Never leave an actionable stale snapshot after a failed refresh.
      setImpact(null);
      setError(true);
    } finally {
      reads.current -= 1;
      if (active.current && sequence.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh(true);
    const timer = window.setInterval(() => { if (!busy.current) void refresh(); }, 5_000);
    return () => { active.current = false; sequence.current += 1; window.clearInterval(timer); };
  }, [refresh]);

  const stop = async () => {
    if (!impact || loading || busy.current) return;
    busy.current = true;
    sequence.current += 1;
    setStopping(true);
    setError(false);
    try {
      const status = await runShoggothBackgroundAction("stop", impact.revision);
      if (active.current) onStopped(status);
    } catch (failure) {
      if (!active.current) return;
      if (failure instanceof ApiError && failure.code === "SHOGGOTH_STOP_IMPACT_CHANGED") {
        setChanged(true);
        await refresh(true);
      } else {
        // launchd can finish stopping after its action response times out.
        const status = await getShoggothProductStatus().catch(() => null);
        if (!active.current) return;
        if (status?.background.supported && status.background.loaded === false) onStopped(status);
        else { setError(true); setImpact(null); }
      }
    } finally {
      busy.current = false;
      if (active.current) setStopping(false);
    }
  };

  return <AlertDialog.Root open onOpenChange={(open) => { if (!open && !busy.current) onCancel(); }}>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className={modal.modalOverlay} />
      <AlertDialog.Popup className={modal.modalPanel} initialFocus={cancelRef}>
        <AlertDialog.Title className={modal.modalTitle}>
          {impact?.availability === "available" && (impact.totalCount ?? 0) > 0
            ? t("settings.stopImpactCount", { count: impact.totalCount }) : t("settings.stopConfirmTitle")}
        </AlertDialog.Title>
        <div className={`${modal.modalBody} ${styles.body}`} aria-busy={loading || stopping}>
          {changed && <p role="status" className={styles.notice}>{t("settings.stopImpactChanged")}</p>}
          {loading && <p role="status">{t("settings.stopImpactLoading")}</p>}
          {error && <p role="alert">{t("settings.stopImpactFailed")}</p>}
          {!loading && impact && <BackgroundStopImpact impact={impact} />}
        </div>
        <div className={modal.modalFoot}>
          <button ref={cancelRef} className="btn-secondary btn-md" disabled={stopping} onClick={onCancel}>{t("common.cancel")}</button>
          {error && !impact ? <button className="btn-primary btn-md" disabled={loading || stopping} onClick={() => void refresh(true)}>{t("settings.retry")}</button>
            : <button className="btn-danger btn-md" disabled={!impact || loading || stopping} onClick={() => void stop()}>
              {t(stopping ? "settings.stopInProgress" : impact?.availability === "unavailable" ? "settings.stopDespiteUnknown" : "settings.stopConfirmAction")}
            </button>}
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
