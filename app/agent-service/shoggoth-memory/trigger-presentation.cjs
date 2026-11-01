"use strict";

const { hasCjk, cjkContentWords } = require("./cjk-query.cjs");

// Storage delimiters are not authored memory. Remove only literal complete
// delimiter lines; escaped lookalikes remain visible. The core supplies the
// first list bullet, while subsequent indentation and list hierarchy survive.
function triggerExcerpt(snippet) {
  if (typeof snippet !== "string") return snippet;
  return snippet.split("\n").filter(line => !/^\s*<!-- (?:shoggoth-memory-entry:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|\/shoggoth-memory-entry) -->\s*$/u.test(line))
    .join("\n").trim().replace(/^- /u, "");
}

// The pinned scorer treats a Chinese clause as one token. Once *all* content
// words of a CJK trigger match segmented words of this user's message, provide
// an ephemeral alias using those original clause tokens. The core still owns
// trust/project eligibility, scores, limits and the strong-hit decision. Do not
// change the message, stored triggers, search evidence or borrowed provenance.
function presentTriggerCandidates(entries, message) {
  const tokens = typeof message === "string" && message.length <= 4096
    ? (message.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(token => token.length > 1) : [];
  const words = new Map();
  for (const token of tokens) for (const word of cjkContentWords(token)) {
    if (!words.has(word)) words.set(word, token);
  }
  return entries.map(entry => {
    const aliases = [];
    for (const phrase of typeof entry.triggers === "string" ? entry.triggers.split(/[\n;|]+/u) : []) {
      if (!hasCjk(phrase) || phrase.length > 256) continue;
      const terms = [...new Set(cjkContentWords(phrase))];
      if (terms.length && terms.every(term => words.has(term))) aliases.push([...new Set(terms.map(term => words.get(term)))].join(" "));
    }
    return { ...entry, snippet: triggerExcerpt(entry.snippet),
      ...(aliases.length ? { triggers: [entry.triggers, ...new Set(aliases)].join(";") } : {}) };
  });
}

module.exports = { triggerExcerpt, presentTriggerCandidates };
