"use strict";

const path = require("node:path");
const { openDatabase, transaction } = require("./inspiration-database");
const { serviceError } = require("./security");

const ONE_SHOT_GRACE_MS = 120_000;
const RECOVERY_REASONS = new Set(["catch-up", "missed", "expired"]);

function validScheduleRecovery(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 4
    && ["reason", "decidedAt", "coalescedCount", "countCapped"].every(key => Object.hasOwn(value, key))
    && RECOVERY_REASONS.has(value.reason)
    && Number.isSafeInteger(value.decidedAt) && value.decidedAt >= 0
    && Number.isSafeInteger(value.coalescedCount) && value.coalescedCount >= 0
    && typeof value.countCapped === "boolean"
    && (value.reason !== "expired" || (value.coalescedCount === 0 && !value.countCapped));
}

class NativeCronRecoveryStore {
  constructor(paths) {
    this.file = path.join(paths.stateDir, "native-cron-recovery-v1.sqlite");
    this.db = null;
  }

  open(existingJobs) {
    const db = openDatabase(this.file);
    try {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (version === 0) {
        // Freeze the upgrade boundary under the Cron writer lease. A clock
        // change or a backdated creation request cannot make a new job legacy.
        transaction(db, () => {
          db.exec(`
            CREATE TABLE legacy_jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
            CREATE TABLE decisions (
              job_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
              run_id TEXT NOT NULL, run_key TEXT NOT NULL,
              reason TEXT NOT NULL, decided_at INTEGER NOT NULL,
              coalesced_count INTEGER NOT NULL, count_capped INTEGER NOT NULL,
              PRIMARY KEY (job_id, scheduled_at),
              UNIQUE (run_id)
            );
            PRAGMA user_version = 1;
          `);
          const insertLegacy = db.prepare("INSERT INTO legacy_jobs VALUES (?, ?)");
          for (const { id, createdAt } of existingJobs) insertLegacy.run(id, createdAt);
        });
      } else if (version !== 1) {
        throw serviceError("CRON_STORE_CORRUPT", "Cron 恢复记录版本不受支持");
      }
      this.legacyJob = db.prepare("SELECT 1 FROM legacy_jobs WHERE id = ? AND created_at = ?");
      this.findDecision = db.prepare(`
        SELECT reason, decided_at AS decidedAt, coalesced_count AS coalescedCount, count_capped AS countCapped
        FROM decisions WHERE run_id = ? AND run_key = ? AND job_id = ? AND scheduled_at = ?
      `);
      this.putDecision = db.prepare(`
        INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (job_id, scheduled_at) DO UPDATE SET
          run_id = excluded.run_id, run_key = excluded.run_key, reason = excluded.reason,
          decided_at = excluded.decided_at, coalesced_count = excluded.coalesced_count, count_capped = excluded.count_capped
      `);
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  oneShotExpired(job, now) {
    return job.schedule.kind === "at" && now - job.nextRunAt > ONE_SHOT_GRACE_MS
      && !this.legacyJob.get(job.id, job.createdAt);
  }

  record(run, scheduledAt, recovery) {
    if (!validScheduleRecovery(recovery) || recovery.decidedAt < scheduledAt) {
      throw serviceError("CRON_RUN_CORRUPT", "Cron 恢复决定与计划时间不一致");
    }
    // Write before enqueue, under NativeCronStore's writer lease. Only an
    // exact durable WorkRun can expose this decision in history.
    const { reason, decidedAt, coalescedCount, countCapped } = recovery;
    this.putDecision.run(run.sourceId, scheduledAt, run.id, run.idempotencyKey, reason,
      decidedAt, coalescedCount, Number(countCapped));
  }

  get(run, scheduledAt) {
    if (!this.db) return null;
    const row = this.findDecision.get(run.id, run.idempotencyKey, run.sourceId, scheduledAt);
    if (!row || (row.countCapped !== 0 && row.countCapped !== 1)) return null;
    const recovery = { ...row, countCapped: row.countCapped === 1 };
    if (recovery.reason === "catch-up"
      ? run.status === "skipped"
      : run.status !== "skipped" || run.resultSummary !== "CRON_MISFIRE_SKIPPED") return null;
    return validScheduleRecovery(recovery) && recovery.decidedAt >= scheduledAt ? recovery : null;
  }

  discardUnbound(runs) {
    if (!this.db) return;
    const keys = new Map(runs.map(run => [run.id, run.idempotencyKey]));
    const orphans = this.db.prepare("SELECT run_id, run_key FROM decisions").all()
      .filter(row => keys.get(row.run_id) !== row.run_key);
    if (orphans.length > 0) {
      const remove = this.db.prepare("DELETE FROM decisions WHERE run_id = ?");
      transaction(this.db, () => {
        for (const row of orphans) remove.run(row.run_id);
      });
    }
  }
}

module.exports = { NativeCronRecoveryStore, validScheduleRecovery };
