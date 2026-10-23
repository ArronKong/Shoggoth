import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAgentMemoryImportReport } from "../../api/client";
import ChatMarkdown from "../../components/ChatMarkdown";
import Modal from "../../components/Modal";
import type { AgentMemoryImportReport } from "../../types";
import s from "./AgentMemoryEditor.module.css";

export default function CodexMemoryImportReportDialog({ backendId, agentId, open, onClose }: {
  backendId: string; agentId: string; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<AgentMemoryImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);

  const load = async (append = false) => {
    if (inFlight.current || (append && (!report?.hasMore || report.nextCursor == null))) return;
    const ticket = ++generation.current;
    inFlight.current = true;
    setBusy(true); setError("");
    if (!append) setReport(null);
    try {
      const next = await getAgentMemoryImportReport(backendId, agentId, append ? {
        runId: report!.runId, cursor: report!.nextCursor!, expectedHash: report!.reportHash,
      } : {});
      if (generation.current !== ticket) return;
      if (append && (next.runId !== report?.runId || next.reportHash !== report?.reportHash
        || (next.nextCursor != null && next.nextCursor <= report!.nextCursor!))) {
        throw new Error(t("agents.memoryCodexTask.reportChanged"));
      }
      setReport(append ? { ...next, text: (report?.text || "") + (next.text || "") } : next);
    } catch (cause) {
      if (generation.current === ticket) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ticket) { inFlight.current = false; setBusy(false); }
    }
  };

  useEffect(() => {
    setReport(null); setError(""); setBusy(false);
    if (open) void load();
    return () => { generation.current++; inFlight.current = false; };
  }, [open, backendId, agentId]);

  return <Modal open={open} onClose={onClose} title={t("agents.memoryCodexTask.reportTitle")}
    subtitle={report?.attempt ? t("agents.memoryCodexTask.reportAttempt", {
      attempt: report.attempt, status: t(`agents.memoryCodexTask.runStates.${report.runStatus}`),
    }) : undefined}
    footer={<div className={s.actions}>
      {report?.hasMore && <button type="button" disabled={busy} onClick={() => void load(true)}>
        {t("agents.memoryCodexTask.reportMore")}
      </button>}
      <button type="button" disabled={busy} onClick={() => void load()}>
        {t("agents.memoryCodexTask.reportRefresh")}
      </button>
    </div>}>
    <p className={s.hint}>{t("agents.memoryCodexTask.reportNotice")}</p>
    {error && <p className={s.error} role="alert">{error}</p>}
    {busy && <p className={s.hint} role="status">{t("common.loading")}</p>}
    {report?.text ? <ChatMarkdown text={report.text} className={s.reportBody} />
      : !busy && !error && <p className={s.hint}>{t("agents.memoryCodexTask.reportEmpty")}</p>}
    {report?.hasMore && <p className={s.hint}>{t("agents.memoryCodexTask.reportPartial")}</p>}
  </Modal>;
}
