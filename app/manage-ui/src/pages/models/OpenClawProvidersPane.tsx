import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EnvVar, ProviderDirectoryEntry } from "../../types";
import {
  addModelConfig,
  deleteEnvVar,
  deleteModelAuthProfile,
  getProviderDirectory,
  listEnvVars,
  revealEnvVar,
  revealModelProviderKey,
  setEnvVar,
  setModelAuthProfileKey,
  updateModelProvider,
  validateCustomEndpoint,
} from "../../api/client";
import { useConfirm, useToast } from "../../components/ui";
import OAuthProvidersCard from "../keys/OAuthProvidersCard";
import ProviderLogo from "../keys/ProviderLogo";
import { ProviderCredentialFields } from "../keys/ProviderCredentialFields";
import { ToolKeysCard } from "../keys/ToolKeysCard";
import styles from "../keys/KeysPanel.module.css";
import CustomEndpointsPanel from "./CustomEndpointsPanel";
import { createOpenClawEndpointController } from "./openclaw-endpoint-controller";
import own from "./OpenClawProvidersPane.module.css";

type Activation = { kind: string; available?: boolean } | null | undefined;

function ProviderRow({
  entry,
  backend,
  active,
  onSaved,
  onActivation,
}: {
  entry: ProviderDirectoryEntry;
  backend: string;
  active: boolean;
  onSaved: () => Promise<void> | void;
  onActivation: (activation: Activation) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const lifecycleEpoch = useRef(0);
  const activeRef = useRef(active);
  const backendRef = useRef(backend);
  activeRef.current = active;
  backendRef.current = backend;

  useEffect(() => {
    lifecycleEpoch.current += 1;
    setBusy(false);
    return () => {
      lifecycleEpoch.current += 1;
    };
  }, [active, backend]);

  const run = async (request: () => Promise<Activation>, message: string): Promise<boolean> => {
    const epoch = lifecycleEpoch.current;
    if (!activeRef.current || backendRef.current !== backend) return false;
    setBusy(true);
    try {
      const activation = await request();
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      onActivation(activation);
      toast.success(message);
      await onSaved();
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      return true;
    } catch (error) {
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (epoch === lifecycleEpoch.current) setBusy(false);
    }
  };

  const saveBaseUrl = (url: string) => run(async () => {
    if (entry.inConfig) {
      return (await updateModelProvider(backend, entry.id, { baseUrl: url })).activation;
    }
    return (await addModelConfig(backend, {
      providerKey: entry.id,
      baseUrl: url,
      ...(entry.api ? { api: entry.api } : {}),
      model: { id: entry.defaultModelId ?? "default" },
    })).activation;
  }, t("models.dirSaved", { name: entry.label }));

  const clearBaseUrl = () => run(
    async () => (await updateModelProvider(backend, entry.id, { clearBaseUrl: true })).activation,
    t("models.dirSaved", { name: entry.label }),
  );

  const saveKey = (key: string) => run(async () => {
    if (entry.inConfig) {
      return (await updateModelProvider(backend, entry.id, { apiKey: key })).activation;
    }
    return (await setModelAuthProfileKey(backend, entry.id, key)).activation;
  }, t("models.dirSaved", { name: entry.label }));

  const clearKey = async () => {
    const guardEpoch = lifecycleEpoch.current;
    const approved = await confirm({
      title: t("models.dirClearKeyTitle", { name: entry.label }),
      message: t("models.dirClearKeyMessage", { name: entry.label }),
      confirmLabel: t("keys.clear"),
      danger: true,
    });
    if (
      !approved
      || guardEpoch !== lifecycleEpoch.current
      || !activeRef.current
      || backendRef.current !== backend
    ) return;
    await run(async () => {
      if (entry.inConfig) {
        return (await updateModelProvider(backend, entry.id, { clearApiKey: true })).activation;
      }
      return (await deleteModelAuthProfile(backend, `${entry.id}:default`)).activation;
    }, t("models.dirKeyCleared", { name: entry.label }));
  };

  const revealKey = async (): Promise<string | null> => {
    try {
      const result = await revealModelProviderKey(backend, entry.id);
      if (result.apiKey) return result.apiKey;
      toast.info(t(result.reason === "remote" ? "models.dirRevealRemote" : "models.dirRevealManaged"));
      return null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const probeUrl = entry.baseUrl.value || entry.baseUrl.defaultValue || null;
  const validateKey = async (key: string) => {
    if (!probeUrl) return;
    try {
      const result = await validateCustomEndpoint(backend, undefined, {
        name: entry.id,
        baseUrl: probeUrl,
        model: "",
        apiKey: key,
        ...(entry.keyProbePath ? { probePath: entry.keyProbePath } : {}),
      });
      if (result.ok) toast.success(t("keys.validateOk"));
      else toast.error(t("keys.validateFail", { error: result.message || "" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={styles.group}>
      <div className={styles.groupHeadRow}>
        <div className={styles.groupName}>
          <ProviderLogo name={entry.logoKey} />
          <span className={styles.groupTitle}>{entry.label}</span>
          {entry.configured && <span className={styles.dotOn} aria-hidden="true" />}
        </div>
        <span className={own.headActions}>
          {entry.getKeyUrl && (
            <a className={styles.getKey} href={entry.getKeyUrl} target="_blank" rel="noreferrer">
              {t("keys.getKey")} ↗
            </a>
          )}
        </span>
      </div>

      <ProviderCredentialFields
        baseUrl={{
          value: entry.baseUrl.value,
          fallback: entry.baseUrl.defaultValue,
          configured: Boolean(entry.baseUrl.value),
          preview: entry.baseUrl.value,
          placeholder: t("keys.baseUrlPlaceholder"),
          ariaLabel: `${entry.id} base URL`,
          title: entry.baseUrl.value ? t("keys.baseUrlReset") : t("keys.baseUrlPlaceholder"),
        }}
        secret={{
          value: null,
          configured: entry.key.configured,
          preview: entry.key.redacted ?? t("models.dirKeySetShort"),
          placeholder: t("keys.enterValue"),
          ariaLabel: `${entry.id} API key`,
          title: entry.id,
        }}
        busy={busy}
        capabilities={{
          editBaseUrl: entry.baseUrl.editable,
          clearBaseUrl: entry.baseUrl.editable && Boolean(entry.baseUrl.value),
          revealSecret: entry.key.configured && entry.key.redacted !== null,
          validateSecret: probeUrl !== null,
          clearSecret: entry.key.configured && entry.key.clearable,
        }}
        onSaveBaseUrl={saveBaseUrl}
        validateBaseUrl={(value) => /^https?:\/\//i.test(value)}
        onResolveBaseUrlForEdit={() => Promise.resolve(entry.baseUrl.value)}
        onClearBaseUrl={clearBaseUrl}
        onSaveSecret={saveKey}
        onRevealSecret={revealKey}
        onValidateSecret={validateKey}
        onClearSecret={clearKey}
      />

      {entry.oauth.length > 0 && !entry.key.configured && (
        <p className={styles.cardHint}>{t("models.dirOauthHint")}</p>
      )}
    </div>
  );
}

function OpenClawToolKeysCard({
  backend,
  active,
  onActivation,
}: {
  backend: string;
  active: boolean;
  onActivation: (activation: Activation) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [error, setError] = useState("");
  const refreshGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const currentBackend = useRef(backend);
  currentBackend.current = backend;
  const activeRef = useRef(active);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const nextVars = await listEnvVars(backend);
      if (generation !== refreshGeneration.current || backend !== currentBackend.current) return;
      setVars(nextVars);
      setError("");
    } catch (cause) {
      if (generation !== refreshGeneration.current || backend !== currentBackend.current) return;
      setVars((previous) => previous ?? []);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [backend]);

  useEffect(() => {
    refreshGeneration.current += 1;
    mutationGeneration.current += 1;
    setVars(null);
    setError("");
    if (active) void refresh();
    return () => {
      refreshGeneration.current += 1;
      mutationGeneration.current += 1;
    };
  }, [active, refresh]);

  const save = async (key: string, value: string): Promise<boolean> => {
    if (!key.trim() || !value.trim() || !activeRef.current || backend !== currentBackend.current) {
      return false;
    }
    const generation = mutationGeneration.current;
    try {
      const result = await setEnvVar(backend, key, value);
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      onActivation(result.activation);
      toast.success(t("models.dirSaved", { name: key }));
      await refresh();
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      return true;
    } catch (cause) {
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      toast.error(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const clear = async (key: string): Promise<boolean> => {
    const guardGeneration = mutationGeneration.current;
    const approved = await confirm({
      title: t("models.dirClearKeyTitle", { name: key }),
      message: t("models.dirClearKeyMessage", { name: key }),
      confirmLabel: t("keys.clear"),
      danger: true,
    });
    if (!approved || !activeRef.current || backend !== currentBackend.current
      || guardGeneration !== mutationGeneration.current) return false;
    const generation = mutationGeneration.current;
    try {
      const result = await deleteEnvVar(backend, key);
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      onActivation(result.activation);
      toast.success(t("models.dirKeyCleared", { name: key }));
      await refresh();
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      return true;
    } catch (cause) {
      if (!activeRef.current || backend !== currentBackend.current || generation !== mutationGeneration.current) return false;
      toast.error(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const reveal = async (key: string): Promise<string | null> => {
    try {
      return await revealEnvVar(backend, key);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  const setEntries = (vars ?? [])
    .filter((item) => item.isSet)
    .map((item) => ({
      ...item,
      canReveal: item.redactedValue !== null,
      canValidate: false,
      canClear: true,
    }));

  return (
    <ToolKeysCard
      title={t("keys.catTool")}
      description={t("models.envDesc")}
      emptyText={t("models.envEmpty")}
      errorText={error ? t("models.error", { msg: error }) : undefined}
      setEntries={setEntries}
      unsetEntries={[]}
      showUnsetDirectory={false}
      canAdd
      loading={vars === null}
      onAdd={save}
      onSave={save}
      onReveal={reveal}
      onValidate={async () => {}}
      onClear={clear}
    />
  );
}

export default function OpenClawProvidersPane({
  backend,
  active,
  onActivation,
}: {
  backend: string;
  active: boolean;
  onActivation: (activation: Activation) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ProviderDirectoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const refreshGeneration = useRef(0);
  const currentBackend = useRef(backend);
  currentBackend.current = backend;
  const activeRef = useRef(active);
  activeRef.current = active;
  const activationRef = useRef(onActivation);
  activationRef.current = onActivation;
  const endpointController = useMemo(
    () => createOpenClawEndpointController(backend, undefined, (activation) => {
      if (!activeRef.current || currentBackend.current !== backend) return;
      activationRef.current(activation);
    }),
    [backend],
  );

  useEffect(() => {
    // StrictMode 会执行 setup → cleanup → setup；每次 setup 都必须恢复当前身份。
    activeRef.current = active;
    currentBackend.current = backend;
    return () => {
      activeRef.current = false;
    };
  }, [active, backend]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const directory = await getProviderDirectory(backend);
      if (generation !== refreshGeneration.current || backend !== currentBackend.current) return;
      setEntries(directory.supported && directory.providers ? directory.providers : []);
      setError("");
    } catch (cause) {
      if (generation !== refreshGeneration.current || backend !== currentBackend.current) return;
      setEntries((previous) => previous ?? []);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [backend]);

  useEffect(() => {
    refreshGeneration.current += 1;
    setEntries(null);
    setError("");
    if (active) void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [active, refresh]);

  const directoryEntries = useMemo(() => (entries ?? []).filter((provider) => {
    if (!provider.custom) return true;
    const candidate = provider.baseUrl.value?.trim() ?? "";
    let hasEndpoint = false;
    try {
      const url = new URL(candidate);
      hasEndpoint = ["http:", "https:"].includes(url.protocol)
        && Boolean(url.hostname)
        && !url.username
        && !url.password;
    } catch { /* URL 不完整的手工 provider 仍留在 Provider 卡修复。 */ }
    return !provider.inConfig || !hasEndpoint || provider.modelsCount === 0;
  }), [entries]);
  const configured = useMemo(
    () => directoryEntries.filter((provider) => provider.configured),
    [directoryEntries],
  );
  const visible = expanded
    ? directoryEntries
    : configured.length > 0
      ? configured
      : directoryEntries.slice(0, 3);
  const hiddenCount = directoryEntries.length - visible.length;

  return (
    <div className={styles.panel}>
      <OAuthProvidersCard backend={backend} />

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div className={styles.cardHeadRow}>
            <h4 className={styles.cardTitle}>{t("models.dirTitle")}</h4>
            {expanded ? (
              <button className={styles.linkBtn} aria-expanded onClick={() => setExpanded(false)}>
                {t("keys.showLess")}
              </button>
            ) : hiddenCount > 0 ? (
              <button className={styles.linkBtn} aria-expanded={false} onClick={() => setExpanded(true)}>
                {t("keys.showAllProviders", { count: hiddenCount })}
              </button>
            ) : null}
          </div>
          <p className={styles.cardDesc}>
            {t("models.dirConfigured", { total: directoryEntries.length, count: configured.length })}
          </p>
        </div>
        <div className={`${styles.cardBody} ${styles.cardBodyFlush}`}>
          {error && <div className="error">{t("models.error", { msg: error })}</div>}
          {entries === null && !error && <p className="muted">{t("common.loading")}</p>}
          {visible.map((provider) => (
            <ProviderRow
              key={provider.id}
              entry={provider}
              backend={backend}
              active={active}
              onSaved={refresh}
              onActivation={onActivation}
            />
          ))}
        </div>
      </section>

      <CustomEndpointsPanel
        key={backend}
        controller={endpointController}
        active={active}
        onChanged={() => void refresh()}
        onActivation={onActivation}
      />

      <OpenClawToolKeysCard backend={backend} active={active} onActivation={onActivation} />
    </div>
  );
}
