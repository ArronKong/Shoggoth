import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSessionMemoryStatus } from "../api/client";
import type { SessionMemoryStatus } from "../types";
import Modal from "./Modal";
import styles from "./ChatMemoryStatus.module.css";

export default function ChatMemoryStatus({ backendId, agentId, sessionKey, connected, running }: {
  backendId: string; agentId: string; sessionKey: string; connected: boolean; running: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<SessionMemoryStatus | null>(null);
  const [failed, setFailed] = useState(false), [checking, setChecking] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => { setVisible(!document.hidden); if (document.hidden) { setOpen(false); setSnapshot(null); } };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  // Recall details are authorization-sensitive and never enter the shared page
  // cache. Closing, hiding, changing session or disconnecting drops their bytes.
  useEffect(() => {
    setSnapshot(null); setFailed(false); setChecking(false);
    if (!connected || !visible) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setChecking(true);
      try {
        const next = await getSessionMemoryStatus(backendId, agentId, sessionKey, open, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(next); setFailed(false);
        if (!next.supported) return;
      } catch {
        if (controller.signal.aborted) return;
        setSnapshot(null); setFailed(true);
      } finally { if (!controller.signal.aborted) setChecking(false); }
      if (!controller.signal.aborted) timer = setTimeout(read, running ? 1000 : open ? 5000 : 30000);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [backendId, agentId, sessionKey, connected, running, open, refresh, visible]);
  if (!connected || !visible || snapshot?.supported === false || !snapshot && !failed && !open) return null;
  const state = snapshot?.supported ? snapshot : null;
  const label = failed ? t("memoryStatus.error") : !state ? t("common.loading")
    : t(`memoryStatus.${state.phase === "complete" && state.outcome ? `outcome.${state.outcome}` : `phase.${state.phase}`}`);
  return <>
    <button type="button" className={styles.trigger} data-memory-status={state?.phase || "unavailable"}
      aria-label={t("memoryStatus.title")} onClick={() => setOpen(true)}>
      {t("memoryStatus.short")} · {label}
    </button>
    {open && <Modal open title={t("memoryStatus.title")} subtitle={t("memoryStatus.description")} width={640}
      onClose={() => { setOpen(false); setSnapshot(null); }}
      footer={<button type="button" className="btn-subtle" disabled={checking} onClick={() => setRefresh(value => value + 1)}>{t("common.refresh")}</button>}>
      <div className={styles.details}>
        <p role="status">{label}</p>
        {state?.updatedAt != null && <time dateTime={new Date(state.updatedAt).toISOString()}>{new Date(state.updatedAt).toLocaleString()}</time>}
        {state?.statusLines.map((line, index) => <pre key={`status-${index}`}>{line}</pre>)}
        {!!state?.traceLines.length && <section aria-label={t("memoryStatus.details")}>
          <h4>{t("memoryStatus.details")}</h4>{state.traceLines.map((line, index) => <pre key={index}>{line}</pre>)}
        </section>}
        {state?.phase === "stale" && <p>{t("memoryStatus.staleHint")}</p>}
      </div>
    </Modal>}
  </>;
}
