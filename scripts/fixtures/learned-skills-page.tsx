import { createRoot } from "react-dom/client";
import SkillsPage from "../../app/manage-ui/src/pages/SkillsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
const query = new URLSearchParams(location.search), agentId = query.get("agent")!;
const title = "核对构建配置与产物";
await applyConfiguredLocale("zh-CN");
createRoot(document.getElementById("root")!).render(<UiProvider>
  <main className="content" style={{ height: "100vh" }}><SkillsPage /></main>
</UiProvider>);
const wait = async (predicate: () => unknown, label: string) => {
  const until = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > until) throw Error(label + "\n" + document.body.innerText);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const cards = () => [...document.querySelectorAll<HTMLElement>(".skill-card")];
const learned = () => cards().find(card => card.title === title)!;
const detail = () => document.querySelector<HTMLElement>('[aria-label="学习技能详情"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find(item => item.textContent?.trim() === text && !item.disabled)!;
const filter = async (text: string, count: number) => {
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(item => item.textContent === text)!.click();
  await wait(() => cards().length === count, "filter " + text);
};
const search = async (text: string, count: number) => {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  await wait(() => cards().length === count, "search " + text);
};
const api = async (action: string, input = {}) => {
  const response = await fetch("/__api/skills/learning", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "shoggoth", agentId, action, input }) });
  if (!response.ok) throw Error(await response.text()); return (await response.json()).result;
};
scope.learnedSkillsAcceptance = async (stage: string) => {
  if (stage === "catalog") {
    await wait(() => cards().length === 3 && learned(), "three unified cards");
    check(document.body.innerText.includes("3 个已装 · 启用 1 个 · AI 助理用过 1 个"), "unified totals");
    check(learned().innerText.includes("自动学习") && learned().querySelector(".skill-badge-used")?.textContent?.trim() === "1 次", "source and actual usage badge");
    const label = learned().querySelector<HTMLElement>(".skill-name")!;
    check(label.scrollWidth <= label.clientWidth + 1, "metadata badges do not squeeze the visible title");
    const opener = learned().querySelector<HTMLButtonElement>(".skill-card-open")!; opener.click();
    await wait(() => detail()?.innerText.includes("方法正文"), "main card opens learned details");
    check(!document.querySelector("aside.skill-detail"), "learned card uses its version-aware detail");
    check(detail()?.innerText.includes("来源任务") && detail()?.innerText.includes("最近 10 个版本"), "provenance and version history");
    check((await api("skills")).items[0].usage.reads === 1, "UI inspection does not add an Agent read");
    button("关闭详情").click(); await wait(() => !detail(), "close learned detail");
    check(document.activeElement === opener, "close restores main-card focus");
    await search(title, 1); check(learned(), "title search"); await search("", 3);
    await filter("已启用", 1); check(learned(), "active learned skill is enabled");
    await filter("已停用", 2); check(!learned(), "disabled filter contains only ordinary skills");
    await filter("全部", 3);
    return { total: 3, enabled: 1, used: 1, titleSearch: true, detail: true };
  }
  if (stage === "archive") {
    learned().querySelector<HTMLElement>('[role="switch"]')!.click();
    await wait(() => learned()?.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false", "archive via main toggle");
    check(document.body.innerText.includes("3 个已装 · 启用 0 个 · AI 助理用过 1 个"), "archive updates totals");
    check((await api("skills")).items[0].archived, "existing archive contract is persisted");
    await filter("已停用", 3); await filter("全部", 3);
    learned().querySelector<HTMLElement>('[role="switch"]')!.click();
    await wait(() => learned()?.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true", "restore via main toggle");
    check((await api("status")).settings.config.mode === "auto", "skill toggle preserves learning settings");
    return { archivedAndRestored: true };
  }
  if (stage === "narrow") {
    check(document.documentElement.scrollWidth <= innerWidth + 1, "no horizontal overflow");
    learned().querySelector<HTMLButtonElement>(".skill-card-open")!.click();
    await wait(() => detail(), "narrow learned detail");
    check(document.documentElement.scrollWidth <= innerWidth + 1, "detail fits narrow viewport");
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  }
  if (stage === "withdrawn") {
    const response = await fetch("/__fixture/forget", { method: "POST" }); check(response.ok, "source withdrawal");
    window.dispatchEvent(new CustomEvent("shoggoth:skills-changed", { detail: { backendId: "shoggoth", agentId } }));
    await wait(() => cards().length === 2 && !detail(), "withdrawn skill and preview disappear");
    check(document.body.innerText.includes("2 个已装 · 启用 0 个 · AI 助理用过 0 个"), "withdrawal clears counts");
    return { withdrawn: true, staleDetailCleared: true };
  }
  throw Error("unknown stage " + stage);
};
