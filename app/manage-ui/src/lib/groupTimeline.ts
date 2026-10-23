export interface GroupTimelineEntry {
  key: string;
  createdAt: number;
  seq?: number;
}

/** Published messages keep authoritative seq order; unfinished cards follow them. */
export function orderGroupTimeline<T extends GroupTimelineEntry>(rows: T[]): T[] {
  const saved = rows.filter(row => row.seq !== undefined).sort((a, b) => a.seq! - b.seq!);
  const pending = rows.filter(row => row.seq === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  return [...saved, ...pending];
}
