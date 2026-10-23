import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { controlCodexCronRun, getCodexCronRunResult } from "../../api/client";
import type { CodexAutomationRunResult, CronRun, UnifiedCronJob } from "../../types";
import { toSanitizedMarkdownHtml } from "../../lib/markdown";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../ChatPromptCard";
import "./CodexAutomation.css";

const ACTIVE = ["preparing", "queued", "starting", "running", "waiting_approval", "waiting_input"];
export default function CodexCronRunResult({ job, run, onClose, onChanged }: {
  job: UnifiedCronJob; run: CronRun; onClose: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<CodexAutomationRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(true);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    let current = true; let timer: ReturnType<typeof setTimeout>;
    alive.current = true; setResult(null); setError(null);
    async function load() {
      try {
        const value = await getCodexCronRunResult(job.id, run.runId!);
        if (!current) return;
        setResult(value); setError(null);
        if (ACTIVE.includes(value.executionStatus || "")) timer = setTimeout(load, 2000);
      } catch (error) { if (current) setError(error instanceof Error ? error.message : String(error)); }
    }
    void load();
    return () => { current = false; alive.current = false; clearTimeout(timer); };
  }, [job.id, run.runId, retry]);
  const control = async (action: "stop" | "approval" | "input" | "cancel-input", requestId: string | null, choice: string | null, answers: Record<string, string> = {}) => {
    if (pending.current) {
      if (action !== "stop") throw new Error(t("chat.requestFailed"));
      return;
    }
    const operationId = crypto.randomUUID(); pending.current = operationId; setSubmitting(true);
    try {
      await controlCodexCronRun(job.id, { runId: run.runId!, operationId, action, requestId, choice, answers });
      if (alive.current) { setRetry(value => value + 1); onChanged(); }
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
      if (action !== "stop") throw error;
    }
    finally { pending.current = null; if (alive.current) setSubmitting(false); }
  };
  const respond = async (entry: ChatPromptEntry, data: ChatPromptResponse) => {
    const canonical = "version" in entry && entry.version === 1 ? entry : null;
    const requestId = canonical?.requestId || entry.requestId || null;
    if (result?.interaction?.type === "approval") await control("approval", requestId, data.choice || null);
    else await control(data.action === "cancel" ? "cancel-input" : "input", requestId, null, data.answers || {});
  };
  const value = result || run;
  return <section className="codex-run-detail" aria-label={t("codexAutomation.result")}>
    <div className="codex-run-meta"><strong>{t("codexAutomation.result")}</strong><span>{t(`codexAutomation.origins.${value.executionOrigin || "shoggoth"}`)}</span>
      <span>{t(`codexAutomation.statuses.${value.executionStatus || "unknown"}`, { defaultValue: value.executionStatus || "unknown" })}</span>
      <button type="button" onClick={() => setRetry(value => value + 1)}>{t("cronForm.runsRefresh")}</button><button type="button" onClick={onClose}>{t("common.close")}</button>
    </div>
    <div className="codex-run-meta">{value.model && <span>{t("cron.model")}: {value.model}</span>}{value.reasoningEffort && <span>{t("codexAutomation.reasoning")}: {t(`codexAutomation.efforts.${value.reasoningEffort}`, { defaultValue: value.reasoningEffort })}</span>}{value.workspace && <span>{value.workspace}</span>}</div>
    {value.error && <p className="codex-source-error" role="alert">{value.error}</p>}
    {error && <p className="codex-source-error" role="alert">{error}</p>}
    {!result && !error && <p className="muted">{t("common.loading")}</p>}
    {result?.interaction && <ChatPromptCard entry={{ ...result.interaction.payload, id: result.interaction.payload.requestId }} onRespond={respond} agentName={job.name} />}
    {result && (result.available ? <>
      {!result.outputComplete && <p className="codex-source-note">{t("codexAutomation.partialOutput")}</p>}
      {result.fullText ? <div className="chat-md codex-run-output" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(result.fullText, true) }} /> : <p className="muted">{t("codexAutomation.noOutput")}</p>}
    </> : <><p className="codex-source-note">{t("codexAutomation.resultUnavailable")}</p>{result.summary && <pre className="detail-pre">{result.summary}</pre>}</>)}
    {value.executionOrigin === "shoggoth" && ACTIVE.includes(value.executionStatus || "") && <button type="button" disabled={submitting} onClick={() => void control("stop", null, null)}>{t("codexAutomation.stopRun")}</button>}
  </section>;
}
