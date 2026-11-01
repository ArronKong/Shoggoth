import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ChatStatusNotice from "./ChatStatusNotice";

export default function ChatServiceRecoveryNotice({ action }: { action?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ChatStatusNotice title={t("settings.serviceRecoveryRequired")} tone="warning" role="alert" action={action} testId="chat-service-recovery">
      {t("settings.serviceRecoveryHint")}
    </ChatStatusNotice>
  );
}
