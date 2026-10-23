"use strict";
const { notificationPolicy } = require("./notification-policy");
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
    const note = new Notification({ title: input.title, body: input.body });
    if (typeof note?.show !== "function") throw Object.assign(new Error("native_notification_invalid"), { code: "NOTIFICATION_INVALID", submitted: false });
    note.on?.("click", () => { void openTarget(input).catch(() => {}); });
    note.show();
    if (input.noticeId) shown.set(input.noticeId, current);
    return { state: "submitted" };
  };
}
module.exports = { createNativeNotificationSender };
