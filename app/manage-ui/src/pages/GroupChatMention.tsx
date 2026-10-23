import { useTranslation } from "react-i18next";
import AgentAvatar from "../components/AgentAvatar";
import type { GroupChatMember } from "../types";
import styles from "./GroupChatPanel.module.css";

export default function GroupChatMention({ member, text = "@" + member.displayName, onOpen }: {
  member: GroupChatMember; text?: string; onOpen(memberId: string): void;
}) {
  const { t } = useTranslation();
  return <button type="button" className={styles.inlineMention} data-group-mention={member.id}
    title={t("groupChat.card.open")} onClick={event => { event.stopPropagation(); onOpen(member.id); }}>
    <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.inlineMentionAvatar} />
    <span>{text.replace(/^@/u, "")}</span>
  </button>;
}
