import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getAgentDefaultModels, selectAgentDefaultModel } from "../../api/client";
import { useToast } from "../../components/ui";
import { usePageCache } from "../../lib/usePageCache";
import ChatModelMenu from "../ChatModelMenu";
import styles from "../AgentsPage.module.css";

export default function AgentDefaultModel({ backend, agentId, model, labelId, onChanged }: {
  backend: string;
  agentId: string;
  model?: string;
  labelId: string;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const cache = usePageCache(`agent:default-models:${backend}:${agentId}`,
    () => getAgentDefaultModels(backend, agentId), { enabled: false });
  const { data } = cache;
  const mounted = useRef(false);
  const reading = useRef(false), writing = useRef(false);
  const [refreshing, setRefreshing] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = async () => {
    if (reading.current || writing.current) return;
    reading.current = true;
    setRefreshing(true);
    try { await cache.refresh(); }
    finally {
      reading.current = false;
      if (mounted.current) setRefreshing(false);
    }
  };
  const choose = async (model: string, _provider?: string, bindingId?: string, modelProviderRef?: string) => {
    if (!bindingId || !data || cache.error || writing.current) return;
    writing.current = true;
    setSaving(true);
    try {
      const selection = await selectAgentDefaultModel(backend, agentId, { model, bindingId,
        revision: data.selection.revision, ...(modelProviderRef ? { modelProviderRef } : {}) });
      cache.replace({ ...data, selection });
      if (mounted.current) onChanged();
    } catch (error) {
      if (mounted.current) {
        const code = error instanceof ApiError ? error.code : undefined;
        toast.error(t(code === "AGENT_BINDING_REVISION_CONFLICT" ? "agents.defaultModelConflict"
          : code === "STORE_COMMIT_UNCERTAIN" ? "agents.defaultModelSaveUnknown"
          : ["PROFILE_MODEL_NOT_AVAILABLE", "SESSION_MODEL_PROVIDER_UNAVAILABLE", "NATIVE_RUNTIME_DISABLED",
            "AGENT_BINDING_DISABLED", "RUNTIME_NOT_INSTALLED"].includes(code ?? "") ? "agents.defaultModelUnavailable"
          : code === "PROFILE_AUTH_REQUIRED" ? "agents.defaultModelSignIn"
          : "agents.defaultModelSaveFailed"));
      }
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const activeModel = data ? data.selection.model ?? "" : model ?? "";
  return (
    <div className={`${styles.ovField} ${styles.ovFieldWide}`}>
      <div className={`${styles.modelPicker} ${styles.defaultModelPicker}`}>
        <ChatModelMenu labelledBy={labelId} portalTo="[data-agent-overview-panel]"
          models={cache.error ? [] : data?.models ?? []} runtimeGroups={data?.runtimes ?? []}
          activeModel={activeModel} activeBindingId={data?.selection.bindingId}
          activeModelProviderRef={data?.selection.modelProviderRef}
          triggerLabel={activeModel ? undefined : t("agents.chooseDefaultModel")}
          loading={cache.loading || refreshing} loadError={!!cache.error}
          pending={saving} onRefresh={() => void refresh()} onSelect={choose} />
      </div>
    </div>
  );
}
