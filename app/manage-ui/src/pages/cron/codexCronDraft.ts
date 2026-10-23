import type { CodexCronJobInput, UnifiedCronJob } from "../../types";
export interface CodexCronDraft {
  name: string;
  prompt: string;
  enabled: boolean;
  kind: "cron" | "heartbeat";
  rrule: string;
  model: string;
  reasoningEffort: string;
  cwd: string;
  executionEnvironment: "local" | "worktree";
  targetThreadId: string;
}
export function emptyCodexCronDraft(): CodexCronDraft {
  return { name: "", prompt: "", enabled: false, kind: "cron", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    model: "", reasoningEffort: "", cwd: "~", executionEnvironment: "local", targetThreadId: "" };
}
export function codexDraftFromJob(job: UnifiedCronJob): CodexCronDraft {
  return { ...emptyCodexCronDraft(), name: job.name, prompt: job.prompt || "", enabled: job.enabled,
    kind: job.codex?.kind || "cron", rrule: job.schedule.kind === "rrule" ? job.schedule.rrule : "",
    model: job.model || "", reasoningEffort: job.reasoningEffort || "", cwd: job.codex?.cwd || "",
    executionEnvironment: job.codex?.executionEnvironment === "worktree" ? "worktree" : "local", targetThreadId: job.codex?.targetThreadId || "" };
}
export function codexInputFromDraft(draft: CodexCronDraft, backendId: string, agentId: string): CodexCronJobInput {
  if (!draft.name.trim() || !draft.prompt.trim() || !draft.rrule.trim()
    || (draft.kind === "cron" && !draft.cwd.trim()) || (draft.kind === "heartbeat" && !draft.targetThreadId.trim())) throw new Error("codexAutomation.required");
  return { backendId, agentId, origin: "codex-desktop", kind: draft.kind, name: draft.name.trim(), prompt: draft.prompt,
    enabled: draft.enabled, schedule: { kind: "rrule", rrule: draft.rrule.trim() },
    ...(draft.kind === "cron" ? { model: draft.model || null, reasoningEffort: draft.reasoningEffort || null,
      cwd: draft.cwd.trim(), executionEnvironment: draft.executionEnvironment } : { targetThreadId: draft.targetThreadId.trim() }) };
}
export function codexPatchFromDraft(draft: CodexCronDraft, job: UnifiedCronJob): Record<string, unknown> {
  const input = codexInputFromDraft({ ...draft, cwd: draft.cwd || "preserve" }, job.backendId, job.agentId || "");
  const { backendId, agentId, origin, kind, ...patch } = input;
  // A legacy multi-directory or project-owned target is preserved during unrelated edits.
  if (!job.codex?.cwd || job.codex?.target?.type !== "projectless") { delete patch.cwd; delete patch.executionEnvironment; }
  return { ...patch, revision: job.revision };
}
