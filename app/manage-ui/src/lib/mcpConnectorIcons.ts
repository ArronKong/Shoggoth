import type { McpIcon } from "../api/mcpConnectors";

export function selectMcpIcon(icons: McpIcon[] | undefined, theme: "light" | "dark", failed: ReadonlySet<string> = new Set()): McpIcon | undefined {
  return (icons || []).filter(icon => {
    if (failed.has(icon.src) || icon.src.length > 2048 || /[\s]/u.test(icon.src)) return false;
    try { const url = new URL(icon.src); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  }).map((icon, index) => {
    const themeRank = icon.theme === theme ? 0 : icon.theme ? 2 : 1;
    const svg = icon.mimeType === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(icon.src);
    const widths = (icon.sizes || []).map(size => Number(size.split("x")[0])).filter(size => Number.isFinite(size) && size > 0);
    const sizeRank = widths.length ? Math.min(...widths.map(size => size >= 64 ? size - 64 : 10000 - size)) : 1000;
    return { icon, rank: themeRank * 1000000 + (svg ? 0 : 10000 + sizeRank), index };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.icon;
}

export function mcpIconFallback(name: string, identity: string) {
  const label = name.includes("/") ? name.split("/")[0].split(".").filter(part => !["io", "com", "org", "github", "mcp"].includes(part)).pop() || name : name;
  const words = label.trim().split(/[\s._/-]+/u).filter(Boolean);
  const initials = (words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]).join("") : Array.from(label.trim()).slice(0, 2).join("")).toUpperCase();
  let hash = 0; for (const letter of identity) hash = (Math.imul(hash, 31) + letter.codePointAt(0)!) >>> 0;
  return { initials: initials || "M", tone: hash % 6 };
}
