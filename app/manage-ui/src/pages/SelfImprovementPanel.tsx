import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n/selfImprovementResources";
import { selfImprovement } from "../api/client";
import { Field, Option, Select, Switch, TextArea, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import ChatMarkdown from "../components/ChatMarkdown";
import { translateProductError } from "../lib/gatewayErrors";
import type { LearnedSkill, LearnedSkillDetail, LearningConfig, LearningJob, LearningMode,
  LearningPage, LearningProposal, LearningStatus } from "../types";
import styles from "./SelfImprovementPanel.module.css";

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function bodyOf(detail: LearnedSkillDetail) {
  let text = (detail.files.find(file => file.path === "SKILL.md")?.content ?? "")
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
  // Older files can include the generated title and another identical title
  // inside the authored body. The modal already provides this heading.
  let heading = /^#\s+([^\r\n]+)(?:\r?\n|$)/u.exec(text);
  while (heading && heading[1].trim() === detail.version.title.trim()) {
    text = text.slice(heading[0].length).trimStart();
    heading = /^#\s+([^\r\n]+)(?:\r?\n|$)/u.exec(text);
  }
  return text;
}

export default function SelfImprovementPanel({ backend, agentId, skillSelection, onSelectionClosed, onSkillsChanged, onBusyChange, detailOnly = false }: {
  backend: string; agentId: string; detailOnly?: boolean;
  skillSelection?: { id: string; versionHash: string } | null;
  onSelectionClosed?: () => void; onSkillsChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t, i18n } = useTranslation("selfImprovement");
  const date = (at: number | null) => at ? new Date(at).toLocaleString(i18n.resolvedLanguage === "en" ? "en" : undefined) : t("notUsed");
  const jobState = (state: string) => t(`states.${state}`, { defaultValue: state });
  const reason = (value: string) => t(`reasons.${value}`, { defaultValue: value });
  const displayError = (message: string) => translateProductError(message, i18n.getFixedT(null, "translation"));
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [config, setConfig] = useState<LearningConfig | null>(null);
  const [skills, setSkills] = useState<LearningPage<LearnedSkill> | null>(null);
  const [jobs, setJobs] = useState<LearningPage<LearningJob> | null>(null);
  const [tab, setTab] = useState<"skills" | "history" | "settings">("skills");
  const [filter, setFilter] = useState("active");
  const [detail, setDetail] = useState<LearnedSkillDetail | null>(null);
  const [proposalBase, setProposalBase] = useState<LearnedSkillDetail | null>(null);
  const [proposal, setProposal] = useState<LearningProposal | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const detailRef = useRef<HTMLElement>(null);
  const alive = useRef(true), epoch = useRef(0), inspectionEpoch = useRef(0);
  const confirm = useConfirm(), toast = useToast();
  const dirty = useRef(false);
  dirty.current = Boolean(config && JSON.stringify(config) !== JSON.stringify(status?.settings?.config));
  const api = useCallback(<T,>(action: Parameters<typeof selfImprovement>[2], input: Record<string, unknown> = {}) =>
    selfImprovement<T>(backend, agentId, action, input), [backend, agentId]);
  const clearInspection = useCallback(() => {
    inspectionEpoch.current += 1;
    setDetail(null); setProposalBase(null); setProposal(null); setEditing(null);
  }, []);
  const load = useCallback(async () => {
    clearInspection();
    if (detailOnly) return;
    const revision = ++epoch.current;
    const next = await api<LearningStatus>("status");
    if (!alive.current || revision !== epoch.current) return;
    setStatus(next); setConfig(next.settings?.config ?? null);
    if (!next.supported) return;
    const [skillPage, history] = await Promise.all([api<LearningPage<LearnedSkill>>("skills"), api<LearningPage<LearningJob>>("history")]);
    if (!alive.current || revision !== epoch.current) return;
    setSkills(skillPage); setJobs(history); setError("");
  }, [api, clearInspection, detailOnly]);
  useEffect(() => {
    alive.current = true;
    void load().catch(cause => { if (alive.current) setError(errorText(cause)); });
    return () => { alive.current = false; epoch.current += 1; inspectionEpoch.current += 1; };
  }, [load]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ backendId?: string; agentId?: string }>).detail;
      if (detail?.backendId !== backend || detail.agentId !== agentId) return;
      // Source invalidation must also clear previews while settings have unsaved edits.
      clearInspection();
      if (!dirty.current) void load().catch(cause => { if (alive.current) setError(errorText(cause)); });
    };
    window.addEventListener("shoggoth:skills-changed", changed);
    return () => window.removeEventListener("shoggoth:skills-changed", changed);
  }, [agentId, backend, clearInspection, load]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) { setError(errorText(cause)); toast.error(displayError(errorText(cause))); } }
    finally { if (alive.current) setBusy(false); }
  };
  const choose = useCallback(async (skill: Pick<LearnedSkill, "id">, versionHash?: string) => {
    clearInspection();
    const inspection = inspectionEpoch.current;
    const value = await api<LearnedSkillDetail>("read", { skillId: skill.id, ...(versionHash ? { versionHash } : {}) });
    if (!alive.current || inspection !== inspectionEpoch.current) return;
    setDetail(value); setProposalBase(null); setProposal(null); setEditing(null);
  }, [api, clearInspection]);
  useEffect(() => {
    if (!skillSelection) { clearInspection(); return; }
    setTab("skills");
    void choose({ id: skillSelection.id }, detailOnly ? undefined : skillSelection.versionHash).catch(cause => {
      if (alive.current) setError(errorText(cause));
    });
  }, [choose, clearInspection, detailOnly, skillSelection?.id, skillSelection?.versionHash]);
  useEffect(() => {
    if (detailOnly || !detail || detail.skill.id !== skillSelection?.id) return;
    detailRef.current?.scrollIntoView({ block: "nearest" });
    detailRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [detail, detailOnly, skillSelection?.id]);
  const saveSettings = () => run(async () => {
    if (!config || !status?.settings) return;
    const activating = config.mode !== "off" && status.settings.config.mode === "off";
    if (activating && !await confirm({
      title: t("enableTitle", { name: status.agentName ?? t("currentAgent") }),
      message: t("enableMessage", { policy: t(config.mode === "auto" ? "autoPolicy" : "reviewPolicy") }),
      confirmLabel: t("enable"),
    })) return;
    await api("configure", { expectedRevision: status.settings.revision, patch: config, ...(activating ? { consent: true } : {}) });
    await load(); toast.success(t("saved"));
  });
  const change = (action: string, extra: Record<string, unknown> = {}) => run(async () => {
    if (!detail) return;
    await api("change", { skillId: detail.skill.id, expectedRevision: detail.skill.revision, action, ...extra });
    setDetail(null); setProposalBase(null); setEditing(null); await load(); onSkillsChanged?.();
    if (detailOnly) onSelectionClosed?.();
  });
  const resolve = (action: "accept" | "reject") => run(async () => {
    if (!proposal) return;
    await api("resolve", { jobId: proposal.id, expectedRevision: proposal.revision, action });
    setProposal(null); await load(); onSkillsChanged?.();
  });
  const detailView = detail && (
    <article className={`${styles.detail}${detailOnly ? ` ${styles.detailOnly}` : ""}`} ref={detailRef} aria-label={t("detailTitle")}>
      {!detailOnly && <div className={styles.head}>
        <h3>{detail.version.title}</h3>
        <button className="btn-secondary" disabled={busy} onClick={() => {
          clearInspection(); onSelectionClosed?.();
        }}>{t("closeDetail")}</button>
      </div>}

      <div className={styles.detailSummary}>
        <div className={styles.detailBadges}>
          <span className={styles.skillState} data-active={!detail.skill.archived}>{t(detail.skill.archived ? "archived" : "translation:skills.filterOn")}</span>
          {detail.skill.owner === "user" && <span className={styles.ownerLabel}>{t("userManaged")}</span>}
          {detail.skill.pinned && <span className={styles.ownerLabel}>{t("pinned")}</span>}
        </div>
        <span className={styles.readCount}>{t("taskReads", { count: detail.usage.reads })}</span>
      </div>

      {editing !== null ? (
        <div className={styles.editor}>
          <Field label={t("editMethod")} hint={t("editHint")}>
            <TextArea rows={14} value={editing} onChange={event => setEditing(event.target.value)} disabled={busy} />
          </Field>
        </div>
      ) : (
        <section className={styles.documentSection} aria-label={t("currentContent")}>
          <ChatMarkdown className="chat-md markdown-document" text={bodyOf(detail)} />
        </section>
      )}

      <details className={styles.inspector}>
        <summary><span>{t("sourceVersions")}</span><span className={styles.inspectorHint}>{t("sourceTaskCount", { count: detail.version.sourceTaskCount })}</span></summary>
        <div className={styles.inspectorBody}>
          <dl className={styles.metadata}>
            <dt>{t("currentVersion")}</dt><dd><code>{detail.version.hash.slice(0, 12)}</code><span>{date(detail.version.createdAt)}</span></dd>
            <dt>{t("sourceEvidence")}</dt><dd>{t("sourceTaskCount", { count: detail.version.sourceTaskCount })} · {t("evidenceCount", { count: detail.version.sourceEventCount })}</dd>
            <dt>{t("usage")}</dt><dd>{t("usageCounts", { exposures: detail.usage.exposures, selections: detail.usage.selections, corrections: detail.usage.correctionSignals })}</dd>
          </dl>
          <p className={styles.inspectionNote}>{t("association")}</p>
          <div className={styles.learningReason}><h4>{t("learningReason")}</h4><p>{reason(detail.version.reason)}</p></div>
          <details><summary>{t("sourceTasks")}{detail.version.sourceTaskCount > detail.version.sources.length ? t("firstSources", { count: detail.version.sources.length }) : ""}</summary>
            <ul>{detail.version.sources.map(source => <li key={source.runId}><code>{source.runId}</code></li>)}</ul>
          </details>
          {detail.files.filter(file => file.path !== "SKILL.md").map(file => <details key={file.path}>
            <summary>{file.path}</summary>
            {/\.md$/iu.test(file.path)
              ? <ChatMarkdown className="chat-md markdown-document" text={file.content} />
              : <pre>{file.content}</pre>}
          </details>)}
          <details><summary>{t("recentVersions")}</summary><div className={styles.versionList}>{detail.history.map(version => detailOnly ? (
            <div key={version.hash} className={styles.versionRow}>
              <code>{version.hash.slice(0, 12)}</code><span>{date(version.createdAt)}</span>
              <span>{t(version.revoked ? "revoked" : version.hash === detail.skill.head ? "currentVersion" : "priorVersion")}</span>
            </div>
          ) : (
            <button key={version.hash} className={styles.item} disabled={busy || version.revoked}
              onClick={() => void run(() => choose(detail.skill, version.hash))}>
              <span>{version.hash.slice(0, 12)} · {date(version.createdAt)}{version.revoked ? ` · ${t("revoked")}` : ""}</span>
              <small>{reason(version.reason)}</small>
            </button>
          ))}</div></details>
          <details><summary>{t("changeHistory")}</summary><ul>{detail.changes.map(change => <li key={change.id}>
            {date(change.createdAt)} · {t(`changes.${change.action}`, { defaultValue: change.action })}
            {` · ${t(change.actor === "user" ? "actors.user" : change.actor === "curator" ? "actors.curator" : "actors.learning")}`}
          </li>)}</ul></details>
        </div>
      </details>

      <div className={`${styles.actions} ${styles.detailActions}`}>
        {editing !== null ? <>
          <button className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>{t("cancelEdit")}</button>
          <button className={`btn-primary ${styles.editButton}`} disabled={busy || !editing.trim()}
            onClick={() => change("edit", { body: editing })}>{t("saveAndAdopt")}</button>
        </> : <>
          <button className="btn-secondary" disabled={busy} onClick={() => change(detail.skill.pinned ? "unpin" : "pin")}>{t(detail.skill.pinned ? "changes.unpin" : "pinSkill")}</button>
          <button className="btn-secondary" disabled={busy} onClick={() => change(detail.skill.archived ? "restore" : "archive")}>{t(detail.skill.archived ? "restoreSkill" : "archiveSkill")}</button>
          {detail.skill.owner === "managed" && <button className="btn-secondary" disabled={busy} onClick={() => change("adopt")}>{t("changes.adopt")}</button>}
          <button className={`btn-primary ${styles.editButton}`} disabled={busy || detail.version.hash !== detail.skill.head}
            onClick={() => setEditing(bodyOf(detail))}>{t("editBody")}</button>
          {!detailOnly && detail.version.hash !== detail.skill.head && <button className="btn-secondary" disabled={busy}
            onClick={() => change("revert", { versionHash: detail.version.hash })}>{t("restoreVersion")}</button>}
        </>}
      </div>
    </article>
  );
  if (detailOnly) return <>
    {error && <p className="error" role="alert">{displayError(error)}</p>}
    {detailView || (!error && <p className="muted" role="status">{t("loadingDetail")}</p>)}
  </>;
  if (status?.supported === false) return null;
  const visibleSkills = skills?.items.filter(skill => filter === "all" || (filter === "archived" ? skill.archived : !skill.archived));
  return <section className={styles.panel} aria-label={t("title")}>
    <div className={styles.head}>
      <div><h2>{t("title")} <span className={styles.preview}>{t("preview")}</span></h2>
        <p>{t("description")}</p></div>
      <span className={styles.badge}>{t(status?.running ? "states.reviewing" : `modes.${status?.settings?.config.mode ?? "off"}`)}</span>
      <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
        await load(); onSkillsChanged?.();
      })}>{t("translation:common.refresh")}</button>
    </div>
    {error && <p className="error" role="alert">{displayError(error)}</p>}
    {!status && !error && <p className="muted">{t("loading")}</p>}
    {status?.supported && <>
      <nav className={styles.tabs} aria-label={t("views")}>
        {(["skills", "history", "settings"] as const).map(id =>
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{t(`tabs.${id}`)}</button>)}
      </nav>
      {tab === "settings" && config && <div className={styles.settings}>
        <p className={styles.note}>{t("settingsNote")}</p>
        <Field label={t("learningMode")}><Select value={config.mode} disabled={busy} onChange={value => setConfig({ ...config, mode: value as LearningMode })}>
          <Option value="off">{t("modeChoices.off")}</Option><Option value="review">{t("modeChoices.review")}</Option><Option value="auto">{t("modeChoices.auto")}</Option>
        </Select></Field>
        <Field label={t("backgroundModel")} hint={t("backgroundModelHint", {
          model: status.capability?.model ?? t(status.capability?.supported ? "runtimeDefault" : "modelUnavailable"),
          runtime: status.capability?.runtime ?? t("runtimeUnbound"),
        })}>
          <TextInput value={config.model ?? ""} placeholder={t("followAgent")} disabled={busy}
            onChange={event => setConfig({ ...config, model: event.target.value.trim() || null })} /></Field>
        <Field label={t("inputBudget")} hint={t("inputBudgetHint")}>
          <TextInput type="number" step={1} disabled={busy} value={config.maxInputTokens ?? ""} placeholder={t("automatic")}
            onChange={event => setConfig({ ...config, maxInputTokens: event.target.value === "" ? null : Number(event.target.value) })} />
        </Field>
        <p className="muted">{t("reviewBudget", {
          iterations: status.capability?.maxIterations ?? 16,
          budget: status.capability?.maxInputTokens == null
            ? t("unlimitedBudget") : t("limitedBudget", { tokens: status.capability.maxInputTokens.toLocaleString() }),
        })}</p>
        <Field label={t("curation")} hint={t("curationHint")}>
          <Switch checked={config.curationEnabled} disabled={busy} onChange={value => setConfig({ ...config, curationEnabled: value })} />
        </Field>
        {!status.capability?.supported && <p role="status" className={styles.note}>{t("reviewUnavailable", {
          reason: status.capability?.reason == null ? t("bindingUnavailable") : displayError(status.capability.reason),
        })}</p>}
        <p className="muted">{t("today", { runs: status.budget?.runs ?? 0, tokens: status.budget?.tokens.toLocaleString() ?? "0" })}
          {Boolean(status.budget?.unknownCalls) && t("unknownCalls", { count: status.budget?.unknownCalls })}</p>
        <div className={styles.actions}><button className="btn-primary" disabled={busy} onClick={saveSettings}>{t("translation:settings.saveSettings")}</button>
          <button className="btn-secondary" disabled={busy || status.settings?.config.mode === "off" || !status.latestRunId || !status.capability?.supported}
            onClick={() => void run(async () => { const result = await api<{ queued: boolean; state: string }>("request", { runId: status.latestRunId });
              await load(); toast.success(result.queued ? t("reviewQueued") : t("alreadyReviewed", { state: jobState(result.state) })); })}>{t("reviewLatest")}</button></div>
      </div>}
      {tab === "skills" && <>
        {status.curation?.map(item => <p className={styles.note} key={item.skillIds.join(":")}>
          {t("curationSuggestion", { title: item.title, reason: item.reason })}</p>)}
        <div className={styles.toolbar}><Select value={filter} onChange={setFilter}>
          <Option value="active">{t("filterActive")}</Option><Option value="archived">{t("archived")}</Option><Option value="all">{t("filterAll")}</Option></Select>
          <span className="muted">{t("loadedCount", { count: skills?.items.length ?? 0 })}</span></div>
        {!visibleSkills?.length && <p className={styles.empty}>{t(status.settings?.config.mode === "off" ? "noSkillsOff" : "noSkills")}</p>}
        <div className={styles.list}>{visibleSkills?.map(skill => <button key={skill.id} className={styles.item}
          disabled={busy || skill.revoked} onClick={() => void run(() => choose(skill))}>
          <strong>{skill.revoked ? t("states.withdrawn") : skill.title}</strong><span>{skill.description}</span>
          <small>{t(skill.owner === "user" ? "userManaged" : "autoManaged")}{skill.pinned ? ` · ${t("pinned")}` : ""}{skill.archived ? ` · ${t("archived")}` : ""}
            {skill.observation === "unused_14_days" ? ` · ${t("unused")}` : ""}
            {` · ${t("tasksRead", { count: skill.usage?.reads ?? 0 })} · ${date(skill.updatedAt)}`}</small></button>)}</div>
        {skills?.nextCursor && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
          const next = await api<LearningPage<LearnedSkill>>("skills", { cursor: skills.nextCursor });
          if (alive.current) setSkills({ ...next, items: [...skills.items, ...next.items] }); })}>{t("moreSkills")}</button>}
      </>}
      {tab === "history" && <>
        {!jobs?.items.length && <p className={styles.empty}>{t("noHistory")}</p>}
        <div className={styles.list}>{jobs?.items.map(job => <article className={styles.history} key={job.id}>
          <div className={styles.head}><strong>{job.proposal?.title ?? jobState(job.state)}</strong>
            <span className={styles.badge}>{jobState(job.state)}</span><small>{date(job.createdAt)}</small></div>
          <p>{job.reason == null ? job.proposal?.reason ?? t("processed") : reason(job.reason)}</p>
          <small>{t("historyEvidence", { count: job.sourceCount })}{job.calls.map(call => t("modelCall", {
            attempt: call.attempt, model: call.model ?? t("unknownModel"),
            usage: call.usage ? t("actualUsage", { tokens: call.usage.inputTokens + call.usage.outputTokens })
              : t("estimatedUsage", { tokens: call.reservedTokens }),
          })).join("")}</small>
          {job.state === "pending_review" && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
            clearInspection();
            const inspection = inspectionEpoch.current;
            const value = await api<LearningProposal>("proposal", { jobId: job.id });
            if (!alive.current || inspection !== inspectionEpoch.current) return;
            setProposal(value);
            if (value.proposal.action === "patch") {
              const base = await api<LearnedSkillDetail>("read", { skillId: value.proposal.skillId, versionHash: value.proposal.baseVersionHash });
              if (alive.current && inspection === inspectionEpoch.current) setProposalBase(base);
            }
          })}>{t("viewProposal")}</button>}
        </article>)}</div>
        {jobs?.nextCursor && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
          const next = await api<LearningPage<LearningJob>>("history", { cursor: jobs.nextCursor });
          if (alive.current) setJobs({ ...next, items: [...jobs.items, ...next.items] }); })}>{t("moreHistory")}</button>}
      </>}
      {proposal && <article className={styles.detail} aria-label={t("proposalTitle")}><h3>{proposal.proposal.title}</h3>
        <p>{proposal.proposal.reason}</p><p className="muted">{t("evidenceCount", { count: proposal.sourceCount })} · {t(proposal.proposal.action === "patch" ? "updateSkill" : "createSkill")}</p>
        <div className={styles.diff}>{proposalBase && <div><h4>{t("currentVersion")}</h4><pre>{bodyOf(proposalBase)}</pre></div>}
          <div><h4>{t("proposedContent")}</h4><pre>{proposal.proposal.body}</pre></div></div>{proposal.proposal.references.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}
        <div className={styles.actions}><button className="btn-primary" disabled={busy} onClick={() => resolve("accept")}>{t("acceptProposal")}</button>
          <button className="btn-secondary" disabled={busy} onClick={() => resolve("reject")}>{t("rejectProposal")}</button>
          <button className="btn-secondary" onClick={clearInspection}>{t("translation:common.close")}</button></div></article>}
      {detailView}
    </>}
  </section>;
}
