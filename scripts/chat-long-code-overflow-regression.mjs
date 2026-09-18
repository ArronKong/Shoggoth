#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cssPath = new URL("../app/manage-ui/src/pages/ChatPage.css", import.meta.url);
const css = readFileSync(cssPath, "utf8");

const bubbleRule = css.match(/\.chat-bubble\s*\{([^}]*)\}/s)?.[1] ?? "";
const preRule = css.match(/\.chat-md pre\s*\{([^}]*)\}/s)?.[1] ?? "";

assert.match(bubbleRule, /\bmin-width:\s*0\s*;/, "气泡必须允许收缩，不能被超长代码行的固有宽度撑开");
assert.match(bubbleRule, /\bmax-width:\s*100%\s*;/, "气泡宽度必须受所属消息列的上限约束");
assert.match(preRule, /\boverflow-x:\s*auto\s*;/, "超长代码行应在代码块内横向滚动，不强制折行");

console.log("chat-long-code-overflow-regression: 3/3 passed");
