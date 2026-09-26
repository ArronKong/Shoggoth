import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Liquid } from "liquid-gooey";
import styles from "./LiquidGooeyDemo.module.css";
import pillStyles from "./PillTabs.module.css";

const MORPH_ITEMS = [
  { x: -62, y: -48, labelKey: "componentsGallery.gooeyMorphCreate", icon: "spark" },
  { x: 0, y: -72, labelKey: "componentsGallery.gooeyMorphSearch", icon: "search" },
  { x: 62, y: -48, labelKey: "componentsGallery.gooeyMorphShare", icon: "share" },
] as const;

const TAB_KEYS = [
  "componentsGallery.gooeyTabOverview",
  "componentsGallery.gooeyTabMotion",
  "componentsGallery.gooeyTabPhysics",
] as const;

function MorphIcon({ name }: { name: (typeof MORPH_ITEMS)[number]["icon"] }) {
  if (name === "search") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="4.5" />
        <path d="m12 12 4 4" />
      </svg>
    );
  }
  if (name === "share") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="5" cy="10" r="2" />
        <circle cx="14.5" cy="5" r="2" />
        <circle cx="14.5" cy="15" r="2" />
        <path d="m6.8 9 5.9-3M6.8 11l5.9 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v14M3 10h14" />
    </svg>
  );
}

// 只服务组件展厅：所有状态都随路由卸载重置，不读取业务状态或持久化数据。
export default function LiquidGooeyDemo() {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [switchOn, setSwitchOn] = useState(false);
  const [buttonPressed, setButtonPressed] = useState(false);
  const [indicatorMetrics, setIndicatorMetrics] = useState({ left: 8, top: 8, width: 0, height: 32 });
  const pressTimerRef = useRef<number | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return undefined;
    const updateIndicator = () => {
      const tab = tabRefs.current[activeTab];
      if (!tab) return;
      const tabRect = tab.getBoundingClientRect();
      const next = {
        left: tab.offsetLeft,
        top: tab.offsetTop,
        width: tabRect.width,
        height: tabRect.height,
      };
      setIndicatorMetrics((current) => (
        current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.height === next.height
          ? current
          : next
      ));
    };

    updateIndicator();
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(list);
    tabRefs.current.forEach((tab) => {
      if (tab) observer.observe(tab);
    });
    return () => observer.disconnect();
  }, [activeTab]);

  // Tabs 采用 roving tabindex；方向键更新选择并同步焦点，Tab 键仍正常离开组件。
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = Number(event.currentTarget.dataset.tabIndex);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % TAB_KEYS.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + TAB_KEYS.length) % TAB_KEYS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TAB_KEYS.length - 1;
    else return;

    event.preventDefault();
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  const handlePress = () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    setButtonPressed(true);
    pressTimerRef.current = window.setTimeout(() => {
      setButtonPressed(false);
      pressTimerRef.current = null;
    }, 360);
  };

  return (
    <section className={styles.root} data-gallery="liquid-gooey">
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{t("componentsGallery.gooeyTitle")}</h2>
          <p className={styles.description}>{t("componentsGallery.gooeyDescription")}</p>
        </div>
        <span className={styles.kind}>{t("componentsGallery.gooeyKind")}</span>
      </header>

      <div className={styles.demoGrid}>
        <article className={styles.demoPanel}>
          <div className={styles.demoCopy}>
            <h3>{t("componentsGallery.gooeyMorphTitle")}</h3>
            <p>{t("componentsGallery.gooeyMorphHint")}</p>
          </div>
          <div className={styles.stage}>
            <Liquid
              className={styles.morphGroup}
              blur={8}
              contrast={18}
              fill="var(--gooey-liquid)"
              shadow="0 12px 28px rgba(0, 0, 0, .18)"
              filterPadding={32}
            >
              {MORPH_ITEMS.map((item, index) => (
                <Liquid.Item
                  key={item.labelKey}
                  x={menuOpen ? item.x : 0}
                  y={menuOpen ? item.y : 0}
                  transition="smooth"
                  delay={menuOpen ? index * 32 : (MORPH_ITEMS.length - index - 1) * 20}
                  style={{ position: "absolute", left: 98, top: 78, zIndex: 1 }}
                >
                  <button
                    type="button"
                    className={`${styles.liquidButton} ${styles.satelliteButton}`}
                    aria-label={t(item.labelKey)}
                    tabIndex={menuOpen ? 0 : -1}
                    disabled={!menuOpen}
                  >
                    <MorphIcon name={item.icon} />
                  </button>
                </Liquid.Item>
              ))}

              <Liquid.Item style={{ position: "absolute", left: 98, top: 78, zIndex: 2 }}>
                <button
                  type="button"
                  className={`${styles.liquidButton} ${styles.morphToggle}`}
                  data-gallery="gooey-morph-toggle"
                  aria-label={t("componentsGallery.gooeyMorphToggle")}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <span className={menuOpen ? styles.toggleIconOpen : styles.toggleIcon} aria-hidden="true" />
                </button>
              </Liquid.Item>
            </Liquid>
          </div>
        </article>

        <article className={styles.demoPanel}>
          <div className={styles.demoCopy}>
            <h3>{t("componentsGallery.gooeyMoveTitle")}</h3>
            <p>{t("componentsGallery.gooeyMoveHint")}</p>
          </div>
          <div className={styles.stage}>
            <Liquid
              ref={tabListRef}
              className={`${styles.tabList} ${pillStyles.tabs}`}
              data-gallery="gooey-tabs"
              role="tablist"
              aria-label={t("componentsGallery.gooeyMoveTitle")}
              blur={7}
              contrast={18}
              fill="var(--gooey-liquid)"
              shadow="0 8px 20px rgba(0, 0, 0, .16)"
              filterPadding={8}
            >
              <Liquid.Item
                effect="move"
                move={{ springiness: 0.72, wobble: 0.16, stretch: 0.2, trail: 0.28 }}
              >
                <span
                  className={styles.tabIndicator}
                  style={{
                    width: indicatorMetrics.width,
                    height: indicatorMetrics.height,
                    transform: `translate3d(${indicatorMetrics.left}px, ${indicatorMetrics.top}px, 0)`,
                  }}
                  aria-hidden="true"
                />
              </Liquid.Item>

              {TAB_KEYS.map((key, index) => (
                <button
                  key={key}
                  ref={(node) => { tabRefs.current[index] = node; }}
                  type="button"
                  role="tab"
                  data-tab-index={index}
                  data-gallery={`gooey-tab-${index}`}
                  aria-selected={activeTab === index}
                  tabIndex={activeTab === index ? 0 : -1}
                  className={`${pillStyles.tab}${activeTab === index ? ` ${pillStyles.tabOn}` : ""}`}
                  onClick={() => setActiveTab(index)}
                  onKeyDown={handleTabKeyDown}
                >
                  {t(key)}
                </button>
              ))}
            </Liquid>
          </div>
        </article>

        <article className={`${styles.demoPanel} ${styles.pressPanel}`}>
          <div className={styles.demoCopy}>
            <h3>{t("componentsGallery.gooeyPressTitle")}</h3>
            <p>{t("componentsGallery.gooeyPressHint")}</p>
          </div>
          <div className={styles.stage}>
            <Liquid
              className={styles.pressGroup}
              blur={9}
              contrast={18}
              fill="var(--gooey-liquid)"
              shadow="0 10px 24px rgba(0, 0, 0, .16)"
              filterPadding={32}
            >
              <Liquid.Item
                morph={{ shape: true, speed: 1.35, bounce: 0.22, contentBlur: 0 }}
              >
                <button
                  type="button"
                  data-gallery="gooey-press-button"
                  className={`${styles.pressButton}${buttonPressed ? ` ${styles.pressButtonActive}` : ""}`}
                  onClick={handlePress}
                >
                  {t("componentsGallery.gooeyPressButton")}
                </button>
              </Liquid.Item>
            </Liquid>
          </div>
        </article>

        <article className={styles.demoPanel} data-gallery="gooey-switch-panel">
          <div className={styles.demoCopy}>
            <h3>{t("componentsGallery.gooeySwitchTitle")}</h3>
            <p>{t("componentsGallery.gooeySwitchHint")}</p>
          </div>
          <div className={styles.stage}>
            <button
              type="button"
              className={styles.switchButton}
              aria-label={t("componentsGallery.gooeySwitchLabel")}
              role="switch"
              aria-checked={switchOn}
              onClick={() => setSwitchOn((on) => !on)}
            >
              <Liquid
                className={styles.switchLiquid}
                blur={5}
                contrast={18}
                fill="var(--gooey-liquid)"
                shadow="0 4px 12px rgba(0, 0, 0, .18)"
                filterPadding={8}
              >
                <Liquid.Item
                  effect="move"
                  move={{ springiness: 0.78, wobble: 0.12, stretch: 0.14, trail: 0.18 }}
                >
                  <span
                    className={styles.switchThumb}
                    style={{ transform: `translate3d(${switchOn ? 36 : 0}px, 0, 0)` }}
                  />
                </Liquid.Item>
              </Liquid>
              <span
                className={`${styles.switchState}${switchOn ? ` ${styles.switchStateOn}` : ""}`}
                aria-hidden="true"
              >
                {switchOn
                  ? t("componentsGallery.gooeySwitchOn")
                  : t("componentsGallery.gooeySwitchOff")}
              </span>
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}
