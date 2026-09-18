import { pinyin } from "pinyin-pro";

export type AgentCreateErrorKind =
  | "openclaw-main-reserved"
  | "openclaw-name-unsupported"
  | "hermes-name-unsupported";

export function classifyAgentCreateError(
  backend: string,
  submittedName: string,
  message: string,
): AgentCreateErrorKind | null {
  if (backend === "openclaw" && /需要有效名称/.test(message)) {
    return "openclaw-name-unsupported";
  }
  if (backend === "openclaw" && /["']main["'] is reserved/i.test(message)) {
    return submittedName.trim().toLowerCase() === "main"
      ? "openclaw-main-reserved"
      : "openclaw-name-unsupported";
  }
  if (backend === "hermes" && /Invalid profile name[\s\S]*Must match/i.test(message)) {
    return "hermes-name-unsupported";
  }
  return null;
}

export function openclawAgentIdFromName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  const latin = /[\u4e00-\u9fff]/.test(trimmed)
    ? pinyin(trimmed, {
        toneType: "none",
        type: "string",
        separator: "",
        v: true,
        nonZh: "consecutive",
      })
    : trimmed;
  if (!latin) return "";
  const lower = latin.toLowerCase();
  const id = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(latin)
    ? lower
    : lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64);
  return !id || id === "main" ? "" : id;
}

export function openclawWorkspacePlaceholder(name: string): string {
  const id = openclawAgentIdFromName(name);
  return id ? `~/.openclaw/agents/${id}` : "~/.openclaw/agents/<id>";
}
