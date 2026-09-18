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
}: {
  steps: TurnStep[];
  live?: boolean;
  defaultOpen?: boolean;
  onOpenLargeView?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!!defaultOpen);
  const stats = useMemo(() => {
    const tools = steps.filter((s) => s.kind === "tool");
    const errs = steps.filter((s) => s.status === "error" || s.isError).length;
    const dur = tools.reduce((a, s) => a + (s.durationS ?? 0), 0);
    return { total: steps.length, tools: tools.length, errs, dur };
  }, [steps]);
  const showDurations = useMemo(() => steps.some((s) => typeof s.durationS === "number" && s.durationS > 0), [steps]);
  if (!steps.length) return null;
  return (
    <div className={styles.proc}>
      <div className={styles.procRow}>
        <button type="button" className={styles.procHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={styles.procIco} data-live={live ? "1" : undefined} data-err={stats.errs ? "1" : undefined}>
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
            <TurnTimeline steps={steps} status={live ? "running" : "done"} showDurations={showDurations} autoFollow={!!live} className={styles.procTimeline} />
          ) : (
            <div />
          )}
        </div>
      </div>
    </div>
  );
}
