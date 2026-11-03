"use strict";
const { notificationPolicy } = require("./notification-policy");

// Electron only keeps a weak wrapper. Retain each notification until its user
// interaction completes, including the time it remains in Notification Center.
const activeNotifications = new Set();
function showNativeNotification(Notification, options, onClick) {
  const note = new Notification(options);
  if (typeof note?.show !== "function") throw Object.assign(new Error("native_notification_invalid"), { code: "NOTIFICATION_INVALID", submitted: false });
  activeNotifications.add(note);
  const release = () => activeNotifications.delete(note);
  note.on?.("close", release);
  note.on?.("failed", release);
  note.on?.("click", () => {
    if (!release()) return;
    try { void Promise.resolve(onClick?.()).catch(() => {}); } catch { /* best-effort navigation */ }
  });
  try { note.show(); } catch (error) { release(); throw error; }
}

function createNativeNotificationSender({ Notification, readConfig, isFocused = async () => false, openTarget = async () => {}, now = Date.now }) {
  const shown = new Map();
  return async input => {
    const current = now();
    for (const [key, time] of shown) if (time + 7 * 86_400_000 < current) shown.delete(key);
    if (input.noticeId && shown.has(input.noticeId)) return { state: "submitted" };
    const policy = notificationPolicy({ config: readConfig(), category: input.category || "task", focused: await isFocused(), now: current });
    if (!policy.allowed) return { state: "suppressed", reason: policy.reason };
    if (typeof Notification?.isSupported !== "function" || !Notification.isSupported()) {
      throw Object.assign(new Error("native_notification_unsupported"), { code: "NOTIFICATION_UNSUPPORTED", submitted: false });
    }
    showNativeNotification(Notification, { title: input.title, body: input.body }, () => openTarget(input));
    if (input.noticeId) shown.set(input.noticeId, current);
    return { state: "submitted" };
  };
}
module.exports = { createNativeNotificationSender, showNativeNotification };
