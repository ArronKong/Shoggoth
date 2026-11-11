// Keep the default backend selection in the same order as the visible tabs.
export const BACKEND_ORDER = [
  "shoggoth", "hermes", "openclaw", "codex", "claude-code", "grok-build",
  "antigravity", "deepseek-harness", "pi",
];

export function sortBackendTabs<T extends { id: string }>(backends: readonly T[]): T[] {
  const rank = (id: string) => {
    const index = BACKEND_ORDER.indexOf(id);
    return index < 0 ? BACKEND_ORDER.length : index;
  };
  return [...backends].sort((a, b) => rank(a.id) - rank(b.id));
}
