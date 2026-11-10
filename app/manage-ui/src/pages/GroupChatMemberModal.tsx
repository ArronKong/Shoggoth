import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Modal from "../components/Modal";
import { useConfirm } from "../components/ui";
import GroupMemberAvatar from "./GroupMemberAvatar";
import { updateGroupChatMembers } from "../api/client";
import GroupChatRoleDocument from "./GroupChatRoleDocument";
import GroupChatMemberModel from "./GroupChatMemberModel";
import { GROUP_MEMBER_BACKEND_IDS, GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import type { GroupChatMember, GroupChatView } from "../types";
import GroupChatFormModal from "./GroupChatFormModal";
import GroupChatMemberPicker, { groupCandidateKey } from "./GroupChatMemberPicker";
import formStyles from "./GroupChatFormModal.module.css";
import styles from "./GroupChatPanel.module.css";

/** 群成员卡：从成员自己的 IDENTITY/SOUL 派生的角色资料，以及同伴能读到的共享原文。 */
export default function GroupChatMemberModal({ groupId, member, view, onView, onClose, isCurrentScope = () => true }: {
  groupId: string;
  member: GroupChatMember;
  view: GroupChatView;
  onView(view: GroupChatView): void;
  onClose(): void;
  isCurrentScope?(): boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  // 与服务端一致：群聊至少保留两位活跃成员。
  const canRemove = !!view.ownerScope && view.group.status === "active" && member.state === "active"
    && view.members.filter((item) => item.state === "active").length > GROUP_MIN_MEMBERS;
  const remove = async () => {
    if (!canRemove || !view.ownerScope || removingRef.current || !isCurrentScope()) return;
    removingRef.current = true;
    setRemoving(true);
    setError(null);
    try {
      const ok = await confirm({ title: t("groupChat.members.remove"), confirmLabel: t("common.confirm"), danger: true, focusCancel: true,
        message: t("groupChat.members.removeConfirm", { name: member.displayName }) });
      if (!ok || !isCurrentScope()) return;
      const next = await updateGroupChatMembers(groupId, { ownerScope: view.ownerScope,
        expectedRosterRevision: view.group.rosterRevision, addMembers: [], removeMemberIds: [member.id] });
      if (!isCurrentScope()) return;
      onView(next);
      onClose();
    } catch (cause) {
      if (isCurrentScope()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      removingRef.current = false;
      if (isCurrentScope()) setRemoving(false);
    }
  };
  const card = member.card;

  return <Modal open width={640} onClose={onClose}
    title={<span className={styles.cardTitle}>
      <GroupMemberAvatar member={member} className={styles.authorAvatar} />
      {member.displayName}
      <span className={styles.muted}>@{member.handle}{member.peerId ? ` · ${member.peerId}` : ""}</span>
    </span>}
    subtitle={card ? t(card.availability === "online" ? "groupChat.card.online" : "groupChat.card.offline") : undefined}
    footer={<>
      {canRemove && <button type="button" className="btn btn-danger" disabled={removing} onClick={() => void remove()}>
        {t("groupChat.members.remove")}</button>}
      <button type="button" className="btn" onClick={onClose}>{t("common.close")}</button>
    </>}>
    <div className={styles.cardBody}>
      {member.state === "active" && view.group.status === "active" && <GroupChatMemberModel
        key={`${view.ownerScope ?? ''}:${groupId}:${member.id}`} member={member} view={view} onView={onView}
        isCurrentScope={isCurrentScope} disabled={removing} />}
      {!card ? <p className={styles.muted}>{t("groupChat.card.pending")}</p> : (
        <dl className={styles.cardFields}>
          <dt>{t("groupChat.card.role")}</dt>
          <dd>{card.missing ? t("groupChat.card.missing")
            : card.role ?? (card.usesDefaultRole ? t("groupChat.card.defaultRole") : t("groupChat.card.notProvided"))}</dd>
          {card.position && <><dt>{t("groupChat.card.position")}</dt><dd>{card.position}</dd></>}
          {card.specialties.length > 0 && <><dt>{t("groupChat.card.specialties")}</dt><dd>{card.specialties.join("、")}</dd></>}
          {card.workingStyle && <><dt>{t("groupChat.card.style")}</dt><dd>{card.workingStyle}</dd></>}
          {card.consultWhen?.length ? <><dt>{t("groupChat.card.consultWhen")}</dt><dd>{card.consultWhen.join("、")}</dd></> : null}
          {card.freshness === "refreshing" || card.freshness === "stale" ? <>
            <dt>{t("groupChat.card.summaryStatus")}</dt><dd>{t(`groupChat.card.${card.freshness}`)}</dd>
          </> : null}
          {card.runtime && <><dt>{t("groupChat.card.runtime")}</dt><dd>{card.runtime}</dd></>}
          <dt>{t("groupChat.card.version")}</dt>
          <dd>{t("groupChat.card.versionValue", { card: card.cardRevision, source: card.sourceRevision ?? "—" })}</dd>
        </dl>
      )}
      <div className={styles.cardSharedHead}>
        <span>{t("groupChat.card.sharedText")}</span>
      </div>
      {member.state === "active" ? <GroupChatRoleDocument key={`${groupId}:${member.id}`} groupId={groupId} memberId={member.id} />
        : <p className={styles.muted}>{t("groupChat.card.code.access_revoked")}</p>}
      {error && <p className={styles.error}>{error}</p>}
      <p className={styles.muted}>
        {member.peerId ? t("groupChat.card.remoteEditHint") : <>{t("groupChat.card.editHint")} <Link to="/agents" onClick={onClose}>{t("groupChat.card.editLink")}</Link></>}
      </p>
    </div>
  </Modal>;
}

/** 以打开弹窗时的名单为基准，确认后一次提交增删。 */
export function GroupChatAddMemberModal({ view, candidates, backends, onView, onRefresh, onClose, isCurrentScope }: {
  view: GroupChatView;
  candidates: GroupCandidateAgent[];
  backends: readonly { id: string; name: string }[];
  onView(view: GroupChatView): void;
  onRefresh(): void;
  onClose(): void;
  isCurrentScope(): boolean;
}) {
  const { t } = useTranslation();
  const [roster] = useState(() => ({ revision: view.group.rosterRevision,
    members: view.members.filter(member => member.state === "active") }));
  const [selectedKeys, setSelectedKeys] = useState(() => roster.members.map(groupCandidateKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const rosterKeys = new Set(roster.members.map(groupCandidateKey));
  const available = candidates.filter(agent => !rosterKeys.has(groupCandidateKey(agent)));
  const eligible = new Map(available.filter(agent => GROUP_MEMBER_BACKEND_IDS.has(agent.backendId))
    .map(agent => [groupCandidateKey(agent), agent]));
  const agents = [...roster.members.map(({ backendId, agentId, peerId, displayName }) => ({ backendId, agentId, peerId, name: displayName })),
    ...available];
  const additions = selectedKeys.map(key => eligible.get(key)).filter((agent): agent is GroupCandidateAgent => !!agent);
  const removals = roster.members.filter(member => !selectedKeys.includes(groupCandidateKey(member)));
  const count = roster.members.length + additions.length - removals.length;
  const changed = additions.length > 0 || removals.length > 0;
  const stale = view.group.rosterRevision !== roster.revision;
  const disabled = busy || stale || !view.ownerScope || view.group.status !== "active";
  const canSave = !disabled && changed && count >= GROUP_MIN_MEMBERS && count <= GROUP_MAX_MEMBERS;
  const close = () => { if (!submitting.current) onClose(); };
  const toggle = (agent: GroupCandidateAgent) => {
    const key = groupCandidateKey(agent);
    if (disabled || submitting.current || (!rosterKeys.has(key) && !eligible.has(key))) return;
    setSelectedKeys(previous => {
      const current = previous.filter(item => rosterKeys.has(item) || eligible.has(item));
      if (current.includes(key)) return current.filter(item => item !== key);
      return current.length < GROUP_MAX_MEMBERS ? [...current, key] : current;
    });
    setError(null);
  };
  const save = async () => {
    if (!canSave || !view.ownerScope || submitting.current || !isCurrentScope()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await updateGroupChatMembers(view.group.id, {
        ownerScope: view.ownerScope, expectedRosterRevision: roster.revision,
        addMembers: additions.map(({ backendId, agentId, peerId }) => ({ backendId, agentId, ...(peerId ? { peerId } : {}) })),
        removeMemberIds: removals.map(member => member.id),
      });
      if (isCurrentScope()) {
        onView(next);
        onClose();
      }
    } catch (cause) {
      if (isCurrentScope()) {
        setError(cause instanceof Error ? cause.message : String(cause));
        onRefresh();
      }
    } finally {
      submitting.current = false;
      if (isCurrentScope()) setBusy(false);
    }
  };
  return <GroupChatFormModal open dismissible={!busy} onClose={close} title={t("groupChat.members.manageTitle")}
    subtitle={t("groupChat.members.count", { count: roster.members.length })}
    footer={<>
      <button type="button" className="btn-secondary" disabled={busy} onClick={close}>{t("common.cancel")}</button>
      <button type="button" className="btn-primary" disabled={!canSave} onClick={() => void save()}>
        {t(busy ? "common.saving" : "common.confirm")}
      </button>
    </>}>
    <GroupChatMemberPicker agents={agents} backends={backends} rosterKeys={rosterKeys}
      selectedKeys={selectedKeys} selectionStatus={t("groupChat.membersCount", { count, max: GROUP_MAX_MEMBERS })}
      emptyLabel={t("groupChat.noCandidates")} disabled={disabled}
      selectionFull={count >= GROUP_MAX_MEMBERS} onToggle={toggle} />
    {changed && <p className={formStyles.empty} role="status">
      {t("groupChat.members.changes", { add: additions.length, remove: removals.length })}</p>}
    {count < GROUP_MIN_MEMBERS && <p className={formStyles.empty} role="status">
      {t("groupChat.members.minSelection", { min: GROUP_MIN_MEMBERS })}</p>}
    {stale && !busy && <p className={formStyles.error} role="status">{t("groupChat.members.rosterChanged")}</p>}
    {error && <p className={formStyles.error} role="alert">{error}</p>}
  </GroupChatFormModal>;
}
