import { useCallback, useLayoutEffect, useState } from "react";

export function useScrollFade(active: boolean, itemCount: number, resetKey?: string) {
  // The scroll viewport can mount after its popover opens.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [more, setMore] = useState(false);
  const checkOverflow = useCallback(() => {
    setEarlier(Boolean(element && element.scrollTop > 1));
    setMore(Boolean(element && element.scrollHeight - element.scrollTop > element.clientHeight + 1));
  }, [element]);

  useLayoutEffect(() => {
    if (active && element) element.scrollTop = 0;
  }, [active, element, resetKey]);

  useLayoutEffect(() => {
    if (!active || !element) return;
    checkOverflow();
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element, itemCount, resetKey, checkOverflow]);

  return { ref: setElement, onScroll: checkOverflow, "data-scrolled": earlier || undefined, "data-more": more || undefined };
}
