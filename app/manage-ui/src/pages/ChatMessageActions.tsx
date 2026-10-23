import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

// Temporarily hide message pinning in every chat view; keep saved pins for later.
export const MESSAGE_PINNING_ENABLED = false;

export function IconCopy() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" />
  </svg>;
}
export function IconPin() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 16v5" />
  </svg>;
}
export function IconTrash() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
  </svg>;
}
function IconFilter() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h16l-6 8v6l-4-2v-4z" />
  </svg>;
}
function IconQuote() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 14L4 9l5-5M4 9h11a5 5 0 015 5v4" />
  </svg>;
}

/** The same bubble actions and keyboard behavior in direct and group chats. */
export function ChatMessageContextMenu({ x, y, onClose, onCopy, onQuote, quoteDisabled, onPin, pinned, onDelete, extra }: {
  x: number; y: number; onClose(): void;
  onCopy?: () => void; onQuote?: () => void; quoteDisabled?: boolean;
  onPin?: () => void; pinned?: boolean; onDelete?: () => void; extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y });
  const [keyboard, setKeyboard] = useState(false);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    const previous = document.activeElement;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [x, y]);
  useEffect(() => {
    const dismiss = () => closeRef.current();
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, []);
  const select = (action: () => void) => { onClose(); action(); };
  return createPortal(<>
    <div className="chat-ctxmenu__backdrop" onClick={onClose} onWheel={onClose}
      onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div ref={ref} className="chat-ctxmenu" role="menu" data-message-menu="" data-keyboard={keyboard || undefined} style={position} onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setKeyboard(true);
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {onCopy && <button type="button" role="menuitem" className="chat-ctxmenu__item" onClick={() => select(onCopy)}><IconCopy /><span>{t("chat.copy")}</span></button>}
      {onQuote && <button type="button" role="menuitem" className="chat-ctxmenu__item" disabled={quoteDisabled} onClick={() => select(onQuote)}><IconQuote /><span>{t("chat.quote")}</span></button>}
      {extra}
      {MESSAGE_PINNING_ENABLED && onPin && <button type="button" role="menuitem" className="chat-ctxmenu__item" onClick={() => select(onPin)}><IconPin /><span>{t(pinned ? "chat.unpin" : "chat.pin")}</span></button>}
      {onDelete && <button type="button" role="menuitem" className="chat-ctxmenu__item is-danger" onClick={() => select(onDelete)}><IconTrash /><span>{t("chat.deleteLocal")}</span></button>}
    </div>
  </>, document.body);
}

export function ChatPinnedMessages({ items, index, onIndex, onJump, onUnpin, pinnedOnly, onToggle }: {
  items: readonly { id: string; text: string }[]; index: number; onIndex(index: number): void;
  onJump(id: string): void; onUnpin(id: string): void; pinnedOnly: boolean; onToggle(): void;
}) {
  const { t } = useTranslation();
  if (!MESSAGE_PINNING_ENABLED || !items.length) return null;
  const selected = Math.min(index, items.length - 1), item = items[selected];
  return <div className="chat-pinbar">
    <button type="button" className="chat-pinbar__jump" title={t("chat.jumpToPinned")} onClick={() => onJump(item.id)}>
      <span className="chat-pinbar__ico"><IconPin /></span><span className="chat-pinbar__text">{item.text}</span>
    </button>
    {items.length > 1 && <>
      <span className="chat-pinbar__count">{selected + 1}/{items.length}</span>
      <span className="chat-pinbar__nav">
        <button type="button" title={t("chat.prevPin")} disabled={selected === 0} onClick={() => onIndex(selected - 1)}>▲</button>
        <button type="button" title={t("chat.nextPin")} disabled={selected === items.length - 1} onClick={() => onIndex(selected + 1)}>▼</button>
      </span>
    </>}
    <button type="button" className="chat-pinbar__x" title={t("chat.unpin")} onClick={() => onUnpin(item.id)}>×</button>
    <button type="button" className={pinnedOnly ? "chat-pinbar__toggle is-active" : "chat-pinbar__toggle"}
      title={t(pinnedOnly ? "chat.showAll" : "chat.showPinnedOnly")} aria-pressed={pinnedOnly} onClick={onToggle}><IconFilter /></button>
  </div>;
}
