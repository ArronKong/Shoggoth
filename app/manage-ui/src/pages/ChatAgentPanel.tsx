import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAgent, getAgentFile, listCronJobs } from "../api/client";
import ChatMarkdown from "../components/ChatMarkdown";
import { usePageCache } from "../lib/usePageCache";
import styles from "./ChatAgentPanel.module.css";

const AgentInspirationPanel = lazy(() => import("./ChatAgentNotes"));

export type ChatAgentPanelKind = "profile" | "cron" | "inspiration";

function RefreshButton({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  return <button type="button" className={styles.action} disabled={busy}
    title={t("common.refresh")} aria-label={t("common.refresh")} onClick={onRefresh}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11A8 8 0 1 0 6.3 16.7M20 4v7h-7" />
    </svg>
  </button>;
}

function Profile({ backendId, agentId, name, renderAvatar }: {
  backendId: string; agentId: string; name: string; renderAvatar: (name: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const scope = JSON.stringify([backendId, agentId]);
  const detail = usePageCache(`chat-agent-profile:${scope}`, () => getAgent(backendId, agentId));
  const soul = usePageCache(`chat-agent-soul:${scope}`, () => getAgentFile(backendId, agentId, "SOUL.md"));
  const displayName = detail.data?.name || name;
  return <>
    <div className={styles.profile}>
      {renderAvatar(displayName)}
      <div className={styles.identity}>
        <div className={styles.name}>{displayName}</div>
        <div className={styles.meta}>@{agentId}</div>
      </div>
      <RefreshButton busy={detail.loading || soul.loading}
        onRefresh={() => { void detail.refresh(); void soul.refresh(); }} />
    </div>
    {detail.error && <p className={styles.error} role="alert">{detail.error}</p>}
    <h3 className={styles.soulTitle}>SOUL</h3>
    {soul.loading && !soul.data && <p className={styles.note} role="status">{t("common.loading")}</p>}
    {soul.error && <p className={styles.error} role="alert">{soul.error}</p>}
    {soul.data?.content.trim() ? <ChatMarkdown text={soul.data.content} className={`chat-md ${styles.soul}`} />
      : !soul.loading && !soul.error && <p className={styles.note}>{t("chat.agentSoulEmpty")}</p>}
  </>;
}

function Cron({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const jobs = usePageCache(`chat-agent-cron:${JSON.stringify([backendId, agentId])}`, async () =>
    (await listCronJobs({ backend: backendId, agentIds: [agentId], sortBy: "nextRunAt", sortDir: "asc" }))
      .filter(job => job.backendId === backendId && job.agentId === agentId));
  const when = (time: number) => new Date(time).toLocaleString([], {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return <>
    <div className={styles.listToolbar}>
      <span className={styles.meta}>{jobs.data && t("chat.agentCronCount", { count: jobs.data.length })}</span>
      <RefreshButton busy={jobs.loading} onRefresh={() => { void jobs.refresh(); }} />
    </div>
    {jobs.loading && !jobs.data && <p className={styles.note} role="status">{t("common.loading")}</p>}
    {jobs.error && <p className={styles.error} role="alert">{jobs.error}</p>}
    {!jobs.loading && !jobs.error && jobs.data?.length === 0 && <p className={styles.note}>{t("chat.panelCronEmpty")}</p>}
    <div className={styles.jobs}>
      {jobs.data?.map(job => <a key={job.id} className={styles.job}
        href={`#/cron?${new URLSearchParams({ backend: job.backendId, job: job.id })}`}>
        <div className={styles.jobHead}>
          <span className={styles.jobName}>{job.name || job.id}</span>
          <span className={`${styles.state} ${job.lastError || job.lastStatus === "error" ? styles.failed : ""}`}>
            <span className={`${styles.dot} ${job.enabled ? styles.enabled : ""}`} />
            {t(job.enabled ? "cron.enabled" : "cron.disabled")}
          </span>
        </div>
        {(job.description || job.prompt) && <p className={styles.prompt}>{job.description || job.prompt}</p>}
        <div className={styles.schedule}>
          {job.scheduleDisplay && <span>{job.scheduleDisplay}</span>}
          {job.nextRunAt != null && <span>{t("chat.panelNextRun", { time: when(job.nextRunAt) })}</span>}
          {job.lastRunAt != null && <span>{t("chat.panelLastRun", { time: when(job.lastRunAt) })}</span>}
        </div>
        {job.lastError && <p className={styles.error}>{job.lastError}</p>}
      </a>)}
    </div>
  </>;
}

// Keep the last view during the closing transition, then unmount it.
// Agent/session changes remount this region via its scope key.
export default function ChatAgentPanel({ kind, backendId, agentId, name, renderAvatar, onClose }: {
  kind: ChatAgentPanelKind | null; backendId: string; agentId: string; name: string;
  renderAvatar: (name: string) => ReactNode; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rendered, setRendered] = useState(kind);
  if (kind && rendered !== kind) setRendered(kind);
  useEffect(() => {
    if (kind) return;
    const timer = setTimeout(() => setRendered(null), 220);
    return () => clearTimeout(timer);
  }, [kind]);
  const title = rendered === "profile" ? t("chat.agentPanelProfile")
    : rendered === "cron" ? t("chat.agentPanelCron") : t("agents.tabInspiration");
  return <div id="chat-agent-panel" className={styles.expansion} data-open={Boolean(kind)}
    role="region" aria-label={title} aria-hidden={!kind} {...(!kind ? { inert: "" } : {})}>
    <div className={styles.clip}>
      {rendered && <div className={styles.body}>
        <div className={styles.toolbar}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.action} title={t("common.close")}
            aria-label={t("common.close")} onClick={onClose}>×</button>
        </div>
        {rendered === "profile" ? <Profile backendId={backendId} agentId={agentId} name={name} renderAvatar={renderAvatar} />
          : rendered === "cron" ? <Cron backendId={backendId} agentId={agentId} />
            : <Suspense fallback={<p className={styles.note} role="status">{t("common.loading")}</p>}>
              <AgentInspirationPanel key={JSON.stringify([backendId, agentId])} backendId={backendId} agentId={agentId} />
            </Suspense>}
      </div>}
    </div>
  </div>;
}
