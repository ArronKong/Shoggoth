import { useCallback, useLayoutEffect, useState } from "react";

export function useScrollFade(
  active: boolean,
  content: unknown,
  resetKey?: string,
  direction: "vertical" | "horizontal" = "vertical",
) {
  // The scroll viewport can mount after its popover opens.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [more, setMore] = useState(false);
  const checkOverflow = useCallback(() => {
    if (!element) return;
    const horizontal = direction === "horizontal";
    const position = horizontal ? element.scrollLeft : element.scrollTop;
    const scrollSize = horizontal ? element.scrollWidth : element.scrollHeight;
    const viewportSize = horizontal ? element.clientWidth : element.clientHeight;
    setEarlier(position > 1);
    setMore(scrollSize - position > viewportSize + 1);
  }, [element, direction]);

  useLayoutEffect(() => {
    if (active && element && direction === "vertical") element.scrollTop = 0;
  }, [active, element, resetKey, direction]);

  useLayoutEffect(() => {
    if (!active || !element) return;
    checkOverflow();
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element, content, resetKey, checkOverflow]);

  return { ref: setElement, onScroll: checkOverflow, "data-scrolled": earlier || undefined, "data-more": more || undefined };
}
