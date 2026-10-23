"use strict";
const { digest, fail } = require("./proactive-service-protocol");
const { notificationPolicy } = require("./notification-policy");
function noticeMessage(notice) {
  const label = value => (value || "灵感便签").replace(/\s+/gu, " ").replace(/[\\\[\]()*_`<>]/gu, "\\$&");
  const links = notice.items.map(item => `- [${label(item.title)}](${item.href.startsWith("/") ? `#${item.href}` : item.href})`).join("\n");
  return `${notice.body}\n\n${links}`;
}

class NoticeDeliveryController {
  constructor({ store, productStore, chatSessionStore, transcriptStore, readConfig, sendSystemNotice,
    isFocused = () => false, validateNotice, onPublished = () => {}, resolveWorkspace = () => null, now = Date.now }) {
    this.store = store; this.products = productStore; this.sessions = chatSessionStore; this.transcripts = transcriptStore;
    this.readConfig = readConfig; this.sendSystemNotice = sendSystemNotice; this.isFocused = isFocused;
    this.validateNotice = validateNotice; this.onPublished = onPublished; this.resolveWorkspace = resolveWorkspace;
    this.now = now; this.tails = new Map(); this.closed = false;
  }
  open() { this.closed = false; }
  close() { this.closed = true; }
  #target(notice) {
    let target;
    if (notice.target.mode === "explicit") target = this.sessions.getSession(notice.target.sessionKey);
    else {
      let binding = this.store.getTarget(notice.profileId);
      if (binding?.deleted) fail("PROACTIVE_TARGET_DELETED");
      if (binding?.sessionKey) {
        target = this.sessions.getSession(binding.sessionKey);
        if (!target) {
          this.store.setTarget(notice.profileId, { ...binding, deleted: true });
          fail("PROACTIVE_TARGET_DELETED");
        }
      } else {
        binding ??= this.store.setTarget(notice.profileId, { operationId: `proactive-target-${digest(notice.profileId)}`,
          profileId: notice.profileId, sessionKey: null, createdAt: this.now(), deleted: false });
        const operation = this.sessions.getCreateOperation(binding.operationId);
        if (operation?.state === "deleted") {
          this.store.setTarget(notice.profileId, { ...binding, deleted: true }); fail("PROACTIVE_TARGET_DELETED");
        }
        target = this.sessions.createSession({ operationId: binding.operationId, profileId: notice.profileId,
          workspace: this.resolveWorkspace(notice.profileId), createdAt: operation?.createdAt ?? binding.createdAt });
        this.store.setTarget(notice.profileId, { ...binding, sessionKey: target.sessionKey });
      }
    }
    if (!target || target.profileId !== notice.profileId || !["draft", "ready"].includes(target.status)) fail("PROACTIVE_TARGET_INVALID");
    return target;
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
          this.transcripts.appendEvent({ profileId: notice.profileId, sessionId: session.id, id: eventId,
            runId: null, kind: "assistant", occurredAt: notice.createdAt, contextExcluded: true,
            content: { text: noticeMessage(notice), proactiveNotice: { id: notice.id, kind: notice.kind, title: notice.title, items: notice.items } } });
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
module.exports = { NoticeDeliveryController, noticeMessage };
