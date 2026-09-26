import { useTranslation } from "react-i18next";
import type { MoaConfig } from "../../types";
import { Option, Select, Switch, TextInput } from "../../components/Field";
import { withActive, type AgentModelSettingsState } from "./useAgentModelSettings";
import styles from "./AgentModelSettings.module.css";

/**
 * 概览下方的重设置卡片：陈旧辅助槽警告 + 辅助模型 + Mixture of Agents + 后备模型链。
 * 全宽，摆在「左卡片 + 右信息栅格」两列区之后。
 *
 * 状态来自 AgentsPage 持有的 useAgentModelSettings（与 AgentMainModelField 共用同一份
 * 快照）。主模型本身在信息栅格里，不在这里。
 */
export default function AgentModelCards({ state }: { state: AgentModelSettingsState }) {
  const { t } = useTranslation();
  const {
    supported,
    providers,
    main,
    aux,
    modelsForProvider,
    taskLabel,
    taskHint,
    editingAuxTask,
    setEditingAuxTask,
    auxDraft,
    setAuxDraft,
    auxBusy,
    writeAux,
    beginAuxEdit,
    staleSlots,
    staleProvider,
    moa,
    selectedMoaPreset,
    setSelectedMoaPreset,
    newMoaPresetName,
    setNewMoaPresetName,
    moaBusy,
    currentMoaPreset,
    moaSlotProviders,
    moaIncomplete,
    saveMoaNow,
    updateMoaPreset,
    patchMoaSlot,
    fallbackRows,
    commitFallbacks,
  } = state;

  if (!supported) return null;

  return (
    <div className={styles.pane} data-testid="agent-model-cards">
      {/* 陈旧辅助槽警告（切换响应的 staleAux 优先；否则持久检测） */}
      {staleSlots.length > 0 && (
        <div className="ui-banner ui-banner--warn" role="status">
          <span>
            {t("models.settings.staleAuxWarn", {
              count: staleSlots.length,
              names: staleSlots.map((s) => taskLabel(s.task)).join(", "),
              provider: staleProvider,
            })}
          </span>
          <button
            className="ui-cbtn ui-cbtn--sm"
            onClick={() => void writeAux("__reset__", "", "", t("models.settings.auxResetOk"))}
            disabled={auxBusy}
          >
            {t("models.settings.resetAllToMain")}
          </button>
        </div>
      )}

      {/* 辅助模型（官方 8 任务行同款：Set to main / Change） */}
      {aux.slots.length > 0 && (
        <section className={styles.card}>
          <div className="ui-secthead">
            <span className="ui-secthead-title">{t("models.settings.auxTitle")}</span>
            <span className="ui-count">{aux.slots.length}</span>
            <span className="ui-toolbar-end">
              <button
                className="ui-cbtn ui-cbtn--sm"
                onClick={() => void writeAux("__reset__", "", "", t("models.settings.auxResetOk"))}
                disabled={auxBusy || !main.provider}
              >
                {t("models.settings.resetAllToMain")}
              </button>
            </span>
          </div>
          <p className="ui-hint">{t("models.settings.auxDesc")}</p>
          <div className={styles.auxList}>
            {aux.slots.map((s) => {
              const isAuto = !s.provider || s.provider === "auto";
              const isEditing = editingAuxTask === s.task;
              const hint = taskHint(s.task);
              return (
                <div key={s.task} className={styles.auxRow}>
                  <div className={styles.auxMeta}>
                    <span className={styles.auxLabel}>
                      {taskLabel(s.task)}
                      {hint && <span className={styles.auxPill}>{hint}</span>}
                    </span>
                    <span className={styles.auxCurrent}>
                      {isAuto
                        ? t("models.settings.autoUseMain")
                        : `${s.provider} · ${s.model || t("models.settings.providerDefault")}`}
                    </span>
                  </div>
                  {!isEditing && (
                    <div className={styles.auxActions}>
                      <button
                        className="ui-cbtn ui-cbtn--sm"
                        onClick={() =>
                          void writeAux(s.task, main.provider, main.model, t("models.settings.auxSavedOk"))
                        }
                        disabled={auxBusy || !main.provider}
                      >
                        {t("models.settings.setToMain")}
                      </button>
                      <button
                        className="ui-cbtn ui-cbtn--sm"
                        onClick={() => beginAuxEdit(s.task)}
                        disabled={auxBusy || providers.length === 0}
                      >
                        {t("models.settings.change")}
                      </button>
                    </div>
                  )}
                  {isEditing && (
                    <div className={styles.auxEdit}>
                      <Select
                        value={auxDraft.provider}
                        onChange={(v) => setAuxDraft({ provider: v, model: "" })}
                      >
                        {!auxDraft.provider && <Option value="">{t("models.settings.provider")}</Option>}
                        {providers.map((p) => (
                          <Option key={p.slug || "none"} value={p.slug}>
                            {p.name || p.slug}
                          </Option>
                        ))}
                      </Select>
                      <Select
                        value={auxDraft.model}
                        onChange={(v) => setAuxDraft((prev) => ({ ...prev, model: v }))}
                      >
                        {!auxDraft.model && <Option value="">{t("models.settings.model")}</Option>}
                        {withActive(modelsForProvider(auxDraft.provider), auxDraft.model).map((m) => (
                          <Option key={m} value={m}>
                            {m}
                          </Option>
                        ))}
                      </Select>
                      <button
                        className="ui-cbtn ui-cbtn--sm ui-cbtn--gold"
                        onClick={() =>
                          void writeAux(s.task, auxDraft.provider, auxDraft.model, t("models.settings.auxSavedOk"))
                        }
                        disabled={!auxDraft.provider || !auxDraft.model || auxBusy}
                      >
                        {t("common.apply")}
                      </button>
                      <button className="ui-cbtn ui-cbtn--sm" onClick={() => setEditingAuxTask(null)}>
                        {t("common.cancel")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Mixture of Agents（官方预设编辑器同款） */}
      {moa && currentMoaPreset && (
        <section className={styles.card}>
          <div className="ui-secthead">
            <span className="ui-secthead-title">{t("models.settings.moaTitle")}</span>
          </div>
          <p className="ui-hint">{t("models.settings.moaDesc")}</p>
          <div className={styles.moaToolbar}>
            <Select value={selectedMoaPreset || moa.defaultPreset} onChange={(v) => setSelectedMoaPreset(v)}>
              {Object.keys(moa.presets).map((name) => (
                <Option key={name} value={name}>
                  {name}
                </Option>
              ))}
            </Select>
            <Switch
              checked={currentMoaPreset.enabled !== false}
              onChange={(v) => updateMoaPreset((prev) => ({ ...prev, enabled: v }))}
              label={t("models.settings.moaEnabled")}
              disabled={moaBusy}
            />
            <button
              className="ui-cbtn ui-cbtn--sm"
              onClick={() => void saveMoaNow({ ...moa, defaultPreset: selectedMoaPreset || moa.defaultPreset })}
              disabled={moaBusy}
            >
              {t("models.settings.moaSetDefault")}
            </button>
            <button
              className="ui-cbtn ui-cbtn--sm"
              onClick={() => {
                if (Object.keys(moa.presets).length <= 1) return;
                const presets = { ...moa.presets };
                delete presets[selectedMoaPreset];
                const fallback = Object.keys(presets)[0];
                const next: MoaConfig = {
                  ...moa,
                  presets,
                  defaultPreset: moa.defaultPreset === selectedMoaPreset ? fallback : moa.defaultPreset,
                  activePreset: moa.activePreset === selectedMoaPreset ? "" : moa.activePreset,
                };
                setSelectedMoaPreset(Object.keys(moa.presets).find((n) => n !== selectedMoaPreset) || "");
                void saveMoaNow(next);
              }}
              disabled={Object.keys(moa.presets).length <= 1 || moaBusy}
            >
              {t("common.delete")}
            </button>
            <TextInput
              value={newMoaPresetName}
              onChange={(e) => setNewMoaPresetName(e.target.value)}
              placeholder={t("models.settings.moaNewPlaceholder")}
              className={styles.moaPresetInput}
            />
            <button
              className="ui-cbtn ui-cbtn--sm"
              onClick={() => {
                const name = newMoaPresetName.trim();
                if (!name || moa.presets[name]) return;
                const next: MoaConfig = {
                  ...moa,
                  presets: {
                    ...moa.presets,
                    [name]: {
                      ...currentMoaPreset,
                      referenceModels: [...currentMoaPreset.referenceModels],
                    },
                  },
                };
                setSelectedMoaPreset(name);
                setNewMoaPresetName("");
                void saveMoaNow(next);
              }}
              disabled={!newMoaPresetName.trim() || !!moa.presets[newMoaPresetName.trim()] || moaBusy}
            >
              {t("models.settings.moaAddPreset")}
            </button>
          </div>
          <p className={styles.moaDefaultNote}>
            {t("models.settings.moaDefaultIs", { name: moa.defaultPreset })}
            {moaIncomplete && ` — ${t("models.settings.moaIncompleteHint")}`}
          </p>
          <div className={styles.moaSlots}>
            {currentMoaPreset.referenceModels.map((slot, index) => (
              <div key={`${selectedMoaPreset}-${index}`} className={styles.moaSlotRow}>
                <span className={styles.moaSlotName}>
                  {t("models.settings.moaReference", { index: index + 1 })}
                </span>
                <Select
                  value={slot.provider}
                  onChange={(v) =>
                    updateMoaPreset((prev) => ({
                      ...prev,
                      referenceModels: prev.referenceModels.map((s, i) =>
                        i === index ? patchMoaSlot(s, { provider: v }) : s,
                      ),
                    }))
                  }
                >
                  {!slot.provider && <Option value="">{t("models.settings.provider")}</Option>}
                  {withActive(moaSlotProviders.map((p) => p.slug), slot.provider).map((slug) => (
                    <Option key={slug} value={slug}>
                      {moaSlotProviders.find((p) => p.slug === slug)?.name || slug}
                    </Option>
                  ))}
                </Select>
                <Select
                  value={slot.model}
                  onChange={(v) =>
                    updateMoaPreset((prev) => ({
                      ...prev,
                      referenceModels: prev.referenceModels.map((s, i) =>
                        i === index ? patchMoaSlot(s, { model: v }) : s,
                      ),
                    }))
                  }
                >
                  {!slot.model && <Option value="">{t("models.settings.model")}</Option>}
                  {withActive(modelsForProvider(slot.provider), slot.model).map((m) => (
                    <Option key={m} value={m}>
                      {m}
                    </Option>
                  ))}
                </Select>
                <Switch
                  checked={slot.enabled !== false}
                  onChange={(v) =>
                    updateMoaPreset((prev) => ({
                      ...prev,
                      referenceModels: prev.referenceModels.map((s, i) =>
                        i === index ? { ...s, enabled: v } : s,
                      ),
                    }))
                  }
                  disabled={moaBusy}
                />
                <button
                  className="ui-cbtn ui-cbtn--sm"
                  onClick={() =>
                    updateMoaPreset((prev) => ({
                      ...prev,
                      referenceModels: prev.referenceModels.filter((_, i) => i !== index),
                    }))
                  }
                  disabled={currentMoaPreset.referenceModels.length <= 1 || moaBusy}
                >
                  {t("models.settings.moaRemove")}
                </button>
              </div>
            ))}
            <div>
              <button
                className="ui-cbtn ui-cbtn--sm"
                onClick={() =>
                  updateMoaPreset((prev) => ({
                    ...prev,
                    referenceModels: [...prev.referenceModels, { ...prev.aggregator, enabled: true }],
                  }))
                }
                disabled={moaBusy}
              >
                {t("models.settings.moaAddReference")}
              </button>
            </div>
            <div className={styles.moaSlotRow}>
              <span className={styles.moaSlotName}>{t("models.settings.moaAggregator")}</span>
              <Select
                value={currentMoaPreset.aggregator.provider}
                onChange={(v) =>
                  updateMoaPreset((prev) => ({
                    ...prev,
                    aggregator: patchMoaSlot(prev.aggregator, { provider: v }),
                  }))
                }
              >
                {!currentMoaPreset.aggregator.provider && (
                  <Option value="">{t("models.settings.provider")}</Option>
                )}
                {withActive(moaSlotProviders.map((p) => p.slug), currentMoaPreset.aggregator.provider).map(
                  (slug) => (
                    <Option key={slug} value={slug}>
                      {moaSlotProviders.find((p) => p.slug === slug)?.name || slug}
                    </Option>
                  ),
                )}
              </Select>
              <Select
                value={currentMoaPreset.aggregator.model}
                onChange={(v) =>
                  updateMoaPreset((prev) => ({
                    ...prev,
                    aggregator: patchMoaSlot(prev.aggregator, { model: v }),
                  }))
                }
              >
                {!currentMoaPreset.aggregator.model && (
                  <Option value="">{t("models.settings.model")}</Option>
                )}
                {withActive(
                  modelsForProvider(currentMoaPreset.aggregator.provider),
                  currentMoaPreset.aggregator.model,
                ).map((m) => (
                  <Option key={m} value={m}>
                    {m}
                  </Option>
                ))}
              </Select>
            </div>
          </div>
        </section>
      )}

      {/* 后备模型链（fallback_providers；官方 FallbackModelsField 同款） */}
      <section className={styles.card}>
        <div className="ui-secthead">
          <span className="ui-secthead-title">{t("models.settings.fallbackTitle")}</span>
          {fallbackRows.length > 0 && <span className="ui-count">{fallbackRows.length}</span>}
        </div>
        <p className="ui-hint">{t("models.settings.fallbackDesc")}</p>
        {fallbackRows.length === 0 && <p className={styles.emptyNote}>{t("models.settings.fallbackEmpty")}</p>}
        <div className={styles.moaSlots}>
          {fallbackRows.map((row, index) => (
            <div key={index} className={styles.moaSlotRow}>
              <span className={styles.moaSlotName}>{index + 1}</span>
              <Select
                value={row.provider}
                onChange={(v) =>
                  commitFallbacks(
                    fallbackRows.map((r, i) => (i === index ? { provider: v, model: "" } : r)),
                  )
                }
              >
                {!row.provider && <Option value="">{t("models.settings.provider")}</Option>}
                {providers
                  .filter((p) => p.slug)
                  .map((p) => (
                    <Option key={p.slug} value={p.slug}>
                      {p.name || p.slug}
                    </Option>
                  ))}
              </Select>
              <Select
                value={row.model}
                onChange={(v) =>
                  commitFallbacks(fallbackRows.map((r, i) => (i === index ? { ...r, model: v } : r)))
                }
              >
                {!row.model && <Option value="">{t("models.settings.model")}</Option>}
                {withActive(modelsForProvider(row.provider), row.model).map((m) => (
                  <Option key={m} value={m}>
                    {m}
                  </Option>
                ))}
              </Select>
              <button
                className="ui-cbtn ui-cbtn--sm"
                onClick={() => commitFallbacks(fallbackRows.filter((_, i) => i !== index))}
              >
                {t("models.settings.moaRemove")}
              </button>
            </div>
          ))}
          <div>
            <button
              className="ui-cbtn ui-cbtn--sm"
              onClick={() => commitFallbacks([...fallbackRows, { provider: "", model: "" }])}
            >
              {t("models.settings.fallbackAdd")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
