import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAgentRuntimeBindings, getSessionRuntime, switchSessionRuntime } from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { sessionRuntimeSupportKey } from "../lib/sessionRuntimeSupport";
import { useConfirm, useToast } from "./ui";
import Modal from "./Modal";
import AgentRuntimeBindings from "./AgentRuntimeBindings";
import styles from "./SessionRuntimeControl.module.css";

export default function SessionRuntimeControl({ backend, agentId, sessionKey, busy, connected, permissionMode = null, onInterrupt, onChanged }: {
  backend: string; agentId: string; sessionKey: string; busy: boolean; connected: boolean;
  permissionMode?: string | null;
  onInterrupt: () => Promise<void>; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const cache = usePageCache(`session:runtime:${backend}:${sessionKey}`, async () => {
    const [session, bindings] = await Promise.all([getSessionRuntime(backend, agentId, sessionKey), getAgentRuntimeBindings(backend, agentId)]);
    return { session, bindings };
  });
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(false);
  const wasBusy = useRef(busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (wasBusy.current && !busy) { setWaiting(false); void cache.refresh(); }
    wasBusy.current = busy;
  }, [busy, cache.refresh]);
  const current = cache.data?.session;
  const blocked = busy || !connected || pending || cache.loading || !!cache.error;
  const unsupported = (code: string) => t(sessionRuntimeSupportKey(code) ?? "agents.sessionRuntimeFactsUnknown");
  const choose = async (bindingId: string) => {
    if (blocked || !current?.canSwitch || pendingRef.current || bindingId === current.bindingId) return;
    const candidate = current.candidates.find((entry) => entry.bindingId === bindingId);
    if (!candidate?.support.supported) return;
    pendingRef.current = true; setPending(true);
    let acceptAdjustments = false;
    const changes = [candidate.adjustments.clearModelOverride ? t("agents.sessionRuntimeClearModel") : null,
      candidate.adjustments.permissionMode !== permissionMode ? (candidate.adjustments.permissionMode
        ? t("agents.sessionRuntimePermissionChange", { mode: candidate.adjustments.permissionMode })
        : t("agents.sessionRuntimePermissionReset")) : null].filter(Boolean);
    if (changes.length) {
      acceptAdjustments = await confirm({ title: t("agents.sessionRuntimeConfirmTitle"),
        message: `${changes.join("\n")}\n\n${t("agents.sessionRuntimeHistoryHint")}`, confirmLabel: t("agents.sessionRuntimeConfirm") });
      if (!acceptAdjustments || !mounted.current) { pendingRef.current = false; if (mounted.current) setPending(false); return; }
    }
    try {
      const session = await switchSessionRuntime(backend, agentId, sessionKey, { bindingId, revision: current.revision, acceptAdjustments });
      if (cache.data) cache.replace({ ...cache.data, session });
      if (mounted.current) { onChanged(); setOpen(false); }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      await cache.refresh();
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  const interrupt = async () => {
    if (pendingRef.current || !connected) return;
    pendingRef.current = true; setPending(true);
    try { await onInterrupt(); if (mounted.current) setWaiting(true); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  return <div className={styles.root}>
    <button type="button" className={`ui-cbtn ui-cbtn--sm ${styles.trigger}`} aria-haspopup="dialog"
      aria-expanded={open} aria-label={t("agents.sessionRuntimeSwitch")}
      onClick={() => { setManaging(false); setOpen(true); void cache.refresh(); }}>
      <span>{t("agents.sessionRuntimeSwitch")}</span>
      {current && <span className={styles.model}>{current.runtime}</span>}
      <span aria-hidden="true">⌄</span>
    </button>
    <Modal open={open} onClose={() => setOpen(false)} dismissible={!pending} width={560}
      title={t(managing ? "agents.sessionRuntimeManage" : "agents.sessionRuntimeTitle")}
      subtitle={t(managing ? "agents.sessionRuntimeManageHint" : "agents.sessionRuntimeHistoryHint")}
      footer={managing ? <button className="ui-cbtn" onClick={() => { setManaging(false); void cache.refresh(); }}>{t("agents.sessionRuntimeBack")}</button> : undefined}>
    {managing ? <AgentRuntimeBindings backend={backend} agentId={agentId} onChanged={() => { void cache.refresh(); onChanged(); }} />
      : <div className={styles.panel} aria-busy={pending || cache.loading}>
      {cache.error && <p role="alert">{t("agents.sessionRuntimeLoadFailed")} <button className="ui-cbtn ui-cbtn--sm" onClick={() => void cache.refresh()}>{t("settings.retry")}</button></p>}
      {!current ? <p>{t("agents.sessionRuntimeLoading")}</p> : <>
        {!current.canSwitch && <p className={styles.hint}>{t("agents.sessionRuntimeFeatureDisabled")}</p>}
        {busy && <div className={styles.busy}>
          <p>{t(waiting ? "agents.sessionRuntimeWaiting" : "agents.sessionRuntimeBusy")}</p>
          <div className={styles.actions}>
            <button className="ui-cbtn ui-cbtn--sm" disabled={pending} onClick={() => setWaiting(true)}>{t("agents.sessionRuntimeWait")}</button>
            <button className="ui-cbtn ui-cbtn--sm" disabled={pending || !connected} onClick={() => void interrupt()}>{t("agents.sessionRuntimeInterrupt")}</button>
          </div>
        </div>}
        <ul className={styles.list}>{current.candidates.map((candidate) => {
          const binding = cache.data?.bindings.bindings.find((entry) => entry.id === candidate.bindingId);
          const availability = cache.data?.bindings.availability?.find((entry) => entry.bindingId === candidate.bindingId);
          const selected = candidate.bindingId === current.bindingId;
          const reason = availability?.available === false ? t(availability.reason === "runtime-disabled" ? "agents.bindingRuntimeDisabled" : "agents.bindingRuntimeUnavailable")
            : candidate.support.supported ? null : unsupported(candidate.support.code);
          return <li key={candidate.bindingId}>
            <button className={styles.option} type="button" aria-pressed={selected}
              disabled={blocked || !current.canSwitch || selected || !!reason || !binding} onClick={() => void choose(candidate.bindingId)}>
              <span>{binding?.label || binding?.runtime || t("agents.sessionRuntimeUnknownBinding")}{selected && <span className={styles.current}>{t("agents.sessionRuntimeCurrent")}</span>}</span>
              {binding?.label && <small>{binding.runtime}</small>}{reason && <small>{reason}</small>}
            </button>
          </li>;
        })}</ul>
        {current.candidates.length < 2 && <p className={styles.hint}>{t("agents.sessionRuntimeSingleBinding")}</p>}
      </>}
      <div className={styles.manage}>
        <button type="button" className="ui-cbtn" disabled={pending || !connected} onClick={() => setManaging(true)}>{t("agents.sessionRuntimeManage")}</button>
      </div>
    </div>}
    </Modal>
  </div>;
}
