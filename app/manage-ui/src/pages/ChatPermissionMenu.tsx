import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ChatPermissionModeOption } from "../types";
import "./ChatPermissionMenu.css";

export default function ChatPermissionMenu({
  options,
  activeMode,
  onSelect,
  disabled = false,
  triggerClassName = "chat-pill",
  appearance = "default",
}: {
  options: ChatPermissionModeOption[];
  activeMode: string;
  onSelect: (option: ChatPermissionModeOption) => void;
  disabled?: boolean;
  triggerClassName?: string;
  appearance?: "default" | "dark";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({});
  const active = options.find((option) => option.id === activeMode) || options[0];

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

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      popupRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 36);
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

  if (!active || options.length === 0) return null;
  return (
    <span className="chat-permission-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName} chat-pill--permission`}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("chat.permissionMode")}: ${active.label}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" />
          <path d="m9.5 12 1.7 1.7 3.5-4" />
        </svg>
        <span className="chat-pill--permission__label">{active.label}</span>
      </button>
      {open && createPortal(
        <div ref={popupRef} className={appearance === "dark" ? "permission-menu permission-menu--dark" : "permission-menu"} style={popupStyle} role="menu" aria-label={t("chat.permissionMode")}>
          <div className="permission-menu__title">{t("chat.permissionMode")}</div>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === active.id}
              className={option.id === active.id ? "permission-menu__item is-active" : "permission-menu__item"}
              data-risk={option.risk}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                if (option.id !== active.id) onSelect(option);
              }}
            >
              <span className="permission-menu__copy">
                <span className="permission-menu__name">{option.label}</span>
                {option.description && <span className="permission-menu__description">{option.description}</span>}
              </span>
              {option.id === active.id && <span className="permission-menu__check">✓</span>}
            </button>
          ))}
          <div className="permission-menu__foot">{t("chat.permissionAppliesNextTurn")}</div>
        </div>,
        document.body,
      )}
    </span>
  );
}
