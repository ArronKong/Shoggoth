const fs = require("node:fs");
const path = require("node:path");
module.exports = function nativeChatImage(directory) {
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  const file = path.join(directory, "中文 图片.png");
  fs.writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
  return { path: file, mimeType: "image/png", data };
};
