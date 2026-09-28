import React from "react";
import { createRoot } from "react-dom/client";
import SkillsPage from "../../app/manage-ui/src/pages/SkillsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { FALLBACK_BACKEND_DESCRIPTORS } from "../../app/manage-ui/src/lib/backends";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// This fixture renders the production page and CSS in Chromium. Only its REST
// boundary is replaced, so page geometry, focus, and scrolling stay real.
const scope = window as typeof window & {
  skillsScaleErrors: string[];
  skillsScaleRequests: Array<{ page: number; query: string; status: string }>;
  runSkillsScalePage: (width: number) => Promise<Record<string, unknown>>;
  showSkillsScaleDetail: () => Promise<{ top: number; bottom: number; cardCount: number }>;
  runStandaloneMcpRepair: (width: number) => Promise<Record<string, unknown>>;
  showStandaloneMcpConfirmation: () => Promise<Record<string, unknown>>;
  finishStandaloneMcpRepair: () => Promise<Record<string, unknown>>;
};
scope.skillsScaleErrors = [];
scope.skillsScaleRequests = [];
window.addEventListener("error", (event) => scope.skillsScaleErrors.push(event.message));
window.addEventListener("unhandledrejection", (event) => scope.skillsScaleErrors.push(String(event.reason)));

const skills = Array.from({ length: 5_000 }, (_, index) => {
  const name = `scale-${String(index).padStart(4, "0")}`;
  return { backendId: "shoggoth", agentId: "fixture-agent", id: name, name, version: "1.0.0",
    source: "user", description: `Skill number ${index} for rendered catalog paging`,
    enabled: true, profileRevision: 1, registryVersion: 1, usageCount: 0, usageAgents: {} };
});
const pageSize = 60;
const revision = "fixture-revision-1";
let showDisabledMcp = false;
let mcpRevision = 1;
const mcpRequests: Array<{ action: string; body: Record<string, unknown> }> = [];
const answer = (value: unknown, status = 200) => Response.json(value, { status });
scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://fixture.invalid");
  if (url.pathname === "/__api/backends") return answer({ backends: FALLBACK_BACKEND_DESCRIPTORS });
  if (url.pathname === "/__api/config") return answer({ config: { disabledBackends: [] } });
  if (url.pathname === "/__api/agents") return answer({ agents: [{ id: "fixture-agent", name: "Fixture Agent" }] });
  if (url.pathname === "/__api/skills/usage") return answer({ backends: [] });
  if (url.pathname === "/__api/mcp/standalone") {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      mcpRequests.push({ action: String(body.action), body });
      if (body.action === "rebind") {
        mcpRevision += 1;
        return answer({ result: { revision: mcpRevision, id: "restore-me", enabled: false,
          activationToken: "00000000-0000-4000-8000-000000000001" } });
      }
      if (body.action === "activate") {
        mcpRevision += 1;
        showDisabledMcp = false;
        return answer({ result: { revision: mcpRevision, id: "restore-me", enabled: true, toolCount: 1 } });
      }
      throw Error(`Unexpected MCP action ${body.action}`);
    }
    return answer({ page: {
      revision: mcpRevision, totalDisabled: showDisabledMcp ? 1 : 0,
      items: showDisabledMcp ? [{ id: "restore-me", name: "Restored MCP",
        commandLabel: "old-server", cwdLabel: "old-workspace", argCount: 2, updatedAt: 1 }] : [],
      nextCursor: showDisabledMcp ? 1 : 0, hasMore: false,
    } });
  }
  if (url.pathname === "/__api/skills/preview") return answer({ preview: { content: "Fixture instructions" } });
  if (url.pathname === "/__api/skills" && url.searchParams.get("paged") !== "1") return answer({ skills: [] });
  if (url.pathname === "/__api/skills" && url.searchParams.get("paged") === "1") {
    const page = Number(url.searchParams.get("page")), query = url.searchParams.get("query") || "";
    const status = url.searchParams.get("status") || "";
    scope.skillsScaleRequests.push({ page, query, status });
    if (page > 0 && url.searchParams.get("revision") !== revision) {
      return answer({ error: "stale", code: "SKILL_PAGE_STALE" }, 409);
    }
    const matched = skills.filter((skill) => (!query || skill.name.includes(query) || skill.description.includes(query))
      && (!status || status === "on"));
    return answer({ page: { supported: true, skills: matched.slice(page * pageSize, (page + 1) * pageSize),
      registryRevision: "a".repeat(64), registryVersion: 1, profileRevision: 1,
      queryRevision: revision, pageIndex: page, pageCount: Math.max(1, Math.ceil(matched.length / pageSize)),
      total: skills.length, enabledCount: skills.length, usedCount: 0, usageSupported: true,
      matchCount: matched.length } });
  }
  throw Error(`Unexpected Skills scale fixture request ${url.pathname}`);
};

await applyConfiguredLocale("en");
createRoot(document.getElementById("root")!).render(
  <UiProvider><main className="content" style={{ height: "100vh" }}><SkillsPage /></main></UiProvider>,
);

const wait = async (test: () => boolean, label: string) => {
  const deadline = performance.now() + 10_000;
  while (!test()) {
    if (performance.now() > deadline) throw Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const main = () => document.querySelector<HTMLElement>(".skill-main-content")!;
const skillPage = () => document.querySelector<HTMLElement>(".skills-page")!;
const content = () => document.querySelector<HTMLElement>("main.content")!;
const cardNames = () => [...document.querySelectorAll<HTMLElement>(".skill-card")].map((card) => card.title);
const expectedName = (index: number) => `scale-${String(index).padStart(4, "0")}`;
const checked = (value: unknown, message: string) => { if (!value) throw Error(message); };
const firstCard = () => document.querySelector<HTMLButtonElement>(".skill-card-open")!;
const pageButtons = () => document.querySelectorAll<HTMLButtonElement>(".skill-pagination button");

scope.runSkillsScalePage = async (width: number) => {
  await wait(() => !!document.querySelector<HTMLElement>('[role="tab"][aria-label="Shoggoth"]'), "native backend tab");
  document.querySelector<HTMLElement>('[role="tab"][aria-label="Shoggoth"]')!.click();
  await wait(() => cardNames().length === pageSize && cardNames()[0] === expectedName(0), "first native page");
  await frame();
  firstCard().click();
  await wait(() => !!document.querySelector(".skill-detail"), "first card detail");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const detail = document.querySelector<HTMLElement>(".skill-detail")!;
  const detailRect = detail.getBoundingClientRect();
  const viewportHeight = document.documentElement.clientHeight;
  checked(detailRect.top >= 0 && detailRect.top < viewportHeight,
    `first card detail outside viewport at ${width}px: ${JSON.stringify({ top: detailRect.top, bottom: detailRect.bottom, viewportHeight })}`);
  const closeRect = detail.querySelector<HTMLButtonElement>(".skill-detail-x")!.getBoundingClientRect();
  checked(closeRect.top >= 0 && closeRect.bottom <= viewportHeight, "detail close control is outside viewport");
  checked(document.documentElement.scrollWidth <= width + 1, `detail overflows horizontally at ${width}px`);
  detail.querySelector<HTMLButtonElement>(".skill-detail-x")!.click();
  await wait(() => !document.querySelector(".skill-detail"), "detail close");
  await frame();
  checked(document.activeElement === firstCard(), "closing detail must restore opener focus");
  const pageCount = Math.ceil(skills.length / pageSize);
  const perPage: Array<{ page: number; cards: number; first: string; last: string; scrollOwner: string }> = [];
  for (let page = 0; page < pageCount; page += 1) {
    const names = cardNames();
    const expectedLength = Math.min(pageSize, skills.length - page * pageSize);
    checked(names.length === expectedLength, `page ${page} mounted ${names.length} cards, expected ${expectedLength}`);
    checked(names[0] === expectedName(page * pageSize), `page ${page} first card mismatch`);
    checked(names.at(-1) === expectedName(page * pageSize + expectedLength - 1), `page ${page} last card mismatch`);
    checked(document.documentElement.scrollWidth <= width + 1, `page ${page} document overflows horizontally`);
    const scrollOwner = main().scrollHeight > main().clientHeight + 1 ? "grid"
      : skillPage().scrollHeight > skillPage().clientHeight + 1 ? "page" : "content";
    const scroller = scrollOwner === "grid" ? main() : scrollOwner === "page" ? skillPage() : content();
    scroller.scrollTop = scroller.scrollHeight;
    await frame();
    checked(scroller.scrollTop > 0, `page ${page} cannot scroll to bottom: ${JSON.stringify({ scrollOwner,
      grid: [main().clientHeight, main().scrollHeight], page: [skillPage().clientHeight, skillPage().scrollHeight],
      content: [content().clientHeight, content().scrollHeight],
      body: [document.body.clientHeight, document.body.scrollHeight], document: [document.documentElement.clientHeight, document.documentElement.scrollHeight] })}`);
    const nav = document.querySelector<HTMLElement>(".skill-pagination")!;
    const navRect = nav.getBoundingClientRect(), scrollerRect = scroller.getBoundingClientRect();
    checked(navRect.bottom <= scrollerRect.bottom + 1 && navRect.top >= scrollerRect.top - 1,
      `page ${page} navigation not visible after scroll`);
    perPage.push({ page, cards: names.length, first: names[0], last: names.at(-1)!, scrollOwner });
    if (page === pageCount - 1) break;
    pageButtons()[1].click();
    await wait(() => cardNames()[0] === expectedName((page + 1) * pageSize), `page ${page + 1}`);
    await frame();
    checked(document.activeElement === firstCard(), `page ${page + 1} first card did not receive focus`);
    const focusRect = firstCard().getBoundingClientRect(), visibleRect = scroller.getBoundingClientRect();
    checked(focusRect.top >= visibleRect.top - 1 && focusRect.top < visibleRect.bottom,
      `page ${page + 1} focused first card outside visible area`);
  }
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  input.focus();
  // Use the native setter so React's value tracker observes a real edit.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "scale-4999");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "scale-4999", inputType: "insertText" }));
  await wait(() => cardNames().length === 1 && cardNames()[0] === "scale-4999", "tail search");
  checked(document.activeElement === input, "search must retain keyboard focus");
  checked(scope.skillsScaleRequests.some((request) => request.query === "scale-4999" && request.page === 0),
    "search must query server from first page");
  checked(scope.skillsScaleErrors.length === 0, `renderer errors: ${scope.skillsScaleErrors.join(" | ")}`);
  return { width, total: skills.length, pageCount, pagesChecked: perPage.length,
    scrollOwner: perPage[0].scrollOwner, maxMountedCards: Math.max(...perPage.map((entry) => entry.cards)),
    firstDetailTop: Math.round(detailRect.top), firstDetailHeight: Math.round(detailRect.height),
    firstPage: perPage[0], finalPage: perPage.at(-1), tailSearch: cardNames(),
    requests: scope.skillsScaleRequests.length, errors: scope.skillsScaleErrors };
};

scope.showSkillsScaleDetail = async () => {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  await wait(() => cardNames().length === pageSize && cardNames()[0] === "scale-0000", "full first page for detail capture");
  firstCard().click();
  await wait(() => !!document.querySelector(".skill-detail"), "detail capture");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rect = document.querySelector<HTMLElement>(".skill-detail")!.getBoundingClientRect();
  checked(rect.top >= 0 && rect.top < document.documentElement.clientHeight, "captured detail heading is invisible");
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), cardCount: cardNames().length };
};

scope.runStandaloneMcpRepair = async (width: number) => {
  document.querySelector<HTMLButtonElement>(".skill-detail-x")?.click();
  showDisabledMcp = true;
  const shoggothTab = document.querySelector<HTMLElement>('[role="tab"][aria-label="Shoggoth"]')!;
  const otherTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab !== shoggothTab)!;
  checked(Boolean(otherTab), "missing secondary backend tab for MCP remount");
  otherTab.click();
  await frame();
  shoggothTab.click();
  await wait(() => !!document.querySelector(".standalone-mcp-item"), "disabled standalone MCP");
  const repair = document.querySelector<HTMLElement>(".standalone-mcp-repair")!;
  checked(!repair.textContent?.includes("/old/"), "old absolute path leaked into rendered UI");
  repair.querySelector<HTMLButtonElement>(".standalone-mcp-item")!.click();
  await wait(() => !!repair.querySelector(".standalone-mcp-editor"), "MCP editor");
  const inputs = repair.querySelectorAll<HTMLInputElement>(".standalone-mcp-fields input");
  const args = repair.querySelector<HTMLTextAreaElement>(".standalone-mcp-fields textarea")!;
  checked(inputs.length === 2 && inputs[0].value === "" && inputs[1].value === "" && args.value === "",
    "old launch inputs were prefilled");
  const change = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  };
  change(inputs[0], "/Users/test/new-server");
  change(inputs[1], "/Users/test/new-workspace");
  change(args, '["--new"]');
  await frame();
  const save = [...repair.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Save and keep disabled"))!;
  checked(!save.disabled, "rebind did not accept explicit new paths and args");
  save.click();
  await wait(() => mcpRequests.length === 1 && !!repair.querySelector(".standalone-mcp-actions .btn-primary"),
    "disabled rebind pending activation");
  await frame();
  const activate = repair.querySelector<HTMLButtonElement>(".standalone-mcp-actions .btn-primary")!;
  const actionRect = activate.getBoundingClientRect(), panelRect = repair.getBoundingClientRect();
  checked(actionRect.top >= panelRect.top && actionRect.bottom <= panelRect.bottom,
    "verify-and-enable action is hidden outside the repair panel after saving");
  checked(document.activeElement === activate, "verify-and-enable action did not receive focus");
  checked(mcpRequests[0].action === "rebind", "MCP was activated during rebind");
  checked(mcpRequests[0].body.command === "/Users/test/new-server"
    && mcpRequests[0].body.cwd === "/Users/test/new-workspace"
    && JSON.stringify(mcpRequests[0].body.args) === '["--new"]', "rebind payload differs from explicit inputs");
  checked(document.documentElement.scrollWidth <= width + 1, "MCP repair overflows horizontally");
  return { width, disabledVisible: true, oldValuesPrefilled: false, callsBeforeActivation: mcpRequests.length,
    actionVisible: true, rebindPayload: mcpRequests[0].body };
};

scope.showStandaloneMcpConfirmation = async () => {
  const activate = document.querySelector<HTMLButtonElement>(
    ".standalone-mcp-repair .standalone-mcp-actions .btn-primary")!;
  activate.click();
  await wait(() => !!document.querySelector<HTMLElement>('[role="alertdialog"]'), "MCP activation confirmation");
  checked(mcpRequests.length === 1, "MCP activation ran before confirmation");
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  checked(dialog.textContent?.includes("Verify and enable standalone MCP"), "activation confirmation is unclear");
  await new Promise((resolve) => setTimeout(resolve, 180));
  const rect = dialog.getBoundingClientRect();
  checked(rect.top >= 0 && rect.bottom <= document.documentElement.clientHeight,
    "activation confirmation dialog is outside viewport");
  return { confirmationRequired: true, dialogVisible: true };
};

scope.finishStandaloneMcpRepair = async () => {
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  dialog.querySelector<HTMLButtonElement>(".btn-primary")!.click();
  await wait(() => mcpRequests.length === 2 && !document.querySelector(".standalone-mcp-item"),
    "confirmed MCP activation");
  checked(mcpRequests[1].action === "activate"
    && mcpRequests[1].body.expectedRevision === 2
    && mcpRequests[1].body.activationToken === "00000000-0000-4000-8000-000000000001",
  "activation did not use exact rebind revision and token");
  return { activationCalls: mcpRequests.length, revisionPinned: true };
};
