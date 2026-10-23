"use strict";

// 成员回复里的两个约定（确定性解析，无模型调用），和 (pass)、@ 一样只看回复文本：
//   第一行单独写「回复 #序号」 → 这条回复引用那条消息；
//   末尾单独成行的「附件：路径」 → 随回复发送成员自己工作区里的文件（每行一个，可以连续多行）。
// 解析只负责切分；序号是否存在、文件能不能读到由调用方核对，核对不过的原样留在正文里。

const MAX_REPLY_ATTACHMENTS = 8;
const REPLY_LINE = /^\s*(?:reply(?: to)?|回复|引用)\s*#(\d{1,9})\s*$/iu;
const ATTACHMENT_LINE = /^\s*(?:attachment|附件)[:：]\s*(\S.*?)\s*$/iu;

/**
 * @param {string} text 成员的最终回答
 * @returns {{ body: string, replyToSeq: number|null, attachmentLines: Array<{line: string, path: string}> }}
 *   attachmentLines 按出现顺序；body 是去掉引用行与全部附件行之后的正文
 */
function parseReplyHeader(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const first = lines.findIndex(line => line.trim() !== "");
  const match = first >= 0 ? REPLY_LINE.exec(lines[first]) : null;
  return { body: match ? lines.slice(first + 1).join("\n").trim() : String(text ?? ""),
    replyToSeq: match ? Number(match[1]) : null };
}

function parseMemberReply(text) {
  const { body, replyToSeq } = parseReplyHeader(text);
  const lines = body.split(/\r?\n/u);
  // 只认末尾连续的附件行（中间允许空行），正文里提到「附件：」的句子不算。
  const attachmentLines = [];
  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "") continue;
    const match = ATTACHMENT_LINE.exec(lines[index]);
    if (!match || attachmentLines.length >= MAX_REPLY_ATTACHMENTS) break;
    // 路径两侧的引号、反引号是模型常见的写法，去掉。
    attachmentLines.unshift({ line: lines[index], path: match[1].replace(/^[`"'“「]+|[`"'”」]+$/gu, "") });
    end = index;
  }
  return { body: lines.slice(0, end).join("\n").trim(), replyToSeq, attachmentLines };
}

module.exports = { MAX_REPLY_ATTACHMENTS, parseMemberReply, parseReplyHeader };
