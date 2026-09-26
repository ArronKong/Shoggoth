"use strict";

const DEFAULT_INSPIRATION_SHORTCUT = "Alt+S";
const MODIFIERS = ["Control", "Alt", "Shift", "Command"];
const ALIASES = { ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", cmd: "Command", command: "Command", meta: "Command" };

function normalizeInspirationShortcut(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const parts = value.trim().split("+").map(part => part.trim());
  const rawKey = parts.pop() || "";
  const key = /^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase()
    : /^f([1-9]|1[0-9]|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase()
      : /^space$/i.test(rawKey) ? "Space" : null;
  const modifiers = parts.map(part => ALIASES[part.toLowerCase()]);
  if (!key || !modifiers.length || modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length
    || !modifiers.some(part => part !== "Shift")) return null;
  return [...MODIFIERS.filter(part => modifiers.includes(part)), key].join("+");
}

module.exports = { DEFAULT_INSPIRATION_SHORTCUT, normalizeInspirationShortcut };
