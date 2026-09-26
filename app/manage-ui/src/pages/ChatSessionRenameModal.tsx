import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import { Field, TextInput } from "../components/Field";

export interface SessionRenameTarget {
  key: string;
  label: string;
}

/** The target is captured when the dialog opens, never read from the active tab at submit time. */
export default function ChatSessionRenameModal({ target, onClose, onSubmit }: {
  target: SessionRenameTarget;
  onClose(): void;
  onSubmit(key: string, label: string): Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(target.label);
  const [saving, setSaving] = useState(false);
  const submittingRef = useRef(false);
  const submit = async () => {
    const trimmed = label.trim();
    if (!trimmed || submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      if (await onSubmit(target.key, trimmed)) onClose();
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };
  return <Modal open title={t("chat.renameSession")} width={480}
    dismissible={!saving} onClose={() => { if (!submittingRef.current) onClose(); }}
    footer={<>
      <button type="button" className="btn" disabled={saving} onClick={onClose}>{t("common.cancel")}</button>
      <button type="submit" form="chat-session-rename" className="btn-primary" disabled={saving || !label.trim()}>
        {t(saving ? "common.saving" : "common.save")}
      </button>
    </>}>
    <form id="chat-session-rename" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label={t("chat.sessionNamePrompt")}>
        <TextInput autoFocus value={label} disabled={saving} onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          }} />
      </Field>
    </form>
  </Modal>;
}
