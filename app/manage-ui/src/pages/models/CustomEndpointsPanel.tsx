import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CustomEndpoint, CustomEndpointsSnapshot } from "../../types";
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
import styles from "./CustomEndpointsPanel.module.css";

type SnapshotState = {
  controller: EndpointController;
  backend: string;
  value: CustomEndpointsSnapshot;
};

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
}: {
  controller: EndpointController;
  active: boolean;
  /** 供「代理」页概览的设置引导跳转定位（?section=endpoints）。 */
  anchorId?: string;
  description?: string;
  /** 完整保存/删除后通知页面刷新（端点进出会改目录）。 */
  onChanged: () => void;
  onActivation?: (activation?: { kind: string; available?: boolean } | null) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();

  const [snapshotState, setSnapshotState] = useState<SnapshotState | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [mutationNote, setMutationNote] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteRecovery, setDeleteRecovery] = useState<DeleteRecovery | null>(null);
  const [modal, setModal] = useState<{
    endpoint: CustomEndpoint | null;
    generation: number;
  } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const modalGeneration = useRef(0);
  const listEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const controllerRef = useRef(controller);
  const deleteRecoveryRef = useRef<DeleteRecovery | null>(null);
  deleteRecoveryRef.current = deleteRecovery;

  // 快照同时带 controller 身份；即使 effect 尚未来得及执行，也不会把旧后端内容
  // 暂时投影成新后端的列表。
  const snapshot = (
    snapshotState?.controller === controller
    && snapshotState.backend === controller.backend
  ) ? snapshotState.value : null;

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
      setListError(null);
      setMutationNote(null);
    }

    const epoch = ++listEpoch.current;
    if (!active) {
      mutationEpoch.current += 1;
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setListError(null);
    controller.list(abort.signal)
      .then((next) => {
        if (epoch !== listEpoch.current) return;
        setSnapshotState({ controller, backend: controller.backend, value: next });
      })
      .catch((error) => {
        if (epoch !== listEpoch.current || abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        // 同一 controller 的瞬时失败保留最后一份可信快照；身份切换时旧快照因上面的
        // controller 标记不会显示，也不会被伪装成 supported:false/空列表。
        setListError(message);
        toast.error(message);
      })
      .finally(() => {
        if (epoch === listEpoch.current) setLoading(false);
      });
    return () => {
      abort.abort();
      if (epoch === listEpoch.current) listEpoch.current += 1;
    };
    // toast 身份不稳定，纳入依赖会让父级重渲染触发无意义重拉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!isEndpointMutationComplete(outcome)) return false;
    setSnapshotState({ controller, backend: controller.backend, value: outcome.snapshot });
    setMutationNote(null);
    setDeleteRecovery(null);
    if (outcome.snapshot.warnings?.length) toast.error(outcome.snapshot.warnings.join("; "));
    else toast.success(t("models.settings.endpoints.deleteOk", { name: endpoint.name }));
    onChanged();
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
          retainSession = true;
          setDeleteRecovery({ endpoint, session, outcome: first });
          return;
        }
        const forced = await controller.remove(endpoint, session, true);
        if (epoch !== mutationEpoch.current || controllerRef.current !== activeController) return;
        noteOutcome(forced);
        if (completeDelete(endpoint, forced)) return;
        setMutationNote(t("models.settings.endpoints.mutationIncomplete", {
          status: forced.status,
          code: forced.code ?? forced.recovery?.code ?? "—",
          stage: forced.stage ?? forced.recovery?.stage ?? "—",
        }));
        toast.error(t("models.settings.endpoints.operationIncomplete"));
        retainSession = true;
        setDeleteRecovery({ endpoint, session, outcome: forced });
        return;
      }

      setMutationNote(t("models.settings.endpoints.mutationIncomplete", {
        status: first.status,
        code: first.code ?? first.recovery?.code ?? "—",
        stage: first.stage ?? first.recovery?.stage ?? "—",
      }));
      toast.error(t("models.settings.endpoints.operationIncomplete"));
      retainSession = true;
      setDeleteRecovery({ endpoint, session, outcome: first });
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
  const missingIn = (endpoint: CustomEndpoint) =>
    (snapshot?.profiles ?? []).filter((profile) => !(endpoint.profiles ?? []).includes(profile));
  const openModal = (endpoint: CustomEndpoint | null) => {
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
            <button className="ui-cbtn ui-cbtn--gold" onClick={() => openModal(null)}>
              {t("models.settings.endpoints.addBtn")}
            </button>
          </span>
        )}
      </div>
      <p className="ui-hint">{description ?? t("models.settings.endpoints.subtitle")}</p>
      {loading && !snapshot && <p className="ui-hint">{t("common.loading")}</p>}
      {listError && <p className={styles.recoveryNote} role="status">{listError}</p>}
      {mutationNote && <p className={styles.recoveryNote} role="status">{mutationNote}</p>}
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
                disabled={Boolean(deleteRecovery)}
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
                      deleting === endpoint.id
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
            setSnapshotState({ controller, backend: controller.backend, value: next });
          }}
          onSaved={(next) => {
            setSnapshotState({ controller, backend: controller.backend, value: next });
            setModalOpen(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
