import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import Modal from "../components/Modal";
import AgentAvatar from "../components/AgentAvatar";
import { useConfirm } from "../components/ui";
import { addGroupChatMember, removeGroupChatMember } from "../api/client";
import GroupChatRoleDocument from "./GroupChatRoleDocument";
import GroupChatMemberModel from "./GroupChatMemberModel";
import { GROUP_MEMBER_BACKEND_IDS, GROUP_NATIVE_BACKEND_ID, GROUP_MAX_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import type { GroupChatMember, GroupChatView } from "../types";
import styles from "./GroupChatPanel.module.css";

const MAX_MEMBERS = GROUP_MAX_MEMBERS;

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
  // 最后一位成员不能移出：没有成员的群没法用，归档才是结束一个群的方式。
  const canRemove = view.group.status === "active" && member.state === "active"
    && view.members.filter((item) => item.state === "active").length > 1;
  const remove = async () => {
    if (!await confirm({ title: t("groupChat.members.remove"), danger: true,
      message: t("groupChat.members.removeConfirm", { name: member.displayName }) }) || !isCurrentScope()) return;
    setRemoving(true);
    try {
      onView(await removeGroupChatMember(groupId, { expectedRosterRevision: view.group.rosterRevision, memberId: member.id }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRemoving(false);
    }
  };
  const card = member.card;

  return <Modal open width={640} onClose={onClose}
    title={<span className={styles.cardTitle}>
      <AgentAvatar agentId={member.agentId} name={member.displayName} className={styles.authorAvatar} />
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

/** 给已有的群加一位成员：列出还不在群里的 Agent，点一下就加入。 */
export function GroupChatAddMemberModal({ view, candidates, onView, onClose }: {
  view: GroupChatView;
  candidates: GroupCandidateAgent[];
  onView(view: GroupChatView): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (agent: { backendId: string; agentId: string; peerId?: string }) => `${agent.backendId}\0${agent.peerId ?? ""}\0${agent.agentId}`;
  const active = view.members.filter((member) => member.state === "active");
  const taken = new Set(active.map(keyOf));
  const available = candidates.filter((agent) => !taken.has(keyOf(agent)));
  const full = active.length >= MAX_MEMBERS;
  const add = async (agent: GroupCandidateAgent) => {
    if (busy) return;
    setBusy(keyOf(agent));
    setError(null);
    try {
      onView(await addGroupChatMember(view.group.id, { expectedRosterRevision: view.group.rosterRevision,
        member: { backendId: agent.backendId, agentId: agent.agentId, ...(agent.peerId ? { peerId: agent.peerId } : {}) } }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };
  return <Modal open width={460} dismissible={!busy} onClose={onClose} title={t("groupChat.members.addTitle")}
    subtitle={t("groupChat.members.count", { count: active.length, max: MAX_MEMBERS })}
    footer={<button type="button" className="btn" disabled={!!busy} onClick={onClose}>{t("common.close")}</button>}>
    <div className={styles.createMembers}>
      {full && <p className={styles.muted}>{t("groupChat.members.full", { max: MAX_MEMBERS })}</p>}
      {!full && available.length === 0 && <p className={styles.muted}>{t("groupChat.members.noneToAdd")}</p>}
      {!full && available.map((agent) => {
        const supported = GROUP_MEMBER_BACKEND_IDS.has(agent.backendId);
        return (
          <div key={keyOf(agent)} className={`${styles.createMember}${supported ? "" : ` ${styles.isDisabled}`}`}
            title={supported ? undefined : t("groupChat.unsupportedBackend")}>
            <AgentAvatar agentId={agent.agentId} name={agent.name} className={styles.createAvatar} />
            <span className={styles.createMemberName}>{agent.name}</span>
            {agent.peerId && <span className={styles.muted}>{agent.peerId}</span>}
            {agent.backendId !== GROUP_NATIVE_BACKEND_ID && <span className={styles.muted}>
              {supported ? agent.backendId === "hermes" ? "Hermes" : "OpenClaw" : t("groupChat.unsupportedShort")}</span>}
            <button type="button" className="btn-sm" disabled={!supported || !!busy} onClick={() => void add(agent)}>
              {t(busy === keyOf(agent) ? "groupChat.members.adding" : "groupChat.members.add")}</button>
          </div>
        );
      })}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </Modal>;
}
