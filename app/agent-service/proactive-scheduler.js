"use strict";
const { CronExpressionParser } = require("cron-parser");
const { normalizeSchedule } = require("./native-cron-store");

function latestOccurrence(schedule, now) {
  const value = normalizeSchedule(schedule);
  if (value.kind === "every") return now < value.anchorMs ? null : value.anchorMs + Math.floor((now - value.anchorMs) / value.everyMs) * value.everyMs;
  if (value.kind === "at") return value.at <= now ? value.at : null;
  try { return CronExpressionParser.parse(value.expr, { currentDate: new Date(now + 1), tz: value.tz }).prev().getTime(); }
  catch { return null; }
}
class ProactiveScheduler {
  constructor({ store, service, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
    this.store = store; this.service = service; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.onError = onError; this.timer = null; this.opened = false; this.generation = 0; this.inFlight = new Map(); this.ticks = new Set();
  }
  async open() { this.opened = true; this.generation++; this.service.scheduler = this; await this.tick({ recovery: true }); }
  async close() { this.opened = false; this.generation++; if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  wake() { if (this.opened) { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.#arm(0); } }
  #arm(delay = null) {
    if (!this.opened || this.timer !== null) return;
    const now = this.now();
    const times = this.store.monitors().filter(value => value.config.enabled && value.nextRunAt !== null).map(value => value.nextRunAt);
    if (this.store.outbox().length) times.push(now + 60_000);
    for (const value of this.store.pendingOccurrences()) if (value.state === "deferred") times.push(value.deferredUntil ?? now);
    if (delay === null && !times.length) return;
    const generation = this.generation;
    this.timer = this.setTimer(() => { this.timer = null; if (this.opened && generation === this.generation) void this.tick().catch(this.onError); },
      delay ?? Math.max(100, Math.min(60_000, Math.min(...times) - now)));
    this.timer?.unref?.();
  }
  tick(options = {}) {
    const task = this.#tick(options); this.ticks.add(task);
    void task.finally(() => this.ticks.delete(task)).catch(() => {}); return task;
  }
  async #tick({ recovery = false } = {}) {
    if (!this.opened) return;
    const generation = this.generation;
    if (this.timer !== null) this.clearTimer(this.timer); this.timer = null;
    const now = this.now();
    await this.service.delivery.recover();
    if (!this.opened || this.generation !== generation) return;
    const pending = this.store.pendingOccurrences();
    for (const value of pending) if (value.state !== "deferred" || (value.deferredUntil ?? 0) <= now) this.#dispatch(value, recovery);
    for (const monitor of this.store.due(now)) {
      const scheduledAt = latestOccurrence(monitor.config.schedule, now);
      if (scheduledAt === null) continue;
      const occurrence = this.store.claimOccurrence(monitor.config.id, scheduledAt, now);
      if (!occurrence) continue;
      if (this.inFlight.has(monitor.config.id) || pending.some(value => value.monitorId === monitor.config.id && value.state === "deferred")) {
        this.store.updateOccurrence(occurrence.id, { state: "skipped", reason: "merged_into_active_check", finishedAt: now });
      } else this.#dispatch(occurrence, recovery);
    }
    this.#arm();
  }
  #dispatch(occurrence, recovery) {
    if (this.inFlight.has(occurrence.monitorId)) return;
    const generation = this.generation;
    const task = Promise.resolve().then(() => {
      if (this.opened && this.generation === generation) return this.service.check(occurrence, { recovery });
    }).catch(error => {
      if (this.opened && this.generation === generation) {
        this.store.updateOccurrence(occurrence.id, { state: "failed", reason: error?.code || "check_failed", finishedAt: this.now() });
        this.onError(error);
      }
    }).finally(() => {
      if (this.inFlight.get(occurrence.monitorId) === task) this.inFlight.delete(occurrence.monitorId);
      if (this.opened && this.generation === generation) this.#arm();
    });
    this.inFlight.set(occurrence.monitorId, task);
  }
  async waitForIdle() {
    while (this.ticks.size || this.inFlight.size) await Promise.allSettled([...this.ticks, ...this.inFlight.values()]);
  }
}
module.exports = { ProactiveScheduler, latestOccurrence };
