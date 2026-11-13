// 定时任务单次运行结果弹窗（设计稿 246:1193；出错 426:1071）。Cron 页日历和
// Dashboard 最近运行共用：标题行右侧「去会话 / 编辑 / 关闭」三枚图标，下面是
// 助理·时间·模型·耗时信息区（设计稿的 Provider 位按用户要求换成模型），再下面是
// 可滚动的白色正文卡。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../../components/Modal";
import AgentAvatar from "../../components/AgentAvatar";
import { fmtMs } from "../usage/charts";
import { formatCronTime } from "./cronPresets";
import ManagedRunFiles from "../agents/ManagedRunFiles";
import styles from "./CronRunReportModal.module.css";

// 图标与导航图标同一语言：1.2 描边、圆头圆角，32 盒子里约 14px 的字形。
const ICON_STROKE = { stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function ChatGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <g {...ICON_STROKE}>
        <path d="M9.5 15.25C9.5 12.627 11.627 10.5 14.25 10.5H17.75C20.373 10.5 22.5 12.627 22.5 15.25V16.75C22.5 19.373 20.373 21.5 17.75 21.5H9.5V15.25Z" />
        <path d="M13 16H13.01M16 16H16.01M19 16H19.01" strokeWidth={2.4} />
      </g>
    </svg>
  );
}

function EditGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <g {...ICON_STROKE}>
        <path d="M18.6 10.9L21.1 13.4L13.4 21.1L10.5 21.5L10.9 18.6L18.6 10.9Z" />
        <path d="M17 12.5L19.5 15" />
      </g>
    </svg>
  );
}

export default function CronRunReportModal({
  open,
  onClose,
  onOpenChangeComplete,
  title,
  failed,
  agentId,
  backendId,
  runId,
  agentName,
  startedAt,
  durationMs,
  model,
  bodyLabel,
  children,
  onAskInChat,
  onEdit,
  editDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onOpenChangeComplete?: (open: boolean) => void;
  title: ReactNode;
  failed: boolean;
  agentId?: string;
  backendId?: string;
  runId?: string;
  agentName?: string;
  startedAt?: number | null;
  durationMs?: number;
  // 这次运行用的模型；页面负责回退（任务配置 / 默认模型文案），缺省显示「—」。
  model?: string;
  bodyLabel?: ReactNode;
  children: ReactNode;
  // 没有可追问的会话或正文时不传，图标随之隐藏。
  onAskInChat?: () => void;
  onEdit: () => void;
  editDisabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;

  const actions = (
    <>
      {onAskInChat && (
        <button type="button" className={styles.iconBtn} onClick={onAskInChat}
          aria-label={t("cron.askInChat")} title={t("cron.askInChat")}>
          <ChatGlyph />
        </button>
      )}
      <button type="button" className={styles.iconBtn} onClick={onEdit} disabled={editDisabled}
        aria-label={t("common.edit")} title={t("common.edit")}>
        <EditGlyph />
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      onOpenChangeComplete={onOpenChangeComplete}
      title={title}
      variant="report"
      tone={failed ? "error" : undefined}
      actions={actions}
    >
      <dl className={styles.meta}>
        <dt>{t("dashboard.agentLabel")}</dt>
        <dd>
          {agentId ? (
            <span className={styles.agent}>
              <AgentAvatar agentId={agentId} className={styles.avatar} />
              <span className={styles.ellipsis}>{agentName || agentId}</span>
            </span>
          ) : "—"}
        </dd>
        <dt>{t("dashboard.timeLabel")}</dt>
        <dd>{formatCronTime(startedAt, locale)}</dd>
        <dt>{t("dashboard.modelLabel")}</dt>
        <dd title={model}>{model || "—"}</dd>
        <dt>{t("dashboard.durationLabel")}</dt>
        <dd>{typeof durationMs === "number" ? fmtMs(durationMs) : "—"}</dd>
      </dl>
      <section className={styles.card}>
        {bodyLabel && <h4 className={styles.cardLabel}>{bodyLabel}</h4>}
        {children}
        {open && backendId && agentId && runId && <ManagedRunFiles backend={backendId} agentId={agentId} runId={runId} />}
      </section>
    </Modal>
  );
}

// 正文卡里的提示行：默认灰色说明；error 为红色错误原因。
export function ReportNote({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={error ? styles.error : styles.note} data-selectable-text={error || undefined}>{children}</p>;
}

// 红色背景只看这次执行本身是否失败。OpenClaw 在「必需投递」失败时也会把
// completionStatus 记成 failed，但正文已经产出，不能整窗标红；投递失败由正文卡
// 顶部的提示行说明。没有执行状态时才退回 completionStatus。
export function runExecutionFailed(status?: string | null, completionStatus?: string | null): boolean {
  const value = status || completionStatus;
  return value === "error" || value === "failed";
}
