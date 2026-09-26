import { useTranslation } from "react-i18next";
import { Option, Select, Switch, TextInput } from "../../components/Field";
import OAuthLoginModal from "../keys/OAuthLoginModal";
import { EFFORT_VALUES, type AgentModelSettingsState } from "./useAgentModelSettings";
import ov from "../AgentsPage.module.css";
import styles from "./AgentModelSettings.module.css";

/**
 * 概览右侧信息栅格里的主模型区：provider + model 选择（含未配置 provider 的行内
 * 激活/引导）和跟着主模型能力门控的默认参数。渲染成一组 `ovField`，与概览其余
 * 字段共用同一套栅格类名，不是独立卡片。
 *
 * 重设置（辅助模型 / MoA / 回退链）在 AgentModelCards 里，两者共用一份
 * useAgentModelSettings 状态（由 AgentsPage 持有），不各拉一次快照。
 */
export default function AgentMainModelField({ state }: { state: AgentModelSettingsState }) {
  const { t } = useTranslation();
  const {
    loading,
    supported,
    error,
    main,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    mainSelectionValid,
    mainProviderOptions,
    selectedProviderRow,
    needsSetup,
    setupIsApiKey,
    setupIsCustom,
    applying,
    doApplyMain,
    apiKeyDraft,
    setApiKeyDraft,
    activating,
    doActivateApiKey,
    startProviderSetup,
    oauthSetup,
    setOauthSetup,
    reasoningSupported,
    fastSupported,
    effortValue,
    fastOn,
    writeDefault,
    reload,
  } = state;

  if (loading && !supported) {
    return (
      <div className={`${ov.ovField} ${ov.ovFieldWide}`}>
        <span className={ov.ovLabel}>{t("agents.model")}</span>
        <span className={ov.ovValue}>{t("common.loading")}</span>
      </div>
    );
  }
  if (!supported) return null;

  return (
    <>
      {error && (
        <div className={ov.ovFieldWide}>
          <div className="ui-banner ui-banner--warn" role="status">
            <span>{t("models.settings.loadFailed", { msg: error })}</span>
          </div>
        </div>
      )}

      <div className={`${ov.ovField} ${ov.ovFieldWide}`}>
        <span className={ov.ovLabel}>{t("agents.model")}</span>
        <div className={styles.mainRow}>
          <Select value={selectedProvider} onChange={(v) => setSelectedProvider(v)}>
            {!selectedProvider && <Option value="">{t("models.settings.provider")}</Option>}
            {mainProviderOptions.map((p) => (
              <Option key={p.slug || "none"} value={p.slug}>
                {p.name || p.slug}
              </Option>
            ))}
          </Select>
          {needsSetup ? (
            setupIsApiKey ? (
              <>
                <TextInput
                  type="password"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void doActivateApiKey();
                  }}
                  placeholder={t("models.settings.pasteKeyPlaceholder", {
                    env: selectedProviderRow?.keyEnv || "API key",
                  })}
                  autoComplete="off"
                  spellCheck={false}
                  className={styles.keyInput}
                />
                <button
                  className="ui-cbtn ui-cbtn--gold"
                  onClick={() => void doActivateApiKey()}
                  disabled={!apiKeyDraft.trim() || activating}
                >
                  {activating ? t("models.settings.activating") : t("models.settings.activate")}
                </button>
              </>
            ) : (
              <button className="ui-cbtn" onClick={() => void startProviderSetup()}>
                {setupIsCustom
                  ? t("models.settings.openEndpoints")
                  : t("models.settings.setupProvider", {
                      name: selectedProviderRow?.name || selectedProvider,
                    })}
              </button>
            )
          ) : (
            <>
              <Select value={selectedModel} onChange={(v) => setSelectedModel(v)}>
                {!selectedModel && <Option value="">{t("models.settings.model")}</Option>}
                {(selectedProviderRow?.models ?? []).map((m) => (
                  <Option
                    key={m}
                    value={m}
                    disabled={selectedProviderRow?.unavailableModels?.includes(m) === true}
                  >
                    {m}
                  </Option>
                ))}
              </Select>
              <button
                className="ui-cbtn ui-cbtn--gold"
                onClick={() => void doApplyMain()}
                disabled={!mainSelectionValid || applying}
              >
                {applying ? t("models.settings.applying") : t("common.apply")}
              </button>
            </>
          )}
          <span className={styles.currentNote}>
            {main.provider && t("models.settings.current", { provider: main.provider, model: main.model })}
          </span>
        </div>
        {needsSetup && !setupIsApiKey && selectedProviderRow && (
          <span className={ov.ovHint}>
            {selectedProviderRow.authType === "api_key"
              ? t("models.settings.needsKeyHint", {
                  name: selectedProviderRow.name,
                  env: selectedProviderRow.keyEnv || "API key",
                })
              : t("models.settings.needsOauthHint", { name: selectedProviderRow.name })}
          </span>
        )}
        {selectedProviderRow?.warning && (
          <span className={ov.ovHint}>{selectedProviderRow.warning}</span>
        )}
        {!needsSetup && selectedProvider && !mainSelectionValid && (
          <span className={ov.ovHint}>{t("models.settings.selectValidModel")}</span>
        )}
      </div>

      {/* 默认参数按当前主模型能力门控（官方 Defaults 行同款），各自成一个栅格字段。 */}
      {reasoningSupported && main.provider && (
        <div className={ov.ovField}>
          <span className={ov.ovLabel}>{t("models.settings.reasoning")}</span>
          <Select value={effortValue} onChange={(v) => void writeDefault({ reasoningEffort: v })}>
            {EFFORT_VALUES.map((v) => (
              <Option key={v} value={v}>
                {v === "none" ? t("models.settings.reasoningOff") : v}
              </Option>
            ))}
          </Select>
        </div>
      )}
      {fastSupported && main.provider && (
        <div className={ov.ovField}>
          <span className={ov.ovLabel}>{t("models.settings.fast")}</span>
          <Switch
            checked={fastOn}
            onChange={(v) => void writeDefault({ serviceTier: v ? "fast" : "normal" })}
            label={t("models.settings.fast")}
          />
        </div>
      )}

      {oauthSetup && (
        <OAuthLoginModal
          provider={oauthSetup}
          onClose={() => {
            setOauthSetup(null);
            reload();
          }}
        />
      )}
    </>
  );
}
