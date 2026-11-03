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
  setModelOperationRecoveryAdvisory, subscribeModelOperationRecovery, type RetainedModelOperation,
} from "./model-operation-recovery";
import styles from "../keys/KeysPanel.module.css";

/** Journal-only recovery remains available even if config/catalog reads fail.
 * advisory (native-config): like the official UI nothing is locked; earlier rows are
 * settled by one read-only check per open, and only unresolved rows are shown.
 * advisory undefined = write mode not known yet: the journal is read, nothing is shown. */
export default function ModelOperationRecovery({ backend, active, advisory, onSettled }: {
  backend: string; active: boolean; advisory?: boolean; onSettled: () => void;
}) {
  const { t } = useTranslation(), toast = useToast(), confirm = useConfirm();
  const snapshot = useSyncExternalStore(subscribeModelOperationRecovery,
    () => getModelOperationRecoverySnapshot(backend));
  const [busy, setBusy] = useState<string | null>(null);
  const [settled, setSettled] = useState<ModelChangeOperation[]>([]);
  const [checked, setChecked] = useState(false);
  const advisoryOn = advisory === true;
  const epoch = useRef(0), currentBackend = useRef(backend), currentActive = useRef(active), currentAdvisory = useRef(advisoryOn);
  currentBackend.current = backend; currentActive.current = active; currentAdvisory.current = advisoryOn;
  const current = (captured: number) => captured === epoch.current && currentBackend.current === backend && currentActive.current;
  // Read-only GET per earlier row; a terminal receipt is acknowledged silently, anything else stays visible.
  const settleEarlierRows = async (captured: number) => {
    const snapshot = getModelOperationRecoverySnapshot(backend);
    for (const row of snapshot.operations) {
      if (snapshot.serverPending.includes(row.operationId)) continue;
      if (!current(captured)) return;
      try {
        const receipt = await getModelChangeOperation(backend, row.operationId, row.providerKey);
        if (receipt.terminal && current(captured)) await confirmModelOperationTerminal(receipt);
      } catch { /* unresolved rows stay for a manual check */ }
    }
  };
  const read = useCallback(async () => {
    const captured = ++epoch.current;
    beginModelOperationRecoveryRead(backend);
    try {
      await initializeModelOperationRecoveryStorage();
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      const summary = await getPendingModelOperationIdentities(backend);
      if (captured !== epoch.current || currentBackend.current !== backend || !currentActive.current) return;
      await acceptModelOperationRecoveryRead(summary);
      if (currentAdvisory.current) await settleEarlierRows(captured);
    } catch {
      if (captured === epoch.current && currentBackend.current === backend && currentActive.current) {
        failModelOperationRecoveryRead(backend);
      }
    } finally {
      if (current(captured)) setChecked(true);
    }
  }, [backend]);
  useEffect(() => { setModelOperationRecoveryAdvisory(backend, advisoryOn); }, [backend, advisoryOn]);
  useEffect(() => {
    setBusy(null); setSettled([]); setChecked(false);
    if (active) void read();
    return () => { epoch.current += 1; };
  }, [active, advisoryOn, read]);
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
  if (!active || advisory === undefined) return null;
  if (advisory ? !checked || snapshot.operations.length === 0 && settled.length === 0
    : snapshot.journal === "ready" && snapshot.storageVerified && snapshot.operations.length === 0 && settled.length === 0) return null;
  return <section className={styles.card} data-model-operation-recovery>
    <div className={styles.cardHead}><h4>{t("models.dirManagedRecoveryTitle")}</h4>
      <p className={styles.cardDesc}>{t("models.dirManagedRecoveryDescription")}</p></div>
    <div className={styles.cardBody}>
      {!advisory && (snapshot.journal !== "ready" || !snapshot.storageVerified) && <div role="status" data-model-recovery-unknown>
        <p>{t(snapshot.journal === "loading" ? "models.dirManagedRecoveryLoading" : "models.dirManagedRecoveryUnknown")}</p>
        <button type="button" className={styles.linkBtn} disabled={snapshot.journal === "loading" || busy !== null}
          onClick={() => void read()}>{t("models.dirManagedRecoveryRead")}</button>
      </div>}
      {!advisory && !snapshot.storageVerified && <p role="status">{t("models.dirManagedRecoveryStorage")}</p>}
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
