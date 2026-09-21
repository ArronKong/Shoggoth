import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listAgentMemories, mutateAgentMemory } from "../../api/client";
import { useToast } from "../../components/ui";
import { useNavigationGuard } from "../../lib/navigation-guard";
import type { AgentMemoryItem, AgentMemoryPage } from "../../types";
import s from "./AgentMemoryEditor.module.css";

// Edit authoritative records, not the bounded Markdown projection. Unloaded
// records, provenance and workspace bindings must survive edits to this page.
export default function AgentMemoryEditor({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [page, setPage] = useState<AgentMemoryPage | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"agent" | "user">("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const dirty = !!content.trim() || Object.entries(drafts).some(([id, value]) => (
    value !== page?.items.find((item) => item.id === id)?.content
  ));
  const currentItems = page?.items.filter((item) => item.validFrom <= Date.now()
    && (item.validUntil === null || item.validUntil > Date.now())) || [];
  useNavigationGuard({ dirty, busy, onDiscard: () => { setDrafts({}); setContent(""); } });

  const load = async (append = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = await listAgentMemories(backendId, agentId, "active", undefined, append ? page?.nextCursor : 0);
      if (generation.current !== ticket) return;
      if (append && page && next.revision !== page.revision) {
        setError(t("agents.memoryChanged"));
        return;
      }
      setPage(append && page ? { ...next, items: [...page.items, ...next.items] } : next);
    } catch (cause) {
      if (generation.current === ticket) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ticket) { inFlight.current = false; setBusy(false); }
    }
  };

  useEffect(() => {
    void load();
    return () => { generation.current++; inFlight.current = false; };
    // The parent keys this editor by backend and Agent, isolating drafts and pending replies.
  }, [backendId, agentId]);

  const save = async (action: "create" | "update" | "delete", item?: AgentMemoryItem) => {
    if (!page || inFlight.current) return;
    inFlight.current = true;
    const ticket = ++generation.current;
    setBusy(true); setError("");
    try {
      const input = action === "create" ? { content: content.trim(), scope, expectedRevision: page.revision }
        : action === "update" && item ? { id: item.id, content: (drafts[item.id] ?? item.content).trim(),
          confidence: 1, validUntil: item.validUntil, expectedRevision: page.revision }
          : { id: item!.id, expectedRevision: page.revision };
      const result = await mutateAgentMemory(backendId, agentId, action, input);
      if (generation.current !== ticket) return;
      const saved = result.item;
      const existed = saved && page.items.some((entry) => entry.id === saved.id);
      const added = action === "create" && saved && !existed && result.revision !== page.revision ? 1 : 0;
      const removed = action === "delete" && existed ? 1 : 0;
      const items = page.items.filter((entry) => entry.id !== saved?.id);
      if (saved?.status === "active" && (existed || added)) items.push(saved);
      items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      setPage({ ...page, revision: result.revision, nextCursor: page.nextCursor + added - removed, items });
      if (action === "create") setContent("");
      if (item) setDrafts((current) => { const next = { ...current }; delete next[item.id]; return next; });
      toast.success(t(action === "delete" ? "agents.memoryForgotten" : "agents.memorySaved"));
    } catch (cause) {
      if (generation.current === ticket) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ticket) { inFlight.current = false; setBusy(false); }
    }
  };

  return (
    <div className={s.editor} aria-label={t("agents.memoryEditor")}>
      <p className={s.hint}>{t("agents.memoryExplain")}</p>
      {error && <div className={s.error} role="alert">
        <p>{error}</p>
        <button type="button" disabled={busy} onClick={() => void load()}>{t("agents.memoryReload")}</button>
      </div>}
      {!page ? !error && <p className={s.hint}>{t("common.loading")}</p> : <>
        <form className={s.add} onSubmit={(event) => { event.preventDefault(); void save("create"); }}>
          <label className={s.label} htmlFor="new-agent-memory">{t("agents.memoryAdd")}</label>
          <textarea id="new-agent-memory" className={s.text} value={content} disabled={busy}
            onChange={(event) => setContent(event.target.value)} placeholder={t("agents.memoryPlaceholder")} rows={3} />
          <div className={s.actions}>
            <select aria-label={t("agents.memoryScope")} value={scope} disabled={busy}
              onChange={(event) => setScope(event.target.value as "agent" | "user")}>
              <option value="agent">{t("agents.memoryScopes.agent")}</option>
              <option value="user">{t("agents.memoryScopes.user")}</option>
            </select>
            <button type="submit" disabled={busy || !content.trim()}>{t("common.save")}</button>
          </div>
        </form>
        {currentItems.length === 0 && <p className={s.hint}>{t("agents.memoryEmpty")}</p>}
        {currentItems.map((item, index) => <article className={s.entry} key={item.id}>
          <div className={s.meta}>
            <span>{t(`agents.memoryScopes.${item.scope}`)}</span>
            {item.sensitivity === "private" && <span>{t("agents.memoryPrivate")}</span>}
          </div>
          <textarea className={s.text} value={drafts[item.id] ?? item.content} disabled={busy}
            aria-label={t("agents.memoryContent", { index: index + 1 })} rows={3}
            onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
          <div className={s.actions}>
            <button type="button" disabled={busy} onClick={() => void save("delete", item)}>{t("common.delete")}</button>
            <button type="button" disabled={busy || !(drafts[item.id] ?? item.content).trim()
              || (drafts[item.id] ?? item.content) === item.content}
              onClick={() => void save("update", item)}>{t("common.save")}</button>
          </div>
        </article>)}
        {page.hasMore && <button className={s.more} type="button" disabled={busy} onClick={() => void load(true)}>
          {t("common.loadMore")}
        </button>}
      </>}
    </div>
  );
}
