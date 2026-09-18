import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import FilterTabs from "../components/FilterTabs";
import FusionLoader from "../components/FusionLoader";
import "./ChatModelMenu.css";

export interface ModelMenuChoice {
  id: string;
  name: string;
  provider?: string;
  reasoning?: boolean;
  pricing?: { input?: string; output?: string; cache?: string | null; free?: boolean };
}

// 将后端给出的价格字段压缩成菜单里可扫描的短标签。
function priceLabel(m: ModelMenuChoice, t: TFunction): string | null {
  if (m.pricing?.free) return t("models.free");
  if (m.pricing?.input) return `${m.pricing.input}/M`;
  return null;
}

// Composer 模型选择器：用可搜索、按 provider 分组的弹层替换原生 <select>。
// 这里只消费已有 /__api/models 数据，不新增后端依赖或改变模型切换语义。
export default function ChatModelMenu({
  models,
  activeModel,
  activeProvider,
  onSelect,
  disabled,
  loading,
  loadError,
  onRefresh,
  selectedRefs,
  triggerLabel,
  emptyLabel,
  portalInDialog,
}: {
  models: ModelMenuChoice[];
  activeModel: string;
  activeProvider?: string;
  onSelect: (id: string, provider?: string) => void;
  disabled?: boolean;
  loading?: boolean;
  loadError?: boolean;
  onRefresh?: () => void;
  /**
   * 多选模式（Agent 页的 fallback 链）：给一组 "<provider>/<id>" 引用，菜单对每个
   * 命中项打 ✓，点击当作「切换」交给 onSelect，且**点完不关**——可以连选多个。
   * 不传 = 原来的单选行为（聊天页两处调用不受影响）。
   */
  selectedRefs?: string[];
  /** 多选模式下触发钮的固定文案（单选时钮显示当前模型名）。 */
  triggerLabel?: string;
  /** 单选表单可显式回到“继承默认模型”；聊天热切换不传，保持原行为。 */
  emptyLabel?: string;
  /** 表单位于可滚动 Modal 时，把菜单挂到 Dialog 面板，避免被 body overflow 裁掉。 */
  portalInDialog?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // null = 全部；否则只显示该 provider 的模型。与搜索框叠加生效。
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [popupHost, setPopupHost] = useState<HTMLElement | null>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties | undefined>();

  // 打开（或菜单先开、模型后到）时把列表滚到当前选中模型（居中）——长目录里 ✓ 项
  // 多半在视口外，打开即见才对得上「查看/切换当前模型」的心智。手动算滚动量而非
  // scrollIntoView（后者会连带滚动页面级祖先），且不做 smooth（打开瞬间应直接就位）。
  // 只依赖 open/models：用户随后的筛选/搜索不重新定位。
  // 注意【不动 Tab 行】：Tab 是筛选器不是位置指示器——打开时选中的筛选恒为最左的
  // 「全部」，把 Tab 行滚到当前模型的 provider 会把选中态挤出视野（用户实测指出）；
  // 「当前模型属于谁」由列表居中 + 分组标题表达。
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const list = listRef.current;
      const item = list?.querySelector<HTMLElement>(".model-menu__item.is-active");
      if (list && item) {
        const delta = item.getBoundingClientRect().top - list.getBoundingClientRect().top;
        list.scrollTop += delta - (list.clientHeight - item.clientHeight) / 2;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, models.length, popupHost]);

  // Portal 到可滚动 Dialog 后，原生 autoFocus 会为了“露出”输入框而回卷 Modal body，
  // 连带把触发器推到视口外。显式 preventScroll 既保留打开即搜索，也保持菜单定位稳定。
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open, popupHost]);

  // 弹层关闭时清空搜索与 provider 筛选；打开后监听外部点击和 Escape，避免焦点留在过期菜单里。
  useEffect(() => {
    if (!open) {
      setQuery("");
      setProviderFilter(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Modal body 自身滚动；普通 absolute 浮层会被裁掉。只在表单调用方显式要求时，
  // 把同一菜单 portal 到最近的 Dialog panel，并按触发器实时定位。聊天页仍走原 DOM。
  useLayoutEffect(() => {
    if (!open || !portalInDialog) {
      setPopupHost(null);
      setPopupStyle(undefined);
      return;
    }
    const trigger = triggerRef.current;
    const host = trigger?.closest<HTMLElement>("[role=dialog]");
    if (!trigger || !host) return;
    setPopupHost(host);
    const position = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const width = Math.min(440, window.innerWidth * 0.84);
      const preferredHeight = Math.min(440, window.innerHeight * 0.84);
      const viewportGap = 18;
      const popupGap = 8;
      const boundaryTop = Math.max(viewportGap, hostRect.top + viewportGap);
      const boundaryBottom = Math.min(window.innerHeight - viewportGap, hostRect.bottom - viewportGap);
      const spaceAbove = Math.max(0, triggerRect.top - boundaryTop - popupGap);
      const spaceBelow = Math.max(0, boundaryBottom - triggerRect.bottom - popupGap);
      const opensUp = spaceAbove >= preferredHeight || spaceAbove > spaceBelow;
      const height = Math.min(preferredHeight, opensUp ? spaceAbove : spaceBelow);
      const rawLeft = triggerRect.left - hostRect.left;
      const left = Math.max(0, Math.min(rawLeft, hostRect.width - width));
      const top = opensUp
        ? triggerRect.top - hostRect.top - height - popupGap
        : triggerRect.bottom - hostRect.top + popupGap;
      setPopupStyle({ position: "absolute", left, top, bottom: "auto", width, height, zIndex: 200 });
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open, portalInDialog]);

  // 同一个模型 id 可能出现在多个 provider 下（实测 deepseek-v4-flash 同时在
  // deepseek 与 volcengine）。勾选/高亮必须连 provider 一起比；当 activeProvider
  // 与 models 的 provider 口径对不上（无合格命中，如部分后端不带 provider）时退回
  // 纯 id 匹配——宁可保持旧的「都勾」也不要「一个都不勾」。
  const multi = Array.isArray(selectedRefs);
  const selectedSet = useMemo(() => new Set(selectedRefs || []), [selectedRefs]);
  const providerQualified =
    !!activeProvider && models.some((m) => m.id === activeModel && (m.provider || "") === activeProvider);
  const isActiveChoice = (m: ModelMenuChoice) =>
    multi
      ? selectedSet.has(m.provider ? `${m.provider}/${m.id}` : m.id)
      : m.id === activeModel && (!providerQualified || (m.provider || "") === activeProvider);
  const active = models.find((m) => isActiveChoice(m)) ?? models.find((m) => m.id === activeModel);
  const activeLabel = triggerLabel || active?.name || activeModel || t("chat.switchModel");
  const OTHER = t("chat.otherProvider");

  // Tab 行用的 provider 全集：取自全部模型（不随搜索词变化，避免打字时 Tab 抖动）。
  // 顺序与分组一致——字母序、「其他」殿后。
  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) set.add((m.provider || "").trim() || OTHER);
    return [...set].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));
  }, [models, OTHER]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProv = new Map<string, ModelMenuChoice[]>();
    for (const m of models) {
      if (q && !`${m.name} ${m.id}`.toLowerCase().includes(q)) continue;
      const key = (m.provider || "").trim() || OTHER;
      // provider Tab 筛选与搜索框叠加：选中某 provider 时只留该组。
      if (providerFilter && key !== providerFilter) continue;
      const bucket = byProv.get(key);
      if (bucket) bucket.push(m);
      else byProv.set(key, [m]);
    }
    const entries = [...byProv.entries()].sort(([a], [b]) =>
      a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b),
    );
    return entries.map(([provider, items]) => ({ provider, items }));
  }, [models, query, providerFilter, OTHER]);

  return (
    <div className="chat-model-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-pill chat-pill--select chat-pill--model"
        onClick={() => {
          if (!open) onRefresh?.();
          setOpen(!open);
        }}
        disabled={disabled}
        title={activeProvider ? `${activeProvider} / ${activeModel}` : t("chat.switchModel")}
      >
        {activeLabel}
      </button>
      {open && (() => {
        const popup = (
        <div
          className={popupHost ? "model-menu model-menu--portal" : "model-menu"}
          role="listbox"
          aria-label={t("chat.switchModel")}
          ref={popupRef}
          style={popupStyle}
        >
          {/* 不滚动的头部：搜索框 + provider 筛选 Tab。占 grid 第一行(auto)，
              列表始终落在第二行(1fr)滚动——单一滚动条不受 Tab 有无影响。 */}
          <div className="model-menu__head">
            <input
              ref={searchRef}
              className="model-menu__search"
              placeholder={t("chat.modelSearchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {/* 与 Dashboard 活动流筛选同一个组件（FilterTabs）：
                provider 多时横向滚动；再点当前项回落到「全部」（toggleOff=""）。 */}
            {providers.length > 1 && (
              <FilterTabs
                className="model-menu__tabs"
                ariaLabel={t("chat.switchModel")}
                scrollable
                toggleOff=""
                value={providerFilter ?? ""}
                onChange={(v) => setProviderFilter(v === "" ? null : v)}
                items={[
                  { value: "", label: t("chat.modelFilterAll") },
                  ...providers.map((p) => ({ value: p, label: p, title: p })),
                ]}
              />
            )}
          </div>
          <div className="model-menu__list" ref={listRef}>
            {!multi && emptyLabel && (
              <button
                type="button"
                role="option"
                aria-selected={!activeModel}
                className={!activeModel ? "model-menu__item is-active" : "model-menu__item"}
                onClick={() => {
                  onSelect("", undefined);
                  setOpen(false);
                }}
              >
                <span className="model-menu__name">{emptyLabel}</span>
                {!activeModel && <span className="model-menu__check">✓</span>}
              </button>
            )}
            {loading && groups.length > 0 && (
              <div className="model-menu__provisional" role="status">{t("chat.loadingModels")}</div>
            )}
            {!loading && loadError && (
              <div className="model-menu__error" role="alert">
                <span>{t("chat.modelLoadFailed")}</span>
                {onRefresh && <button type="button" onClick={onRefresh}>{t("chat.reloadModels")}</button>}
              </div>
            )}
            {groups.length === 0 && (loading || !loadError) && (
              <div className="model-menu__empty">
                {loading ? <FusionLoader size="sm" label={t("chat.loadingModels")} />
                  : models.length === 0 ? t("chat.modelCatalogEmpty") : t("chat.noModelMatch")}
              </div>
            )}
            {groups.map((g) => (
              <Fragment key={g.provider}>
                <div className="model-menu__label">{g.provider}</div>
                {g.items.map((m) => {
                  const price = priceLabel(m, t);
                  const isActive = isActiveChoice(m);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={isActive ? "model-menu__item is-active" : "model-menu__item"}
                      onClick={() => {
                        onSelect(m.id, m.provider);
                        if (!multi) setOpen(false); // 多选:留着菜单继续挑
                      }}
                      title={m.id}
                    >
                      <span className="model-menu__name">{m.name || m.id}</span>
                      {m.reasoning && <span className="model-menu__tag">{t("common.reasoning")}</span>}
                      {price && <span className="model-menu__price">{price}</span>}
                      {isActive && <span className="model-menu__check">✓</span>}
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
        );
        return popupHost ? createPortal(popup, popupHost) : popup;
      })()}
    </div>
  );
}
