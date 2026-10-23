"use strict";

const crypto = require("node:crypto");

// Fixed field order is shared with the browser mirror. Operation identity is
// included; authority scope is separately checked and never treated as a grant.
function canonicalGroupSendPayload(value) {
  return JSON.stringify({
    groupId: value.groupId,
    clientMessageId: value.clientMessageId,
    body: value.body,
    mentions: [...(value.mentions ?? value.mentionMemberIds ?? [])],
    replyTo: value.replyTo ?? value.replyToSeq ?? null,
    taskId: value.taskId ?? null,
    attachments: (value.attachments ?? []).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    requestMode: value.requestMode ?? "auto",
    discussionId: value.requestedDiscussionId ?? value.discussionId ?? null,
    summaryMemberId: value.summaryMemberId ?? null,
    expectedPolicyVersion: value.expectedPolicyVersion ?? null,
  });
}

function groupSendPayloadDigest(value) {
  return crypto.createHash("sha256").update(canonicalGroupSendPayload(value), "utf8").digest("hex");
}

module.exports = { canonicalGroupSendPayload, groupSendPayloadDigest };
