import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAgent, getAgentFile, listCronJobs } from "../api/client";
import type { UnifiedCronJob } from "../types";
import AgentAvatar from "../components/AgentAvatar";
import AgentSoulDocument from "../components/AgentSoulDocument";
import BackendTabIcon from "../components/BackendTabIcon";
import { usePageCache } from "../lib/usePageCache";
import ChatAvatarPicker from "./ChatAvatarPicker";
import styles from "./ChatAgentPanel.module.css";

const AgentInspirationPanel = lazy(() => import("./ChatAgentNotes"));
const AgentCronDialog = lazy(() => import("./CronPage").then(module => ({ default: module.CronJobDialog })));

export type ChatAgentPanelKind = "profile" | "avatar" | "cron" | "inspiration" | "artifacts";

type ProfileProps = {
  backendId: string; backendName: string; agentId: string; name: string; avatarVersion: number;
  onEditAvatar: () => void; onAvatarSaved: (returnToProfile: boolean) => void; onAvatarSavingChange: (saving: boolean) => void;
};

function Profile({ backendId, backendName, agentId, name, avatarVersion, editingAvatar,
  onEditAvatar, onAvatarSaved, onAvatarSavingChange }: ProfileProps & { editingAvatar: boolean }) {
  const { t } = useTranslation();
  const avatarTrigger = useRef<HTMLButtonElement>(null);
  const wasEditingAvatar = useRef(false);
  useLayoutEffect(() => {
    if (!editingAvatar && wasEditingAvatar.current) avatarTrigger.current?.focus({ preventScroll: true });
    wasEditingAvatar.current = editingAvatar;
  }, [editingAvatar]);
  const scope = JSON.stringify([backendId, agentId]);
  // The profile mounts on each open and revalidates both reads in the background.
  const detail = usePageCache(`chat-agent-profile:${scope}`, () => getAgent(backendId, agentId));
  const soul = usePageCache(`chat-agent-soul:${scope}`, () => getAgentFile(backendId, agentId, "SOUL.md"));
  const displayName = detail.data?.name || name;
  const profileBody = `${styles.body} ${styles.profileBody}`;
  if (editingAvatar) return <div className={profileBody} key="avatar">
    <ChatAvatarPicker agentId={agentId} name={displayName} version={avatarVersion}
      onSaved={onAvatarSaved} onSavingChange={onAvatarSavingChange} />
  </div>;
  return <div className={profileBody} key="profile">
    <div className={`${styles.profileRow} ${styles.profile}`}>
      <button type="button" ref={avatarTrigger} className={styles.avatarEdit}
        title={t("chat.changeAvatar")} aria-label={t("chat.changeAvatar")} onClick={onEditAvatar}>
        <AgentAvatar agentId={agentId} name={displayName} className="chat-header__avatar" version={avatarVersion} />
        <span className={styles.avatarAction} aria-hidden="true">{t("chat.change")}</span>
      </button>
      <div className={styles.identity}>
        <div className={styles.name}>{displayName}</div>
        <div className={`${styles.backend} ${styles.profileMeta}`}>
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
  </div>;
}

function Cron({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const [selectedJob, setSelectedJob] = useState<UnifiedCronJob | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const closeDialog = useCallback(() => {
    setSelectedJob(null);
    trigger.current?.focus({ preventScroll: true });
  }, []);
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
      {jobs.data?.map(job => <button key={job.id} type="button" className={styles.job}
        data-cron-id={job.id} aria-haspopup="dialog"
        onClick={event => { trigger.current = event.currentTarget; setSelectedJob(job); }}>
        <span className={styles.jobHead}>
          <span className={styles.jobName}>{job.name || job.id}</span>
          <span className={styles.state}>{t(job.enabled ? "cron.enabled" : "cron.disabled")}</span>
        </span>
        {(job.description || job.prompt) && <span className={styles.prompt}>{job.description || job.prompt}</span>}
        <span className={styles.schedule}>
          {job.scheduleDisplay && <span>{job.scheduleDisplay}</span>}
          {job.nextRunAt != null && <span>{t("chat.panelNextRun", { time: when(job.nextRunAt) })}</span>}
          {job.lastRunAt != null && <span>{t("chat.panelLastRun", { time: when(job.lastRunAt) })}</span>}
        </span>
      </button>)}
    </div>
    {selectedJob && <Suspense fallback={<p className={styles.note} role="status">{t("common.loading")}</p>}>
      <AgentCronDialog key={JSON.stringify([selectedJob.backendId, selectedJob.id])} job={selectedJob}
        onClose={closeDialog} onChange={jobs.refresh} />
    </Suspense>}
  </>;
}

// All header entries share the same full-height surface and scroll area.
// Agent/session changes remount this region via its scope key.
export default function ChatAgentPanel({ kind, children, ...profile }: ProfileProps & {
  kind: ChatAgentPanelKind | null; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { backendId, agentId } = profile;
  const title = kind === "profile" ? t("chat.agentPanelProfile")
    : kind === "avatar" ? t("chat.changeAvatar")
      : kind === "cron" ? t("chat.agentPanelCron")
        : kind === "artifacts" ? t("chat.agentArtifactsTitle") : t("agents.tabInspiration");
  return <div id="chat-agent-panel" className={styles.expansion} data-open={Boolean(kind)}
    role="region" aria-label={title} aria-hidden={!kind} {...(!kind ? { inert: "" } : {})}>
    <div className={styles.clip}>
      {kind === "profile" || kind === "avatar" ? <Profile {...profile} editingAvatar={kind === "avatar"} />
        : kind && <div key={kind} className={styles.body}>
        {kind !== "artifacts" && <div className={styles.toolbar}>
          <h2 className={styles.title}>{title}</h2>
        </div>}
        {kind === "artifacts" ? children
          : kind === "cron" ? <Cron backendId={backendId} agentId={agentId} />
            : <Suspense fallback={<p className={styles.note} role="status">{t("common.loading")}</p>}>
              <AgentInspirationPanel key={JSON.stringify([backendId, agentId])} backendId={backendId} agentId={agentId} />
            </Suspense>}
      </div>}
    </div>
  </div>;
}
