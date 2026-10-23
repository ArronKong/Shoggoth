import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getBundledPlugins, getPluginCatalogPage, type PluginCatalogItem } from "../api/client";
import { useComposerPopupPosition } from "../lib/useComposerPopupPosition";
import { IconPlugin, IconSearch } from "./chatIcons";
import "./ChatModelMenu.css";
import styles from "./ChatPluginPicker.module.css";

export type ChatPluginSelection = { installationId: string; revision: number };

const MAX_SELECTED = 4;
const RECENT_KEY = "shoggoth.chat.plugins.recent.v1";
const ready = (item: PluginCatalogItem) => item.desiredState === "enabled"
  && item.components.some(component => component.state === "ready");
function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  } catch { return []; }
}

export default function ChatPluginPicker({ sessionKey, backendId, selected, onChange, onBrowse,
  onSelectionValidity, selectionSupported = false, selectionChecking = false, onRetryReadiness }: {
  sessionKey: string | null;
  backendId: string;
  selectionSupported?: boolean;
  selectionChecking?: boolean;
  onRetryReadiness?: () => void;
  selected: ChatPluginSelection[];
  onChange: (next: ChatPluginSelection[]) => void;
  onBrowse: (installationId?: string) => void;
  onSelectionValidity?: (key: string, backend: string,
    selection: ChatPluginSelection[], valid: boolean | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PluginCatalogItem[]>([]);
  const [icons, setIcons] = useState<Map<string, string>>(new Map());
  const [adapterGaps, setAdapterGaps] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [catalogKey, setCatalogKey] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [recent, setRecent] = useState(readRecent);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popupStyle = useComposerPopupPosition(open, rootRef, popupRef);

  useEffect(() => { setOpen(false); setQuery(""); }, [sessionKey, backendId]);
  useEffect(() => { if (selectionSupported !== true) setOpen(false); }, [selectionSupported]);
  useEffect(() => {
    if ((!open && selected.length === 0) || !sessionKey || selectionSupported !== true) return;
    let canceled = false;
    setLoading(true); setError(false);
    void (async () => {
      try {
        const all: PluginCatalogItem[] = [];
        let cursor = 0;
        let revision: string | null = null;
        for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
          const page = await getPluginCatalogPage("shoggoth", cursor, 20, revision);
          if (!page.supported || !page.catalogRevision) throw new Error("catalog unavailable");
          if (revision !== null && page.catalogRevision !== revision) throw new Error("catalog changed");
          revision = page.catalogRevision;
          all.push(...page.items);
          if (page.nextCursor === null) break;
          if (page.nextCursor <= cursor || pageIndex === 99) throw new Error("catalog pagination invalid");
          cursor = page.nextCursor;
        }
        const bundled = await getBundledPlugins().catch(() => null);
        if (canceled) return;
        setItems(all);
        setCatalogKey(`${backendId}\0${sessionKey}`);
        setIcons(new Map((bundled?.items ?? []).filter(item => item.iconAvailable)
          .map(item => [item.installationId, item.id])));
        setAdapterGaps(new Set((bundled?.items ?? []).filter(item =>
          item.components.apps > 0 || item.unconvertedMcp.length > 0)
          .map(item => item.installationId)));
      } catch {
        if (!canceled) setError(true);
      } finally { if (!canceled) setLoading(false); }
    })();
    return () => { canceled = true; };
  }, [open, selected.length, sessionKey, backendId, selectionSupported]);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const visible = useMemo(() => items.filter(item => {
    if (!item.components.length) return false;
    const phrase = `${item.packageName} ${item.components.map(component => component.title).join(" ")}`.toLowerCase();
    return phrase.includes(query.trim().toLowerCase());
  }).sort((a, b) => {
    if (query.trim()) return 0;
    const ai = recent.indexOf(a.installationId), bi = recent.indexOf(b.installationId);
    return (ai < 0 ? 1000 : ai) - (bi < 0 ? 1000 : bi);
  }), [items, query, recent]);
  const byId = useMemo(() => new Map(items.map(item => [item.installationId, item])), [items]);
  const catalogCurrent = selectionSupported === true && catalogKey === `${backendId}\0${sessionKey}` && !loading && !error;
  const staleSelection = catalogCurrent && selected.some(value => {
    const item = byId.get(value.installationId);
    return !item || item.revision !== value.revision || !ready(item);
  });
  useEffect(() => {
    if (sessionKey) onSelectionValidity?.(sessionKey, backendId, selected,
      selected.length && catalogCurrent ? !staleSelection : null);
  }, [sessionKey, backendId, selected, catalogCurrent, staleSelection, onSelectionValidity]);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const toggle = (item: PluginCatalogItem) => {
    if (!ready(item)) return;
    const exists = selected.some(value => value.installationId === item.installationId);
    if (!exists && selected.length >= MAX_SELECTED) { setLimitReached(true); return; }
    setLimitReached(false);
    if (!exists) {
      const nextRecent = [item.installationId, ...recent.filter(id => id !== item.installationId)].slice(0, 16);
      setRecent(nextRecent);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(nextRecent)); } catch { /* storage disabled */ }
    }
    onChange(exists ? selected.filter(value => value.installationId !== item.installationId)
      : [...selected, { installationId: item.installationId, revision: item.revision }]);
  };
  return <div ref={rootRef} className={styles.root} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); close(); }
  }}>
    <div className={styles.inline}>
      <button ref={triggerRef} type="button" className="chat-pill chat-pill--select chat-pill--icon-label chat-pill--plugin" aria-expanded={open}
        aria-haspopup="dialog" disabled={!sessionKey || selectionSupported !== true}
        title={selectionSupported === true ? t("chat.pluginPickerHint")
          : t(selectionChecking ? "chat.pluginSelectionChecking" : "chat.pluginPickerHostPending")}
        onClick={() => setOpen(value => !value)}>
        <span className="chat-pill__icon" aria-hidden="true"><IconPlugin /></span>
        <span className="chat-pill__label">{t("chat.pluginPicker")}{selected.length ? ` · ${selected.length}` : ""}</span>
      </button>
      {sessionKey && selectionSupported !== true && onRetryReadiness && <button type="button"
        className={styles.retry} disabled={selectionChecking} onClick={onRetryReadiness}
        aria-label={t("chat.pluginSelectionRetry")} title={t("chat.pluginPickerHostPending")}>
        {t(selectionChecking ? "chat.pluginSelectionChecking" : "chat.pluginSelectionRetry")}
      </button>}
      {selected.map(value => {
        const item = byId.get(value.installationId);
        return <span className={styles.chip} key={value.installationId}>
          {item?.packageName ?? value.installationId}
          <button type="button" aria-label={t("chat.pluginRemove", { name: item?.packageName ?? value.installationId })}
            onClick={() => onChange(selected.filter(row => row.installationId !== value.installationId))}>×</button>
        </span>;
      })}
    </div>
    {staleSelection && <p className={styles.stale} role="alert">{t("chat.pluginSelectionStale")}</p>}
    {open && <div ref={popupRef} className={`${styles.panel} chat-plugin-menu chat-composer-menu-surface`}
      style={popupStyle} role="dialog" aria-label={t("chat.pluginPickerTitle")}>
      <div className={styles.heading}><strong>{t("chat.pluginPickerTitle")}</strong>
        <button type="button" className={styles.close} onClick={close} aria-label={t("common.close")}>×</button>
      </div>
      <p className={styles.hint}>{t("chat.pluginPickerHint")}</p>
      <div className="model-menu__search-field">
        <span className="model-menu__search-icon" aria-hidden="true"><IconSearch /></span>
        <input ref={searchRef} type="search" className="model-menu__search" value={query}
          aria-label={t("chat.pluginSearch")}
          onChange={event => setQuery(event.target.value)} placeholder={t("chat.pluginSearch")} />
      </div>
      {loading && <p className={styles.state} role="status">{t("plugins.loading")}</p>}
      {error && <p className={styles.state} role="status">{t("chat.pluginCatalogError")}</p>}
      {!loading && !error && <div className={styles.list}>
        {visible.length === 0 && <p className={styles.state}>{t("chat.pluginNoInstalled")}</p>}
        {visible.map(item => {
          const checked = selected.some(value => value.installationId === item.installationId);
          const icon = icons.get(item.installationId);
          const needsPermission = item.components.some(component => component.state === "permission_required");
          const needsConnection = item.components.some(component => component.state === "connection_required");
          const needsSecret = item.components.some(component => component.state === "secret_required");
          const canPrepare = needsPermission || needsConnection || needsSecret;
          return <div className={styles.itemRow} key={item.installationId}><label className={styles.item}>
            {icon ? <img src={`/__api/plugins/bundled-icon/${encodeURIComponent(icon)}`} alt="" />
              : <span className={styles.iconFallback} aria-hidden="true" />}
            <span className={styles.itemText}><strong>{item.packageName}{recent.includes(item.installationId) && !query.trim()
              ? <em className={styles.recent}>{t("chat.pluginRecent")}</em> : null}</strong>
              <small>{item.desiredState !== "enabled" ? t("chat.pluginDisabled")
                : ready(item) ? `${t("chat.pluginComponentCount", {
                  ready: item.components.filter(component => component.state === "ready").length,
                  total: item.components.length,
                })}${adapterGaps.has(item.installationId) ? ` · ${t("chat.pluginPartialGap")}` : ""}`
                  : needsPermission ? t("chat.pluginPermissionRequired")
                    : needsConnection ? t("chat.pluginConnectionRequired")
                      : needsSecret ? t("chat.pluginSecretRequired")
                        : t("chat.pluginUnavailable")}</small></span>
            <input type="checkbox" checked={checked} disabled={!ready(item)}
              onChange={() => toggle(item)} />
          </label>{item.desiredState === "enabled" && !ready(item) && <button type="button"
            className={styles.prepare} onClick={() => { close(); onBrowse(item.installationId); }}>
            {t(canPrepare ? "chat.pluginPrepare" : "chat.pluginViewStatus")}</button>}</div>;
        })}
      </div>}
      {limitReached && <p className={styles.state} role="alert">{t("chat.pluginMaxSelected")}</p>}
      <button type="button" className={styles.browse} onClick={() => { close(); onBrowse(); }}>
        {t("chat.pluginBrowse")}
      </button>
    </div>}
  </div>;
}
