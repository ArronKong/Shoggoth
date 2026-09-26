import assert from "node:assert/strict";
import avatarModule from "./helpers/load-agent-avatar.cjs";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const feedPath = path.join(root, "app/manage-ui/src/pages/dashboard/ActivityFeed.tsx");
const cssPath = path.join(root, "app/manage-ui/src/pages/dashboard/DashboardPage.css");

const feed = fs.readFileSync(feedPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

// Render the current component instead of coupling this regression to its
// parameter spelling. Display names may change; avatar identity stays stable.
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = uiRequire("typescript");
const React = uiRequire("react");
const { create, act } = uiRequire("react-test-renderer");
const source = ts.createSourceFile(feedPath, feed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ActivityAgentAvatar");
assert.ok(component, "ActivityFeed must define its agent avatar");
const compiled = ts.transpileModule(`import React from "react";\nexport ${component.getText(source)}`, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, {
  module, exports: module.exports, require: uiRequire,
  AgentAvatarView: avatarModule.default,
}, { filename: feedPath });
for (const props of [
  { agentId: "stable/id", displayName: "Alice" },
  { agentId: "stable/id", displayName: "中文助理" },
  { agentId: "backend agent" },
  { agentId: "fallback", displayName: "" },
  { agentId: "" },
]) {
  const rendered = create(React.createElement(module.exports.ActivityAgentAvatar, props));
  try {
    const avatar = rendered.root.findByType("span");
    assert.match(avatar.props.className, /dash-run-agent-avatar/);
    assert.equal(avatar.props["data-initial"], undefined);
    if (props.agentId) {
      const image = rendered.root.findByType("img");
      assert.equal(image.props.src, `/avatar/${encodeURIComponent(props.agentId)}`);
      act(() => image.props.onLoad());
      assert.equal(avatar.props.style.background, "transparent");
      assert.equal(avatar.props["data-initial"], undefined);
      act(() => image.props.onError());
    }
    assert.equal(rendered.root.findAllByType("img").length, 0);
    assert.equal(avatar.props["data-initial"], undefined, "failed images contain no letters");
  } finally { rendered.unmount(); }
}

// 头像尺寸应在活动行中稳定占位，并裁切成圆形，避免长列表出现布局跳动。
assert.match(css, /\.dash-run-agent-avatar\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;[\s\S]*?border-radius:\s*50%;/);

console.log("dashboard agent avatar regression: PASS");
