import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, revealManagedAgentFile, revealPath } from "../api/client";
import { useToast } from "./ui";

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
        const url = new URL(link.href, window.location.href);
        const match = url.origin === window.location.origin
          && /^\/__api\/agents\/([^/]+)\/managed-files\/([a-f0-9]{64})\/content$/u.exec(url.pathname);
        const backend = url.searchParams.get("backend");
        if (match && backend) {
          event.preventDefault();
          let agentId: string;
          try { agentId = decodeURIComponent(match[1]); } catch { return; }
          void revealManagedAgentFile(backend, agentId, match[2]).catch((error) => {
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
