import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { revealPath } from "../api/client";
import { useToast } from "./ui";

// Markdown is also rendered in detail dialogs and portals outside ChatPage.
// Handle every local-file link once, regardless of the current page.
export default function LocalFileLinks() {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[data-local-path]");
      if (!anchor) return;
      event.preventDefault();
      let filePath = "";
      try { filePath = decodeURIComponent(anchor.dataset.localPath || ""); } catch { /* invalid markers stay inert */ }
      if (!filePath) return;
      void revealPath(filePath).catch((error) => {
        toast.error(t("chat.artifactsRevealFailed", { msg: error instanceof Error ? error.message : String(error) }));
      });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [t, toast]);
  return null;
}
