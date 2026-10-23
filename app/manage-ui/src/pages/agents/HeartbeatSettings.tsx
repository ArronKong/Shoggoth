import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, Switch, TextInput } from "../../components/Field";
import { useToast } from "../../components/ui";
import "../../i18n/heartbeatResources";
import s from "./HeartbeatSettings.module.css";

export interface HeartbeatMonitor {
  revision: number;
  config: {
    id: string; kind: "heartbeat"; profileId: string; enabled: boolean;
    schedule: { kind: "every"; everyMs: number; anchorMs: number }; timezone: string;
    activeHours: { start: string; end: string } | null; push: boolean;
    budget: { maxRunsPerDay: number; maxTokensPerDay: number };
    checklist: unknown[]; scopes: { inspiration: boolean; runIds: string[] }; target: { mode: string; sessionKey?: string }; review: null;
  };
}
interface Scratch { revision: number; content: string; updatedAt: number }
interface Status { reason: string | null; lastCheckAt: number | null; lastNoticeAt: number | null;
  capabilities: { deterministic: boolean; semanticVerified: boolean; reason: string | null } }
async function call<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch("/__api/proactive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, params }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Heartbeat request failed");
  return data;
}
export default function HeartbeatSettings({ profileId }: { profileId: string }) {
  const { t } = useTranslation(); const toast = useToast();
  const [monitor, setMonitor] = useState<HeartbeatMonitor | null>(null);
  const [draft, setDraft] = useState<HeartbeatMonitor["config"] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [scratch, setScratch] = useState<Scratch | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current; setMonitor(null); setDraft(null); setStatus(null); setScratch(null); setError("");
    void Promise.all([
      call<{ monitor: HeartbeatMonitor; status: Status }>("proactive.monitor.get", { kind: "heartbeat", profileId }),
      call<{ scratch: Scratch }>("proactive.scratch.get", { profileId }),
    ]).then(([value, notes]) => { if (ticket === generation.current) { setMonitor(value.monitor); setDraft(value.monitor.config); setStatus(value.status); setScratch(notes.scratch); } })
      .catch(e => { if (ticket === generation.current) setError(String(e.message || e)); });
    return () => { generation.current++; };
  }, [profileId, generation]);
  async function save() {
    if (!draft || !monitor) return;
    const ticket = generation.current; setBusy(true); setError("");
    try {
      const result = await call<{ monitor: HeartbeatMonitor; status: Status }>("proactive.monitor.set", {
        operationId: crypto.randomUUID(), expectedRevision: monitor.revision, config: draft,
      });
      if (ticket !== generation.current) return;
      setMonitor(result.monitor); setDraft(result.monitor.config); setStatus(result.status); toast.success(t("heartbeat.saved"));
    } catch(e) { if (ticket === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  async function resetScratch() {
    if (!scratch) return; const ticket = generation.current; setBusy(true); setError("");
    try {
      const value = await call<{ scratch: Scratch }>("proactive.scratch.set", { profileId, content: "", expectedRevision: scratch.revision });
      if (ticket === generation.current) setScratch(value.scratch);
    } catch(e) { if (ticket === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (ticket === generation.current) setBusy(false); }
  }
  if (!draft) return <div className={s.panel} role={error ? "alert" : undefined}>{error || t("common.loading")}</div>;
  const invalid = !Number.isInteger(draft.schedule.everyMs) || draft.schedule.everyMs < 60000
    || !Number.isInteger(draft.budget.maxRunsPerDay) || draft.budget.maxRunsPerDay < 1 || draft.budget.maxRunsPerDay > 48
    || !Number.isInteger(draft.budget.maxTokensPerDay) || draft.budget.maxTokensPerDay < 1024 || draft.budget.maxTokensPerDay > 10000000;
  return <section className={s.panel} data-heartbeat-settings aria-label={t("heartbeat.title")}>
    <div className={s.top}><label className={s.toggle}><Switch checked={draft.enabled} disabled={busy}
      onChange={enabled => setDraft({ ...draft, enabled })} /><span>{t("heartbeat.enabled")}</span></label>
      <button className={s.button} type="button" disabled={busy || invalid} onClick={() => void save()}>{busy ? t("common.saving") : t("heartbeat.save")}</button></div>
    <p className={s.hint}>{t("heartbeat.hint")}</p>
    <div className={s.grid}>
      <Field label={t("heartbeat.interval")}><TextInput type="number" min={1} value={draft.schedule.everyMs / 60000} disabled={busy}
        onChange={e => setDraft({ ...draft, schedule: { ...draft.schedule, everyMs: Number(e.target.value) * 60000 } })} /></Field>
      <Field label={t(draft.timezone === "system" ? "heartbeat.systemTimezone" : "heartbeat.timezone")}><TextInput
        value={draft.timezone === "system" ? Intl.DateTimeFormat().resolvedOptions().timeZone : draft.timezone}
        readOnly={draft.timezone === "system"} disabled={busy} onChange={e => setDraft({ ...draft, timezone: e.target.value })} /></Field>
      <Field label={t("heartbeat.runs")}><TextInput type="number" min={1} max={48} value={draft.budget.maxRunsPerDay} disabled={busy}
        onChange={e => setDraft({ ...draft, budget: { ...draft.budget, maxRunsPerDay: Number(e.target.value) } })} /></Field>
      <Field label={t("heartbeat.tokens")}><TextInput type="number" min={1024} max={10000000} value={draft.budget.maxTokensPerDay} disabled={busy}
        onChange={e => setDraft({ ...draft, budget: { ...draft.budget, maxTokensPerDay: Number(e.target.value) } })} /></Field>
    </div>
    <div className={s.row}><label className={s.toggle}><Switch checked={draft.activeHours !== null} disabled={busy}
      onChange={enabled => setDraft({ ...draft, activeHours: enabled ? { start: "08:00", end: "22:00" } : null })} /><span>{t("heartbeat.hours")}</span></label>
      {draft.activeHours && <><input type="time" aria-label={t("heartbeat.start")} value={draft.activeHours.start} disabled={busy}
        onChange={e => setDraft({ ...draft, activeHours: { ...draft.activeHours!, start: e.target.value } })} />
        <span>–</span><input type="time" aria-label={t("heartbeat.end")} value={draft.activeHours.end} disabled={busy}
          onChange={e => setDraft({ ...draft, activeHours: { ...draft.activeHours!, end: e.target.value } })} /></>}
      <label className={s.toggle}><Switch checked={draft.push} disabled={busy}
        onChange={push => setDraft({ ...draft, push })} /><span>{t("heartbeat.push")}</span></label></div>
    {status && <p className={s.hint}>{t("heartbeat.lastCheck")}: {status.lastCheckAt ? new Date(status.lastCheckAt).toLocaleString() : "—"}
      {status.reason ? " · " + t("heartbeat.reasons." + status.reason, { defaultValue: status.reason }) : ""}
      {!status.capabilities.deterministic || !status.capabilities.semanticVerified
        ? " · " + t("heartbeat.unavailable") : ""}</p>}
    <details><summary>{t("heartbeat.scratch")}</summary><p className={s.hint}>{t("heartbeat.scratchHint")}</p>
      <pre className={s.notes}>{scratch?.content || t("heartbeat.emptyScratch")}</pre>
      <button className={s.button} type="button" disabled={busy || !scratch?.content} onClick={() => void resetScratch()}>{t("heartbeat.reset")}</button></details>
    {error && <p role="alert" className={s.error}>{error}</p>}
  </section>;
}
