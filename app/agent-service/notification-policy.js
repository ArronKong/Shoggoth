"use strict";
const { inActiveHours, validTimezone } = require("./proactive-service-protocol");
const CATEGORIES = new Set(["chat", "cron", "task", "proactive"]);
function notificationPolicy({ config, category, focused = false, now = Date.now() }) {
  if (!CATEGORIES.has(category)) return { allowed: false, reason: "invalid_category" };
  if (config?.notifications?.[category] !== true) return { allowed: false, reason: "notifications_disabled" };
  if (focused && config.notificationPolicy?.suppressWhileFocused !== false) return { allowed: false, reason: "foreground" };
  const quiet = config.notificationPolicy?.quietHours;
  if (quiet && validTimezone(quiet.timezone) && inActiveHours(now, quiet.timezone, quiet)) {
    return { allowed: false, reason: "quiet_hours" };
  }
  return { allowed: true, reason: null };
}
module.exports = { notificationPolicy, CATEGORIES };
