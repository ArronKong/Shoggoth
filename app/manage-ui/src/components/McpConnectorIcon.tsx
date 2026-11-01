import { useState, useSyncExternalStore } from "react";
import type { McpIcon } from "../api/mcpConnectors";
import { mcpIconFallback, selectMcpIcon } from "../lib/mcpConnectorIcons";
import { bundledMcpIcon } from "../lib/bundledMcpIcons";
import { mcpBrandId } from "../lib/mcpRecommendationCatalog";
import s from "./McpConnectorIcon.module.css";

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
const readTheme = (): "light" | "dark" => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) { observer = new MutationObserver(() => listeners.forEach(notify => notify())); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); }
  return () => { listeners.delete(listener); if (!listeners.size) { observer?.disconnect(); observer = null; } };
}

export default function McpConnectorIcon({ name, identity, iconId, icons, compact = false }: { name: string; identity: string; iconId?: string; icons?: McpIcon[]; compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as const);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [loadedSrc, setLoadedSrc] = useState("");
  const brand = mcpBrandId(iconId || identity), bundled = bundledMcpIcon(brand);
  const icon = bundled && !failed.has(bundled.src) ? bundled : selectMcpIcon(icons, theme, failed);
  const fallback = mcpIconFallback(name, identity), loaded = !!icon && loadedSrc === icon.src;
  return <span className={`${s.icon}${compact ? ` ${s.compact}` : ""}${loaded ? ` ${s.imageSurface}` : ""}${loaded && icon?.theme === "dark" ? ` ${s.darkImage}` : ""}`} data-mcp-icon={identity} data-bundled-icon={icon === bundled ? brand : undefined} data-tone={fallback.tone} aria-hidden="true">
    {!icon && <span>{fallback.initials}</span>}
    {icon && <img key={icon.src} src={icon.src} alt="" loading="lazy" decoding="async" style={{ opacity: loaded ? 1 : 0 }} onLoad={() => setLoadedSrc(icon.src)} referrerPolicy="no-referrer" onError={() => setFailed(previous => new Set([...previous, icon.src]))} />}
  </span>;
}
