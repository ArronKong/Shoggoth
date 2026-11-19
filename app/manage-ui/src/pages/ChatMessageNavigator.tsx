import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import { formatChatTime } from "../lib/chatTime";
import styles from "./ChatMessageNavigator.module.css";

const PAGE_SIZE = 50;
const MARK_PITCH = 14 * 2 / 3;

export interface ChatMessageNavigationEntry {
  groupKey: string;
  messageKey: string;
  text: string;
  ts?: number;
  reply?: string;
}

type EntryFocus = { key: string; source: "mark" | "list" };

function entryKey(entry: ChatMessageNavigationEntry) {
  return JSON.stringify([entry.groupKey, entry.messageKey]);
}

function revealFocusedRow(popup: HTMLDivElement) {
  const row = popup.querySelector('[data-chat-nav-row-focus="mark"]');
  if (!row) return;
  const style = getComputedStyle(popup);
  const contentTop = popup.getBoundingClientRect().top + popup.clientTop;
  const top = contentTop + parseFloat(style.paddingTop);
  const bottom = contentTop + popup.clientHeight - parseFloat(style.paddingBottom);
  const bounds = row.getBoundingClientRect();
  if (bounds.top < top || bounds.height > bottom - top) popup.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) popup.scrollTop += bounds.bottom - bottom;
}

export default function ChatMessageNavigator({ entries, threadRef, onSelect, loadEarlier, loadingEarlier, earlierFailed }: {
  entries: ChatMessageNavigationEntry[];
  threadRef: RefObject<HTMLDivElement>;
  onSelect: (entry: ChatMessageNavigationEntry) => boolean;
  loadEarlier?: () => Promise<void>;
  loadingEarlier: boolean;
  earlierFailed: boolean;
}) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const extendedHover = useRef(false);
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [focusedEntry, setFocusedEntry] = useState<EntryFocus | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [layout, setLayout] = useState({ slots: PAGE_SIZE + 1, compact: false });
  const first = Math.max(0, entries.length - shown);
  const visible = useMemo(() => entries.slice(first).map(entry => ({
    entry,
    key: entryKey(entry),
    time: formatChatTime(entry.ts),
  })), [entries, first]);
  const hasMore = entries.length > PAGE_SIZE && (first > 0 || !!loadEarlier);
  const marks = useMemo(() => visible.slice(-Math.max(1, layout.slots - Number(hasMore))), [visible, layout.slots, hasMore]);
  const focusedIndex = focusedEntry === null ? -1 : marks.findIndex(mark => mark.key === focusedEntry.key);

  useLayoutEffect(() => {
    if (popup && focusedEntry?.source === "mark") revealFocusedRow(popup);
  }, [popup, focusedEntry, visible]);

  useLayoutEffect(() => {
    if (!popup) return;
    const observer = new ResizeObserver(() => revealFocusedRow(popup));
    observer.observe(popup);
    return () => observer.disconnect();
  }, [popup]);

  useLayoutEffect(() => {
    const region = regionRef.current;
    const thread = threadRef.current;
    const conversation = thread?.parentElement;
    if (!region || !thread || !conversation) return;
    const header = conversation.querySelector(".chat-topdock");
    const dock = conversation.querySelector(".chat-botdock");
    const pointer = matchMedia("(pointer: coarse)");
    const measure = () => {
      const bounds = thread.getBoundingClientRect();
      const start = Math.max(0, (header?.getBoundingClientRect().bottom ?? bounds.top) - bounds.top) + 8;
      const bottom = parseFloat(getComputedStyle(thread).getPropertyValue("--chat-fade-bottom")) || 0;
      const end = bottom + 8;
      const slots = Math.floor((bounds.height - start - end) / MARK_PITCH);
      region.style.top = `${start}px`;
      region.style.bottom = `${end}px`;
      const compact = pointer.matches || bounds.width < 500 || slots < 2;
      setLayout(current => current.compact === compact && current.slots === slots ? current : { compact, slots });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const target of [thread, header, dock]) if (target) observer.observe(target);
    pointer.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      pointer.removeEventListener("change", measure);
    };
  }, [threadRef]);

  useLayoutEffect(() => {
    const finishHover = () => {
      if (!extendedHover.current) return;
      extendedHover.current = false;
      setOpen(false);
      setFocusedEntry(null);
    };
    if (layout.compact) {
      finishHover();
      return;
    }
    const trigger = triggerRef.current;
    const thread = threadRef.current;
    const content = thread?.closest<HTMLElement>(".content") ?? thread?.parentElement;
    if (!trigger || !thread || !content) return;

    // Observe the right gutter without covering the native scrollbars.
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      const { target, clientX, clientY } = event;
      if (target === thread || target === content) {
        const { right, top, bottom } = trigger.getBoundingClientRect();
        if (clientX >= right && clientX < content.getBoundingClientRect().right && clientY >= top && clientY < bottom) {
          if (!extendedHover.current) {
            extendedHover.current = true;
            setOpen(true);
          }
          const firstMark = trigger.querySelector("[data-chat-nav-mark]")?.getBoundingClientRect();
          const index = firstMark?.height ? Math.floor((clientY - firstMark.top) / firstMark.height) : -1;
          const key = marks[index]?.key;
          setFocusedEntry(current => {
            if (current?.key === key && current?.source === "mark") return current;
            return key === undefined ? null : { key, source: "mark" };
          });
          return;
        }
      }
      if (target instanceof Node && (trigger.contains(target) || popup?.contains(target))) return;
      finishHover();
    };
    const leave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") finishHover();
    };
    content.addEventListener("pointermove", move, { capture: true, passive: true });
    content.addEventListener("pointerleave", leave);
    return () => {
      content.removeEventListener("pointermove", move, true);
      content.removeEventListener("pointerleave", leave);
    };
  }, [layout.compact, marks, popup, threadRef]);

  const changeOpen = (next: boolean, details?: Popover.Root.ChangeEventDetails) => {
    if (!next && extendedHover.current && details?.reason === "trigger-hover") {
      details.cancel();
      return;
    }
    setOpen(next);
    if (!next) {
      extendedHover.current = false;
      const hovered = regionRef.current?.querySelector<HTMLElement>("[data-chat-nav-mark]:hover");
      const key = hovered ? marks[Number(hovered.dataset.chatNavMark)]?.key : undefined;
      setFocusedEntry(key ? { key, source: "mark" } : null);
    }
  };
  const focusByPointer = (event: ReactPointerEvent, key: string | null, source: EntryFocus["source"]) => {
    if (event.pointerType === "mouse") setFocusedEntry(key === null ? null : { key, source });
  };
  const select = (entry: ChatMessageNavigationEntry) => {
    if (onSelect(entry)) changeOpen(false);
  };
  const showEarlier = () => {
    if (first > 0) {
      setShown(Math.min(entries.length, shown + PAGE_SIZE));
    } else if (loadEarlier && !loadingEarlier) {
      setShown(Math.max(shown, entries.length + PAGE_SIZE));
      void loadEarlier();
    }
  };

  return (
    <div className={styles.region} ref={regionRef} style={{ "--chat-nav-mark-pitch": `${MARK_PITCH}px` } as CSSProperties} data-chat-message-navigator>
      <Popover.Root open={open} onOpenChange={changeOpen}>
        <Popover.Trigger ref={triggerRef} type="button" className={layout.compact ? styles.compactTrigger : styles.trigger}
          aria-label={t("chat.messageNavigator")} openOnHover={!layout.compact} delay={80} closeDelay={100}
          data-chat-nav-focused={focusedIndex >= 0 ? "" : undefined}
          onClick={event => {
            if (layout.compact || event.detail === 0 || !(event.target instanceof Element)) return;
            if (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType !== "mouse") return;
            const index = event.target.closest<HTMLElement>("[data-chat-nav-mark]")?.dataset.chatNavMark;
            if (index === undefined) return;
            event.preventBaseUIHandler();
            select(marks[Number(index)].entry);
          }}
        >
          {layout.compact ? t("chat.messageNavigator") : (
            <span className={styles.marks} aria-hidden="true">
              {hasMore && <span className={styles.ellipsis}>⋯</span>}
              {marks.map(({ key }, index) => {
                const distance = focusedIndex < 0 ? Infinity : Math.abs(index - focusedIndex);
                return <span key={key} className={styles.mark} data-chat-nav-mark={index}
                  data-focus-distance={distance <= 3 ? distance : undefined}
                  onPointerEnter={event => focusByPointer(event, key, "mark")}
                  onPointerLeave={event => focusByPointer(event, null, "mark")} />;
              })}
            </span>
          )}
        </Popover.Trigger>
        <Popover.Portal container={regionRef}>
          <Popover.Positioner className={styles.positioner} side={layout.compact ? "bottom" : "left"}
            align={layout.compact ? "end" : "center"} sideOffset={layout.compact ? 6 : 0}
            collisionBoundary={regionRef.current ?? undefined} collisionPadding={8}>
            <Popover.Popup ref={setPopup} className={styles.popup} aria-label={t("chat.messageNavigator")}
              initialFocus={type => !extendedHover.current && type !== "mouse"} data-chat-nav-list>
              {hasMore && <button type="button" className={styles.more} onClick={showEarlier}
                disabled={first === 0 && loadingEarlier} data-chat-nav-more>
                {first === 0 && loadingEarlier ? t("chat.historyLoadingEarlier")
                  : first === 0 && earlierFailed ? t("chat.historyRetryEarlier") : t("chat.messageNavigatorEarlier")}
              </button>}
              <div className={styles.entries}>
                {visible.map(({ entry, key, time }) => (
                  <button type="button" className={styles.entry} key={key} data-chat-nav-row
                    data-chat-nav-row-focus={focusedEntry?.key === key ? focusedEntry.source : undefined}
                    onPointerEnter={event => focusByPointer(event, key, "list")}
                    onPointerLeave={event => focusByPointer(event, null, "list")}
                    onFocus={() => setFocusedEntry({ key, source: "list" })}
                    onBlur={() => setFocusedEntry(null)}
                    onClick={() => select(entry)}>
                    <span className={styles.text}>{entry.text}</span>
                    {time ? <span className={styles.time}>{time}</span> : null}
                    {entry.reply && <span className={styles.reply}>{entry.reply}</span>}
                  </button>
                ))}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
