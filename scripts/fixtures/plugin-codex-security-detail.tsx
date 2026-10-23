import "./plugins-page";
import type { CodexSecurityStatus } from "../../app/manage-ui/src/api/client";

declare const __CODEX_SECURITY_RENDER_BASE__: CodexSecurityStatus;
const scope = window as any;
const originalFetch = scope.fetch;
let mode = "unauthenticated";
const calls: Array<{ route: string; body: any }> = [];
const delayed: Array<() => void> = [];
const base = __CODEX_SECURITY_RENDER_BASE__;
const responseFor = () => {
  const value = structuredClone(base);
  if (mode === "authenticated") value.authentication = "authenticated";
  if (mode === "missing") { value.installation = { state: "not-installed", integrity: "not-installed", skillCount: 0, mcpCount: 0, pendingDisable: false }; value.authentication = "unobserved"; }
  if (mode === "disabled") value.installation.state = "disabled";
  return value;
};
scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://fixture.local"), route = url.pathname;
  if (route === "/__api/plugins/codex-security-status") {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method !== "POST" || !body || Object.keys(body).length !== 2 || !Object.hasOwn(body, "installationId") || !Object.hasOwn(body, "agentId")) throw Error("strict status-only HTTP contract");
    calls.push({ route, body });
    if (mode === "error") return Response.json({ error: "Status unavailable" }, { status: 503 });
    if (mode === "delayed") await new Promise<void>(resolve => delayed.push(resolve));
    return Response.json(responseFor());
  }
  if (route === "/__api/plugins/bundled") return Response.json({ batchDigest: "9".repeat(64), items: [{
    id: "codex-security", installationId: "7".repeat(64), displayName: "Codex Security",
    shortDescription: "Find and fix vulnerabilities", category: "Developer Tools", version: "0.1.24", iconAvailable: false,
    components: { skills: 15, allSkillFiles: 15, apps: 3, mcp: 1 }, converted: { skills: 15, mcp: 0 },
    unconvertedMcp: [{ name: "codex-security", reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }], importStatus: "previewable",
    installationState: mode === "missing" ? "not-installed" : mode === "disabled" ? "disabled" : "enabled",
    installedReleaseDigest: mode === "missing" ? null : "a".repeat(64),
  }] });
  if (route === "/__api/plugins/bundled/codex-security") return Response.json({ detail: {
    id: "codex-security", displayName: "Codex Security", shortDescription: "Find and fix vulnerabilities",
    longDescription: "Find and fix vulnerabilities in your projects with Codex Security.", category: "Developer Tools",
    version: "0.1.24", developerName: "OpenAI", websiteURL: "https://openai.com", license: "Proprietary", iconAvailable: false,
    components: { skills: 15, allSkillFiles: 15, apps: 3, mcp: 1 }, converted: { skills: 15, mcp: 0 },
    unconvertedMcp: [{ name: "codex-security", reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }], importStatus: "previewable",
    prompts: [], skills: [{ name: "codex-security", description: "Security workflow instructions" }], mcpServers: [],
    apps: ["codex-security"], connectionWarnings: [], sourceWarnings: [],
  } });
  return originalFetch(input, init);
};
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 6_000;
  while (!predicate()) { if (performance.now() >= deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const detail = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const panel = () => document.querySelector<HTMLElement>("#codex-security-status-title")?.closest("section");
const refresh = () => [...(panel()?.querySelectorAll<HTMLButtonElement>("button") || [])].find(button => button.textContent === "重新检查状态");

scope.runCodexSecurityDetail = async (scenario: string, theme: string) => {
  mode = scenario;
  document.documentElement.dataset.theme = theme;
  const oldOpener = document.querySelector('[aria-label="查看 Codex Security 详情"]');
  scope.remountPlugins();
  if (oldOpener) await wait(() => !oldOpener.isConnected, "previous page unmounted");
  await new Promise(resolve => setTimeout(resolve, 40));
  await wait(() => !!document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Shoggoth"]'), "Shoggoth tab");
  document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Shoggoth"]')!.click();
  const available = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "可安装");
  await wait(() => !!available(), "bundled tab"); available()!.click();
  await wait(() => !!document.querySelector('[aria-label="查看 Codex Security 详情"]'), "Codex card");
  const opener = document.querySelector<HTMLButtonElement>('[aria-label="查看 Codex Security 详情"]')!;
  opener.click();
  await wait(() => !!panel(), "status section in production detail");
  if (scenario === "delayed") {
    await wait(() => panel()?.textContent?.includes("正在核对本地安装"), "loading state");
    detail()!.querySelector<HTMLButtonElement>('[aria-label="关闭插件详情"]')!.click();
    for (const resolve of delayed.splice(0)) resolve();
    await new Promise(resolve => setTimeout(resolve, 80));
    check(!detail() && !panel(), "late status cannot reopen closed detail");
    check(document.activeElement === opener, "close restores card focus");
    return { scenario, lateResponseFenced: true, focusRestored: true };
  }
  if (scenario === "error") {
    await wait(() => !!panel()?.querySelector('[role="alert"]'), "status error");
    check(refresh() && !refresh()!.disabled, "error permits only status retry");
    mode = "unauthenticated"; refresh()!.click();
  }
  const accountText = scenario === "authenticated" ? "已检测到本机登录" : scenario === "missing" ? "尚未检测到受管 Codex 账号" : "账号未连接";
  await wait(() => calls.some(call => call.body.agentId !== null)
    && panel()?.textContent?.includes(accountText), "final native candidate status");
  await new Promise(resolve => setTimeout(resolve, 80));
  await wait(() => panel()?.textContent?.includes(accountText), "sanitized account status settled");
  const text = panel()!.textContent!;
  check(text.includes("完整扫描") && text.includes("尚未启用") && text.includes("当前不能使用完整扫描工具"), "never presents scanner as ready");
  check(text.includes(scenario === "missing" ? "尚未安装" : scenario === "disabled" ? "当前已停用" : "本地安装文件已核对"), "actual installation state");
  check(!/READY|启用扫描|开始扫描|thread\/|turn\/|runtimeAccountId|fixture-agent|runtimeProfileId|principalIdentity/u.test(text), "no scanner action or account/Run identity");
  if (scenario !== "missing") check(text.includes("15 个技能、0 个 MCP 组件"), "partial install remains explicit");
  check(calls.length > 0 && calls.every(call => Object.keys(call.body).length === 2), "only sanitized status requests");
  refresh()!.focus();
  check(document.activeElement === refresh(), "status retry is keyboard focusable");
  const d = detail()!, bounds = d.getBoundingClientRect(), scroll = d.querySelector<HTMLElement>('[class*="scroll"]')!;
  const footer = d.querySelector("footer")!.getBoundingClientRect();
  check(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, "dialog fits viewport");
  check(scroll.scrollWidth <= scroll.clientWidth + 1 && footer.bottom <= bounds.bottom + 1, "scroll and footer fit");
  scroll.scrollTop = Math.max(0, panel()!.offsetTop - 150);
  return { scenario, width: innerWidth, theme, account: accountText, scanEnabled: false,
    horizontalOverflow: false, keyboardFocusable: true, sourceFiles: 124,
    statusCalls: calls.length, retryRecovered: scenario === "error" };
};
