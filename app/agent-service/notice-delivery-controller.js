"use strict";
const { digest, fail } = require("./proactive-service-protocol");
const { notificationPolicy } = require("./notification-policy");
const { initialRuntimePermissionMode } = require("./runtime-permission-modes");
function noticeMessage(notice) {
  const label = value => (value || "灵感便签").replace(/\s+/gu, " ").replace(/[\\\[\]()*_`<>]/gu, "\\$&");
  const links = notice.items.map(item => `- [${label(item.title)}](${item.href.startsWith("/") ? `#${item.href}` : item.href})`).join("\n");
  return `${notice.body}\n\n${links}`;
}

// Only the delivery controller writes this runless publication identity. A
// background review, imported reply or user-supplied lookalike is not a notice.
function isPublishedNoticeEvent(event) {
  const notice = event?.content?.proactiveNotice;
  return event?.kind === "assistant" && event.runId === null && event.runtimeRef === null
    && typeof notice?.id === "string" && /^notice-[a-f0-9]{64}$/u.test(notice.id)
    && event.id === `proactive-${notice.id}` && ["heartbeat", "inspiration"].includes(notice.kind)
    && typeof event.content.text === "string" && event.content.text.trim().length > 0
    && Array.isArray(notice.items) && notice.items.length > 0;
}

const proactiveTranscriptId = runId => `proactive-run-${digest(runId)}`;

class NoticeDeliveryController {
  constructor({ store, productStore, chatSessionStore, transcriptStore, readConfig, sendSystemNotice,
    isFocused = () => false, validateNotice, onPublished = () => {}, resolveWorkspace = () => null,
    resolveRunSession = () => null, now = Date.now }) {
    this.store = store; this.products = productStore; this.sessions = chatSessionStore; this.transcripts = transcriptStore;
    this.readConfig = readConfig; this.sendSystemNotice = sendSystemNotice; this.isFocused = isFocused;
    this.validateNotice = validateNotice; this.onPublished = onPublished; this.resolveWorkspace = resolveWorkspace;
    this.resolveRunSession = resolveRunSession;
    this.now = now; this.tails = new Map(); this.closed = false;
  }
  open() { this.closed = false; }
  close() { this.closed = true; }
  ensureMainSession(profileId) {
    let binding = this.store.getTarget(profileId);
    if (binding?.deleted) return null;
    if (binding?.sessionKey) {
      const session = this.sessions.getSession(binding.sessionKey);
      if (!session) this.store.setTarget(profileId, { ...binding, deleted: true });
      if (session && session.profileId !== profileId) fail("PROACTIVE_TARGET_INVALID");
      return session;
    }
    // An existing reminder target is authoritative. If this Agent never had
    // one, adopt the original default chat before creating a new Main session.
    if (!binding) {
      const legacy = this.sessions.getLegacyDefaultSession?.(profileId);
      binding = this.store.setTarget(profileId, { operationId: `proactive-target-${digest(profileId)}`,
        profileId, sessionKey: legacy?.sessionKey ?? null, createdAt: legacy?.createdAt ?? this.now(), deleted: false });
      if (legacy) return legacy;
    }
    const operation = this.sessions.getCreateOperation(binding.operationId);
    if (operation?.state === "deleted") {
      this.store.setTarget(profileId, { ...binding, deleted: true });
      return null;
    }
    const profile = this.products.getAgentProfile(profileId);
    const session = this.sessions.createSession({ operationId: binding.operationId, profileId,
      permissionMode: initialRuntimePermissionMode(profile?.runtime || "codex"),
      workspace: operation ? operation.workspace : this.resolveWorkspace(profileId, binding.operationId),
      createdAt: operation?.createdAt ?? binding.createdAt });
    this.store.setTarget(profileId, { ...binding, sessionKey: session.sessionKey });
    return session;
  }
  #target(notice) {
    const runId = this.store.getOccurrence(notice.occurrenceId)?.runId;
    const sessionKey = runId && this.resolveRunSession(runId);
    if (sessionKey) {
      const session = this.sessions.getSession(sessionKey);
      if (!session || session.profileId !== notice.profileId || !["draft", "ready"].includes(session.status)) fail("PROACTIVE_TARGET_INVALID");
      return session;
    }
    const explicit = notice.target.mode === "explicit";
    const target = explicit ? this.sessions.getSession(notice.target.sessionKey) : this.ensureMainSession(notice.profileId);
    if (!explicit && !target) fail("PROACTIVE_TARGET_DELETED");
    if (!target || target.profileId !== notice.profileId || !["draft", "ready"].includes(target.status)) fail("PROACTIVE_TARGET_INVALID");
    return target;
  }
  publishedEvent(noticeId, sessionKey) {
    const session = this.sessions.getSession(sessionKey);
    if (!session) fail("PROACTIVE_TARGET_INVALID");
    const event = this.transcripts.getEvent(session.profileId, session.id, `proactive-${noticeId}`);
    if (!isPublishedNoticeEvent(event)) fail("PROACTIVE_NOT_FOUND");
    return { event, profileId: session.profileId };
  }
  deliver(noticeId) {
    const prior = this.tails.get(noticeId) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.#deliver(noticeId)); this.tails.set(noticeId, task);
    void task.finally(() => { if (this.tails.get(noticeId) === task) this.tails.delete(noticeId); }).catch(() => {});
    return task;
  }
  async #deliver(noticeId) {
    if (this.closed) return;
    let notice = this.store.getNotice(noticeId); if (!notice) return;
    if (notice.systemState === "submitting") {
      notice = this.store.updateNotice(notice.id, { systemState: "needs_verification", systemReason: "send_acceptance_unknown" });
    }
    if (["pending", "publishing"].includes(notice.appState)) {
      try {
        if (notice.appState === "pending" && !this.validateNotice(notice)) {
          return this.store.updateNotice(notice.id, { appState: "suppressed", systemState: "suppressed", systemReason: "source_or_monitor_changed" });
        }
        const session = this.#target(notice);
        this.transcripts.ensureSession({ profileId: notice.profileId, sessionId: session.id });
        const eventId = `proactive-${notice.id}`;
        const existing = this.transcripts.listEvents(notice.profileId, session.id).find(event => event.id === eventId);
        if (existing) {
          if (existing.content?.proactiveNotice?.id !== notice.id) fail("PROACTIVE_RESPONSE_INVALID");
        } else {
          if (this.closed || !this.validateNotice(notice)) {
            return this.store.updateNotice(notice.id, { appState: "suppressed", systemState: "suppressed", systemReason: "source_or_monitor_changed" });
          }
          notice = this.store.updateNotice(notice.id, { appState: "publishing", sessionKey: session.sessionKey });
          const runId = this.store.getOccurrence(notice.occurrenceId)?.runId;
          this.transcripts.appendEvent({ profileId: notice.profileId, sessionId: session.id, id: eventId,
            runId: null, kind: "assistant", occurredAt: notice.createdAt, contextExcluded: false,
            content: { text: noticeMessage(notice), proactiveNotice: { id: notice.id, kind: notice.kind, title: notice.title, items: notice.items,
              ...(runId ? { reviewRunId: runId } : {}) } } });
        }
        this.sessions.touchSession(session.sessionKey, notice.createdAt);
        notice = this.store.updateNotice(notice.id, { appState: "published", sessionKey: session.sessionKey });
        this.onPublished(notice);
      } catch (error) {
        const uncertain = error?.committedUncertain || /(?:UNCERTAIN|IOERR)/u.test(error?.code || "");
        return this.store.updateNotice(notice.id, { appState: uncertain ? "needs_verification" : "failed",
          systemState: "suppressed", systemReason: error?.code || "app_publication_failed" });
      }
    }
    if (notice.appState !== "published" || notice.systemState !== "pending" || this.closed) return notice;
    if (!this.validateNotice(notice)) return this.store.updateNotice(notice.id, { systemState: "suppressed", systemReason: "source_or_monitor_changed" });
    const policy = notificationPolicy({ config: this.readConfig(), category: "proactive", focused: await this.isFocused(), now: this.now() });
    if (this.closed) return notice;
    if (!this.validateNotice(notice)) return this.store.updateNotice(notice.id, { systemState: "suppressed", systemReason: "source_or_monitor_changed" });
    if (!policy.allowed) return this.store.updateNotice(notice.id, { systemState: policy.reason === "quiet_hours" ? "pending" : "suppressed", systemReason: policy.reason });
    if (typeof this.sendSystemNotice !== "function") return this.store.updateNotice(notice.id, { systemState: "failed", systemReason: "notification_host_unavailable" });
    notice = this.store.beginSystemSubmission(notice.id, this.now());
    if (!notice) return this.store.getNotice(noticeId);
    try {
      const receipt = await this.sendSystemNotice({ noticeId: notice.id, category: "proactive", title: notice.title,
        body: notice.items.map(item => item.title).filter(Boolean).slice(0, 5).join(" · ").slice(0, 240) || notice.body.slice(0, 240),
        target: { kind: "chat", backendId: this.products.getAgentProfile(notice.profileId)?.backendId,
          agentId: this.products.getAgentProfile(notice.profileId)?.agentId, profileId: notice.profileId, sessionKey: notice.sessionKey } });
      if (receipt?.state === "suppressed") return this.store.updateNotice(notice.id, { systemState: "suppressed", systemReason: receipt.reason });
      if (receipt?.state !== "submitted") return this.store.updateNotice(notice.id, { systemState: "needs_verification", systemReason: "send_acceptance_unknown" });
      return this.store.updateNotice(notice.id, { systemState: "submitted", systemReason: null });
    } catch (error) {
      return this.store.updateNotice(notice.id, { systemState: error?.submitted === false ? "failed" : "needs_verification",
        systemReason: error?.code || "send_acceptance_unknown" });
    }
  }
  async recover() { for (const notice of this.store.outbox()) await this.deliver(notice.id); }
}
module.exports = { NoticeDeliveryController, noticeMessage, isPublishedNoticeEvent, proactiveTranscriptId };
