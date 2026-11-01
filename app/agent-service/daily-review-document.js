"use strict";
const { HeartbeatDocumentStore, meaningful, MAX_DOCUMENT_BYTES } = require("./heartbeat-document");
const { serviceError } = require("./security");

const DAILY_REVIEW_FILE = "DAILY_REVIEW.md";
const DEFAULT_DAILY_REVIEW = `# Daily inspiration review

You are my daily inspiration review assistant.

Review the supplied candidates and decide which items deserve my attention or action today.

Prioritize:
- Inspiration seeds created today and seeds created more than three days ago.
- Items waiting for my input or approval that can proceed once I respond.
- Failed or interrupted items that require me to decide what to do next.
- Completed items that have not been archived and whose results are worth reviewing.
- Older ideas I have favorited, but only when you can explain why they deserve renewed attention now.

Do not mechanically remind me about an idea just because it has been stored for a long time.
For each reminder, explain what happened, why it deserves attention now, and the concrete next step I can take.

Use only the information provided. Do not infer missing background or the quality of any artifacts.
Stay silent when there is not sufficient reason to notify me.
Do not automatically execute, modify, or archive ideas.
`;

function parseDailyReview(content) {
  if (typeof content !== "string" || !content.isWellFormed() || content.includes("\0")
    || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES || Buffer.byteLength(JSON.stringify(content)) > 20 * 1024) {
    throw serviceError("PROACTIVE_DOCUMENT_INVALID", "每日灵感回顾规则内容无效或过长");
  }
  return { empty: !meaningful(content) };
}

class DailyReviewDocumentStore extends HeartbeatDocumentStore {
  constructor(options) {
    super({ ...options, documentName: DAILY_REVIEW_FILE, defaultContent: DEFAULT_DAILY_REVIEW, parseContent: parseDailyReview });
  }
}

module.exports = { DAILY_REVIEW_FILE, DEFAULT_DAILY_REVIEW, DailyReviewDocumentStore, parseDailyReview };
