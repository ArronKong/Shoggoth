#!/usr/bin/env node

// Agent Trajectory 六行与自动跟随回归：真实挂载 TurnTimeline，并用节点 mock
// 区分时间线内部滚动容器与外层聊天容器。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const React = requireFromUi("react");
const TestRenderer = requireFromUi("react-test-renderer");
const esbuild = requireFromUi("esbuild");
const { act } = TestRenderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const timelineSourcePath = path.join(uiRoot, "src/components/TurnTimeline/TurnTimeline.tsx");
const processSourcePath = path.join(uiRoot, "src/components/TurnTimeline/TurnProcess.tsx");
const chatSourcePath = path.join(uiRoot, "src/pages/ChatPage.tsx");
const cssPath = path.join(uiRoot, "src/components/TurnTimeline/TurnTimeline.module.css");
const scrollbarCssPath = path.join(uiRoot, "src/components/ScrollbarProvider.css");
const results = [];

function check(name, condition) {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

function withoutCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseCssRules(source) {
  return [...withoutCssComments(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.trim()),
    declarations: match[2],
  }));
}

// 全局 scrollbar 规则不得挂业务 class；`.scrolling` 是 Provider 唯一批准的状态 class。
// 按整组 selector 审查，避免用分组规则把 transition 或业务 selector 藏在另一个成员中。
function globalScrollbarRuleIssues(source) {
  const allowedSelectors = new Set([
    ":root",
    ':root[data-theme="dark"]',
    "body[data-immersive]",
    "*",
    "*::-webkit-scrollbar",
    "*::-webkit-scrollbar-track",
    "*::-webkit-scrollbar-corner",
    "*::-webkit-scrollbar-thumb",
    "*::-webkit-scrollbar-thumb:vertical",
    "*::-webkit-scrollbar-thumb:horizontal",
    "*.scrolling::-webkit-scrollbar-thumb",
    "*:hover::-webkit-scrollbar-thumb",
    '*[data-scrollbar="hidden"]',
    '*[data-scrollbar="hidden"]::-webkit-scrollbar',
  ]);
  const issues = [];
  for (const rule of parseCssRules(source)) {
    for (const selector of rule.selectors) {
      if (selector.startsWith("@property ")) continue;
      if (!allowedSelectors.has(selector)) {
        issues.push(`selector not allowed: ${selector}`);
      }
    }
    if (
      rule.selectors.some((selector) => selector.includes("::-webkit-scrollbar"))
      && /\btransition(?:-[a-z-]+)?\s*:/i.test(rule.declarations)
    ) {
      issues.push("pseudo transition");
    }
  }
  return issues;
}

async function compileTurnTimeline() {
  const dir = fs.mkdtempSync(path.join(uiRoot, ".agent-trajectory-regression-"));
  const outfile = path.join(dir, "turn-timeline.cjs");
  const plugin = {
    name: "agent-trajectory-regression-stubs",
    setup(build) {
      build.onResolve({ filter: /^react-i18next$/ }, () => ({
        path: "react-i18next",
        namespace: "trajectory-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "trajectory-stub" }, () => ({
        contents: "export const useTranslation = () => ({ t: (key) => key });",
        loader: "js",
      }));
      build.onLoad({ filter: /\.module\.css$/ }, () => ({
        contents: "export default new Proxy({}, { get: (_target, key) => String(key) });",
        loader: "js",
      }));
    },
  };

  await esbuild.build({
    entryPoints: [timelineSourcePath],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["react", "react-test-renderer"],
    plugins: [plugin],
    logLevel: "silent",
  });

  return {
    TurnTimeline: createRequire(outfile)(outfile).default,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSteps(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `step-${index + 1}`,
    kind: "thinking",
    status: index === count - 1 ? "running" : "ok",
    startTs: index,
  }));
}

function mountTimeline(TurnTimeline, { steps, autoFollow }) {
  const outerNode = { scrollTop: 137 };
  const wrapNode = {
    clientHeight: 224,
    scrollHeight: 720,
    _scrollTop: 0,
    get scrollTop() {
      return this._scrollTop;
    },
    set scrollTop(value) {
      this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
  };
  let rowScrollCalls = 0;

  const createNodeMock = (element) => {
    if (element.props["data-regression"] === "outer-scroll") return outerNode;
    if (element.type === "div" && String(element.props.className ?? "").split(/\s+/).includes("wrap")) {
      return wrapNode;
    }
    if (element.type === "li") {
      return {
        animate() {},
        querySelector() {
          return null;
        },
        scrollIntoView() {
          rowScrollCalls += 1;
          // 模拟嵌套滚动容器下 scrollIntoView 可能连带改变外层聊天位置。
          outerNode.scrollTop = 0;
        },
      };
    }
    return {};
  };

  const tree = (nextSteps) => React.createElement(
    "section",
    { ref: () => {}, "data-regression": "outer-scroll" },
    React.createElement(TurnTimeline, {
      steps: nextSteps,
      status: autoFollow ? "running" : "done",
      showDurations: false,
      autoFollow,
      className: "procTimeline",
    }),
  );

  let renderer;
  act(() => {
    renderer = TestRenderer.create(tree(steps), { createNodeMock });
  });
  return {
    outerNode,
    wrapNode,
    update(nextSteps) {
      act(() => renderer.update(tree(nextSteps)));
    },
    unmount() {
      act(() => renderer.unmount());
    },
    get rowScrollCalls() {
      return rowScrollCalls;
    },
  };
}

const previousWindow = globalThis.window;
globalThis.window = {
  matchMedia() {
    return { matches: true };
  },
};

const compiled = await compileTurnTimeline();
try {
  const live = mountTimeline(compiled.TurnTimeline, {
    steps: makeSteps(7),
    autoFollow: true,
  });
  const eightSteps = makeSteps(8);
  live.wrapNode.scrollTop = 23;
  const liveOuterBefore = live.outerNode.scrollTop;
  live.update(eightSteps);
  check(
    "live 追加步骤后内部时间线滚到底部",
    live.wrapNode.scrollTop === live.wrapNode.scrollHeight - live.wrapNode.clientHeight,
  );
  check(
    "live 自动跟随不改变外层聊天滚动位置",
    live.outerNode.scrollTop === liveOuterBefore,
  );
  check(
    "自动跟随不调用行节点 scrollIntoView",
    live.rowScrollCalls === 0,
  );
  live.wrapNode.scrollTop = 23;
  live.wrapNode.scrollHeight = 900;
  const grownEightSteps = [
    ...eightSteps.slice(0, 7),
    { ...eightSteps[7], text: "同一运行步骤追加了更多流式内容" },
  ];
  live.update(grownEightSteps);
  check(
    "live 同步数内容增长后仍滚到底部",
    live.wrapNode.scrollTop === live.wrapNode.scrollHeight - live.wrapNode.clientHeight,
  );
  live.wrapNode.scrollTop = 23;
  live.update([...grownEightSteps]);
  check("live 同内容父级重渲染不强制跳底", live.wrapNode.scrollTop === 23);
  live.unmount();

  const history = mountTimeline(compiled.TurnTimeline, {
    steps: makeSteps(7),
    autoFollow: false,
  });
  check("history 初始保持顶部", history.wrapNode.scrollTop === 0);
  history.update(makeSteps(8));
  check("history 追加步骤后仍保持顶部", history.wrapNode.scrollTop === 0);
  history.unmount();

  const timelineSource = fs.readFileSync(timelineSourcePath, "utf8");
  const processSource = fs.readFileSync(processSourcePath, "utf8");
  const chatSource = fs.readFileSync(chatSourcePath, "utf8");
  const cssSource = fs.readFileSync(cssPath, "utf8");
  const scrollbarCssSource = fs.readFileSync(scrollbarCssPath, "utf8");
  const scrollbarCss = withoutCssComments(scrollbarCssSource);
  check(
    "TurnTimeline 源码已移除 scrollIntoView",
    !timelineSource.includes("scrollIntoView"),
  );
  check(
    "TurnProcess 仅在 live 时开启 autoFollow",
    /autoFollow=\{(?:live === true|!!live)\}/.test(processSource),
  );
  const groupTrajectoryIndex = chatSource.indexOf('key={`${groupRenderKey}:live-trajectory`}');
  const groupedMessagesIndex = chatSource.indexOf("{keyedMessages.map");
  check(
    "直播时间线固定在 assistant 组第一条回复上方",
    /const liveMessage = g\.msgs\.find\(\(message\) => message\.pending\);/.test(chatSource)
      && /const groupLiveSteps = liveMessage \? liveStepsFor\(liveMessage\) : \[\];/.test(chatSource)
      && groupTrajectoryIndex >= 0
      && groupTrajectoryIndex < groupedMessagesIndex
      && !chatSource.includes('key={`${messageRenderKey}:live-trajectory`}'),
  );
  check(
    "直播临时计划写入 Agent Trajectory，持久进度卡继续独立展示",
    chatSource.includes('timelineFeed(sk, { kind: "plan", entries: p.plan })')
      && /if \(m\.pending && showTraj && !progress && liveStepsFor\(m\)\.length\) return null;/.test(chatSource)
      && (chatSource.match(/else pendingPlanRef\.current\.delete\(sk\);/g)?.length ?? 0) >= 3,
  );
  check(
    "时间线按实际 1–6 行自然增高并以六行为最大高度",
    /--trajectory-row-height:\s*36px\s*;/.test(cssSource)
      && /--trajectory-visible-rows:\s*6\s*;/.test(cssSource)
      && /--trajectory-wrap-padding-block:\s*4px\s*;/.test(cssSource)
      && /\.row\s*\{[^}]*min-height:\s*var\(--trajectory-row-height\)\s*;/s.test(cssSource)
      && /\.procTimeline\s*\{[^}]*height:\s*auto\s*;/s.test(cssSource)
      && /\.procTimeline\s*\{[^}]*max-height:\s*calc\(\s*var\(--trajectory-row-height\)\s*\*\s*var\(--trajectory-visible-rows\)\s*\+\s*var\(--trajectory-wrap-padding-block\)\s*\*\s*2\s*\)\s*;/s.test(cssSource),
  );
  check(
    "六行时间线只在内部滚动",
    /\.wrap\s*\{[^}]*overflow:\s*auto\s*;/s.test(cssSource)
      && /\.procTimeline\s*\{[^}]*overflow-y:\s*auto\s*;/s.test(cssSource),
  );
  check(
    "全局滚动槽共享 4px thumb、8px 边缘与 12px track",
    /--ui-scrollbar-thumb-size:\s*4px\s*;/.test(scrollbarCss)
      && /--ui-scrollbar-edge-inset:\s*8px\s*;/.test(scrollbarCss)
      && /--ui-scrollbar-track-size:\s*calc\(var\(--ui-scrollbar-thumb-size\)\s*\+\s*var\(--ui-scrollbar-edge-inset\)\)\s*;/.test(scrollbarCss)
      && /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*var\(--ui-scrollbar-track-size\)\s*;[^}]*height:\s*var\(--ui-scrollbar-track-size\)\s*;/s.test(scrollbarCss),
  );
  check(
    "每个元素独立 seed 透明 thumb 颜色并由基础 thumb 读取",
    /@property\s+--ui-scrollbar-thumb-color\s*\{[^}]*inherits:\s*true\s*;[^}]*initial-value:\s*transparent\s*;/s.test(scrollbarCss)
      && /\*\s*\{[^}]*--ui-scrollbar-thumb-color:\s*transparent\s*;/s.test(scrollbarCss)
      && /\*::\-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--ui-scrollbar-thumb-color\)\s*;/s.test(scrollbarCss),
  );
  check(
    "全局滚动条定义独立明暗主题浮现色",
    /:root\s*\{[^}]*--ui-scrollbar-thumb-visible:\s*rgba\(0,\s*0,\s*0,\s*0\.1\)\s*;/s.test(scrollbarCss)
      && /:root\[data-theme="dark"\]\s*\{[^}]*--ui-scrollbar-thumb-visible:\s*rgba\(255,\s*255,\s*255,\s*0\.16\)\s*;/s.test(scrollbarCss),
  );
  check(
    "scrolling 与 hover 均使用全局主题浮现色",
    /\*\.scrolling::\-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--ui-scrollbar-thumb-visible\)\s*;/s.test(scrollbarCss)
      && /\*:hover::\-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--ui-scrollbar-thumb-visible\)\s*;/s.test(scrollbarCss),
  );
  check(
    "全局滚动条无业务专属 class 且不依赖 pseudo transition",
    globalScrollbarRuleIssues(scrollbarCssSource).length === 0,
  );
  const groupedRuleFixtureIssues = globalScrollbarRuleIssues(`
    *::-webkit-scrollbar-thumb,
    .dashboard-page {
      transition-property: background-color;
    }
  `);
  check(
    "全局滚动条规则审查会拒绝分组业务 class 与 pseudo transition",
    groupedRuleFixtureIssues.includes("selector not allowed: .dashboard-page")
      && groupedRuleFixtureIssues.includes("pseudo transition"),
  );
} finally {
  compiled.cleanup();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} pass`);
assert.equal(failed.length, 0, `${failed.length} 项 Agent Trajectory 六行/自动滚动回归失败`);
