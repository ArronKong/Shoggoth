#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const source = {
  oauth: read("app/manage-ui/src/pages/keys/OAuthLoginModal.tsx"),
  keysCss: read("app/manage-ui/src/pages/keys/KeysPanel.module.css"),
  field: read("app/manage-ui/src/components/Field.tsx"),
  skills: read("app/manage-ui/src/pages/SkillsPage.tsx"),
  skin: read("app/manage-ui/src/manage-skin.css"),
  glass: read("app/manage-ui/src/pages/GlassLab.tsx"),
  usage: read("app/manage-ui/src/pages/UsagePage.tsx"),
  usageCss: read("app/manage-ui/src/pages/usage/UsagePage.css"),
};

const failures = [];
function check(name, condition) {
  const ok = Boolean(condition);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
}

check(
  "BUG-026 OAuth 使用共享 Modal 的 focus/Escape/ARIA 生命周期",
  /import Modal from "\.\.\/\.\.\/components\/Modal"/.test(source.oauth) &&
    /<Modal[\s\S]{0,220}dismissible=/.test(source.oauth) &&
    !/role="dialog"|styles\.modalOverlay|styles\.modal\b/.test(source.oauth),
);
check(
  "BUG-026 OAuth 私有假 modal 样式已移除",
  !/\.modalOverlay\s*\{|\.modalTitle\s*\{/.test(source.keysCss),
);
check(
  "BUG-027 Switch 可把可访问名称传给真实控件",
  /ariaLabel\?: string/.test(source.field) &&
    /<BaseSwitch\.Root[\s\S]{0,220}aria-label=\{ariaLabel\}/.test(source.field),
);
check(
  "BUG-027 Skills 卡片入口是原生按钮且不再嵌套 switch",
  /<article[\s\S]{0,420}<button[\s\S]{0,160}skill-card-open/.test(source.skills) &&
    !/role="button"/.test(source.skills) &&
    /\.skill-card-open:focus-visible/.test(source.skin),
);
check(
  "BUG-027 Skills 两处 switch 都包含技能名",
  (source.skills.match(/ariaLabel=\{`\$\{t\("skills\.enabledLabel"\)\}: \$\{[^}]+\.name\}`\}/g) || []).length >= 2,
);
check(
  "BUG-028 Glass range 与可见标题显式关联",
  /useId/.test(source.glass) && /type="range"[\s\S]{0,180}aria-labelledby=\{labelId\}/.test(source.glass),
);
check(
  "BUG-030 Usage 会话入口可由键盘聚焦激活",
  /<tr[\s\S]{0,180}usage-row-click[\s\S]{0,180}onClick=\{\(\) => setPreviewFor\(s\)\}/.test(source.usage) &&
    /<button[\s\S]{0,180}usage-session-open[\s\S]{0,180}aria-label=\{`\$\{sessionLabel\(s\)\} · \$\{fmtWhen\(s\.updatedAt\)\}`\}/.test(source.usage) &&
    /usage-session-open[\s\S]{0,260}setPreviewFor\(s\)/.test(source.usage) &&
    /\.usage-session-open:focus-visible/.test(source.usageCss),
);

console.log(`RESULT ${7 - failures.length}/7 pass`);
assert.deepEqual(failures, []);
