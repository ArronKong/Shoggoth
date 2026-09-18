// TurnTimeline —— 「一次 agent 回合」的竖向步骤时间线(纯展示,只吃 TurnStep[])。
// 数据从 lib/turnTimeline.ts 的 reducer 来;本组件不关心事件从哪产生(剧本播放 /
// 历史回放 / 将来聊天页的实时流都一样)。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { deriveRelations, formatDuration, summarizeArgs, toolLabelKey, type StepStatus, type TurnStep, type TurnTimelineState } from "../../lib/turnTimeline";
import { TrajChevron, TrajGlyphExec, TrajGlyphRead, TrajGlyphThinking, TrajGlyphWorkboard } from "./trajectoryIcons";
import styles from "./TurnTimeline.module.css";

export interface TurnTimelineProps {
  steps: TurnStep[];
  status: TurnTimelineState["status"];
  showDurations?: boolean; // 历史回放没有可信时序 → false,工具耗时一律「—」
  autoFollow?: boolean;
  onUserScrollAway?: () => void;
  emptyHint?: ReactNode;
  className?: string;
}

const ENTER_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "none" },
];
const ENTER_MS = 240;
const ENTER_EASE = "cubic-bezier(0.215, 0.61, 0.355, 1)"; // 与 usage uc-grow 同曲线

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function oneLine(text: string | undefined, max = 90): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function fmtK(n?: number): string {
  if (typeof n !== "number") return "";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ---- 步骤类型小图标(currentColor,颜色由节点的分类/状态色决定) ----------
// thinking/read/execute/workboard 四类 1:1 取自 Figma 稿(trajectoryIcons);
// 其余仍是旧线条图标,待设计稿补齐后逐类替换。
function glyph(kind: string): ReactNode {
  const p = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "user":
      return <svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>;
    case "thinking":
      return <TrajGlyphThinking />;
    case "gather":
      return <svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
    case "read":
      return <TrajGlyphRead />;
    case "execute":
      return <TrajGlyphExec />;
    case "workboard":
      return <TrajGlyphWorkboard />;
    case "message":
      return <svg {...p}><path d="M21 4 3 11l7 2 2 7 9-16Z" /></svg>;
    case "plan":
      return <svg {...p}><path d="m4 6 2 2 3-3M4 13l2 2 3-3M4 20l2 2 3-3" transform="translate(0,-1.5)" /><path d="M13 6h7M13 13h7M13 20h7" transform="translate(0,-1.5)" /></svg>;
    case "prompt":
      return <svg {...p}><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7" /><path d="M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>;
    case "status":
      return <svg {...p}><path d="M8 4v6l-3 3M16 20v-6l3-3" /><path d="M4 13h6M14 11h6" /></svg>;
    case "error":
      return <svg {...p}><path d="M12 7v6M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>;
    case "final":
      return <svg {...p}><path d="m6 12 4 4 8-8" /></svg>;
    case "text":
      return <svg {...p}><path d="M4 6h16M4 12h16M4 18h9" /></svg>;
    default:
      return <svg {...p}><path d="M14 3a5 5 0 0 0-4.6 7L3 16.5V21h4.5L14 14.6A5 5 0 0 0 20.9 8l-3.4 3.4-2.9-2.9L18 5.1A5 5 0 0 0 14 3Z" /></svg>;
  }
}

// 节点着色用的语义槽:tool 用分类,其他 kind 用固定映射。
function nodeAccent(step: TurnStep): string {
  if (step.status === "error" || step.isError) return "error";
  if (step.kind === "tool") return step.category ?? "other";
  if (step.kind === "prompt") return step.status === "pending" ? "pending" : "neutral";
  if (step.kind === "final") return "final";
  if (step.kind === "error") return "error";
  if (step.kind === "plan") return "plan";
  return "neutral";
}

function nodeGlyph(step: TurnStep): ReactNode {
  return glyph(step.kind === "tool" ? (step.category === "other" ? "wrench" : step.category ?? "wrench") : step.kind);
}

export default function TurnTimeline({ steps, status, showDurations = true, autoFollow = true, onUserScrollAway, emptyHint, className }: TurnTimelineProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const enteredRef = useRef<Set<string>>(new Set());
  const prevLenRef = useRef(0);
  const followedStepsRef = useRef<TurnStep[]>([]);
  const followedAutoRef = useRef(false);

  const relations = useMemo(() => deriveRelations(steps), [steps]);

  // 重播/换剧本(steps 变短)时重置进入动画与展开状态。
  if (steps.length < prevLenRef.current) {
    enteredRef.current.clear();
    if (open.size) setOpen(new Set());
  }
  prevLenRef.current = steps.length;

  // 新步进入动画(WAAPI,家法;连接线随行一起长出来)。
  useEffect(() => {
    for (const s of steps) {
      if (enteredRef.current.has(s.id)) continue;
      enteredRef.current.add(s.id);
      const el = rowRefs.current.get(s.id);
      if (!el || reducedMotion()) continue;
      el.animate(ENTER_KEYFRAMES, { duration: ENTER_MS, easing: ENTER_EASE });
      const rail = el.querySelector(`.${styles.railTop}`);
      if (rail instanceof HTMLElement) rail.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: ENTER_MS, easing: ENTER_EASE });
    }
  }, [steps]);

  // 只滚动时间线自身，避免嵌套在聊天流时带动外层滚动容器。ChatPage 每次
  // render 都会 filter 出新数组，因此按 step 对象逐项比较：真实 reducer 更新会
  // 替换发生变化的 step，纯父级重渲染仍复用原对象，不会把用户无故拽回底部。
  useEffect(() => {
    const prevSteps = followedStepsRef.current;
    const stepsChanged = prevSteps.length !== steps.length || steps.some((step, index) => step !== prevSteps[index]);
    const autoFollowEnabled = autoFollow && !followedAutoRef.current;
    followedStepsRef.current = steps;
    followedAutoRef.current = autoFollow;
    if (!autoFollow || (!stepsChanged && !autoFollowEnabled)) return;
    const el = wrapRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onUserScrollAway) return;
    const away = () => onUserScrollAway();
    el.addEventListener("wheel", away, { passive: true });
    el.addEventListener("touchmove", away, { passive: true });
    return () => {
      el.removeEventListener("wheel", away);
      el.removeEventListener("touchmove", away);
    };
  }, [onUserScrollAway]);

  const chipLabel = (s: TurnStep): string => {
    if (s.kind === "prompt") {
      if (s.promptOutcome === "answered") return t("turnLab.promptAnswered", { choice: s.promptChoice ?? "" });
      if (s.promptOutcome === "expired") return t("turnLab.promptExpired");
      if (s.status === "pending") return t("turnLab.pending");
    }
    const m: Record<StepStatus, string> = {
      running: t("turnLab.running"),
      ok: t("turnLab.done"),
      error: t("turnLab.failed"),
      aborted: t("turnLab.aborted"),
      pending: t("turnLab.pending"),
    };
    return m[s.status];
  };

  const kindLabel = (s: TurnStep): string => {
    switch (s.kind) {
      case "user": return t("turnLab.stepUser");
      case "thinking": return t("turnLab.stepThinking");
      case "text": return t("turnLab.stepSegment");
      case "plan": return t("turnLab.stepPlan");
      case "prompt": return t("turnLab.stepPrompt");
      case "status": return t("turnLab.stepStatus");
      case "error": return t("turnLab.stepError");
      case "final": return t("turnLab.stepFinal");
      default: {
        // 工具显示名(R340):中文模式映射人话,en 的映射值就是原标识符;
        // 未收录(MCP 长名等)回退原名。原始标识符恒在行悬停 title 上。
        const raw = s.toolName ?? "tool";
        return t(toolLabelKey(raw), { defaultValue: "" }) || raw;
      }
    }
  };

  const titleFor = (s: TurnStep): string => {
    switch (s.kind) {
      case "tool": return summarizeArgs(s.toolName, s.args);
      case "plan": {
        const total = s.planEntries?.length ?? 0;
        const done = s.planEntries?.filter((e) => e.status === "completed").length ?? 0;
        return `${done}/${total} · ${t("turnLab.planVersion", { n: s.planVersion ?? 1 })}`;
      }
      case "prompt": return oneLine(s.prompt?.command || s.prompt?.question, 80);
      case "status": return oneLine(s.text, 80);
      case "final": {
        const u = s.usage;
        const meta = [s.model, u ? `↑${fmtK(u.input)} ↓${fmtK(u.output)}` : ""].filter(Boolean).join(" · ");
        return meta || oneLine(s.text, 80);
      }
      default: return oneLine(s.text, 90);
    }
  };

  const bodyFor = (s: TurnStep): ReactNode => {
    if (s.kind === "tool") {
      const argsText = s.args !== undefined ? JSON.stringify(s.args, null, 2) : "";
      return (
        <>
          <div className={styles.secLabel}>{t("turnLab.argsLabel")}</div>
          {argsText ? <pre className={styles.pre}>{argsText}</pre> : <div className={styles.noArgs}>{t("turnLab.noArgs")}</div>}
          {s.diffText || s.diff ? (
            <>
              <div className={styles.secLabel}>{t("turnLab.diffLabel")}</div>
              <pre className={styles.pre}>
                {s.diffText
                  ? s.diffText.split("\n").map((ln, i) => (
                      <div key={i} className={ln.startsWith("+") ? styles.diffAdd : ln.startsWith("-") ? styles.diffDel : ln.startsWith("@@") ? styles.diffHunk : styles.diffCtx}>
                        {ln}
                      </div>
                    ))
                  : (
                      <>
                        <div className={styles.diffHunk}>{s.diff!.path}</div>
                        {s.diff!.oldText.split("\n").map((ln, i) => <div key={`o${i}`} className={styles.diffDel}>- {ln}</div>)}
                        {s.diff!.newText.split("\n").map((ln, i) => <div key={`n${i}`} className={styles.diffAdd}>+ {ln}</div>)}
                      </>
                    )}
              </pre>
            </>
          ) : null}
          {s.output ? (
            <>
              <div className={styles.secLabel}>{t("turnLab.resultLabel")}</div>
              <pre className={styles.pre}>{s.output}</pre>
              {s.outputTruncated ? <div className={styles.noArgs}>{t("turnLab.truncatedNote")}</div> : null}
            </>
          ) : null}
        </>
      );
    }
    if (s.kind === "plan") {
      return (
        <div className={styles.planList}>
          {(s.planEntries ?? []).map((e, i) => (
            <div key={i} className={styles.planLine} data-st={e.status === "completed" ? "done" : e.status === "in_progress" ? "run" : "todo"}>
              <span className={styles.planMark}>{e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"}</span>
              <span>{e.content}</span>
            </div>
          ))}
        </div>
      );
    }
    if (s.kind === "prompt") {
      return (
        <>
          {s.prompt?.description ? <div className={styles.bodyText}>{s.prompt.description}</div> : null}
          {s.prompt?.command ? <pre className={styles.pre}>{s.prompt.command}</pre> : null}
          {s.prompt?.choices?.length ? <div className={styles.noArgs}>{s.prompt.choices.join(" / ")}</div> : null}
        </>
      );
    }
    if (s.text) return <div className={styles.bodyText}>{s.text}</div>;
    return null;
  };

  const hasBody = (s: TurnStep): boolean => {
    if (s.kind === "tool") return s.args !== undefined || !!s.output || !!s.diffText || !!s.diff;
    if (s.kind === "plan") return (s.planEntries?.length ?? 0) > 0;
    if (s.kind === "prompt") return !!(s.prompt?.description || s.prompt?.command || s.prompt?.choices?.length);
    return !!s.text?.trim();
  };

  if (!steps.length) return <div ref={wrapRef} className={`${styles.wrap} ${className ?? ""}`}>{emptyHint ?? null}</div>;

  return (
    <div ref={wrapRef} className={`${styles.wrap} ${className ?? ""}`} data-status={status}>
      <ol className={styles.list}>
        {steps.map((s, i) => {
          const expandable = hasBody(s);
          const isOpen = open.has(s.id);
          const rel = relations.get(s.id);
          const running = s.status === "running" || s.status === "pending";
          return (
            <li
              key={s.id}
              ref={(el) => {
                if (el) rowRefs.current.set(s.id, el);
                else rowRefs.current.delete(s.id);
              }}
              className={styles.row}
              aria-current={running ? "step" : undefined}
            >
              <div className={styles.gutter}>
                <span className={styles.railTop} data-hidden={i === 0 ? "1" : undefined} />
                <span className={styles.node} data-accent={nodeAccent(s)} data-running={running ? "1" : undefined}>
                  {nodeGlyph(s)}
                </span>
                <span className={styles.railBottom} data-hidden={i === steps.length - 1 ? "1" : undefined} />
              </div>
              <div className={styles.main}>
                {rel ? (
                  <span className={styles.relBadge} data-type={rel.type}>
                    {rel.type === "retry" ? "↻ " : "⇄ "}
                    {rel.type === "retry" ? t("turnLab.retryBadge") : t("turnLab.switchBadge")}
                  </span>
                ) : null}
                <button type="button" className={styles.head} onClick={expandable ? () => setOpen((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; }) : undefined} disabled={!expandable} aria-expanded={expandable ? isOpen : undefined}>
                  <span
                    className={styles.name}
                    data-mono={s.kind === "tool" && /^[\w.:-]+$/.test(kindLabel(s)) ? "1" : undefined}
                    title={s.kind === "tool" ? s.toolName : undefined}
                  >
                    {kindLabel(s)}
                  </span>
                  <span className={styles.title}>{titleFor(s)}</span>
                  {s.kind === "tool" && s.status === "running" && s.updateCount ? (
                    <span className={styles.updates}>{t("turnLab.updates", { count: s.updateCount })}</span>
                  ) : null}
                  <span className={styles.dur}>{s.kind === "tool" ? (showDurations ? formatDuration(s.durationS) : "—") : ""}</span>
                  <span className={styles.chip} data-st={s.kind === "prompt" && s.promptOutcome === "expired" ? "aborted" : s.status}>{chipLabel(s)}</span>
                  <span className={styles.chev} data-show={expandable ? "1" : undefined} data-open={isOpen ? "1" : undefined}><TrajChevron /></span>
                </button>
                <div className={styles.bodyClip} data-open={isOpen ? "1" : undefined}>
                  <div className={styles.bodyInner}>{isOpen ? <div className={styles.body}>{bodyFor(s)}</div> : <div className={styles.body} />}</div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
