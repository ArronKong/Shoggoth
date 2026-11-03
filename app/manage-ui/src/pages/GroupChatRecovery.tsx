import { useTranslation } from "react-i18next";
import type { GroupExecutionRecovery } from "../types";
import styles from "./GroupChatPanel.module.css";

export default function GroupChatRecovery({ recovery }: { recovery: GroupExecutionRecovery }) {
  const { t } = useTranslation();
  if (recovery.type !== "result" || recovery.cancelRequested) return null;
  return <div className={styles.recovery} role="status">
    <span>{t("groupChat.recovery.result")}</span>
  </div>;
}
