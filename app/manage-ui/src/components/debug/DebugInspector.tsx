// In-app element style inspector. When debug mode is on, Shift+click any element
// to open this panel; edits are written live into a single injected <style> block
// keyed by the element's selector, so ALL matching elements update in real time.
// Edits are ephemeral (gone on reload) — "复制给 AI" copies them out.
//
// Every override is self-describing: class-less nodes get a STRUCTURAL selector
// (nearest classed ancestor + tag + :nth-of-type, e.g. `.kpi-val > span`) instead
// of an opaque id, and the export prefixes each rule with the edited element's
// label (tag + text). So the copied/saved CSS says exactly where each change
// landed — no guessing, and the selectors survive reload/rebuild.
//
// Pure frontend: no backend route, no config-store, no architecture surface. It
// only reads getComputedStyle and writes one <style> element (no DOM mutation).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { catalogFor, inferKind, isCatalogProp, type PropKind } from "./catalog";
import { ScrubNumber } from "./ScrubNumber";
import { ColorField } from "./ColorField";
import { BoxModel } from "./BoxModel";
import { SpacingGap } from "./SpacingGap";
import { RenderedFont } from "./RenderedFont";
import { SizeOrigin } from "./SizeOrigin";
import { canSaveOverridesToSource, saveOverridesToSource } from "./store";
import styles from "./DebugInspector.module.css";

interface Edges {
  t: number;
  r: number;
  b: number;
  l: number;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  mg: Edges; // margin
  bd: Edges; // border widths
  pd: Edges; // padding
}

// A single injected declaration. `imp` is decided per declaration by probing whether
// the plain version actually took effect — never by the user (see setProp).
interface Decl {
  v: string;
  imp: boolean;
}

// Which action button is currently showing its transient confirmation.
type BtnKey = "copy" | "save" | "clear";

// One undoable edit. `prev: undefined` = no override existed before this step.
interface Change {
  selector: string;
  prop: string;
  prev: Decl | undefined;
  next: string;
}

function cssEscape(cls: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(cls) : cls;
}

// A short, human-readable label for an element: tag + a snippet of its own text,
// so an exported rule says WHICH node was edited (e.g. `span · "2.4M"`).
function describeEl(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32);
  return text ? `${tag} · "${text}"` : tag;
}

// Build a stable, self-describing selector for an element with no usable class:
// anchor at the nearest classed ancestor, then pin the node by tag + :nth-of-type.
// Unlike the old ephemeral `data-dbg-id`, this survives reload/rebuild AND tells you
// (or any AI you paste the export into) exactly where the edit landed — no guessing.
function structuralSelector(el: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  for (let hops = 0; node && node !== document.body && hops < 8; hops++) {
    if (node !== el && node.classList.length) {
      parts.unshift("." + cssEscape(node.classList[0]));
      return parts.join(" > ");
    }
    const tag = node.tagName.toLowerCase();
    const parent: HTMLElement | null = node.parentElement;
    const twins = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    node = parent;
  }
  parts.unshift("body");
  return parts.join(" > ");
}

// Copy text to the clipboard, falling back to a hidden textarea + execCommand.
// navigator.clipboard rejects in some webviews (no focus / no permission), and
// the export must not silently fail — copying the tweaks out is the whole point.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function Editor({ kind, value, onChange }: { kind: PropKind; value: string; onChange: (v: string) => void }) {
  if (kind === "color") return <ColorField value={value} onChange={onChange} />;
  // same swatch + picker as a color, but it only rewrites the color inside the value
  if (kind === "shadow") return <ColorField value={value} onChange={onChange} compound />;
  if (kind === "length") return <ScrubNumber value={value} onChange={onChange} defaultUnit="px" step={1} />;
  if (kind === "number") return <ScrubNumber value={value} onChange={onChange} defaultUnit="" step={0.05} />;
  return <input className={styles.scrubInput} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

export default function DebugInspector() {
  const { i18n } = useTranslation();
  // 反馈直接写在按钮里（「已复制」/「已保存」），按钮定宽、到时自动还原原文案。
  // 不用全局 toast：它固定在右上角、z-index 10001，会被本面板（同一角落、
  // z-index 2147483647）整个盖住 —— 那正是「点了没反应」的成因。
  // 也不另插一条提示行：那会把面板撑高、挤动下面的内容。
  // 详细信息（写入路径、失败原因）挂在按钮 title 上，不占版面。
  const [btnMsg, setBtnMsg] = useState<{ key: BtnKey; short: string; detail?: string; err?: boolean } | null>(null);
  const btnTimer = useRef<number | null>(null);

  // Panel-local language, deliberately NOT the app's. The point is the export: the
  // UI can stay in your language while the brief goes out in the one the AI you're
  // pasting into works in. getFixedT pins a language without touching the global
  // one (switching that reloads the window — see SettingsPage).
  const [lang, setLang] = useState<"zh-CN" | "en">(() => (i18n.language === "en" ? "en" : "zh-CN"));
  const t = useMemo(() => i18n.getFixedT(lang), [i18n, lang]);

  const [el, setEl] = useState<HTMLElement | null>(null);
  const [classes, setClasses] = useState<string[]>([]); // classes available on el
  const [active, setActive] = useState<string[]>([]); // toggled classes building the selector
  const [rect, setRect] = useState<Rect | null>(null);
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState({ x: 0, y: 0 }); // panel drag offset
  const [, force] = useState(0); // re-read getComputedStyle after edits
  // "Save to source" only works from a source checkout; the packaged app has no
  // editable src dir, so probe once and hide the button when it can't ever succeed.
  const [canSave, setCanSave] = useState(false);

  const overrides = useRef<Map<string, Map<string, Decl>>>(new Map()); // selector → prop → declaration
  const descriptions = useRef<Map<string, string>>(new Map()); // selector → human label (for export comments)
  const history = useRef<Change[]>([]); // undo stack, oldest first
  const styleElRef = useRef<HTMLStyleElement | null>(null);

  const say = useCallback((key: BtnKey, short: string, detail?: string, err = false) => {
    setBtnMsg({ key, short, detail, err });
    if (btnTimer.current) window.clearTimeout(btnTimer.current);
    btnTimer.current = window.setTimeout(() => setBtnMsg(null), 1800);
  }, []);
  useEffect(() => () => { if (btnTimer.current) window.clearTimeout(btnTimer.current); }, []);

  const reposition = useCallback((target: HTMLElement | null) => {
    if (!target) {
      setRect(null);
      return;
    }
    const r = target.getBoundingClientRect();
    // Overlay bands come from the *computed* style, so live overrides (injected as
    // real CSS) are already reflected — no separate bookkeeping. Negative margins
    // clamp to 0: a band can't be drawn inside-out, and the panel still shows the
    // true value.
    const cs = getComputedStyle(target);
    const n = (v: string) => Math.max(0, parseFloat(v) || 0);
    setRect({
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
      mg: { t: n(cs.marginTop), r: n(cs.marginRight), b: n(cs.marginBottom), l: n(cs.marginLeft) },
      bd: { t: n(cs.borderTopWidth), r: n(cs.borderRightWidth), b: n(cs.borderBottomWidth), l: n(cs.borderLeftWidth) },
      pd: { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) },
    });
  }, []);

  const selectElement = useCallback(
    (target: HTMLElement) => {
      const cls = Array.from(target.classList);
      setEl(target);
      setClasses(cls);
      setActive(cls.length ? [cls[0]] : []);
      reposition(target);
    },
    [reposition],
  );

  // Active selector for the current element. Class-based when a chip is on (styles
  // ALL same-class nodes); otherwise a self-describing structural selector so the
  // export/save names exactly which class-less element was edited (no dead ids).
  const selector = el
    ? active.length
      ? "." + active.map(cssEscape).join(".")
      : structuralSelector(el)
    : "";

  // Single source of truth for serializing overrides → CSS. The live preview,
  // "copy for AI", and "save to source" ALL go through this, so the copied/saved
  // CSS carries the exact same !important the on-screen preview uses (otherwise it
  // wins on screen but loses the moment it's pasted back into the source).
  // `comments` (export only) prefixes each rule with the edited element's label.
  const buildCss = useCallback(({ comments = false }: { comments?: boolean } = {}): string => {
    let css = "";
    overrides.current.forEach((props, sel) => {
      if (props.size === 0) return;
      if (comments) {
        const desc = descriptions.current.get(sel);
        if (desc) css += `/* ${desc} */\n`;
      }
      css += `${sel} {\n`;
      props.forEach((d, prop) => {
        css += `  ${prop}: ${d.v}${d.imp ? " !important" : ""};\n`;
      });
      css += "}\n";
    });
    return css;
  }, []);

  const renderStyle = useCallback(() => {
    let s = styleElRef.current;
    if (!s) {
      s = document.createElement("style");
      s.setAttribute("data-debug-ui", "overrides");
      document.head.appendChild(s);
      styleElRef.current = s;
    }
    s.textContent = buildCss();
  }, [buildCss]);

  useEffect(() => {
    renderStyle();
  }, [renderStyle]);

  useEffect(() => {
    let alive = true;
    canSaveOverridesToSource().then((ok) => {
      if (alive) setCanSave(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setProp = useCallback(
    (prop: string, value: string) => {
      if (!selector) return;
      let m = overrides.current.get(selector);
      if (!m) {
        m = new Map();
        overrides.current.set(selector, m);
      }
      // Record BEFORE writing — `prev === undefined` means "there was no override
      // here", which is what undo restores to (back to the stylesheet's own value).
      // A drag fires onChange once per pixel, so a run on the same target collapses
      // into the entry already on top: one gesture = one undoable step.
      const prev = m.get(prop);
      const top = history.current[history.current.length - 1];
      if (top && top.selector === selector && top.prop === prop) top.next = value;
      else history.current.push({ selector, prop, prev, next: value });

      // Read the on-screen value BEFORE writing, so we can tell afterwards whether
      // the plain declaration actually did anything.
      const before = el ? getComputedStyle(el).getPropertyValue(prop).trim() : "";

      if (value.trim() === "") m.delete(prop);
      else m.set(prop, { v: value, imp: prev?.imp ?? false });
      if (el) descriptions.current.set(selector, describeEl(el));
      renderStyle();

      // Auto-!important, decided per declaration instead of by a toggle the user
      // can't reason about: our selector comes from the element's class, so it is
      // often LESS specific than the rule it fights (`.wb-card-iconbtn` vs
      // `.wb-card .wb-card-iconbtn`) and loses silently. If the computed value did
      // not budge, we lost — re-emit that one declaration with !important.
      // Only probed when the declaration is NEW: a drag fires this per pixel, and
      // the verdict can't change mid-gesture.
      const decl = m.get(prop);
      if (decl && !decl.imp && prev === undefined && el) {
        const after = getComputedStyle(el).getPropertyValue(prop).trim();
        if (after === before) {
          m.set(prop, { v: decl.v, imp: true });
          renderStyle();
        }
      }

      force((n) => n + 1);
      requestAnimationFrame(() => reposition(el));
    },
    [selector, renderStyle, reposition, el],
  );

  const readValue = (prop: string): string => {
    const ov = overrides.current.get(selector)?.get(prop);
    if (ov != null) return ov.v;
    if (!el) return "";
    return getComputedStyle(el).getPropertyValue(prop).trim();
  };

  // True once any declaration had to be forced — drives the export blurb and the
  // badge in the change log.
  const anyForced = (): boolean => {
    for (const props of overrides.current.values()) for (const d of props.values()) if (d.imp) return true;
    return false;
  };

  // Copy all tweaks as an AI-ready brief: a one-line instruction + the CSS block,
  // so it can be pasted straight into a chat with an AI to apply to the source.
  const copyForAi = async () => {
    const css = buildCss({ comments: true });
    if (!css) {
      say("copy", t("debug.btnNothing"), t("debug.nothingToCopy"));
      return;
    }
    // The blurb has to describe what's actually in the CSS: !important now appears
    // only on the declarations that needed it, so say so only when some did.
    const text = `${t(anyForced() ? "debug.exportHeader" : "debug.exportHeaderPlain")}\n\n${css}`;
    if (await copyText(text)) say("copy", t("debug.btnCopied"), t("debug.copied"));
    else say("copy", t("debug.btnFailed"), t("debug.copyFailed"), true);
  };

  // Undo one step: put the previous value back (or drop the override entirely if
  // there wasn't one), and pop the entry so the list shows what's still applied.
  const undo = () => {
    const last = history.current.pop();
    if (!last) return;
    const m = overrides.current.get(last.selector);
    if (m) {
      if (last.prev === undefined) m.delete(last.prop);
      else m.set(last.prop, last.prev);
      if (m.size === 0) {
        overrides.current.delete(last.selector);
        descriptions.current.delete(last.selector);
      }
    }
    renderStyle();
    force((n) => n + 1);
    requestAnimationFrame(() => reposition(el));
  };

  const clearAll = () => {
    overrides.current.clear();
    descriptions.current.clear();
    history.current = [];
    renderStyle();
    force((n) => n + 1);
    requestAnimationFrame(() => reposition(el));
    say("clear", t("debug.btnCleared"), t("debug.cleared"));
  };

  const overridesToObject = (): Record<string, Record<string, string>> => {
    const obj: Record<string, Record<string, string>> = {};
    overrides.current.forEach((props, sel) => {
      if (props.size === 0) return;
      const decls: Record<string, string> = {};
      props.forEach((d, prop) => {
        decls[prop] = `${d.v}${d.imp ? " !important" : ""}`;
      });
      obj[sel] = decls;
    });
    return obj;
  };

  const saveToSource = async () => {
    const obj = overridesToObject();
    if (Object.keys(obj).length === 0) {
      say("save", t("debug.btnNothing"), t("debug.nothingToCopy"));
      return;
    }
    try {
      const r = await saveOverridesToSource(obj);
      say("save", t("debug.btnSaved"), t("debug.savedToCode", { n: r.selectors ?? 0 }));
    } catch (e) {
      say("save", t("debug.btnFailed"), t("debug.saveFailed", { msg: e instanceof Error ? e.message : String(e) }), true);
    }
  };

  // shift+click selection (capture phase, so it beats the app's own handlers)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest("[data-debug-ui]")) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(target);
    };
    const onDown = (e: MouseEvent) => {
      // stop shift+click from extending a text selection outside the panel
      const target = e.target as HTMLElement | null;
      if (e.shiftKey && target && !target.closest("[data-debug-ui]")) e.preventDefault();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [selectElement]);

  // Refresh after ancestor transitions too: a press scale can leave the badge
  // showing a transient size captured by Shift+click after the element rebounds.
  useEffect(() => {
    if (!el) return;
    const on = () => reposition(el);
    const onTransition = (event: TransitionEvent) => {
      if (event.target instanceof Element && event.target.contains(el)) on();
    };
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    window.addEventListener("transitionend", onTransition, true);
    window.addEventListener("transitioncancel", onTransition, true);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
      window.removeEventListener("transitionend", onTransition, true);
      window.removeEventListener("transitioncancel", onTransition, true);
    };
  }, [el, reposition]);

  // tear down the injected style when debug mode turns off
  useEffect(() => {
    return () => {
      styleElRef.current?.remove();
      styleElRef.current = null;
    };
  }, []);

  const ancestry = useMemo(() => {
    const chain: HTMLElement[] = [];
    let node: HTMLElement | null = el;
    while (node && node !== document.body && chain.length < 6) {
      chain.push(node);
      node = node.parentElement;
    }
    return chain.reverse();
  }, [el]);

  const q = search.trim().toLowerCase();
  const catalog = catalogFor(el); // img/svg swap the typography group for what actually applies
  const visibleGroups = q
    ? catalog.map((g) => ({ ...g, props: g.props.filter((p) => p.prop.includes(q)) })).filter((g) => g.props.length)
    : catalog;

  const searchProps = useMemo(() => {
    if (!q || !el) return [] as string[];
    const cs = getComputedStyle(el);
    const out: string[] = [];
    for (let i = 0; i < cs.length; i++) {
      const name = cs.item(i);
      if (name.includes(q) && !isCatalogProp(name)) out.push(name);
      if (out.length >= 40) break;
    }
    return out;
  }, [q, el]);

  // panel drag (header grip)
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const onHeaderDown = (e: ReactPointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    setPos({ x: dragRef.current.px + (e.clientX - dragRef.current.sx), y: dragRef.current.py + (e.clientY - dragRef.current.sy) });
  };
  const onHeaderUp = (e: ReactPointerEvent) => {
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  // 动作按钮：反馈期内换短文案（按钮定宽，不会因文字变化跳动），详细信息进 title。
  const actionBtn = (key: BtnKey, label: string, onClick: () => void, primary = false) => {
    const on = btnMsg?.key === key;
    const cls = [styles.toolBtn, primary ? styles.toolBtnPrimary : "", on && btnMsg?.err ? styles.toolBtnErr : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <button className={cls} onClick={onClick} title={on ? btnMsg?.detail : undefined}>
        {on ? btnMsg!.short : label}
      </button>
    );
  };

  const renderRow = (prop: string, kind: PropKind) => {
    const value = readValue(prop);
    return (
      <div key={prop} className={styles.row}>
        <span className={styles.rowLabel} title={prop}>
          {prop}
        </span>
        <Editor kind={kind} value={value} onChange={(v) => setProp(prop, v)} />
      </div>
    );
  };

  // Size badge rides above the margin box, flipping below it near the viewport top.
  const badge = rect
    ? {
        top: rect.top - rect.mg.t - 18 >= 2 ? rect.top - rect.mg.t - 18 : rect.top + rect.height + rect.mg.b + 4,
        left: Math.max(2, rect.left - rect.mg.l),
      }
    : null;

  return (
    <>
      {rect && (
        <>
          {/* Nested band overlay: each layer sets its own border widths and, with
              box-sizing:border-box + width:100%, its content area IS the next box
              down (margin box → border box → padding box → content box). */}
          <div
            className={styles.hlMargin}
            data-debug-ui="highlight"
            style={{
              top: rect.top - rect.mg.t,
              left: rect.left - rect.mg.l,
              width: rect.width + rect.mg.l + rect.mg.r,
              height: rect.height + rect.mg.t + rect.mg.b,
              borderTopWidth: rect.mg.t,
              borderRightWidth: rect.mg.r,
              borderBottomWidth: rect.mg.b,
              borderLeftWidth: rect.mg.l,
            }}
          >
            <div
              className={styles.hlBorder}
              style={{
                borderTopWidth: rect.bd.t,
                borderRightWidth: rect.bd.r,
                borderBottomWidth: rect.bd.b,
                borderLeftWidth: rect.bd.l,
              }}
            >
              <div
                className={styles.hlPadding}
                style={{
                  borderTopWidth: rect.pd.t,
                  borderRightWidth: rect.pd.r,
                  borderBottomWidth: rect.pd.b,
                  borderLeftWidth: rect.pd.l,
                }}
              >
                <div className={styles.hlContent} />
              </div>
            </div>
          </div>
          <div className={styles.hlSize} data-debug-ui="highlight" style={badge!}>
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </>
      )}
      <div className={styles.panel} data-debug-ui="panel" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
        <header className={styles.header} onPointerDown={onHeaderDown} onPointerMove={onHeaderMove} onPointerUp={onHeaderUp}>
          <span className={styles.title}>{t("debug.panelTitle")}</span>
          <div className={styles.headRight}>
            {/* stopPropagation so a click here isn't read as the start of a panel drag */}
            <div className={styles.langSwitch} title={t("debug.lang")} onPointerDown={(e) => e.stopPropagation()}>
              {(["zh-CN", "en"] as const).map((l) => (
                <button
                  key={l}
                  className={l === lang ? `${styles.langBtn} ${styles.langBtnOn}` : styles.langBtn}
                  onClick={() => setLang(l)}
                >
                  {l === "zh-CN" ? "中" : "EN"}
                </button>
              ))}
            </div>
            {el && (
              <button className={styles.close} onClick={() => { setEl(null); setRect(null); }} title={t("common.close")}>
                ×
              </button>
            )}
          </div>
        </header>

        {!el ? (
          <div className={styles.empty}>{t("debug.empty")}</div>
        ) : (
          <div className={styles.body}>
            <div className={styles.crumbs}>
              {ancestry.map((node, i) => {
                const label = node.tagName.toLowerCase() + (node.classList[0] ? "." + node.classList[0] : "");
                return (
                  <button
                    key={i}
                    className={node === el ? `${styles.crumb} ${styles.crumbCur}` : styles.crumb}
                    onClick={() => selectElement(node)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className={styles.targetRow}>
              <span className={styles.targetLabel}>{t("debug.target")}</span>
              <div className={styles.chips}>
                {classes.length === 0 ? (
                  <code className={styles.thisOnly} title={t("debug.thisOnly")}>
                    {selector}
                  </code>
                ) : (
                  classes.map((c) => {
                    const on = active.includes(c);
                    return (
                      <button
                        key={c}
                        className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                        onClick={() => setActive((a) => (on ? a.filter((x) => x !== c) : [...a, c]))}
                      >
                        .{c}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* 间距排在最前：调布局时问的第一个问题总是「这块空白是谁给的」。
                盒模型是它的一部分（padding/margin 的四边就在图上），所以收进来做小标题。 */}
            <div className={styles.group}>
              <div className={styles.groupHead}>{t("debug.groups.spacing")}</div>
              <div className={styles.subHead}>{t("debug.groups.box")}</div>
              <BoxModel read={readValue} set={setProp} />
              <SpacingGap el={el} read={readValue} set={setProp} onSelect={selectElement} t={t} />
            </div>

            <input
              className={styles.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("debug.search")}
              spellCheck={false}
            />

            {visibleGroups.map((g) => {
              // A group where every prop has a short tag renders as a 2-col grid of
              // in-field-tagged inputs (Figma's W/H block); everything else stays
              // label+input rows, since CSS property names don't fit in a tag.
              const tagged = g.props.length > 0 && g.props.every((p) => p.short);
              return (
                <div key={g.id} className={styles.group}>
                  <div className={styles.groupHead}>{t(`debug.groups.${g.id}`)}</div>
                  {/* answer first: which font is on screen. The font-family row right
                      below it is the declared stack, which is a different question. */}
                  {g.id === "typography" && <RenderedFont el={el} t={t} />}
                  {tagged ? (
                    <>
                      <div className={styles.grid2}>
                        {g.props.map((p) => (
                          <ScrubNumber
                            key={p.prop}
                            label={p.short}
                            title={p.prop}
                            value={readValue(p.prop)}
                            onChange={(v) => setProp(p.prop, v)}
                            defaultUnit="px"
                            step={1}
                          />
                        ))}
                      </div>
                      {/* `max-*: none` here usually means the cap is on an ancestor */}
                      {g.id === "size" && <SizeOrigin el={el} t={t} onSelect={selectElement} />}
                    </>
                  ) : (
                    g.props.map((p) => renderRow(p.prop, p.kind))
                  )}
                </div>
              );
            })}

            {searchProps.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupHead}>{t("debug.groups.found")}</div>
                {searchProps.map((prop) => renderRow(prop, inferKind(prop, readValue(prop))))}
              </div>
            )}

            {q && visibleGroups.length === 0 && searchProps.length === 0 && (
              <div className={styles.empty}>{t("debug.noProp")}</div>
            )}
          </div>
        )}

        {/* 固定底栏：改动记录 + 三个动作按钮。它们是「对已做的改动做什么」，
            与上面「继续改什么」是两件事，所以钉在底部不随属性列表滚动。 */}
        {el && (
          <div className={styles.footer}>
            {/* change log — newest first, so the row the undo button removes is the
                one right under it */}
            <div className={styles.hist}>
              <div className={styles.histHead}>
                <span>
                  {t("debug.history")} ({history.current.length})
                </span>
                <button className={styles.toolBtn} onClick={undo} disabled={history.current.length === 0}>
                  {t("debug.undo")}
                </button>
              </div>
              {history.current.length === 0 ? (
                <div className={styles.histEmpty}>{t("debug.histEmpty")}</div>
              ) : (
                <div className={styles.histList}>
                  {history.current
                    .map((c, i) => ({ c, i }))
                    .reverse()
                    .map(({ c, i }) => {
                      const forced = overrides.current.get(c.selector)?.get(c.prop)?.imp;
                      return (
                        <div
                          key={i}
                          className={styles.histRow}
                          title={`${c.selector} { ${c.prop}: ${c.prev?.v ?? t("debug.histDefault")} → ${c.next || t("debug.histRemoved")} }`}
                        >
                          <span className={styles.histSel}>{c.selector}</span>
                          <span className={styles.histProp}>{c.prop}</span>
                          {forced && (
                            <span className={styles.histForced} title={t("debug.forcedHint")}>
                              !
                            </span>
                          )}
                          <span className={styles.histVal}>{c.next || t("debug.histRemoved")}</span>
                        </div>
                      );
                    })}
                </div>
              )}
              {/* the badge needs no hover to be understood: a 12px target with a
                  title on its parent row too is a tooltip you can't reliably hit */}
              {anyForced() && <div className={styles.histLegend}>{t("debug.forcedLegend")}</div>}
            </div>

            <div className={styles.toolbar}>
              {actionBtn("copy", t("debug.export"), copyForAi, true)}
              {canSave && actionBtn("save", t("debug.saveToCode"), saveToSource)}
              {actionBtn("clear", t("debug.clear"), clearAll)}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
