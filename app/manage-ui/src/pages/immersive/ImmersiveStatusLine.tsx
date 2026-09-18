import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImmersivePhase } from "./immersiveBg";
import { toolLabelKey } from "../../lib/turnTimeline";
import styles from "./ImmersiveStatusLine.module.css";

// 轻量状态行：流式期间在消息流尾部显示一行半透明状态（思考中/正在运行某工具），
// 点开玻璃浮层看本轮过程详情（工具行 + 思考全文）；轮次完成（live 变 null）后
// 短暂淡出自动收起。这是沉浸模式对普通模式思考卡/工具卡的替代呈现——用户选择
// 「轻量状态行」而非整套大卡（NG2-2 的翻案形态）。

export interface ImmersiveLiveTool {
  name: string;
  title?: string; // formatToolTitle 的产品化标题（url/query 摘要）
  done: boolean;
  isError?: boolean;
  durationS?: number;
}

export interface ImmersiveLiveStatus {
  tools: ImmersiveLiveTool[];
  thinkingText?: string; // 全量累积推理文本（原文；详情里 <pre> 展示）
}

export default function ImmersiveStatusLine({ phase, live }: { phase: ImmersivePhase; live: ImmersiveLiveStatus | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 完成后淡出收起：live 消失时先保留末帧内容播放淡出动画，再卸载。
  const [shown, setShown] = useState<ImmersiveLiveStatus | null>(live);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (live) {
      setShown(live);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = setTimeout(() => {
      setShown(null);
      setClosing(false);
      setOpen(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [live]);
  // 详情浮层的 Esc：capture 阶段拦截，避免同一按键继续冒泡到沉浸层的分层退出链。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!shown) return null;
  // 工具显示名(R340):中文模式映射成人话,未收录/英文模式回退原标识符。
  const toolDisp = (name?: string): string => {
    const raw = (name || "").trim();
    if (!raw) return t("chat.tool");
    return t(toolLabelKey(raw), { defaultValue: "" }) || raw;
  };
  const runningTool = [...shown.tools].reverse().find((x) => !x.done);
  const thinkingLines = (shown.thinkingText || "").trim().split("\n").filter(Boolean);
  const preview = thinkingLines[thinkingLines.length - 1]?.slice(0, 48) ?? "";
  const label =
    phase === "tool" && runningTool
      ? t("chat.liveToolRun", { tool: toolDisp(runningTool.name) })
      : phase === "thinking" || (!shown.tools.length && shown.thinkingText)
        ? preview
          ? `${t("chat.liveThinking")} · ${preview}`
          : t("chat.liveThinking")
        : shown.tools.length
          ? t("chat.liveToolsCount", { count: shown.tools.length })
          : t("chat.liveThinking");
  return (
    <div className={closing ? `${styles.wrap} ${styles.closing}` : styles.wrap}>
      <button type="button" className={styles.pill} onClick={() => setOpen((v) => !v)} title={t("chat.liveDetail")}>
        <span className={styles.dot} />
        <span className={styles.label}>{label}</span>
        <span className={styles.chev}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          <div className={styles.backdrop} onMouseDown={() => setOpen(false)} />
          <div className={styles.pop}>
            <div className={styles.popTitle}>{t("chat.liveDetail")}</div>
            {shown.thinkingText?.trim() ? <pre className={styles.thinking}>{shown.thinkingText.trim()}</pre> : null}
            {shown.tools.length > 0 && (
              <div className={styles.toolList}>
                {shown.tools.map((x, i) => (
                  <div key={i} className={x.isError ? `${styles.toolRow} ${styles.toolErr}` : styles.toolRow}>
                    <span className={styles.toolMark}>{x.isError ? "✗" : x.done ? "✓" : "▸"}</span>
                    <span className={styles.toolName} title={x.name || undefined}>
                      {toolDisp(x.name)}
                      {x.title ? <span className={styles.toolTitle}> · {x.title}</span> : null}
                    </span>
                    {x.durationS != null && (
                      <span className={styles.toolDur}>{x.durationS >= 10 ? Math.round(x.durationS) : x.durationS.toFixed(1)}s</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
