import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { TextInput } from "../../components/Field";
import { IconCalendar, IconCalendarChevron } from "./cronIcons";
import styles from "./CronDatePicker.module.css";

// Use UTC for calendar arithmetic only. The form still submits a local date and time.
function calendarDay(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
}

const FIRST_DAY = calendarDay(1, 0, 1);
const LAST_DAY = calendarDay(9999, 11, 31);
const dateKey = (date: Date) => date.toISOString().slice(0, 10);

function shiftDays(date: Date, days: number) {
  return calendarDay(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function shiftMonths(date: Date, months: number) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const last = calendarDay(year, month + 1, 0).getUTCDate();
  return calendarDay(year, month, Math.min(date.getUTCDate(), last));
}

export default function CronDatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const format = useMemo(() => ({
    month: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }),
    day: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }),
  }), [locale]);
  const now = new Date();
  const today = calendarDay(now.getFullYear(), now.getMonth(), now.getDate());
  const parsed = new Date(`${value}T00:00:00Z`);
  const selected = parsed >= FIRST_DAY && parsed <= LAST_DAY && dateKey(parsed) === value ? parsed : null;
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => selected ?? today);
  const anchor = useRef<HTMLDivElement>(null);
  const activeDay = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const monthStart = calendarDay(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1);
  const weekStart = shiftDays(monthStart, -monthStart.getUTCDay());
  const title = format.month.format(cursor);

  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    activeDay.current?.focus();
  }, [cursor]);

  function changeOpen(next: boolean) {
    if (next) setCursor(selected ?? today);
    setOpen(next);
  }

  function choose(value: string) {
    onChange(value);
    setOpen(false);
  }

  function navigateDays(event: KeyboardEvent<HTMLTableElement>) {
    let next: Date;
    switch (event.key) {
      case "ArrowLeft": next = shiftDays(cursor, -1); break;
      case "ArrowRight": next = shiftDays(cursor, 1); break;
      case "ArrowUp": next = shiftDays(cursor, -7); break;
      case "ArrowDown": next = shiftDays(cursor, 7); break;
      case "Home": next = shiftDays(cursor, -cursor.getUTCDay()); break;
      case "End": next = shiftDays(cursor, 6 - cursor.getUTCDay()); break;
      case "PageUp": next = shiftMonths(cursor, event.shiftKey ? -12 : -1); break;
      case "PageDown": next = shiftMonths(cursor, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault();
    const target = next < FIRST_DAY ? FIRST_DAY : next > LAST_DAY ? LAST_DAY : next;
    if (target.getTime() === cursor.getTime()) return;
    moveFocus.current = true;
    setCursor(target);
  }

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <div className={styles.control} ref={anchor}>
      <TextInput className={`field-input ${styles.input}`} type="date" aria-label={t("cronForm.dateLabel")}
        value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => {
          if (event.key === "F4" || (event.altKey && event.key === "ArrowDown")) {
            event.preventDefault();
            changeOpen(true);
          }
        }} />
      <Popover.Trigger type="button" className={styles.toggle} aria-label={t("cronForm.datePickerLabel")}>
        <IconCalendar />
      </Popover.Trigger>
    </div>
    <Popover.Portal>
      <Popover.Positioner className={styles.positioner} anchor={anchor} align="start" sideOffset={8} collisionPadding={12}>
        <Popover.Popup className={styles.popup} aria-label={t("cronForm.datePickerLabel")} initialFocus={activeDay}>
          <div className={styles.header}>
            <span className={styles.title} aria-live="polite">{title}</span>
            <div className={styles.navigation}>
              <button type="button" className={styles.toggleMonth} aria-label={t("cron.calPrev")}
                disabled={shiftMonths(monthStart, -1) < FIRST_DAY} onClick={() => setCursor(shiftMonths(cursor, -1))}>
                <IconCalendarChevron direction="left" />
              </button>
              <button type="button" className={styles.toggleMonth} aria-label={t("cron.calNext")}
                disabled={shiftMonths(monthStart, 1) > LAST_DAY} onClick={() => setCursor(shiftMonths(cursor, 1))}>
                <IconCalendarChevron direction="right" />
              </button>
            </div>
          </div>
          <table className={styles.calendar} role="grid" aria-label={title} onKeyDown={navigateDays}>
            <thead><tr>{Array.from({ length: 7 }, (_, index) =>
              <th key={index} scope="col">{format.weekday.format(shiftDays(weekStart, index))}</th>
            )}</tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, week) =>
              <tr key={week}>{Array.from({ length: 7 }, (_, weekday) => {
                const date = shiftDays(weekStart, week * 7 + weekday);
                const timestamp = date.getTime();
                const active = timestamp === cursor.getTime();
                const checked = timestamp === selected?.getTime();
                return <td key={timestamp} aria-selected={checked}>
                  <button type="button" className={styles.day} ref={active ? activeDay : undefined} tabIndex={active ? 0 : -1}
                    aria-label={format.day.format(date)} aria-current={timestamp === today.getTime() ? "date" : undefined}
                    data-checked={checked || undefined} data-adjacent={date.getUTCMonth() !== cursor.getUTCMonth() || undefined}
                    disabled={date < FIRST_DAY || date > LAST_DAY} onClick={() => choose(dateKey(date))}>
                    {date.getUTCDate()}
                  </button>
                </td>;
              })}</tr>
            )}</tbody>
          </table>
          <div className={styles.footer}>
            <button type="button" className={styles.action} disabled={!value} onClick={() => choose("")}>{t("common.clear")}</button>
            <button type="button" className={styles.action} onClick={() => choose(dateKey(today))}>{t("cron.calToday")}</button>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
