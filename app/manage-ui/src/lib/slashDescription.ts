import type { TFunction } from "i18next";
import { normalizeSlashDescription, slashDescriptionKeys, slashDescriptionPrefixes } from "../i18n/slashDescriptions";

/** Display-only localization. The catalog, command syntax and dispatch stay raw. */
export function translateSlashDescription(raw: string, t: TFunction): string {
  const lookup = (value: string): string => {
    const normalized = normalizeSlashDescription(value);
    const exactKey = slashDescriptionKeys.get(normalized);
    const key = exactKey
      || slashDescriptionPrefixes.find(([prefix]) => normalized.startsWith(prefix))?.[1];
    if (!key) return value;
    const translated = t(key, { ns: "slashCommands", keySeparator: false, nsSeparator: false, defaultValue: value });
    if (translated !== key) return translated;
    // Preserve original English (including a long skill's full text). Known
    // Chinese metadata can still be shown in English via the reverse lookup.
    return exactKey && normalized !== normalizeSlashDescription(key) ? translated : value;
  };
  // Hermes appends grammar to prose. Translate the label, never the grammar.
  const suffix = /^(.*) \((usage:|alias for) (.+)\)$/u.exec(raw);
  if (suffix) {
    const key = suffix[2] === "usage:" ? "usage: {{syntax}}" : "alias for {{syntax}}";
    return `${lookup(suffix[1])} (${t(key, {
      ns: "slashCommands", keySeparator: false, nsSeparator: false, syntax: suffix[3],
    })})`;
  }
  const quick = /^(exec:|alias →) (.+)$/u.exec(raw);
  if (quick) return t(`${quick[1]} {{syntax}}`, {
    ns: "slashCommands", keySeparator: false, nsSeparator: false, syntax: quick[2],
  });
  // Unrecognized third-party prose remains verbatim. Never substitute an
  // unrelated built-in's description just because a custom command shares a name.
  return lookup(raw);
}
