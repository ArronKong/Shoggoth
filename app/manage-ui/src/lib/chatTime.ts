/** Message footers use the system locale and local time, including month/day. */
export function formatChatTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
