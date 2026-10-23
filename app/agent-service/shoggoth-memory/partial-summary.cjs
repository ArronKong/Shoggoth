"use strict";

// Decode only the JSON transport's sole summary string. Tool arguments and
// other assistant text are never a recall summary. An incomplete escape is
// withheld until its remaining bytes arrive; invalid suffixes revoke a prefix.
function partialSummary(text) {
  const prefix = /^\s*\{\s*"summary"\s*:\s*"/u.exec(text);
  if (!prefix) return null;
  let raw = "", index = prefix[0].length;
  const decoded = () => {
    try {
      const result = JSON.parse(`"${raw}"`);
      return result.isWellFormed() ? result : result.slice(0, -1).isWellFormed() ? result.slice(0, -1) : null;
    } catch { return null; }
  };
  while (index < text.length) {
    const char = text[index++];
    if (char === '"') return /^\s*\}?\s*$/u.test(text.slice(index)) ? decoded() : null;
    if (char.charCodeAt(0) < 0x20) return null;
    if (char !== "\\") { raw += char; continue; }
    if (index === text.length) return decoded();
    const escape = text[index++];
    if ('"\\/bfnrt'.includes(escape)) { raw += `\\${escape}`; continue; }
    if (escape !== "u") return null;
    const digits = text.slice(index, index + 4);
    if (!/^[0-9a-f]*$/iu.test(digits)) return null;
    if (digits.length < 4) return decoded();
    raw += `\\u${digits}`; index += 4;
  }
  return decoded();
}

module.exports = { partialSummary };
