"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { ShoggothBackend } = require("../../app/core/shoggoth-backend");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

function nativeAgentImages(root, runtime = "codex") {
  const agentId = `${runtime}-images`;
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  const key = `agent:${agentId}:${sessionId}`;
  const otherKey = `agent:${agentId}:${otherId}`;
  const imagePath = path.join(root, "中文 图片(1).png");
  const relativePath = path.join(root, "relative.png");
  fs.writeFileSync(imagePath, PNG);
  fs.writeFileSync(relativePath, PNG);
  const text = `这里是图片。\n\n![中文图片](<${imagePath}>)\n\n![文件 URL](file://${encodeURI(imagePath)})\n\n![相对路径](./relative.png)\n\nMEDIA:${imagePath}`;
  const history = [{ id: "request", role: "user", content: [{ type: "text", text: "请发送图片" }] },
    { id: "images", role: "assistant", content: [{ type: "text", text }] }];
  const backend = new ShoggothBackend({ id: "shoggoth", name: runtime,
    paths: { tokenPath: path.join(root, "unused-token") }, readToken: () => "unused", requestService: async () => ({}) });
  const profile = { id: "image-profile", agentId, runtime, runtimeAccountId: "image-account" };
  backend._profilesByAgent.set(agentId, profile);
  for (const id of [sessionId, otherId]) backend._sessionsByKey.set(id, {
    id, sessionKey: id, profileId: profile.id, workspace: root, status: "ready",
  });
  backend.runtimeCliAuth.set(profile.runtimeAccountId, { runtime, processHome: root });
  backend._getHistoryItems = async readKey => {
    backend._sessionTarget(readKey);
    return (readKey === key ? history : []).map(message => ({ fragment: null, payload: { message } }));
  };
  return { backend, history, key, otherKey, agentId, imagePath, relativePath, text, PNG };
}
module.exports = { nativeAgentImages, PNG };
