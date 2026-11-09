import { useTranslation } from "react-i18next";
import GroupMemberAvatar from "./GroupMemberAvatar";
import type { GroupChatMember } from "../types";
import styles from "./GroupChatPanel.module.css";

export function GroupMentionAvatarStack({ members }: { members: readonly GroupChatMember[] }) {
  if (!members.length) return null;
  return <span className={styles.mentionAvatarStack} aria-hidden="true">
    {members.slice(0, 3).map(member => <GroupMemberAvatar key={member.id} member={member} className={styles.mentionAvatarStackItem} />)}
  </span>;
}

export default function GroupChatMention({ member, everyone, picker }: {
  member?: GroupChatMember; everyone?: readonly GroupChatMember[];
  picker?: { id: string; prefill: boolean; disabled: boolean; open(button: HTMLButtonElement): void };
}) {
  const { t } = useTranslation();
  const id = member?.id ?? "all";
  const name = member?.displayName ?? t("groupChat.target.all");
  const avatar = member ? <GroupMemberAvatar member={member} className={styles.inlineMentionAvatar} />
    : everyone && <GroupMentionAvatarStack members={everyone} />;
  if (!picker) {
    return <span className={styles.inlineMention} data-group-mention={id}>{avatar}<span>{name}</span></span>;
  }
  const title = t("groupChat.composer.changeMention", { name });
  return <button type="button" className={styles.inlineMention} disabled={picker.disabled}
    data-group-prefill={picker.prefill ? id : undefined} data-group-composer-mention={id}
    title={title} aria-label={title} aria-haspopup="listbox" aria-controls={picker.id}
    onMouseDown={event => event.preventDefault()}
    onClick={event => { event.stopPropagation(); picker.open(event.currentTarget); }}>
    {avatar}
    <span>{name}</span>
  </button>;
}
