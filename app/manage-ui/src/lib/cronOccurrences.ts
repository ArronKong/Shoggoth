// Expand a UnifiedCronJob's schedule into the run times that fall on a given
// local calendar day — the engine behind the cron calendar view.
//
// Scope/altitude: this is an overview calendar, not the scheduler. Cron fields
// are evaluated in the schedule's IANA tz when one is present (converted to the
// browser's local day for display, CRON-006); otherwise in the browser's local
// time. Anything it can't expand falls back to the backend-computed nextRunAt
// so a job still appears at least once.

import type { UnifiedCronJob } from "../types";

const DAY_MS = 86_400_000;
const TIME_CAP = 8; // max materialized run-times per job per day (count stays exact)

// 真实的"次日本地午夜"。DST 切换日的一天不是 86_400_000ms —— Date 构造器
// 按本地日历字段进位，天边界永远正确（CRON-007）。
function nextLocalMidnight(day: Date): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0).getTime();
}

type Field = Set<number> | "*";

interface CronFields {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export interface DayOccurrences {
  times: number[]; // sorted epoch ms, materialized up to TIME_CAP
  count: number; // exact total runs that day
  capped: boolean; // count > times.length
}

// One hour's worth of a job's runs. `count` is exact — no TIME_CAP — because the
// week/day views place jobs into hour cells and must not lose the later hours.
export interface HourOccurrence {
  first: number; // epoch ms of the first run in that hour
  count: number; // exact runs within that hour
}

const EMPTY: DayOccurrences = { times: [], count: 0, capped: false };

// 解析失败返回 null（越界、*/0、倒序 range、无有效值）。绝不回退成 "*" ——
// 那会把一个坏字段放大成每分钟级的幽灵日程（CRON-008）。
function parseField(token: string, min: number, max: number): Field | null {
  if (token === "*") return "*";
  const set = new Set<number>();
  for (const part of token.split(",")) {
    const slash = part.indexOf("/");
    const step = slash >= 0 ? parseInt(part.slice(slash + 1), 10) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    const range = slash >= 0 ? part.slice(0, slash) : part;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(range, 10);
      // N/step 等价 N-max/step（裸 N 仍是单值）。dow 的合法上界是 7 而非归一用的 6：
      // 用 6 会让 `1/2` 漏掉周日（下面 v===7 会折回 0），用 lo 夹底则防 `7/2` 出现 lo>hi。
      const stepMax = max === 6 ? 7 : max;
      hi = slash >= 0 ? Math.max(stepMax, lo) : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) {
      const vv = max === 6 && v === 7 ? 0 : v; // cron dow 7 == Sunday
      if (vv < min || vv > max) return null;
      set.add(vv);
    }
  }
  return set.size ? set : null;
}

export function parseCronExpr(expr: string): CronFields | null {
  const f = (expr || "").trim().split(/\s+/);
  if (f.length !== 5) return null; // only standard 5-field cron
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: f[2] !== "*",
    dowRestricted: f[4] !== "*",
  };
}

// ---- schedule tz 支持（CRON-006）------------------------------------------
// 纯 Intl 实现，无依赖。DateTimeFormat 实例按 tz 缓存（构造开销大）；非法
// IANA 名缓存 null，调用方回退本地解释（fail-soft）。
const tzFmtCache = new Map<string, Intl.DateTimeFormat | null>();
function tzFmt(tz: string): Intl.DateTimeFormat | null {
  if (tzFmtCache.has(tz)) return tzFmtCache.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
  } catch {
    f = null;
  }
  tzFmtCache.set(tz, f);
  return f;
}

const TZ_DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface WallClock { y: number; mo: number; d: number; h: number; mi: number; dow: number }

// 某个绝对时刻在 tz 里的墙钟字段。
function tzWallClock(t: number, fmt: Intl.DateTimeFormat): WallClock {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(t)) parts[p.type] = p.value;
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour) % 24, mi: Number(parts.minute), dow: TZ_DOW[parts.weekday] ?? 0,
  };
}

// tz 墙钟 → 绝对时刻（两轮偏移校正；DST 跳掉的墙钟返回 null）。
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, fmt: Intl.DateTimeFormat): number | null {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const wc = tzWallClock(guess, fmt);
    const asUtc = Date.UTC(wc.y, wc.mo - 1, wc.d, wc.h, wc.mi, 0, 0);
    const want = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
    if (asUtc === want) return guess;
    guess += want - asUtc;
  }
  const wc = tzWallClock(guess, fmt);
  return wc.y === y && wc.mo === mo && wc.d === d && wc.h === h && wc.mi === mi ? guess : null;
}

function inField(field: Field, v: number): boolean {
  return field === "*" || field.has(v);
}

function fieldList(field: Field, min: number, max: number): number[] {
  if (field !== "*") return [...field].sort((a, b) => a - b);
  const all: number[] = [];
  for (let v = min; v <= max; v += 1) all.push(v);
  return all;
}

function cronMatchesDay(c: CronFields, d: Date): boolean {
  if (!inField(c.month, d.getMonth() + 1)) return false;
  const domOk = inField(c.dom, d.getDate());
  const dowOk = inField(c.dow, d.getDay());
  // Vixie cron: when both day-of-month and day-of-week are restricted, a day
  // matches if EITHER matches; otherwise honor whichever is restricted.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

function cronDay(c: CronFields, day: Date, fromMs = -Infinity): DayOccurrences {
  if (!cronMatchesDay(c, day)) return EMPTY;
  const hours = fieldList(c.hour, 0, 23);
  const mins = fieldList(c.minute, 0, 59);
  const y = day.getFullYear();
  const mo = day.getMonth();
  const d = day.getDate();
  const dayStart = new Date(y, mo, d, 0, 0, 0, 0).getTime();
  const dayEnd = nextLocalMidnight(day);
  const isDstDay = dayEnd - dayStart !== DAY_MS;
  // Fast path: normal 24h day, no lower bound inside it → original O(1)-count behavior.
  if (!isDstDay && !(fromMs > dayStart)) {
    const count = hours.length * mins.length;
    const times: number[] = [];
    for (const h of hours) {
      for (const m of mins) {
        times.push(new Date(y, mo, d, h, m, 0, 0).getTime());
        if (times.length >= TIME_CAP) return { times, count, capped: count > times.length };
      }
    }
    return { times, count, capped: count > times.length };
  }
  // 精确路径：DST 日逐枚验证（跳掉的钟点被 Date 规整到别的小时 → 当天不存在，
  // 丢弃；回拨日同一墙钟只取 Date 构造器给的那一枚 = vixie「跑一次」语义），
  // 或创建日裁剪（CRON-007 / 既有 fromMs 行为）。
  let count = 0;
  const times: number[] = [];
  for (const h of hours) {
    for (const m of mins) {
      const dt = new Date(y, mo, d, h, m, 0, 0);
      const t = dt.getTime();
      if (t < fromMs || t < dayStart || t >= dayEnd) continue;
      if (isDstDay && (dt.getHours() !== h || dt.getMinutes() !== m)) continue; // 不存在的本地时刻
      count += 1;
      if (times.length < TIME_CAP) times.push(t);
    }
  }
  return { times, count, capped: count > times.length };
}

function cronMatchesWallClockDay(c: CronFields, wc: WallClock): boolean {
  if (!inField(c.month, wc.mo)) return false;
  const domOk = inField(c.dom, wc.d);
  const dowOk = inField(c.dow, wc.dow);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

// 浏览器本地一天 [dayStart, dayEnd) 内、按 tz 墙钟展开的全部 cron 时刻（升序、
// 去重）。窗口两端在 tz 里最多横跨 2 个日历日；month/dom/dow 都按 tz 判定。
function cronTimesInWindowTz(c: CronFields, dayStart: number, dayEnd: number, fmt: Intl.DateTimeFormat, fromMs: number): number[] {
  const hours = fieldList(c.hour, 0, 23);
  const mins = fieldList(c.minute, 0, 59);
  const times = new Set<number>();
  const startWc = tzWallClock(dayStart, fmt);
  const endWc = tzWallClock(dayEnd - 1, fmt);
  const tzDays = [startWc];
  if (endWc.y !== startWc.y || endWc.mo !== startWc.mo || endWc.d !== startWc.d) tzDays.push(endWc);
  for (const wc of tzDays) {
    if (!cronMatchesWallClockDay(c, wc)) continue;
    for (const h of hours) {
      for (const m of mins) {
        const t = zonedInstant(wc.y, wc.mo, wc.d, h, m, fmt);
        if (t === null) continue;
        if (t >= dayStart && t < dayEnd && t >= fromMs) times.add(t);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

function cronDayTz(c: CronFields, dayStart: number, dayEnd: number, fmt: Intl.DateTimeFormat, fromMs: number): DayOccurrences {
  const all = cronTimesInWindowTz(c, dayStart, dayEnd, fmt, fromMs);
  if (!all.length) return EMPTY;
  return { times: all.slice(0, TIME_CAP), count: all.length, capped: all.length > TIME_CAP };
}

function cronHourlyTz(c: CronFields, dayStart: number, dayEnd: number, fmt: Intl.DateTimeFormat, fromMs: number): Map<number, HourOccurrence> {
  const out = new Map<number, HourOccurrence>();
  for (const t of cronTimesInWindowTz(c, dayStart, dayEnd, fmt, fromMs)) {
    const h = new Date(t).getHours(); // 显示桶用浏览器本地小时
    const cur = out.get(h);
    if (cur) {
      cur.count += 1;
      if (t < cur.first) cur.first = t;
    } else {
      out.set(h, { first: t, count: 1 });
    }
  }
  return out;
}

function everyDay(anchorMs: number, everyMs: number, dayStart: number, dayEnd: number, fromMs = -Infinity): DayOccurrences {
  if (!(everyMs > 0) || !Number.isFinite(anchorMs)) return EMPTY;
  const lo = Math.max(dayStart, fromMs); // don't surface fires before the job existed
  // every 只从 anchor 向未来展开，不能用负 k 反推 anchor 之前不存在的执行。
  const firstK = Math.max(0, Math.ceil((lo - anchorMs) / everyMs));
  const first = anchorMs + firstK * everyMs;
  if (first >= dayEnd) return EMPTY;
  const count = Math.floor((dayEnd - 1 - first) / everyMs) + 1;
  const times: number[] = [];
  for (let t = first, i = 0; t < dayEnd && i < TIME_CAP; t += everyMs, i += 1) times.push(t);
  return { times, count, capped: count > times.length };
}

function atDay(at: string | null, dayStart: number, dayEnd: number, fromMs = -Infinity): DayOccurrences {
  if (at == null) return EMPTY;
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(ms)) return EMPTY;
  if (ms >= dayStart && ms < dayEnd && ms >= fromMs) return { times: [ms], count: 1, capped: false };
  return EMPTY;
}

// Resolve the anchor an "every" schedule counts from.
function everyAnchor(job: UnifiedCronJob, anchorMs: unknown): number {
  if (typeof anchorMs === "number") return anchorMs;
  if (typeof job.nextRunAt === "number") return job.nextRunAt;
  return Date.now();
}

// Exact per-hour expansion. Hour boundaries come from the Date constructor rather
// than dayStart + h*3600_000 so a DST shift doesn't slide the buckets.
function cronHourly(c: CronFields, day: Date, fromMs: number): Map<number, HourOccurrence> {
  const out = new Map<number, HourOccurrence>();
  if (!cronMatchesDay(c, day)) return out;
  const y = day.getFullYear();
  const mo = day.getMonth();
  const d = day.getDate();
  const mins = fieldList(c.minute, 0, 59);
  for (const h of fieldList(c.hour, 0, 23)) {
    let first = -1;
    let count = 0;
    for (const m of mins) {
      const dt = new Date(y, mo, d, h, m, 0, 0);
      const t = dt.getTime();
      if (t < fromMs) continue;
      if (dt.getHours() !== h || dt.getMinutes() !== m) continue; // DST 跳时不存在的时刻（CRON-007）
      if (first < 0) first = t;
      count += 1;
    }
    if (count > 0) out.set(h, { first, count });
  }
  return out;
}

function everyHourly(anchorMs: number, everyMs: number, day: Date, fromMs: number): Map<number, HourOccurrence> {
  const out = new Map<number, HourOccurrence>();
  if (!(everyMs > 0) || !Number.isFinite(anchorMs)) return out;
  const y = day.getFullYear();
  const mo = day.getMonth();
  const d = day.getDate();
  for (let h = 0; h < 24; h += 1) {
    const hourStart = new Date(y, mo, d, h, 0, 0, 0).getTime();
    const hourEnd = new Date(y, mo, d, h + 1, 0, 0, 0).getTime();
    const lo = Math.max(hourStart, fromMs);
    if (lo >= hourEnd) continue;
    // 小时桶与日视图保持同一语义：anchor 之前没有任何 occurrence。
    const firstK = Math.max(0, Math.ceil((lo - anchorMs) / everyMs));
    const first = anchorMs + firstK * everyMs;
    if (first >= hourEnd) continue;
    const count = Math.floor((hourEnd - 1 - first) / everyMs) + 1;
    out.set(h, { first, count });
  }
  return out;
}

/**
 * Runs grouped by local hour. The week/day calendar views bucket jobs by hour and
 * collapse each to one ×N row, so they need every hour a job touches — not the
 * TIME_CAP-truncated sample `occurrencesOnDay` materializes for the month
 * tooltip. With that sample a `*​/15` job only ever reached 00:00–01:45 and looked
 * like it stopped running for the rest of the day.
 */
export function hourlyOccurrencesOnDay(job: UnifiedCronJob, day: Date): Map<number, HourOccurrence> {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = nextLocalMidnight(day);
  const createdAt = typeof job.createdAt === "number" ? job.createdAt : null;
  if (createdAt != null && dayEnd <= createdAt) return new Map();
  const fromMs = createdAt ?? -Infinity;
  const s = job.schedule;
  let out = new Map<number, HourOccurrence>();
  if (s?.kind === "cron") {
    const c = parseCronExpr(s.expr);
    const fmt = c && s.tz ? tzFmt(s.tz) : null;
    out = c ? (fmt ? cronHourlyTz(c, dayStart, dayEnd, fmt, fromMs) : cronHourly(c, day, fromMs)) : out;
  } else if (s?.kind === "every") {
    out = everyHourly(everyAnchor(job, s.anchorMs), Number(s.everyMs), day, fromMs);
  } else if (s?.kind === "at") {
    const occ = atDay(s.at, dayStart, dayEnd, fromMs);
    if (occ.count > 0) out.set(new Date(occ.times[0]).getHours(), { first: occ.times[0], count: 1 });
  }
  // Same fallback as occurrencesOnDay: an unexpandable schedule still shows its
  // backend-computed nextRunAt so the job isn't invisible.
  if (
    out.size === 0 &&
    typeof job.nextRunAt === "number" &&
    job.nextRunAt >= dayStart &&
    job.nextRunAt < dayEnd &&
    job.nextRunAt >= fromMs
  ) {
    out.set(new Date(job.nextRunAt).getHours(), { first: job.nextRunAt, count: 1 });
    return out;
  }
  // 表达式展开只知道基准时刻，看不到 OpenClaw 的 staggerMs（错峰，把实际触发
  // 推后最多 stagger 毫秒）。后端的 nextRunAt 才是权威值——把它所在的小时桶
  // 校正过来，格内排序与"下一个要跑的"高亮才对得上真实触发顺序：
  // `0 */8 * * *`+5min stagger 展开成 16:00，实际 16:03:05，会被误排在
  // 无 stagger 的 `2 */4 * * *`(16:02) 前面。只校正 nextRunAt 那一次（更远的
  // occurrence 后端也没给权威值），且只允许往后修（stagger 从不提前）。
  if (typeof job.nextRunAt === "number" && job.nextRunAt >= dayStart && job.nextRunAt < dayEnd) {
    const hour = new Date(job.nextRunAt).getHours();
    const bucket = out.get(hour);
    if (bucket && bucket.first <= job.nextRunAt) {
      out.set(hour, { first: job.nextRunAt, count: bucket.count });
    }
  }
  return out;
}

export function occurrencesOnDay(job: UnifiedCronJob, day: Date): DayOccurrences {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = nextLocalMidnight(day);
  // A job can't have fired before it existed: hide occurrences earlier than its
  // creation time. Whole days before creation show nothing; the creation day is
  // clipped to fires at/after createdAt. createdAt absent (older jobs / Hermes
  // without the field) → no clipping, original behavior.
  const createdAt = typeof job.createdAt === "number" ? job.createdAt : null;
  if (createdAt != null && dayEnd <= createdAt) return EMPTY;
  const fromMs = createdAt ?? -Infinity;
  const s = job.schedule;
  let occ: DayOccurrences = EMPTY;
  if (s?.kind === "cron") {
    const c = parseCronExpr(s.expr);
    const fmt = c && s.tz ? tzFmt(s.tz) : null;
    occ = c ? (fmt ? cronDayTz(c, dayStart, dayEnd, fmt, fromMs) : cronDay(c, day, fromMs)) : EMPTY;
  } else if (s?.kind === "every") {
    const anchor =
      typeof s.anchorMs === "number"
        ? s.anchorMs
        : typeof job.nextRunAt === "number"
          ? job.nextRunAt
          : Date.now();
    occ = everyDay(anchor, Number(s.everyMs), dayStart, dayEnd, fromMs);
  } else if (s?.kind === "at") {
    occ = atDay(s.at, dayStart, dayEnd, fromMs);
  }
  // Fallback: schedule couldn't be expanded but the backend's nextRunAt lands
  // on this day — show that single occurrence so the job isn't invisible.
  if (
    occ.count === 0 &&
    typeof job.nextRunAt === "number" &&
    job.nextRunAt >= dayStart &&
    job.nextRunAt < dayEnd &&
    job.nextRunAt >= fromMs
  ) {
    return { times: [job.nextRunAt], count: 1, capped: false };
  }
  return occ;
}
