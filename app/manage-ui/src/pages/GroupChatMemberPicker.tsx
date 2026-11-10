import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AgentPickerOption, AgentPickerTabs } from "../components/AgentPicker";
import { sortBackendTabs } from "../components/BackendTabIcon";
import { GROUP_MEMBER_BACKEND_IDS, type GroupCandidateAgent } from "../lib/groupChat";
import { useScrollFade } from "../lib/useScrollFade";
import styles from "./GroupChatFormModal.module.css";

export function groupCandidateKey({ backendId, agentId, peerId }: Pick<GroupCandidateAgent, "backendId" | "agentId" | "peerId">) {
  return `${backendId}\0${peerId ?? ""}\0${agentId}`;
}

export default function GroupChatMemberPicker({ agents, backends, initialBackend, selectedKeys, rosterKeys, selectionStatus,
  emptyLabel, disabled, selectionFull, onToggle }: {
  agents: GroupCandidateAgent[];
  backends: readonly { id: string; name: string }[];
  initialBackend?: string;
  selectedKeys: readonly string[];
  rosterKeys?: ReadonlySet<string>;
  selectionStatus: string;
  emptyLabel: string;
  disabled?: boolean;
  selectionFull?: boolean;
  onToggle(agent: GroupCandidateAgent): void;
}) {
  const { t } = useTranslation();
  const [backend, setBackend] = useState(initialBackend);
  const byBackend = new Map<string, GroupCandidateAgent[]>();
  for (const agent of agents) {
    const items = byBackend.get(agent.backendId);
    if (items) items.push(agent);
    else byBackend.set(agent.backendId, [agent]);
  }
  const names = new Map(backends.map(({ id, name }) => [id, name]));
  const tabs = sortBackendTabs(Array.from(byBackend.keys(), id => ({ id, name: names.get(id) ?? id })));
  const activeBackend = backend && byBackend.has(backend) ? backend : tabs[0]?.id;
  const visibleAgents = activeBackend ? byBackend.get(activeBackend) ?? [] : [];
  const listRows = Math.max(1, ...Array.from(byBackend.values(), items => items.length));
  const scroll = useScrollFade(true, visibleAgents.length, activeBackend);
  const membersLabel = t("groupChat.membersLabel");

  return <div className={styles.members}>
    <div className={styles.membersHead}>
      <span>{membersLabel}</span>
      <span className={styles.count} role="status" title={selectionStatus}>{selectionStatus}</span>
    </div>
    <AgentPickerTabs items={tabs} value={activeBackend} onChange={setBackend} label={t("a11y.switchBackend")} disabled={disabled} />
    <div className={styles.memberList} role="group" aria-label={membersLabel} data-roster={rosterKeys ? "" : undefined}
      style={{ "--member-rows": listRows } as CSSProperties} {...scroll}>
      {visibleAgents.map(agent => {
        const supported = GROUP_MEMBER_BACKEND_IDS.has(agent.backendId);
        const key = groupCandidateKey(agent);
        const checked = selectedKeys.includes(key);
        const inRoster = rosterKeys?.has(key);
        const membership = inRoster ? t(checked ? "groupChat.members.inGroup" : "groupChat.members.pendingRemoval") : undefined;
        const label = [agent.name, names.get(agent.backendId) ?? agent.backendId, agent.peerId,
          membership ?? (!supported && t("groupChat.unsupportedBackend"))].filter(Boolean).join(" · ");
        const detail = [membership, agent.peerId, !inRoster && !supported && t("groupChat.unsupportedShort")].filter(Boolean).join(" · ");
        return <AgentPickerOption key={key} agentId={agent.agentId} name={agent.name} label={label}
          detail={detail} checked={checked} disabled={(!inRoster && !supported) || disabled || (!checked && selectionFull)}
          onClick={() => onToggle(agent)} />;
      })}
      {visibleAgents.length === 0 && <p className={styles.empty} role="status">{emptyLabel}</p>}
    </div>
  </div>;
}
