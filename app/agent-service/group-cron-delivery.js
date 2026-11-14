"use strict";

const { cronFinalAnswer } = require("./cron-output-policy");
const { transcriptEventId } = require("./transcript-store");
const { redactGrantTokens } = require("./group-tool-grant");

class GroupCronDelivery {
  constructor({ cronStore, groupChat, dispatcher, sessions, transcripts, getCronOutput, assertSecretSafe, onError }) {
    this.cronStore = cronStore;
    this.groupChat = groupChat;
    this.dispatcher = dispatcher;
    this.sessions = sessions;
    this.transcripts = transcripts;
    this.getCronOutput = getCronOutput;
    this.assertSecretSafe = assertSecretSafe;
    this.onError = onError;
  }

  // Resume an already admitted run with the input it actually received.
  recoverPrompt({ run, job, prompt, operationId }) {
    const target = job.groupDelivery;
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
    return prompt;
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
      const output = this.getCronOutput(run, events);
      if (!output) return;
      const answer = output.disposition === "deliver" ? cronFinalAnswer(events.filter(event => !event.contextExcluded), display) : null;
      let text = answer?.content.text.trim() ? redactGrantTokens(answer.content.text) : null;
      if (text !== null) {
        try {
          const safe = this.assertSecretSafe({ text }, { runId: run.id, kind: "fullText" });
          if (safe === false || safe?.then) text = null;
        } catch { text = null; }
      }
      this.groupChat.publishCronReply({ target, profileId: run.profileId, jobId: job.id, runId: run.id, text });
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
