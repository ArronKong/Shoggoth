import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  abandonModelChangeOperation, getModelChangeOperation, recoverModelChangeOperation, getPendingModelOperationIdentities,
} from "../../api/client";
import type { ModelChangeOperation } from "../../types";
import { useConfirm, useToast } from "../../components/ui";
import {
  acceptModelOperationRecoveryRead, beginModelOperationRecoveryRead, confirmModelOperationTerminal,
  failModelOperationRecoveryRead, getModelOperationRecoverySnapshot, initializeModelOperationRecoveryStorage, retainModelOperation,
  subscribeModelOperationRecovery, type RetainedModelOperation,
} from "./model-operation-recovery";
import styles from "../keys/KeysPanel.module.css";

/** Journal-only recovery remains available even if config/catalog reads fail. */
export default function ModelOperationRecovery({ backend, active, onSettled }: {
  backend: string; active: boolean; onSettled: () => void;
}) {
  const { t } = useTranslation(), toast = useToast(), confirm = useConfirm();
  const snapshot = useSyncExternalStore(subscribeModelOperationRecovery,
    () => getModelOperationRecoverySnapshot(backend));
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettled] = useState<ModelChangeOperation[]>([]);
  const epoch = useRef(0), currentBackend = useRef(backend), currentActive = useRef(active);
  currentBackend.current = backend; currentActive.current = active;
  const read = useCallback(async () => {
    const captured = ++epoch.current;
    beginModelOperationRecoveryRead(backend);
    try {
      await initializeModelOperationRecoveryStorage();
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      const summary = await getPendingModelOperationIdentities(backend);
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      await acceptModelOperationRecoveryRead(summary);
    } catch {
      if (captured === epoch.current && currentBackend.current === backend && currentActive.current) {
        failModelOperationRecoveryRead(backend);
      }
    }
  }, [backend]);
  useEffect(() => {
    setBusy(null); setSettled([]);
    if (active) void read();
    return () => { epoch.current += 1; };
  }, [active, read]);
  const observe = async (original: RetainedModelOperation, recover = false) => {
    if (busy || !currentActive.current || currentBackend.current !== backend) return;
    const captured = epoch.current;
    setBusy(original.operationId);
    try {
      if (recover) {
        const current = getModelOperationRecoverySnapshot(backend);
        const retained = current.operations.find((row) => row.operationId === original.operationId && row.providerKey === original.providerKey);
        if (!retained || current.journal !== "ready" || !current.storageVerified || !current.serverPending.includes(original.operationId)
          || retained.status === "needs_secret" || retained.status === "not_found" || retained.code === "model_recovery_requested") return;
        // Await Main durability before POST. Unknown retain/POST ACK permits GET only.
        if (!await retainModelOperation({ ...original, code: "model_recovery_requested" })) throw new Error("unverified_storage");
      }
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      const receipt = await (recover ? recoverModelChangeOperation : getModelChangeOperation)(backend, original.operationId, original.providerKey);
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      if (receipt.terminal) {
        if (!await confirmModelOperationTerminal(receipt)) throw new Error("unverified_storage");
        if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
        setSettled((previous) => [receipt, ...previous].slice(0, 16));
        onSettled();
      } else if (!await retainModelOperation({ ...original, status: receipt.status,
        ...(recover || original.code === "model_recovery_requested" ? { code: "model_recovery_requested" } : {}) })) {
        throw new Error("unverified_storage");
      }
    } catch {
      if (captured === epoch.current && currentBackend.current === backend && currentActive.current) {
        toast.error(t("models.dirManagedUnconfirmed"));
      }
    } finally { if (captured === epoch.current) setBusy(null); }
  };
  // 用户显式放弃服务端仍挂着的原操作（如改名停在「需要重新输入 Key」）：服务端把结论记为
  // 失败，不回滚已写入的配置；只有终态回执经 Main 核对后才解锁。
  const abandon = async (original: RetainedModelOperation) => {
    if (busy || !currentActive.current || currentBackend.current !== backend) return;
    const captured = epoch.current;
    const approved = await confirm({
      title: t("models.dirManagedAbandonTitle"),
      message: t("models.dirManagedAbandonConfirm", { provider: original.providerKey }),
      confirmLabel: t("models.dirManagedAbandon"),
      danger: true,
    });
    if (!approved || captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
    setBusy(original.operationId);
    try {
      const receipt = await abandonModelChangeOperation(backend, original.operationId, original.providerKey);
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      if (!receipt.terminal || !await confirmModelOperationTerminal(receipt)) throw new Error("unverified_storage");
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      setSettled((previous) => [receipt, ...previous].slice(0, 16));
      onSettled();
    } catch {
      if (captured === epoch.current && currentBackend.current === backend && currentActive.current) {
        toast.error(t("models.dirManagedUnconfirmed"));
      }
    } finally { if (captured === epoch.current) setBusy(null); }
  };
  const settledMessage = (receipt: ModelChangeOperation) => receipt.code === "operation_not_admitted"
    ? "models.dirManagedNotAdmitted" : receipt.code === "abandoned_by_user" ? "models.dirManagedAbandoned"
      : receipt.status === "applied" ? "models.dirManagedApplied"
        : receipt.status === "compensated" ? "models.dirManagedCompensated" : "models.dirManagedFailed";
  if (!active) return null;
  if (snapshot.journal === "ready" && snapshot.storageVerified && snapshot.operations.length === 0 && settled.length === 0) return null;
  return <section className={styles.card} data-model-operation-recovery>
    <div className={styles.cardHead}><h4>{t("models.dirManagedRecoveryTitle")}</h4>
      <p className={styles.cardDesc}>{t("models.dirManagedRecoveryDescription")}</p></div>
    <div className={styles.cardBody}>
      {(snapshot.journal !== "ready" || !snapshot.storageVerified) && <div role="status" data-model-recovery-unknown>
        <p>{t(snapshot.journal === "loading" ? "models.dirManagedRecoveryLoading" : "models.dirManagedRecoveryUnknown")}</p>
        <button type="button" className={styles.linkBtn} disabled={snapshot.journal === "loading" || busy !== null}
          onClick={() => void read()}>{t("models.dirManagedRecoveryRead")}</button>
      </div>}
      {!snapshot.storageVerified && <p role="status">{t("models.dirManagedRecoveryStorage")}</p>}
      {snapshot.operations.map((original) => <div key={original.operationId} className={styles.group} data-model-recovery-operation>
        <p>{original.providerKey}</p>
        <p>{t("models.dirManagedOperation", { operationId: original.operationId, status: original.status })}</p>
        <button type="button" className={styles.linkBtn} disabled={busy !== null}
          onClick={() => void observe(original)}>{t("models.dirManagedObserve")}</button>
        {snapshot.journal === "ready" && snapshot.storageVerified && snapshot.serverPending.includes(original.operationId)
          && original.status !== "needs_secret" && original.status !== "not_found" && original.code !== "model_recovery_requested"
          && <button type="button" className={styles.linkBtn} disabled={busy !== null}
            onClick={() => void observe(original, true)}>{t("models.dirManagedRecoveryResume")}</button>}
        {snapshot.journal === "ready" && snapshot.storageVerified && snapshot.serverPending.includes(original.operationId)
          && <button type="button" className={styles.linkBtn} disabled={busy !== null} data-model-recovery-abandon
            onClick={() => void abandon(original)}>{t("models.dirManagedAbandon")}</button>}
        {original.code === "model_recovery_requested" && <p>{t("models.dirManagedRecoveryRequested")}</p>}
        {original.status === "not_found" && <p>{t("models.dirManagedNotObserved")}</p>}
      </div>)}
      {settled.map((receipt) => <div key={receipt.operationId} className={styles.group} role="status" data-model-recovery-terminal>
        <p>{t(settledMessage(receipt))}</p>
        <p>{t("models.dirManagedOperation", { operationId: receipt.operationId, status: receipt.status })}</p>
      </div>)}
    </div>
  </section>;
}
