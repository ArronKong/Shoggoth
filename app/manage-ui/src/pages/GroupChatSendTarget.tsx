import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import AgentAvatar from "../components/AgentAvatar";
import type { GroupChatMember, GroupChatMessage } from "../types";
import styles from "./GroupChatPanel.module.css";

/**
 * 输入框最前面的「发给」：
 * - owner：正文不加 @，按群规则由群主先答；
 * - all：正文前加 @all，全员依次回答；
 * - member：正文前加 @handle，只请这一位回答。
 */
export type GroupSendTarget = { kind: "owner" } | { kind: "all" } | { kind: "member"; memberId: string };

export const OWNER_TARGET: GroupSendTarget = Object.freeze({ kind: "owner" });
const BROADCAST_HANDLE = "all";
const ASCII_WORD = /[A-Za-z0-9_-]/u;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US");

export function sameSendTarget(a: GroupSendTarget, b: GroupSendTarget) {
  return a.kind === b.kind && (a.kind !== "member" || b.kind === "member" && a.memberId === b.memberId);
}

/**
 * 最近一位发言的成员。seq 是最后一条成员消息的序号（用来判断「之后有没有人再发言」）；
 * target 跳过已移出的成员，就是群主或还没人发言时交给群主。
 */
export function followLatestSpeaker(messages: GroupChatMessage[], active: GroupChatMember[], ownerId: string | null) {
  const activeIds = new Set(active.map(member => member.id));
  let seq = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const author = messages[index].author;
    if (author.kind !== "member") continue;
    seq ||= messages[index].seq;
    if (!activeIds.has(author.memberId)) continue;
    return { seq, target: author.memberId === ownerId ? OWNER_TARGET : { kind: "member", memberId: author.memberId } as GroupSendTarget };
  }
  return { seq, target: OWNER_TARGET };
}

/** 选中的成员已移出时返回 null；选中群主本人等同于不 @。 */
export function validSendTarget(target: GroupSendTarget, active: GroupChatMember[], ownerId: string | null): GroupSendTarget | null {
  if (target.kind !== "member") return target;
  if (target.memberId === ownerId) return OWNER_TARGET;
  return active.some(member => member.id === target.memberId) ? target : null;
}

/** 发送时把「发给」写到正文最前面，效果与手动输入 @ 相同；正文已经以同一个 @ 开头时不重复。 */
export function addressedBody(body: string, target: GroupSendTarget, members: ReadonlyMap<string, GroupChatMember>) {
  const handle = target.kind === "all" ? BROADCAST_HANDLE : target.kind === "member" ? members.get(target.memberId)?.handle : undefined;
  const memberId = target.kind === "member" && handle ? target.memberId : null;
  if (!handle) return { body, memberId };
  const head = normalize(body), mention = normalize(`@${handle}`);
  if (head.startsWith(mention) && !(ASCII_WORD.test(mention.at(-1)!) && ASCII_WORD.test(head[mention.length] ?? ""))) {
    return { body, memberId };
  }
  return { body: body ? `@${handle} ${body}` : `@${handle}`, memberId };
}

const byPosition = (a: GroupChatMember, b: GroupChatMember) => a.position - b.position;

function GroupAvatars({ members }: { members: GroupChatMember[] }) {
  return <span className={styles.sendTargetStack} aria-hidden="true">
    {members.slice(0, 3).map(member => <AgentAvatar key={member.id} agentId={member.agentId} name={member.displayName}
      className={styles.sendTargetAvatar} />)}
  </span>;
}

/** 输入框左上角的「发给 + 头像 + 名称」；点开换人。宽度回报给输入框做首行缩进。 */
export function GroupChatSendTargetChip({ target, active, ownerId, open, menuId, disabled, buttonRef, onToggle, onWidth }: {
  target: GroupSendTarget; active: GroupChatMember[]; ownerId: string | null; open: boolean; menuId: string; disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement>; onToggle(): void; onWidth(width: number): void;
}) {
  const { t } = useTranslation();
  const member = target.kind === "member" ? active.find(item => item.id === target.memberId)
    : target.kind === "owner" ? active.find(item => item.id === ownerId) : undefined;
  const name = target.kind === "all" ? t("groupChat.target.all") : member?.displayName ?? t("groupChat.target.owner");
  const onWidthRef = useRef(onWidth);
  onWidthRef.current = onWidth;
  useLayoutEffect(() => {
    const element = buttonRef.current;
    if (!element?.getBoundingClientRect) return;
    const report = () => onWidthRef.current(Math.ceil(element.getBoundingClientRect().width));
    report();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    observer?.observe(element);
    return () => { observer?.disconnect(); onWidthRef.current(0); };
  }, [buttonRef]);
  return <button type="button" ref={buttonRef} className={styles.sendTarget} data-group-send-target={target.kind === "member" ? target.memberId : target.kind}
    disabled={disabled} title={t("groupChat.target.change")}
    aria-label={`${t("groupChat.target.label")} ${name}${target.kind === "owner" ? ` · ${t("groupChat.target.owner")}` : ""} · ${t("groupChat.target.change")}`}
    aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
    onMouseDown={event => event.preventDefault()} onClick={onToggle}>
    <span className={styles.sendTargetLabel}>{t("groupChat.target.label")}</span>
    {target.kind === "all" ? <GroupAvatars members={[...active].sort(byPosition)} />
      : member && <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.sendTargetAvatar} />}
    <span className={styles.sendTargetName}>{name}</span>
    {target.kind === "owner" && member && <span className={styles.sendTargetTag}>{t("groupChat.target.owner")}</span>}
    <svg className={styles.sendTargetCaret} viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" /></svg>
  </button>;
}

/** 换人菜单：群主（默认，不 @）在最前，其次是其他成员，最后是所有人。 */
export function GroupChatSendTargetMenu({ id, target, active, ownerId, anchorRef, onPick, onClose }: {
  id: string; target: GroupSendTarget; active: GroupChatMember[]; ownerId: string | null;
  anchorRef: RefObject<HTMLElement>; onPick(target: GroupSendTarget): void; onClose(): void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const roster = [...active].sort(byPosition);
  const owner = roster.find(member => member.id === ownerId);
  const options: Array<{ key: string; target: GroupSendTarget; label: string; detail: string; avatar: ReactNode }> = [
    { key: "owner", target: OWNER_TARGET, label: owner?.displayName ?? t("groupChat.target.owner"), detail: t("groupChat.target.owner"),
      avatar: owner ? <AgentAvatar agentId={owner.agentId} name={owner.displayName} className={styles.memberAvatar} /> : null },
    ...roster.filter(member => member !== owner).map(member => ({ key: member.id, target: { kind: "member", memberId: member.id } as GroupSendTarget,
      label: member.displayName, detail: `@${member.handle}`,
      avatar: <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.memberAvatar} /> })),
    { key: "all", target: { kind: "all" }, label: t("groupChat.target.all"), detail: `@${BROADCAST_HANDLE}`, avatar: <GroupAvatars members={roster} /> },
  ];
  useEffect(() => {
    const menu = menuRef.current;
    menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus?.();
    if (typeof document === "undefined" || !menu) return;
    const outside = (event: Event) => {
      const node = event.target as Node | null;
      if (node && !menu.contains(node) && !anchorRef.current?.contains(node)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchorRef]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined && items.length) {
      event.preventDefault();
      items[(move + items.length) % items.length].focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onClose();
    }
  };
  return <div ref={menuRef} className={`${styles.mentionMenu} ${styles.sendTargetMenu}`} id={id} role="listbox"
    aria-label={t("groupChat.target.change")} onKeyDown={onKeyDown}>
    {options.map(option => {
      const selected = sameSendTarget(option.target, target);
      return <button type="button" key={option.key} role="option" aria-selected={selected} data-group-send-target-option={option.key}
        className={`${styles.mentionItem}${selected ? ` ${styles.isActive}` : ""}`} onClick={() => onPick(option.target)}>
        {option.avatar}
        <span className={styles.sendTargetOptionName}>{option.label}</span>
        <span className={styles.muted}>{option.detail}</span>
        {selected && <span className={styles.sendTargetCheck} aria-hidden="true">✓</span>}
      </button>;
    })}
  </div>;
}
