import { useEffect } from "react";
import "./ScrollbarProvider.css";

export const SCROLLBAR_CONFIG = {
  thumbSizePx: 4,
  edgeInsetPx: 8,
  hideDelayMs: 1200,
  fadeMs: 400,
} as const;

const CSS_VARIABLES = [
  ["--ui-scrollbar-thumb-size", `${SCROLLBAR_CONFIG.thumbSizePx}px`],
  ["--ui-scrollbar-edge-inset", `${SCROLLBAR_CONFIG.edgeInsetPx}px`],
  [
    "--ui-scrollbar-track-size",
    "calc(var(--ui-scrollbar-thumb-size) + var(--ui-scrollbar-edge-inset))",
  ],
  ["--ui-scrollbar-radius", `${SCROLLBAR_CONFIG.thumbSizePx / 2}px`],
  ["--ui-scrollbar-fade-duration", `${SCROLLBAR_CONFIG.fadeMs}ms`],
] as const;

const THUMB_COLOR_VARIABLE = "--ui-scrollbar-thumb-color";
const THUMB_VISIBLE_VARIABLE = "--ui-scrollbar-thumb-visible";

export default function ScrollbarProvider(): null {
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.documentElement;
    const previousValues = new Map(
      CSS_VARIABLES.map(([name]) => [name, {
        value: root.style.getPropertyValue(name),
        priority: root.style.getPropertyPriority(name),
      }]),
    );
    for (const [name, value] of CSS_VARIABLES) root.style.setProperty(name, value);

    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const fades = new Map<HTMLElement, Animation>();
    const hoveredTargets = new WeakSet<HTMLElement>();
    const resolveTarget = (target: EventTarget | null): HTMLElement | null => {
      if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) return target;
      if (typeof Document !== "undefined" && target instanceof Document) {
        const scrollingElement = target.scrollingElement;
        return scrollingElement instanceof HTMLElement ? scrollingElement : null;
      }
      if (typeof Window !== "undefined" && target instanceof Window) {
        const scrollingElement = target.document.scrollingElement;
        return scrollingElement instanceof HTMLElement ? scrollingElement : null;
      }
      return null;
    };
    const isVisibleScrollTarget = (target: HTMLElement) => (
      target.getAttribute("data-scrollbar") !== "hidden"
      && (target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth)
    );
    const changedScrollAncestors = (target: EventTarget | null, relatedTarget: EventTarget | null): HTMLElement[] => {
      const ancestors: HTMLElement[] = [];
      if (typeof Element === "undefined" || !(target instanceof Element)) return ancestors;

      // A pointer moving between descendants does not enter/leave their shared
      // ancestors. Exclude those using DOM identity before reading geometry:
      // scrollHeight/clientHeight can force layout on a large chat or card wall.
      const relatedAncestors = new Set<Element>();
      let related = relatedTarget instanceof Element ? relatedTarget : null;
      while (related) {
        relatedAncestors.add(related);
        related = related.parentElement;
      }
      let element: Element | null = target;
      while (element && !relatedAncestors.has(element)) {
        if (
          typeof HTMLElement !== "undefined"
          && element instanceof HTMLElement
          && isVisibleScrollTarget(element)
        ) {
          ancestors.push(element);
        }
        element = element.parentElement;
      }
      return ancestors;
    };
    const cancelFade = (target: HTMLElement) => {
      const fade = fades.get(target);
      if (!fade) return;
      fades.delete(target);
      fade.cancel();
    };
    const prefersReducedMotion = () => (
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    const startFade = (target: HTMLElement) => {
      cancelFade(target);
      if (target.getAttribute("data-scrollbar") === "hidden" || prefersReducedMotion()) return;
      if (typeof target.animate !== "function") return;

      const visibleColor = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(target).getPropertyValue(THUMB_VISIBLE_VARIABLE).trim()
        : "";
      const animation = target.animate(
        [
          { [THUMB_COLOR_VARIABLE]: visibleColor || `var(${THUMB_VISIBLE_VARIABLE})` } as Keyframe,
          { [THUMB_COLOR_VARIABLE]: "transparent" } as Keyframe,
        ],
        { duration: SCROLLBAR_CONFIG.fadeMs, easing: "ease" },
      );
      fades.set(target, animation);
      animation.onfinish = () => {
        if (fades.get(target) !== animation) return;
        fades.delete(target);
        animation.cancel();
      };
      animation.oncancel = () => {
        if (fades.get(target) === animation) fades.delete(target);
      };
    };
    const handleScroll = (event: Event) => {
      const target = resolveTarget(event.target);
      if (!target) return;

      cancelFade(target);
      target.classList.add("scrolling");
      const existingTimer = timers.get(target);
      if (existingTimer !== undefined) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        target.classList.remove("scrolling");
        timers.delete(target);
        if (!hoveredTargets.has(target)) startFade(target);
      }, SCROLLBAR_CONFIG.hideDelayMs);
      timers.set(target, timer);
    };
    const handlePointerOver = (event: PointerEvent) => {
      for (const target of changedScrollAncestors(event.target, event.relatedTarget)) {
        hoveredTargets.add(target);
        cancelFade(target);
      }
    };
    const handlePointerOut = (event: PointerEvent) => {
      for (const target of changedScrollAncestors(event.target, event.relatedTarget)) {
        hoveredTargets.delete(target);
        if (!timers.has(target)) startFade(target);
      }
    };

    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    return () => {
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      for (const [target, timer] of timers) {
        clearTimeout(timer);
        target.classList.remove("scrolling");
      }
      timers.clear();
      for (const fade of fades.values()) fade.cancel();
      fades.clear();
      for (const [name] of CSS_VARIABLES) {
        const previous = previousValues.get(name);
        if (previous?.value) root.style.setProperty(name, previous.value, previous.priority);
        else root.style.removeProperty(name);
      }
    };
  }, []);

  return null;
}
