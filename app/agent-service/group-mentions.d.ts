export const BROADCAST_HANDLES: readonly string[];
export function isBroadcastHandle(handle: string): boolean;
export function findMentionSpans(text: string, members: readonly { memberId: string; handle: string }[]):
  { start: number; end: number; memberId: string | null }[];
