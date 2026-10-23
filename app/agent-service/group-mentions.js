"use strict";

// 群聊 @ 解析（确定性，无模型调用）。只识别顶层正文中的 @：代码块、行内代码、
// 引用块、URL、邮箱和转义的 \@ 只保留文字，不触发调度（群聊开发计划 §9.2）。
// 中文没有词边界，所以先按当前群的已知标识做最长前缀匹配，匹配不上才读一个
// 通用词元记为未解析目标。

const BROADCAST_HANDLES = Object.freeze(["all", "everyone", "所有人", "全体成员"]);
const MAX_UNRESOLVED_HANDLE_CHARS = 32;
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}_-]/u;
const ASCII_WORD_CHAR = /[A-Za-z0-9_-]/u;
// 邮箱、路径或单词中间的 @ 不是提及。
const NON_MENTION_PREFIX = /[A-Za-z0-9_.+%/\\-]/u;

function normalizeHandle(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

// handle 由显示名派生：保留字母、数字、下划线和连字符，空白折叠为连字符。
function deriveHandle(displayName) {
  const base = normalizeHandle(displayName).trim().replace(/\s+/gu, "-")
    .split("").filter((char) => TOKEN_CHAR.test(char)).join("")
    .replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "")
    .slice(0, 24);
  return base || "agent";
}

function uniqueHandle(displayName, takenHandles) {
  const taken = new Set([...takenHandles, ...BROADCAST_HANDLES].map(normalizeHandle));
  const base = deriveHandle(displayName);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function fenceOf(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match ? match[1] : null;
}

// 返回可参与解析的文本片段（逐行，已剔除代码块、引用块和缩进代码）。
function mentionableLines(text) {
  const lines = String(text).split(/\r?\n/u);
  const result = [];
  let fence = null;
  let previousBlank = true;
  let inQuote = false;
  for (const line of lines) {
    if (fence) {
      const close = fenceOf(line);
      if (close && close[0] === fence[0] && close.length >= fence.length
        && line.trim() === close) fence = null;
      continue;
    }
    const open = fenceOf(line);
    if (open) { fence = open; inQuote = false; continue; }
    const blank = line.trim() === "";
    // 引用块及其惰性续行（直到空行）都属于引用。
    if (/^ {0,3}>/u.test(line) || (inQuote && !blank)) { inQuote = true; previousBlank = false; continue; }
    inQuote = false;
    if (previousBlank && /^(?: {4}|\t)/u.test(line) && !blank) continue;
    previousBlank = blank;
    result.push(line);
  }
  return result;
}

// 剔除行内代码、URL、Markdown 链接目标后，按位置报告每个 @ 之后的文本。
function mentionSites(line) {
  const sites = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\" && index + 1 < line.length) { index += 2; continue; }
    if (char === "`") {
      let ticks = 1;
      while (line[index + ticks] === "`") ticks += 1;
      const marker = "`".repeat(ticks);
      const close = line.indexOf(marker, index + ticks);
      index = close < 0 ? index + ticks : close + ticks;
      continue;
    }
    if (char === "]" && line[index + 1] === "(") {
      const close = line.indexOf(")", index + 2);
      index = close < 0 ? line.length : close + 1;
      continue;
    }
    // Check the boundary first: scanning the remaining suffix at every letter makes a long word quadratic.
    if (index === 0 || !ASCII_WORD_CHAR.test(line[index - 1])) {
      const url = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/iu.exec(line.slice(index));
      if (url) {
        index += url[0].length;
        continue;
      }
    }
    if (char === "@" && (index === 0 || !NON_MENTION_PREFIX.test(line[index - 1]))) {
      sites.push(line.slice(index + 1));
    }
    index += 1;
  }
  return sites;
}

function readToken(text) {
  let token = "";
  for (const char of text) {
    if (!TOKEN_CHAR.test(char) || token.length >= MAX_UNRESOLVED_HANDLE_CHARS) break;
    token += char;
  }
  return token.replace(/-+$/u, "");
}

/**
 * @param {string} text 正文
 * @param {Array<{memberId: string, handle: string}>} members 当前群可解析的成员
 * @returns {{ memberIds: string[], broadcast: boolean, unresolved: string[] }}
 */
function parseMentions(text, members, options = {}) {
  const handoffs = [];
  const candidates = [
    ...members.map((member) => ({ memberId: member.memberId, handle: normalizeHandle(member.handle) })),
    ...BROADCAST_HANDLES.map((handle) => ({ memberId: null, handle: normalizeHandle(handle) })),
  ].sort((left, right) => right.handle.length - left.handle.length);
  const memberIds = [];
  const unresolved = [];
  let broadcast = false;
  for (const line of mentionableLines(text)) {
    for (const site of mentionSites(line)) {
      const normalized = normalizeHandle(site);
      const match = candidates.find((candidate) => normalized.startsWith(candidate.handle)
        && !(ASCII_WORD_CHAR.test(candidate.handle.at(-1))
          && ASCII_WORD_CHAR.test(normalized[candidate.handle.length] ?? "")));
      if (match?.memberId === null) {
        broadcast = true;
      } else if (match) {
        if (!memberIds.includes(match.memberId)) {
          memberIds.push(match.memberId);
          handoffs.push({ memberId: match.memberId, excerpt: `@${[...site].slice(0, 180).join("")}` });
        }
      } else {
        const token = readToken(site);
        if (token && !unresolved.includes(token)) unresolved.push(token);
      }
    }
  }
  return { memberIds, broadcast, unresolved, ...(options.handoffs ? { handoffs } : {}) };
}

// 成功回合的静默协议：整条回复是 (pass) / pass / pass. 或空白（容忍大小写和首尾空白）。
function isPassReply(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed === "" || /^(?:\(pass\)|pass\.?)$/iu.test(trimmed);
}

module.exports = {
  BROADCAST_HANDLES,
  deriveHandle,
  isPassReply,
  normalizeHandle,
  parseMentions,
  uniqueHandle,
};
