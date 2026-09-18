import type { TFunction } from "i18next";
import type { BackendDescriptor, CronJobInput, UnifiedAgent } from "../../types";
import { emptyOpenClawDraft, openClawInputFromDraft, validateOpenClawDraft } from "./OpenClawCronForm";
import { emptyHermesDraft, hermesInputFromDraft, validateHermesDraft } from "./HermesCronForm";
import { emptyNativeCronDraft, nativeCronInputFromDraft, validateNativeCronDraft, type NativeCronDraft } from "./ShoggothCronForm";

export type CronCreateDraft = Pick<NativeCronDraft,
  "backendId" | "agentId" | "name" | "prompt" | "enabled" | "schedKind" | "cronExpr" | "everyMin" | "atLocal">;

export function emptyCronCreateDraft(): CronCreateDraft {
  const { backendId, agentId, name, prompt, enabled, schedKind, cronExpr, everyMin, atLocal } = emptyNativeCronDraft("");
  return { backendId, agentId, name, prompt, enabled, schedKind, cronExpr, everyMin, atLocal };
}

export function cronAgentAvailable(agent: UnifiedAgent): boolean {
  return !agent.archived && (!agent.lifecycleState || agent.lifecycleState === "active");
}

// The assistant chooses the backend. Common fields live in one draft, so
// switching assistants never resets the user's message or schedule.
export function cronCreateInputFromDraft(
  draft: CronCreateDraft,
  kind: NonNullable<BackendDescriptor["surfaces"]["cron"]>["kind"],
  t: TFunction,
): CronJobInput {
  if (!draft.backendId || !draft.agentId.trim()) throw new Error(t("cronForm.nativeValidateAgent"));
  if (!draft.name.trim()) throw new Error(t("cron.nameRequired"));
  if (!draft.prompt.trim()) throw new Error(t("cronForm.nativeValidatePrompt"));
  if (kind === "openclaw") {
    const value = { ...emptyOpenClawDraft(), ...draft, backendId: "openclaw" as const };
    const error = validateOpenClawDraft(value);
    if (error) throw new Error(t(error));
    return { ...openClawInputFromDraft(value), backendId: draft.backendId };
  }
  if (kind === "hermes") {
    const value = { ...emptyHermesDraft(), ...draft, backendId: "hermes" as const };
    const error = validateHermesDraft(value);
    if (error) throw new Error(error);
    return { ...hermesInputFromDraft(value), backendId: draft.backendId };
  }
  const value = { ...emptyNativeCronDraft(draft.backendId), ...draft };
  const error = validateNativeCronDraft(value);
  if (error) throw new Error(t(error));
  return nativeCronInputFromDraft(value);
}
