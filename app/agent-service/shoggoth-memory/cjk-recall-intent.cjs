"use strict";

// Chinese recall phrasing the upstream intent rules miss, such as
// 「我之前用的那个工具叫什么？」 or 「上次我们讨论过哪个方案？」. It only
// widens the escalate-mode decision for the current user's own words; quoted
// text, hypotheticals and future reminders never trigger it.
const RETROSPECTIVE = /(之前|以前|上次|上回|曾经|刚才|前面|早先|那天|那次|上周|上週|上个月|上個月|昨天)/u;
const RECALLED = /(用的|用过|用過|用了|说的|說的|说过|說過|提到|提过|提過|讨论|討論|聊过|聊過|聊的|告诉|告訴|记下|記下|保存|定的|决定|決定|选的|選的|推荐|推薦|发的|發的|写的|寫的|做的|查的|找的|安排|约定|約定|那个|那個|那件|那篇)/u;
const DISCUSSED = /(我们|我們|咱们|咱們|我跟你|你跟我).{0,6}(聊过|聊過|讨论过|討論過|说过|說過|谈过|談過|提过|提過)/u;
const PREFERENCE = /我的?(偏好|习惯|習慣|要求|喜好|设置|設置|规定|規定).{0,6}(是什么|是什麼|有哪些|是啥|还记得|還記得)/u;
const FUTURE = /(明天|明早|明晚|今晚|以后|以後|之后|之後|下次|下回|待会|待會|等会|等會|稍后|稍後|将来|將來|未来|未來|下周|下週|下个月|下個月)/u;
const HYPOTHETICAL = /^(如果|假如|假设|假設|要是|万一|萬一)/u;
const QUOTED = /[「『“"][^」』”"]*[」』”"]/gu;

function hasLocalizedRecallIntent(message) {
  if (typeof message !== "string") return false;
  const text = message.normalize("NFKC").replace(QUOTED, " ").replace(/\s+/gu, " ").trim().slice(0, 2000);
  if (!text || HYPOTHETICAL.test(text)) return false;
  const retrospective = RETROSPECTIVE.test(text);
  if (FUTURE.test(text) && !retrospective) return false;
  return retrospective && RECALLED.test(text) || DISCUSSED.test(text) || PREFERENCE.test(text);
}

module.exports = { hasLocalizedRecallIntent };
