import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getNativeCapacity, updateNativeCapacity } from "../../api/client";
import { Field, Switch, TextInput } from "../../components/Field";
import { useToast } from "../../components/ui";
import { usePageCache } from "../../lib/usePageCache";
import type { NativeCapacitySnapshot } from "../../types";
import styles from "./NativeCapacityCard.module.css";

type Draft = { maxActive: string; startupConcurrency: string; enabled: boolean };
const toDraft = (value: NativeCapacitySnapshot): Draft => ({
  maxActive: String(value.maxActive), startupConcurrency: String(value.startupConcurrency), enabled: value.enabled,
});
const validLimit = (value: string, max: number) => /^\d+$/u.test(value)
  && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max;

export default function NativeCapacityCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const cache = usePageCache("settings:native-capacity", getNativeCapacity);
  const [draft, setDraft] = useState<Draft | null>(cache.data ? toDraft(cache.data) : null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const dirty = useRef(false);
  const savingRef = useRef(false);
  const snapshotRef = useRef(cache.data);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Draft | null>(null);
  const persistRef = useRef<(next: Draft) => Promise<void>>();
  snapshotRef.current = cache.data;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        if (pending.current) void persistRef.current?.(pending.current);
      }
    };
  }, []);
  useEffect(() => {
    if (cache.data && !dirty.current && !savingRef.current) setDraft(toDraft(cache.data));
  }, [cache.data, saving]);
  useEffect(() => {
    const poll = setInterval(() => { if (!savingRef.current && !dirty.current) void cache.refresh(); }, 3000);
    return () => clearInterval(poll);
  }, [cache.refresh]);

  const persist = async (next: Draft) => {
    timer.current = null;
    pending.current = null;
    const previous = snapshotRef.current;
    if (!previous || savingRef.current || !validLimit(next.maxActive, 100) || !validLimit(next.startupConcurrency, 16)) return;
    savingRef.current = true;
    if (mounted.current) setSaving(true);
    try {
      const saved = await updateNativeCapacity({
        expectedRevision: previous.revision, maxActive: Number(next.maxActive),
        startupConcurrency: Number(next.startupConcurrency), enabled: next.enabled,
      });
      dirty.current = false;
      cache.replace(saved);
      if (mounted.current) setDraft(toDraft(saved));
    } catch (error) {
      dirty.current = false;
      if (mounted.current) {
        setDraft(toDraft(previous));
      }
      toast.error(t("settings.autoSaveFailed", { msg: error instanceof Error ? error.message : String(error) }));
      await cache.refresh();
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  persistRef.current = persist;
  const change = (patch: Partial<Draft>, immediate = false) => {
    if (!draft || savingRef.current || cache.error) return;
    const next = { ...draft, ...patch };
    dirty.current = true;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (!validLimit(next.maxActive, 100) || !validLimit(next.startupConcurrency, 16)) return;
    if (immediate) void persist(next);
    else {
      pending.current = next;
      timer.current = setTimeout(() => void persist(next), 350);
    }
  };
  const disabled = cache.loading || !!cache.error || saving;
  const queueLabel = (reason: string) => {
    if (reason === "GLOBAL_CAPACITY") return t("settings.nativeCapacityQueueGlobal");
    if (["STARTUP_BACKPRESSURE", "HOST_CAPACITY"].includes(reason)) return t("settings.nativeCapacityQueueStartup");
    if (reason.includes("SESSION")) return t("settings.nativeCapacityQueueSession");
    if (reason.includes("WORKSPACE")) return t("settings.nativeCapacityQueueWorkspace");
    if (reason.includes("ACCOUNT")) return t("settings.nativeCapacityQueueAccount");
    if (reason.includes("PROFILE")) return t("settings.nativeCapacityQueueProfile");
    return t("settings.nativeCapacityQueueOther");
  };

  return <section className="settings-section" id="settings-native-capacity">
    <header className="settings-section-head">
      <h3 className="settings-h">{t("settings.nativeCapacityTitle")}</h3>
      <p className="settings-sech">{t("settings.nativeCapacityDescription")}</p>
    </header>
    <div className={`settings-card ${styles.card}`} aria-busy={saving}>
      {cache.error && <div className="settings-inline-state" role="alert">
        <div><strong>{t("settings.nativeCapacityUnavailable")}</strong><p>{t("settings.nativeCapacityRetry")}</p></div>
        <button className="ui-cbtn ui-cbtn--sm" onClick={() => void cache.refresh()}>{t("settings.retry")}</button>
      </div>}
      {!draft ? <p className="ui-hint">{t("common.loading")}</p> : <>
        <div className="settings-heading-row">
          <div><h4 id="native-capacity-enabled">{t("settings.nativeCapacityEnable")}</h4>
            <p>{t(draft.enabled ? "settings.nativeCapacityEnabled" : "settings.nativeCapacityDisabled")}</p></div>
          <Switch checked={draft.enabled} disabled={disabled || !validLimit(draft.maxActive, 100) || !validLimit(draft.startupConcurrency, 16)} ariaLabelledBy="native-capacity-enabled"
            onChange={(enabled) => change({ enabled }, true)} />
        </div>
        <div className={styles.fields}>
          <Field label={t("settings.nativeCapacityMax")} hint={t("settings.nativeCapacityMaxHint")}
            error={!validLimit(draft.maxActive, 100) ? t("settings.nativeCapacityRange", { max: 100 }) : undefined}>
            <TextInput type="number" inputMode="numeric" min={1} max={100} step={1} value={draft.maxActive} disabled={disabled}
              onChange={(event) => change({ maxActive: event.target.value })} />
          </Field>
          <Field label={t("settings.nativeCapacityStartup")} hint={t("settings.nativeCapacityStartupHint")}
            error={!validLimit(draft.startupConcurrency, 16) ? t("settings.nativeCapacityRange", { max: 16 }) : undefined}>
            <TextInput type="number" inputMode="numeric" min={1} max={16} step={1} value={draft.startupConcurrency} disabled={disabled}
              onChange={(event) => change({ startupConcurrency: event.target.value })} />
          </Field>
        </div>
        {cache.data && !cache.error && <dl className={styles.counts}>
          <div><dt>{t("settings.nativeCapacityActive")}</dt><dd>{cache.data.active}</dd></div>
          <div><dt>{t("settings.nativeCapacityQueued")}</dt><dd>{cache.data.queued}</dd></div>
        </dl>}
        {cache.data && !cache.error && cache.data.byReason.length > 0 && <ul className={styles.reasons}>
          {cache.data.byReason.map((entry) => <li key={entry.reason}>{queueLabel(entry.reason)}<span>{entry.count}</span></li>)}
        </ul>}
      </>}
      <p className="ui-hint">{t("settings.nativeCapacityLimitNotice")}</p>
    </div>
  </section>;
}
