import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import FilterTabs from "../components/FilterTabs";
import { SESSION_CATEGORY_ORDER, sessionCategoryOf, type SessionCategory, type SessionCategoryRow } from "../lib/sessionKind";

export interface SessionMenuRow extends SessionCategoryRow {
  /** 已算好的显示名（friendlySessionLabel）。 */
  title: string;
  /** 最近消息仅参与搜索，不在单行列表中显示。 */
  sub: string;
  /** 已格式化的相对时间（"3m" / "2026/7/20"），空串 = 不显示。 */
  time: string;
  /** `time` 对应的时间戳——列表排序用它，做到「显示什么时间就按什么排」。 */
  ts: number;
}

// 会话切换器：把 header 里那个原生 <select> 换成模型菜单同款弹层——
// 头部 = 搜索框 + 按会话类型分的 FilterTabs，列表按时间倒序、单行显示。
//
// R266 起会话不再按类型隐藏（cron/子代理/dream/心跳过去被整片抹掉，导致工作板
// 「运行」跳过来的 subagent 会话在 UI 里根本无处可寻），改为全量显示 + Tab 分流。
//
// 皮肤直接复用模型菜单的 `.model-menu*`（同一个弹层语言，避免第二份重复 CSS——
// R264 刚清掉过一轮），只加 `.session-menu` 一个修饰类改定位：模型菜单从
// composer 向上弹，这个从 header 向下弹。
export default function ChatSessionMenu({
  sessions,
  activeKey,
  onSelect,
}: {
  sessions: SessionMenuRow[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // null = 全部；否则只显示该类型。与搜索框叠加生效。
  const [kindFilter, setKindFilter] = useState<SessionCategory | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>();

  // 头部在窄窗口会换到第二行，按实际锚点约束浮层，四边留白不会被视口裁掉。
  useLayoutEffect(() => {
    if (!open) return;
    const position = (event?: Event) => {
      if (event?.target instanceof Node && rootRef.current?.contains(event.target)) return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(520, window.innerWidth - 64);
      const left = Math.max(32, Math.min(rect.left, window.innerWidth - width - 32));
      setPopupStyle({ width, left: left - rect.left, maxHeight: Math.max(0, window.innerHeight - rect.bottom - 40) });
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);

  // 关闭时清空筛选；打开后接管外部点击与 Escape（与模型菜单同一套收尾）。
  useEffect(() => {
    if (!open) {
      setQuery("");
      setKindFilter(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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

  // 打开时把当前会话滚到列表中间（会话多时选中项多半在视口外）。手动算滚动量而非
  // scrollIntoView（后者会连带滚动页面级祖先），不做 smooth。
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
  }, [open, sessions.length]);

  const active = sessions.find((s) => s.key === activeKey);
  const kindOf = useMemo(() => {
    const m = new Map<string, SessionCategory>();
    for (const s of sessions) m.set(s.key, sessionCategoryOf(s));
    return m;
  }, [sessions]);

  // Tab 行只列**真实存在**的类型（自动分 Tab），顺序固定，各带条数。不随搜索词
  // 变化，避免打字时 Tab 抖动。
  const kinds = useMemo(() => {
    const count = new Map<SessionCategory, number>();
    for (const s of sessions) {
      const k = kindOf.get(s.key) ?? "other";
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    return SESSION_CATEGORY_ORDER.filter((k) => count.has(k)).map((k) => ({ kind: k, count: count.get(k) ?? 0 }));
  }, [sessions, kindOf]);

  // 搜索 + Tab 筛选后的行。**不分组**：「全部」就是一条按时间倒序的流水（分类交给
  // Tab，列表里再切一次分组标题反而把最近的会话推到看不见的地方）；选中某个 Tab 时
  // 列表本来就只剩那一类，标题=Tab 名纯属重复，同样不显示。
  // 排序用 ts（= 行上显示的那个时间），显示什么时间就按什么排，不会出现视觉乱序。
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = sessions.filter((s) => {
      if (q && !`${s.title} ${s.sub} ${s.key}`.toLowerCase().includes(q)) return false;
      return !kindFilter || (kindOf.get(s.key) ?? "other") === kindFilter;
    });
    return rows.slice().sort((a, b) => b.ts - a.ts);
  }, [sessions, query, kindFilter, kindOf]);

  return (
    <div className="chat-session-menu" ref={rootRef}>
      <button
        type="button"
        className="chat-session-select"
        onClick={() => setOpen((o) => !o)}
        title={t("chat.switchAgentSession")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active?.title || t("chat.switchAgentSession")}
        {active?.time ? ` · ${active.time}` : ""}
      </button>
      {open && (
        <div className="model-menu session-menu" style={popupStyle} role="listbox" aria-label={t("chat.switchAgentSession")}>
          <div className="model-menu__head">
            <input
              className="model-menu__search"
              placeholder={t("chat.sessionSearchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {kinds.length > 1 && (
              <FilterTabs
                className="model-menu__tabs"
                ariaLabel={t("chat.switchAgentSession")}
                scrollable
                toggleOff=""
                value={kindFilter ?? ""}
                onChange={(v) => setKindFilter(v === "" ? null : (v as SessionCategory))}
                items={[
                  { value: "", label: t("chat.sessionFilterAll", { count: sessions.length }) },
                  ...kinds.map((k) => ({
                    value: k.kind,
                    label: `${t(`chat.sessionFilter.${k.kind}`)} ${k.count}`,
                    title: t(`chat.sessionFilter.${k.kind}`),
                  })),
                ]}
              />
            )}
          </div>
          <div className="model-menu__list" ref={listRef}>
            {visible.length === 0 && <div className="model-menu__empty">{t("chat.noSessionMatch")}</div>}
            {visible.map((s) => {
              const isActive = s.key === activeKey;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={isActive ? "model-menu__item is-active" : "model-menu__item"}
                  onClick={() => {
                    onSelect(s.key);
                    setOpen(false);
                  }}
                  title={s.key}
                >
                  {/* 类型标记（"任务" / "灵感便签" …）：不分组之后，这是一条会话属于哪一类的
                      唯一线索——排在名字前面，一眼扫得出流水里混着什么。筛到某个 Tab 时整列
                      同类，标记纯属重复，撤掉把宽度让给标题。 */}
                  {!kindFilter && (
                    <span className="session-menu__kind">{t(`chat.sessionFilter.${kindOf.get(s.key) ?? "other"}`)}</span>
                  )}
                  <span className="model-menu__name session-menu__name">
                    <span className="session-menu__title">{s.title}</span>
                  </span>
                  {s.time && <span className="model-menu__price">{s.time}</span>}
                  {isActive && <span className="model-menu__check">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
