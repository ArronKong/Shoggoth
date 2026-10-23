"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function loadChatUiResources({ directory = path.join(__dirname, "native-chat-ui-resources"), read = fs.readFileSync } = {}) {
  try {
    const manifest = JSON.parse(read(path.join(directory, "manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.bundleId !== "native-chat-ui-v1" || manifest.bridgeApiVersion !== 1
      || !/^[a-f0-9]{64}$/u.test(manifest.files?.["visualize.css"] || "")) throw Error("invalid resource manifest");
    const bytes = read(path.join(directory, "visualize.css"));
    if (bytes.length > 64 * 1024 || crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.files["visualize.css"]) throw Error("invalid resource content");
    return { bundleId: manifest.bundleId, stylesheet: bytes.toString("utf8"), manifest };
  } catch (cause) { throw Object.assign(new Error("卡片所需的内置资源不可用"), { code: "UI_RESOURCE_UNAVAILABLE", cause }); }
}
module.exports = { loadChatUiResources };
