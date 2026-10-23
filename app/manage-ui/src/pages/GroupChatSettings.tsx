import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import { Field, Option, Select, TextArea } from "../components/Field";
import { updateGroupChat } from "../api/client";
import type { GroupChatView } from "../types";
import styles from "./GroupChatPanel.module.css";

/** 群设置：群主（没有 @ 的消息先交给它）与群用途（成员每次发言前都会看到）。 */
export default function GroupChatSettings({ view, onView, onClose }: {
  view: GroupChatView; onView(view: GroupChatView): void; onClose(): void;
}) {
  const { t } = useTranslation();
  const members = view.members.filter(member => member.state === "active");
  const [ownerId, setOwnerId] = useState(view.group.ownerMemberId ?? view.currentOwnerId ?? members[0]?.id ?? "");
  const [purpose, setPurpose] = useState(view.group.purpose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(view.group.metadataRevision);
  const sending = useRef(false);
  const save = async () => {
    if (sending.current) return;
    const patch = { ...(ownerId && ownerId !== view.group.ownerMemberId ? { ownerMemberId: ownerId } : {}),
      ...(purpose.trim() !== view.group.purpose ? { purpose: purpose.trim() } : {}) };
    if (Object.keys(patch).length === 0) { onClose(); return; }
    sending.current = true; setBusy(true); setError(null);
    try {
      onView(await updateGroupChat(view.group.id, { expectedMetadataRevision: revision.current, patch }));
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; setBusy(false); }
  };
  return <Modal open width={440} title={t("groupChat.strategy.settings")} dismissible={!busy} onClose={onClose}
    footer={<><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
      <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{t("groupChat.strategy.save")}</button></>}>
    <Field label={t("groupChat.owner.label")} hint={t("groupChat.owner.hint")}>
      <Select value={ownerId} disabled={busy || members.length === 0} onChange={value => setOwnerId(value)}>
        {members.map(member => <Option key={member.id} value={member.id}>{member.displayName}</Option>)}
      </Select>
    </Field>
    <Field label={t("groupChat.purposeLabel")} hint={t("groupChat.purposeHint")}>
      <TextArea value={purpose} maxLength={1000} rows={3} disabled={busy} onChange={event => setPurpose(event.target.value)} />
    </Field>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </Modal>;
}
