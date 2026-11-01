const FILE_ORDER: Record<string, number> = {
  "IDENTITY.MD": 0,
  "SOUL.MD": 1,
  "USER.MD": 2,
  "AGENTS.MD": 3,
  "MEMORY.MD": 5,
};

// Hide internal rule files in profile/settings surfaces; the runtime still uses them.
// Keep profile documents in settings order, with generated memory always last.
export function visibleAgentFiles<T extends { name: string }>(files: readonly T[] | undefined): T[] {
  return (files || [])
    .filter((file) => !["TOOLS.MD", "DAILY_REVIEW.MD"].includes(file.name.toUpperCase()))
    .sort((left, right) => (FILE_ORDER[left.name.toUpperCase()] ?? 4) - (FILE_ORDER[right.name.toUpperCase()] ?? 4));
}
