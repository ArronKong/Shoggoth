import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import GroupMemberAvatar from "./GroupMemberAvatar";
import { GROUP_MIN_MEMBERS } from "../lib/groupChat";
import type { GroupChatMember, GroupChatView } from "../types";
import GroupChatRoleDocument from "./GroupChatRoleDocument";
import { ChatMessageContextMenu, IconTrash } from "./ChatMessageActions";
import closeIcon from "../assets/figma/group-chat/group-details-close.svg";
import addIcon from "../assets/figma/group-chat/group-details-add.svg";
import deleteIcon from "../assets/figma/group-chat/group-details-delete.svg";
import settingsIcon from "../assets/nav-icons/settings.svg";
import styles from "./GroupChatDetails.module.css";

export type GroupChatDetailsProps = {
  view: GroupChatView;
  onClose(): void;
  onAddMember?(): void;
  onRemoveMember?(member: GroupChatMember): void;
  removingMember?: boolean;
  onRename?(): void;
  onSettings?(): void;
  onDelete?(): void;
  deleting?: boolean;
};

/** 群详情占用原聊天区域；只展示成员 SOUL，仍通过固定版本和摘要校验读取。 */
export default function GroupChatDetails({ view, onClose, onAddMember,
  onRemoveMember, removingMember = false, onRename, onSettings, onDelete, deleting = false }: GroupChatDetailsProps) {
  const { t } = useTranslation();
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ groupId: string; memberId: string } | null>(null);
  const [memberMenu, setMemberMenu] = useState<{ groupId: string; ownerScope: GroupChatView["ownerScope"]; memberId: string; x: number; y: number } | null>(null);
  const members = view.members.filter(member => member.state === "active");
  const menuMember = memberMenu?.groupId === view.group.id && memberMenu.ownerScope === view.ownerScope
    ? members.find(member => member.id === memberMenu.memberId) : undefined;
  const preferred = members.find(member => member.id === view.currentOwnerId) ?? members[0];
  const selected = (selection?.groupId === view.group.id
    ? members.find(member => member.id === selection.memberId) : undefined) ?? preferred;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
        || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth : 1;
      const before = list.scrollLeft;
      list.scrollLeft += event.deltaY * unit;
      if (list.scrollLeft !== before) event.preventDefault();
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected?.id, view.group.id]);
  const active = view.group.status === "active" && !deleting;
  const canAdd = active && Boolean(onAddMember);
  const canRemove = active && !removingMember && members.length > GROUP_MIN_MEMBERS;
  const selectMember = (memberId: string) => setSelection({ groupId: view.group.id, memberId });
  const openMemberMenu = (memberId: string, x: number, y: number) => {
    if (onRemoveMember) setMemberMenu({ groupId: view.group.id, ownerScope: view.ownerScope, memberId, x, y });
  };
  const navigateMembers = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openMemberMenu(members[index].id, bounds.left, bounds.bottom);
      return;
    }
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
  const iconStyle = (source: string) => ({ "--group-details-icon": `url(${JSON.stringify(source)})` }) as CSSProperties;

  return <section className={styles.details} data-group-details aria-labelledby={`${id}-title`}>
    <header className={styles.header}>
      <button type="button" className={styles.iconButton} data-group-details-action="close" onClick={onClose}
        aria-label={t("common.close")} title={t("common.close")}><span className={styles.headerIcon} style={iconStyle(closeIcon)} aria-hidden="true" /></button>
      <h2 id={`${id}-title`} className={styles.title}>
        {onRename ? <button type="button" className={styles.titleButton} data-group-details-action="rename"
          disabled={!active} onClick={onRename} title={t("groupChat.rename")}
          aria-label={`${view.group.name} · ${t("groupChat.rename")}`}>{view.group.name}</button> : view.group.name}
      </h2>
      <div className={styles.tools}>
        {onSettings && <button type="button" className={styles.iconButton} data-group-details-action="settings"
          disabled={!active} onClick={onSettings} title={t("groupChat.strategy.settings")} aria-label={t("groupChat.strategy.settings")}>
          <span className={styles.headerIcon} style={iconStyle(settingsIcon)} aria-hidden="true" />
        </button>}
        {onDelete && (view.group.status === "deleting" ? (
          <button type="button" className="btn-danger btn-sm" data-group-details-action="force-delete" disabled={deleting} onClick={onDelete}>
            {t("groupChat.forceDelete")}
          </button>
        ) : (
          <button type="button" className={styles.iconButton} data-group-details-action="delete"
            disabled={deleting} onClick={onDelete} title={t("groupChat.delete")} aria-label={t("groupChat.delete")}>
            <span className={`${styles.headerIcon} ${styles.deleteIcon}`} style={iconStyle(deleteIcon)} aria-hidden="true" />
          </button>
        ))}
      </div>
    </header>
    <div ref={listRef} className={styles.members} role="tablist" aria-label={t("groupChat.membersLabel")}>
      {members.map((member, index) => {
        const isSelected = member.id === selected?.id;
        return <button type="button" key={member.id} role="tab" id={`${id}-member-${index}`} data-group-details-member={member.id}
          aria-controls={`${id}-role`} aria-selected={isSelected} tabIndex={isSelected ? 0 : -1}
          aria-haspopup={onRemoveMember ? "menu" : undefined}
          className={`${styles.member}${isSelected ? ` ${styles.selected}` : ""}`}
          title={member.displayName} onClick={() => selectMember(member.id)}
          onContextMenu={event => {
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            openMemberMenu(member.id, event.clientX, event.clientY);
          }}
          onKeyDown={event => navigateMembers(event, index)}>
          <GroupMemberAvatar member={member} className={styles.avatar} />
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
    </div>
    {memberMenu && menuMember && onRemoveMember && <ChatMessageContextMenu x={memberMenu.x} y={memberMenu.y}
      onClose={() => setMemberMenu(null)} extra={<button type="button" role="menuitem" data-group-member-remove={menuMember.id}
        className="chat-ctxmenu__item is-danger" disabled={!canRemove} onClick={() => {
          setMemberMenu(null);
          if (canRemove) {
            listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[members.indexOf(menuMember)]?.focus({ preventScroll: true });
            onRemoveMember(menuMember);
          }
        }}><IconTrash /><span>{t("groupChat.members.remove")}</span></button>} />}
  </section>;
}
