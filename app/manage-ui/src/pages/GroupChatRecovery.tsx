import { useState } from "react";
import { useTranslation } from "react-i18next";
import { reconcileGroupChatExecution, type GroupInteractionTarget } from "../api/client";
import { useToast } from "../components/ui";
import type { GroupChatView, GroupExecutionRecovery } from "../types";
import styles from "./GroupChatPanel.module.css";

export default function GroupChatRecovery({ groupId, target, recovery, onView }: {
  groupId: string; target: GroupInteractionTarget; recovery: GroupExecutionRecovery; onView(view: GroupChatView): void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    try { onView(await reconcileGroupChatExecution(groupId, target)); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className={styles.recovery} role="status">
    <span>{t(recovery.type === "result" ? "groupChat.recovery.result"
      : recovery.cancelRequested ? "groupChat.recovery.cancel" : "groupChat.recovery.execution")}</span>
    <button type="button" className="btn-sm" disabled={busy} onClick={() => void read()}>
      {t(recovery.type === "result" ? "groupChat.recovery.reread" : "groupChat.recovery.reconcile")}
    </button>
  </div>;
}
