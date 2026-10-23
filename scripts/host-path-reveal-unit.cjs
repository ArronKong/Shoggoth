"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { revealHostPath } = require("../app/host-path-reveal");

test("Finder receives exact existing paths and expanded home paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-reveal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "季度报告 100%.txt");
  fs.writeFileSync(file, "report");
  const selected = [];
  const reveal = target => revealHostPath(target, absolute => selected.push(absolute));
  assert.equal(reveal(file), true);
  assert.equal(reveal(directory), true);
  assert.equal(reveal("~"), true);
  assert.equal(reveal("~/Documents"), fs.existsSync(path.join(os.homedir(), "Documents")));
  assert.deepEqual(selected.slice(0, 3), [file, directory, os.homedir()]);
  if (selected.length === 4) assert.equal(selected[3], path.join(os.homedir(), "Documents"));
  const count = selected.length;
  for (const invalid of [null, {}, "", "relative.txt", file + "\0", path.join(directory, "missing.txt")]) {
    assert.equal(reveal(invalid), false);
  }
  assert.equal(selected.length, count);
  assert.equal(revealHostPath(file, () => { throw Error("Finder unavailable"); }), false);
});
