import { useTranslation } from "react-i18next";
import type { UnifiedModel } from "../../types";
import ChatModelMenu from "../ChatModelMenu";

export function openClawModelReference(id: string, provider?: string): string {
  return id ? (provider ? `${provider}/${id}` : id) : "";
}

export function findOpenClawModel(models: UnifiedModel[], reference: string): UnifiedModel | undefined {
  return models.find((model) => openClawModelReference(model.id, model.provider) === reference)
    ?? models.find((model) => model.id === reference);
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
