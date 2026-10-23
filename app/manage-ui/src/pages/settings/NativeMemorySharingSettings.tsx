import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { getNativeMemorySharingConfig, getNativeMemorySharingContext, updateNativeMemorySharingConfig } from "../../api/client";
import type { NativeMemorySharingContext, NativeMemorySharingProjection, NativeMemorySharingSettings } from "../../types";
import { Switch } from "../../components/Field";
import { changeMemorySharingAgent, memorySharingAgentSelected, sameMemorySharingSettings } from "../../lib/nativeMemoryForm";
import { useNavigationGuard } from "../../lib/navigation-guard";

let pendingWrite: Promise<unknown> = Promise.resolve();
export default function NativeMemorySharingSettings() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<NativeMemorySharingProjection | null>(null);
  const [context, setContext] = useState<NativeMemorySharingContext | null>(null);
  const [draft, setDraft] = useState<NativeMemorySharingSettings>({ enabled: true, excludedProfiles: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [needsReload, setNeedsReload] = useState(false), [saved, setSaved] = useState(false);
  const generation = useRef(0), inFlight = useRef(false);
  const dirty = !!snapshot && !sameMemorySharingSettings(draft, snapshot.config);
  useEffect(() => () => { generation.current++; }, []);
  useNavigationGuard({ dirty, busy, onDiscard: () => { if (snapshot) setDraft(structuredClone(snapshot.config)); } });
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const current = ++generation.current;
    try {
      await pendingWrite.catch(() => {});
      if (generation.current !== current) return;
      // Read applies Core's authoritative projection before querying the
      // effective gate and current dynamic participant inventory.
      const next = await getNativeMemorySharingConfig();
      if (generation.current !== current) return;
      const nextContext = await getNativeMemorySharingContext();
      if (generation.current !== current) return;
      if (nextContext.revision !== next.revision) throw Error("Sharing revision changed");
      setSnapshot(next); setContext(nextContext); setDraft(structuredClone(next.config)); setNeedsReload(false);
    } catch {
      if (generation.current === current) { setError("loadFailed"); setNeedsReload(true); }
    } finally {
      if (generation.current === current) { inFlight.current = false; setBusy(false); }
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || needsReload || !snapshot || !dirty || context?.owner !== "shoggoth-memory-core") return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const current = generation.current;
    const writing = updateNativeMemorySharingConfig({ expectedRevision: snapshot.revision, config: draft });
    pendingWrite = writing.catch(() => {});
    try {
      const next = await writing;
      if (generation.current !== current) return;
      const nextContext = await getNativeMemorySharingContext();
      if (generation.current !== current) return;
      if (nextContext.revision !== next.revision) throw Error("Sharing revision changed");
      setSnapshot(next); setContext(nextContext); setDraft(structuredClone(next.config)); setSaved(true);
    } catch (failure) {
      if (generation.current !== current) return;
      const code = (failure as { code?: string })?.code;
      setError(code === "NATIVE_MEMORY_SHARING_STALE" || code === "NATIVE_MEMORY_SHARING_CONFLICT" ? "conflict"
        : code === "NATIVE_MEMORY_SHARING_INVALID" ? "invalid" : "saveFailed");
      setNeedsReload(code !== "NATIVE_MEMORY_SHARING_INVALID");
    } finally {
      if (generation.current === current) { inFlight.current = false; setBusy(false); }
    }
  };
  const disabled = busy || needsReload || !snapshot || context?.owner !== "shoggoth-memory-core";
  const change = (update: (previous: NativeMemorySharingSettings) => NativeMemorySharingSettings) => {
    if (inFlight.current || needsReload || !snapshot) return;
    setSaved(false); setDraft(update);
  };
  const agents = context?.agents || [];
  const ids = [...new Set([...agents.map(agent => agent.profileId), ...draft.excludedProfiles])];
  return <form onSubmit={event => void save(event)} aria-label={t("nativeMemorySharing.title")}>
    <fieldset className="settings-memory-section" disabled={disabled}>
      <legend>{t("nativeMemorySharing.title")}</legend>
      <p className="ui-hint">{t("nativeMemorySharing.description")}</p>
      <Switch label={t("nativeMemorySharing.enabled")} checked={draft.enabled} disabled={disabled}
        onChange={enabled => change(previous => ({ ...previous, enabled }))} />
      {context?.owner === "legacy" && <p role="status">{t("nativeMemory.inactive")}</p>}
      {context && !context.featureReady && <p role="status" className="ui-hint">{t("nativeMemorySharing.gated")}</p>}
      {context?.featureReady && <p role="status" className="ui-hint">{t(context.effectiveEnabled ? "nativeMemorySharing.on" : "nativeMemorySharing.off")}</p>}
      <div className="settings-memory-agents" role="group" aria-label={t("nativeMemorySharing.participants")}>
        <strong>{t("nativeMemorySharing.participants")}</strong>
        <p className="ui-hint">{t("nativeMemorySharing.participantsHint")}</p>
        {ids.map(id => <Switch key={id} disabled={disabled} checked={memorySharingAgentSelected(draft, id)}
          label={agents.find(agent => agent.profileId === id)?.name || t("nativeMemory.unavailableAgent", { id })}
          onChange={included => change(previous => changeMemorySharingAgent(previous, id, included))} />)}
        {!ids.length && <p className="ui-hint">{t("nativeMemory.noAgents")}</p>}
      </div>
      <p className="ui-hint">{t("nativeMemorySharing.scopeHint")}</p>
      <p className="ui-hint">{t("nativeMemorySharing.providerHint")}</p>
      <p className="ui-hint">{t("nativeMemorySharing.workspaceHint")}</p>
      <p className="ui-hint">{t("nativeMemorySharing.runtimeHint")}</p>
    </fieldset>
    {error && <p className="field-error" role="alert">{t(`nativeMemory.${error}`)}</p>}
    <div className="settings-memory-actions">
      <p role="status">{saved ? t("nativeMemory.saved") : dirty ? t("nativeMemory.unsaved") : snapshot ? t("nativeMemory.loaded") : ""}</p>
      <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => void load()}>{t(dirty ? "nativeMemory.discardReload" : "common.refresh")}</button>
      <button type="submit" className="ui-cbtn ui-cbtn--sm ui-cbtn--primary" disabled={disabled || !dirty}>{t(busy ? "common.saving" : "common.save")}</button>
    </div>
  </form>;
}
