import { useEffect, useId, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, { ModalSection } from "../../components/Modal";
import { Field, Option, Select, Switch, TextInput } from "../../components/Field";
import { ApiError, applyModelChange, previewModelChange } from "../../api/client";
import type {
  CustomModelProvider,
  ModelCatalogSnapshot,
  ModelChangeApplyResult,
  ModelChangeCapabilities,
  ModelChangePreview,
} from "../../types";
import {
  createInitialModelEditorState,
  isModelEditorDirty,
  modelEditorReducer,
  toModelChangeSpec,
  validateModelEditor,
  type EditableModelInput,
  type ModelEditorField,
  type ModelEditorMode,
} from "./model-editor-state";
import styles from "./ModelEditorDrawer.module.css";
import { useNavigationGuard } from "../../lib/navigation-guard";

export interface ModelEditorDrawerProps {
  mode: ModelEditorMode;
  backend: string;
  providers: CustomModelProvider[];
  model?: EditableModelInput;
  capabilities: ModelChangeCapabilities;
  // 目录模型(allowlist 驱动,如 openrouter):只有模型 ID 可写——元数据由上游
  // 目录提供,表单只暴露 ID 字段,保存=allowlist 搬键+引用改写。
  catalogOnly?: boolean;
  // 草稿模式:目录模型改名/既有 provider 新增(auth 或 config 型)不逐发网关,
  // 收集进页面草稿队列批量提交;config 型新增连元数据一起暂存。
  onDraft?: (op: {
    kind: "rename" | "create";
    providerKey: string;
    sourceModelId?: string;
    modelId: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  }) => void;
  open: boolean;
  onApplied: (catalog: ModelCatalogSnapshot) => Promise<"synced" | "sync-pending">;
  // config-only 保存成功时把生效方式冒泡给页面（待生效横幅 + 重启网关按钮）。
  onActivation?: (activation?: ModelChangeApplyResult["activation"]) => void;
  onRequestClose: () => void;
  onOpenChangeComplete: (open: boolean) => void;
}

const PRE_JOURNAL_CODES = new Set([
  "preview_expired",
  "preview_stale",
  "snapshot_changed",
  "target_conflict",
  "topology_changed",
]);

// 将服务端逐阶段结果限制为可展示字段，不把任意 raw details 注入 UI。
function errorResult(
  operationId: string,
  stage: string,
  message: string,
): ModelChangeApplyResult {
  return {
    operationId,
    status: "failed",
    stage,
    details: [{ stage, status: "failed", message, retryable: true }],
  };
}

// 引用、改名或重启要求属于危险影响，必须由用户二次确认后才 apply。
function requiresImpactConfirmation(
  mode: ModelEditorMode,
  sourceModelId: string | null,
  targetModelId: string,
  preview: ModelChangePreview,
): boolean {
  return (mode === "edit" && sourceModelId !== targetModelId)
    || preview.references.length > 0
    || String(preview.runtimeApply || "").includes("restart");
}

// 按 store 聚合影响项，保持服务端枚举顺序，便于用户定位引用来源。
function groupReferences(preview: ModelChangePreview): Array<[string, ModelChangePreview["references"]]> {
  const groups = new Map<string, ModelChangePreview["references"]>();
  for (const reference of preview.references) {
    const rows = groups.get(reference.store) || [];
    rows.push(reference);
    groups.set(reference.store, rows);
  }
  return [...groups.entries()];
}

export default function ModelEditorDrawer({
  mode,
  backend,
  providers,
  model,
  capabilities,
  catalogOnly,
  onDraft,
  open,
  onApplied,
  onActivation,
  onRequestClose,
  onOpenChangeComplete,
}: ModelEditorDrawerProps) {
  const { t } = useTranslation();
  // auth 型(凭证在 auth-profiles、模型条目=allowlist 键)也可挂新模型 ID
  const editableProviders = useMemo(
    () => providers.filter((provider) => provider.source === "config" || provider.source === "auth"),
    [providers],
  );
  const initial = useMemo(
    () => createInitialModelEditorState(mode, { providers: editableProviders, model }, capabilities),
    // 调用方可能每次 render 创建新对象；结构 key 防止用户输入被无关 render 重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, JSON.stringify(editableProviders.map((provider) => provider.key)), JSON.stringify(model), JSON.stringify(capabilities)],
  );
  const [state, dispatch] = useReducer(modelEditorReducer, initial);
  const [requestError, setRequestError] = useState("");
  const idPrefix = useId().replace(/:/g, "");
  const errors = validateModelEditor(state);
  const dirty = isModelEditorDirty(state);
  const busy = state.phase === "previewing" || state.phase === "applying";
  const supported = capabilities.supported
    && (mode === "create" ? capabilities.create : capabilities.update);
  // 只有 ID 可写的目录模型表单:显式 catalogOnly(编辑),或新增时选中 auth 型 provider
  const idOnly = catalogOnly === true
    || (mode === "create"
      && state.values.providerMode === "existing"
      && editableProviders.find((p) => p.key === state.values.providerKey)?.source === "auth");
  useNavigationGuard({ dirty: open && dirty, busy: open && busy, onDiscard: onRequestClose });

  // 每个打开 session 都从 props 建立全新不可变 baseline，关闭后 API Key 随状态销毁。
  useEffect(() => {
    if (!open) return;
    dispatch({ type: "reset", state: initial });
    setRequestError("");
  }, [initial, open]);

  function setField(field: ModelEditorField, value: string | boolean): void {
    dispatch({ type: "field", field, value });
    setRequestError("");
  }

  function describedBy(field: ModelEditorField): string | undefined {
    return errors[field] ? `${idPrefix}-${field}-error` : undefined;
  }

  // reducer 只保存稳定错误码；这里集中翻译，确保切换语言后不会残留旧文案。
  function fieldError(field: ModelEditorField): string | undefined {
    switch (errors[field]) {
      case "provider_required": return t("models.validationProviderRequired");
      case "provider_invalid": return t("models.validationProviderInvalid");
      case "model_id_required": return t("models.validationModelIdRequired");
      case "base_url_invalid": return t("models.validationBaseUrlInvalid");
      case "context_positive_integer": return t("models.validationContextPositive");
      case "max_tokens_positive_integer": return t("models.validationMaxTokensPositive");
      default: return undefined;
    }
  }

  // 服务端只允许已知错误码映射为具体文案，未知错误不回显 raw message 或 secret。
  function changeError(code?: string, operationId?: string): string {
    let message: string;
    switch (code) {
      case "preview_expired": message = t("models.errorPreviewExpired"); break;
      case "preview_stale": message = t("models.errorSnapshotChanged"); break;
      case "snapshot_changed": message = t("models.errorSnapshotChanged"); break;
      case "target_conflict": message = t("models.errorTargetConflict"); break;
      case "source_not_found": message = t("models.errorSourceMissing"); break;
      case "provider_not_found": message = t("models.errorProviderMissing"); break;
      case "topology_changed": message = t("models.errorTopologyChanged"); break;
      case "model_change_recovering": message = t("models.errorRecovering"); break;
      case "config_write_conflict": message = t("models.mutationWriteConflict"); break;
      default: message = t("models.changeErrorGeneric");
    }
    return operationId ? `${message} ${t("models.operationReference", { operationId })}` : message;
  }

  // capability blocker 同样只展示受控映射，避免把后端内部细节直接注入页面。
  function capabilityReason(code: string): string {
    switch (code) {
      case "upgrade_required": return t("models.capabilityUpgradeRequired");
      case "conditional_write_unsupported":
      case "hermes_conditional_write_unsupported":
        return t("models.capabilityConditionalWrite");
      case "supervisor_drain_unsupported":
      case "openclaw_supervisor_drain_unsupported":
        return t("models.capabilitySupervisorDrain");
      case "loading": return t("models.capabilityLoading");
      default: return t("models.capabilityUnsupported");
    }
  }

  // 运行态协议值转成人类可读文案，未知值保守显示“等待确认”。
  function runtimeLabel(runtime?: string): string {
    if (runtime === "hot") return t("models.runtimeHot");
    if (runtime?.includes("restart")) return t("models.runtimeRestart");
    if (runtime?.includes("drain")) return t("models.runtimeDrain");
    return t("models.runtimeUnknown");
  }

  // 结果行始终以图标和文字双重表达状态，不依赖颜色辨识。
  function resultStatus(status: string): { icon: string; label: string } {
    switch (status) {
      case "applied": return { icon: "✓", label: t("models.statusApplied") };
      case "partial": return { icon: "↻", label: t("models.statusPartial") };
      case "cleanup_pending": return { icon: "↻", label: t("models.statusPartial") };
      case "needs_secret": return { icon: "!", label: t("models.statusBlocked") };
      case "pending": return { icon: "…", label: t("models.statusPending") };
      case "blocked": return { icon: "!", label: t("models.statusBlocked") };
      default: return { icon: "×", label: t("models.statusFailed") };
    }
  }

  function requestClose(): void {
    if (busy) return;
    if (dirty && !window.confirm(t("models.discardEditor"))) return;
    onRequestClose();
  }

  // applied 必须先同步共享目录与页面复合状态，确认 synced 后才关闭弹窗。
  async function finishApplied(result: ModelChangeApplyResult): Promise<void> {
    if (result.activation) onActivation?.(result.activation);
    if (!result.catalog) {
      dispatch({
        type: "apply-result",
        result: {
          ...result,
          status: "partial",
          stage: "catalog-pending",
          details: [{ stage: "catalog-pending", status: "pending", retryable: true, message: t("models.catalogPending") }],
        },
      });
      return;
    }
    let syncStatus: "synced" | "sync-pending" = "sync-pending";
    try {
      syncStatus = await onApplied(result.catalog);
    } catch {
      // 后端已 applied 后，客户端回读失败只能进入同步重试，不能重新执行 mutation。
      syncStatus = "sync-pending";
    }
    if (syncStatus === "synced") {
      dispatch({ type: "apply-result", result });
      onRequestClose();
      return;
    }
    dispatch({
      type: "apply-result",
      result: {
        ...result,
        status: "partial",
        stage: "client-sync-pending",
        details: [{ stage: "client-sync-pending", status: "pending", retryable: true, message: t("models.clientSyncPending") }],
      },
    });
  }

  // apply 的 retry 始终复用 previewToken 与 operationId，避免重复迁移引用。
  async function runApply(preview: ModelChangePreview): Promise<void> {
    const operationId = state.operationId || crypto.randomUUID();
    dispatch({ type: "apply-started", operationId });
    setRequestError("");
    try {
      const result = await applyModelChange(
        backend,
        toModelChangeSpec(state),
        preview.previewToken,
        operationId,
      );
      if (result.status === "applied") await finishApplied(result);
      else dispatch({ type: "apply-result", result });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.code && PRE_JOURNAL_CODES.has(apiError.code)) {
        // 明确发生在 journal 前的冲突废弃旧 token/id；字段值保持不变。
        dispatch({ type: "field", field: "name", value: state.values.name });
      }
      const message = changeError(apiError?.code, operationId);
      setRequestError(message);
      dispatch({
        type: "apply-result",
        result: errorResult(
          apiError?.code && PRE_JOURNAL_CODES.has(apiError.code) ? "" : operationId,
          apiError?.stage || "apply",
          message,
        ),
      });
    }
  }

  // config-only 降级下，能力类 blocker（backend 自报 bypass 集合内）不阻塞提交：
  // 保存仍会写入配置，生效由页面的重启网关横幅完成；冲突类 blocker 照旧拦截。
  // bypass 集支持按 kind 分级（弹窗只有 create/update 两种 kind；改 id 的
  // rename 已被 idLocked 禁止，不会到达提交）。
  const rawBypass = capabilities.configWrite?.bypassBlockerCodes;
  const drawerKind = mode === "create" ? "create" : "update";
  const bypassBlockerCodes = new Set(
    Array.isArray(rawBypass)
      ? rawBypass
      : rawBypass
        ? [...(rawBypass["*"] || []), ...(rawBypass[drawerKind] || [])]
        : [],
  );
  const blockingBlockers = (blockers: ModelChangePreview["blockers"]) => (
    blockers.filter((blocker) => !bypassBlockerCodes.has(blocker.code))
  );

  // 首次提交只做 preview；无危险影响时同一用户动作继续 apply。
  async function submit(): Promise<void> {
    if (!supported || busy || Object.keys(errors).length > 0 || !dirty) return;
    // 草稿模式(批量提交):目录模型改名 + 既有 provider 的新增(auth/config 型
    // 一视同仁)不逐发网关,收集进页面草稿队列,由「提交更改」一次合并写。
    // providerMode:"new"(新建 provider,带端点/凭证)与编辑元数据保持即时路径。
    const draftable = idOnly || (mode === "create" && state.values.providerMode === "existing");
    if (onDraft && draftable) {
      const modelId = state.values.id.trim();
      if (!modelId) return;
      if (mode === "edit" && state.sourceModelId === modelId) {
        onRequestClose();
        return;
      }
      if (mode === "create") {
        const ctx = Number(state.values.contextWindow);
        const maxTok = Number(state.values.maxTokens);
        onDraft({
          kind: "create",
          providerKey: state.values.providerKey,
          modelId,
          ...(state.values.name.trim() ? { name: state.values.name.trim() } : {}),
          ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
          ...(Number.isFinite(maxTok) && maxTok > 0 ? { maxTokens: maxTok } : {}),
          ...(state.values.reasoning ? { reasoning: true } : {}),
        });
      } else {
        onDraft({ kind: "rename", providerKey: state.values.providerKey, sourceModelId: state.sourceModelId!, modelId });
      }
      return;
    }
    if (state.preview && blockingBlockers(state.preview.blockers).length === 0) {
      await runApply(state.preview);
      return;
    }
    dispatch({ type: "preview-started" });
    setRequestError("");
    try {
      const preview = await previewModelChange(backend, toModelChangeSpec(state));
      const blocking = blockingBlockers(preview.blockers);
      if (blocking.length > 0) {
        setRequestError([...new Set(blocking.map((blocker) => changeError(blocker.code)))].join(" "));
        dispatch({ type: "preview-ready", preview, confirmationRequired: false });
        dispatch({
          type: "apply-result",
          result: {
            operationId: "",
            status: "failed",
            stage: "preflight",
            details: blocking.map((blocker) => ({
              stage: blocker.store || "preflight",
              reference: blocker.referenceKey,
              status: "blocked",
              message: changeError(blocker.code),
              retryable: false,
            })),
          },
        });
        return;
      }
      const confirmationRequired = requiresImpactConfirmation(
        mode,
        state.sourceModelId,
        state.values.id.trim(),
        preview,
      );
      dispatch({ type: "preview-ready", preview, confirmationRequired });
      if (!confirmationRequired) await runApply(preview);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const message = changeError(apiError?.code);
      setRequestError(message);
      dispatch({ type: "apply-result", result: errorResult("", "preview", message) });
    }
  }

  // 客户端同步失败只重跑 onApplied，绝不再次调用后端 apply。
  async function retrySync(): Promise<void> {
    const result = state.result;
    const catalog = result?.catalog;
    if (!result || !catalog) return;
    dispatch({ type: "apply-started", operationId: state.operationId || result.operationId || "" });
    try {
      const status = await onApplied(catalog);
      if (status === "synced") onRequestClose();
      else dispatch({ type: "apply-result", result });
    } catch {
      // 客户端回读失败保留原 partial 结果，允许再次重试且绝不重复后端 mutation。
      dispatch({ type: "apply-result", result });
    }
  }

  const fieldSupported = (field: string) => capabilities.fields?.[field] !== false;
  const title = mode === "create" ? t("models.editorAddTitle") : t("models.editorEditTitle");
  const retryingSync = state.phase === "partial" && state.result?.stage === "client-sync-pending";
  const canSubmit = supported
    && dirty
    && Object.keys(errors).length === 0
    && !busy;
  // Adapter 允许只返回 status/code/stage；即使没有逐项 details，也必须显示阶段结果。
  const visibleResultDetails = state.result
    ? (state.result.details?.length
        ? state.result.details
        : [{
            stage: state.result.stage || "apply",
            status: state.result.status,
            retryable: state.result.status !== "applied" && state.result.status !== "compensated",
          }])
    : [];

  return (
    <Modal
      open={open}
      title={title}
      subtitle={backend}
      onClose={requestClose}
      onOpenChangeComplete={onOpenChangeComplete}
      dismissible={!busy}
      width={600}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={requestClose} disabled={busy}>{t("common.cancel")}</button>
          {retryingSync ? (
            <button type="button" className="btn-primary" onClick={() => void retrySync()} disabled={busy}>
              {t("models.retrySync")}
            </button>
          ) : state.phase === "confirming" ? null : (
            <button type="button" className="btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
              {state.phase === "partial" || state.phase === "failed" ? t("models.retryApply") : t("models.saveApply")}
            </button>
          )}
        </>
      )}
    >
      {!supported && (
        <div className={styles.capabilityNotice} role="status">
          {t("models.capabilityUnavailable", {
            action: mode === "create" ? t("models.actionCreate") : t("models.actionUpdate"),
            reason: (capabilities.blockers || ["unsupported"]).map(capabilityReason).join(" "),
          })}
        </div>
      )}

      <ModalSection title={t("models.providerSection")}>
        {mode === "create" && (
          <Field label={t("models.providerMode")}>
            <Select
              value={state.values.providerMode}
              onChange={(value) => setField("providerMode", value)}
              disabled={!supported}
            >
              <Option value="existing">{t("models.existingProvider")}</Option>
              <Option value="new">{t("models.newProviderOption")}</Option>
            </Select>
          </Field>
        )}
        {state.values.providerMode === "existing" ? (
          <Field label={t("models.providerField")}>
            <Select
              value={state.values.providerKey}
              onChange={(value) => setField("providerKey", value)}
              disabled={state.providerLocked || !supported}
            >
              {editableProviders.map((provider) => (
                <Option key={provider.key} value={provider.key}>{provider.name || provider.key}</Option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <Field label={t("models.providerKey")} error={fieldError("providerKey")} errorId={describedBy("providerKey")}>
              <TextInput
                value={state.values.providerKey}
                onChange={(event) => setField("providerKey", event.target.value)}
                aria-invalid={!!errors.providerKey || undefined}
                aria-describedby={describedBy("providerKey")}
                disabled={!supported}
                autoComplete="off"
              />
            </Field>
            <Field label={t("models.baseUrl")} error={fieldError("baseUrl")} errorId={describedBy("baseUrl")}>
              <TextInput
                value={state.values.baseUrl}
                onChange={(event) => setField("baseUrl", event.target.value)}
                aria-invalid={!!errors.baseUrl || undefined}
                aria-describedby={describedBy("baseUrl")}
                disabled={!supported}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <Field label={t("models.apiKey")} hint={t("models.apiKeySessionHint")}>
              <TextInput
                type="password"
                value={state.values.apiKey}
                onChange={(event) => setField("apiKey", event.target.value)}
                disabled={!supported}
                autoComplete="new-password"
              />
            </Field>
            <Field label={t("models.apiAdapterOptional")}>
              <TextInput
                value={state.values.api}
                onChange={(event) => setField("api", event.target.value)}
                disabled={!supported}
              />
            </Field>
          </>
        )}
      </ModalSection>

      <ModalSection title={t("models.modelParameters")}>
        <Field
          label={t("models.modelId")}
          error={fieldError("id")}
          errorId={describedBy("id")}
          // catalogOnly:目录模型编辑的唯一可写字段就是 id(rename=allowlist 搬键),
          // 不受 config 模型的 rename 能力锁(那是 runtime 迁移路径的限制)
          hint={state.idLocked && !catalogOnly ? t("models.idLocked") : idOnly ? t("models.catalogIdOnlyHint") : undefined}
        >
          <TextInput
            value={state.values.id}
            onChange={(event) => setField("id", event.target.value)}
            readOnly={state.idLocked && !catalogOnly}
            aria-invalid={!!errors.id || undefined}
            aria-describedby={describedBy("id")}
            disabled={!supported || !fieldSupported("id")}
          />
        </Field>
        {!idOnly && fieldSupported("name") && (
          <Field label={t("models.displayName")}>
            <TextInput
              value={state.values.name}
              onChange={(event) => setField("name", event.target.value)}
              disabled={!supported}
            />
          </Field>
        )}
        {!idOnly && (fieldSupported("contextWindow") || fieldSupported("maxTokens")) && (
          <div className={styles.twoColumns}>
            {fieldSupported("contextWindow") && (
              <Field label={t("models.contextWindow")} error={fieldError("contextWindow")} errorId={describedBy("contextWindow")}>
                <TextInput
                  inputMode="numeric"
                  value={state.values.contextWindow}
                  onChange={(event) => setField("contextWindow", event.target.value)}
                  aria-invalid={!!errors.contextWindow || undefined}
                  aria-describedby={describedBy("contextWindow")}
                  disabled={!supported}
                />
              </Field>
            )}
            {fieldSupported("maxTokens") && (
              <Field label={t("models.maxTokensField")} error={fieldError("maxTokens")} errorId={describedBy("maxTokens")}>
                <TextInput
                  inputMode="numeric"
                  value={state.values.maxTokens}
                  onChange={(event) => setField("maxTokens", event.target.value)}
                  aria-invalid={!!errors.maxTokens || undefined}
                  aria-describedby={describedBy("maxTokens")}
                  disabled={!supported}
                />
              </Field>
            )}
          </div>
        )}
        {!idOnly && fieldSupported("reasoning") && (
          <Field label={t("models.reasoningModel")}>
            <Switch
              checked={state.values.reasoning}
              onChange={(value) => setField("reasoning", value)}
              disabled={!supported}
              label={t("models.reasoningEnabled")}
            />
          </Field>
        )}
      </ModalSection>

      {state.preview && (state.preview.references.length > 0 || state.preview.runtimeApply) && (
        <ModalSection title={t("models.impactPreview")}>
          <div className={styles.impactSummary}>
            {t("models.runtimeImpact", {
              runtime: runtimeLabel(state.preview.runtimeApply),
              count: state.preview.references.length,
            })}
          </div>
          {groupReferences(state.preview).map(([store, references]) => (
            <div key={store} className={styles.referenceGroup}>
              <strong>{store} · {references.length}</strong>
              <ul>{references.map((reference) => <li key={reference.referenceKey}>{reference.referenceKey}</li>)}</ul>
            </div>
          ))}
          {state.phase === "confirming" && (
            <div className={styles.impactActions} role="alertdialog" aria-label={t("models.impactConfirmAria")}>
              <button type="button" className="btn-secondary" autoFocus onClick={() => setField("name", state.values.name)}>{t("common.cancel")}</button>
              <button type="button" className="btn-danger" onClick={() => state.preview && void runApply(state.preview)}>
                {t("models.confirmApply")}
              </button>
            </div>
          )}
        </ModalSection>
      )}

      {(requestError || state.result) && (
        <ModalSection title={t("models.applyResults")}>
          <div className={styles.results} role="alert">
            {requestError && <p>{requestError}</p>}
            {visibleResultDetails.map((detail, index) => (
              <div key={`${detail.stage}:${detail.reference || index}`} className={styles.resultRow}>
                <span>{t("models.stageLabel", { stage: detail.stage })}</span>
                <strong className={styles.resultStatus}>
                  <span aria-hidden="true">{resultStatus(detail.status).icon}</span>
                  {resultStatus(detail.status).label}
                </strong>
                {detail.reference && <code>{detail.reference}</code>}
                {detail.stage === "catalog-pending" && <span>{t("models.catalogPending")}</span>}
                {detail.stage === "client-sync-pending" && <span>{t("models.clientSyncPending")}</span>}
              </div>
            ))}
            {state.result?.operationId && (
              <p className={styles.operationId}>{t("models.operationReference", { operationId: state.result.operationId })}</p>
            )}
          </div>
        </ModalSection>
      )}

      <div className={styles.liveStatus} aria-live="polite">
        {state.phase === "previewing" && t("models.previewing")}
        {state.phase === "applying" && t("models.applying")}
      </div>
    </Modal>
  );
}
