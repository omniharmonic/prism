import { calendarDate } from "../../lib/sync/client";

type EventTime = { start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
export const calendarDayKey = (day: Date) => `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate());
const followingDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

/** Bound expansion to the visible range; all-day and midnight ends are exclusive. */
export function groupCalendarDays<T extends EventTime>(events: T[], from: Date, to: Date): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const event of events) {
    const raw = event.start?.dateTime || event.start?.date;
    if (!raw) continue;
    const start = calendarDate(raw);
    if (!Number.isFinite(start.getTime())) continue;
    const rawEnd = event.end?.dateTime || event.end?.date;
    const end = rawEnd ? calendarDate(rawEnd) : start;
    const validEnd = Number.isFinite(end.getTime()) && end > start ? end : new Date(start.getTime() + 1);
    let day = midnight(new Date(Math.max(start.getTime(), from.getTime())));
    while (day <= to && day < validEnd) {
      const key = calendarDayKey(day);
      result.set(key, [...(result.get(key) ?? []), event]);
      day = followingDay(day);
    }
  }
  return result;
}

export type PositionedEvent<T> = { event: T; start: number; end: number; column: number; columns: number };
/** Clip overnight events to this local day and give overlapping blocks separate columns.
 * Minutes describe the wall-clock grid, so DST dates still align to their labels.
 */
export function layoutCalendarDay<T extends EventTime>(events: T[], day: Date): PositionedEvent<T>[] {
  const begin = midnight(day), finish = followingDay(day);
  const minutes = (date: Date) => date <= begin ? 0 : date >= finish ? 1440 : date.getHours() * 60 + date.getMinutes();
  const positioned: PositionedEvent<T>[] = events.flatMap(event => {
    if (!event.start?.dateTime) return [];
    const start = calendarDate(event.start.dateTime);
    const rawEnd = event.end?.dateTime ? calendarDate(event.end.dateTime) : start;
    const end = rawEnd > start ? rawEnd : new Date(start.getTime() + 30 * 60_000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= finish || end <= begin) return [];
    const startMinute = minutes(start);
    // Minimum 30-minute visual height keeps the label operable and participates in collisions.
    return [{ event, start: startMinute, end: Math.min(1440, Math.max(startMinute + 30, minutes(end))), column: 0, columns: 1 }];
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  let group: PositionedEvent<T>[] = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const finishGroup = () => { for (const item of group) item.columns = ends.length; };
  for (const item of positioned) {
    if (item.start >= groupEnd) { finishGroup(); group = []; ends = []; }
    let column = ends.findIndex(end => end <= item.start);
    if (column < 0) column = ends.length;
    ends[column] = item.end;
    item.column = column;
    group.push(item);
    groupEnd = Math.max(...ends);
  }
  finishGroup();
  return positioned;
}
