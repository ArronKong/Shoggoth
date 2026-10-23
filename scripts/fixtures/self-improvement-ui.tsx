import { createRoot } from "react-dom/client";
import SelfImprovementPanel from "../../app/manage-ui/src/pages/SelfImprovementPanel";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any, agentId = new URLSearchParams(location.search).get("agent")!;
applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider><main className="page management-page" style={{ maxWidth: 1080, margin: "auto", padding: 24 }}>
  <h1>Skills · 自动学习验收</h1><p className="muted">独立测试 Agent · 实际组件、Service 与 REST · 模型回复使用本地夹具</p>
  <SelfImprovementPanel backend="shoggoth" agentId={agentId} />
</main></UiProvider>);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => unknown, label: string) => {
  const until = performance.now() + 10000;
  while (!predicate()) { if (performance.now() > until) throw Error(label + "\n" + document.body.innerText); await pause(20); }
};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text && !item.disabled);
const click = async (text: string) => { await wait(() => button(text), "button: " + text); button(text)!.click(); await pause(60); };
const api = async (action: string, input = {}) => {
  const response = await fetch("/__api/skills/learning", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "shoggoth", agentId, action, input }) });
  if (!response.ok) throw Error(await response.text()); return (await response.json()).result;
};
const check = (value: unknown, text: string) => { if (!value) throw Error(text); };
scope.learningAcceptance = async (stage: string) => {
  if (stage === "settings") {
    await click("学习设置"); await wait(() => document.querySelector('[role="combobox"]'), "mode control");
    check((await api("status")).settings.config.mode === "off", "fresh profile is dormant");
    (document.querySelector('[role="combobox"]') as HTMLElement).click();
    await wait(() => document.querySelector('[role="option"]'), "mode options");
    ([...document.querySelectorAll('[role="option"]')].find(item => item.textContent?.includes("仅生成建议")) as HTMLElement).click();
    await click("保存设置"); await wait(() => document.querySelector('[role="alertdialog"], [role="dialog"]'), "activation disclosure");
    check((await api("status")).settings.config.mode === "off", "no activation before confirmation");
    check(document.body.innerText.includes("额外模型用量"), "visible evidence and cost disclosure");
    await click("确认开启"); await wait(() => button("复盘最近完成任务"), "saved settings");
    const status = await api("status"); check(status.settings.config.mode === "review", "review mode saved");
    check(document.body.innerText.includes("单次复盘输入预算") && !document.body.innerText.includes("每日最多复盘次数"), "single-review budget replaces daily quotas");
    check(status.settings.config.maxInputTokens === null && status.capability.maxIterations === 16
      && status.capability.maxInputTokens === 120000, "automatic fallback and sixteen iterations are visible");
    check(status.capability.followsAgentDefault && status.capability.model === "fixture-model", "own Agent default model");
    return { consent: true, mode: status.settings.config.mode, model: status.capability.model };
  }
  if (stage === "proposal") {
    await click("复盘最近完成任务");
    await wait(() => button("刷新"), "request finished");
    const advanced = await fetch("/__fixture/advance", { method: "POST" }); check(advanced.ok, "isolated clock advance");
    await click("刷新"); await click("复盘历史"); await click("查看提案");
    await wait(() => document.querySelector('[aria-label="学习提案详情"]'), "proposal body");
    check(document.body.innerText.includes("检查产物内容和时间"), "reviewable procedure");
    check((await api("skills")).items.length === 0, "review does not publish");
    return { pendingReview: true };
  }
  if (stage === "published") {
    await click("接受并保存"); await click("学到的技能");
    await wait(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some(item => item.textContent?.includes("核对构建配置与产物") && !item.disabled), "saved skill card");
    ([...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("核对构建配置与产物"))!).click();
    await wait(() => document.querySelector('[aria-label="学习技能详情"]'), "skill details");
    check(document.body.innerText.includes("来源任务"), "source provenance available");
    check((await api("skills")).items.length === 1, "one publication"); return { published: 1 };
  }
  if (stage === "edited") {
    await click("编辑正文"); const editor = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "人工整理：先核对配置，再构建并验证产物。\n保留失败和最终验证记录。");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await click("保存并转为用户管理");
    await wait(() => document.body.innerText.includes("用户管理"), "user ownership");
    ([...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("核对构建配置与产物"))!).click();
    await wait(() => document.body.innerText.includes("上一版本"), "before/after versions");
    const skill = (await api("skills")).items[0]; check(skill.owner === "user" && skill.revision === 2, "manual edit ownership and revision");
    return { owner: skill.owner, revision: skill.revision };
  }
  if (stage === "narrow") {
    check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal viewport overflow");
    check(document.querySelector('[aria-label="学习技能详情"]'), "detail survives resize");
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  }
  if (stage === "withdrawn") {
    const status = await api("status"), skill = (await api("skills")).items[0];
    await api("configure", { expectedRevision: status.settings.revision, patch: { mode: "off" } });
    const lateRead = new URLSearchParams(location.search).has("lateRead");
    const originalFetch = window.fetch.bind(window);
    let captured = false, release: (() => void) | undefined;
    try {
      if (lateRead) {
        await click("关闭详情");
        window.fetch = async (input, init) => {
          const response = await originalFetch(input, init);
          if (!captured && String(input).includes("/__api/skills/learning") && JSON.parse(String(init?.body)).action === "read") {
            captured = true; await new Promise<void>(resolve => { release = resolve; });
          }
          return response;
        };
        ([...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("核对构建配置与产物"))!).click();
        await wait(() => captured, "pre-withdrawal read is held in flight");
      } else {
        check(document.querySelector('[aria-label="学习技能详情"]'), "old detail is open before withdrawal");
        check(document.body.innerText.includes("上一版本"), "old comparison is open before withdrawal");
        await click("编辑正文");
        check(document.querySelector("textarea"), "old edit draft is present before withdrawal");
      }
      const forgotten = await originalFetch("/__fixture/forget", { method: "POST" });
      check(forgotten.ok, "real isolated source withdrawal");
      if (lateRead) {
        // The REST test separately verifies actual Service notification delivery.
        window.dispatchEvent(new CustomEvent("shoggoth:skills-changed", { detail: { backendId: "shoggoth", agentId, change: "withdraw" } }));
        release!();
      } else await click("刷新");
      await wait(() => !document.querySelector('[aria-label="学习技能详情"], [aria-label="学习提案详情"], textarea'), "withdrawn detail, comparison and edit draft disappear");
      await wait(() => button("刷新"), "in-flight read or refresh completed");
      check(!document.body.innerText.includes("人工整理：") && !document.body.innerText.includes("检查产物内容和时间"), "no stale body or late response restored");
      const response = await originalFetch("/__api/skills/learning", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "shoggoth", agentId, action: "read", input: { skillId: skill.id } }) });
      check(response.status === 422 && (await response.json()).code === "LEARNING_VERSION_UNAVAILABLE", "withdrawn version is denied by Service");
      check((await api("status")).settings.config.mode === "off", "background learning stays off");
      await click("复盘历史"); await wait(() => document.body.innerText.includes("来源已撤回"), "withdrawal history visible");
      return { withdrawn: true, lateRead, cachedBodyCleared: true, learningOff: true };
    } finally { release?.(); window.fetch = originalFetch; }
  }
  throw Error("unknown acceptance stage");
};
