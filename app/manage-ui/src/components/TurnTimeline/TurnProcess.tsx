// TurnProcess —— 聊天线程里的「回合过程」区:一行紧凑摘要(步数/工具数/错误数/
// 总耗时),点击内嵌展开完整 TurnTimeline;右侧「⤢」把同一份步骤交给父级开抽屉
// 大视图。历史回合(降级数据)与直播回合(S2)共用本组件,live 只影响脉冲与跟随。
// 视觉按 Figma 稿(node 7171:818)还原:白胶囊头 + cpu 图标 + Steps/Tools/Errors 摘要。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, type TurnStep } from "../../lib/turnTimeline";
import TurnTimeline from "./TurnTimeline";
import { IconTrajectory, TrajChevron, TrajZoom } from "./trajectoryIcons";
import styles from "./TurnTimeline.module.css";

export default function TurnProcess({
  steps,
  live,
  defaultOpen,
  onOpenLargeView,
  pluginConversation,
}: {
  steps: TurnStep[];
  live?: boolean;
  defaultOpen?: boolean;
  onOpenLargeView?: () => void;
  pluginConversation?: { backendId: string; sessionKey: string;
    agentId?: string; sessionId?: string; duplicateToolCallIds?: ReadonlySet<string> };
}) {
  const { t } = useTranslation();
  const stats = useMemo(() => {
    const all: TurnStep[] = [];
    let taskErrors = 0, running = false;
    const visit = (items: TurnStep[]) => {
      for (const step of items) {
        all.push(step);
        if (!step.subagent) continue;
        running ||= step.subagent.status === "running";
        if (["failed", "timeout"].includes(step.subagent.status)
          && !step.subagent.steps.some(child => child.status === "error" || child.isError)) taskErrors++;
        visit(step.subagent.steps);
      }
    };
    visit(steps);
    const tools = all.filter((s) => s.kind === "tool");
    const errs = taskErrors + all.filter((s) => s.status === "error" || s.isError).length;
    const dur = tools.reduce((a, s) => a + (s.durationS ?? 0), 0);
    return { total: all.length, tools: tools.length, errs, dur, running };
  }, [steps]);
  const [open, setOpen] = useState(!!defaultOpen || stats.running);
  const showDurations = useMemo(() => steps.some((s) => typeof s.durationS === "number" && s.durationS > 0), [steps]);
  if (!steps.length) return null;
  return (
    <div className={styles.proc} data-chat-process>
      <div className={styles.procRow}>
        <button type="button" className={styles.procHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={styles.procIco} data-live={live || stats.running ? "1" : undefined} data-err={stats.errs ? "1" : undefined}>
            <IconTrajectory />
          </span>
          <span className={styles.procLabel}>{t("turnLab.processLabel")}</span>
          <span className={styles.procMeta}>
            {t("turnLab.processSummary", { steps: stats.total, tools: stats.tools })}
            {stats.errs ? <span className={styles.procErr}> · {t("turnLab.processErrors", { count: stats.errs })}</span> : null}
            {showDurations && stats.dur > 0 ? ` · ${formatDuration(stats.dur)}` : ""}
          </span>
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
            <TurnTimeline steps={steps} status={live || stats.running ? "running" : "done"} showDurations={showDurations} autoFollow={!!live || stats.running} className={styles.procTimeline} pluginConversation={pluginConversation} />
          ) : (
            <div />
          )}
        </div>
      </div>
    </div>
  );
}
