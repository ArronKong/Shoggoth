"use strict";

const { validResponseMetadata } = require("../chat-response-metadata");

const path = require("node:path");
const crypto = require("node:crypto");
const { parseReplyHeader } = require("./group-reply-format");
const { openDatabase, transaction } = require("./inspiration-database");
const { preparePrivateParent, fsyncPrivateParent } = require("./private-file");
const { acquirePrivateWriterLease } = require("./private-writer-lease");
const { fail, MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS_ON_CREATE } = require("./group-chat-protocol");
const { GROUP_TURN_OPERATION_PREFIX } = require("./group-chat-run");
const { isPassReply, parseMentions, uniqueHandle } = require("./group-mentions");
const { parseGrantToken, sameDigest } = require("./group-tool-grant");
const { resultPage, sha256, validText } = require("../group-result-content");
const { groupSendPayloadDigest } = require("../group-send-payload");
const { validModelSelection } = require("../group-member-model");
const { DEFAULT_AGENT_PROFILE_ID } = require("./product-store");
const { ROUND_LIMITS, currentOwner, defaultOwner, insertCalls, openingSpeakers } = require("./group-rounds");

// 群聊权威存储：独立 SQLite，事务与私有 writer lease 规范同 inspirations.sqlite；群日志顺序以服务端 seq 为准。
// 发言机制（单一机制，见 docs/architecture/group-room-single-mechanism-2026-10-17.md）：
//   一条消息开一轮（discussions 表），轮里的发言位是 opportunities 表的行，全群同一时间只有一位持有发言位。
//   普通消息群主先答；回复里 @ 了谁，谁就插到下一位；没话说就 (pass)。
//   开始用工具一段时间后让出发言位，活在后台继续；结果交回时作为该成员的消息发群，并请派活者回应。
const MAIN_THREAD = "main";
const DISCUSSION_PURPOSE = "group_discussion";
const MAX_MEMBER_REPLY_BYTES = 64 * 1024;
const MAX_REPLY_EXCERPT_BYTES = 600;

function replySnapshot(quoted) {
  return { seq: quoted.seq, messageId: quoted.id, author: quoted.author,
    excerpt: utf8Prefix(quoted.body, MAX_REPLY_EXCERPT_BYTES),
    ...(quoted.attachments?.length ? { attachments: quoted.attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) } : {}) };
}

const OPERATION_RETENTION_MS = 30 * 86_400_000;
const DEFAULT_LIMITS = Object.freeze({ maxQueuedTurnsPerGroup: 128, maxQueuedTurnsPerMember: 16 });
// 成员第一次在群里发言时看最近 12 条；之后看自上次以来别人的新消息，最多 24 条，其中本轮开始前的最多 8 条。
const FIRST_LOOK = 12;
const DELTA_MAX = 24;
const EARLIER_MAX = 8;
// 成员每次在群里只能有一个回合在跑；结束这些原因的回合都是用户主动停下。
const USER_STOPS = new Set(["GROUP_DISCUSSION_STOPPED", "GROUP_MEMBER_STOPPED", "GROUP_MEMBER_REMOVED", "GROUP_DELETED"]);
const LEGACY_RETIRED = "GROUP_UPGRADE_RETIRED";

const MEMBER_CARDS_SCHEMA = `CREATE TABLE member_cards(member_id TEXT PRIMARY KEY REFERENCES members(id),
  group_id TEXT NOT NULL REFERENCES groups(id), data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX member_cards_group ON member_cards(group_id);`;
const TASKS_SCHEMA = `CREATE TABLE tasks(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL, target_member_id TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX tasks_group ON tasks(group_id, created_at);
CREATE INDEX tasks_status ON tasks(status, created_at);`;
const RESULTS_SCHEMA = `CREATE TABLE message_results(message_id TEXT PRIMARY KEY REFERENCES messages(id),
  body TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL);`;
const ROLE_SNAPSHOTS_SCHEMA = `CREATE TABLE role_snapshots(id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
  group_id TEXT NOT NULL REFERENCES groups(id), created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), body TEXT NOT NULL);
CREATE INDEX role_snapshots_member ON role_snapshots(group_id,member_id,created_at);
CREATE TABLE role_summaries(id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));`;
const DELIVERY_SCHEMA = `CREATE TABLE message_deliveries(group_id TEXT NOT NULL, member_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id), seq INTEGER NOT NULL, complete INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(group_id,member_id,message_id));
CREATE INDEX message_deliveries_coverage ON message_deliveries(group_id,member_id,seq,complete);`;
// v10 起的新库只建本机制用到的表。旧库升级时保留旧表（任务、协作、交付覆盖），只是不再读写。
const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE groups(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX groups_page ON groups(status, updated_at DESC, id);
CREATE TABLE members(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), position INTEGER NOT NULL,
  state TEXT NOT NULL, handle TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(group_id, position), UNIQUE(group_id, handle));
CREATE TABLE messages(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), seq INTEGER NOT NULL,
  origin_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(group_id, seq), UNIQUE(group_id, origin_key));
CREATE TABLE discussions(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), status TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX discussions_group ON discussions(group_id, created_at DESC, id);
CREATE TABLE opportunities(id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  discussion_id TEXT NOT NULL REFERENCES discussions(id), member_id TEXT NOT NULL REFERENCES members(id),
  state TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX opportunities_queue ON opportunities(group_id, state, ordinal);
CREATE INDEX opportunities_discussion ON opportunities(discussion_id, state, ordinal);
CREATE TABLE session_bindings(group_id TEXT NOT NULL REFERENCES groups(id), member_id TEXT NOT NULL REFERENCES members(id),
  thread_id TEXT NOT NULL, purpose TEXT NOT NULL, profile_id TEXT NOT NULL, session_key TEXT UNIQUE,
  watermark INTEGER NOT NULL, external TEXT CHECK(external IS NULL OR json_valid(external)),
  delivery_scan_seq INTEGER NOT NULL DEFAULT 0, coverage_start_seq INTEGER NOT NULL DEFAULT 0,
  coverage_unknown_before INTEGER,
  PRIMARY KEY(group_id, member_id, thread_id, purpose));
CREATE TABLE operations(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)));
${MEMBER_CARDS_SCHEMA}
${RESULTS_SCHEMA}
${ROLE_SNAPSHOTS_SCHEMA}
PRAGMA user_version=10;
`;
const MIGRATION_V2 = `${MEMBER_CARDS_SCHEMA}
PRAGMA user_version=2;
`;
const MIGRATION_V3 = `ALTER TABLE session_bindings ADD COLUMN external TEXT CHECK(external IS NULL OR json_valid(external));
PRAGMA user_version=3;
`;
const MIGRATION_V4 = `${TASKS_SCHEMA}
PRAGMA user_version=4;
`;
const MIGRATION_V5 = `${RESULTS_SCHEMA}
PRAGMA user_version=5;`;
const MIGRATION_V6 = `${ROLE_SNAPSHOTS_SCHEMA}
PRAGMA user_version=6;`;
const MIGRATION_V7 = `${DELIVERY_SCHEMA}
ALTER TABLE invitations ADD COLUMN data TEXT CHECK(data IS NULL OR json_valid(data));
ALTER TABLE session_bindings ADD COLUMN delivery_scan_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_bindings ADD COLUMN coverage_start_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_bindings ADD COLUMN coverage_unknown_before INTEGER;
UPDATE session_bindings SET delivery_scan_seq=watermark, coverage_start_seq=watermark,
  coverage_unknown_before=CASE WHEN watermark>0 THEN watermark ELSE NULL END;
PRAGMA user_version=7;`;

const parse = (row) => (row ? JSON.parse(row.data) : null);
const clone = (value) => (value == null ? value : structuredClone(value));
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function utf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}

// 成员换过会话时，放弃的旧会话记在绑定的 external.retired 里：它们仍是群内部会话。
const MAX_RETIRED_SESSIONS = 20;
function retiredSessions(externalJson) {
  if (!externalJson) return [];
  const retired = JSON.parse(externalJson).retired;
  return Array.isArray(retired) ? retired : [];
}

// 写入新的会话信息时保留已放弃的旧会话名单。
function mergeExternal(priorJson, external) {
  if (external === undefined) return priorJson ?? null;
  const retired = retiredSessions(priorJson);
  if (external === null) return retired.length ? JSON.stringify({ retired }) : null;
  return JSON.stringify(retired.length ? { ...external, retired } : external);
}

const ACTIVE_TURN = ["running", "waiting"];
const holdsFloor = (turn) => ACTIVE_TURN.includes(turn.state) && turn.floor && !turn.released;
const waitingForSlot = (turn) => turn.state === "queued" && !turn.released;

class GroupChatStore {
  constructor({ paths, now = Date.now, randomUUID = crypto.randomUUID, database = openDatabase, limits = {} }) {
    this.paths = paths;
    this.now = now;
    this.randomUUID = randomUUID;
    this.openDatabase = database;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    this.filePath = path.join(paths.stateDir, "group-chats.sqlite");
    this.db = null;
    this.lease = null;
    this.poisoned = false;
    this.tables = new Set();
    this.internalSessionKeys = new Set();
  }

  open() {
    if (this.db) return this;
    preparePrivateParent(this.filePath, this.paths.trustedRoot);
    const lease = acquirePrivateWriterLease({
      lockPath: path.join(this.paths.stateDir, "group-chats.writer.lock"),
      trustedRoot: this.paths.trustedRoot,
    });
    try {
      this.db = this.openDatabase(this.filePath);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (!Number.isSafeInteger(version) || version < 0 || version > 10) fail("GROUP_CHAT_STORE_CORRUPT");
      if (version !== 10) {
        transaction(this.db, () => {
          if (version === 0) { this.db.exec(SCHEMA); return; }
          if (version === 1) this.db.exec(MIGRATION_V2);
          if (version <= 2) this.db.exec(MIGRATION_V3);
          if (version < 4) this.db.exec(MIGRATION_V4);
          if (version < 5) this.db.exec(MIGRATION_V5);
          if (version < 6) this.db.exec(MIGRATION_V6);
          if (version < 7) this.db.exec(MIGRATION_V7);
          this.#retireLegacyWork();
          this.db.exec("PRAGMA user_version=10");
        });
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        fsyncPrivateParent(this.paths.stateDir);
      }
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("GROUP_CHAT_STORE_CORRUPT");
      this.tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      this.internalSessionKeys = new Set(this.db.prepare("SELECT session_key, external FROM session_bindings").all()
        .flatMap((row) => [row.session_key, ...retiredSessions(row.external)].filter(Boolean)));
      this.lease = lease;
      this.poisoned = false;
      this.#write(() => {
        if (!this.db.prepare("SELECT value FROM meta WHERE key='authorityId'").get()) {
          this.db.prepare("INSERT INTO meta VALUES('authorityId',?)").run(JSON.stringify(crypto.randomUUID()));
        }
      });
      return this;
    } catch (error) {
      this.db?.close();
      this.db = null;
      lease.release();
      throw error;
    }
  }

  // 升级到单一机制：旧机制里没结束的讨论、发言机会与正式任务一律取消；已在跑的运行记下来，
  // 由驱动启动时中止。旧表、历史消息与任务记录保留，不删。
  #retireLegacyWork() {
    const at = this.now();
    const legacy = [];
    const table = (name) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    for (const row of this.db.prepare("SELECT data FROM opportunities WHERE state IN ('queued','running','waiting')").all()) {
      const turn = parse(row);
      if (turn.state !== "queued" && turn.runId) legacy.push({ runKind: turn.runKind ?? "native", runId: turn.runId,
        sessionKey: turn.sessionKey ?? null, external: turn.external ?? null, id: turn.id });
      Object.assign(turn, { state: "cancelled", errorCode: LEGACY_RETIRED, finishedAt: at });
      this.db.prepare("UPDATE opportunities SET state='cancelled', data=? WHERE id=?").run(JSON.stringify(turn), turn.id);
    }
    for (const row of this.db.prepare("SELECT data FROM discussions WHERE status IN ('running','paused_limit','queued')").all()) {
      const discussion = parse(row);
      Object.assign(discussion, { status: "cancelled", updatedAt: at });
      this.db.prepare("UPDATE discussions SET status='cancelled', data=? WHERE id=?").run(JSON.stringify(discussion), discussion.id);
    }
    if (table("tasks")) {
      for (const row of this.db.prepare("SELECT data FROM tasks WHERE status NOT IN ('succeeded','failed','declined','cancelled')").all()) {
        const task = parse(row);
        for (const attempt of task.attempts ?? []) {
          if (attempt.state === "ended") continue;
          if (attempt.runId) legacy.push({ runKind: attempt.runKind ?? "native", runId: attempt.runId,
            sessionKey: attempt.sessionKey ?? null, external: attempt.external ?? null, id: attempt.id });
          Object.assign(attempt, { state: "ended", endedAt: at, cancelRequested: true });
        }
        Object.assign(task, { status: "cancelled", statusReason: LEGACY_RETIRED, activeAttemptId: null, updatedAt: at });
        this.db.prepare("UPDATE tasks SET status='cancelled', data=? WHERE id=?").run(JSON.stringify(task), task.id);
      }
    }
    for (const row of this.db.prepare("SELECT data FROM groups").all()) {
      const group = parse(row);
      const members = this.db.prepare("SELECT data FROM members WHERE group_id=? ORDER BY position").all(group.id).map(parse);
      // 旧版统筹者是自动选的，还可能停在故障时的临时顺延上；群主按新规则重新确定。
      group.ownerMemberId = group.ownerMemberId ?? defaultOwner(members.filter(member => member.state === "active"),
        DEFAULT_AGENT_PROFILE_ID)?.id ?? null;
      group.lateRounds = 0;
      this.db.prepare("UPDATE groups SET data=? WHERE id=?").run(JSON.stringify(group), group.id);
    }
    if (legacy.length) {
      this.db.prepare("INSERT INTO meta(key,value) VALUES('legacyRetiredRuns',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(legacy));
    }
  }

  close() {
    try {
      if (this.db) {
        try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { this.db.close(); }
      }
    } finally {
      this.db = null;
      this.lease?.release();
      this.lease = null;
    }
  }

  #ready() {
    if (!this.db || !this.lease || this.poisoned) fail("GROUP_CHAT_UNAVAILABLE");
  }

  #write(action) {
    this.#ready();
    try { return transaction(this.db, action); } catch (error) {
      if (/^SQLITE_(IOERR|CORRUPT|NOTADB|FULL)/u.test(error.code || "")) this.poisoned = true;
      throw error;
    }
  }

  #operation(operationId, payload, action) {
    const fingerprint = digest(payload);
    return this.#write(() => {
      const prior = this.db.prepare("SELECT fingerprint, result FROM operations WHERE id=?").get(operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("GROUP_CHAT_OPERATION_CONFLICT");
        return JSON.parse(prior.result);
      }
      // Agent management receipts survive retries after the general operation
      // retention window; forgetting one could create a second group.
      this.db.prepare("DELETE FROM operations WHERE created_at<? AND id NOT LIKE 'agent-management:%'")
        .run(this.now() - OPERATION_RETENTION_MS);
      const result = action();
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?)")
        .run(operationId, this.now(), fingerprint, JSON.stringify(result));
      return clone(result);
    });
  }

  // ---- 行读写 ----

  #group(groupId) {
    return parse(this.db.prepare("SELECT data FROM groups WHERE id=?").get(groupId));
  }

  #requireGroup(groupId, { active = false } = {}) {
    const group = this.#group(groupId);
    if (!group) fail("GROUP_CHAT_NOT_FOUND");
    if (group.status === "deleted") fail("GROUP_CHAT_DELETED");
    if (active && group.status === "deleting") fail("GROUP_CHAT_DELETED");
    if (active && group.status !== "active") fail("GROUP_CHAT_ARCHIVED");
    return group;
  }

  #putGroup(group) {
    this.db.prepare(`INSERT INTO groups(id,status,updated_at,data) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`)
      .run(group.id, group.status, group.updatedAt, JSON.stringify(group));
  }

  #members(groupId, { activeOnly = false } = {}) {
    return this.db.prepare(`SELECT data FROM members WHERE group_id=?${activeOnly ? " AND state='active'" : ""}
      ORDER BY position`).all(groupId).map(parse);
  }

  #member(memberId) {
    return parse(this.db.prepare("SELECT data FROM members WHERE id=?").get(memberId));
  }

  #putMember(member) {
    this.db.prepare(`INSERT INTO members(id,group_id,position,state,handle,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data`)
      .run(member.id, member.groupId, member.position, member.state, member.handle, JSON.stringify(member));
  }

  #round(roundId) {
    return parse(this.db.prepare("SELECT data FROM discussions WHERE id=?").get(roundId));
  }

  #putRound(round) {
    this.db.prepare(`INSERT INTO discussions(id,group_id,status,created_at,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data`)
      .run(round.id, round.groupId, round.status, round.createdAt, JSON.stringify(round));
  }

  #rounds(groupId, statuses) {
    return this.db.prepare(`SELECT data FROM discussions WHERE group_id=? AND status IN (${statuses.map(() => "?").join(",")})
      ORDER BY created_at, rowid`).all(groupId, ...statuses).map(parse);
  }

  #turn(turnId) {
    return parse(this.db.prepare("SELECT data FROM opportunities WHERE id=?").get(turnId));
  }

  #putTurn(turn) {
    this.db.prepare(`INSERT INTO opportunities(id,group_id,discussion_id,member_id,state,ordinal,run_id,data)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, run_id=excluded.run_id,
      data=excluded.data`).run(turn.id, turn.groupId, turn.discussionId, turn.memberId,
      turn.state, turn.ordinal, turn.runId, JSON.stringify(turn));
  }

  #turns(where, ...args) {
    return this.db.prepare(`SELECT data FROM opportunities WHERE ${where} ORDER BY ordinal`).all(...args).map(parse);
  }

  #insertMessage(group, message) {
    const latest = this.db.prepare("SELECT max(seq) AS seq FROM messages WHERE group_id=?").get(group.id).seq ?? 0;
    const seq = Math.max(group.lastSeq, latest) + 1;
    const stored = { ...message, id: message.id ?? this.randomUUID(), groupId: group.id, seq,
      threadId: MAIN_THREAD, createdAt: this.now() };
    this.db.prepare("INSERT INTO messages(id,group_id,seq,origin_key,data) VALUES(?,?,?,?,?)")
      .run(stored.id, group.id, seq, stored.originKey, JSON.stringify(stored));
    group.lastSeq = seq;
    group.updatedAt = stored.createdAt;
    return stored;
  }

  #systemMessage(group, system, originKey = `system:${this.randomUUID()}`) {
    return this.#insertMessage(group, { originKey, author: { kind: "system" }, body: "",
      mentions: { memberIds: [], broadcast: false, unresolved: [] }, system });
  }

  #binding(groupId, memberId) {
    return this.db.prepare(`SELECT * FROM session_bindings WHERE group_id=? AND member_id=? AND thread_id=?
      AND purpose=?`).get(groupId, memberId, MAIN_THREAD, DISCUSSION_PURPOSE) || null;
  }

  #ensureBinding(member) {
    const existing = this.#binding(member.groupId, member.id);
    if (existing) return existing;
    this.db.prepare(`INSERT INTO session_bindings(group_id,member_id,thread_id,purpose,profile_id,session_key,watermark,
      delivery_scan_seq,coverage_start_seq) VALUES(?,?,?,?,?,?,?,?,?)`).run(member.groupId, member.id, MAIN_THREAD, DISCUSSION_PURPOSE,
      member.profileId ?? `${member.backendId}:${member.agentId}`, null, member.joinedSeq, member.joinedSeq, member.joinedSeq);
    return this.#binding(member.groupId, member.id);
  }

  #publicBinding(row) {
    return row && { groupId: row.group_id, memberId: row.member_id, threadId: row.thread_id,
      purpose: row.purpose, profileId: row.profile_id, sessionKey: row.session_key, watermark: row.watermark,
      external: row.external ? JSON.parse(row.external) : null };
  }

  #cards(groupId) {
    return new Map(this.db.prepare("SELECT member_id, data FROM member_cards WHERE group_id=?").all(groupId)
      .map((row) => [row.member_id, JSON.parse(row.data)]));
  }

  #owner(group) {
    return currentOwner(group, this.#members(group.id), this.#cards(group.id));
  }

  // ---- 轮次 ----

  #newTurn(group, round, memberId, { kind, note, calledBy = null, causeMessageIds = [], released = false }) {
    const queued = this.db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE group_id=? AND state='queued'").get(group.id).n;
    const mine = this.db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE member_id=? AND state='queued'").get(memberId).n;
    if (queued >= this.limits.maxQueuedTurnsPerGroup || mine >= this.limits.maxQueuedTurnsPerMember) return null;
    const ordinal = (this.db.prepare("SELECT max(ordinal) AS n FROM opportunities WHERE group_id=?").get(group.id).n ?? 0) + 1;
    const id = this.randomUUID();
    const turn = {
      id, groupId: group.id, discussionId: round.id, memberId, ordinal, kind, note, calledBy,
      causeMessageIds: [...causeMessageIds], state: "queued", floor: false, released,
      releasedReason: released ? "busy" : null, releasedAt: released ? this.now() : null,
      operationId: `${GROUP_TURN_OPERATION_PREFIX}${id}`, runId: null, sessionKey: null, fence: null,
      inputThroughSeq: null, errorCode: null, abortReason: null, resultMessageId: null,
      postedText: null, createdAt: this.now(), startedAt: null, finishedAt: null,
    };
    this.#putTurn(turn);
    return turn;
  }

  #newRound(group, { kind, causeMessage, speakers, notes, calledBy = null, plain = false }) {
    const round = { id: this.randomUUID(), groupId: group.id, threadId: MAIN_THREAD, kind,
      status: this.#rounds(group.id, ["running", "queued"]).length ? "queued" : "running",
      causeMessageId: causeMessage.id, startSeq: causeMessage.seq, order: [], turnCount: 0, plain,
      limit: speakers.length * ROUND_LIMITS.turnsPerOpeningSpeaker, ownerFallback: false, createdAt: this.now(), updatedAt: this.now() };
    this.#putRound(round);
    for (const memberId of speakers) {
      const turn = this.#newTurn(group, round, memberId, { kind: kind === "user" ? "open" : kind, calledBy,
        note: notes(memberId), causeMessageIds: [causeMessage.id] });
      if (turn) round.order.push(turn.id);
    }
    if (!round.order.length) { round.status = "done"; }
    this.#putRound(round);
    return round;
  }

  /**
   * 把一批成员插到轮次里当前位置之后（已在后面排队的提前，并改记为这次叫它）；返回新增的发言位数。
   * note 可以是字符串，或按成员给出的函数。
   */
  #insertSpeakers(group, round, afterTurnId, memberIds, { cap, kind, calledBy, note, causeMessageId }) {
    const turns = new Map(round.order.map(id => [id, this.#turn(id)]));
    const index = afterTurnId ? round.order.indexOf(afterTurnId) : this.#roundPosition(round, turns);
    const slots = round.order.map(id => ({ key: id, memberId: turns.get(id).memberId, waiting: waitingForSlot(turns.get(id)) }));
    const turnsOf = (memberId) => [...turns.values()].filter(turn => turn.memberId === memberId && !waitingForSlot(turn)).length;
    const planned = insertCalls(slots, index, memberIds, turnsOf, cap);
    const noteFor = (memberId) => (typeof note === "function" ? note(memberId) : note);
    for (const key of planned.moved) {
      const moved = turns.get(key);
      Object.assign(moved, { kind, calledBy, note: noteFor(moved.memberId), causeMessageIds: [...moved.causeMessageIds, causeMessageId] });
      this.#putTurn(moved);
    }
    const order = [];
    for (const slot of planned.order) {
      if (slot.key) { order.push(slot.key); continue; }
      const turn = this.#newTurn(group, round, slot.memberId, { kind, note: noteFor(slot.memberId), calledBy, causeMessageIds: [causeMessageId] });
      if (turn) order.push(turn.id);
    }
    round.order = order;
    return planned.added.length;
  }

  // 轮次当前进行到的位置：持有发言位的那一位，否则最后一位已经轮到过的。
  #roundPosition(round, turns = new Map(round.order.map(id => [id, this.#turn(id)]))) {
    const holder = round.order.findIndex(id => holdsFloor(turns.get(id)));
    if (holder >= 0) return holder;
    let last = -1;
    round.order.forEach((id, index) => { if (!waitingForSlot(turns.get(id))) last = index; });
    return last;
  }

  #memberBusy(groupId, memberId, exceptId = null) {
    return this.#turns("group_id=? AND member_id=? AND state IN ('running','waiting')", groupId, memberId)
      .some(turn => turn.id !== exceptId);
  }

  #cancelTurn(turn, errorCode) {
    Object.assign(turn, { state: "cancelled", errorCode, finishedAt: this.now() });
    this.#putTurn(turn);
  }

  // ---- 读取 ----

  getRemoteOwnerId() {
    return this.#write(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='remoteOwnerId'").get();
      if (row) return JSON.parse(row.value);
      const id = this.randomUUID();
      this.db.prepare("INSERT INTO meta(key,value) VALUES('remoteOwnerId',?)").run(JSON.stringify(id));
      return id;
    });
  }

  getDriverFence() {
    this.#ready();
    const row = this.db.prepare("SELECT value FROM meta WHERE key='driverFence'").get();
    return row ? JSON.parse(row.value) : 0;
  }

  advanceDriverFence() {
    return this.#write(() => {
      const next = this.getDriverFence() + 1;
      this.db.prepare("INSERT INTO meta VALUES('driverFence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(next));
      return next;
    });
  }

  /** 升级时记下的旧机制运行；取走后清空，由驱动逐个中止。 */
  takeLegacyRuns() {
    return this.#write(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='legacyRetiredRuns'").get();
      if (!row) return [];
      this.db.prepare("DELETE FROM meta WHERE key='legacyRetiredRuns'").run();
      return JSON.parse(row.value);
    });
  }

  /** 运行诊断：只有计数与版本，不含消息正文、成员设定或令牌。 */
  diagnostics() {
    this.#ready();
    const counts = (sql) => Object.fromEntries(this.db.prepare(sql).all().map((row) => [row.key, row.count]));
    return {
      schemaVersion: this.db.prepare("PRAGMA user_version").get().user_version,
      driverFence: this.getDriverFence(),
      groups: counts("SELECT status AS key, COUNT(*) AS count FROM groups GROUP BY status"),
      rounds: counts("SELECT status AS key, COUNT(*) AS count FROM discussions GROUP BY status"),
      turns: counts(`SELECT state AS key, COUNT(*) AS count FROM opportunities
        WHERE state IN ('queued','running','waiting') GROUP BY state`),
      externalTurns: this.db.prepare(`SELECT COUNT(*) AS count FROM opportunities WHERE state IN ('running','waiting')
        AND json_extract(data,'$.runKind')='external'`).get().count,
      messages: this.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      internalSessions: this.internalSessionKeys.size,
    };
  }

  isInternalSessionKey(sessionKey) {
    return this.internalSessionKeys.has(sessionKey);
  }

  getOwnerScope() {
    this.#ready();
    const value = this.db.prepare("SELECT value FROM meta WHERE key='authorityId'").get();
    if (!value) fail("GROUP_CHAT_UNAVAILABLE");
    return `ga1:${JSON.parse(value.value)}`;
  }

  ensureMemberBinding({ groupId, memberId }) {
    return this.#write(() => {
      this.#requireGroup(groupId, { active: true });
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId || member.state !== "active") fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      return this.#publicBinding(this.#ensureBinding(member));
    });
  }

  lookupSend({ groupId, clientMessageId, payloadDigest = null, ownerScope = null }) {
    this.#ready();
    const actualOwner = this.getOwnerScope();
    const base = { ownerScope: actualOwner, groupId, clientMessageId, payloadMatches: null, message: null, discussionId: null };
    if (ownerScope !== null && ownerScope !== actualOwner) return { ...base, status: "unknown", reason: "owner_changed" };
    this.#requireGroup(groupId);
    const message = parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? AND origin_key=?")
      .get(groupId, `user:${clientMessageId}`));
    if (!message) return { ...base, status: "not_found" };
    const actualDigest = message.sendPayloadDigest ?? groupSendPayloadDigest({ groupId, clientMessageId,
      body: message.body, mentions: message.requestedMentions, replyTo: message.replyTo?.seq ?? null,
      taskId: message.requestedTaskId ?? null, attachments: message.attachments,
      requestMode: message.requestMode, discussionId: message.requestedDiscussionId,
      summaryMemberId: message.summaryMemberId, expectedPolicyVersion: message.expectedPolicyVersion });
    return { ...base, status: "found", payloadDigest: actualDigest,
      payloadMatches: payloadDigest === null ? null : payloadDigest === actualDigest,
      message, discussionId: message.origin?.discussionId ?? null };
  }

  #groupView(group) {
    const cards = this.#cards(group.id);
    const owner = this.#owner(group);
    const active = this.#turns("group_id=? AND state IN ('running','waiting')", group.id);
    const queued = this.#turns("group_id=? AND state='queued'", group.id);
    const round = this.#rounds(group.id, ["running"])[0] ?? null;
    // 宿主明确排队的外部回合：同一 Agent / 工作区 / 宿主上另有一次执行还没确认结束（可能在别的群），标出排队原因。
    const blocked = active.some((turn) => turn.observation?.dispatchState === "queued")
      ? this.#turns("state IN ('running','waiting')").filter((turn) => turn.external && turn.observation?.dispatchState !== "queued"
        && (turn.recovery?.type === "execution" || turn.observation?.status === "unknown")) : [];
    const queueReason = (turn) => turn.observation?.dispatchState === "queued" && blocked.some((other) => other.runId !== turn.runId
      && ["backendId", "agentId", "workspace"].every((key) => other.external[key] === turn.external?.[key])
      && other.external.remote?.hostId === turn.external?.remote?.hostId) ? "execution_unconfirmed" : null;
    return {
      ownerScope: this.getOwnerScope(),
      group: { ...group, directoryRevision: group.directoryRevision ?? 0, ownerMemberId: group.ownerMemberId ?? null },
      currentOwnerId: owner?.id ?? null,
      members: this.#members(group.id).map((member) => ({ ...member, card: cards.get(member.id) ?? null })),
      round: round && { id: round.id, causeMessageId: round.causeMessageId, order: round.order.map(id => {
        const turn = this.#turn(id);
        return { opportunityId: id, memberId: turn.memberId, state: turn.state, released: Boolean(turn.released),
          releasedReason: turn.releasedReason ?? null, errorCode: turn.errorCode ?? null };
      }) },
      // 正在发言（持有发言位）与在后台干活的成员。
      activeTurns: active.map((turn) => ({ opportunityId: turn.id, memberId: turn.memberId, discussionId: turn.discussionId,
        startedAt: turn.startedAt, floor: holdsFloor(turn), released: Boolean(turn.released),
        releasedReason: turn.releasedReason ?? null, releasedAt: turn.releasedAt ?? null,
        dispatchState: turn.observation?.dispatchState ?? null, queueReason: queueReason(turn),
        recovery: turn.recovery ?? null, stopping: Boolean(turn.abortReason) })),
      // 等待用户审批 / 补充输入的回合：让出发言位，交互卡在群里显示。
      pendingInteractions: active.filter((turn) => turn.state === "waiting" && turn.interaction?.status === "pending" && !turn.abortReason)
        .map((turn) => ({ opportunityId: turn.id, memberId: turn.memberId,
          status: turn.interaction.status, request: turn.interaction.request,
          context: turn.interaction.context ?? null, occurredAt: turn.interaction.occurredAt })),
      // 成员在群里用的内部会话（网关形式的会话 key）；页面据此把它们从普通会话列表与通知中排除。
      internalSessionKeys: this.listInternalSessions(group.id).map((session) => session.key),
      queuedMemberIds: [...new Set(queued.map((turn) => turn.memberId))],
    };
  }

  // 搜索过滤用完整绑定目录，不能受列表 500 个群的显示上限或归档筛选影响。
  listInternalSessions(groupId = null) {
    this.#ready();
    const rows = this.db.prepare(`SELECT b.session_key AS key, b.external AS external, m.data AS member
      FROM session_bindings b JOIN members m ON m.id=b.member_id ${groupId ? "WHERE b.group_id=?" : ""}`)
      .all(...(groupId ? [groupId] : []));
    const sessions = new Map();
    for (const row of rows) {
      const member = JSON.parse(row.member);
      for (const key of [row.key, ...retiredSessions(row.external)].filter(Boolean)) {
        const session = { backendId: member.backendId, key: member.profileId ? `agent:${member.agentId}:${key}` : key };
        sessions.set(`${session.backendId}\0${session.key}`, session);
      }
    }
    return [...sessions.values()];
  }

  listGroups({ includeArchived = false } = {}) {
    this.#ready();
    const groups = this.db.prepare(`SELECT data FROM groups WHERE status IN (${includeArchived ? "'active','archived','deleting'" : "'active','deleting'"})
      ORDER BY updated_at DESC, id LIMIT 500`).all().map(parse);
    return groups.map((group) => ({
      ...this.#groupView(group),
      lastMessage: parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? ORDER BY seq DESC LIMIT 1").get(group.id)),
    }));
  }

  listRecentArtifacts({ sinceMs, limit, backendIds }) {
    this.#ready();
    if (!backendIds.length) return { items: [], truncated: false };
    // Query the public message attachment references, never internal sessions or workspace contents.
    // Scope and deduplication precede LIMIT so other backends/repeated deliveries cannot crowd out files.
    const rows = this.db.prepare(`WITH outputs AS (
      SELECT a.value AS attachment, g.id AS groupId, json_extract(g.data,'$.name') AS groupName,
        msg.seq AS messageSeq, json_extract(m.data,'$.backendId') AS backendId,
        json_extract(m.data,'$.agentId') AS agentId, json_extract(m.data,'$.displayName') AS agentName,
        json_extract(msg.data,'$.createdAt') AS createdAt,
        ROW_NUMBER() OVER (PARTITION BY json_extract(a.value,'$.id')
          ORDER BY json_extract(msg.data,'$.createdAt') DESC, msg.id DESC) AS occurrence
      FROM groups g JOIN messages msg ON msg.group_id=g.id
      JOIN members m ON m.group_id=g.id AND m.id=json_extract(msg.data,'$.author.memberId')
      JOIN json_each(msg.data,'$.attachments') a
      WHERE g.status='active' AND json_extract(msg.data,'$.author.kind')='member'
        AND json_extract(msg.data,'$.createdAt')>=?
        AND json_extract(m.data,'$.backendId') IN (${backendIds.map(() => "?").join(",")})
    ) SELECT attachment,groupId,groupName,messageSeq,backendId,agentId,agentName,createdAt
      FROM outputs WHERE occurrence=1 ORDER BY createdAt DESC,groupId,messageSeq DESC,attachment LIMIT ?`)
      .all(sinceMs, ...backendIds, limit + 1);
    return { items: rows.slice(0, limit).map(row => ({ ...row, attachment: JSON.parse(row.attachment) })),
      truncated: rows.length > limit };
  }

  // App-level Agent queries need complete counts and stable ID pagination. The
  // sidebar's bounded 500-row projection is not an authoritative group total.
  queryAgentGroups({ includeArchived = false, member = null, query = "", afterId = "", limit = 20 } = {}) {
    this.#ready();
    const where = [includeArchived ? "g.status IN ('active','archived')" : "g.status='active'"], values = [];
    if (member) {
      where.push(`EXISTS (SELECT 1 FROM members m WHERE m.group_id=g.id
        AND json_extract(m.data,'$.state')='active'
        AND json_extract(m.data,'$.backendId')=? AND json_extract(m.data,'$.agentId')=?)`);
      values.push(member.backendId, member.agentId);
    }
    if (query.trim()) {
      where.push("(instr(lower(json_extract(g.data,'$.name')),lower(?))>0 OR instr(lower(json_extract(g.data,'$.purpose')),lower(?))>0)");
      values.push(query.trim(), query.trim());
    }
    const filter = where.join(" AND ");
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM groups g WHERE ${filter}`).get(...values).total;
    const rows = this.db.prepare(`SELECT g.data FROM groups g WHERE ${filter} AND g.id>? ORDER BY g.id LIMIT ?`)
      .all(...values, afterId, limit + 1).map(parse);
    const selected = rows.slice(0, limit);
    return { total, groups: selected.map(group => ({ group, members: this.#members(group.id) })),
      nextAfterId: rows.length > limit ? selected.at(-1).id : null };
  }

  getGroup(groupId) {
    this.#ready();
    return this.#groupView(this.#requireGroup(groupId));
  }

  listMessages({ groupId, afterSeq = null, beforeSeq = null, limit = 50 }) {
    this.#ready();
    this.#requireGroup(groupId);
    let rows;
    let hasMore;
    if (afterSeq !== null) {
      rows = this.db.prepare("SELECT data FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(groupId, afterSeq, limit + 1);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    } else {
      rows = this.db.prepare(`SELECT data FROM messages WHERE group_id=? AND seq<? ORDER BY seq DESC LIMIT ?`)
        .all(groupId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    return { messages: rows.map(row => {
      const message = parse(row), reply = message.replyTo;
      // 已保存的旧引用只含文字。在当前群按原 ID/seq 补媒体元数据，不重写历史，也不要求原图在这一页。
      if (reply && reply.attachments === undefined && reply.seq < message.seq) {
        const quoted = parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? AND seq=? AND id=?")
          .get(groupId, reply.seq, reply.messageId));
        if (quoted && quoted.author.kind !== "system" && quoted.attachments?.length)
          message.replyTo = { ...reply, attachments: replySnapshot(quoted).attachments };
      }
      return message;
    }), hasMore };
  }

  readMessage({ groupId, seq, offset = 0, digest: expected = null }) {
    this.#ready();
    this.#requireGroup(groupId);
    const message = parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? AND seq=?").get(groupId, seq));
    if (!message || message.author.kind === "system") fail("GROUP_CHAT_REPLY_NOT_FOUND");
    const full = this.db.prepare("SELECT body FROM message_results WHERE message_id=?").get(message.id);
    return { page: resultPage(full?.body ?? message.body, { offset, digest: expected }) };
  }

  /** 截至某个 seq 的最近一条用户消息。 */
  latestUserMessage(groupId, throughSeq) {
    this.#ready();
    return parse(this.db.prepare(`SELECT data FROM messages WHERE group_id=? AND seq<=?
      AND json_extract(data,'$.author.kind')='user' ORDER BY seq DESC LIMIT 1`).get(groupId, throughSeq));
  }

  getMessage(messageId) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM messages WHERE id=?").get(messageId));
  }

  // ---- 群管理 ----

  createGroup({ operationId, name, purpose, members }) {
    const keys = new Set(members.map((member) => `${member.backendId}\0${member.peerId ?? ""}\0${member.agentId}`));
    if (keys.size !== members.length) fail("GROUP_CHAT_MEMBER_DUPLICATE");
    if (members.length < MIN_GROUP_MEMBERS_ON_CREATE || members.length > MAX_GROUP_MEMBERS) {
      fail("GROUP_CHAT_MEMBER_LIMIT");
    }
    return this.#operation(`create:${operationId}`, { name, purpose, members }, () => this.#createGroup({ name, purpose, members }));
  }

  #createGroup({ name, purpose, members }) {
      const time = this.now();
      const group = {
        id: this.randomUUID(), name: name.trim(), purpose: purpose.trim(), status: "active",
        createdAt: time, updatedAt: time, metadataRevision: 1, rosterRevision: 1, directoryRevision: 0,
        controlEpoch: 1, lastSeq: 0, policyVersion: 1, ownerMemberId: null, lateRounds: 0,
      };
      this.#putGroup(group);
      const handles = [];
      const created = members.map((input, position) => {
        const handle = uniqueHandle(input.displayName, handles);
        handles.push(handle);
        const member = {
          id: this.randomUUID(), groupId: group.id, backendId: input.backendId, agentId: input.agentId,
          profileId: input.profileId, ...(input.peerId ? { peerId: input.peerId } : {}), displayName: input.displayName,
          handle, state: "active", position, joinedSeq: 0, leftSeq: null,
        };
        this.#putMember(member);
        return member;
      });
      group.ownerMemberId = defaultOwner(created, DEFAULT_AGENT_PROFILE_ID)?.id ?? null;
      this.#putGroup(group);
      return { groupId: group.id };
  }

  updateGroup({ groupId, expectedMetadataRevision, patch }) {
    return this.#write(() => {
      const group = this.#requireGroup(groupId);
      if (group.status === "deleting") fail("GROUP_CHAT_DELETED");
      if (group.metadataRevision !== expectedMetadataRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
      const name = patch.name === undefined ? group.name : patch.name.trim();
      const purpose = patch.purpose === undefined ? group.purpose : patch.purpose.trim();
      const status = patch.status ?? group.status;
      const ownerMemberId = patch.ownerMemberId === undefined ? group.ownerMemberId ?? null : patch.ownerMemberId;
      if (ownerMemberId !== null) {
        const owner = this.#member(ownerMemberId);
        if (!owner || owner.groupId !== groupId || owner.state !== "active") fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      }
      if (name === group.name && purpose === group.purpose && status === group.status && ownerMemberId === (group.ownerMemberId ?? null)) {
        return { groupId };
      }
      if (name !== group.name) this.#systemMessage(group, { eventType: "renamed", name, previousName: group.name });
      Object.assign(group, { name, purpose, status, ownerMemberId, metadataRevision: group.metadataRevision + 1, updatedAt: this.now() });
      this.#putGroup(group);
      return { groupId };
    });
  }

  setMemberModel({ groupId, expectedRosterRevision, memberId, modelSelection }) {
    return this.#write(() => {
      const group = this.#requireGroup(groupId, { active: true });
      if (group.rosterRevision !== expectedRosterRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId || member.state !== "active") fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      if (!validModelSelection(modelSelection)) fail();
      if (JSON.stringify(member.modelSelection ?? null) === JSON.stringify(modelSelection)) return { groupId };
      member.modelSelection = clone(modelSelection);
      this.#putMember(member);
      group.rosterRevision++;
      group.updatedAt = this.now();
      this.#putGroup(group);
      return { groupId };
    });
  }

  addMember(args) {
    return this.#write(() => this.#addMember(args));
  }

  #addMember({ groupId, expectedRosterRevision, member: input }) {
      const group = this.#requireGroup(groupId, { active: true });
      if (group.rosterRevision !== expectedRosterRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
      const all = this.#members(groupId);
      const active = all.filter((member) => member.state === "active");
      if (active.some((member) => member.backendId === input.backendId && member.agentId === input.agentId && (member.peerId ?? null) === (input.peerId ?? null))) {
        fail("GROUP_CHAT_MEMBER_DUPLICATE");
      }
      if (active.length >= MAX_GROUP_MEMBERS) fail("GROUP_CHAT_MEMBER_LIMIT");
      // 移除成员的 handle 保留不复用，旧消息里的 @ 不会改指向他人。
      const handle = uniqueHandle(input.displayName, all.map((member) => member.handle));
      const member = {
        id: this.randomUUID(), groupId, backendId: input.backendId, agentId: input.agentId,
        profileId: input.profileId, ...(input.peerId ? { peerId: input.peerId } : {}), displayName: input.displayName, handle, state: "active",
        position: Math.max(...all.map((item) => item.position)) + 1, joinedSeq: group.lastSeq, leftSeq: null,
      };
      this.#putMember(member);
      this.#systemMessage(group, { eventType: "member_added", memberId: member.id });
      group.rosterRevision += 1;
      if (!group.ownerMemberId) group.ownerMemberId = member.id;
      this.#putGroup(group);
      return { groupId, memberId: member.id };
  }

  lookupAgentManagement(operationId, request) {
    this.#ready();
    if (!/^agent-management:[a-f0-9]{64}$/u.test(operationId)) fail();
    const prior = this.db.prepare("SELECT fingerprint, result FROM operations WHERE id=?").get(operationId);
    if (!prior) return null;
    if (prior.fingerprint !== digest(request)) fail("GROUP_CHAT_OPERATION_CONFLICT");
    return JSON.parse(prior.result);
  }

  applyAgentManagement({ operationId, request, ownerScope, previewDigest, members, rosterRevision, policyVersion }) {
    if (!/^agent-management:[a-f0-9]{64}$/u.test(operationId)) fail();
    return this.#operation(operationId, request, () => {
      if (ownerScope !== this.getOwnerScope()) fail("GROUP_CHAT_OWNER_CHANGED");
      let groupId, addedMemberIds;
      if (request.action === "create") {
        if (members.length < MIN_GROUP_MEMBERS_ON_CREATE || members.length > MAX_GROUP_MEMBERS) fail("GROUP_CHAT_MEMBER_LIMIT");
        if (new Set(members.map(member => `${member.backendId}:${member.agentId}`)).size !== members.length) fail("GROUP_CHAT_MEMBER_DUPLICATE");
        ({ groupId } = this.#createGroup({ name: request.name, purpose: request.purpose, members }));
        addedMemberIds = this.#members(groupId).map(member => member.id);
      } else {
        groupId = request.groupId;
        const group = this.#requireGroup(groupId, { active: true });
        if (group.rosterRevision !== rosterRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
        if ((group.policyVersion ?? 1) !== policyVersion) fail("GROUP_CHAT_POLICY_CONFLICT");
        // One transaction includes every member and the receipt. Any duplicate,
        // capacity failure or write failure rolls back the entire batch.
        addedMemberIds = members.map((member, index) => this.#addMember({ groupId,
          expectedRosterRevision: rosterRevision + index, member }).memberId);
      }
      const group = this.#requireGroup(groupId);
      return { ok: true, status: request.action === "create" ? "created" : "members_added",
        clientRequestId: request.clientRequestId, ownerScope, previewDigest, groupId, groupName: group.name,
        rosterRevision: group.rosterRevision, memberIds: addedMemberIds };
    });
  }

  removeMember({ groupId, expectedRosterRevision, memberId }) {
    return this.#write(() => {
      const group = this.#requireGroup(groupId);
      if (group.rosterRevision !== expectedRosterRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId || member.state !== "active") fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      const aborts = this.#stopMemberTurns(groupId, memberId, "GROUP_MEMBER_REMOVED");
      Object.assign(member, { state: "removed", leftSeq: group.lastSeq });
      this.#putMember(member);
      this.#systemMessage(group, { eventType: "member_removed", memberId });
      group.rosterRevision += 1;
      if (group.ownerMemberId === memberId) {
        group.ownerMemberId = defaultOwner(this.#members(groupId), DEFAULT_AGENT_PROFILE_ID)?.id ?? null;
      }
      this.#putGroup(group);
      return { groupId, aborts };
    });
  }

  // ---- 用户发言 ----

  /**
   * 用户发言：有正在进行的一轮就插进这一轮（下一位开口前），否则开新一轮。
   * requestMode / discussionId / summaryMemberId / taskId / expectedPolicyVersion 是旧发送协议的字段：
   * 只参与幂等核对，不再影响谁来回答。
   */
  appendUserMessage({ groupId, clientMessageId, body, mentionMemberIds, replyToSeq = null, taskId = null, attachments = [],
    requestMode = "auto", discussionId = null, summaryMemberId = null, ownerScope = null, expectedPolicyVersion = null }) {
    return this.#write(() => {
      const group = this.#requireGroup(groupId, { active: true });
      if (ownerScope !== null && ownerScope !== this.getOwnerScope()) fail("GROUP_CHAT_OWNER_CHANGED");
      const originKey = `user:${clientMessageId}`;
      const prior = parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? AND origin_key=?")
        .get(groupId, originKey));
      if (prior) {
        if (prior.body !== body || digest(prior.requestedMentions) !== digest(mentionMemberIds)
          || (prior.replyTo?.seq ?? null) !== replyToSeq || (prior.requestedTaskId ?? null) !== taskId
          || (prior.requestMode ?? "auto") !== requestMode || (prior.requestedDiscussionId ?? null) !== discussionId
          || (prior.summaryMemberId ?? null) !== summaryMemberId
          || (prior.expectedPolicyVersion ?? null) !== expectedPolicyVersion
          || digest(prior.attachments ?? []) !== digest(attachments)) {
          fail("GROUP_CHAT_MESSAGE_CONFLICT");
        }
        return { message: prior, discussionId: prior.origin?.discussionId ?? null, duplicate: true };
      }
      if (expectedPolicyVersion !== null && expectedPolicyVersion !== (group.policyVersion ?? 1)) fail("GROUP_CHAT_POLICY_CHANGED");
      // 引用回复：只能引用本群里用户或成员说过的话；摘录随消息保存，之后原文再长也不必回查。
      const quoted = replyToSeq === null ? null : parse(this.db.prepare(
        "SELECT data FROM messages WHERE group_id=? AND seq=?").get(groupId, replyToSeq));
      if (replyToSeq !== null && (!quoted || quoted.author.kind === "system")) fail("GROUP_CHAT_REPLY_NOT_FOUND");
      const active = this.#members(groupId, { activeOnly: true });
      const activeIds = new Set(active.map((member) => member.id));
      const parsed = parseMentions(body, active.map((member) => ({ memberId: member.id, handle: member.handle })));
      const structured = mentionMemberIds.filter((id) => activeIds.has(id));
      const invalidStructured = mentionMemberIds.filter((id) => !activeIds.has(id));
      const targeted = [...new Set([...structured, ...parsed.memberIds])];
      // 引用某位成员的话而没有另外 @ 别人：只请被引用的那位回答。
      const quotedMemberId = quoted?.author.kind === "member" && activeIds.has(quoted.author.memberId)
        ? quoted.author.memberId : null;
      const message = this.#insertMessage(group, {
        originKey, author: { kind: "user" }, body, requestedMentions: [...mentionMemberIds],
        requestMode, requestedDiscussionId: discussionId, summaryMemberId,
        expectedPolicyVersion, sendPayloadDigest: groupSendPayloadDigest({ groupId, clientMessageId, body,
          mentionMemberIds, replyToSeq, taskId, attachments, requestMode, discussionId, summaryMemberId, expectedPolicyVersion }),
        ...(taskId ? { requestedTaskId: taskId } : {}),
        mentions: { memberIds: targeted, broadcast: parsed.broadcast,
          unresolved: [...parsed.unresolved, ...invalidStructured.map((id) => `#${id}`)] },
        ...(quoted ? { replyTo: replySnapshot(quoted) } : {}),
        ...(attachments.length ? { attachments: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) } : {}),
      });
      // 点了不存在的名字：不猜测，谁也不叫，页面会提示。
      const unresolved = parsed.unresolved.length > 0 || invalidStructured.length > 0;
      const owner = this.#owner(group);
      const speakers = unresolved ? [] : openingSpeakers({ active, ownerId: owner?.id ?? null, author: { kind: "user" },
        mentionIds: targeted.length ? targeted : quotedMemberId ? [quotedMemberId] : [], broadcast: parsed.broadcast });
      const named = new Set(targeted);
      const note = (memberId) => (parsed.broadcast || named.has(memberId) || memberId === quotedMemberId ? "The user invited you" : "New user message");
      group.lateRounds = 0;
      // 排队中还没开始的迟到结果轮次并进这条消息：它们的内容都已在群里，下一位开口时都会看到。
      for (const waiting of this.#rounds(groupId, ["queued"])) {
        for (const id of waiting.order) {
          const turn = this.#turn(id);
          if (turn.state === "queued") this.#cancelTurn(turn, "GROUP_ROUND_MERGED");
        }
        Object.assign(waiting, { status: "cancelled", updatedAt: this.now() });
        this.#putRound(waiting);
      }
      const running = this.#rounds(groupId, ["running"])[0];
      let round = running;
      if (running) {
        const added = this.#insertSpeakers(group, running, null, speakers, { cap: ROUND_LIMITS.ownerCallCap, kind: "open",
          calledBy: null, note, causeMessageId: message.id });
        running.limit += added * ROUND_LIMITS.turnsPerOpeningSpeaker;
        running.updatedAt = this.now();
        this.#putRound(running);
      } else if (speakers.length) {
        round = this.#newRound(group, { kind: "user", causeMessage: message, speakers, notes: note,
          plain: !targeted.length && !quotedMemberId && !parsed.broadcast });
      }
      message.origin = { discussionId: round?.id ?? null };
      this.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(message), message.id);
      this.#putGroup(group);
      return { message, discussionId: round?.id ?? null, duplicate: false };
    });
  }

  // ---- 停止与重试 ----

  groupLifecycle(groupId) { this.#ready(); return this.#group(groupId)?.status ?? null; }

  groupsPendingDeletion() {
    this.#ready();
    return this.db.prepare("SELECT id FROM groups WHERE status IN ('archived','deleting') ORDER BY id").all().map(row => row.id);
  }

  #stopMemberTurns(groupId, memberId, reason) {
    const aborts = [];
    for (const turn of this.#turns("group_id=? AND member_id=? AND state IN ('queued','running','waiting')", groupId, memberId)) {
      if (turn.state === "queued") { this.#cancelTurn(turn, reason); continue; }
      if (!turn.abortReason) turn.abortReason = reason;
      if (turn.interaction?.status === "pending") turn.interaction.status = "cancelled";
      this.#putTurn(turn);
      aborts.push(clone(turn));
    }
    return aborts;
  }

  /** 停止全群：清空排队与轮次，中止正在发言和在后台干活的回合。 */
  stopDiscussion({ groupId }) {
    return this.#write(() => this.#stopGroup(groupId, "GROUP_DISCUSSION_STOPPED"));
  }

  #stopGroup(groupId, reason) {
    this.#requireGroup(groupId);
    const rounds = this.#rounds(groupId, ["queued", "running"]);
    for (const round of rounds) {
      Object.assign(round, { status: "cancelled", updatedAt: this.now() });
      this.#putRound(round);
    }
    const aborts = [];
    for (const turn of this.#turns("group_id=? AND state IN ('queued','running','waiting')", groupId)) {
      if (turn.state === "queued") { this.#cancelTurn(turn, reason); continue; }
      if (!turn.abortReason) turn.abortReason = reason;
      if (turn.interaction?.status === "pending") turn.interaction.status = "cancelled";
      this.#putTurn(turn);
      aborts.push(clone(turn));
    }
    return { groupId, stopped: rounds.length > 0 || aborts.length > 0, aborts };
  }

  /** 单独停下一位成员：取消它排着的发言，中止它正在跑的回合。 */
  stopMember({ groupId, memberId }) {
    return this.#write(() => {
      this.#requireGroup(groupId);
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId) fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      const aborts = this.#stopMemberTurns(groupId, memberId, "GROUP_MEMBER_STOPPED");
      return { groupId, stopped: aborts.length > 0, aborts };
    });
  }

  /** 让最近一次没答成的成员补答：单独开一轮，只请它开口；同一次操作只生效一次。 */
  retryMember({ groupId, memberId, operationId }) {
    return this.#operation(`retry:${groupId}:${operationId}`, { groupId, memberId }, () => {
      const group = this.#requireGroup(groupId, { active: true });
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId || member.state !== "active") fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      const last = this.#turns("member_id=?", memberId).at(-1);
      if (!last || last.state !== "failed") fail("GROUP_CHAT_NOTHING_TO_RETRY");
      const cause = this.getMessage(last.causeMessageIds.at(-1)) ?? this.latestUserMessage(groupId, group.lastSeq);
      if (!cause) fail("GROUP_CHAT_NOTHING_TO_RETRY");
      const round = this.#newRound(group, { kind: "retry", causeMessage: cause, speakers: [memberId],
        notes: () => "Retry your previous unsuccessful reply", calledBy: last.calledBy ?? null });
      group.updatedAt = this.now();
      this.#putGroup(group);
      return { groupId, memberId, discussionId: round.id };
    });
  }

  // ---- 删除 ----

  deleteGroup({ groupId, expectedMetadataRevision = null }) {
    return this.#write(() => {
      const group = this.#group(groupId);
      if (!group) fail("GROUP_CHAT_NOT_FOUND");
      if (group.status === "deleted") return { groupId, status: "deleted" };
      if (group.status === "deleting") return { groupId, status: "deleting" };
      if (expectedMetadataRevision !== null && group.metadataRevision !== expectedMetadataRevision) fail("GROUP_CHAT_REVISION_CONFLICT");
      Object.assign(group, { status: "deleting", deletionRequestedAt: this.now(),
        metadataRevision: group.metadataRevision + 1, controlEpoch: group.controlEpoch + 1, updatedAt: this.now() });
      this.#putGroup(group);
      this.#stopGroup(groupId, "GROUP_DELETED");
      return { groupId, status: "deleting" };
    });
  }

  #finishGroupDeletion(groupId) {
    const group = this.#group(groupId);
    if (!group || !["deleting", "deleted"].includes(group.status)) fail("GROUP_CHAT_INVALID");
    const pendingTurns = this.#turns("group_id=? AND state IN ('running','waiting')", groupId).length;
    const hosts = this.groupDeletionTargets(groupId);
    if (group.status === "deleting" && !pendingTurns
      && (!hosts.targets.length || group.deletionHostsDigest === hosts.digest)) {
      // 执行身份与内部会话排除记录留着供恢复核对；公开内容在所有执行停下后才删。
      this.db.prepare("DELETE FROM message_results WHERE message_id IN (SELECT id FROM messages WHERE group_id=?)").run(groupId);
      if (this.tables.has("invitations")) {
        this.db.prepare("DELETE FROM invitations WHERE cause_message_id IN (SELECT id FROM messages WHERE group_id=?)").run(groupId);
      }
      for (const table of ["message_deliveries", "collaboration_actions", "collaboration_wakeups", "collaboration_items"]) {
        if (this.tables.has(table)) this.db.prepare(`DELETE FROM ${table} WHERE group_id=?`).run(groupId);
      }
      for (const table of ["messages", "member_cards", "role_snapshots"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE group_id=?`).run(groupId);
      }
      for (const turn of this.#turns("group_id=?", groupId)) {
        if (turn.postedText || turn.publicProgress || turn.collaborationSnapshot) {
          turn.postedText = null; delete turn.publicProgress; delete turn.collaborationSnapshot; this.#putTurn(turn);
        }
      }
      if (this.tables.has("tasks")) {
        for (const row of this.db.prepare("SELECT data FROM tasks WHERE group_id=?").all(groupId)) {
          const task = parse(row);
          Object.assign(task, { objective: "", inputs: [], deliverables: [], acceptance: [], constraints: [],
            progress: null, result: null, reviewReceipt: null, revisions: [], pendingUserInputs: [] });
          for (const attempt of task.attempts ?? []) { delete attempt.result; delete attempt.publicProgress; delete attempt.taskInputManifest; }
          this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), task.id);
        }
      }
      group.name = ""; group.purpose = ""; group.lastSeq = 0;
      group.status = "deleted"; group.deletedAt = this.now(); group.updatedAt = this.now();
      this.#putGroup(group);
    }
    return { groupId, status: group.status };
  }

  finishGroupDeletion(groupId) { return this.#write(() => this.#finishGroupDeletion(groupId)); }

  groupDeletionTargets(groupId) {
    this.#ready();
    const hosts = new Map();
    for (const record of this.#turns("group_id=?", groupId)) {
      const external = record.runKind === "external" ? record.external : null;
      if (!external) continue;
      const key = JSON.stringify(external.remote
        ? [external.backendId, external.agentId, external.remote.peerId, external.remote.hostId]
        : [external.backendId, external.agentId, external.executionId]);
      if (!hosts.has(key)) hosts.set(key, external);
    }
    return { targets: [...hosts.values()].map(clone), digest: digest([...hosts.keys()].sort()) };
  }

  confirmGroupDeletionHosts(groupId, targetsDigest) {
    return this.#write(() => {
      const group = this.#group(groupId);
      if (group?.status !== "deleting" || this.groupDeletionTargets(groupId).digest !== targetsDigest) return false;
      group.deletionHostsDigest = targetsDigest; this.#putGroup(group); return true;
    });
  }

  // ---- 成员目录 ----

  getMemberCards(groupId) {
    this.#ready();
    return this.#cards(groupId);
  }

  saveRoleSnapshot({ groupId, memberId, text, ...metadata }) {
    if (!validText(text) || sha256(text) !== metadata.exportDigest) fail("GROUP_RESULT_INVALID");
    return this.#write(() => {
      const member = this.#member(memberId);
      if (!member || member.groupId !== groupId || member.state !== "active") return null;
      const id = digest([groupId, memberId, metadata]);
      const prior = this.getRoleSnapshot({ groupId, memberId, id });
      if (prior) return prior;
      const value = { id, groupId, memberId, ...metadata, createdAt: this.now() };
      this.db.prepare("INSERT INTO role_snapshots VALUES(?,?,?,?,?,?)")
        .run(id, memberId, groupId, value.createdAt, JSON.stringify(value), text);
      return { ...value, text };
    });
  }

  getRoleSnapshot({ groupId, memberId, id }) {
    this.#ready();
    const row = this.db.prepare("SELECT data,body FROM role_snapshots WHERE group_id=? AND member_id=? AND id=?").get(groupId, memberId, id);
    return row ? { ...parse(row), text: row.body } : null;
  }

  listRoleSnapshots({ groupId, memberId, before = null, limit = 20 }) {
    this.#ready();
    const cursor = before ? this.db.prepare("SELECT rowid FROM role_snapshots WHERE group_id=? AND member_id=? AND id=?")
      .get(groupId, memberId, before)?.rowid : null;
    if (before && !cursor) return { snapshots: [], hasMore: false, nextCursor: null };
    const rows = this.db.prepare(`SELECT data FROM role_snapshots WHERE group_id=? AND member_id=?
      AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?`).all(groupId, memberId, cursor, cursor, limit + 1);
    const snapshots = rows.slice(0, limit).map(parse);
    return { snapshots, hasMore: rows.length > limit, nextCursor: rows.length > limit ? snapshots.at(-1).id : null };
  }

  roleCursor(value = null, cursor = null) {
    return this.#write(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key='roleCursorKey'").get();
      const key = row ? JSON.parse(row.value) : crypto.randomBytes(32).toString("hex");
      if (!row) this.db.prepare("INSERT INTO meta VALUES('roleCursorKey',?)").run(JSON.stringify(key));
      const mac = encoded => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(encoded).digest("base64url");
      if (cursor === null) { const encoded = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${encoded}.${mac(encoded)}`; }
      const parts = cursor.split(".");
      if (parts.length !== 2 || Buffer.byteLength(parts[1]) !== Buffer.byteLength(mac(parts[0]))
        || !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(mac(parts[0])))) return null;
      try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null; }
    });
  }

  /**
   * 写入刷新后的成员卡与显示名；内容未变的卡保持 cardRevision。任一变化时群目录版本 +1。
   * @param {{groupId: string, updates: Array<{memberId: string, displayName: string, card: object}>}} input
   */
  applyMemberCards({ groupId, updates }) {
    return this.#write(() => {
      const group = this.#requireGroup(groupId);
      const cards = this.#cards(groupId);
      let changed = false;
      for (const update of updates) {
        const member = this.#member(update.memberId);
        if (!member || member.groupId !== groupId || member.state !== "active") continue;
        if (update.displayName && update.displayName !== member.displayName) {
          member.displayName = update.displayName;
          this.#putMember(member);
          changed = true;
        }
        const prior = cards.get(member.id);
        const { cardRevision: priorRevision = 0, ...priorContent } = prior ?? {};
        if (prior && digest(priorContent) === digest(update.card)) continue;
        const card = { ...update.card, cardRevision: priorRevision + 1 };
        this.db.prepare(`INSERT INTO member_cards VALUES(?,?,?)
          ON CONFLICT(member_id) DO UPDATE SET data=excluded.data`).run(member.id, groupId, JSON.stringify(card));
        changed = true;
      }
      if (changed) {
        group.directoryRevision = (group.directoryRevision ?? 0) + 1;
        this.#putGroup(group);
      }
      return { groupId, directoryRevision: group.directoryRevision ?? 0, changed };
    });
  }

  // ---- 驱动用：认领、执行登记、提交 ----

  runningOpportunities() {
    this.#ready();
    return this.#turns("state IN ('running','waiting')");
  }

  opportunityByRunId(runId) {
    this.#ready();
    return parse(this.db.prepare("SELECT data FROM opportunities WHERE run_id=?").get(runId));
  }

  getOpportunity(opportunityId) {
    this.#ready();
    return this.#turn(opportunityId);
  }

  executionTerminalReceipt({ groupId, ownerId, hostId, execution }) {
    this.#ready();
    const empty = { receipt: null };
    if (ownerId !== this.getRemoteOwnerId()) return empty;
    const record = this.opportunityByRunId(execution.runId);
    if (!record || record.groupId !== groupId || ["queued", "running", "waiting"].includes(record.state)) return empty;
    const external = record.external, status = record.observation?.terminalStatus;
    if (!external || record.runKind !== "external" || external.remote?.hostId !== hostId
      || external.remote.groupId !== groupId || external.remote.ownerId !== ownerId
      || !["completed", "failed", "canceled", "interrupted"].includes(status)
      || !Number.isSafeInteger(record.finishedAt) || record.finishedAt < 0
      || ["executionId", "runId", "backendId", "agentId", "sessionKey", "workspace", "mode"].some(key => external[key] !== execution[key])) return empty;
    const { executionId, runId, backendId, agentId, sessionKey, workspace, mode } = external;
    return { receipt: { authority: { groupId, ownerId, epoch: this.getDriverFence() }, hostId,
      snapshot: { executionId, runId, backendId, agentId, sessionKey, workspace, mode, status,
        sequence: record.observation.sequence ?? 0, finishedAt: record.finishedAt, resultSummary: null, errorCode: null, attention: null } } };
  }

  groupsWithQueuedTurns() {
    this.#ready();
    return this.db.prepare("SELECT DISTINCT group_id FROM opportunities WHERE state='queued'").all().map((row) => row.group_id);
  }

  /**
   * 认领下一个可以开始的回合。全群同一时间只有一位持有发言位：上一位发完、跳过或让出发言位，
   * 下一位才开始。成员在后台干活时被叫到的发言（忙完再答）不占发言位，等它空下来就开始。
   * 驱动反复调用直到返回 null。
   */
  claimNext(groupId, fence) {
    return this.#write(() => {
      if (fence !== this.getDriverFence()) return null;
      const group = this.#group(groupId);
      if (!group || group.status !== "active") return null;
      // 忙完再答：它当前的回合结束后再开始，不占发言位。
      for (const turn of this.#turns("group_id=? AND state='queued'", groupId)) {
        if (!turn.released || this.#memberBusy(groupId, turn.memberId)) continue;
        const member = this.#member(turn.memberId);
        if (member?.state !== "active") { this.#cancelTurn(turn, "GROUP_MEMBER_REMOVED"); continue; }
        return this.#claim(group, this.#round(turn.discussionId), turn, member, fence, false);
      }
      if (this.#turns("group_id=? AND state IN ('running','waiting')", groupId).some(holdsFloor)) return null;
      for (;;) {
        let round = this.#rounds(groupId, ["running"])[0];
        if (!round) {
          round = this.#rounds(groupId, ["queued"])[0];
          if (!round) return null;
          round.status = "running";
          this.#putRound(round);
        }
        for (const id of round.order) {
          const turn = this.#turn(id);
          if (!waitingForSlot(turn)) continue;
          const member = this.#member(turn.memberId);
          if (member?.state !== "active") { this.#cancelTurn(turn, "GROUP_MEMBER_REMOVED"); continue; }
          if (round.turnCount >= round.limit) { this.#cancelTurn(turn, "GROUP_ROUND_LIMIT"); continue; }
          if (this.#memberBusy(groupId, turn.memberId)) {
            // 还在忙上一件事：这次叫它的话放进它的收件箱，这一轮照常往下走。
            Object.assign(turn, { released: true, releasedReason: "busy", releasedAt: this.now() });
            this.#putTurn(turn);
            continue;
          }
          round.turnCount += 1;
          this.#putRound(round);
          return this.#claim(group, round, turn, member, fence, true);
        }
        Object.assign(round, { status: "done", updatedAt: this.now() });
        this.#putRound(round);
      }
    });
  }

  #claim(group, round, turn, member, fence, floor) {
    const binding = this.#ensureBinding(member);
    const members = this.#members(group.id);
    const cards = this.#cards(group.id);
    // 成员自己说过的话已经在它的会话里，只给别人说的；新会话（首次或换过会话）看最近几条，含它自己的。
    const fresh = !binding.session_key;
    const rows = fresh
      ? this.db.prepare("SELECT data FROM messages WHERE group_id=? ORDER BY seq DESC LIMIT ?").all(group.id, FIRST_LOOK).map(parse).reverse()
      : this.db.prepare("SELECT data FROM messages WHERE group_id=? AND seq>? ORDER BY seq").all(group.id, binding.watermark).map(parse)
        .filter(message => message.author.kind !== "member" || message.author.memberId !== member.id);
    const unseen = rows.slice(-DELTA_MAX);
    // 新会话只看最近几条：告诉它前面还有多少条没列出（原生成员可以用 group_messages_read 回查）。
    const olderThanFirstLook = fresh && rows.length
      ? this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=? AND seq<?").get(group.id, rows[0].seq).n : 0;
    const startSeq = round?.startSeq ?? group.lastSeq;
    const order = round ? round.order.map(id => this.#turn(id)) : [turn];
    const status = (item) => {
      if (item.id === turn.id) return "speaking";
      if (item.state === "replied") return "posted";
      if (item.state === "passed") return "passed";
      if (item.state === "failed") return item.errorCode === "GROUP_TURN_TIMEOUT" ? "missed" : "failed";
      if (item.state === "cancelled") return item.errorCode === "GROUP_MEMBER_REMOVED" ? "left" : "stopped";
      if (item.state === "waiting") return "approval";
      if (item.state === "running" && item.released) return item.releasedReason === "timeout" ? "missed" : "working";
      if (item.state === "queued" && item.released) return "busy";
      return null;
    };
    const working = this.#turns("group_id=? AND state IN ('running','waiting')", group.id)
      .filter(item => item.released && item.memberId !== member.id)
      .map(item => ({ memberId: item.memberId, since: item.releasedAt ?? item.startedAt ?? this.now() }));
    Object.assign(turn, { state: "running", floor, fence, startedAt: this.now(), sessionKey: binding.session_key,
      // 这一回合是不是在新会话上开始的（recordRun 之后 sessionKey 总会有值，不能拿它判断）。
      freshSession: fresh,
      inputThroughSeq: group.lastSeq, modelSelection: clone(member.modelSelection ?? null),
      activeSince: this.now(), activeElapsedMs: 0,
      // 这一回合看到的成员设定版本：读同伴设定时默认读这一版（seen），之后改了也能看出来。
      directorySnapshot: Object.fromEntries([...cards].filter(([, card]) => card.roleSnapshotId).map(([id, card]) => [id, card.roleSnapshotId])) });
    this.#putTurn(turn);
    const owner = this.#owner(group);
    return clone({ opportunity: turn, group, member, binding: this.#publicBinding(binding), ownerId: owner?.id ?? null,
      members: members.map(item => ({ ...item, card: cards.get(item.id) ?? null })),
      earlier: unseen.filter(message => message.seq < startSeq).slice(-EARLIER_MAX),
      current: unseen.filter(message => message.seq >= startSeq),
      omitted: olderThanFirstLook + Math.max(0, rows.length - unseen.length) + Math.max(0, unseen.filter(message => message.seq < startSeq).length - EARLIER_MAX),
      spokeThisRound: !fresh && binding.watermark >= startSeq,
      order: order.filter(Boolean).map(item => ({ memberId: item.memberId, status: status(item) })),
      position: Math.max(0, order.findIndex(item => item?.id === turn.id)),
      working, note: turn.note ?? "Your turn" });
  }

  getDiscussionBinding(groupId, memberId) {
    this.#ready(); const binding = this.#binding(groupId, memberId); return binding ? this.#publicBinding(binding) : null;
  }

  bindSession({ groupId, memberId, sessionKey, external = undefined, fence = undefined }) {
    return this.#write(() => {
      if (fence !== undefined && fence !== this.getDriverFence()) return null;
      const binding = this.#binding(groupId, memberId);
      if (!binding) fail("GROUP_CHAT_MEMBER_NOT_FOUND");
      if (binding.session_key && binding.session_key !== sessionKey) fail("GROUP_CHAT_STORE_CORRUPT");
      this.db.prepare(`UPDATE session_bindings SET session_key=?, external=? WHERE group_id=? AND member_id=?
        AND thread_id=? AND purpose=?`).run(sessionKey, mergeExternal(binding.external, external),
        groupId, memberId, MAIN_THREAD, DISCUSSION_PURPOSE);
      this.internalSessionKeys.add(sessionKey);
      return this.#publicBinding(this.#binding(groupId, memberId));
    });
  }

  /**
   * 成员的群内部会话在对方后端已经续接不上（典型：App 重启后 Hermes 不再认这条会话）：放弃旧会话，
   * 水位退回入群位置。下一次认领会新建会话，并给它看最近的群消息（含成员自己说过的话）。
   * 旧会话仍记作群内部会话，不回到普通会话列表。
   */
  resetSession({ groupId, memberId }) {
    return this.#write(() => {
      const binding = this.#binding(groupId, memberId);
      const member = this.#member(memberId);
      if (!binding?.session_key || !member) return null;
      const retired = [...retiredSessions(binding.external), binding.session_key].slice(-MAX_RETIRED_SESSIONS);
      this.db.prepare(`UPDATE session_bindings SET session_key=NULL, external=?, watermark=? WHERE group_id=?
        AND member_id=? AND thread_id=? AND purpose=?`).run(JSON.stringify({ retired }), member.joinedSeq,
        groupId, memberId, MAIN_THREAD, DISCUSSION_PURPOSE);
      return this.#publicBinding(this.#binding(groupId, memberId));
    });
  }

  /**
   * 原生成员的群内会话放不下这次输入、压缩也没成功，请求还没发给模型就被拒：退掉这条会话（仍算群内部会话），
   * 水位退回入群位置，同一位置换成一个新回合（新编号：旧编号的发送记录不会挡住它），新会话看最近的群消息。
   * 只换本回合开始前就有的会话；返回 null 时照常记失败（新会话上再被拒不会再换）。
   */
  renewSessionForTurn({ opportunityId, fence }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state) || turn.fence !== fence || fence !== this.getDriverFence()
        || turn.abortReason || turn.freshSession !== false) return null;
      const group = this.#group(turn.groupId);
      const member = this.#member(turn.memberId);
      const round = this.#round(turn.discussionId);
      const binding = this.#binding(turn.groupId, turn.memberId);
      if (group?.status !== "active" || member?.state !== "active" || !round?.order.includes(turn.id)
        || !binding?.session_key || binding.session_key !== turn.sessionKey) return null;
      const next = this.#newTurn(group, round, member.id, { kind: turn.kind, note: turn.note, calledBy: turn.calledBy ?? null,
        causeMessageIds: turn.causeMessageIds, released: turn.released === true });
      if (!next) return null;
      const retired = [...retiredSessions(binding.external), binding.session_key].slice(-MAX_RETIRED_SESSIONS);
      this.db.prepare(`UPDATE session_bindings SET session_key=NULL, external=?, watermark=? WHERE group_id=?
        AND member_id=? AND thread_id=? AND purpose=?`).run(JSON.stringify({ retired }), member.joinedSeq,
        group.id, member.id, MAIN_THREAD, DISCUSSION_PURPOSE);
      Object.assign(turn, { state: "cancelled", errorCode: "GROUP_SESSION_RENEWED", finishedAt: this.now() });
      this.#putTurn(turn);
      round.order = round.order.map(id => (id === turn.id ? next.id : id));
      if (round.turnCount > 0 && !turn.released) round.turnCount -= 1;
      this.#putRound(round);
      this.#systemMessage(group, { eventType: "session_renewed", memberId: member.id }, `renew:${turn.id}`);
      group.updatedAt = this.now();
      this.#putGroup(group);
      return { groupId: group.id, opportunityId: next.id };
    });
  }

  // 运行时接下这次输入后，成员会话里就有了截至 inputThroughSeq 的群消息。
  recordRun({ opportunityId, runId, sessionKey, runKind = "native", external = null, fence = undefined }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state)
        || (fence !== undefined && (fence !== this.getDriverFence() || turn.fence !== fence))) return null;
      Object.assign(turn, { runId, sessionKey, runKind, ...(external ? { external } : {}) });
      this.#putTurn(turn);
      const binding = this.#binding(turn.groupId, turn.memberId);
      if (binding && turn.inputThroughSeq !== null && binding.watermark < turn.inputThroughSeq) {
        this.db.prepare(`UPDATE session_bindings SET watermark=? WHERE group_id=? AND member_id=? AND thread_id=? AND purpose=?`)
          .run(turn.inputThroughSeq, turn.groupId, turn.memberId, MAIN_THREAD, DISCUSSION_PURPOSE);
      }
      return clone(turn);
    });
  }

  requestAbort({ opportunityId, reason }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state)) return null;
      if (!turn.abortReason) turn.abortReason = reason;
      if (turn.state === "waiting") {
        turn.state = "running";
        turn.activeSince = this.now();
      }
      if (turn.interaction?.status === "pending") turn.interaction.status = "cancelled";
      this.#putTurn(turn);
      return clone(turn);
    });
  }

  adopt({ opportunityId, fence }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state)) return null;
      turn.fence = fence;
      this.#putTurn(turn);
      return clone(turn);
    });
  }

  /**
   * 让出发言位：开始用工具一段时间后、或等用户审批时。回合在后台继续，下一位开始发言。
   * text：让位那一刻已经写出的正文，先作为一条消息发到群里；其中的 @ 照常叫人。
   */
  releaseTurn({ opportunityId, reason, fence = undefined, text = null }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !holdsFloor(turn) || (fence !== undefined && (fence !== this.getDriverFence() || turn.fence !== fence))) {
        return { changed: false, groupId: turn?.groupId ?? null };
      }
      Object.assign(turn, { released: true, releasedReason: reason, releasedAt: this.now() });
      const group = this.#group(turn.groupId);
      const member = this.#member(turn.memberId);
      let messageId = null;
      const body = typeof text === "string" ? text.trim() : "";
      if (reason === "working" && body && !isPassReply(body) && group.status === "active" && member?.state === "active") {
        const message = this.#publish(group, turn, member, body, { partial: true });
        turn.postedText = body;
        messageId = message.id;
      }
      this.#putTurn(turn);
      this.#putGroup(group);
      return { changed: true, groupId: turn.groupId, messageId };
    });
  }

  /**
   * 回合在等用户审批或补充输入：交互卡挂在群上，同时让出发言位。
   * 同一请求重复上报不改变状态；换了新请求就替换。用户答案从不写进群库。
   */
  markWaiting({ opportunityId, interaction }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state) || turn.abortReason) return null;
      if (turn.interaction?.request?.requestId === interaction.request.requestId
        || turn.interactionRequestIds?.includes(interaction.request.requestId)) {
        return { changed: false, opportunity: clone(turn) };
      }
      if (turn.state === "running") {
        turn.activeElapsedMs = (turn.activeElapsedMs ?? 0) + Math.max(0, this.now() - (turn.activeSince ?? turn.startedAt));
        turn.activeSince = null;
      }
      if (holdsFloor(turn)) Object.assign(turn, { released: true, releasedReason: "approval", releasedAt: this.now() });
      turn.interactionRequestIds = [...(turn.interactionRequestIds ?? []), interaction.request.requestId];
      turn.state = "waiting";
      turn.interaction = { request: interaction.request, context: interaction.context ?? null,
        status: "pending", occurredAt: this.now() };
      this.#putTurn(turn);
      return { changed: true, opportunity: clone(turn) };
    });
  }

  markInteractionResponded({ opportunityId, requestId }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || turn.state !== "waiting" || turn.abortReason
        || turn.interaction?.status !== "pending" || turn.interaction?.request?.requestId !== requestId) return null;
      turn.interaction.status = "responded";
      turn.state = "running";
      turn.activeSince = this.now();
      this.#putTurn(turn);
      return clone(turn);
    });
  }

  // 执行身份与核对状态一起落库。结果不确定时仍保留运行占用，不以失败释放重试入口。
  #updateExecution({ id, runId, fence = undefined }, update) {
    return this.#write(() => {
      const record = this.#turn(id);
      if (!record || !ACTIVE_TURN.includes(record.state) || (runId && record.runId !== runId)
        || (fence !== undefined && (fence !== this.getDriverFence() || record.fence !== fence))) return null;
      const before = JSON.stringify(record);
      update(record);
      const changed = before !== JSON.stringify(record);
      if (changed) this.#putTurn(record);
      return { groupId: record.groupId, changed, record: clone(record) };
    });
  }

  recordExecutionObservation(input) {
    return this.#updateExecution(input, (record) => {
      const hostChanged = input.hostId && record.external && record.external.hostId !== input.hostId;
      if (input.hostId && record.external) record.external.hostId = input.hostId;
      const status = input.status;
      const at = input.at ?? this.now();
      const unknown = ["queued", "unknown", "unavailable"].includes(status);
      const prior = record.observation;
      const queued = input.dispatchState === "queued" && status === "queued" && input.sequence === 0 && prior?.acceptedAt == null;
      record.observation = {
        acceptedAt: prior?.acceptedAt ?? (unknown ? null : at),
        dispatchState: queued ? "queued" : null,
        sequence: input.sequence ?? (hostChanged ? null : prior?.sequence ?? null),
        status, terminalStatus: prior?.terminalStatus ?? (["completed", "failed", "canceled", "interrupted"].includes(status) ? status : null),
        at: prior?.status === status ? prior.at : at,
        unknownSince: unknown && !queued ? prior?.unknownSince ?? at : null,
      };
      if (record.runKind === "external" && prior?.acceptedAt == null) {
        if (queued) record.activeSince = null;
        else if (!unknown) { record.activeSince = this.now(); record.activeElapsedMs = 0; }
      }
      if ((!unknown || queued && record.recovery?.reason === "GROUP_EXTERNAL_START_UNCONFIRMED")
        && record.recovery?.type === "execution" && !record.recovery.cancelRequested) record.recovery = null;
    });
  }

  recordExecutionCapabilities({ capabilities, ...input }) {
    return this.#updateExecution(input, record => { record.executionCapabilities = clone(capabilities); });
  }

  markReconciliation({ type = "execution", reason, cancelRequested = false, ...input }) {
    return this.#updateExecution(input, (record) => {
      record.recovery = { type, reason, since: record.recovery?.since ?? this.now(),
        cancelRequested: cancelRequested || record.recovery?.cancelRequested === true };
      if (record.state === "waiting" && (cancelRequested || type === "result")) {
        record.state = "running";
        record.activeSince = this.now();
      }
      if ((cancelRequested || type === "result") && record.interaction?.status === "pending") record.interaction.status = "cancelled";
    });
  }

  // 运行从未被接受（崩溃在认领与发送之间）时，回合回到原位置，不算一次发言。
  requeue({ opportunityId }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || turn.state !== "running" || turn.runId) return null;
      Object.assign(turn, { state: "queued", fence: null, startedAt: null, inputThroughSeq: null, floor: false });
      this.#putTurn(turn);
      const round = this.#round(turn.discussionId);
      if (round && round.turnCount > 0 && !turn.released) { round.turnCount -= 1; this.#putRound(round); }
      return clone(turn);
    });
  }

  /** 成员的一条群消息（最终回答或让位时已写出的正文）。 */
  #publish(group, turn, member, text, { partial = false, attachments = [], replyToSeq = null, responseMetadata = null } = {}) {
    const quoted = replyToSeq === null ? null : parse(this.db.prepare(
      "SELECT data FROM messages WHERE group_id=? AND seq=?").get(group.id, replyToSeq));
    const replyTo = quoted && quoted.author.kind !== "system" ? replySnapshot(quoted) : null;
    const active = this.#members(group.id, { activeOnly: true });
    const parsed = parseMentions(text, active.map((peer) => ({ memberId: peer.id, handle: peer.handle })));
    const called = parsed.memberIds.filter((id) => id !== member.id);
    const owner = this.#owner(group);
    const late = turn.released && !partial;
    const message = this.#insertMessage(group, {
      originKey: partial ? `turn-partial:${turn.id}` : `turn:${turn.id}`, author: { kind: "member", memberId: member.id },
      body: utf8Prefix(text, MAX_MEMBER_REPLY_BYTES), fullResult: { bytes: Buffer.byteLength(text, "utf8"), digest: sha256(text) },
      mentions: { memberIds: called, broadcast: parsed.broadcast && member.id === owner?.id, unresolved: parsed.unresolved },
      origin: { opportunityId: turn.id, runId: turn.runId, discussionId: turn.discussionId,
        ...(partial ? { partial: true } : {}), ...(late ? { late: true } : {}) },
      ...(replyTo ? { replyTo } : {}),
      ...(validResponseMetadata(responseMetadata) ? { responseMetadata: clone(responseMetadata) } : {}),
      ...(attachments.length ? { attachments: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) } : {}),
    });
    this.db.prepare("INSERT INTO message_results VALUES(?,?,?,?)").run(message.id, text, message.fullResult.digest, message.fullResult.bytes);
    this.#route(group, turn, member, message, { late });
    return message;
  }

  // 一条成员消息之后谁接着说：发言位上的回复里 @ 了谁，谁插到下一位；后台交回的结果开一轮，由派活者回应。
  #route(group, turn, member, message, { late = false, done = false } = {}) {
    const active = this.#members(group.id, { activeOnly: true });
    const owner = this.#owner(group);
    const isOwner = member.id === owner?.id;
    const mentionIds = message?.mentions.memberIds ?? [];
    const broadcast = Boolean(message?.mentions.broadcast);
    if (!late && !done) {
      const round = this.#round(turn.discussionId);
      if (!round || round.status !== "running") return;
      const callees = openingSpeakers({ active, ownerId: owner?.id ?? null, author: { kind: "member", memberId: member.id },
        mentionIds, broadcast });
      if (!callees.length) return;
      this.#insertSpeakers(group, round, turn.id, callees, { cap: isOwner ? ROUND_LIMITS.ownerCallCap : ROUND_LIMITS.memberCallCap,
        kind: "call", calledBy: member.id, note: `${member.displayName} invited you`, causeMessageId: message.id });
      round.updatedAt = this.now();
      this.#putRound(round);
      return;
    }
    if ((group.lateRounds ?? 0) >= ROUND_LIMITS.lateRounds) return;
    const speakers = openingSpeakers({ active, ownerId: owner?.id ?? null, author: { kind: "member", memberId: member.id },
      mentionIds, broadcast, late: true, calledBy: turn.calledBy ?? null });
    if (!speakers.length) return;
    group.lateRounds = (group.lateRounds ?? 0) + 1;
    const cause = message ?? this.#systemMessage(group, { eventType: "work_done", memberId: member.id }, `work-done:${turn.id}`);
    this.#newRound(group, { kind: "late", causeMessage: cause, speakers, calledBy: member.id,
      notes: (memberId) => (memberId === turn.calledBy && !mentionIds.includes(memberId)
        ? `${member.displayName} finished the work you assigned` : `${member.displayName} invited you`) });
  }

  /**
   * 提交一次成员回合的终态。重复或迟到的提交不产生第二条消息。
   * @param {{opportunityId: string, fence: number, status: string, text?: string|null, errorCode?: string|null,
   *   attachments?: object[], replyToSeq?: number|null}} input attachments / replyToSeq：成员随回复发的文件
   *   （已存进媒体库）与它引用的消息序号，由驱动从回复文本里解析并核对
   */
  completeTurn({ opportunityId, fence, status, text = null, errorCode = null, attachments = [], replyToSeq = null, responseMetadata = null }) {
    return this.#write(() => {
      const turn = this.#turn(opportunityId);
      if (!turn || !ACTIVE_TURN.includes(turn.state) || turn.fence !== fence || fence !== this.getDriverFence()) {
        return { changed: false, groupId: turn?.groupId ?? null };
      }
      const group = this.#group(turn.groupId);
      const member = this.#member(turn.memberId);
      const round = this.#round(turn.discussionId);
      if (typeof text === "string") {
        const header = parseReplyHeader(text);
        const quoted = header.replyToSeq === null ? null : parse(this.db.prepare(
          "SELECT data FROM messages WHERE group_id=? AND seq=?").get(group.id, header.replyToSeq));
        if (quoted && quoted.author.kind !== "system") { text = header.body; replyToSeq = quoted.seq; }
      }
      // 让位时已经发出的那段正文不重复发。
      if (typeof text === "string" && turn.postedText) {
        const trimmed = text.trim();
        if (trimmed.startsWith(turn.postedText)) text = trimmed.slice(turn.postedText.length).trim();
      }
      const finish = (state, extra = {}) => Object.assign(turn, { state, finishedAt: this.now(), ...extra });
      let message = null;
      if (group.status !== "active" || USER_STOPS.has(turn.abortReason) || member.state !== "active") {
        finish("cancelled", { errorCode: turn.abortReason ?? "GROUP_DISCUSSION_STOPPED" });
        if (turn.abortReason === "GROUP_MEMBER_STOPPED" && group.status === "active") {
          message = this.#systemMessage(group, { eventType: "turn_stopped", memberId: member.id }, `turn:${turn.id}`);
        }
      } else if (turn.abortReason || status !== "completed") {
        const code = turn.abortReason ?? errorCode ?? `GROUP_TURN_${String(status).toUpperCase()}`;
        finish("failed", { errorCode: code });
        message = this.#systemMessage(group, { eventType: "turn_failed", memberId: member.id, errorCode: code }, `turn:${turn.id}`);
        this.#ownerFallback(group, round, turn);
      } else if (attachments.length === 0 && (typeof text !== "string" || !text.trim()) && !turn.postedText) {
        turn.recovery = { type: "result", reason: "GROUP_TURN_RESULT_EMPTY", since: this.now(), cancelRequested: false };
      } else if (attachments.length === 0 && (typeof text !== "string" || !text.trim() || isPassReply(text))) {
        finish("passed");
        // 后台干完了、结果在之前的话里已经说过：告诉派活者它做完了。
        if (turn.released && turn.postedText) this.#route(group, turn, member, null, { done: true });
      } else {
        message = this.#publish(group, turn, member, text ?? "", { attachments, replyToSeq, responseMetadata });
        finish("replied", { resultMessageId: message.id });
      }
      if (["replied", "passed"].includes(turn.state)) turn.recovery = null;
      if (turn.state === "passed" && turn.postedText && validResponseMetadata(responseMetadata)) {
        const prior = parse(this.db.prepare("SELECT data FROM messages WHERE group_id=? AND origin_key=?")
          .get(group.id, `turn-partial:${turn.id}`));
        if (prior?.author?.kind === "member" && prior.author.memberId === member.id) {
          prior.responseMetadata = clone(responseMetadata);
          this.db.prepare("UPDATE messages SET data=? WHERE id=? AND group_id=?")
            .run(JSON.stringify(prior), prior.id, group.id);
        }
      }
      this.#putTurn(turn);
      this.#putGroup(group);
      return { changed: true, groupId: group.id, state: turn.state, messageId: message?.id ?? null };
    });
  }

  // 群主开口失败（不是跳过、也不是被用户停下）时，这条消息顺延给名单里下一位可用成员，只顺延一次。
  #ownerFallback(group, round, turn) {
    if (!round || round.status !== "running" || !round.plain || round.ownerFallback || turn.kind !== "open"
      || !turn.floor || round.order[0] !== turn.id) return;
    const cards = this.#cards(group.id);
    const active = this.#members(group.id, { activeOnly: true });
    const failed = active.find(member => member.id === turn.memberId);
    const next = [...active.filter(member => member.position > (failed?.position ?? -1)), ...active.filter(member => member.position < (failed?.position ?? -1))]
      .find(member => member.id !== turn.memberId && cards.get(member.id)?.availability !== "offline");
    if (!next) return;
    round.ownerFallback = true;
    this.#insertSpeakers(group, round, turn.id, [next.id], { cap: ROUND_LIMITS.ownerCallCap, kind: "open", calledBy: null,
      note: "New user message (the owner could not answer)", causeMessageId: round.causeMessageId });
    round.limit += 1;
    this.#putRound(round);
  }

  // ---- 外部成员群工具令牌：新机制不再签发，旧令牌在这里一律失效 ----

  /** 令牌只在它所属的回合仍在进行时有效；返回调用方的群、成员与回合。 */
  resolveToolGrant(token) {
    this.#ready();
    const parsed = parseGrantToken(token);
    if (!parsed || parsed.kind !== "turn") return null;
    const turn = this.#turn(parsed.refId);
    const valid = (turn?.toolGrants ?? []).some((grant) => grant.expiresAt > this.now() && sameDigest(grant.digest, parsed.digest));
    if (!turn || !ACTIVE_TURN.includes(turn.state) || turn.abortReason || turn.observation?.terminalStatus || !valid) return null;
    return { kind: "turn", opportunity: turn, task: null, attempt: null };
  }
}

module.exports = { DEFAULT_LIMITS, GroupChatStore, MAIN_THREAD };
