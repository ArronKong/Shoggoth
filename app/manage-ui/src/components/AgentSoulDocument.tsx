import { useTranslation } from "react-i18next";
import ChatMarkdown from "./ChatMarkdown";
import styles from "./AgentSoulDocument.module.css";

/** 单聊资料和群详情共用 SOUL 正文排版与空态。 */
export default function AgentSoulDocument({ text }: { text: string }) {
  const { t } = useTranslation();
  return text.trim() ? <ChatMarkdown text={text} className={`chat-md ${styles.text}`} />
    : <p className={styles.empty}>{t("chat.agentSoulEmpty")}</p>;
}
