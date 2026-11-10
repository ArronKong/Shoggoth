import { useTranslation } from "react-i18next";
import { Option, Select, Switch, TextInput } from "../../components/Field";
import ChatModelMenu from "../ChatModelMenu";
import OAuthLoginModal from "../keys/OAuthLoginModal";
import { EFFORT_VALUES, type AgentModelSettingsState } from "./useAgentModelSettings";
import ov from "../AgentsPage.module.css";
import styles from "./AgentModelSettings.module.css";

// Keep the existing setup/default handlers while the overview shows only the model picker.
const SHOW_MODEL_OPTIONS = false;

/**
 * 概览右侧信息栅格里的主模型区：共用模型菜单（含未配置 provider 的行内
 * 激活/引导）和跟着主模型能力门控的默认参数。渲染成一组 `ovField`，与概览其余
 * 字段共用同一套栅格类名，不是独立卡片。
 *
 * 重设置（辅助模型 / MoA / 回退链）在 AgentModelCards 里，两者共用一份
 * useAgentModelSettings 状态（由 AgentsPage 持有），不各拉一次快照。
 */
export default function AgentMainModelField({ state, labelId }: { state: AgentModelSettingsState; labelId: string }) {
  const { t } = useTranslation();
  const {
    loading,
    supported,
    error,
    main,
    providers,
    selectedProvider,
    setSelectedProvider,
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
        <span className={ov.ovValue}>{t("common.loading")}</span>
      </div>
    );
  }
  if (!supported) return null;

  const models = providers.flatMap((provider) => provider.models.map((id) => ({
    id, name: id, provider: provider.slug,
    disabled: provider.unavailableModels?.includes(id),
    pricing: provider.pricing?.[id],
  })));
  const mainProvider = providers.find((provider) => provider.slug === main.provider);

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
        <div className={styles.mainRow}>
          <div className={`${ov.modelPicker} ${ov.defaultModelPicker}`}>
            <ChatModelMenu
              labelledBy={labelId}
              portalTo="[data-agent-overview-panel]"
              models={error ? [] : models}
              providerNames={Object.fromEntries(providers.map((provider) => [provider.slug, provider.name]))}
              activeModel={main.model}
              activeProvider={main.provider}
              triggerLabel={main.model ? undefined : t("agents.chooseDefaultModel")}
              loading={loading}
              loadError={!!error}
              pending={applying || activating}
              onRefresh={reload}
              onSelect={(model, provider) => { if (provider) void doApplyMain(provider, model); }}
            />
          </div>
          {SHOW_MODEL_OPTIONS && <details className={styles.providerSetup}>
            <summary>{t("models.settings.configureProviders")}</summary>
            <div className={styles.providerSetupBody}>
              <div className={styles.mainProvider}>
                <Select hideIcon title={t("models.settings.provider")} value={selectedProvider} onChange={(v) => setSelectedProvider(v)}>
                  {!selectedProvider && <Option value="">{t("models.settings.provider")}</Option>}
                  {mainProviderOptions.map((p) => (
                    <Option key={p.slug || "none"} value={p.slug}>
                      {p.name || p.slug}
                    </Option>
                  ))}
                </Select>
              </div>
              <div className={`${styles.mainSelection} ${needsSetup ? styles.mainSetup : ""}`}>
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
                ) : <span className={ov.ovHint}>{t("models.settings.chooseFromMenu")}</span>}
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
            </div>
          </details>}
        </div>
        {mainProvider?.warning && <span className={ov.ovHint}>{mainProvider.warning}</span>}
      </div>

      {/* 默认参数按主模型能力门控，紧凑排列在同一行，窄窗自然换行。 */}
      {SHOW_MODEL_OPTIONS && main.provider && (reasoningSupported || fastSupported) && (
        <div className={`${ov.ovFieldWide} ${styles.overviewDefaults}`}>
          {reasoningSupported && (
            <div className={`${ov.ovField} ${styles.reasoningField}`}>
              <span className={ov.ovLabel}>{t("models.settings.reasoning")}</span>
              <Select hideIcon title={t("models.settings.reasoning")} value={effortValue} onChange={(v) => void writeDefault({ reasoningEffort: v })}>
                {EFFORT_VALUES.map((v) => (
                  <Option key={v} value={v}>
                    {v === "none" ? t("models.settings.reasoningOff") : v}
                  </Option>
                ))}
              </Select>
            </div>
          )}
          {fastSupported && (
            <div className={`${ov.ovField} ${styles.fastField}`}>
              <span className={ov.ovLabel}>{t("models.settings.fast")}</span>
              <Switch
                checked={fastOn}
                onChange={(v) => void writeDefault({ serviceTier: v ? "fast" : "normal" })}
                ariaLabel={t("models.settings.fast")}
              />
            </div>
          )}
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
