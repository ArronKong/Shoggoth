import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import { Field, TextArea, TextInput } from "../components/Field";
import AgentAvatar from "../components/AgentAvatar";
import { createGroupChat } from "../api/client";
import { GROUP_MEMBER_BACKEND_IDS, GROUP_NATIVE_BACKEND_ID, GROUP_MAX_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import styles from "./GroupChatPanel.module.css";

const MAX_MEMBERS = GROUP_MAX_MEMBERS;

/** 从聊天页 Agent 右键「创建群组」打开；右键的那个 Agent 默认选中。 */
export default function GroupChatCreateModal({ initial, agents, onClose, onCreated }: {
  initial: GroupCandidateAgent;
  agents: GroupCandidateAgent[];
  onClose(): void;
  onCreated(groupId: string): void;
}) {
  const { t } = useTranslation();
  const keyOf = (agent: GroupCandidateAgent) => `${agent.backendId}\0${agent.peerId ?? ""}\0${agent.agentId}`;
  const [selected, setSelected] = useState<string[]>([keyOf(initial)]);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const operationIdRef = useRef(crypto.randomUUID());
  const byKey = useMemo(() => new Map(agents.map((agent) => [keyOf(agent), agent])), [agents]);
  const chosen = selected.map((key) => byKey.get(key)).filter((agent): agent is GroupCandidateAgent => !!agent);
  const defaultName = chosen.map((agent) => agent.name).join("、").slice(0, 64);
  const canSubmit = chosen.length >= 2 && chosen.length <= MAX_MEMBERS && !saving;

  const toggle = (agent: GroupCandidateAgent) => {
    const key = keyOf(agent);
    setSelected((prev) => prev.includes(key) ? prev.filter((item) => item !== key)
      : prev.length >= MAX_MEMBERS ? prev : [...prev, key]);
  };
  const submit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const view = await createGroupChat({ operationId: operationIdRef.current, name: name.trim() || defaultName,
        purpose: purpose.trim(), members: chosen.map(({ backendId, agentId, peerId }) => ({ backendId, agentId, ...(peerId ? { peerId } : {}) })) });
      onCreated(view.group.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return <Modal open title={t("groupChat.createTitle")} subtitle={t("groupChat.createSubtitle")} width={520}
    dismissible={!saving} onClose={() => { if (!submittingRef.current) onClose(); }}
    footer={<>
      <button type="button" className="btn" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <button type="submit" form="group-chat-create" className="btn-primary" disabled={!canSubmit}>
        {t(saving ? "groupChat.creating" : "groupChat.create")}
      </button>
    </>}>
    <form id="group-chat-create" className={styles.createForm} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label={t("groupChat.nameLabel")}>
        <TextInput value={name} maxLength={64} placeholder={defaultName || t("groupChat.namePlaceholder")} disabled={saving}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
      </Field>
      <Field label={t("groupChat.purposeLabel")} hint={t("groupChat.purposeHint")}>
        <TextArea value={purpose} maxLength={1000} rows={2} disabled={saving} onChange={(event) => setPurpose(event.target.value)} />
      </Field>
      <div className={styles.createMembersHead}>
        <span>{t("groupChat.membersLabel")}</span>
        <span className={styles.muted}>{t("groupChat.membersCount", { count: chosen.length, max: MAX_MEMBERS })}</span>
      </div>
      <div className={styles.createMembers} role="group" aria-label={t("groupChat.membersLabel")}>
        {agents.map((agent) => {
          const supported = GROUP_MEMBER_BACKEND_IDS.has(agent.backendId);
          const checked = selected.includes(keyOf(agent));
          return (
            <label key={keyOf(agent)} className={`${styles.createMember}${supported ? "" : ` ${styles.isDisabled}`}`}
              title={supported ? undefined : t("groupChat.unsupportedBackend")}>
              <input type="checkbox" checked={checked} disabled={!supported || saving
                || (!checked && selected.length >= MAX_MEMBERS)} onChange={() => toggle(agent)} />
              <AgentAvatar agentId={agent.agentId} name={agent.name} className={styles.createAvatar} />
              <span className={styles.createMemberName}>{agent.name}</span>
              {agent.peerId && <span className={styles.muted}>{agent.peerId}</span>}
              {agent.backendId !== GROUP_NATIVE_BACKEND_ID && <span className={styles.muted}>
                {supported ? agent.backendId === "hermes" ? "Hermes" : "OpenClaw" : t("groupChat.unsupportedShort")}</span>}
            </label>
          );
        })}
      </div>
      <p className={styles.muted}>{t("groupChat.memoryNote")}</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </Modal>;
}
