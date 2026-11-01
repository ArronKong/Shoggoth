"use strict";

// Chinese and mixed Chinese/English keyword support for memory search.
// Unsegmented CJK text forms one long token for the upstream tokenizer, so a
// short word inside a sentence never matches, and the upstream fallback score
// cannot see it either. This module only plans query terms and scores a
// candidate's coverage; retrieval, filtering and ranking stay upstream.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const { Converter } = require("opencc-js");
const toSimplified = Converter({ from: "t", to: "cn" });
const toTraditional = ["t", "tw", "hk"].map(to => Converter({ from: "cn", to }));
const MAX_QUERY_CHARS = 4096, MAX_TERMS = 8;
// Function words, pronouns, interrogatives and recall phrasing carry no
// content of their own; matching them would rank chatter above facts.
const STOP = new Set(`我 你 您 他 她 它 我们 你们 他们 她们 咱们 自己 的 地 得 了 着 过 吗 呢 吧 啊 呀 哦 嘛 和 与 及 或 或者 跟 同 是 不是
  在 有 没有 有没有 这 那 这个 那个 这些 那些 哪 哪个 哪些 哪里 什么 啥 怎么 怎样 怎么样 为什么 如何 多少 几 叫 叫做 用 用的 用过
  之前 以前 上次 上回 刚才 刚刚 曾经 当时 现在 今天 昨天 一下 一个 一些 可以 能 能不能 会 要 想 就 都 也 还 又 再 很 请 帮 帮我
  告诉 说 说过 讲 提 提过 聊 聊过 讨论 讨论过 记得 还记得 知道 是否 一直 关于 对于 还是 但是 然后 所以 因为 如果`.split(/\s+/u).filter(Boolean));

const hasCjk = text => typeof text === "string" && CJK.test(text);
const foldChinese = text => toSimplified(text.normalize("NFKC")).toLowerCase();

// Retrieval expands only the bounded query, never the stored source. Original
// snippets, line ranges and source fingerprints remain authoritative.
function cjkQueryVariants(term) {
  const simplified = foldChinese(term);
  return [...new Set([term, simplified, ...toTraditional.map(convert => convert(simplified))])];
}

let segmenter = null;
function words(text) {
  segmenter ||= new Intl.Segmenter("zh", { granularity: "word" });
  return [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment);
}

function cjkContentWords(text) {
  return words(foldChinese(text)).filter(term => term && !STOP.has(term) && Array.from(term).length >= 2);
}

// Distinct content terms, longest first: CJK words of two or more characters
// and Latin/number words of two or more characters.
function planCjkQueryTerms(query) {
  if (!hasCjk(query)) return [];
  const terms = new Set();
  for (const term of cjkContentWords(query.slice(0, MAX_QUERY_CHARS))) terms.add(term);
  return [...terms].sort((a, b) => Array.from(b).length - Array.from(a).length).slice(0, MAX_TERMS);
}

function count(haystack, needle) {
  let total = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) total++;
  return total;
}

// Relevance in [0, 1] for a candidate text. Weighted coverage of the query
// terms decides most of it; density separates a short fact from a long
// transcript that mentions the word once. No coverage, no score.
function scoreCjkCandidate(text, terms) {
  if (typeof text !== "string" || !terms.length) return 0;
  const body = foldChinese(text);
  let weight = 0, covered = 0, coveredChars = 0;
  for (const term of terms) {
    const length = Array.from(term).length, termWeight = Math.min(length, 4);
    weight += termWeight;
    const found = count(body, term);
    if (!found) continue;
    covered += termWeight; coveredChars += found * length;
  }
  if (!covered) return 0;
  const coverage = covered / weight;
  const density = Math.min(1, coveredChars * 12 / Math.max(Array.from(body).length, 1));
  return Math.min(0.95, 0.25 + 0.5 * coverage + 0.2 * density);
}

module.exports = { hasCjk, planCjkQueryTerms, scoreCjkCandidate, cjkQueryVariants, cjkContentWords };
