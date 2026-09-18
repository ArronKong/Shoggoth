import type { UnifiedSkill } from "../types";

/** Persist identity across refreshes without conflating package versions or agent scopes. */
export function skillIdentity(skill: UnifiedSkill): string {
  return JSON.stringify([
    skill.backendId,
    skill.agentId || skill.profileId || "",
    skill.id || skill.name,
    skill.source || "",
    skill.version || "",
  ]);
}
