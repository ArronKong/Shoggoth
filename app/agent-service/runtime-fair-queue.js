"use strict";

// Capacity and per-conversation FIFO are checked by admission, not by this
// ordering policy. Blocked candidates do not consume a scheduling credit.
const DEFAULT_WEIGHTS = Object.freeze({ chat: 4, kanban: 2, cron: 1, inspiration: 1, compaction: 1 });
class RuntimeFairQueue {
  constructor({ weights = DEFAULT_WEIGHTS, agingMs = 120_000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(agingMs) || agingMs < 1 || Object.keys(weights).length !== 5
      || Object.keys(DEFAULT_WEIGHTS).some(source => !Number.isInteger(weights[source])
        || weights[source] < 1 || weights[source] > 16)) throw new Error("Invalid fair queue policy");
    this.weights = Object.freeze({ ...weights });
    this.agingMs = agingMs;
    this.now = now;
    this.finish = new Map(Object.keys(weights).map(source => [source, 0]));
  }
  order(runs, enqueuedAt) {
    const now = this.now();
    const time = run => {
      const value = enqueuedAt(run);
      return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, now) : now;
    };
    return runs.map((run, index) => ({ run, index, at: time(run),
      finish: (this.finish.get(run.source) ?? 0) + 1 / (this.weights[run.source] || 1) }))
      .sort((a, b) => {
        const aOld = now - a.at >= this.agingMs, bOld = now - b.at >= this.agingMs;
        return Number(bOld) - Number(aOld)
          || (aOld ? a.at - b.at : a.finish - b.finish)
          || a.at - b.at || a.index - b.index;
      }).map(entry => entry.run);
  }
  admitted(run, competingSources) {
    const present = new Set(competingSources);
    present.add(run.source);
    // Idle classes rejoin at the current virtual time instead of accumulating
    // an unbounded burst of credits during a long absence.
    const floor = Math.min(...[...present].map(source => this.finish.get(source) ?? 0));
    for (const [source, value] of this.finish) if (!present.has(source)) this.finish.set(source, Math.max(value, floor));
    this.finish.set(run.source, (this.finish.get(run.source) ?? 0) + 1 / (this.weights[run.source] || 1));
  }
}
module.exports = { RuntimeFairQueue, DEFAULT_WEIGHTS };
