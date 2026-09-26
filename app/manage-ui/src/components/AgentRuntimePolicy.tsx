import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAgentRuntimePolicy, setAgentRuntimePolicy } from "../api/client";
import type { AgentRuntimeBinding, RuntimeSelectionPolicy } from "../types";
import { usePageCache } from "../lib/usePageCache";
import { Field, Option, Select, Switch, TextInput } from "./Field";
import { useToast } from "./ui";
import styles from "./AgentRuntimeBindings.module.css";

export default function AgentRuntimePolicy({ backend, agentId, bindings, checkpointBindingIds }: {
  backend: string; agentId: string; bindings: AgentRuntimeBinding[]; checkpointBindingIds: string[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const cache = usePageCache(`agent:runtime-policy:${backend}:${agentId}`, () => getAgentRuntimePolicy(backend, agentId));
  const [draft, setDraft] = useState<RuntimeSelectionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (cache.data) setDraft(cache.data); }, [cache.data]);
  if (!draft) return <p className={cache.error ? styles.error : "ui-hint"}>{cache.error || t("common.loading")}</p>;
  const update = (patch: Partial<RuntimeSelectionPolicy>) => setDraft({ ...draft, ...patch });
  const toggle = (id: string, enabled: boolean) => {
    const allowedBindingIds = enabled ? [...draft.allowedBindingIds, id] : draft.allowedBindingIds.filter(key => key !== id);
    const weights = Object.fromEntries(Object.entries(draft.weights).filter(([key]) => allowedBindingIds.includes(key)));
    update({ allowedBindingIds, weights, preferredBindingIds: enabled ? [...draft.preferredBindingIds, id]
      : draft.preferredBindingIds.filter(key => key !== id) });
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try { cache.replace(await setAgentRuntimePolicy(backend, agentId, draft)); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); await cache.refresh(); }
    finally { setSaving(false); }
  };
  return <div className={styles.add} aria-busy={saving}>
    <Field label={t("agents.runtimePolicyTitle")} hint={t(`agents.runtimePolicyHint.${draft.mode}`)}>
      <Select value={draft.mode} disabled={saving} onChange={mode => update({ mode: mode as RuntimeSelectionPolicy["mode"] })}>
        {(["fixed", "preferred", "auto"] as const).map(mode => <Option key={mode} value={mode}>{t(`agents.runtimePolicyMode.${mode}`)}</Option>)}
      </Select>
    </Field>
    {draft.mode !== "fixed" && <>
      <p className="ui-hint">{t("agents.runtimePolicyAllowed")}</p>
      {bindings.map(binding => {
        const selected = draft.allowedBindingIds.includes(binding.id);
        const index = draft.preferredBindingIds.indexOf(binding.id);
        return <div key={binding.id} className={styles.actions}>
          <Switch checked={selected} disabled={saving || !binding.enabled} label={binding.label || `${binding.runtime} · ${binding.runtimeAccountId}`}
            onChange={enabled => toggle(binding.id, enabled)} />
          {selected && draft.mode === "preferred" && <button className="ui-cbtn ui-cbtn--sm" disabled={saving || index <= 0}
            onClick={() => { const next = [...draft.preferredBindingIds]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update({ preferredBindingIds: next }); }}>
            {t("agents.runtimePolicyPriority", { order: index + 1 })} ↑</button>}
          {selected && draft.mode === "auto" && <TextInput type="number" min={1} max={100} aria-label={t("agents.runtimePolicyWeight")}
            value={draft.weights[binding.id] ?? 1} disabled={saving} onChange={event => update({ weights: { ...draft.weights,
              [binding.id]: Math.max(1, Math.min(100, Number(event.target.value) || 1)) } })} />}
        </div>;
      })}
      <Switch checked={draft.affinity} disabled={saving} label={t("agents.runtimePolicyAffinity")} onChange={affinity => update({ affinity })} />
    </>}
    <Field label={t("agents.runtimeSummaryBinding")} hint={t("agents.runtimeSummaryHint")}>
      <Select value={draft.compactionBindingId || ""} disabled={saving} onChange={id => update({ compactionBindingId: id || null })}>
        <Option value="">{t("agents.runtimeSummaryAutomatic")}</Option>
        {bindings.filter(binding => binding.enabled && checkpointBindingIds.includes(binding.id))
          .map(binding => <Option key={binding.id} value={binding.id}>{binding.label || binding.runtime} · {binding.runtimeAccountId}</Option>)}
      </Select>
    </Field>
    <div className={styles.actions}><button className="ui-cbtn ui-cbtn--sm" disabled={saving || (draft.mode !== "fixed" && !draft.allowedBindingIds.length)
      || JSON.stringify(draft) === JSON.stringify(cache.data)} onClick={() => void save()}>{t("common.save")}</button></div>
  </div>;
}
