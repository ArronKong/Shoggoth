import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui/react/menu";
import AgentAvatar from "../components/AgentAvatar";
import { GROUP_MAX_MEMBERS } from "../lib/groupChat";
import type { GroupChatView } from "../types";
import GroupChatRoleDocument from "./GroupChatRoleDocument";
import closeIcon from "../assets/figma/group-chat/group-details-close.svg";
import addIcon from "../assets/figma/group-chat/group-details-add.svg";
import styles from "./GroupChatDetails.module.css";

export type GroupChatDetailsProps = {
  view: GroupChatView;
  onClose(): void;
  onAddMember?(): void;
  onOpenMember?(memberId: string): void;
  onSearch?(): void;
  onRename?(): void;
  onSettings?(): void;
  onDelete?(): void;
  deleting?: boolean;
};

/** 群详情占用原聊天区域；公开角色原文仍通过固定版本和摘要校验读取。 */
export default function GroupChatDetails({ view, onClose, onAddMember, onOpenMember, onSearch,
  onRename, onSettings, onDelete, deleting = false }: GroupChatDetailsProps) {
  const { t } = useTranslation();
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ groupId: string; memberId: string } | null>(null);
  const members = view.members.filter(member => member.state === "active");
  const preferred = members.find(member => member.id === view.currentOwnerId) ?? members[0];
  const selected = (selection?.groupId === view.group.id
    ? members.find(member => member.id === selection.memberId) : undefined) ?? preferred;
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected?.id, view.group.id]);
  const active = view.group.status === "active" && !deleting;
  const canAdd = active && members.length < GROUP_MAX_MEMBERS && Boolean(onAddMember);
  const hasActions = Boolean(onSearch || onRename || onSettings || onDelete || onOpenMember);
  const selectMember = (memberId: string) => setSelection({ groupId: view.group.id, memberId });
  const navigateMembers = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % members.length
      : event.key === "ArrowLeft" ? (index + members.length - 1) % members.length
        : event.key === "Home" ? 0 : event.key === "End" ? members.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selectMember(members[next].id);
    const button = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    button?.focus();
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return <section className={styles.details} data-group-details aria-labelledby={`${id}-title`}>
    <header className={styles.header}>
      <h2 id={`${id}-title`} className={styles.title}>{view.group.name}</h2>
      <div className={styles.tools}>
        {hasActions && <Menu.Root>
          <Menu.Trigger className={styles.iconButton} data-group-details-action="menu" title={t("groupChat.strategy.settings")}
            aria-label={t("groupChat.strategy.settings")}><span className={styles.moreIcon} aria-hidden="true">···</span></Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className={styles.menuPositioner} sideOffset={6} align="end">
              <Menu.Popup className={styles.menu}>
                {onOpenMember && selected && <Menu.Item className={styles.menuItem} data-group-details-action="profile"
                  onClick={() => onOpenMember(selected.id)}>{t("groupChat.card.open")}</Menu.Item>}
                {onSearch && <Menu.Item className={styles.menuItem} data-group-details-action="search" onClick={onSearch}>{t("groupChat.search.open")}</Menu.Item>}
                {onRename && <Menu.Item className={styles.menuItem} data-group-details-action="rename" disabled={!active} onClick={onRename}>{t("groupChat.rename")}</Menu.Item>}
                {onSettings && <Menu.Item className={styles.menuItem} data-group-details-action="settings" disabled={!active} onClick={onSettings}>{t("groupChat.strategy.settings")}</Menu.Item>}
                {onDelete && <Menu.Item className={`${styles.menuItem} ${styles.deleteItem}`}
                  data-group-details-action="delete" disabled={deleting || view.group.status === "deleting"} onClick={onDelete}>{t("groupChat.delete")}</Menu.Item>}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>}
        <button type="button" className={styles.iconButton} data-group-details-action="close" onClick={onClose}
          aria-label={t("common.close")} title={t("common.close")}><img src={closeIcon} alt="" /></button>
      </div>
    </header>
    <div ref={listRef} className={styles.members} role="tablist" aria-label={t("groupChat.membersLabel")}>
      {members.map((member, index) => {
        const isSelected = member.id === selected?.id;
        return <button type="button" key={member.id} role="tab" id={`${id}-member-${index}`} data-group-details-member={member.id}
          aria-controls={`${id}-role`} aria-selected={isSelected} tabIndex={isSelected ? 0 : -1}
          className={`${styles.member}${isSelected ? ` ${styles.selected}` : ""}`}
          title={member.displayName} onClick={() => selectMember(member.id)}
          onKeyDown={event => navigateMembers(event, index)}>
          <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.avatar} />
          <span className={styles.memberName}>{member.displayName}</span>
        </button>;
      })}
      {canAdd && <button type="button" className={styles.addMember} data-group-details-action="add" onClick={onAddMember}
        aria-label={t("groupChat.members.addTitle")} title={t("groupChat.members.addTitle")}><img src={addIcon} alt="" /></button>}
    </div>
    <div id={`${id}-role`} className={styles.role} role="tabpanel" tabIndex={0}
      aria-labelledby={selected ? `${id}-member-${members.indexOf(selected)}` : undefined}>
      {selected && <GroupChatRoleDocument key={`${view.ownerScope ?? ""}:${view.group.id}:${selected.id}`}
        groupId={view.group.id} memberId={selected.id} variant="compact" />}
      <details className={styles.secondaryInfo}>
        <summary>{t("groupChat.memorySummary")}</summary>
        <p>{t("groupChat.memoryNote")}</p>
      </details>
    </div>
  </section>;
}
