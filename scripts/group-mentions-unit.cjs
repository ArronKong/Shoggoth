"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isPassReply, parseMentions, uniqueHandle } = require("../app/agent-service/group-mentions");

const members = [
  { memberId: "r", handle: "research" },
  { memberId: "b", handle: "builder" },
  { memberId: "v", handle: "评审员" },
];

test("top-level @ invites; Chinese handles need no word boundary", () => {
  assert.deepEqual(parseMentions("请@builder修一下，然后 @评审员看看", members),
    { memberIds: ["b", "v"], broadcast: false, unresolved: [] });
  assert.deepEqual(parseMentions("@Builder. 和 @builder 再说一次", members).memberIds, ["b"], "case-insensitive, deduped");
});

test("code, quotes, links, emails and escapes never dispatch (M06)", () => {
  const text = [
    "@research 看看 `@builder`",
    "```", "@评审员 in code", "```",
    "> @builder quoted",
    "    @builder indented code",
    "mail a@builder.com https://x.com/@builder [link](https://y.com/@builder) \\@builder",
  ].join("\n");
  assert.deepEqual(parseMentions(text, members), { memberIds: ["r"], broadcast: false, unresolved: [] });
});

test("broadcast and unresolved targets are reported, not guessed (M03)", () => {
  assert.equal(parseMentions("@all 大家好", members).broadcast, true);
  assert.equal(parseMentions("@所有人 大家好", members).broadcast, true);
  assert.deepEqual(parseMentions("@unknown 你好 @builderx", members).unresolved, ["unknown", "builderx"]);
  assert.deepEqual(parseMentions("没有点名", members), { memberIds: [], broadcast: false, unresolved: [] });
});

test("handles are unique, reserved words avoided", () => {
  assert.equal(uniqueHandle("Builder Bot", ["builder-bot"]), "builder-bot-2");
  assert.equal(uniqueHandle("研究 员", []), "研究-员");
  assert.equal(uniqueHandle("!!!", []), "agent");
  assert.equal(uniqueHandle("All", []), "all-2", "broadcast words are never member handles");
});

test("only a whole-message pass is silent (M05)", () => {
  for (const text of ["(pass)", " PASS ", "pass.", "", "  \n"]) assert.equal(isPassReply(text), true, JSON.stringify(text));
  for (const text of ["I pass this", "(pass) but also", null]) assert.equal(isPassReply(text), false, JSON.stringify(text));
});

test("member reply conventions: a leading quote line and trailing attachment lines", () => {
  const { parseMemberReply } = require("../app/agent-service/group-reply-format");
  assert.deepEqual(parseMemberReply("回复 #12\n我同意这个方案。\n\n附件：报告/结论.md\n附件: `chart.png`\n"), {
    body: "我同意这个方案。", replyToSeq: 12,
    attachmentLines: [{ line: "附件：报告/结论.md", path: "报告/结论.md" }, { line: "附件: `chart.png`", path: "chart.png" }] });
  // 正文中间提到「附件：」不算；引用行必须是第一行、单独成行。
  const plain = "先说结论。\n附件：见上文的说明\n然后是细节。\n回复 #3 之后再说。";
  assert.deepEqual(parseMemberReply(plain), { body: plain, replyToSeq: null, attachmentLines: [] });
  assert.deepEqual(parseMemberReply("\n引用 #7\n附件：a.txt"), { body: "", replyToSeq: 7, attachmentLines: [{ line: "附件：a.txt", path: "a.txt" }] });
  assert.deepEqual(parseMemberReply("(pass)"), { body: "(pass)", replyToSeq: null, attachmentLines: [] });
  assert.equal(parseMemberReply(Array.from({ length: 10 }, (_item, index) => `附件：f${index}.txt`).join("\n")).attachmentLines.length, 8,
    "at most eight attachment lines are taken; earlier ones stay in the text");
});
