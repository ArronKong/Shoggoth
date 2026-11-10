import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../components/Field";
import { createGroupChat } from "../api/client";
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS, type GroupCandidateAgent } from "../lib/groupChat";
import GroupChatFormModal from "./GroupChatFormModal";
import GroupChatMemberPicker, { groupCandidateKey } from "./GroupChatMemberPicker";
import styles from "./GroupChatFormModal.module.css";

/** 从聊天页 Agent 右键「创建群组」打开；右键的那个 Agent 默认选中。 */
export default function GroupChatCreateModal({ initial, agents, backends, onClose, onCreated }: {
  initial: GroupCandidateAgent;
  agents: GroupCandidateAgent[];
  backends: readonly { id: string; name: string }[];
  onClose(): void;
  onCreated(groupId: string): void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([groupCandidateKey(initial)]);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const operationIdRef = useRef(crypto.randomUUID());
  const byKey = useMemo(() => new Map(agents.map(agent => [groupCandidateKey(agent), agent])), [agents]);
  const chosen = selected.map((key) => byKey.get(key)).filter((agent): agent is GroupCandidateAgent => !!agent);
  const defaultName = chosen.map((agent) => agent.name).join("、").slice(0, 64);
  const canSubmit = chosen.length >= GROUP_MIN_MEMBERS && chosen.length <= GROUP_MAX_MEMBERS && !saving;
  const toggle = (agent: GroupCandidateAgent) => {
    const key = groupCandidateKey(agent);
    setSelected((prev) => prev.includes(key) ? prev.filter((item) => item !== key)
      : prev.length >= GROUP_MAX_MEMBERS ? prev : [...prev, key]);
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

  return <GroupChatFormModal open title={t("groupChat.createTitle")} subtitle={t("groupChat.createSubtitle")}
    dismissible={!saving} onClose={() => { if (!submittingRef.current) onClose(); }}
    footer={<>
      <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <button type="submit" form="group-chat-create" className="btn-primary" disabled={!canSubmit}>
        {t(saving ? "groupChat.creating" : "groupChat.create")}
      </button>
    </>}>
    <form id="group-chat-create" className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label={t("groupChat.nameLabel")}>
        <TextInput value={name} maxLength={64} placeholder={defaultName || t("groupChat.namePlaceholder")} disabled={saving}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
      </Field>
      <Field label={t("groupChat.purposeLabel")} hint={t("groupChat.purposeHint")}>
        <TextArea value={purpose} maxLength={1000} rows={2} disabled={saving} onChange={(event) => setPurpose(event.target.value)} />
      </Field>
      <GroupChatMemberPicker agents={agents} backends={backends} initialBackend={initial.backendId}
        selectedKeys={selected} selectionStatus={t("groupChat.membersCount", { count: chosen.length, max: GROUP_MAX_MEMBERS })}
        emptyLabel={t("groupChat.noCandidates")} disabled={saving} selectionFull={selected.length >= GROUP_MAX_MEMBERS}
        onToggle={toggle} />
      <p className={styles.memoryNote}>{t("groupChat.memoryNote")}</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  </GroupChatFormModal>;
}
