import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { UnifiedCronJob } from "../types";
import { occurrencesOnDay, hourlyOccurrencesOnDay, type DayOccurrences } from "../lib/cronOccurrences";

const VISIBLE_CHIPS = 3; // month-view chips per day before "+N"
const MAX_PER_CELL = 5; // week-view event rows per hour-cell before folding
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface DayEntry {
  job: UnifiedCronJob;
  occ: DayOccurrences;
  first: number;
}
interface DayCell {
  date: Date;
  inMonth: boolean;
  entries: DayEntry[];
}
// A job's occurrences collapsed within one hour (fires N times → one ×N row).
interface JobGroup {
  job: UnifiedCronJob;
  time: number; // earliest fire that hour
  count: number;
}

export type CalendarMode = "month" | "week" | "day";

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// 日期导航与标题渲染在页面工具栏（设计稿把它和筛选并成一排），但推算规则属于
// 日历自身，导出成纯函数由 CronPage 驱动受控的 cursor。
export function shiftCalendarCursor(cursor: Date, mode: CalendarMode, delta: number): Date {
  if (mode === "month") return new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  if (mode === "week") return new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + delta * 7);
  return new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + delta);
}

export function calendarRangeTitle(cursor: Date, mode: CalendarMode, t: TFunction): string {
  if (mode === "month") {
    return t("cron.calMonthTitle", { year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
  }
  if (mode === "week") {
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - cursor.getDay());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return `${start.getMonth() + 1}.${start.getDate()} - ${end.getMonth() + 1}.${end.getDate()}`;
  }
  return t("cron.calDayTitle", { year: cursor.getFullYear(), month: cursor.getMonth() + 1, day: cursor.getDate() });
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
// 本地推算的 occurrence 与后端给的 nextRunAt 会有秒级出入，按小时格对齐即可
// （周/日视图本来就把同一小时内的多次触发折成一行）。
function sameHour(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return sameDay(a, b) && a.getHours() === b.getHours();
}

// 只有真正跨日且用户仍停留在旧“今天”时，时钟才应推动日历视图。
export function shouldFollowCalendarDay(previous: Date, next: Date, cursor: Date): boolean {
  return !sameDay(previous, next) && sameDay(cursor, previous);
}
function fmtHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 对齐到下一分钟后刷新，跨小时/零点时 today 与当前小时标记都会自动更新。
export function nextCalendarClockDelay(nowMs = Date.now()): number {
  return 60_000 - (nowMs % 60_000) + 25;
}
function chipTitle(e: DayEntry, t: TFunction): string {
  const times = e.occ.times.map(fmtHM).join(" ");
  const more = e.occ.capped ? ` ${t("cron.calMoreCount", { count: e.occ.count })}` : "";
  const sched = e.job.scheduleDisplay ? ` · ${e.job.scheduleDisplay}` : "";
  const off = e.job.enabled ? "" : t("cron.calDisabledSuffix");
  return `${e.job.name}${off}${sched}\n${times}${more}`;
}

// Group a day's occurrences by hour, collapsing each job to one ×N row per hour
// (a job that fires every few minutes becomes a single ×N row, not a dozen).
// Drives off the exact per-hour expansion: `entries[].occ.times` is truncated at
// TIME_CAP for the month tooltip, so bucketing from it made high-frequency jobs
// disappear after the first couple of hours.
function hourBuckets(cell: DayCell): Map<number, JobGroup[]> {
  const byHour = new Map<number, JobGroup[]>();
  for (const e of cell.entries) {
    for (const [h, { first, count }] of hourlyOccurrencesOnDay(e.job, cell.date)) {
      let groups = byHour.get(h);
      if (!groups) byHour.set(h, (groups = []));
      groups.push({ job: e.job, time: first, count });
    }
  }
  for (const groups of byHour.values()) groups.sort((a, b) => a.time - b.time);
  return byHour;
}

export default function CronCalendar({
  jobs,
  cursor,
  mode,
  nextUp,
  onCursorChange,
  onModeChange,
  onJobClick,
}: {
  jobs: UnifiedCronJob[];
  cursor: Date;
  mode: CalendarMode;
  /** 全场下一个要触发的任务（页面算好传入），命中的那格渲染成纯黑。 */
  nextUp?: { id: string; at: number } | null;
  onCursorChange: (cursor: Date) => void;
  onModeChange: (mode: CalendarMode) => void;
  onJobClick?: (job: UnifiedCronJob, occurrenceMs?: number) => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  const nowRef = useRef(now);
  nowRef.current = now;
  const today = now;
  const nowHour = today.getHours();
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // 分钟定时器只挂载一次，跨日回调改从 ref 取最新的，避免重排期。
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    // 每次都重新按分钟边界排期，避免后台挂起后 interval 累积漂移。
    const schedule = () => {
      timer = window.setTimeout(() => {
        const previous = nowRef.current;
        const next = new Date();
        nowRef.current = next;
        setNow(next);
        // 分钟 tick 只更新时间；跨日且仍跟随旧今天时才推进 cursor。
        if (shouldFollowCalendarDay(previous, next, cursorRef.current)) {
          cursorRef.current = next;
          onCursorChangeRef.current(next);
        }
        schedule();
      }, nextCalendarClockDelay());
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  // Sunday-first week to match the calendar design (SUN … SAT).
  const WEEKDAYS = [
    t("cron.weekdaySun"),
    t("cron.weekdayMon"),
    t("cron.weekdayTue"),
    t("cron.weekdayWed"),
    t("cron.weekdayThu"),
    t("cron.weekdayFri"),
    t("cron.weekdaySat"),
  ];

  const cells = useMemo<DayCell[]>(() => {
    const buildCell = (date: Date, inMonth: boolean) => {
      const entries: DayEntry[] = [];
      for (const job of jobs) {
        const occ = occurrencesOnDay(job, date);
        if (occ.count > 0) entries.push({ job, occ, first: occ.times[0] ?? 0 });
      }
      entries.sort((a, b) => {
        if (a.job.enabled !== b.job.enabled) return a.job.enabled ? -1 : 1;
        return a.first - b.first;
      });
      return { date, inMonth, entries };
    };

    const out: DayCell[] = [];
    if (mode === "month") {
      const first = startOfMonth(cursor);
      const offset = first.getDay(); // Sunday-start grid
      const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
      for (let i = 0; i < 42; i += 1) {
        const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
        out.push(buildCell(date, date.getMonth() === cursor.getMonth()));
      }
    } else if (mode === "week") {
      const offset = cursor.getDay();
      const gridStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - offset);
      for (let i = 0; i < 7; i += 1) {
        const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
        out.push(buildCell(date, true));
      }
    } else if (mode === "day") {
      out.push(buildCell(cursor, true));
    }
    return out;
  }, [jobs, cursor, mode]);

  // Per-day hour buckets for the time views.
  const dayBuckets = useMemo(
    () => (mode === "month" ? [] : cells.map(hourBuckets)),
    [cells, mode],
  );
  // First hour that has any event (to scroll past empty pre-dawn hours).
  const firstHour = useMemo(() => {
    let h = Infinity;
    for (const b of dayBuckets) for (const k of b.keys()) h = Math.min(h, k);
    return Number.isFinite(h) ? h : 0;
  }, [dayBuckets]);

  // Collapse any expanded cells + scroll to the first event when the range changes.
  useEffect(() => {
    setExpanded(new Set());
  }, [cursor, mode]);
  useEffect(() => {
    if (mode === "month" || !scrollRef.current) return;
    const rows = scrollRef.current.querySelectorAll<HTMLElement>(".cal-hrow");
    const row = rows[firstHour];
    if (row) scrollRef.current.scrollTop = Math.max(0, row.offsetTop - 4);
  }, [mode, cursor, firstHour]);

  const toggleCell = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 月视图格高 = 日历高 ÷ 6，随窗口浮动；写死「每格 3 条」会在矮窗口下把最后一条
  // 裁成半截（.cal-cell 是 overflow:hidden）。这里按实测格高反推能整条放下几个：
  // 全部放得下就全放，放不下则先扣掉「+N」那一行再算，保证永远不出现半截。
  const monthGridRef = useRef<HTMLDivElement>(null);
  const [chipFit, setChipFit] = useState({ full: VISIBLE_CHIPS, withMore: VISIBLE_CHIPS });

  useEffect(() => {
    if (mode !== "month") return;
    const grid = monthGridRef.current;
    if (!grid) return;
    const measure = () => {
      const chips = grid.querySelector<HTMLElement>(".cal-chips");
      const chip = grid.querySelector<HTMLElement>(".cal-chip");
      if (!chips || !chip) return; // 整月无任务时无从测量，保持默认值即可
      const box = chips.clientHeight;
      const chipH = chip.getBoundingClientRect().height;
      if (!box || !chipH) return;
      const gap = parseFloat(getComputedStyle(chips).gap) || 0;
      const more = grid.querySelector<HTMLElement>(".cal-more");
      const moreH = more ? more.getBoundingClientRect().height : chipH / 2;
      const fit = (h: number) => Math.max(1, Math.floor((h + gap) / (chipH + gap)));
      const next = { full: fit(box), withMore: fit(box - moreH - gap) };
      // 值没变就返回同一引用，避免 ResizeObserver → setState → 布局 的自激循环。
      setChipFit((prev) => (prev.full === next.full && prev.withMore === next.withMore ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [mode]);

  // Month cell → that day's day view (the date-number row and the "+N" row are
  // both clickable shortcuts).
  const goToDay = (date: Date) => {
    onCursorChange(new Date(date.getFullYear(), date.getMonth(), date.getDate()));
    onModeChange("day");
  };

  // Pill-style event (calendar design): name only, exact time lives in the
  // tooltip; the ×N badge stays for jobs that fire several times within the hour.
  const renderEvent = (g: JobGroup) => (
    <button
      key={`${g.job.id}-${g.time}`}
      className={
        `cal-ev cal-ev-${g.job.backendId}` +
        (g.job.enabled ? "" : " cal-ev-off") +
        // 触发时刻已过 → 底色抽空，只留文字（×N 的组按首次触发算）。
        (g.time < today.getTime() ? " is-past" : "") +
        (nextUp && g.job.id === nextUp.id && sameHour(g.time, nextUp.at) ? " is-next" : "")
      }
      title={`${g.job.name}${g.count > 1 ? ` ×${g.count}` : ""}${g.job.scheduleDisplay ? ` · ${g.job.scheduleDisplay}` : ""}\n${fmtHM(g.time)}`}
      onClick={() => onJobClick?.(g.job, g.time)}
    >
      <span className="cal-ev-name">{g.job.name}</span>
      {g.count > 1 ? <span className="cal-ev-n">×{g.count}</span> : null}
    </button>
  );

  return (
    <div className={`cal cal-mode-${mode}`}>
      {mode === "month" ? (
        <div className="cal-grid cal-grid-month" ref={monthGridRef}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="cal-wd">
              {w}
            </div>
          ))}
          {cells.map((cell) => {
            const visible = cell.entries.slice(
              0,
              cell.entries.length <= chipFit.full ? cell.entries.length : chipFit.withMore,
            );
            const extra = cell.entries.length - visible.length;
            const cls =
              "cal-cell" +
              (cell.inMonth ? "" : " cal-out") +
              (sameDay(cell.date, today) ? " cal-today" : "");
            return (
              <div key={cell.date.toISOString()} className={cls}>
                <div
                  className="cal-day"
                  role="button"
                  tabIndex={0}
                  title={t("cron.calViewDay")}
                  onClick={() => goToDay(cell.date)}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); goToDay(cell.date); } }}
                >
                  {cell.date.getDate()}
                </div>
                <div className="cal-chips">
                  {visible.map((e) => (
                    <span
                      key={e.job.id}
                      className={
                        `cal-chip cal-chip-${e.job.backendId}` +
                        (e.job.enabled ? "" : " cal-chip-off") +
                        (e.first < today.getTime() ? " is-past" : "") +
                        (nextUp && e.job.id === nextUp.id && sameDay(cell.date, new Date(nextUp.at)) ? " is-next" : "")
                      }
                      title={chipTitle(e, t)}
                      role="button"
                      tabIndex={0}
                      onClick={(ev) => { ev.stopPropagation(); onJobClick?.(e.job, e.first); }}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onJobClick?.(e.job, e.first); } }}
                    >
                      <span className="cal-chip-time">{fmtHM(e.first)}</span>
                      <span className="cal-chip-name">{e.job.name}</span>
                      {e.occ.count > 1 && <span className="cal-chip-n">×{e.occ.count}</span>}
                    </span>
                  ))}
                  {extra > 0 && (
                    <span
                      className="cal-more"
                      role="button"
                      tabIndex={0}
                      title={t("cron.calViewDay")}
                      onClick={() => goToDay(cell.date)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); goToDay(cell.date); } }}
                    >
                      +{extra}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`cal-tg cal-tg-${mode}`}>
          <div className="cal-tg-head">
            <div className="cal-tg-gutter" />
            {cells.map((cell) => (
              <div
                key={cell.date.toISOString()}
                className={"cal-tg-chead" + (sameDay(cell.date, today) ? " is-today" : "")}
              >
                <span className="cal-tg-dow">{WEEKDAYS[cell.date.getDay()]}</span>
                <span className="cal-tg-date">{cell.date.getDate()}</span>
              </div>
            ))}
          </div>
          <div className="cal-tg-body" ref={scrollRef}>
            {HOURS.map((h) => {
              const rowHasEv = dayBuckets.some((b) => (b.get(h)?.length ?? 0) > 0);
              return (
                <div key={h} className={"cal-hrow" + (rowHasEv ? " has-ev" : "")}>
                  <div className="cal-hlabel">{`${String(h).padStart(2, "0")}:00`}</div>
                  {cells.map((cell, ci) => {
                    const groups = dayBuckets[ci]?.get(h) ?? [];
                    const key = `${ci}-${h}`;
                    const isOpen = expanded.has(key);
                    const cap = mode === "day" ? groups.length : MAX_PER_CELL;
                    const shown = isOpen ? groups : groups.slice(0, cap);
                    const hidden = groups.length - shown.length;
                    const isNow = sameDay(cell.date, today) && h === nowHour;
                    return (
                      <div
                        key={ci}
                        className={"cal-hcell" + (isNow ? " is-now" : "")}
                        // 当前时间线按分钟落在小时格内的比例定位（CSS 画线，这里只给位置）。
                        style={isNow ? ({ "--cal-now-at": `${(today.getMinutes() / 60) * 100}%` } as CSSProperties) : undefined}
                      >
                        {shown.map(renderEvent)}
                        {hidden > 0 && (
                          <button className="cal-hmore" onClick={() => toggleCell(key)}>
                            {t("cron.calMorePlus", { count: hidden })}
                          </button>
                        )}
                        {isOpen && groups.length > MAX_PER_CELL && (
                          <button className="cal-hless" onClick={() => toggleCell(key)}>
                            {t("cron.calCollapse")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
