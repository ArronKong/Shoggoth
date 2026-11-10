"use strict";

// Shared content policy; no stores, Runtime, filesystem or legacy engine.
const crypto = require("node:crypto");

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b\d{6}\b.*(?:验证码|verification code|otp)|(?:验证码|verification code|otp).*\b\d{6}\b/iu,
]);
const ASSIGNED_SECRET = /\b(?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*([^\r\n]{8,})/giu;
const ENV_NAME = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+')`;
const ENV_LOOKUP = String.raw`(?:os\.environ\[${ENV_NAME}\]|os\.environ\.get\(${ENV_NAME}\)|os\.getenv\(${ENV_NAME}\)|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[${ENV_NAME}\])|Deno\.env\.get\(${ENV_NAME}\)|System\.getenv\(${ENV_NAME}\)|getenv\(${ENV_NAME}\))`;
const ENV_REFERENCE = new RegExp(
  String.raw`^${ENV_LOOKUP}(?:\s*(?:\bor\b|\|\||\?\?)\s*${ENV_LOOKUP})*(?:;)?$`,
  "u",
);
const ARG_REFERENCE = /^(?:argv|process\.argv)\[[A-Za-z_][A-Za-z0-9_]*\];?$/u;
// The one audited frozen GWAS helper derives this token from a response row.
// Pin the entire file so a different script cannot use the same expression to
// conceal an embedded credential through an alias or fallback.
const GWAS_EFFECT_TOKEN = /^token\s*=\s*str\(effect\[0\]\)$/iu;
const FROZEN_GWAS_HELPER_SHA256 = "9844fcad187346a045712ef2975691f20028308349c9f772b5c13065248cb543";
function isAuditedGwasEffectToken(value, match) {
  return GWAS_EFFECT_TOKEN.test(match[0].trim())
    && crypto.createHash("sha256").update(value).digest("hex") === FROZEN_GWAS_HELPER_SHA256;
}
// A plugin's `${secret:NAME}` reference names a credential and is never a value;
// documentation placeholders such as `Bearer <token>` cannot carry one either.
// The assignment pattern consumes the rest of the line, so whatever follows a
// placeholder is checked again rather than exempted with it.
const SECRET_REFERENCE_TAIL = /^secret:[A-Z][A-Z0-9_]{0,63}\}/u;
const PLACEHOLDER_VALUE = /^["'`]?(?:Bearer\s+)?(?:\$\{secret:[A-Z][A-Z0-9_]{0,63}\}|<[A-Za-z][A-Za-z _-]{0,40}>|\*{3,}|x{3,}(?:\.{2,}y{3,})?|X{3,})["'`]?(?=$|[\s,;)，。、；：）])/u;
function placeholderRest(value, match) {
  if (value.slice(Math.max(0, match.index - 2), match.index) === "${") {
    const tail = SECRET_REFERENCE_TAIL.exec(value.slice(match.index));
    if (tail) return match[0].slice(tail[0].length);
  }
  const assigned = match[1].trimStart();
  const placeholder = PLACEHOLDER_VALUE.exec(assigned);
  return placeholder ? assigned.slice(placeholder[0].length) : null;
}
function isRegexKeyAlternative(value, match) {
  // `/...token=|.../` matches a query-string key, not an assigned value.
  // Only skip an empty regex alternative; a literal after `token=` remains
  // subject to the ordinary secret-assignment check.
  const lineStart = value.lastIndexOf("\n", match.index) + 1;
  return /\/\(\?:[^/]*$/u.test(value.slice(lineStart, match.index))
    && match[1].trimStart().startsWith("|");
}
const PII_PATTERNS = Object.freeze([
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/u,
]);
const REVIEWED_MEMORY_ID = /^reviewed-(mc-[a-f0-9]{64})$/u;

function normalizeContent(value) { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(); }
function contentHash(value) { return crypto.createHash("sha256").update(normalizeContent(value)).digest("hex"); }
function lexicalTerms(value) {
  const normalized = normalizeContent(value);
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = cjk.length <= 1 ? cjk : cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`);
  return new Set([...words, ...bigrams]);
}
function hasSecret(value) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // A helper that reads an environment variable or a CLI argument does not
  // embed its runtime value. Keep rejecting literal/fallback assignments while
  // allowing verified Skill scripts to name external credential inputs.
  return [...value.matchAll(ASSIGNED_SECRET)].some((match) => {
    const assigned = match[1].trim();
    if (isRegexKeyAlternative(value, match) || ENV_REFERENCE.test(assigned) || ARG_REFERENCE.test(assigned)
      || isAuditedGwasEffectToken(value, match)) return false;
    const rest = placeholderRest(value, match);
    return rest === null || hasSecret(rest);
  });
}
function hasPii(value) { return PII_PATTERNS.some((pattern) => pattern.test(value)); }
// Trust tier of a stored fact, derived only from source refs the Service sets.
// owner: written or confirmed by the user; system: imported, or consolidated
// by Shoggoth in the background from the user's own words; agent: saved by an
// Agent in a direct conversation; untrusted: kept for the user to confirm, and
// never recalled by Agents, injected or shared.
const UNTRUSTED_REF_PREFIX = "untrusted:";
const CONSOLIDATED_REF = "consolidated:auto";
function memoryTrust(item) {
  const refs = item.sourceRefs;
  if (refs.some((ref) => ref.startsWith(UNTRUSTED_REF_PREFIX))) return "untrusted";
  if (refs.includes(CONSOLIDATED_REF)) return "system";
  if (REVIEWED_MEMORY_ID.test(item.id) || refs.some((ref) => ref.startsWith("user-edit:"))) return "owner";
  if (refs.some((ref) => ref.startsWith("codex-memory:"))) return "system";
  return "agent";
}
// An Agent's saved fact must reuse at least one word of the user's quoted
// message; otherwise the quote does not support it. English words also match
// by a shared stem of four or more letters ("prefer" ~ "prefers").
function quoteSupportsContent(quote, content) {
  const quoted = [...lexicalTerms(quote)];
  return [...lexicalTerms(content)].some((term) => quoted.some((word) => word === term
    || (/^[a-z]{4,}$/u.test(word) && /^[a-z]{4,}$/u.test(term) && (word.startsWith(term) || term.startsWith(word)))));
}

module.exports = { contentHash, hasPii, hasSecret, lexicalTerms, memoryTrust, normalizeContent, quoteSupportsContent,
  CONSOLIDATED_REF, UNTRUSTED_REF_PREFIX, REVIEWED_MEMORY_ID };
