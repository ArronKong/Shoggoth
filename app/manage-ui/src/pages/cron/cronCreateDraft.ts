import type { TFunction } from "i18next";
import type { BackendDescriptor, BackendStatus, CronJobInput, CronModelChoice, UnifiedAgent } from "../../types";
import { sortBackendTabs } from "../../lib/backendTabOrder";
import { emptyOpenClawDraft, openClawInputFromDraft, validateOpenClawDraft } from "./OpenClawCronForm";
import { emptyHermesDraft, hermesInputFromDraft, validateHermesDraft } from "./HermesCronForm";
import { emptyNativeCronDraft, nativeCronInputFromDraft, validateNativeCronDraft, type NativeCronDraft } from "./ShoggothCronForm";

export type CronCreateDraft = Pick<NativeCronDraft,
  "backendId" | "agentId" | "name" | "prompt" | "enabled" | "schedKind" | "cronExpr" | "everyMin" | "atLocal">
  & { taskModel: CronModelChoice | null };

export function emptyCronCreateDraft(): CronCreateDraft {
  const { backendId, agentId, name, prompt, enabled, schedKind, cronExpr, everyMin, atLocal } = emptyNativeCronDraft("");
  return { backendId, agentId, name, prompt, enabled, schedKind, cronExpr, everyMin, atLocal, taskModel: null };
}

export function cronAgentAvailable(agent: UnifiedAgent): boolean {
  return !agent.archived && (!agent.lifecycleState || agent.lifecycleState === "active");
}

export function defaultCronAssistant(backends: BackendDescriptor[], agents: Record<string, UnifiedAgent[]>, statuses: BackendStatus[]) {
  const connected = new Set(statuses.filter((status) => status.connected && !status.disabled).map(({ id }) => id));
  for (const { id: backendId } of sortBackendTabs(backends)) {
    if (!connected.has(backendId)) continue;
    const agent = agents[backendId]?.find((item) => item.id && item.isDefault && cronAgentAvailable(item));
    if (agent) return { backendId, agentId: agent.id };
  }
  return undefined;
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
  const { taskModel, ...common } = draft;
  if (kind === "openclaw") {
    const value = { ...emptyOpenClawDraft(), ...common, backendId: "openclaw" as const,
      model: taskModel?.model ?? "" };
    const error = validateOpenClawDraft(value);
    if (error) throw new Error(t(error));
    return { ...openClawInputFromDraft(value), backendId: draft.backendId };
  }
  if (kind === "hermes") {
    const value = { ...emptyHermesDraft(), ...common, backendId: "hermes" as const,
      model: taskModel?.model ?? "", provider: taskModel && "provider" in taskModel ? taskModel.provider ?? "" : "" };
    const error = validateHermesDraft(value);
    if (error) throw new Error(error);
    return { ...hermesInputFromDraft(value), backendId: draft.backendId };
  }
  const value = { ...emptyNativeCronDraft(draft.backendId), ...common,
    modelSelection: taskModel && "bindingId" in taskModel ? taskModel : null };
  const error = validateNativeCronDraft(value);
  if (error) throw new Error(t(error));
  return nativeCronInputFromDraft(value);
}
