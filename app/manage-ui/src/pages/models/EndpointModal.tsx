import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CustomEndpoint, CustomEndpointInput, CustomEndpointsSnapshot } from "../../types";
import { Field, Option, Select, TextInput } from "../../components/Field";
import Modal from "../../components/Modal";
import { useConfirm, useToast } from "../../components/ui";
import {
  createEndpointMutationSession,
  isEndpointMutationComplete,
  type EndpointController,
  type EndpointMutationOutcome,
  type EndpointSafeReference,
} from "./endpoint-controller";
import styles from "./CustomEndpointsPanel.module.css";
import { endpointMutationNotice } from "./endpoint-mutation-state";

function IconSearch() {
  return (
    <svg width={16} height={16} viewBox="1 1 14 14" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12Z" />
      <path d="M10.667 11.1133L14.0537 14.5" />
    </svg>
  );
}

const slugify = (raw: string) =>
  raw.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase();

function fetchableUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return Boolean(url.protocol.startsWith("http") && url.host);
  } catch {
    return false;
  }
}

function outcomeReferences(outcome: EndpointMutationOutcome): EndpointSafeReference[] {
  return [
    ...(outcome.recovery?.references ?? []),
    ...outcome.steps.flatMap((step) => step.references ?? []),
  ];
}

export default function EndpointModal({
  open,
  controller,
  snapshot,
  endpoint,
  onClose,
  onOpenChangeComplete,
  onSaved,
  onSnapshot,
  onActivation,
}: {
  open: boolean;
  controller: EndpointController;
  snapshot: CustomEndpointsSnapshot;
  /** null = 新增；有值 = 编辑该端点 */
  endpoint: CustomEndpoint | null;
  onClose: () => void;
  onOpenChangeComplete: (open: boolean) => void;
  onSaved: (snapshot: CustomEndpointsSnapshot) => void;
  onSnapshot?: (snapshot: CustomEndpointsSnapshot) => void;
  onActivation?: (activation?: { kind: string; available?: boolean } | null) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const editing = Boolean(endpoint);
  const form = snapshot.form;
  const nameReadOnly = editing && form?.nameEditable === false;
  const firstModelIsDefault = form?.firstModelIsDefault !== false;
  const apiOptions = form?.apiOptions ?? [];
  const hasAdvancedApi = apiOptions.length > 0;

  const [name, setName] = useState(endpoint?.name ?? "");
  const [id, setId] = useState(endpoint?.id ?? "");
  const [idTouched, setIdTouched] = useState(editing);
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [api, setApi] = useState(
    endpoint?.api ?? form?.defaultApi ?? apiOptions[0] ?? "",
  );
  const [apiChanged, setApiChanged] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => [...new Set(endpoint?.models ?? [])]);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [mutationOutcome, setMutationOutcome] = useState<EndpointMutationOutcome | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fetchEpoch = useRef(0);
  const revealEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const saveSession = useMemo(
    () => createEndpointMutationSession(controller.backend, editing ? "edit" : "create"),
    [controller, editing],
  );
  const clearSession = useMemo(
    () => createEndpointMutationSession(controller.backend, "clear-key"),
    [controller],
  );

  const inputForRequest = (): CustomEndpointInput => {
    const input: CustomEndpointInput = {
      id: (idTouched ? id : slugify(name)) || undefined,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      model: selected[0] ?? "",
      models: selected,
      discoverModels: false,
    };
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    // 折叠、展开但未改、或编辑已有端点时都省略 api，让 controller/后端保留原值。
    if (apiChanged && api) input.api = api;
    return input;
  };

  useEffect(() => {
    const epoch = ++fetchEpoch.current;
    if (!fetchableUrl(baseUrl)) {
      setFetching(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      setFetching(true);
      setFetchNote(null);
      try {
        const request = inputForRequest();
        request.name = request.name || "endpoint";
        request.model = "";
        const result = await controller.validate(request, abort.signal);
        if (epoch !== fetchEpoch.current) return;
        setFetched(result.models ?? []);
        if (!result.ok) setFetchNote(result.message || t("common.error"));
        else if (!result.models?.length) {
          setFetchNote(t("models.settings.endpoints.fetchEmpty"));
        }
      } catch (error) {
        if (epoch !== fetchEpoch.current || abort.signal.aborted) return;
        setFetchNote(error instanceof Error ? error.message : String(error));
      } finally {
        if (epoch === fetchEpoch.current) setFetching(false);
      }
    }, 700);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
    // name/selected/id 不触发目录探测；它们不改变远端连接身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, baseUrl, apiKey, api, apiChanged]);

  useEffect(() => () => {
    fetchEpoch.current += 1;
    revealEpoch.current += 1;
    mutationEpoch.current += 1;
    controller.release?.(saveSession);
    controller.release?.(clearSession);
  }, [clearSession, controller, saveSession]);

  const chips = useMemo(
    () => [...new Set([...fetched, ...selected])],
    [fetched, selected],
  );
  const visibleChips = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return chips;
    return chips.filter((model) => model.toLowerCase().includes(normalized));
  }, [chips, query]);

  const toggle = (model: string) =>
    setSelected((current) =>
      current.includes(model)
        ? current.filter((candidate) => candidate !== model)
        : [...current, model]);

  const addManual = () => {
    const model = manual.trim();
    if (!model) return;
    setSelected((current) => current.includes(model) ? current : [...current, model]);
    setManual("");
  };

  const noteOutcome = (outcome: EndpointMutationOutcome) => {
    if (outcome.activation) onActivation?.(outcome.activation);
  };

  const retainIncomplete = (outcome: EndpointMutationOutcome) => {
    setMutationOutcome(outcome);
    setMutationError(null);
    if (outcome.snapshot) onSnapshot?.(outcome.snapshot);
    toast.error(t("models.settings.endpoints.operationIncomplete"));
  };

  const finishOutcome = (
    outcome: EndpointMutationOutcome,
    successMessage: string,
  ): boolean => {
    noteOutcome(outcome);
    if (!isEndpointMutationComplete(outcome)) {
      retainIncomplete(outcome);
      return false;
    }
    setMutationOutcome(null);
    setMutationError(null);
    if (outcome.snapshot.warnings?.length) toast.error(outcome.snapshot.warnings.join("; "));
    else toast.success(successMessage);
    setApiKey("");
    controller.release?.(outcome.operationId === clearSession.rootOperationId
      ? clearSession
      : saveSession);
    onSaved(outcome.snapshot);
    return true;
  };

  const recoveryLocked = mutationOutcome?.recovery?.locked === true;
  const recoveryNeedsSecret = mutationOutcome?.recovery?.needsSecret === true;
  const recoverySession = mutationOutcome?.operationId === clearSession.rootOperationId
    ? clearSession
    : saveSession;
  const canRetry = recoveryLocked
    && mutationOutcome?.recovery?.retryable !== false
    && Boolean(controller.retry)
    && (!recoveryNeedsSecret || Boolean(apiKey.trim()));
  const canSave = Boolean(
    !saving
    && !clearing
    && (recoveryLocked
      ? canRetry
      : name.trim() && baseUrl.trim() && selected.length > 0),
  );

  const confirmBlockedModelRemoval = async (
    outcome: EndpointMutationOutcome,
    epoch: number,
  ): Promise<EndpointMutationOutcome> => {
    const blocked = outcome.recovery?.blockedRemoval;
    if (!blocked || !controller.confirmBlockedRemoval) return outcome;
    const approved = await confirm({
      title: t("models.settings.endpoints.deleteReferencesTitle"),
      message: (
        <div>
          <p>{t("models.settings.endpoints.deleteReferencesConfirm", { name: blocked.modelId })}</p>
          {outcomeReferences(outcome).length > 0 && (
            <ul className={styles.referenceList}>
              {outcomeReferences(outcome).map((reference, index) => (
                <li key={`${reference.store}:${reference.referenceKey ?? ""}:${index}`}>
                  <span className="mono">{reference.store}</span>
                  {reference.referenceKey && <> · <span className="mono">{reference.referenceKey}</span></>}
                  {reference.scope && <> · {reference.scope}</>}
                  {reference.agent && <> · {reference.agent}</>}
                  {reference.profile && <> · {reference.profile}</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
      confirmLabel: t("models.settings.endpoints.deleteForce"),
      danger: true,
    });
    if (!approved || epoch !== mutationEpoch.current) return outcome;
    return controller.confirmBlockedRemoval(saveSession, blocked.operationId);
  };

  const doSave = async () => {
    if (!canSave) return;
    const epoch = ++mutationEpoch.current;
    const activeController = controller;
    setSaving(true);
    setMutationError(null);
    try {
      const first = recoveryLocked && controller.retry
        ? await controller.retry(
            recoverySession,
            recoveryNeedsSecret ? { apiKey: apiKey.trim() } : undefined,
          )
        : await controller.save(inputForRequest(), saveSession);
      if (epoch !== mutationEpoch.current || activeController !== controller) return;
      const outcome = recoverySession.kind === "clear-key"
        ? first
        : await confirmBlockedModelRemoval(first, epoch);
      if (epoch !== mutationEpoch.current || activeController !== controller) return;
      finishOutcome(
        outcome,
        t(recoverySession.kind === "clear-key"
          ? "models.settings.endpoints.clearKeyOk"
          : "models.settings.endpoints.saveOk"),
      );
    } catch (error) {
      if (epoch !== mutationEpoch.current || activeController !== controller) return;
      const message = error instanceof Error ? error.message : String(error);
      setMutationError(message);
      toast.error(message);
    } finally {
      if (epoch === mutationEpoch.current && activeController === controller) setSaving(false);
    }
  };

  const doReveal = async () => {
    if (!endpoint || !controller.revealApiKey || revealing) return;
    if (revealedKey !== null) {
      revealEpoch.current += 1;
      setRevealedKey(null);
      return;
    }
    const epoch = ++revealEpoch.current;
    const abort = new AbortController();
    setRevealing(true);
    try {
      const value = await controller.revealApiKey(endpoint, abort.signal);
      if (epoch === revealEpoch.current && value !== null) setRevealedKey(value);
    } catch (error) {
      if (!abort.signal.aborted && epoch === revealEpoch.current) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (epoch === revealEpoch.current) setRevealing(false);
    }
  };

  const doClear = async () => {
    if (!endpoint || !controller.clearApiKey || clearing) return;
    const guardEpoch = mutationEpoch.current;
    const approved = await confirm({
      title: t("models.settings.endpoints.clearKeyTitle", { name: endpoint.name }),
      message: t("models.settings.endpoints.clearKeyConfirm", { name: endpoint.name }),
      confirmLabel: t("models.settings.endpoints.clearKey"),
      danger: true,
    });
    if (!approved || guardEpoch !== mutationEpoch.current) return;
    const epoch = ++mutationEpoch.current;
    const activeController = controller;
    setClearing(true);
    setMutationError(null);
    try {
      const outcome = await controller.clearApiKey(endpoint, clearSession);
      if (epoch !== mutationEpoch.current || activeController !== controller) return;
      finishOutcome(outcome, t("models.settings.endpoints.clearKeyOk"));
    } catch (error) {
      if (epoch !== mutationEpoch.current || activeController !== controller) return;
      const message = error instanceof Error ? error.message : String(error);
      setMutationError(message);
      toast.error(message);
    } finally {
      if (epoch === mutationEpoch.current && activeController === controller) setClearing(false);
    }
  };

  const references = mutationOutcome ? outcomeReferences(mutationOutcome) : [];

  return (
    <Modal
      open={open}
      title={editing ? t("models.settings.endpoints.formEdit") : t("models.settings.endpoints.formAdd")}
      onClose={() => {
        mutationEpoch.current += 1;
        controller.release?.(saveSession);
        controller.release?.(clearSession);
        setApiKey("");
        setRevealedKey(null);
        onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
      width={720}
      dismissible={!saving && !clearing}
      footer={
        <button className="ui-cbtn ui-cbtn--gold" disabled={!canSave} onClick={() => void doSave()}>
          {saving
            ? t("common.saving")
            : recoveryLocked
              ? t("models.settings.endpoints.retryMutation")
              : t("common.save")}
        </button>
      }
    >
      <div className={styles.modalGrid}>
        <Field
          label={t("models.settings.endpoints.name")}
          hint={!editing && form?.nameEditable === false
            ? t("models.settings.endpoints.nameCreateHint")
            : undefined}
        >
          <TextInput
            value={name}
            autoComplete="off"
            placeholder="openai"
            disabled={nameReadOnly || recoveryLocked}
            onChange={(event) => {
              setName(event.target.value);
              if (!idTouched) setId(slugify(event.target.value));
            }}
          />
        </Field>
        <Field label={t("models.settings.endpoints.providerId")}>
          <TextInput
            value={idTouched ? id : slugify(name)}
            spellCheck={false}
            autoComplete="off"
            disabled={editing || recoveryLocked}
            title={editing ? t("models.settings.endpoints.idLocked") : undefined}
            onChange={(event) => {
              setIdTouched(true);
              setId(slugify(event.target.value));
            }}
          />
        </Field>
        <Field label={t("models.settings.endpoints.url")}>
          <TextInput
            value={baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.example.com/v1"
            disabled={recoveryLocked}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        <Field
          label={t("models.settings.endpoints.apiKey")}
          hint={editing ? t("models.settings.endpoints.apiKeyKeepHint") : undefined}
        >
          <div className={styles.keyInputRow}>
            <TextInput
              type="password"
              value={apiKey}
              spellCheck={false}
              autoComplete="new-password"
              placeholder={editing
                ? t("models.settings.endpoints.apiKeyKeepHint")
                : t("models.settings.endpoints.apiKeyOptional")}
              disabled={recoveryLocked && !recoveryNeedsSecret}
              onChange={(event) => {
                setApiKey(event.target.value);
                setRevealedKey(null);
              }}
            />
            {endpoint?.canRevealApiKey && controller.revealApiKey && (
              <button className="ui-cbtn ui-cbtn--sm" type="button" disabled={recoveryLocked} onClick={() => void doReveal()}>
                {revealedKey !== null ? t("keys.hide") : t("keys.reveal")}
              </button>
            )}
            {endpoint?.canClearApiKey && controller.clearApiKey && (
              <button
                className="btn-danger"
                type="button"
                disabled={clearing || recoveryLocked}
                onClick={() => void doClear()}
              >
                {t("models.settings.endpoints.clearKey")}
              </button>
            )}
          </div>
          {revealedKey !== null && (
            <span className={`${styles.keyPreview} mono`}>{revealedKey}</span>
          )}
        </Field>
      </div>

      {hasAdvancedApi && (
        <div className={styles.advancedBlock}>
          <button
            type="button"
            className={styles.advancedToggle}
            aria-expanded={advancedOpen}
            disabled={recoveryLocked}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {t("models.settings.endpoints.advanced")}
          </button>
          {advancedOpen && (
            <Field label={t("models.settings.endpoints.apiProtocol")}>
              <Select
                value={api}
                disabled={recoveryLocked}
                onChange={(value) => {
                  setApi(value);
                  setApiChanged(true);
                }}
              >
                {apiOptions.map((option) => <Option key={option} value={option}>{option}</Option>)}
              </Select>
            </Field>
          )}
        </div>
      )}

      {(mutationOutcome || mutationError) && (
        <div className={styles.recoveryBox} role="status">
          <strong>{t("models.settings.endpoints.recoveryTitle")}</strong>
          {mutationError ? (
            <p>{mutationError}</p>
          ) : mutationOutcome && (
            <>
              <p>{t("models.settings.endpoints.mutationIncomplete", {
                status: mutationOutcome.status,
                code: mutationOutcome.code ?? mutationOutcome.recovery?.code ?? "—",
                stage: mutationOutcome.stage ?? mutationOutcome.recovery?.stage ?? "—",
              })}</p>
              <p>{t(`models.settings.endpoints.${endpointMutationNotice(mutationOutcome)}`)}</p>
              {references.length > 0 && (
                <ul className={styles.referenceList}>
                  {references.map((reference, index) => (
                    <li key={`${reference.store}:${reference.referenceKey ?? ""}:${index}`}>
                      <span className="mono">{reference.store}</span>
                      {reference.referenceKey && <> · <span className="mono">{reference.referenceKey}</span></>}
                      {reference.scope && <> · {reference.scope}</>}
                      {reference.agent && <> · {reference.agent}</>}
                      {reference.profile && <> · {reference.profile}</>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      <div className={styles.modelsBlock}>
        <div className={styles.modelsHead}>
          <span className={styles.modelsLabel}>{t("models.settings.endpoints.modelsLabel")}</span>
          {fetched.length > 20 && (
            <button
              className={`${styles.searchBtn} ${searchOpen ? styles.searchBtnOn : ""}`}
              title={t("models.settings.endpoints.searchTitle")}
              aria-label={t("models.settings.endpoints.searchTitle")}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((open) => {
                  if (open) setQuery("");
                  return !open;
                });
              }}
            >
              <IconSearch />
            </button>
          )}
        </div>
        <p className={styles.modelsHint}>
          {t(firstModelIsDefault
            ? "models.settings.endpoints.modelsHint"
            : "models.settings.endpoints.modelsHintNoDefault")}
        </p>
        {searchOpen && (
          <TextInput
            autoFocus
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("models.settings.endpoints.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
        )}
        {fetching && <p className={styles.fetchNote}>{t("models.settings.endpoints.fetching")}</p>}
        {!fetching && fetchNote && <p className={styles.fetchNote}>{fetchNote}</p>}
        {visibleChips.length > 0 && (
          <div className={styles.chips}>
            {visibleChips.map((model) => {
              const selectedModel = selected.includes(model);
              return (
                <button
                  key={model}
                  className={`${styles.chip} ${selectedModel ? styles.chipOn : ""}`}
                  aria-pressed={selectedModel}
                  disabled={recoveryLocked}
                  onClick={() => toggle(model)}
                >
                  {model}
                  {firstModelIsDefault && selectedModel && selected[0] === model && (
                    <span className={styles.chipDefault}>
                      {t("models.settings.endpoints.defaultBadge")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {query.trim() && visibleChips.length === 0 && (
          <p className={styles.fetchNote}>{t("models.settings.endpoints.searchNoMatch")}</p>
        )}
        <div className={styles.manualRow}>
          <TextInput
            value={manual}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("models.settings.endpoints.manualPlaceholder")}
            disabled={recoveryLocked}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addManual();
            }}
          />
          <button className="ui-cbtn" disabled={recoveryLocked || !manual.trim()} onClick={addManual}>
            {t("models.settings.endpoints.manualAdd")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
