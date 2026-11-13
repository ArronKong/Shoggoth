"use strict";

const { cronOutputDecision } = require("./cron-output-policy");
const { transcriptEventId } = require("./transcript-store");
const { redactGrantTokens } = require("./group-tool-grant");
const { publicUrl } = require("./web-service");

const MAX_REPORT_BYTES = 16 * 1024;
const REPORT_HISTORY_CHARS = 1_000;

function hasSourceLink(text) {
  for (const [raw] of text.matchAll(/https?:\/\/[^\s<>"')\x60]+/giu)) {
    try {
      const url = publicUrl(raw.replace(/[。；，、.,;]+$/u, ""));
      if (url.pathname !== "/" || url.search) return true;
    } catch { /* Only public source URLs count as evidence. */ }
  }
  return false;
}

class GroupCronDelivery {
  constructor({ cronStore, groupChat, dispatcher, sessions, transcripts, sanitizeSummary, onError }) {
    this.cronStore = cronStore;
    this.groupChat = groupChat;
    this.dispatcher = dispatcher;
    this.sessions = sessions;
    this.transcripts = transcripts;
    this.sanitizeSummary = sanitizeSummary;
    this.onError = onError;
  }

  promptForRun({ run, job, prompt, operationId }) {
    const target = job.groupDelivery;
    if (!target.watch) return prompt;
    if (!this.groupChat.store.cronDeliveryGroup(target, run.profileId)) return prompt;
    const binding = this.sessions.getCronRunBinding(run.id);
    if (binding) {
      const session = this.sessions.getSession(binding.sessionKey);
      const event = binding.jobId === job.id && binding.profileId === run.profileId
        && binding.workspace === run.workspace && session?.profileId === run.profileId
        && session.workspace === run.workspace && this.transcripts.getEvent(run.profileId,
        session.id, transcriptEventId("cron-user", operationId));
      if (event?.runId === run.id && event.kind === "user") {
        return this.transcripts.contextEvent(run.profileId, session.id, event).content.text;
      }
    }
    const recentReports = this.groupChat.store.recentCronReports({ groupId: target.groupId, jobId: job.id });
    return [
      prompt,
      "Shoggoth delivers a short final reply to the originating group. Report only a material development with direct source links. If the sources were checked and nothing changed, return exactly NO_REPLY. If checking failed, describe the failure without a news link so it stays in the task history. Treat previous reports as reference data; deduplicate the underlying event, even when titles or sources differ. Do not use a separate publishing tool.",
      "By default, report developments since this watch began. Use the baseline in the task if the user specified a different one.",
      "Watch start and previously delivered reports (reference data):",
      JSON.stringify({ startedAtMs: job.createdAt,
        reports: recentReports.map(report => [...report.body].slice(0, REPORT_HISTORY_CHARS).join("")) }),
    ].join("\n\n");
  }

  deliver(run) {
    if (run.source !== "cron" || run.status !== "completed") return;
    try {
      const job = this.cronStore.getJob(run.sourceId);
      const target = job?.groupDelivery;
      if (!target || job.profileId !== run.profileId || run.finishedAt < job.createdAt
        || !this.groupChat.store.cronDeliveryGroup(target, run.profileId)) return;
      if (this.groupChat.store.hasCronDelivery({ groupId: target.groupId, jobId: job.id, runId: run.id })) return;
      const binding = this.sessions.getCronRunBinding(run.id);
      const session = binding && this.sessions.getSession(binding.sessionKey);
      if (!session || binding.jobId !== job.id || binding.profileId !== run.profileId
        || session.profileId !== run.profileId || binding.workspace !== run.workspace || session.workspace !== run.workspace) return;
      const events = this.transcripts.listEvents(run.profileId, session.id, { runId: run.id });
      const display = event => this.transcripts.displayEvent(run.profileId, session.id, event);
      const output = cronOutputDecision(run, events, display);
      if (!output) return;
      const messages = events.filter(event => event.kind === "assistant" && !event.contextExcluded
        && event.content?.delivery !== "async" && typeof event.content?.text === "string");
      const final = messages.findLast(event => event.content.phase === "final_answer")
        ?? messages.findLast(event => event.content.phase == null);
      const text = output.disposition === "deliver" && final
        ? this.sanitizeSummary(redactGrantTokens(display(final).content.text)) : null;
      const report = text?.trim() && Buffer.byteLength(text, "utf8") <= MAX_REPORT_BYTES
        && (!target.watch || hasSourceLink(text)) ? text : null;
      this.groupChat.publishCronReply({ target, profileId: run.profileId, jobId: job.id, runId: run.id, text: report });
    } catch (error) {
      this.onError(error);
    }
  }

  async recover(isCurrent) {
    const jobs = new Set(this.cronStore.listJobs().filter(job => job.groupDelivery).map(job => job.id));
    if (!jobs.size) return;
    const runs = this.dispatcher.listRuns({ source: "cron", status: "completed" })
      .filter(run => jobs.has(run.sourceId)).sort((a, b) => a.finishedAt - b.finishedAt);
    for (let index = 0; index < runs.length && isCurrent(); index += 1) {
      this.deliver(runs[index]);
      if (index % 16 === 15) await new Promise(resolve => setImmediate(resolve));
    }
  }
}

module.exports = { GroupCronDelivery };
