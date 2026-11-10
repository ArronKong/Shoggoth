"use strict";

const { SECRET_KINDS, secretReferences } = require("../core/chat-secret-contract");
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_MATCHES = 2048;
const MAX_SECRET_BYTES = 64 * 1024;
const FIELD = /^(?:.*[_\-.])?(?:password|passwd|pwd|passphrase|api_?key|access_?token|refresh_?token|id_?token|auth_?token|token|client_?secret|secret|private_?key|密码|密碼|口令|密钥|密鑰|令牌)$/iu;
const LABEL = /(?:["']?)([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|token|secret)|密码|密碼|口令|密钥|密鑰|令牌)(?:["']?)([ \t]*(?::|：|=|\bis\b|\b为\b|[是为為])[ \t]*(?:\r?\n[ \t]*)?|[ \t]+)/giu;
// A link's opaque token may be a page signature, cursor or tracking value.
// Its name alone does not make it a reusable account credential. Parse query
// and fragment parameters separately, preserving their exact source bytes.
const LINK_QUERY = /[?#][^\s<>"'`()[\]，；。！？]+/gu;
const LINK_AUTH_TOKEN = /^(?:(?:access|refresh|id|auth|bearer|oauth|session|private|api|personal_access)_?token|authorization|proxy_authorization|cookie|set_cookie)$/u;
const FORMATS = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]{1,65536}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu],
  ["api_key", /\b(?:sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,})\b/gu],
  ["token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
];

function fail(code = "SECRET_INPUT_INVALID") { const error = new Error(code); error.code = code; throw error; }
function textValue(value, max = MAX_INPUT_BYTES) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= max;
}
function fieldKind(name) {
  const normalized = name.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/ /gu, "_").toLowerCase();
  if (["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(normalized)) return "token";
  if (!FIELD.test(normalized)) return null;
  if (/password|passwd|passphrase|pwd|密码|密碼|口令/u.test(normalized)) return "password";
  if (/private_?key/u.test(normalized)) return "private_key";
  if (/api_?key|密钥|密鑰/u.test(normalized)) return "api_key";
  if (/token|令牌/u.test(normalized)) return "token";
  return "secret";
}
function linkFieldKind(name) {
  try { name = decodeURIComponent(name); } catch { return null; }
  const normalized = name.replace(/([a-z])([A-Z])/gu, "$1_$2").replace(/[- ]/gu, "_").toLowerCase();
  const kind = fieldKind(name) || fieldKind(normalized);
  return kind === "token" && !LINK_AUTH_TOKEN.test(normalized) ? null : kind;
}
function isPlaceholder(value) {
  return /^\$\{[^\n]*\}$|^\{\{[^\n]*\}\}$|^<[^\n]*>$|^[*•●]+$/u.test(value)
    || /^(?:process\.env\.|os\.environ|os\.getenv|env\.)/u.test(value);
}
function variants(value) {
  const values = new Set([value]);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) values.add(encoded);
  // JSON escaping is handled by the parser below. Known encoded echoes are
  // finite and explicit, not a claim to recognize arbitrary obfuscation.
  values.add(Buffer.from(value).toString("base64"));
  return [...values].filter(Boolean);
}
function knownMatchBoundary(text, start, value, original = value) {
  if (original === "/" && value === "/") {
    // Old conversations may already contain a slash registered as a secret.
    // Mask a standalone echo without rewriting the slashes in URLs and paths.
    const delimiter = /[\s"'“”‘’「」,;，；]/u;
    return delimiter.test(text[start - 1] ?? " ") && delimiter.test(text[start + value.length] ?? " ");
  }
  // Short word-like credentials still match as complete tokens, including
  // their encoded echoes. A coincidental substring in "stories" or a filename
  // is not an echo of the two-letter password "to".
  if (original.length >= 8 || !/^[A-Za-z0-9_]+$/u.test(original)) return true;
  return !/[A-Za-z0-9_]/u.test(text[start - 1] || "")
    && !/[A-Za-z0-9_]/u.test(text[start + value.length] || "");
}

// Parse only after JSON.parse succeeds; this cursor records source ranges so
// replacing a value does not normalize its neighbours, keys or whitespace.
function jsonLeaves(source) {
  // A business string such as "123456" or "true" is also a valid JSON
  // primitive. Treat it as text so an already-known short credential cannot
  // disappear into a successful parse with no string leaves.
  try { const parsed = JSON.parse(source); if (parsed === null || !["object", "string"].includes(typeof parsed)) return null; }
  catch { return null; }
  let at = 0, count = 0;
  const leaves = [];
  const ws = () => { while (/\s/u.test(source[at] || "") && at < source.length) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === "\\") at++;
      else if (c === '"') break;
    }
    return { start, end: at, value: JSON.parse(source.slice(start, at)) };
  };
  const walk = (name, depth) => {
    if (depth > 48 || ++count > 32768) fail();
    ws();
    if (source[at] === "{") {
      at++; ws();
      while (source[at] !== "}") {
        const key = string(); ws(); at++; walk(key.value, depth + 1); ws();
        if (source[at] !== ",") break;
        at++; ws();
      }
      at++; return;
    }
    if (source[at] === "[") {
      at++; ws();
      while (source[at] !== "]") {
        walk(null, depth + 1); ws(); if (source[at] !== ",") break; at++;
      }
      at++; return;
    }
    if (source[at] === '"') { leaves.push({ ...string(), name, quoted: true }); return; }
    const start = at;
    while (at < source.length && !/[\s,\]}]/u.test(source[at])) at++;
    const value = source.slice(start, at);
    if (name && fieldKind(name) && /^-?\d/u.test(value)) leaves.push({ start, end: at, name, value, quoted: false });
  };
  walk(null, 0);
  return leaves;
}

function detectSecrets(text, options = {}) {
  if (!textValue(text)) fail();
  const known = (options.known || []).filter(entry => textValue(entry.value, MAX_SECRET_BYTES) && entry.value.length
    && SECRET_KINDS.includes(entry.kind || "secret"));
  const autoDetect = options.autoDetect !== false;
  const selections = options.selections || [];
  if (!Array.isArray(selections) || selections.length > 64) fail();
  const matches = [], ambiguous = [];
  if (!autoDetect && !known.length && !selections.length) return { matches, ambiguous };
  const occupied = secretReferences(text);
  const add = (start, end, value, kind, source, extra = {}) => {
    if (start < 0 || end <= start || !textValue(value, MAX_SECRET_BYTES) || !value.length
      || !["selection", "known"].includes(source) && isPlaceholder(value)) return;
    if (occupied.some(ref => start < ref.end && end > ref.start)) return;
    matches.push({ start, end, value, kind, source, ...extra });
    if (matches.length > MAX_MATCHES) fail();
  };
  const leaves = options.structured === false ? null : jsonLeaves(text);
  for (const item of selections) {
    if (!item || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0
      || item.end > text.length || item.start >= item.end || !SECRET_KINDS.includes(item.kind || "secret")) fail();
    const leaf = leaves?.find(value => value.start === item.start && value.end === item.end
      || value.quoted && value.start + 1 === item.start && value.end - 1 === item.end);
    const value = leaf ? leaf.value : text.slice(item.start, item.end);
    if (!textValue(value, MAX_SECRET_BYTES)) fail();
    add(leaf?.start ?? item.start, leaf?.end ?? item.end, value, item.kind || "secret", "selection", leaf ? { json: true } : {});
  }
  if (leaves) {
    for (const leaf of leaves) {
      const kind = leaf.name && fieldKind(leaf.name);
      if (autoDetect && kind && !isPlaceholder(leaf.value)) add(leaf.start, leaf.end, leaf.value, kind, "field", { json: true });
      else {
        const nested = detectSecrets(leaf.value, { known, structured: false, autoDetect });
        if (nested.matches.length || nested.ambiguous.length) {
          // A JSON value may have multiple references; its original logical
          // string is reconstructed by replaceSecrets and escaped exactly once.
          matches.push({ start: leaf.start, end: leaf.end, value: leaf.value, kind: "secret", source: "json",
            json: true, nested: nested.matches });
          ambiguous.push(...nested.ambiguous.map(() => ({ start: leaf.start, end: leaf.end, reason: "value-boundary" })));
        }
      }
    }
  } else {
    for (const entry of known) for (const value of variants(entry.value)) {
      for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + value.length)) {
        if (!knownMatchBoundary(text, start, value, entry.value)) continue;
        add(start, start + value.length, entry.value, entry.kind || "secret", "known", { reference: entry.reference,
          transform: value === entry.value ? "plain" : value === encodeURIComponent(entry.value) ? "url" : "base64" });
      }
    }
  }
  if (!leaves && autoDetect) {
    for (const [kind, re] of FORMATS) for (const match of text.matchAll(new RegExp(re))) {
      add(match.index, match.index + match[0].length, match[0], kind, "format");
    }
    const queries = [...text.matchAll(new RegExp(LINK_QUERY))];
    for (const query of queries) for (const param of query[0].matchAll(/[?&#](?:amp;)?([^?&#=]+)=/gu)) {
      const kind = linkFieldKind(param[1]);
      if (!kind) continue;
      const offset = param.index + param[0].length;
      const tail = query[0].slice(offset), boundary = tail.search(/[&#]/u);
      const value = boundary < 0 ? tail : tail.slice(0, boundary), start = query.index + offset;
      add(start, start + value.length, value, kind, "query");
    }
    let queryIndex = 0;
    for (const match of text.matchAll(new RegExp(LABEL))) {
      while (queries[queryIndex] && queries[queryIndex].index + queries[queryIndex][0].length <= match.index) queryIndex++;
      const query = queries[queryIndex];
      // A quoted or space-separated credential extends past the URL span.
      // Let the ordinary label parser protect that explicit value as before.
      if (query && match.index >= query.index && (match.index + match[0].length < query.index + query[0].length
        || !linkFieldKind(match[1]))) continue;
      if (match.index > 0 && /[A-Za-z0-9_]/u.test(text[match.index - 1])) continue;
      const kind = fieldKind(match[1]);
      const implicitLabel = /^\s+$/u.test(match[2]);
      if (!kind || kind !== "password" && implicitLabel) continue;
      let start = match.index + match[0].length, end = start, value;
      const quote = text[start], close = { '"': '"', "'": "'", "“": "”", "「": "」" }[quote];
      const cliFlag = /^--?[A-Za-z]/u.test(match[1]);
      // In English prose, "email and password to enjoy ..." does not declare
      // the password "to". Require a separator (colon, equals, "is", etc.), a
      // quoted value or a CLI flag; Chinese labels keep their natural forms.
      if (implicitLabel && /^[A-Za-z0-9_.-]+$/u.test(match[1]) && !cliFlag && !close) continue;
      if (close) {
        start++; end = start;
        while (end < text.length && text[end] !== close && text[end] !== "\n") {
          if (text[end] === "\\" && end + 1 < text.length) end++;
          end++;
        }
        if (text[end] !== close) { ambiguous.push({ start, end, reason: "unclosed-quote" }); continue; }
        value = text.slice(start, end);
        if (quote === '"') { try { value = JSON.parse(`"${value}"`); } catch { ambiguous.push({ start, end, reason: "invalid-escape" }); continue; } }
      } else {
        while (end < text.length && !/[\s,;，；。！？!?<>"'`]/u.test(text[end])) end++;
        value = text.slice(start, end);
        // Headlines such as "低碳密码 / 11-10" use a column separator.
        if (implicitLabel && !cliFlag && value === "/") continue;
        if (/^(?:是|为|為)$/u.test(value)) continue;
        if (value.endsWith(".")) { ambiguous.push({ start, end, reason: "value-boundary" }); continue; }
      }
      if (/^(?:预算|budget|count|length|expired|expires|value|here|example|your[_-]|<)/iu.test(value || "")) continue;
      add(start, end, value, kind, "label");
    }
    for (const match of text.matchAll(/\b(?:Authorization|Proxy-Authorization)[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+([^\s,;]+)/giu)) {
      const start = match.index + match[0].length - match[1].length;
      add(start, start + match[1].length, match[1], "token", "header");
    }
    for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:([^\s/?#@]+)@/giu)) {
      const start = match.index + match[0].length - match[1].length - 1;
      add(start, start + match[1].length, match[1], "password", "url");
    }
  }
  const rank = { selection: 0, field: 1, json: 1, label: 1, query: 1, known: 2, format: 3, header: 3, url: 3 };
  const accepted = [];
  for (const match of matches.sort((a, b) => rank[a.source] - rank[b.source] || b.end - b.start - (a.end - a.start))) {
    if (!accepted.some(other => match.start < other.end && match.end > other.start)) accepted.push(match);
  }
  accepted.sort((a, b) => a.start - b.start);
  return { matches: accepted, ambiguous: ambiguous.filter(item => !accepted.some(match => match.source === "selection"
    && match.start <= item.start && match.end >= item.end)) };
}

async function replaceSecrets(text, detection, replace) {
  let cursor = 0, result = "";
  for (const match of detection.matches) {
    const replacement = match.nested ? await replaceSecrets(match.value, { matches: match.nested }, replace) : await replace(match);
    result += text.slice(cursor, match.start) + (match.json ? JSON.stringify(replacement) : replacement);
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

module.exports = { detectSecrets, replaceSecrets, fieldKind, variants, knownMatchBoundary, textValue, MAX_INPUT_BYTES, MAX_SECRET_BYTES };
