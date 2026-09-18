// Turn Lab 演示剧本 —— 四段有代表性的「一轮对话」事件流。
// 每条 { dt, ev }:dt = 距上一事件的毫秒数(播放器按倍速缩放调度,但传给 reducer
// 的虚拟时钟用未缩放的 dt 累加,所以任何倍速下显示的耗时都是剧本真值)。
// 注意:thinking / delta 依线上契约必须是「全量累积」文本(reducer 负责切段)。

import type { TurnEvent } from "../../lib/turnTimeline";

export interface ScenarioEvent {
  dt: number;
  ev: TurnEvent;
}
export type ScenarioId = "smooth" | "recover" | "planning" | "parallel";
export interface Scenario {
  id: ScenarioId;
  events: ScenarioEvent[];
}

// ---------------------------------------------------------------- smooth ----
const S1_T1 = "用户想要玻璃效果的抗锯齿方案。先搜一下业界通行做法,再对照仓库里现有的 shader 实现。";
const S1_T2 = S1_T1 + "\n\n关键词应该覆盖 SDF 轮廓羽化与覆盖率 AA 两条路线。";
const S1_A1 = "调研完成。结论先行:**覆盖率羽化带**是最适合本仓库的方案。\n\n";
const S1_A2 = S1_A1 + "- 业界通行做法是把 `smoothstep` 羽化带对称跨在 SDF 边界两侧(±0.75 设备像素);\n- 仓库里 `shaders.ts` 的羽化带被外阴影分支拦腰截断,这正是锯齿来源;\n";
const S1_A3 = S1_A2 + "- 我已把修复补丁应用到 `FS_GLASS`,构建通过。\n\n细节见上方各步骤的展开内容。";

const smooth: Scenario = {
  id: "smooth",
  events: [
    { dt: 0, ev: { kind: "user", text: "帮我调研 WebGL 玻璃效果边缘锯齿的成因和修法,直接把补丁打上" } },
    { dt: 500, ev: { kind: "thinking", text: S1_T1 } },
    { dt: 900, ev: { kind: "thinking", text: S1_T2 } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t1", name: "web_search", phase: "start", args: { query: "WebGL SDF outline antialiasing coverage smoothstep", count: 8 } } },
    { dt: 1800, ev: { kind: "tool", toolCallId: "t1", name: "web_search", phase: "result", result: '8 results:\n1. "Antialiased SDF rendering" — 覆盖率羽化带要对称跨过 sdf=0\n2. "Signed distance fields for vector shapes"\n3. "GPU glass refraction techniques"\n…' } },
    { dt: 600, ev: { kind: "tool", toolCallId: "t2", name: "web_fetch", phase: "start", args: { url: "https://iquilezles.org/articles/distfunctions2d/" } } },
    { dt: 2400, ev: { kind: "tool", toolCallId: "t2", name: "web_fetch", phase: "result", durationS: 2.4, result: "已抓取并转为 markdown(4.2k 字)。要点:羽化宽度按 fwidth(sdf) 或固定设备像素取,edge±half 对称覆盖…" } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "start", args: { command: "rg -n 'smoothstep' app/manage-ui/src/pages/glass/shaders.ts" } } },
    { dt: 900, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "update", partialResult: "142:  float edge = smoothstep(-1.5, 0.5, sdf);\n" } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "update", partialResult: "142:  float edge = smoothstep(-1.5, 0.5, sdf);\n171:  float shadowMask = smoothstep(0.0, 12.0, sdf);\n" } },
    { dt: 500, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "result", result: "142:  float edge = smoothstep(-1.5, 0.5, sdf);\n171:  float shadowMask = smoothstep(0.0, 12.0, sdf);\n(exit 0)" } },
    { dt: 1100, ev: { kind: "tool", toolCallId: "t4", name: "apply_patch", phase: "start", args: { path: "app/manage-ui/src/pages/glass/shaders.ts" }, diffText: "@@ -140,3 +140,4 @@\n-  float edge = smoothstep(-1.5, 0.5, sdf);\n-  if (sdf > 0.0) return shadowColor;\n+  const float AA = 0.75;\n+  float edge = smoothstep(-AA, AA, sdf);\n+  if (sdf > AA) return shadowColor;" } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t4", name: "apply_patch", phase: "result", durationS: 0.6, result: "Patch applied cleanly (1 file, +3 -2)." } },
    { dt: 900, ev: { kind: "delta", text: S1_A1 } },
    { dt: 800, ev: { kind: "delta", text: S1_A2 } },
    { dt: 800, ev: { kind: "delta", text: S1_A3 } },
    { dt: 400, ev: { kind: "final", text: S1_A3, meta: { model: "claude-fable-5", usage: { input: 48213, output: 1024, contextPercent: 23 } } } },
  ],
};

// --------------------------------------------------------------- recover ----
const S2_T1 = "先直接抓取定价页,拿到表格再落盘。";
const S2_T2 = S2_T1 + "\n\n直接抓取被 403 拦了(反爬)。换浏览器真实渲染后读页面文本,绕开指纹检测。";
const S2_A = "定价表已抓到并保存为 `~/out/pricing.md`(先被 403 拦截,已改走浏览器渲染;首次落盘遇到权限问题,换目录后成功)。";

const recover: Scenario = {
  id: "recover",
  events: [
    { dt: 0, ev: { kind: "user", text: "抓取 https://example.com/pricing 的定价表,存成本地 markdown" } },
    { dt: 500, ev: { kind: "thinking", text: S2_T1 } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t1", name: "web_fetch", phase: "start", args: { url: "https://example.com/pricing" } } },
    { dt: 1600, ev: { kind: "tool", toolCallId: "t1", name: "web_fetch", phase: "result", isError: true, result: '{"status":"error","code":403,"message":"Forbidden: bot detection triggered"}' } },
    { dt: 900, ev: { kind: "thinking", text: S2_T2 } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t2", name: "browser", phase: "start", args: { action: "open", url: "https://example.com/pricing" } } },
    { dt: 3100, ev: { kind: "tool", toolCallId: "t2", name: "browser", phase: "result", durationS: 3.1, result: "页面渲染完成,读取到定价表 3 档:Free / Pro $20 / Enterprise 询价。" } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "start", args: { command: "mkdir -p /out && tee /out/pricing.md" } } },
    { dt: 600, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "result", isError: true, result: "mkdir: /out: Read-only file system (exit 1)" } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t4", name: "exec", phase: "start", args: { command: "mkdir -p ~/out && tee ~/out/pricing.md" } } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t4", name: "exec", phase: "result", result: "written: ~/out/pricing.md (412 bytes)" } },
    { dt: 900, ev: { kind: "delta", text: S2_A } },
    { dt: 400, ev: { kind: "final", text: S2_A, meta: { model: "gpt-5.4", usage: { input: 12840, output: 356, contextPercent: 9 } } } },
  ],
};

// -------------------------------------------------------------- planning ----
const S3_T1 = "全仓清理 console.log 属于批量改动,先列计划再动手,清理后必须构建验证。";
const S3_T2 = S3_T1 + "\n\n扫描结果 37 处,集中在 6 个文件;其中 2 处在错误处理路径里,应换成正式日志而不是直接删。";
const S3_A = "清理完成:35 处删除、2 处改为 logger.warn,构建验证通过。计划三项全部勾掉。";

const planning: Scenario = {
  id: "planning",
  events: [
    { dt: 0, ev: { kind: "user", text: "把仓库里的 console.log 全清掉,先列个计划,清完要能构建" } },
    { dt: 600, ev: { kind: "thinking", text: S3_T1 } },
    { dt: 1200, ev: { kind: "plan", entries: [{ content: "扫描全部 console.log 出现点", status: "pending" }, { content: "逐文件清理/替换", status: "pending" }, { content: "构建验证", status: "pending" }] } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t1", name: "search_files", phase: "start", args: { pattern: "console\\.log" } } },
    { dt: 1400, ev: { kind: "tool", toolCallId: "t1", name: "search_files", phase: "result", durationS: 1.3, result: "37 matches in 6 files:\nsrc/lib/api.ts (12)\nsrc/pages/Home.tsx (9)\n…" } },
    { dt: 900, ev: { kind: "thinking", text: S3_T2 } },
    { dt: 800, ev: { kind: "plan", entries: [{ content: "扫描全部 console.log 出现点", status: "completed" }, { content: "逐文件清理/替换", status: "in_progress" }, { content: "构建验证", status: "pending" }] } },
    { dt: 700, ev: { kind: "prompt", prompt: { kind: "approval", requestId: "req-1", command: "npm run build && git add -A", description: "清理后重新构建并暂存全部改动", choices: ["允许一次", "本会话允许", "拒绝"] } } },
    { dt: 2600, ev: { kind: "promptAnswer", requestId: "req-1", choice: "允许一次" } },
    { dt: 600, ev: { kind: "tool", toolCallId: "t2", name: "exec", phase: "start", args: { command: "npm run build && git add -A" } } },
    { dt: 8400, ev: { kind: "tool", toolCallId: "t2", name: "exec", phase: "result", durationS: 8.4, result: "vite v5 building…\n✓ built in 7.9s\n(exit 0)" } },
    { dt: 700, ev: { kind: "plan", entries: [{ content: "扫描全部 console.log 出现点", status: "completed" }, { content: "逐文件清理/替换", status: "completed" }, { content: "构建验证", status: "completed" }] } },
    { dt: 900, ev: { kind: "status", status: { kind: "compacting", text: "上下文接近上限,正在整理…" } } },
    { dt: 1400, ev: { kind: "status", status: { kind: "compacted" } } },
    { dt: 700, ev: { kind: "delta", text: S3_A } },
    { dt: 400, ev: { kind: "final", text: S3_A, meta: { model: "claude-fable-5", usage: { input: 88012, output: 512, contextPercent: 71 } } } },
  ],
};

// -------------------------------------------------------------- parallel ----
const S4_T1 = "两个目录并行查:内置 web_search 的 provider 列表,和 AgentKey 的搜索类工具清单,拿齐了再对比。";
const S4_SEG = "两边目录都拿到了,下面按覆盖面 / 计费 / 时效性三个维度对比。";
const S4_A = "结论:AgentKey 的搜索工具在垂类数据(社媒/链上/行情)上远多于内置 web_search;通用网页检索两者重叠,内置版免费、AgentKey 按次计费。日常混用建议:通用查询走内置,垂类走 AgentKey。";

const parallel: Scenario = {
  id: "parallel",
  events: [
    { dt: 0, ev: { kind: "user", text: "对比一下 AgentKey 里的搜索类工具和内置 web_search 的差别" } },
    { dt: 500, ev: { kind: "thinking", text: S4_T1 } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t1", name: "web_search", phase: "start", args: { query: "built-in web_search providers coverage", count: 5 } } },
    { dt: 120, ev: { kind: "tool", toolCallId: "t2", name: "mcp__agentkey__find_tools", phase: "start", args: { q: "web search", max_results: 20 } } },
    { dt: 1800, ev: { kind: "tool", toolCallId: "t1", name: "web_search", phase: "result", result: "5 results: provider 由网关配置决定(Brave/Exa/Tavily…),对模型只暴露统一 web_search。" } },
    { dt: 800, ev: { kind: "tool", toolCallId: "t2", name: "mcp__agentkey__find_tools", phase: "result", durationS: 2.7, result: '20 tools matched: "Brave/getWebSearch", "Firecrawl/scrape", "Exa/search", "Tavily/search", …(含社媒/链上/行情等垂类)' } },
    { dt: 900, ev: { kind: "interim", text: S4_SEG } },
    { dt: 700, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "start", args: { command: "jq '.tools | length' agentkey-catalog.json" } } },
    { dt: 600, ev: { kind: "tool", toolCallId: "t3", name: "exec", phase: "result", result: "1799" } },
    { dt: 800, ev: { kind: "delta", text: S4_A.slice(0, 40) } },
    { dt: 700, ev: { kind: "delta", text: S4_A } },
    { dt: 400, ev: { kind: "final", text: S4_A, meta: { model: "hermes-4.1", usage: { input: 20144, output: 288, contextPercent: 12 } } } },
  ],
};

export const SCENARIOS: Scenario[] = [smooth, recover, planning, parallel];
