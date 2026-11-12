import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import FusionLoader from "./FusionLoader";
import styles from "./ChatLiveActivityBubble.module.css";

export interface ChatLiveActivityBubbleProps {
  preview: ReactNode;
  onOpen?: () => void;
  className: string;
  glass?: boolean;
  activityPhase?: string;
}

export default function ChatLiveActivityBubble({ preview, onOpen, className, glass, activityPhase }: ChatLiveActivityBubbleProps) {
  const { t } = useTranslation();
  const timelineRef = useRef<HTMLDivElement>(null);
  const hasActivity = !!preview;

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const bubble = timeline?.parentElement;
    if (!hasActivity || !timeline || !bubble) return;
    const measure = () => {
      const height = `${timeline.offsetHeight}px`;
      if (bubble.style.getPropertyValue("--activity-height") !== height) bubble.style.setProperty("--activity-height", height);
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    observer.observe(timeline);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hasActivity]);

  return (
    <div className={`${className} ${hasActivity ? "is-activity-loading" : "is-streaming"} ${styles.bubble}`}
      data-live-activity-bubble={hasActivity ? "activity" : "waiting"} data-glass-panel={glass || undefined} data-activity-phase={activityPhase}
      onClick={onOpen && (event => {
        if (event.target instanceof Element && !event.target.closest("[data-chat-activity-preview]")) onOpen();
      })}>
      <div className={styles.indicator}>
        <FusionLoader size="sm" ariaLabel={t("chat.liveStatus.running")} preserveBallEdges />
      </div>
      <div className={styles.timeline} ref={timelineRef}>{preview}</div>
    </div>
  );
}
