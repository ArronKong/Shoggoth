"use strict";

const MAX_WINDOWS = 32;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

function quotaLabel(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const label = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} _().&+%·–-]*$/u.test(label) ? label : null;
}

function quotaAccountName(value) {
  if (typeof value !== "string" || value.length > 254 || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.trim() || null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMESTAMP ? value : null;
}

function duration(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function percent(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 100) : null;
}

function quotaSnapshot(windows, { accountName, credits, resetCredits, checkedAt = Date.now() } = {}) {
  const projected = windows.slice(0, MAX_WINDOWS).flatMap(window => {
    const usedPercent = percent(window?.usedPercent);
    if (usedPercent === null) return [];
    return [{
      label: quotaLabel(window.label),
      durationMinutes: duration(window.durationMinutes),
      usedPercent,
      resetsAt: timestamp(window.resetsAt),
    }];
  });
  const name = quotaAccountName(accountName);
  const creditBalance = validCredits(credits) ? credits : null;
  const resetCount = positiveResetCount(resetCredits) ? resetCredits : null;
  return (projected.length > 0 || creditBalance || resetCount) && timestamp(checkedAt) !== null
    ? { status: "available", checkedAt, windows: projected, ...(name ? { accountName: name } : {}),
      ...(creditBalance ? { credits: creditBalance } : {}),
      ...(resetCount ? { resetCredits: resetCount } : {}) }
    : { status: "unavailable" };
}

function exactObject(value, keys) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable && Object.hasOwn(field, "value");
    });
}

function validCredits(credits) {
  if (exactObject(credits, ["kind"])) return ["present", "unlimited"].includes(credits.kind);
  if (exactObject(credits, ["kind", "wallets"]) && credits.kind === "wallets") {
    const wallets = credits.wallets;
    return Array.isArray(wallets) && wallets.length > 0 && wallets.length <= 4
      && Array.from(wallets).every(wallet => exactObject(wallet, ["kind", "amount", "unit"])
        && ["recharge", "bonus"].includes(wallet.kind) && ["USD", "CNY"].includes(wallet.unit)
        && positiveBalance(wallet.amount));
  }
  return exactObject(credits, ["kind", "amount", "unit"]) && credits.kind === "balance"
    && positiveBalance(credits.amount) && ["credits", "USD", "CNY"].includes(credits.unit);
}

function positiveBalance(amount) {
  return Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER;
}

function positiveResetCount(count) {
  return Number.isSafeInteger(count) && count > 0;
}

function validQuotaSnapshot(snapshot) {
  if (exactObject(snapshot, ["status"])) return ["unavailable", "unsupported"].includes(snapshot.status);
  if (!snapshot || typeof snapshot !== "object") return false;
  const hasAccountName = Object.hasOwn(snapshot, "accountName");
  const hasCredits = Object.hasOwn(snapshot, "credits");
  const hasResets = Object.hasOwn(snapshot, "resetCredits");
  const fields = ["status", "checkedAt", "windows",
    ...(hasAccountName ? ["accountName"] : []), ...(hasCredits ? ["credits"] : []), ...(hasResets ? ["resetCredits"] : [])];
  return exactObject(snapshot, fields) && snapshot.status === "available"
    && (!hasAccountName || (typeof snapshot.accountName === "string" && quotaAccountName(snapshot.accountName) === snapshot.accountName))
    && (!hasCredits || validCredits(snapshot.credits)) && (!hasResets || positiveResetCount(snapshot.resetCredits))
    && timestamp(snapshot.checkedAt) !== null && Array.isArray(snapshot.windows)
    && (snapshot.windows.length > 0 || hasCredits || hasResets) && snapshot.windows.length <= MAX_WINDOWS
    && Array.from(snapshot.windows).every(window => exactObject(window, ["label", "durationMinutes", "usedPercent", "resetsAt"])
      && quotaLabel(window.label) === window.label && duration(window.durationMinutes) === window.durationMinutes
      && percent(window.usedPercent) === window.usedPercent && timestamp(window.resetsAt) === window.resetsAt);
}

module.exports = { MAX_WINDOWS, quotaSnapshot, validQuotaSnapshot };
