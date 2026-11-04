import { lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAgent, getAgentFile, listCronJobs } from "../api/client";
import AgentSoulDocument from "../components/AgentSoulDocument";
import BackendTabIcon from "../components/BackendTabIcon";
import { usePageCache } from "../lib/usePageCache";
import styles from "./ChatAgentPanel.module.css";

const AgentInspirationPanel = lazy(() => import("./ChatAgentNotes"));

export type ChatAgentPanelKind = "profile" | "cron" | "inspiration" | "artifacts";

function Profile({ backendId, backendName, agentId, name, renderAvatar }: {
  backendId: string; backendName: string; agentId: string; name: string; renderAvatar: (name: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const scope = JSON.stringify([backendId, agentId]);
  // The profile mounts on each open and revalidates both reads in the background.
  const detail = usePageCache(`chat-agent-profile:${scope}`, () => getAgent(backendId, agentId));
  const soul = usePageCache(`chat-agent-soul:${scope}`, () => getAgentFile(backendId, agentId, "SOUL.md"));
  const displayName = detail.data?.name || name;
  return <>
    <div className={styles.profile}>
      {renderAvatar(displayName)}
      <div className={styles.identity}>
        <div className={styles.name}>{displayName}</div>
        <div className={styles.backend}>
          <BackendTabIcon backend={backendId} label={backendName} />
          <span>{backendName}</span>
        </div>
      </div>
    </div>
    {detail.error && <p className={styles.error} role="alert">{detail.error}</p>}
    {soul.loading && !soul.data && <p className={styles.note} role="status">{t("common.loading")}</p>}
    {soul.error && <p className={styles.error} role="alert">{soul.error}</p>}
    {(Boolean(soul.data?.content.trim()) || !soul.loading && !soul.error)
      && <AgentSoulDocument text={soul.data?.content ?? ""} />}
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
    {jobs.data && <p className={styles.count}>{t("chat.agentCronCount", { count: jobs.data.length })}</p>}
    {jobs.loading && !jobs.data && <p className={styles.note} role="status">{t("common.loading")}</p>}
    {jobs.error && <p className={styles.note} role="status">{t("chat.panelCronUnavailable")}</p>}
    {!jobs.loading && !jobs.error && jobs.data?.length === 0 && <p className={styles.note}>{t("chat.panelCronEmpty")}</p>}
    <div className={styles.jobs}>
      {jobs.data?.map(job => <a key={job.id} className={styles.job}
        href={`#/cron?${new URLSearchParams({ backend: job.backendId, job: job.id })}`}>
        <div className={styles.jobHead}>
          <span className={styles.jobName}>{job.name || job.id}</span>
          <span className={styles.state}>{t(job.enabled ? "cron.enabled" : "cron.disabled")}</span>
        </div>
        {(job.description || job.prompt) && <p className={styles.prompt}>{job.description || job.prompt}</p>}
        <div className={styles.schedule}>
          {job.scheduleDisplay && <span>{job.scheduleDisplay}</span>}
          {job.nextRunAt != null && <span>{t("chat.panelNextRun", { time: when(job.nextRunAt) })}</span>}
          {job.lastRunAt != null && <span>{t("chat.panelLastRun", { time: when(job.lastRunAt) })}</span>}
        </div>
      </a>)}
    </div>
  </>;
}

// All header entries share the same full-height surface and scroll area.
// Agent/session changes remount this region via its scope key.
export default function ChatAgentPanel({ kind, backendId, backendName, agentId, name, renderAvatar, children }: {
  kind: ChatAgentPanelKind | null; backendId: string; backendName: string; agentId: string; name: string;
  renderAvatar: (name: string) => ReactNode; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const title = kind === "profile" ? t("chat.agentPanelProfile")
    : kind === "cron" ? t("chat.agentPanelCron")
      : kind === "artifacts" ? t("chat.agentArtifactsTitle") : t("agents.tabInspiration");
  return <div id="chat-agent-panel" className={styles.expansion} data-open={Boolean(kind)}
    role="region" aria-label={title} aria-hidden={!kind} {...(!kind ? { inert: "" } : {})}>
    <div className={styles.clip}>
      {kind && <div key={kind} className={styles.body}>
        {kind !== "profile" && kind !== "artifacts" && <div className={styles.toolbar}>
          <h2 className={styles.title}>{title}</h2>
        </div>}
        {kind === "artifacts" ? children
          : kind === "profile" ? <Profile backendId={backendId} backendName={backendName} agentId={agentId} name={name} renderAvatar={renderAvatar} />
          : kind === "cron" ? <Cron backendId={backendId} agentId={agentId} />
            : <Suspense fallback={<p className={styles.note} role="status">{t("common.loading")}</p>}>
              <AgentInspirationPanel key={JSON.stringify([backendId, agentId])} backendId={backendId} agentId={agentId} />
            </Suspense>}
      </div>}
    </div>
  </div>;
}
