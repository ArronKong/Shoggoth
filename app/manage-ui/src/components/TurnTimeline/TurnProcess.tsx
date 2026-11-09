// TurnProcess —— 聊天线程里的「回合过程」区:一行紧凑摘要(步数/工具数/错误数/
// 总耗时),点击内嵌展开完整 TurnTimeline;右侧「⤢」把同一份步骤交给父级开抽屉
// 大视图。历史回合(降级数据)与直播回合(S2)共用本组件,live 只影响脉冲与跟随。
// 视觉按 Figma 稿(node 7171:818)还原:白胶囊头 + cpu 图标 + Steps/Tools/Errors 摘要。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTurnElapsed, turnElapsedMs, type TurnStep, type TurnTiming } from "../../lib/turnTimeline";
import TurnTimeline from "./TurnTimeline";
import { IconTrajectory, TrajChevron, TrajZoom } from "./trajectoryIcons";
import styles from "./TurnTimeline.module.css";

export function getTurnProcessStats(steps: TurnStep[]) {
  let total = 0, tools = 0, errs = 0, running = false;
  const visit = (items: TurnStep[]) => {
    for (const step of items) {
      total++;
      if (step.kind === "tool") tools++;
      if (step.status === "error" || step.isError) errs++;
      if (!step.subagent) continue;
      running ||= step.subagent.status === "running";
      if (["failed", "timeout"].includes(step.subagent.status)
        && !step.subagent.steps.some(child => child.status === "error" || child.isError)) errs++;
      visit(step.subagent.steps);
    }
  };
  visit(steps);
  const showDurations = steps.some(step => typeof step.durationS === "number" && step.durationS > 0);
  return { total, tools, errs, running, showDurations };
}

export function TurnProcessSummary({ stats, timing, live }: {
  stats: ReturnType<typeof getTurnProcessStats>;
  timing?: TurnTiming;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const counting = live && timing?.startedAt != null && timing.finishedAt == null;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting, timing?.startedAt]);
  const elapsed = turnElapsedMs(timing?.startedAt, timing?.finishedAt ?? (counting ? now : undefined));
  const duration = elapsed === undefined ? "" : formatTurnElapsed(elapsed);
  return <>
    {t("turnLab.processSummary", { steps: stats.total, tools: stats.tools })}
    {stats.errs ? <span className={styles.procErr}> · {t("turnLab.processErrors", { count: stats.errs })}</span> : null}
    {duration && <> · <span data-turn-elapsed-ms={elapsed}>{duration}</span></>}
  </>;
}

export default function TurnProcess({
  steps,
  timing,
  live,
  defaultOpen,
  onOpenLargeView,
  pluginConversation,
}: {
  steps: TurnStep[];
  timing?: TurnTiming;
  live?: boolean;
  defaultOpen?: boolean;
  onOpenLargeView?: () => void;
  pluginConversation?: { backendId: string; sessionKey: string;
    agentId?: string; sessionId?: string; duplicateToolCallIds?: ReadonlySet<string> };
}) {
  const { t } = useTranslation();
  const stats = useMemo(() => getTurnProcessStats(steps), [steps]);
  const [open, setOpen] = useState(!!defaultOpen || stats.running);
  if (!steps.length) return null;
  return (
    <div className={styles.proc} data-chat-process>
      <div className={styles.procRow}>
        <button type="button" className={styles.procHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={styles.procIco} data-live={live || stats.running ? "1" : undefined} data-err={stats.errs ? "1" : undefined}>
            <IconTrajectory />
          </span>
          <span className={styles.procLabel}>{t("turnLab.processLabel")}</span>
          <span className={styles.procMeta}><TurnProcessSummary stats={stats} timing={timing} live={live} /></span>
          <span className={styles.procChev} data-open={open ? "1" : undefined}>
            <TrajChevron />
          </span>
        </button>
        {onOpenLargeView ? (
          <button type="button" className={styles.procZoom} onClick={onOpenLargeView} title={t("turnLab.processLargeView")} aria-label={t("turnLab.processLargeView")}>
            <TrajZoom />
          </button>
        ) : null}
      </div>
      <div className={styles.bodyClip} data-open={open ? "1" : undefined}>
        <div className={styles.bodyInner}>
          {open ? (
            <TurnTimeline steps={steps} status={live || stats.running ? "running" : "done"} showDurations={stats.showDurations} autoFollow={!!live || stats.running} className={styles.procTimeline} pluginConversation={pluginConversation} />
          ) : (
            <div />
          )}
        </div>
      </div>
    </div>
  );
}
