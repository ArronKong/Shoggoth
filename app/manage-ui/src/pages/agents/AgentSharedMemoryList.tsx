import { useState } from "react";
import { useTranslation } from "react-i18next";
import { mutateAgentMemory } from "../../api/client";
import { useToast } from "../../components/ui";
import type { AgentMemoryPage, AgentSharedMemoryItem } from "../../types";
import s from "./AgentMemoryEditor.module.css";

// Facts other Agents shared with this one. Each change is written through the
// Agent that holds the fact, at the revision the list was read with.
export default function AgentSharedMemoryList({ backendId, shared, disabled, onChanged }: {
  backendId: string;
  shared: AgentMemoryPage["shared"];
  disabled: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = (shared?.items ?? []).filter(({ item }) => item.validFrom <= Date.now()
    && (item.validUntil === null || item.validUntil > Date.now()));
  if (rows.length === 0) return null;

  const change = async (row: AgentSharedMemoryItem, action: "update" | "delete") => {
    setBusy(true); setError("");
    try {
      const input = action === "update"
        ? { id: row.item.id, content: (drafts[row.item.id] ?? row.item.content).trim(), confidence: 1,
          validUntil: row.item.validUntil, expectedRevision: row.homeRevision }
        : { id: row.item.id, expectedRevision: row.homeRevision };
      await mutateAgentMemory(backendId, row.homeAgentId, action, input);
      setDrafts((current) => { const next = { ...current }; delete next[row.item.id]; return next; });
      toast.success(t(action === "delete" ? "agents.memoryForgotten" : "agents.memorySaved"));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return (
    <section className={s.candidates} aria-label={t("agents.memorySharedTitle")}>
      <h3>{t("agents.memorySharedTitle")}</h3>
      <p className={s.hint}>{t("agents.memorySharedExplain")}</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      {rows.map((row) => {
        const value = drafts[row.item.id] ?? row.item.content;
        return <article className={s.entry} key={`${row.homeAgentId}:${row.item.id}`}>
          <div className={s.meta}>
            <span>{t(`agents.memoryScopes.${row.item.scope}`)}</span>
            {row.item.sensitivity === "private" && <span>{t("agents.memoryPrivate")}</span>}
            <span>{t("agents.memorySharedFrom", { name: row.homeAgentName })}</span>
          </div>
          <textarea className={s.text} value={value} disabled={busy || disabled} rows={3}
            aria-label={t("agents.memorySharedContent", { name: row.homeAgentName })}
            onChange={(event) => setDrafts((current) => ({ ...current, [row.item.id]: event.target.value }))} />
          <div className={s.actions}>
            <button type="button" disabled={busy || disabled} onClick={() => void change(row, "delete")}>
              {t("common.delete")}
            </button>
            <button type="button" disabled={busy || disabled || !value.trim() || value === row.item.content}
              onClick={() => void change(row, "update")}>{t("common.save")}</button>
          </div>
        </article>;
      })}
      {shared?.truncated && <p className={s.hint}>{t("agents.memorySharedTruncated")}</p>}
    </section>
  );
}
