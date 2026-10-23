import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import "./ChatThinkFastMenu.css";

// 与 composer 脸面 .chat-pill--think 的 background-image 同一 15px 脑图标（ChatPage.css）。
function BrainIcon() {
  return (
    <svg
      className="think-fast-menu__brain"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4.66699 9.33301C3.56243 9.33301 2.66699 10.2284 2.66699 11.333C2.66699 12.4376 3.56243 13.333 4.66699 13.333C4.90075 13.333 5.12514 13.2929 5.33366 13.2192" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.84226 10.4032C1.94918 9.97231 1.33301 9.05817 1.33301 8.00017C1.33301 7.19237 1.69216 6.46851 2.2595 5.97949" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.28035 5.92514C2.10327 5.6604 2 5.34209 2 4.99967C2 4.0792 2.74619 3.33301 3.66667 3.33301C4.04194 3.33301 4.38825 3.45703 4.66683 3.66634" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.82545 3.70989C4.72382 3.49444 4.66699 3.25369 4.66699 2.99967C4.66699 2.0792 5.41319 1.33301 6.33366 1.33301C7.25413 1.33301 8.00033 2.0792 8.00033 2.99967V13.333" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.33301 13.333C5.33301 14.0694 5.92996 14.6663 6.66634 14.6663C7.40274 14.6663 7.99967 14.0694 7.99967 13.333" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 4.66699C8 5.77156 8.8954 6.66699 10 6.66699" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.3337 9.33301C12.4383 9.33301 13.3337 10.2284 13.3337 11.333C13.3337 12.4376 12.4383 13.333 11.3337 13.333C11.0999 13.333 10.8755 13.2929 10.667 13.2192" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.1572 10.4032C14.0503 9.97231 14.6665 9.05817 14.6665 8.00017C14.6665 7.19237 14.3073 6.46851 13.74 5.97949" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.7195 5.92514C13.8965 5.6604 13.9998 5.34209 13.9998 4.99967C13.9998 4.0792 13.2536 3.33301 12.3331 3.33301C11.9579 3.33301 11.6115 3.45703 11.333 3.66634" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 2.99967C8 2.0792 8.7462 1.33301 9.66667 1.33301C10.5871 1.33301 11.3333 2.0792 11.3333 2.99967C11.3333 3.25369 11.2765 3.49444 11.1749 3.70989" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6667 13.333C10.6667 14.0694 10.0697 14.6663 9.33333 14.6663C8.59693 14.6663 8 14.0694 8 13.333" stroke="currentColor" strokeWidth="1.28" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Figma 309:16240 / asset f5d048590c…svg — 原路径，勿改形。
function BoltIcon({ iconRef }: { iconRef?: Ref<SVGSVGElement> }) {
  return (
    <svg
      ref={iconRef}
      width="11"
      height="13"
      viewBox="0 0 11 13"
      fill="none"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path
        d="M0.760102 7.60791C0.849112 7.66825 0.952147 7.70008 1.05724 7.6997H4.94465C5.03448 7.69938 5.12304 7.72261 5.20274 7.76738C5.28243 7.81216 5.35088 7.87715 5.40221 7.95677C5.45354 8.0364 5.48622 8.12829 5.49745 8.22456C5.50868 8.32082 5.49812 8.4186 5.46668 8.50949L4.40042 12.1205C4.38371 12.1861 4.38815 12.2559 4.413 12.3184C4.43785 12.3809 4.48164 12.4325 4.53718 12.4646C4.59272 12.4966 4.65671 12.5074 4.71864 12.495C4.78057 12.4826 4.83677 12.4479 4.87801 12.3965L10.3759 6.27807C10.4421 6.18991 10.4838 6.08328 10.4962 5.97055C10.5085 5.85782 10.491 5.74363 10.4456 5.64124C10.4002 5.53885 10.3289 5.45246 10.2399 5.39211C10.1509 5.33176 10.0479 5.29993 9.94276 5.30032H6.05534C5.96551 5.30064 5.87695 5.27741 5.79726 5.23264C5.71757 5.18786 5.64912 5.12287 5.59779 5.04324C5.54646 4.96362 5.51378 4.87173 5.50255 4.77546C5.49132 4.6792 5.50188 4.58142 5.53332 4.49053L6.59958 0.879473C6.61629 0.813879 6.61185 0.744099 6.587 0.681589C6.56214 0.619078 6.51836 0.567551 6.46282 0.535465C6.40728 0.503378 6.34329 0.492639 6.28136 0.50501C6.21943 0.517381 6.16323 0.552127 6.12199 0.603544L0.624068 6.72195C0.55786 6.8101 0.516168 6.91674 0.503836 7.02947C0.491504 7.14219 0.509038 7.25639 0.5544 7.35878C0.599763 7.46117 0.671093 7.54756 0.760102 7.60791Z"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ChatThinkFastMenu({
  levels: supportedLevels,
  value,
  defaultValue,
  defaultLabel,
  levelLabel,
  fastCapable,
  fastOn,
  onChangeThinking,
  onChangeFast,
  disabled = false,
  triggerClassName = "chat-pill chat-pill--select chat-pill--think",
  appearance = "auto",
}: {
  levels: string[];
  value?: string | null;
  defaultValue?: string | null;
  defaultLabel: string;
  levelLabel: (level: string) => string;
  fastCapable: boolean;
  fastOn: boolean;
  onChangeThinking: (level: string) => void | Promise<unknown>;
  onChangeFast: (next: boolean) => void;
  disabled?: boolean;
  triggerClassName?: string;
  /** auto = follow document data-theme; dark/default force */
  appearance?: "auto" | "default" | "dark";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [themeDark, setThemeDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark",
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setThemeDark(root.getAttribute("data-theme") === "dark");
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  const menuDark = appearance === "dark" || (appearance === "auto" && themeDark);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const thumbFillRef = useRef<HTMLSpanElement>(null);
  const shapeAnimationRef = useRef<Animation | null>(null);
  const faceBoltRef = useRef<SVGSVGElement>(null);
  const popupBoltRef = useRef<SVGSVGElement>(null);
  const fastAnimationsRef = useRef<Animation[]>([]);
  const previousFastRef = useRef(fastOn);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({});
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const [pendingLevel, setPendingLevel] = useState<string | null>(null);
  const [animateThumb, setAnimateThumb] = useState(true);
  const draggingRef = useRef<{ pointerId: number; startX: number; offset: number; thumb: boolean; moved: boolean; index: number } | null>(null);
  const savingRef = useRef(false);
  const queuedLevelRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopMotion = () => {
      if (!reduced.matches) return;
      shapeAnimationRef.current?.cancel();
      fastAnimationsRef.current.forEach(animation => animation.cancel());
    };
    reduced.addEventListener("change", stopMotion);
    return () => {
      mountedRef.current = false;
      queuedLevelRef.current = null;
      shapeAnimationRef.current?.cancel();
      fastAnimationsRef.current.forEach(animation => animation.cancel());
      reduced.removeEventListener("change", stopMotion);
    };
  }, []);

  useLayoutEffect(() => {
    const enabled = fastOn && !previousFastRef.current;
    previousFastRef.current = fastOn;
    fastAnimationsRef.current.forEach(animation => animation.cancel());
    fastAnimationsRef.current = [];
    if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const icon of [faceBoltRef.current, popupBoltRef.current]) {
      if (!icon) continue;
      fastAnimationsRef.current.push(icon.animate([
        { transform: "translateY(1px) scale(.88) rotate(-8deg)", opacity: .55 },
        { transform: "translateY(-1px) scale(1.12) rotate(3deg)", opacity: 1, offset: .38 },
        { transform: "none", opacity: 1 },
      ], { duration: 340, easing: "cubic-bezier(.22, .61, .36, 1)" }));
    }
  }, [fastOn]);

  useEffect(() => {
    if (!open || disabled) {
      draggingRef.current = null;
      setDragPosition(null);
    }
    if (disabled) queuedLevelRef.current = null;
  }, [open, disabled]);

  const normalized = value ?? "";
  const effectiveLevel = normalized || defaultValue || "";
  const faceLabel = effectiveLevel ? levelLabel(effectiveLevel) : defaultLabel;
  // Inheritance uses the effective mode's existing stop, never an extra option.
  const levels = supportedLevels.filter(Boolean);
  const stepCount = levels.length;
  const displayedLevel = pendingLevel ?? effectiveLevel;
  const rawIndex = stepCount > 0 ? levels.indexOf(displayedLevel) : -1;
  const activeIndex = rawIndex >= 0 ? rawIndex : 0;
  const previewIndex = draggingRef.current?.moved ? draggingRef.current.index : activeIndex;
  // Prefer the session face label so a stale value (not in current levels) still echoes correctly.
  const previewLevel = draggingRef.current?.moved ? levels[previewIndex] : displayedLevel;
  const currentStepLabel = previewLevel ? levelLabel(previewLevel) : defaultLabel;
  const fastTitle = `${t("chat.fastLabel")} — ${t("chat.fastQuotaHint")}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(288, window.innerWidth - 36);
      setPopupStyle({
        position: "fixed",
        left: Math.max(18, Math.min(rect.left, window.innerWidth - width - 18)),
        bottom: Math.max(18, window.innerHeight - rect.top + 8),
        maxHeight: Math.max(0, rect.top - 26),
        width,
      });
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);

  if (stepCount === 0 && !fastCapable) return null;

  // Keep the thumb responsive while a session patch is pending. Serialize final
  // choices and coalesce rapid repeats so an older reply cannot win the race.
  const commitLevel = async (level: string) => {
    if (level === displayedLevel) return;
    setPendingLevel(level);
    queuedLevelRef.current = level;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (mountedRef.current && queuedLevelRef.current !== null) {
        const next = queuedLevelRef.current;
        queuedLevelRef.current = null;
        await onChangeThinking(next);
      }
    } catch {
      // The caller owns save errors; restore the last confirmed session value.
      queuedLevelRef.current = null;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setPendingLevel(null);
    }
  };

  const pointerPosition = (clientX: number, offset = 0) => {
    const track = trackRef.current;
    if (!track || stepCount <= 1) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - offset - rect.left) / rect.width)) : 0;
  };

  // The same leading-edge / trailing-shape motion as PillTabs and NavActiveBlob,
  // capped for a 12px dot: position never overshoots the chosen stop.
  const animateLiquidThumb = (index: number) => {
    const fill = thumbFillRef.current;
    const thumb = thumbRef.current?.getBoundingClientRect();
    const track = trackRef.current?.getBoundingClientRect();
    if (!fill || !thumb || !track || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const distance = track.left + (stepCount <= 1 ? 0 : index / (stepCount - 1)) * track.width - (thumb.left + thumb.width / 2);
    const from = getComputedStyle(fill).transform;
    shapeAnimationRef.current?.cancel();
    const stretch = Math.min(Math.abs(distance) * .32, 6) / 12;
    fill.style.transformOrigin = distance >= 0 ? "right center" : "left center";
    shapeAnimationRef.current = fill.animate([
      { transform: from },
      { transform: `scaleX(${1 + stretch}) scaleY(${1 - stretch * .24})`, offset: .19 },
      { transform: "scale(1)" },
    ], { duration: 330, easing: "ease-in-out" });
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || stepCount === 0 || draggingRef.current || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const thumb = !!thumbRef.current?.contains(event.target as Node);
    const rect = thumbRef.current?.getBoundingClientRect();
    // The generous grab halo must not introduce a half-step pointer offset.
    const offset = thumb && rect ? Math.max(-6, Math.min(6, event.clientX - (rect.left + rect.width / 2))) : 0;
    draggingRef.current = { pointerId: event.pointerId, startX: event.clientX, offset, thumb, moved: false, index: activeIndex };
    event.currentTarget.setPointerCapture(event.pointerId);
    shapeAnimationRef.current?.cancel();
    setAnimateThumb(true);
    if (thumb) setDragPosition(pointerPosition(event.clientX, offset));
  };

  const onTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    drag.moved ||= Math.abs(delta) >= 3;
    if (drag.moved) {
      const position = pointerPosition(event.clientX, drag.offset);
      // A quarter-step toward a neighbour is enough. Apply the same generous
      // target during preview and release, rather than changing it on lift.
      const bias = drag.thumb && Math.abs(delta) >= 3 ? Math.sign(delta) * .25 : 0;
      const target = position * Math.max(0, stepCount - 1) + bias;
      const index = bias < 0 ? Math.ceil(target - .5) : Math.floor(target + .5);
      drag.index = Math.max(0, Math.min(stepCount - 1, index));
      setDragPosition(position);
    }
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    draggingRef.current = null;
    setDragPosition(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && !disabled) {
      const index = drag.moved ? drag.index : Math.round(pointerPosition(event.clientX) * Math.max(0, stepCount - 1));
      // A tap on the resting thumb preserves inheritance. A click that
      // interrupts its travel still selects the point under the pointer.
      if (drag.moved || !drag.thumb || index !== activeIndex) {
        animateLiquidThumb(index);
        void commitLevel(levels[index] ?? "");
      }
    }
  };

  const fillPct = (dragPosition ?? (stepCount <= 1 ? 0 : activeIndex / (stepCount - 1))) * 100;

  return (
    <span className="chat-think-fast-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName} chat-pill--think-fast${fastOn ? " is-fast" : ""}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${t("chat.effortLabel")}: ${faceLabel}${fastOn ? ` · ${t("chat.fastLabel")}` : ""}`}
      >
        {fastOn && <span className="chat-pill--think-fast__bolt" aria-hidden="true"><BoltIcon iconRef={faceBoltRef} /></span>}
        <span className="chat-pill--think-fast__label">{faceLabel}</span>
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          className={menuDark ? "think-fast-menu think-fast-menu--dark" : "think-fast-menu"}
          style={popupStyle}
          role="dialog"
          aria-label={t("chat.effortLabel")}
        >
          <div className="think-fast-menu__top">
            <div className="think-fast-menu__level">
              <BrainIcon />
              <span className="think-fast-menu__level-label">{currentStepLabel}</span>
            </div>
            {fastCapable && (
              <button
                type="button"
                className={fastOn ? "think-fast-menu__fast-btn is-on" : "think-fast-menu__fast-btn"}
                role="switch"
                aria-checked={fastOn}
                aria-pressed={fastOn}
                aria-label={t("chat.fastLabel")}
                title={fastTitle}
                disabled={disabled}
                onClick={() => onChangeFast(!fastOn)}
              >
                <BoltIcon iconRef={popupBoltRef} />
              </button>
            )}
          </div>
          {stepCount > 0 && (
            <div className="think-fast-menu__effort">
              <div
                ref={trackRef}
                className="think-fast-menu__slider"
                data-dragging={dragPosition !== null || undefined}
                data-animate={animateThumb || undefined}
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, stepCount - 1)}
                aria-valuenow={previewIndex}
                aria-valuetext={currentStepLabel}
                aria-label={t("chat.effortLabel")}
                aria-disabled={disabled || undefined}
                onPointerDown={onTrackPointerDown}
                onPointerMove={onTrackPointerMove}
                onPointerUp={(event) => finishDrag(event, true)}
                onPointerCancel={(event) => finishDrag(event, false)}
                onLostPointerCapture={(event) => finishDrag(event, false)}
                onKeyDown={(event) => {
                  if (disabled || stepCount === 0 || draggingRef.current) return;
                  let next = activeIndex;
                  if (event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "Home") {
                    event.preventDefault();
                    next = event.key === "Home" ? 0 : Math.max(0, activeIndex - 1);
                  } else if (event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "End") {
                    event.preventDefault();
                    next = event.key === "End" ? stepCount - 1 : Math.min(stepCount - 1, activeIndex + 1);
                  } else {
                    return;
                  }
                  shapeAnimationRef.current?.cancel();
                  setAnimateThumb(false);
                  const level = levels[next] ?? "";
                  void commitLevel(level);
                }}
              >
                <div className="think-fast-menu__track" />
                <div className="think-fast-menu__dots" aria-hidden="true">
                  {levels.map((lvl, i) => (
                    <i key={`${lvl || "default"}-${i}`} />
                  ))}
                </div>
                <div
                  className="think-fast-menu__thumb-position"
                  style={{ transform: `translateX(${fillPct}%)` }}
                  aria-hidden="true"
                >
                  <div ref={thumbRef} className="think-fast-menu__thumb">
                    <span ref={thumbFillRef} className="think-fast-menu__thumb-fill" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
