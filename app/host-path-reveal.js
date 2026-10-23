"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function revealHostPath(target, showItemInFolder) {
  if (typeof target !== "string" || !target || target.includes("\0")) return false;
  const absolute = target === "~" || target.startsWith("~/") ? path.join(os.homedir(), target.slice(1)) : target;
  if (!path.isAbsolute(absolute) || !fs.existsSync(absolute)) return false;
  try {
    showItemInFolder(absolute);
    return true;
  } catch {
    return false;
  }
}

module.exports = { revealHostPath };
