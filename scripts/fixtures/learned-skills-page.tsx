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
const detail = () => document.querySelector<HTMLElement>('[role="dialog"] [aria-label="学习技能详情"]');
const api = async (action: string, input = {}) => {
  const response = await fetch("/__api/skills/learning", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: "shoggoth", agentId, action, input }) });
  if (!response.ok) throw Error(await response.text()); return (await response.json()).result;
};
scope.learnedSkillsAcceptance = async (stage: string) => {
  if (stage === "catalog") {
    await wait(() => cards().length === 3 && learned(), "three unified cards");
    const catalog = await (await fetch("/__api/skills?backend=shoggoth&paged=1&limit=100")).json();
    check(new Set(catalog.page.skills.map((skill: { agentId: string }) => skill.agentId)).size === 2,
      "second Agent skills share the same list");
    check(document.body.innerText.includes("3 个已装 · 启用 1 个 · AI 助理用过 1 个"), "unified totals");
    check(cards().every(card => !card.querySelector(".skill-badge, .skill-card-tags")), "cards only show names and descriptions");
    check(getComputedStyle(learned()).borderTopWidth === "0px", "skill card backgrounds have no border");
    const label = learned().querySelector<HTMLElement>(".skill-name")!;
    check(label.scrollWidth <= label.clientWidth + 1, "metadata badges do not squeeze the visible title");
    const opener = learned().querySelector<HTMLButtonElement>(".skill-card-open")!; opener.click();
    await wait(() => detail()?.querySelector('[aria-label="当前版本内容"] .chat-md h2'), "main card opens rendered current content");
    const documentBody = detail()!.querySelector<HTMLElement>('[aria-label="当前版本内容"]')!;
    check(documentBody.querySelectorAll('ol li').length === 3, "Markdown steps render as an ordered list");
    check(!documentBody.querySelector('h1'), "the skill title is not repeated inside the document");
    check(!documentBody.querySelector('pre'), "the skill body is not displayed as raw source");
    check(!detail()!.innerText.includes("上一版本"), "details do not compare an ancestor version");
    check(!document.querySelector('[aria-label="自动学习"]'), "automatic learning card remains hidden");
    const provenance = detail()!.querySelector<HTMLDetailsElement>('details')!;
    check(!provenance.open, "secondary skill information starts collapsed");
    provenance.querySelector('summary')!.click();
    check(detail()?.innerText.includes("来源任务") && detail()?.innerText.includes("最近 10 个版本"), "provenance and version history remain available");
    check((await api("skills")).items[0].usage.reads === 1, "UI inspection does not add an Agent read");
    document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!.click();
    await wait(() => !document.querySelector('[role="dialog"]'), "close learned detail");
    check(document.activeElement === opener, "close restores main-card focus");
    check(!document.querySelector('input[type="search"]'), "search is hidden");
    check(!document.querySelector('.ui-toolbar [role="combobox"]'), "Agent filter is hidden");
    check(![...document.querySelectorAll(".ui-toolbar button")].some(item => item.textContent?.includes("安装")), "installation is hidden");
    check(![...document.querySelectorAll('.ui-toolbar [role="tab"]')]
      .some(tab => ["全部", "已启用", "已停用"].includes(tab.textContent?.trim() || "")), "status filters are removed");
    return { total: 3, enabled: 1, used: 1, hiddenControls: true, detail: true };
  }
  if (stage === "archive") {
    learned().querySelector<HTMLElement>('[role="switch"]')!.click();
    await wait(() => learned()?.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false", "archive via main toggle");
    check(document.body.innerText.includes("3 个已装 · 启用 0 个 · AI 助理用过 1 个"), "archive updates totals");
    check((await api("skills")).items[0].archived, "existing archive contract is persisted");
    check(cards().length === 3, "archiving keeps the skill in the unfiltered catalog");
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
    const popup = document.querySelector<HTMLElement>('[role="dialog"]')!.getBoundingClientRect();
    check(popup.left >= 0 && popup.right <= innerWidth + 1, "the modal stays within the narrow viewport");
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
