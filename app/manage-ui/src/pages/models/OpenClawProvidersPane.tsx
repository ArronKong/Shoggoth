import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { EnvVar, ModelChangeApplyResult, ModelChangeOperation, ProviderDirectoryEntry } from "../../types";
import {
  addModelConfig,
  clearModelAuthProviderKeys,
  deleteEnvVar,
  getProviderDirectory,
  getModelChangeOperation,
  listEnvVars,
  revealEnvVar,
  revealModelProviderKey,
  setEnvVar,
  setModelAuthProfileKey,
  saveModelProviderDraft,
  updateModelProvider,
  validateCustomEndpoint,
} from "../../api/client";
import { useConfirm, useToast } from "../../components/ui";
import OAuthProvidersCard from "../keys/OAuthProvidersCard";
import ProviderLogo from "../keys/ProviderLogo";
import { ProviderCredentialFields } from "../keys/ProviderCredentialFields";
import { SHOW_TOOL_KEYS, ToolKeysCard } from "../keys/ToolKeysCard";
import styles from "../keys/KeysPanel.module.css";
import CustomEndpointsPanel from "./CustomEndpointsPanel";
import { createOpenClawEndpointController } from "./openclaw-endpoint-controller";
import { useSlowPending } from "./useSlowPending";
import { usePageCache } from "../../lib/usePageCache";
import {
  confirmModelOperationTerminal, getModelOperationRecoverySnapshot, modelOperationRecoveryBlocks,
  retainModelOperation, retainedProviderModelOperation, subscribeModelOperationRecovery,
} from "./model-operation-recovery";
import own from "./OpenClawProvidersPane.module.css";

type Activation = { kind: string; available?: boolean } | null | undefined;

// Keep only non-secret operation metadata across navigation/reload. An unknown
// acknowledgement can be observed, but must never mint a replacement operation.
type ProviderWriteReceipt = { operationId: string; status: string; code?: string };
const providerMutationStatuses = new Set(["applied", "partial", "failed", "blocked", "needs_secret", "cleanup_pending", "compensated"]);
function readProviderWriteReceipt(backend: string, provider: string): ProviderWriteReceipt | null {
  const record = retainedProviderModelOperation(backend, provider);
  return record ? { operationId: record.operationId, status: record.status, ...(record.code ? { code: record.code } : {}) } : null;
}

function providerEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (value !== value.trim() || value.length > 4096 || !["http:", "https:"].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

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
  const slowSave = useSlowPending(busy);
  const [preparedEndpoint, setPreparedEndpoint] = useState<string | null>(null);
  const preparedEndpointRef = useRef(preparedEndpoint);
  preparedEndpointRef.current = preparedEndpoint;
  const prepareEndpoint = (endpoint: string | null) => { preparedEndpointRef.current = endpoint; setPreparedEndpoint(endpoint); };
  const nativeConfig = entry.writeMode === "native-config";
  const managed = entry.writeMode === "managed-model-change" || nativeConfig;
  const providerKey = entry.key.statusUnknown && !entry.key.configured
    ? { ...entry.key, configured: true, redacted: t("models.dirNativeKeyStatusUnknown") } : entry.key;
  const recovery = useSyncExternalStore(subscribeModelOperationRecovery,
    () => getModelOperationRecoverySnapshot(backend));
  const recoveryBlocked = managed && (!recovery.storageVerified || modelOperationRecoveryBlocks(backend, entry.id));
  const [pendingWrite, setPendingWrite] = useState<ProviderWriteReceipt | null>(() =>
    managed ? readProviderWriteReceipt(backend, entry.id) : null);
  const pendingWriteRef = useRef(pendingWrite);
  const [observation, setObservation] = useState<"found" | "not-found" | null>(null);
  const [settledWrite, setSettledWrite] = useState<ModelChangeOperation | null>(null);
  const recordWrite = async (receipt: ProviderWriteReceipt | null, terminal?: ModelChangeOperation): Promise<boolean> => {
    const verified = receipt ? await retainModelOperation({ version: 1, backendId: backend, providerKey: entry.id,
      operationId: receipt.operationId, status: receipt.status,
      ...(receipt.code === "model_recovery_requested" ? { code: "model_recovery_requested" } : {}) })
      : !!terminal && await confirmModelOperationTerminal(terminal);
    const retained = readProviderWriteReceipt(backend, entry.id);
    pendingWriteRef.current = retained;
    setPendingWrite(retained);
    setObservation(null);
    return verified;
  };
  const lifecycleEpoch = useRef(0);
  const activeRef = useRef(active);
  const backendRef = useRef(backend);
  activeRef.current = active;
  backendRef.current = backend;

  useEffect(() => {
    lifecycleEpoch.current += 1;
    setBusy(false);
    const receipt = managed ? readProviderWriteReceipt(backend, entry.id) : null;
    pendingWriteRef.current = receipt;
    setPendingWrite(receipt);
    setObservation(null);
    setSettledWrite(null);
    return () => {
      lifecycleEpoch.current += 1;
    };
  }, [active, backend, entry.id, managed]);

  useEffect(() => { prepareEndpoint(null); }, [active, backend, entry.id, entry.baseUrl.value]);

  useEffect(() => {
    const retained = managed ? readProviderWriteReceipt(backend, entry.id) : null;
    pendingWriteRef.current = retained; setPendingWrite(retained);
  }, [managed, backend, entry.id, recovery.revision]);

  const run = async (
    request: (operationId?: string) => Promise<ModelChangeApplyResult | { ok: boolean; activation?: Activation }>,
    message: string,
  ): Promise<boolean> => {
    const epoch = lifecycleEpoch.current;
    if (!activeRef.current || backendRef.current !== backend) return false;
    if (managed && (pendingWriteRef.current || !getModelOperationRecoverySnapshot(backend).storageVerified
      || modelOperationRecoveryBlocks(backend, entry.id))) {
      toast.info(t(pendingWriteRef.current ? "models.dirManagedPending" : "models.dirManagedRecoveryUnknown"));
      return false;
    }
    const operationId = managed ? `provider:${crypto.randomUUID()}` : undefined;
    setSettledWrite(null);
    setBusy(true);
    try {
      if (operationId && !await recordWrite({ operationId, status: "unconfirmed" })) {
        toast.error(t("models.dirManagedRecoveryStorage")); return false;
      }
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      const result = await request(operationId);
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      if (managed && (!operationId || !("status" in result) || result.operationId !== operationId
        || result.receiptIdentityVerified !== true
        || Object.keys(result).some((key) => !["operationId", "status", "stage", "code", "catalog", "activation", "warnings", "details", "canForce", "receiptIdentityVerified", "configSaved", "catalogPending", "retryable", "needsVerification"].includes(key))
        || !providerMutationStatuses.has(result.status) || typeof result.stage !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.stage)
        || result.code !== undefined && (typeof result.code !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.code)))) {
        throw new Error(t("models.dirManagedUnconfirmed"));
      }
      if ("status" in result && result.status !== "applied") {
        if (operationId) {
          if (["failed", "compensated"].includes(result.status)) {
            if (!await recordWrite(null, { version: 1, backendId: backend, providerKey: entry.id, operationId,
              status: result.status === "compensated" ? "compensated" : "failed", stage: result.stage, terminal: true })) {
              toast.error(t("models.dirManagedRecoveryStorage")); return false;
            }
          }
          else if (!await recordWrite({ operationId, status: result.status })) {
            toast.error(t("models.dirManagedRecoveryStorage")); return false;
          }
        }
        if (activeRef.current && backendRef.current === backend && epoch === lifecycleEpoch.current) {
          toast.error(t(result.code === "provider_credentials_incomplete" ? "models.dirProviderKeysIncomplete"
            : "models.dirManagedNotApplied", { status: result.status }));
        }
        return false;
      }
      if (operationId && "status" in result && !await recordWrite(null, { version: 1, backendId: backend,
        providerKey: entry.id, operationId, status: "applied", stage: result.stage, terminal: true })) {
        toast.error(t("models.dirManagedRecoveryStorage")); return false;
      }
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      onActivation(result.activation);
      toast.success(message);
      try { await onSaved(); } catch { toast.info(t("models.dirManagedRefreshFailed")); }
      if ("warnings" in result && result.warnings?.length) toast.info(result.warnings.join("；"));
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      return true;
    } catch (error) {
      // The original record is retained. Neither refresh nor another click
      // resubmits this write after an uncertain acknowledgement.
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return false;
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (epoch === lifecycleEpoch.current) setBusy(false);
    }
  };

  const updateProvider = (patch: Parameters<typeof updateModelProvider>[2], operationId?: string) =>
    updateModelProvider(backend, entry.id, {
      ...patch, ...(nativeConfig ? { baseHash: entry.configRevision } : {}),
    }, operationId);

  const createProvider = (baseUrl: string, apiKey?: string, operationId?: string) => {
    if (nativeConfig) return saveModelProviderDraft(backend, {
      providerKey: entry.id, baseUrl, api: entry.api || undefined, models: [],
      ...(apiKey ? { apiKey } : {}), credentialScope: "provider", baseHash: entry.configRevision,
    }, operationId!);
    if (managed && (!entry.defaultModelId || !entry.api)) {
      throw new Error(t("models.dirManagedMetadataRequired"));
    }
    return addModelConfig(backend, {
      providerMode: "new",
      providerKey: entry.id,
      baseUrl: managed ? providerEndpoint(baseUrl) ?? baseUrl : baseUrl,
      ...(entry.api ?  { api: entry.api } : {}),
      ...(apiKey ? { apiKey } : {}),
      model: { id: entry.defaultModelId ?? "default" },
    }, operationId);
  };

  const saveBaseUrl = (url: string) => {
    if (managed && !nativeConfig && entry.inConfig) {
      const endpoint = providerEndpoint(url);
      if (!endpoint || !entry.baseUrl.editable || pendingWriteRef.current || busy
        || modelOperationRecoveryBlocks(backend, entry.id)
        || !activeRef.current || backendRef.current !== backend) return Promise.resolve(false);
      if (endpoint !== entry.baseUrl.value) {
        // A domain change cannot reuse the old key by implication. Keep a local
        // endpoint draft until the user supplies a key or explicitly clears it.
        prepareEndpoint(endpoint);
        toast.info(t("models.dirManagedEndpointDraft"));
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    }
    return run(async (operationId) => {
      if (entry.inConfig) return updateProvider({ baseUrl: url }, operationId);
      return createProvider(url, undefined, operationId);
    }, t("models.dirSaved", { name: entry.label }));
  };

  const clearBaseUrl = () => run(
    async (operationId) => updateProvider({ clearBaseUrl: true }, operationId),
    t("models.dirSaved", { name: entry.label }),
  );

  const saveKey = (key: string) => run(async (operationId) => {
    if (entry.inConfig || nativeConfig) return updateProvider({ apiKey: key,
      ...(nativeConfig ? { credentialScope: "provider" } : {}),
      ...(managed && preparedEndpoint ? { baseUrl: preparedEndpoint } : {}) }, operationId);
    if (managed) {
      const endpoint = entry.baseUrl.value || entry.baseUrl.defaultValue;
      if (entry.key.editable !== true || !endpoint) throw new Error(t("models.dirManagedEndpointRequired"));
      return createProvider(endpoint, key, operationId);
    }
    return setModelAuthProfileKey(backend, entry.id, key);
  }, t("models.dirSaved", { name: entry.label }));

  const saveKeylessEndpoint = async () => {
    const endpoint = preparedEndpoint;
    const epoch = lifecycleEpoch.current;
    if (!managed || !endpoint || pendingWriteRef.current || busy || modelOperationRecoveryBlocks(backend, entry.id)) return;
    if (entry.key.configured && !await confirm({
      title: t("models.dirManagedKeylessConfirmTitle", { name: entry.label }),
      message: t("models.dirManagedKeylessConfirmMessage", { endpoint }),
      confirmLabel: t("models.dirManagedSaveKeyless"), danger: true,
    })) return;
    if (epoch !== lifecycleEpoch.current || endpoint !== preparedEndpointRef.current
      || !activeRef.current || backendRef.current !== backend) return;
    await run(async (operationId) => updateProvider(
      { baseUrl: endpoint, clearApiKey: true }, operationId), t("models.dirSaved", { name: entry.label }));
  };

  const observeWrite = async () => {
    const original = pendingWriteRef.current;
    const epoch = lifecycleEpoch.current;
    if (!original || busy || !activeRef.current || backendRef.current !== backend) return;
    let terminalObserved = false;
    setBusy(true);
    try {
      const operation = await getModelChangeOperation(backend, original.operationId, entry.id);
      if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current
        || pendingWriteRef.current?.operationId !== original.operationId) return;
      if (operation.terminal) {
        // Only the closed, identity-checked original journal receipt unlocks the
        // form. Snapshot changes or absence from a pending list are insufficient.
        if (!await recordWrite(null, operation)) throw new Error("unverified_storage");
        terminalObserved = true;
        if (!activeRef.current || backendRef.current !== backend || epoch !== lifecycleEpoch.current) return;
        prepareEndpoint(null);
        setSettledWrite(operation);
        if (operation.status === "applied") toast.success(t("models.dirSaved", { name: entry.label }));
        else toast.error(t(operation.status === "compensated"
          ? "models.dirManagedCompensated" : "models.dirManagedFailed"));
        await onSaved();
      } else if (operation.status === "not_found") {
        setObservation("not-found");
      } else {
        if (!await recordWrite({ operationId: original.operationId, status: operation.status })) throw new Error("unverified_storage");
        setObservation("found");
      }
    } catch {
      if (activeRef.current && backendRef.current === backend && epoch === lifecycleEpoch.current) {
        toast.error(t(terminalObserved ? "models.dirManagedRefreshFailed" : "models.dirManagedUnconfirmed"));
      }
    } finally {
      if (epoch === lifecycleEpoch.current) setBusy(false);
    }
  };

  const clearKey = async () => {
    const guardEpoch = lifecycleEpoch.current;
    const approved = await confirm({
      title: t("models.dirClearKeyTitle", { name: entry.label }),
      message: t(nativeConfig ? "models.dirClearProviderKeyMessage" : "models.dirClearKeyMessage", { name: entry.label }),
      confirmLabel: t("keys.clear"),
      danger: true,
    });
    if (
      !approved
      || guardEpoch !== lifecycleEpoch.current
      || !activeRef.current
      || backendRef.current !== backend
    ) return;
    await run(async (operationId) => {
      if (entry.inConfig || nativeConfig) return updateProvider(
        { clearApiKey: true, ...(nativeConfig ? { credentialScope: "provider" } : {}) }, operationId);
      if (managed) throw new Error(t("models.dirManagedMetadataRequired"));
      return clearModelAuthProviderKeys(backend, entry.id);
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

  const probeUrl = preparedEndpoint || entry.baseUrl.value || entry.baseUrl.defaultValue || null;
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
          configured: Boolean(preparedEndpoint || entry.baseUrl.value),
          preview: preparedEndpoint || entry.baseUrl.value,
          placeholder: t("keys.baseUrlPlaceholder"),
          ariaLabel: `${entry.id} base URL`,
          title: entry.baseUrl.value ? t("keys.baseUrlReset") : t("keys.baseUrlPlaceholder"),
        }}
        secret={{
          value: null,
          configured: providerKey.configured,
          preview: providerKey.redacted ?? t("models.dirKeySetShort"),
          placeholder: t("keys.enterValue"),
          ariaLabel: `${entry.id} API key`,
          title: entry.id,
        }}
        busy={busy || recoveryBlocked || managed && pendingWrite !== null}
        capabilities={{
          editBaseUrl: entry.baseUrl.editable,
          clearBaseUrl: (!managed || nativeConfig) && entry.baseUrl.editable && Boolean(entry.baseUrl.value),
          editSecret: !managed || (entry.key.editable === true || Boolean(preparedEndpoint && entry.baseUrl.editable && entry.api))
            && pendingWrite === null && !recoveryBlocked,
          revealSecret: !nativeConfig && entry.key.configured && entry.key.redacted !== null,
          validateSecret: probeUrl !== null,
          clearSecret: providerKey.configured && providerKey.clearable,
        }}
        onSaveBaseUrl={saveBaseUrl}
        validateBaseUrl={(value) => managed ? providerEndpoint(value) !== null : /^https?:\/\//i.test(value)}
        onResolveBaseUrlForEdit={() => Promise.resolve(preparedEndpoint || entry.baseUrl.value)}
        onClearBaseUrl={clearBaseUrl}
        onSaveSecret={saveKey}
        onRevealSecret={revealKey}
        onValidateSecret={validateKey}
        onClearSecret={clearKey}
      />

      {slowSave && <p className={styles.cardHint} role="status">{t("models.savingSlow")}</p>}

      {managed && preparedEndpoint && (
        <div className={styles.cardHint} data-managed-endpoint-draft>
          <p>{t("models.dirManagedEndpointDraft")}</p>
          <button type="button" className={styles.linkBtn} disabled={busy || pendingWrite !== null}
            onClick={() => void saveKeylessEndpoint()}>{t("models.dirManagedSaveKeyless")}</button>
          {" · "}
          <button type="button" className={styles.linkBtn} disabled={busy || pendingWrite !== null}
            onClick={() => prepareEndpoint(null)}>{t("common.cancel")}</button>
        </div>
      )}
      {managed && entry.key.editReason && !preparedEndpoint && (
        <p className={styles.cardHint}>
          {t(entry.key.editReason === "transaction_unavailable" ? "models.dirManagedUnavailable"
            : entry.key.editReason === "endpoint_required" ? "models.dirManagedEndpointRequired"
              : "models.dirManagedMetadataRequired")}
        </p>
      )}
      {managed && pendingWrite && (
        <div className={styles.cardHint} role="status" data-managed-provider-operation>
          <p>{t("models.dirManagedPending")}</p>
          <p>{t("models.dirManagedOperation", { operationId: pendingWrite.operationId, status: pendingWrite.status })}</p>
          <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => void observeWrite()}>
            {t("models.dirManagedObserve")}
          </button>
          {observation === "not-found" && <p>{t("models.dirManagedNotObserved")}</p>}
        </div>
      )}

      {managed && settledWrite && (
        <div className={styles.cardHint} role="status" data-managed-provider-terminal>
          <p>{t(settledWrite.status === "applied" ? "models.dirManagedApplied"
            : settledWrite.status === "compensated" ? "models.dirManagedCompensated" : "models.dirManagedFailed")}</p>
          <p>{t("models.dirManagedOperation", { operationId: settledWrite.operationId, status: settledWrite.status })}</p>
        </div>
      )}

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
  recoveryRefreshKey = 0,
}: {
  backend: string;
  active: boolean;
  onActivation: (activation: Activation) => void;
  recoveryRefreshKey?: number;
}) {
  const { t } = useTranslation();
  const { data: directory, error, refresh } = usePageCache(`models:providers:${backend}`,
    () => getProviderDirectory(backend), { staleTime: 30_000, enabled: active });
  const entries = directory ? (directory.supported ? directory.providers ?? [] : []) : null;
  const [expanded, setExpanded] = useState(false);
  const [providerWriteRevision, setProviderWriteRevision] = useState(0);
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

  const previousRefreshKey = useRef(recoveryRefreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === recoveryRefreshKey) return;
    previousRefreshKey.current = recoveryRefreshKey;
    if (active) void refresh();
  }, [active, refresh, recoveryRefreshKey]);
  const providerChanged = () => {
    setProviderWriteRevision((value) => value + 1);
    return refresh();
  };

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
    return !provider.inConfig || !hasEndpoint || provider.writeMode !== "native-config" && provider.modelsCount === 0;
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
      <OAuthProvidersCard backend={backend} refreshKey={recoveryRefreshKey + providerWriteRevision}
        onChanged={providerChanged} />

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
              onSaved={providerChanged}
              onActivation={onActivation}
            />
          ))}
        </div>
      </section>

      <CustomEndpointsPanel
        key={backend}
        controller={endpointController}
        refreshKey={recoveryRefreshKey + providerWriteRevision}
        active={active}
        onChanged={() => void refresh()}
        onActivation={onActivation}
      />

      {SHOW_TOOL_KEYS && (
        <OpenClawToolKeysCard backend={backend} active={active} onActivation={onActivation} />
      )}
    </div>
  );
}
