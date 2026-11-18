import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, revealManagedAgentFile, revealPath } from "../api/client";
import { useToast } from "./ui";
import { managedAgentFileFromHref } from "../lib/appLinks";

// Markdown is also rendered in detail dialogs and portals outside ChatPage.
// Handle every local-file link once, regardless of the current page.
export default function LocalFileLinks() {
  const { t } = useTranslation();
  const toast = useToast();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (link && !link.hasAttribute("download")) {
        const file = managedAgentFileFromHref(link.href, window.location.href);
        if (file) {
          event.preventDefault();
          void revealManagedAgentFile(file.backend, file.agentId, file.fileId).catch((error) => {
            const code = error instanceof ApiError ? error.code : undefined;
            toast.error(code ? t(`agents.managedFiles.errors.${code}`, { defaultValue: t("agents.managedFiles.unavailable") })
              : t("agents.managedFiles.unavailable"));
          });
          return;
        }
      }
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
