"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// A native save dialog selected the destination. Replace it only after the complete file is on disk.
async function writeDesktopExport(destination, content) {
  if (!path.isAbsolute(destination)) throw new Error("INVALID_EXPORT_PATH");
  const temporary = path.join(path.dirname(destination), `.shoggoth-export-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

module.exports = { writeDesktopExport };
