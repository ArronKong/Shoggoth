"use strict";
const fs = require("node:fs"), path = require("node:path");
const { createSkillAdapters, RELEASE, sha256 } = require("../../app/agent-service/lark-cli-installer");

// Synthetic files only; no real account, runtime, network or global CLI changes.
async function prepareFixture({ root, signal, onStage }) {
  signal.throwIfAborted(); onStage("downloadCli");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true, mode: 0o700 });
  const executable = path.join(root, "bin", "lark-cli");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf 'lark-cli version 1.0.98\\n'\n", { mode: 0o700 });
  onStage("downloadSkills");
  const names = ["lark-shared", "lark-calendar"];
  for (const name of names) {
    const directory = path.join(root, "skills", name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\ndescription: Lark fixture ${name}\n---\n\nRead references before running lark-cli.\n`, { mode: 0o600 });
  }
  onStage("verify");
  return { cliSha256: sha256(fs.readFileSync(executable)), skills: createSkillAdapters(root, names, { ...RELEASE, skillCount: names.length }) };
}
module.exports = { prepareFixture };
