import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { acceptAgentMemoryCandidates, explainAgentMemory, listAgentMemories,
  listAgentMemoryCandidates, listAgentTranscripts, mutateAgentMemory,
  reviewAgentMemoryCandidate } from "../../api/client";
import { useToast } from "../../components/ui";
import { useNavigationGuard } from "../../lib/navigation-guard";
import type { AgentMemoryCandidate, AgentMemoryCandidatePage, AgentMemoryExplanation,
  AgentMemoryItem, AgentMemoryPage, AgentTranscriptEventPage } from "../../types";
import s from "./AgentMemoryEditor.module.css";

// Edit authoritative records, not the bounded Markdown projection. Unloaded
// records, provenance and workspace bindings must survive edits to this page.
export default function AgentMemoryEditor({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [page, setPage] = useState<AgentMemoryPage | null>(null);
  const [auditMode, setAuditMode] = useState(false);
  const [explanation, setExplanation] = useState<AgentMemoryExplanation | null>(null);
  const [evidenceAnchorId, setEvidenceAnchorId] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [candidatePage, setCandidatePage] = useState<AgentMemoryCandidatePage | null>(null);
  const [candidateStatus, setCandidateStatus] = useState<"pending" | "all">("pending");
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [sourcePreview, setSourcePreview] = useState<{ candidateId: string; text: string } | null>(null);
  const [sourceLoading, setSourceLoading] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<"agent" | "user">("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const candidateGeneration = useRef(0);
  const candidateInFlight = useRef(false);
  const evidenceGeneration = useRef(0);
  const sourceGeneration = useRef(0);
  const dirty = !!content.trim() || Object.entries(drafts).some(([id, value]) => (
    value !== page?.items.find((item) => item.id === id)?.content
  ));
  const currentItems = auditMode ? page?.items || [] : page?.items.filter((item) => item.validFrom <= Date.now()
    && (item.validUntil === null || item.validUntil > Date.now())) || [];
  useNavigationGuard({ dirty, busy: busy || candidateBusy, onDiscard: () => { setDrafts({}); setContent(""); } });

  const load = async (append = false, status: "active" | "deleted" = auditMode ? "deleted" : "active") => {
    if (inFlight.current) return;
    inFlight.current = true;
    const ticket = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = await listAgentMemories(backendId, agentId, status, undefined, append ? page?.nextCursor : 0);
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

  const loadCandidates = async (append = false, status: "pending" | "all" = candidateStatus) => {
    if (backendId !== "shoggoth" || candidateInFlight.current) return;
    sourceGeneration.current++;
    setSourceLoading(null);
    candidateInFlight.current = true;
    const ticket = ++candidateGeneration.current;
    setCandidateBusy(true); setCandidateError("");
    try {
      let next = await listAgentMemoryCandidates(backendId, agentId, status,
        append ? candidatePage?.nextCursor ?? 0 : 0, 50,
        append ? candidatePage?.revision : undefined);
      // Revoked sources are skipped by the Service while its cursor advances
      // over stored candidates. Continue through bounded empty pages so the
      // editor does not appear exhausted when a visible item follows them.
      for (let skipped = 0; next.items.length === 0 && next.hasMore && skipped < 16; skipped++) {
        if (candidateGeneration.current !== ticket || next.nextCursor === null) return;
        next = await listAgentMemoryCandidates(backendId, agentId, status,
          next.nextCursor, 50, next.revision);
      }
      if (candidateGeneration.current !== ticket) return;
      if (append && candidatePage && next.revision !== candidatePage.revision) {
        setCandidateError(t("agents.memoryCandidatesChanged"));
        return;
      }
      if (!append) setSelectedCandidateIds([]);
      setCandidatePage(append && candidatePage ? {
        ...next, items: [...candidatePage.items, ...next.items],
      } : next);
    } catch (cause) {
      if (candidateGeneration.current === ticket) {
        setCandidateError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (candidateGeneration.current === ticket) { candidateInFlight.current = false; setCandidateBusy(false); }
    }
  };

  useEffect(() => {
    setExplanation(null);
    setEvidenceAnchorId(null);
    setSelectedCandidateIds([]);
    void load();
    void loadCandidates();
    return () => {
      generation.current++; inFlight.current = false;
      candidateGeneration.current++; candidateInFlight.current = false;
      evidenceGeneration.current++;
      sourceGeneration.current++;
    };
    // The parent keys this editor by backend and Agent, isolating drafts and pending replies.
  }, [backendId, agentId]);

  const showEvidence = async (id: string, anchorId = id) => {
    const pageTicket = generation.current;
    const ticket = ++evidenceGeneration.current;
    setExplanation(null);
    setEvidenceAnchorId(anchorId);
    setExplaining(true); setError("");
    try {
      const value = await explainAgentMemory(backendId, agentId, id);
      if (generation.current === pageTicket && evidenceGeneration.current === ticket) setExplanation(value);
    } catch (cause) {
      if (generation.current === pageTicket && evidenceGeneration.current === ticket) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (evidenceGeneration.current === ticket) setExplaining(false);
    }
  };

  const switchAudit = () => {
    if (busy || inFlight.current) return;
    const next = !auditMode;
    setAuditMode(next); setPage(null); setDrafts({}); setExplanation(null); setEvidenceAnchorId(null);
    evidenceGeneration.current++; setExplaining(false);
    void load(false, next ? "deleted" : "active");
  };

  const switchCandidates = () => {
    if (candidateBusy || candidateInFlight.current) return;
    const next = candidateStatus === "pending" ? "all" : "pending";
    setCandidateStatus(next); setCandidatePage(null); setSourcePreview(null); setSourceLoading(null);
    setSelectedCandidateIds([]);
    sourceGeneration.current++;
    void loadCandidates(false, next);
  };

  const previewCandidateSource = async (candidate: AgentMemoryCandidate) => {
    if (sourceLoading || candidateBusy) return;
    const candidateTicket = candidateGeneration.current;
    const ticket = ++sourceGeneration.current;
    setSourceLoading(candidate.id); setCandidateError(""); setSourcePreview(null);
    try {
      const result = await listAgentTranscripts(backendId, agentId,
        candidate.source.sessionId, candidate.source.seq - 1, 1) as AgentTranscriptEventPage;
      if (candidateGeneration.current !== candidateTicket || sourceGeneration.current !== ticket) return;
      const event = result.items[0];
      if (event?.id !== candidate.source.eventId || event.seq !== candidate.source.seq
        || event.kind !== "user"
        || event.runId !== candidate.source.runId || event.contextExcluded
        || typeof event.content?.text !== "string") {
        throw new Error(t("agents.memoryCandidateSourceUnavailable"));
      }
      setSourcePreview({ candidateId: candidate.id, text: event.content.text });
    } catch (cause) {
      if (candidateGeneration.current === candidateTicket && sourceGeneration.current === ticket) {
        setCandidateError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (sourceGeneration.current === ticket) setSourceLoading(null);
    }
  };

  const reviewCandidate = async (candidate: AgentMemoryCandidate, action: "accept" | "reject") => {
    if (!page || !candidatePage || busy || inFlight.current || candidateInFlight.current
      || sourceLoading !== null
      || candidate.status !== "pending"
      || (action === "accept" && page.recallPolicy?.ready === false)) return;
    candidateInFlight.current = true;
    const ticket = ++candidateGeneration.current;
    setCandidateBusy(true); setCandidateError("");
    let succeeded = false;
    try {
      await reviewAgentMemoryCandidate(backendId, agentId, action, candidate.id,
        candidatePage.revision, action === "accept" ? page.revision : undefined);
      if (candidateGeneration.current !== ticket) return;
      succeeded = true;
      setSourcePreview(null);
      toast.success(t(action === "accept" ? "agents.memoryCandidateAccepted" : "agents.memoryCandidateRejected"));
    } catch (cause) {
      if (candidateGeneration.current === ticket) {
        setCandidateError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (candidateGeneration.current === ticket) { candidateInFlight.current = false; setCandidateBusy(false); }
    }
    if (succeeded) {
      void loadCandidates(false, candidateStatus);
      if (action === "accept") void load(false, "active");
    }
  };

  const toggleCandidateSelection = (candidateId: string) => {
    setSelectedCandidateIds((selected) => selected.includes(candidateId)
      ? selected.filter((id) => id !== candidateId)
      : selected.length < 50 ? [...selected, candidateId] : selected);
  };

  const acceptSelectedCandidates = async () => {
    if (!page || !candidatePage || busy || inFlight.current || candidateInFlight.current
      || sourceLoading !== null || page.recallPolicy?.ready === false
      || selectedCandidateIds.length < 1 || selectedCandidateIds.length > 50) return;
    const selected = candidatePage.items.filter((candidate) => selectedCandidateIds.includes(candidate.id));
    if (selected.length !== selectedCandidateIds.length
      || selected.some((candidate) => candidate.status !== "pending")) return;
    candidateInFlight.current = true;
    const ticket = ++candidateGeneration.current;
    setCandidateBusy(true); setCandidateError("");
    let succeeded = false;
    try {
      const result = await acceptAgentMemoryCandidates(backendId, agentId,
        selectedCandidateIds, candidatePage.revision, page.revision);
      if (candidateGeneration.current !== ticket) return;
      if (result.acceptedCandidateIds.length !== selectedCandidateIds.length
        || result.acceptedCandidateIds.some((id, index) => id !== selectedCandidateIds[index])) {
        throw new Error(t("agents.memoryCandidatesChanged"));
      }
      succeeded = true;
      setSelectedCandidateIds([]);
      setSourcePreview(null);
      toast.success(t("agents.memoryCandidatesAccepted", { count: result.acceptedCandidateIds.length }));
    } catch (cause) {
      if (candidateGeneration.current === ticket) {
        setCandidateError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (candidateGeneration.current === ticket) { candidateInFlight.current = false; setCandidateBusy(false); }
    }
    if (succeeded) {
      void loadCandidates(false, candidateStatus);
      void load(false, "active");
    }
  };

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
      const replacedId = action === "update" || action === "delete" ? item?.id : saved?.id;
      const existed = page.items.some((entry) => entry.id === replacedId || entry.id === saved?.id);
      const added = action === "create" && saved && !existed && result.revision !== page.revision ? 1 : 0;
      const removed = action === "delete" && existed ? 1 : 0;
      const items = page.items.filter((entry) => entry.id !== replacedId && entry.id !== saved?.id);
      if (saved?.status === "active" && (existed || added)) items.push(saved);
      items.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      setPage({ ...page, revision: result.revision, nextCursor: page.nextCursor + added - removed, items });
      setExplanation(null);
      setEvidenceAnchorId(null);
      evidenceGeneration.current++; setExplaining(false);
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
      <button className={s.more} type="button" disabled={busy} onClick={switchAudit}>
        {t(auditMode ? "agents.memoryShowActive" : "agents.memoryShowForgotten")}
      </button>
      {page?.recallPolicy?.ready === false && <p className={s.error} role="alert">
        {t("agents.memoryRecallNeedsRepair")}
      </p>}
      {page?.recallPolicy?.indexPending && page.recallPolicy.ready && <p className={s.hint}>
        {t("agents.memoryIndexPending")}
      </p>}
      {error && <div className={s.error} role="alert">
        <p>{error}</p>
        <button type="button" disabled={busy} onClick={() => void load()}>{t("agents.memoryReload")}</button>
      </div>}
      {!page ? !error && <p className={s.hint}>{t("common.loading")}</p> : <>
        {!auditMode && <form className={s.add} onSubmit={(event) => { event.preventDefault(); void save("create"); }}>
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
        </form>}
        {!auditMode && backendId === "shoggoth" && <section className={s.candidates}
          aria-label={t("agents.memoryCandidatesTitle")}>
          <div className={s.candidateHeading}>
            <div>
              <h3>{t("agents.memoryCandidatesTitle")}</h3>
              <p className={s.hint}>{t("agents.memoryCandidatesExplain")}</p>
            </div>
            <div className={s.candidateHeadingActions}>
              <button type="button" disabled={candidateBusy || busy || sourceLoading !== null
                || !page || selectedCandidateIds.length === 0 || page.recallPolicy?.ready === false}
                onClick={() => void acceptSelectedCandidates()}>
                {t("agents.memoryCandidatesAcceptSelected", { count: selectedCandidateIds.length })}
              </button>
              <button type="button" disabled={candidateBusy} onClick={switchCandidates}>
                {t(candidateStatus === "pending" ? "agents.memoryCandidatesShowAll" : "agents.memoryCandidatesShowPending")}
              </button>
            </div>
          </div>
          {candidatePage?.usage.day && <p className={s.candidateUsage}>
            {t("agents.memoryCandidateUsage", { day: candidatePage.usage.day, count: candidatePage.usage.calls })}
            {candidatePage.usage.calls > 0 && <> · {t("agents.memoryCandidateTokenUsage", {
              input: candidatePage.usage.inputTokens, output: candidatePage.usage.outputTokens,
            })}</>}
          </p>}
          {candidateError && <div className={s.error} role="alert">
            <p>{candidateError}</p>
            <button type="button" disabled={candidateBusy} onClick={() => void loadCandidates()}>
              {t("agents.memoryReload")}
            </button>
          </div>}
          {!candidatePage && !candidateError && <p className={s.hint}>{t("common.loading")}</p>}
          {candidatePage?.items.length === 0 && <p className={s.hint}>{t("agents.memoryCandidatesEmpty")}</p>}
          {candidatePage?.items.map((candidate) => <article className={s.candidate} key={candidate.id}>
            <div className={s.meta}>
              {candidate.status === "pending" && <input type="checkbox"
                aria-label={t("agents.memoryCandidateSelect", { content: candidate.content })}
                checked={selectedCandidateIds.includes(candidate.id)}
                disabled={candidateBusy || busy || sourceLoading !== null
                  || !page || page.recallPolicy?.ready === false
                  || (selectedCandidateIds.length >= 50 && !selectedCandidateIds.includes(candidate.id))}
                onChange={() => toggleCandidateSelection(candidate.id)} />}
              <span>{t(`agents.memoryScopes.${candidate.scope}`)}</span>
              {candidate.sensitivity === "private" && <span>{t("agents.memoryPrivate")}</span>}
              {candidate.status !== "pending" && <span>{t(`agents.memoryCandidateStatus.${candidate.status}`)}</span>}
            </div>
            <p className={s.candidateContent}>{candidate.content}</p>
            <p className={s.candidateSource}>{t("agents.memoryCandidateSource")}: {candidate.source.sessionId} / {candidate.source.eventId}</p>
            {sourcePreview?.candidateId === candidate.id && <blockquote className={s.sourcePreview}>
              {sourcePreview.text}
            </blockquote>}
            <div className={s.actions}>
              <button type="button" disabled={candidateBusy || sourceLoading !== null}
                onClick={() => void previewCandidateSource(candidate)}>
                {t("agents.memoryCandidateShowSource")}
              </button>
              {candidate.status === "pending" && <>
                <button type="button" disabled={candidateBusy || busy || sourceLoading !== null}
                  onClick={() => void reviewCandidate(candidate, "reject")}>
                  {t("agents.memoryCandidateReject")}
                </button>
                <button type="button" disabled={candidateBusy || busy || sourceLoading !== null || !page || page.recallPolicy?.ready === false}
                  onClick={() => void reviewCandidate(candidate, "accept")}>
                  {t("agents.memoryCandidateAccept")}
                </button>
              </>}
            </div>
          </article>)}
          {candidatePage?.hasMore && <button className={s.more} type="button" disabled={candidateBusy}
            onClick={() => void loadCandidates(true)}>{t("common.loadMore")}</button>}
        </section>}
        {currentItems.length === 0 && <p className={s.hint}>{t("agents.memoryEmpty")}</p>}
        {currentItems.map((item, index) => <article className={s.entry} key={item.id}>
          <div className={s.meta}>
            <span>{t(`agents.memoryScopes.${item.scope}`)}</span>
            {item.sensitivity === "private" && <span>{t("agents.memoryPrivate")}</span>}
          </div>
          <textarea className={s.text} value={drafts[item.id] ?? item.content} disabled={busy || auditMode}
            aria-label={t("agents.memoryContent", { index: index + 1 })} rows={3}
            onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
          <div className={s.actions}>
            <button type="button" disabled={explaining} onClick={() => void showEvidence(item.id)}>
              {t("agents.memorySource")}
            </button>
            {!auditMode && <button type="button" disabled={busy} onClick={() => void save("delete", item)}>{t("common.delete")}</button>}
            {!auditMode && <button type="button" disabled={busy || !(drafts[item.id] ?? item.content).trim()
              || (drafts[item.id] ?? item.content) === item.content}
              onClick={() => void save("update", item)}>{t("common.save")}</button>}
          </div>
          {evidenceAnchorId === item.id && explanation && <aside className={s.detail} aria-live="polite">
            <p><strong>{t(explanation.item.id === item.id
              ? "agents.memoryCurrentVersionEvidence" : "agents.memoryPreviousVersionEvidence")}</strong></p>
            <p>{t("agents.memoryEvidenceVersionId")}: <code>{explanation.item.id}</code></p>
            <p>{t("agents.memoryEvidenceVersionContent")}: {explanation.item.content}</p>
            {explanation.item.id !== item.id && <p><strong>{t("agents.memoryHistoricalEvidenceOnly")}</strong></p>}
            {explanation.withdrawalReason && <p>{t("agents.memoryWithdrawalReason")}: {t(
              `agents.memoryWithdrawalReasons.${explanation.withdrawalReason}`)}</p>}
            <p>{t(explanation.evidence.status === "verified_origin" && explanation.evidence.origin === "import"
              ? "agents.memoryImportEvidence" : `agents.memoryEvidence.${explanation.evidence.status}`)}</p>
            {explanation.evidence.importFile && <p>{t("agents.memoryImportedFile")}: {explanation.evidence.importFile.name
              ?? t("agents.memoryImportedFileNameUnavailable")} · SHA-256 <code>{explanation.evidence.importFile.sha256}</code></p>}
            {explanation.evidence.quote && <blockquote>{explanation.evidence.quote}</blockquote>}
            {explanation.evidence.sessionId && <p>{t("agents.memorySession")}: {explanation.evidence.sessionId}</p>}
            {explanation.evidence.eventId && <p>{t("agents.memoryEvent")}: {explanation.evidence.eventId}</p>}
            {explanation.item.supersedes && <button type="button" disabled={explaining}
              onClick={() => void showEvidence(explanation.item.supersedes!, item.id)}>
              {t("agents.memoryPreviousVersion")}
            </button>}
          </aside>}
        </article>)}
        {page.hasMore && <button className={s.more} type="button" disabled={busy} onClick={() => void load(true)}>
          {t("common.loadMore")}
        </button>}
      </>}
    </div>
  );
}
