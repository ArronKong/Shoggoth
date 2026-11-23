import { useId } from "react";
import { useTranslation } from "react-i18next";
import { getCronModels } from "../../api/client";
import { usePageCache } from "../../lib/usePageCache";
import type { BackendCronKind, CronModelChoice, UnifiedModel } from "../../types";
import ChatModelMenu, { type ModelMenuChoice } from "../ChatModelMenu";

export function openClawModelReference(id: string, provider?: string): string {
  return id ? (provider ? `${provider}/${id}` : id) : "";
}

export function findOpenClawModel<T extends { id: string; provider?: string }>(models: T[], reference: string): T | undefined {
  return models.find((model) => openClawModelReference(model.id, model.provider) === reference)
    ?? models.find((model) => model.id === reference);
}

function findInheritedModel(models: ModelMenuChoice[], selection: CronModelChoice | undefined, kind?: BackendCronKind) {
  if (!selection?.model) return undefined;
  if ("bindingId" in selection) {
    const choices = models.filter(model => model.bindingId === selection.bindingId
      && model.modelProviderRef === selection.modelProviderRef);
    return choices.find(model => model.id === selection.model)
      ?? (selection.model === "default" ? choices.find(model => model.isDefault) : undefined);
  }
  let matches = models.filter((model) => {
    if (kind === "openclaw") {
      return Boolean(model.provider) && openClawModelReference(model.id, model.provider) === selection.model;
    }
    return model.id === selection.model && (!selection.provider || model.provider === selection.provider);
  });
  if (kind === "openclaw" && matches.length === 0) {
    matches = models.filter((model) => model.id === selection.model);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function CronTaskModelField({ backendId, agentId, kind, value, defaultModelHint, onChange, disabled }: {
  backendId: string;
  agentId: string;
  kind?: BackendCronKind;
  value: CronModelChoice | null;
  defaultModelHint?: string;
  onChange: (value: CronModelChoice | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const ready = Boolean(backendId && agentId && kind);
  const { data, loading, error, refresh } = usePageCache(
    `cron-models:${JSON.stringify([backendId, agentId])}`,
    () => getCronModels(backendId, agentId),
    { enabled: ready, staleTime: 15_000, loadingOnEmptyRefresh: true },
  );
  const models: ModelMenuChoice[] = ready ? data?.models.map(model => ({ ...model, provider: model.provider ?? undefined })) ?? [] : [];
  const inherited = ready ? data?.defaultSelection : undefined;
  const inheritedModel = findInheritedModel(models, inherited, kind);
  const inheritedName = inheritedModel?.name || inherited?.model || defaultModelHint;
  const defaultLabel = inheritedName ? t("cronForm.modelDefaultNamed", { model: inheritedName }) : t("cronForm.modelDefault");
  const native = value && "bindingId" in value ? value : null;
  const current = value
    ? (kind === "openclaw" ? findOpenClawModel(models, value.model) : findInheritedModel(models, value, kind))
    : inheritedModel;
  const provider = value && "provider" in value ? value.provider : current?.provider;
  return (
    <div className="field">
      <span className="field-label" id={labelId}>{t("cronForm.taskModelLabel")}</span>
      <div className="cron-model-picker">
        <ChatModelMenu
          key={JSON.stringify([backendId, agentId])}
          models={models}
          activeModel={current?.id ?? value?.model ?? ""}
          activeProvider={provider}
          activeBindingId={native?.bindingId ?? current?.bindingId}
          activeModelProviderRef={native?.modelProviderRef ?? current?.modelProviderRef}
          runtimeGroups={ready ? data?.runtimes : undefined}
          labelledBy={labelId}
          triggerLabel={!ready ? t("cronForm.modelSelectAgent") : !value ? defaultLabel : undefined}
          disabled={disabled || !ready}
          loading={ready && loading}
          loadError={Boolean(error)}
          onRefresh={() => { if (!loading) void refresh().catch(() => {}); }}
          onSelect={(model, source, bindingId, modelProviderRef) => {
            const usesDefault = inheritedModel?.id === model && inheritedModel.provider === source
              && inheritedModel.bindingId === bindingId && inheritedModel.modelProviderRef === modelProviderRef;
            if (!model || usesDefault) {
              if (value) onChange(null);
            } else if (bindingId) onChange({ model, bindingId, ...(modelProviderRef ? { modelProviderRef } : {}) });
            else if (kind === "openclaw") onChange({ model: openClawModelReference(model, source) });
            else onChange({ model, provider: source });
          }}
          portalInDialog
        />
      </div>
    </div>
  );
}

function findHermesModel(models: UnifiedModel[], id: string, provider: string): UnifiedModel | undefined {
  const candidates = models.filter((model) => model.id === id);
  return candidates.find((model) => model.provider === provider || model.acpProviderRef === provider)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export function OpenClawModelPicker({ models, loading, value, onChange }: {
  models: UnifiedModel[];
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const current = findOpenClawModel(models, value);
  return (
    <div className="cron-model-picker">
      <ChatModelMenu
        models={models}
        activeModel={current?.id || value}
        activeProvider={current?.provider}
        triggerLabel={value ? current?.name || value : t("cronForm.modelDefault")}
        emptyLabel={t("cronForm.modelDefault")}
        onSelect={(id, provider) => onChange(openClawModelReference(id, provider))}
        loading={loading}
        portalInDialog
      />
    </div>
  );
}

export function HermesModelPicker({ models, loading, model, provider, onChange }: {
  models: UnifiedModel[];
  loading: boolean;
  model: string;
  provider: string;
  onChange: (choice: UnifiedModel | null) => void;
}) {
  const { t } = useTranslation();
  const current = findHermesModel(models, model, provider);
  return (
    <div className="cron-model-picker">
      <ChatModelMenu
        models={models}
        activeModel={current?.id || model}
        activeProvider={current?.provider}
        triggerLabel={model ? current?.name || model : t("cronForm.modelDefault")}
        emptyLabel={t("cronForm.modelDefault")}
        onSelect={(id, pickedProvider) => {
          if (!id) {
            onChange(null);
            return;
          }
          onChange(models.find((choice) => choice.id === id && choice.provider === pickedProvider)
            ?? models.find((choice) => choice.id === id)
            ?? null);
        }}
        loading={loading}
        portalInDialog
      />
    </div>
  );
}

function refsFromText(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function OpenClawFallbackPicker({ models, loading, value, onChange }: {
  models: UnifiedModel[];
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const refs = refsFromText(value);
  const selectedRefs = refs.map((reference) => {
    const current = findOpenClawModel(models, reference);
    return current ? openClawModelReference(current.id, current.provider) : reference;
  });
  const remove = (reference: string) => onChange(refs.filter((item) => item !== reference).join(", "));
  const toggle = (id: string, provider?: string) => {
    const qualified = openClawModelReference(id, provider);
    const index = refs.findIndex((reference) => reference === qualified || reference === id);
    onChange((index >= 0 ? refs.filter((_, itemIndex) => itemIndex !== index) : [...refs, qualified]).join(", "));
  };
  return (
    <div className="cron-fallback-picker">
      {refs.map((reference) => (
        <span className="cron-model-chip" key={reference}>
          <span>{reference}</span>
          <button type="button" onClick={() => remove(reference)} aria-label={t("cronForm.modelRemove", { model: reference })}>×</button>
        </span>
      ))}
      <div className="cron-model-picker">
        <ChatModelMenu
          models={models}
          activeModel=""
          selectedRefs={selectedRefs}
          triggerLabel={refs.length
            ? t("cronForm.modelFallbackCount", { count: refs.length })
            : t("cronForm.modelFallbackAdd")}
          onSelect={toggle}
          loading={loading}
          portalInDialog
        />
      </div>
    </div>
  );
}
