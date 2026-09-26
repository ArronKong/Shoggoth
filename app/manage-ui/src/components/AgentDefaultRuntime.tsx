import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAgentRuntimeBindings, getRuntimeStatuses, setAgentDefaultBinding } from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { isVisibleRuntime } from "../lib/runtimeVisibility";
import { Field, Option, Select } from "./Field";
import { useToast } from "./ui";
import styles from "./AgentRuntimeBindings.module.css";

export default function AgentDefaultRuntime({ backend, agentId, onChanged }: {
  backend: string; agentId: string; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const cache = usePageCache(`agent:bindings:${backend}:${agentId}`, () => getAgentRuntimeBindings(backend, agentId));
  const status = usePageCache("agent:connected-runtimes", getRuntimeStatuses);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const snapshot = cache.data;
  const connected = status.data?.filter(runtime => runtime.enabled && runtime.releaseEnabled && runtime.installation === "available") || [];
  const bindings = snapshot?.bindings.filter(binding => isVisibleRuntime(binding.runtime)
    && (binding.id === snapshot.defaultBindingId || (binding.enabled
    && connected.some(runtime => runtime.runtime === binding.runtime)
    && snapshot.availability?.find(entry => entry.bindingId === binding.id)?.available !== false))) || [];
  bindings.sort((a, b) => Number(b.id === snapshot?.defaultBindingId) - Number(a.id === snapshot?.defaultBindingId));
  const choices = bindings.filter((binding, index) => bindings.findIndex(other => other.runtime === binding.runtime) === index);
  const visibleDefaultBindingId = choices.find((binding) => binding.id === snapshot?.defaultBindingId)?.id ?? "";
  const select = async (bindingId: string) => {
    if (!snapshot || pendingRef.current || bindingId === snapshot.defaultBindingId) return;
    pendingRef.current = true; setPending(true);
    try {
      const next = await setAgentDefaultBinding(backend, agentId, bindingId, { revision: snapshot.revision });
      cache.replace(next); onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      await cache.refresh();
    } finally { pendingRef.current = false; setPending(false); }
  };
  return <section className={styles.card} aria-busy={pending}>
    <Field label={t("agents.defaultRuntime")} hint={t("agents.defaultRuntimeHint")}>
      <Select title={t("agents.defaultRuntime")} value={visibleDefaultBindingId}
        disabled={pending || cache.loading || status.loading || !!cache.error || !!status.error}
        onChange={bindingId => void select(bindingId)}>
        {choices.map(binding => <Option key={binding.id} value={binding.id}>
          {status.data?.find(runtime => runtime.runtime === binding.runtime)?.name || binding.runtime}
        </Option>)}
      </Select>
    </Field>
    {(cache.error || status.error) && <p className={styles.error} role="alert">{t("agents.sessionRuntimeLoadFailed")} <button
      className="ui-cbtn ui-cbtn--sm" onClick={() => { void cache.refresh(); void status.refresh(); }}>{t("settings.retry")}</button></p>}
  </section>;
}
