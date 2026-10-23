import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Align composer menus with the input frame rather than the toolbar padding. */
export function useComposerPopupPosition(open: boolean, rootRef: RefObject<HTMLElement>,
  popupRef: RefObject<HTMLElement>) {
  const [style, setStyle] = useState<CSSProperties | undefined>();
  useLayoutEffect(() => {
    if (!open) { setStyle(undefined); return; }
    const composer = rootRef.current?.closest<HTMLElement>("[data-chat-composer]");
    if (!composer) { setStyle(undefined); return; }
    const position = () => {
      const popup = popupRef.current;
      if (!popup) return;
      const left = parseFloat(window.getComputedStyle(popup).left) || 0;
      setStyle({ left: left + composer.getBoundingClientRect().left - popup.getBoundingClientRect().left });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(composer);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [open, rootRef, popupRef]);
  return style;
}
