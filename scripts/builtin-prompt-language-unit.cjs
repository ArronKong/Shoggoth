"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createDefaultDocuments, VIEW_HEADERS, EMPTY_VIEW_MESSAGES, V3_DEFAULT_AGENTS } = require("../app/agent-service/agent-definition-defaults");
const { renderRoomPrompt, systemText } = require("../app/agent-service/group-room-prompt");
const { DEFAULT_HEARTBEAT, parseHeartbeat } = require("../app/agent-service/heartbeat-document");
const { SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS, SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS } = require("../app/agent-service/product-capability-manifest");
const { parseMemberReply } = require("../app/agent-service/group-reply-format");
const { createLegacyV4Identity } = require("../app/agent-service/agent-definition-legacy-defaults");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");

const noFixedChinese = (value, label) => assert.doesNotMatch(String(value), /\p{Script=Han}/u, `${label} has fixed Chinese text without an App locale branch`);

test("Agent default documents and generated-view instructions use English", () => {
  for (const [kind, body] of Object.entries(createDefaultDocuments("Test Agent"))) noFixedChinese(body, kind);
  for (const [kind, body] of Object.entries(VIEW_HEADERS)) noFixedChinese(body, `${kind} header`);
  for (const [kind, body] of Object.entries(EMPTY_VIEW_MESSAGES)) noFixedChinese(body, `${kind} empty message`);
  assert.match(createDefaultDocuments().SOUL, /user.s current language/u);
});

test("English defaults preserve user names and exact legacy migration identity", () => {
  assert.ok(createDefaultDocuments("测试代理").IDENTITY.includes("- Name: 测试代理"));
  assert.ok(createDefaultDocuments("测试\n代理").IDENTITY.includes('Profile name (JSON): "测试\\n代理"'));
  assert.equal(crypto.createHash("sha256").update(V3_DEFAULT_AGENTS).digest("hex"), "3f7eafac954ecfc0272fc7e8d7c42282099324864557353b9d92c8022a9746c2");
  assert.equal(crypto.createHash("sha256").update(createLegacyV4Identity("Test Agent")).digest("hex"), "ebb8b07d619cb4e2dda7a2e7e4af5c3856816706e105007e6ebf17b3e2eb141f");
  assert.ok(createLegacyV4Identity("旧\n名字").includes('Profile name (JSON): "旧\\n名字"'));
});

test("group rules and system metadata are English while user text stays unchanged", () => {
  const member = { id: "a", displayName: "Owner", state: "active" };
  const input = { group: { name: "Test" }, member, members: [member], ownerId: "a", earlier: [], current: [],
    order: [{ memberId: "a", status: "speaking" }], position: 0, note: "New user message" };
  noFixedChinese(renderRoomPrompt(input), "group prompt");
  noFixedChinese(systemText({ system: { eventType: "turn_failed", memberId: "a" } }, () => "Owner"), "group system event");
  const body = "请用中文回答，不改写这条原文。";
  const prompt = renderRoomPrompt({ ...input, current: [{ id: "m", seq: 1, author: { kind: "user" }, body }] });
  assert.ok(prompt.includes(`user: ${body}`));
  assert.match(prompt, /Reply in the user.s language/u);
});

test("the default heartbeat explanation is English and still causes no model check", () => {
  noFixedChinese(DEFAULT_HEARTBEAT, "heartbeat default");
  assert.equal(parseHeartbeat(DEFAULT_HEARTBEAT).empty, true);
});

test("shared native and external product instructions use English", () => {
  noFixedChinese(SHOGGOTH_PRODUCT_DEVELOPER_INSTRUCTIONS, "native product instructions");
  noFixedChinese(SHOGGOTH_EXTERNAL_PRODUCT_DEVELOPER_INSTRUCTIONS, "external product instructions");
});

test("model-visible product tool descriptions and schema guidance use English", () => {
  const inspect = (value, label) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["description", "title"].includes(key) && typeof item === "string") noFixedChinese(item, `${label}.${key}`);
      if (item && typeof item === "object") inspect(item, `${label}.${key}`);
    }
  };
  for (const tool of DEFAULT_TOOL_REGISTRY.mcpDefinitions()) inspect(tool, tool.name);
});

test("English group reply markers work alongside saved Chinese replies", () => {
  for (const [reply, attachment] of [["Reply to", "Attachment"], ["回复", "附件"]]) {
    const value = parseMemberReply(`${reply} #12\n结果保持中文。\n${attachment}: /tmp/测试 文件.txt`);
    assert.equal(value.replyToSeq, 12);
    assert.equal(value.body, "结果保持中文。");
    assert.equal(value.attachmentLines[0]?.path, "/tmp/测试 文件.txt");
  }
  assert.equal(parseMemberReply("Attachment: is mentioned in this sentence.\nOrdinary ending.").attachmentLines.length, 0);
});
