import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CustomEndpoint } from "../../types";
import { useConfirm, useToast } from "../../components/ui";
import EndpointModal from "./EndpointModal";
import {
  canConfirmEndpointRemoval,
  createEndpointMutationSession,
  endpointOutcomeReferences as safeReferences,
  isEndpointMutationComplete,
  type EndpointController,
  type EndpointMutationOutcome,
  type EndpointSafeReference,
} from "./endpoint-controller";
import { getModelOperationRecoverySnapshot, modelOperationRecoveryBlocks, subscribeModelOperationRecovery } from "./model-operation-recovery";
import { useSlowPending } from "./useSlowPending";
import { usePageCache } from "../../lib/usePageCache";
import { endpointMutationNotice } from "./endpoint-mutation-state";
import styles from "./CustomEndpointsPanel.module.css";
// Custom/fixture controllers stay isolated unless they explicitly share a snapshot scope.
const controllerKeys = new WeakMap<EndpointController, string>();
let controllerSequence = 0;
function snapshotKey(controller: EndpointController): string {
  if (controller.cacheKey) return controller.cacheKey;
  let key = controllerKeys.get(controller);
  if (!key) { key = `models:endpoints:controller:${++controllerSequence}`; controllerKeys.set(controller, key); }
  return key;
}

type DeleteRecovery = {
  endpoint: CustomEndpoint;
  session: ReturnType<typeof createEndpointMutationSession>;
  outcome: EndpointMutationOutcome;
};

function mayForceReferenceDelete(outcome: EndpointMutationOutcome): boolean {
  return canConfirmEndpointRemoval({
    code: outcome.code ?? outcome.recovery?.code,
    blockers: outcome.steps.flatMap((step) => step.blockers ?? []),
    references: safeReferences(outcome),
    canForce: outcome.canForce,
  });
}

export default function CustomEndpointsPanel({
  controller,
  active,
  anchorId,
  description,
  onChanged,
  onActivation,
  refreshKey = 0,
}: {
  controller: EndpointController;
  active: boolean;
  /** 供「代理」页概览的设置引导跳转定位（?section=endpoints）。 */
  anchorId?: string;
  description?: string;
  /** 完整保存/删除后通知页面刷新（端点进出会改目录）。 */
  onChanged: () => void;
  onActivation?: (activation?: { kind: string; available?: boolean } | null) => void;
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const recovery = useSyncExternalStore(subscribeModelOperationRecovery,
    () => getModelOperationRecoverySnapshot(controller.backend));
  const recoveryUnknown = recovery.required && (recovery.journal !== "ready" || !recovery.storageVerified);

  const { data: snapshot, loading, error: listError, refresh, replace } = usePageCache(
    snapshotKey(controller), () => controller.list(), { staleTime: 30_000, enabled: active },
  );
  const [mutationNote, setMutationNote] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<{ endpoint: CustomEndpoint; outcome: EndpointMutationOutcome } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const slowDelete = useSlowPending(deleting !== null);
  const [deleteRecovery, setDeleteRecovery] = useState<DeleteRecovery | null>(null);
  const [modal, setModal] = useState<{
    endpoint: CustomEndpoint | null;
    generation: number;
  } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const modalGeneration = useRef(0);
  const mutationEpoch = useRef(0);
  const controllerRef = useRef(controller);
  const deleteRecoveryRef = useRef<DeleteRecovery | null>(null);
  deleteRecoveryRef.current = deleteRecovery;

  useEffect(() => {
    if (snapshot) controller.adoptSnapshot?.(snapshot);
  }, [controller, snapshot]);

  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    if (active) void refresh();
  }, [active, refresh, refreshKey]);

  useEffect(() => {
    const identityChanged = controllerRef.current !== controller;
    if (identityChanged) {
      const pendingDelete = deleteRecoveryRef.current;
      if (pendingDelete) controllerRef.current.release?.(pendingDelete.session);
      controllerRef.current = controller;
      mutationEpoch.current += 1;
      setDeleteRecovery(null);
      setModalOpen(false);
      setModal(null);
      setMutationNote(null);
      setDeleteBlocked(null);
    }

    if (!active) {
      mutationEpoch.current += 1;
    }
  }, [active, controller]);

  useEffect(() => () => {
    mutationEpoch.current += 1;
    const pendingDelete = deleteRecoveryRef.current;
    if (pendingDelete) controllerRef.current.release?.(pendingDelete.session);
  }, []);

  const noteOutcome = (outcome: EndpointMutationOutcome) => {
    if (outcome.activation) onActivation?.(outcome.activation);
  };

  const completeDelete = (endpoint: CustomEndpoint, outcome: EndpointMutationOutcome) => {
    if (outcome.status === "applied" && outcome.configSaved === true) {
      if (outcome.snapshot) replace(outcome.snapshot);
      setMutationNote(null); setDeleteBlocked(null); setDeleteRecovery(null);
      toast.success(t("models.settings.endpoints.nativeDeleteOk", { name: endpoint.name }));
      if (outcome.warnings?.length) toast.info(outcome.warnings.join("；"));
      else if (outcome.sync === "pending") toast.info(t("models.dirManagedRefreshFailed"));
      onChanged();
      return true;
    }
    if (!isEndpointMutationComplete(outcome)) return false;
    replace(outcome.snapshot);
    setMutationNote(null);
    setDeleteBlocked(null);
    setDeleteRecovery(null);
    if (outcome.snapshot.warnings?.length) toast.error(outcome.snapshot.warnings.join("; "));
    else toast.success(t("models.settings.endpoints.deleteOk", { name: endpoint.name }));
    onChanged();
    return true;
  };

  const retainDeleteOutcome = (endpoint: CustomEndpoint, session: DeleteRecovery["session"], outcome: EndpointMutationOutcome) => {
    if (outcome.snapshot) replace(outcome.snapshot);
    // A proven zero-write rejection has no operation to resume. Keep the reason
    // visible, release the plan and let the user edit this or another endpoint.
    if (endpointMutationNotice(outcome) === "preflightBlocked" && outcome.recovery?.locked === false) {
      setDeleteRecovery(null);
      setDeleteBlocked({ endpoint, outcome });
      setMutationNote(null);
      return false;
    }
    setMutationNote(t(`models.settings.endpoints.${endpointMutationNotice(outcome)}`));
    toast.error(t("models.settings.endpoints.operationIncomplete"));
    setDeleteRecovery({ endpoint, session, outcome });
    return true;
  };

  const referenceConfirmMessage = (
    endpoint: CustomEndpoint,
    references: EndpointSafeReference[],
  ): ReactNode => (
    <div>
      <p>{t("models.settings.endpoints.deleteReferencesConfirm", { name: endpoint.name })}</p>
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
    </div>
  );

  const doDelete = async (endpoint: CustomEndpoint) => {
    if (deleting || (deleteRecovery && deleteRecovery.endpoint.id !== endpoint.id)) return;
    const previous = deleteRecovery?.endpoint.id === endpoint.id ? deleteRecovery : null;
    if (!previous) {
      const guardEpoch = mutationEpoch.current;
      const guardController = controller;
      const ok = await confirm({
        title: t("common.delete"),
        message: t("models.settings.endpoints.deleteConfirm", { name: endpoint.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (
        !ok
        || guardEpoch !== mutationEpoch.current
        || controllerRef.current !== guardController
      ) return;
    }

    const epoch = ++mutationEpoch.current;
    const activeController = controller;
    const session = previous?.session
      ?? createEndpointMutationSession(controller.backend, "delete");
    let retainSession = false;
    setDeleting(endpoint.id);
    setMutationNote(null);
    setDeleteBlocked(null);
    try {
      const first = previous?.outcome.recovery?.locked && controller.retry
        ? await controller.retry(session)
        : await controller.remove(endpoint, session, false);
      if (epoch !== mutationEpoch.current || controllerRef.current !== activeController) return;
      noteOutcome(first);
      if (completeDelete(endpoint, first)) return;

      if (mayForceReferenceDelete(first)) {
        setMutationNote(t("models.settings.endpoints.mutationIncomplete", {
          status: first.status,
          code: first.code ?? first.recovery?.code ?? "references_exist",
          stage: first.stage ?? first.recovery?.stage ?? "—",
        }));
        const references = safeReferences(first);
        const force = await confirm({
          title: t("models.settings.endpoints.deleteReferencesTitle"),
          message: referenceConfirmMessage(endpoint, references),
          confirmLabel: t("models.settings.endpoints.deleteForce"),
          danger: true,
        });
        if (epoch !== mutationEpoch.current || controllerRef.current !== activeController) return;
        if (!force) {
          retainSession = retainDeleteOutcome(endpoint, session, first);
          return;
        }
        const forced = await controller.remove(endpoint, session, true);
        if (epoch !== mutationEpoch.current || controllerRef.current !== activeController) return;
        noteOutcome(forced);
        if (completeDelete(endpoint, forced)) return;
        retainSession = retainDeleteOutcome(endpoint, session, forced);
        return;
      }

      retainSession = retainDeleteOutcome(endpoint, session, first);
    } catch (error) {
      if (epoch !== mutationEpoch.current || controllerRef.current !== activeController) return;
      const message = error instanceof Error ? error.message : String(error);
      setMutationNote(message);
      toast.error(message);
    } finally {
      if (!retainSession) activeController.release?.(session);
      if (epoch === mutationEpoch.current && controllerRef.current === activeController) {
        setDeleting(null);
      }
    }
  };

  const endpoints = snapshot?.endpoints ?? [];
  const blockedReferences = deleteBlocked ? safeReferences(deleteBlocked.outcome) : [];
  const primaryOwners = [...new Set(blockedReferences.flatMap((reference) => {
    if (reference.store !== "config") return [];
    if (reference.referenceKey === "agents.defaults.model.primary") return [t("models.settings.endpoints.primaryDefaultScope")];
    const agent = reference.referenceKey?.match(/^agents\.entries\.(.+)\.model\.primary$/)?.[1];
    return agent ? [agent] : [];
  }))];
  const cronReferences = blockedReferences.filter((reference) => reference.store === "cron");
  const missingIn = (endpoint: CustomEndpoint) =>
    (snapshot?.profiles ?? []).filter((profile) => !(endpoint.profiles ?? []).includes(profile));
  const openModal = (endpoint: CustomEndpoint | null) => {
    if (recoveryUnknown || endpoint && modelOperationRecoveryBlocks(controller.backend, endpoint.id)) {
      toast.info(t("models.dirManagedPending")); return;
    }
    const generation = ++modalGeneration.current;
    setModal({ endpoint, generation });
    setModalOpen(true);
  };

  return (
    <section className={styles.card} id={anchorId}>
      <div className="ui-secthead">
        <span className="ui-secthead-title">{t("models.settings.endpoints.title")}</span>
        {endpoints.length > 0 && <span className="ui-count">{endpoints.length}</span>}
        {snapshot?.supported && (
          <span className={styles.headActions}>
            <button className="ui-cbtn ui-cbtn--gold" disabled={recoveryUnknown} onClick={() => openModal(null)}>
              {t("models.settings.endpoints.addBtn")}
            </button>
          </span>
        )}
      </div>
      <p className="ui-hint">{description ?? t(snapshot?.form?.configurationDraft
        ? "models.settings.endpoints.nativeSubtitle" : "models.settings.endpoints.subtitle")}</p>
      {loading && !snapshot && <p className="ui-hint">{t("common.loading")}</p>}
      {listError && <p className={styles.recoveryNote} role="status">{listError}</p>}
      {mutationNote && <p className={styles.recoveryNote} role="status">{mutationNote}</p>}
      {deleteBlocked && <div className={styles.recoveryNote} role="alert">
        <p>{t("models.settings.endpoints.deleteBlocked", { name: deleteBlocked.endpoint.name })}</p>
        {primaryOwners.length > 0 && <p>{t("models.settings.endpoints.deletePrimaryOwners", { names: primaryOwners.join("、") })}</p>}
        {cronReferences.length > 0 && <p>{t("models.settings.endpoints.deleteCronReferences", { count: cronReferences.length })}</p>}
        <button className="ui-cbtn ui-cbtn--sm" onClick={() => setDeleteBlocked(null)}>{t("common.close")}</button>
      </div>}
      {slowDelete && <p className={styles.recoveryNote} role="status">{t("models.savingSlow")}</p>}
      {snapshot && !snapshot.supported && (
        <p className="ui-hint">{t("models.settings.endpoints.unsupported")}</p>
      )}
      {snapshot?.supported && (
        <div className={styles.subBlock}>
          {endpoints.length === 0 && (
            <p className={styles.emptyNote}>{t("models.settings.endpoints.empty")}</p>
          )}
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} className={styles.endpointRow}>
              <button
                type="button"
                className={styles.endpointMain}
                disabled={Boolean(deleteRecovery) || modelOperationRecoveryBlocks(controller.backend, endpoint.id)}
                onClick={() => openModal(endpoint)}
              >
                <span className={styles.endpointName}>
                  {endpoint.name}
                  {(endpoint.activeIn?.length ?? 0) > 0 && (
                    <span className="tag tag-active">
                      {t("models.settings.endpoints.activeIn", { names: endpoint.activeIn!.join(" ") })}
                    </span>
                  )}
                  {missingIn(endpoint).length > 0 && (
                    <span className="tag">
                      {t("models.settings.endpoints.missingIn", { names: missingIn(endpoint).join(" ") })}
                    </span>
                  )}
                  {endpoint.source === "direct-config" && (
                    <span className="tag">{t("models.settings.endpoints.configTag")}</span>
                  )}
                </span>
                <span className={`${styles.endpointUrl} mono`}>{endpoint.baseUrl}</span>
                <span className={styles.endpointMeta}>
                  {endpoint.models.length > 1
                    ? t("models.settings.endpoints.modelCount", {
                        model: endpoint.model,
                        count: endpoint.models.length,
                      })
                    : endpoint.model}
                  {endpoint.hasApiKey
                    ? ` · ${endpoint.apiKeyPreview || t("models.settings.endpoints.apiKeySet")}`
                    : ""}
                </span>
              </button>
              <span className={styles.endpointActions}>
                {endpoint.source !== "direct-config" && (
                  <button
                    className="btn-danger"
                    onClick={() => void doDelete(endpoint)}
                    disabled={Boolean(
                      deleting === endpoint.id || !deleteRecovery && modelOperationRecoveryBlocks(controller.backend, endpoint.id)
                      || (deleteRecovery && deleteRecovery.endpoint.id !== endpoint.id)
                    )}
                  >
                    {deleteRecovery?.endpoint.id === endpoint.id
                      ? t("models.settings.endpoints.retryMutation")
                      : t("common.delete")}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {modal && snapshot && (
        <EndpointModal
          key={modal.generation}
          open={modalOpen}
          controller={controller}
          snapshot={snapshot}
          endpoint={modal.endpoint}
          onClose={() => setModalOpen(false)}
          onOpenChangeComplete={(open) => {
            if (!open) setModal(null);
          }}
          onActivation={onActivation}
          onSnapshot={(next) => {
            replace(next);
          }}
          onSaved={(next) => {
            if (next) replace(next);
            setModalOpen(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
