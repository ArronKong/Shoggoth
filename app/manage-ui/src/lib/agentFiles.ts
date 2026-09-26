// Hide the tool catalog in profile/settings surfaces; the runtime still uses it.
export function visibleAgentFiles<T extends { name: string }>(files: readonly T[] | undefined): T[] {
  return (files || []).filter((file) => file.name.toUpperCase() !== "TOOLS.MD");
}
