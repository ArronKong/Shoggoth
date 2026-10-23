const FILE_ORDER: Record<string, number> = {
  "IDENTITY.MD": 0,
  "SOUL.MD": 1,
  "USER.MD": 2,
  "AGENTS.MD": 3,
  "MEMORY.MD": 5,
};

// Hide the tool catalog in profile/settings surfaces; the runtime still uses it.
// Keep profile documents in settings order, with generated memory always last.
export function visibleAgentFiles<T extends { name: string }>(files: readonly T[] | undefined): T[] {
  return (files || [])
    .filter((file) => file.name.toUpperCase() !== "TOOLS.MD")
    .sort((left, right) => (FILE_ORDER[left.name.toUpperCase()] ?? 4) - (FILE_ORDER[right.name.toUpperCase()] ?? 4));
}
