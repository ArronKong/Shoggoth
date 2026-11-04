import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import McpConnectorIcon from "../../app/manage-ui/src/components/McpConnectorIcon";
import { mcpRecommendationOrder } from "../../app/manage-ui/src/lib/mcpRecommendationCatalog";
import sources from "../../app/manage-ui/src/assets/mcp-logos/sources.json";

const state = window as any;
const ids = [...new Set([...mcpRecommendationOrder, ...sources.assets.map(asset => asset.id)])];
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const wait = async (predicate: () => unknown, message: string) => {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function Fixture() {
  const [open, setOpen] = useState(false);
  state.showCatalog = (value: boolean) => flushSync(() => setOpen(value));
  return <main>
    <h1>连接器图标加载回归</h1>
    <p>真实组件与内置图标；本地模拟请求占用连接，不访问账号或连接器。</p>
    <button onClick={() => void state.runFixture().then((value: unknown) => { state.result = value; }, (error: Error) => { state.error = error.message; })}>运行检查</button>
    {open && <div className="catalog">{ids.map(id => <div className="item" key={id}><McpConnectorIcon name={id} identity={id} /><span>{id}</span></div>)}
      <div className="item" id="custom"><McpConnectorIcon name="GitHub" identity="untrusted-custom-server" /><span>自定义服务</span></div>
    </div>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const images = () => [...document.querySelectorAll<HTMLImageElement>("[data-bundled-icon] img")];
const visibleImages = () => images().filter(img => img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === "1");
state.runFixture = async () => {
  await wait(() => state.showCatalog, "fixture did not mount");
  const pending = Array.from({ length: 6 }, (_, index) => fetch(`/slow/${index}`));
  await wait(() => state.heldRequests === 6, "six local requests did not occupy the connection pool");
  const phases: Record<string, unknown>[] = [];
  try {
    for (const phase of ["cold", "reopen", "dark", ...(state.goOffline ? ["offline"] : [])]) {
      state.showCatalog(false);
      document.documentElement.dataset.theme = phase === "dark" ? "dark" : "light";
      const started = performance.now();
      state.showCatalog(true);
      check(images().every(img => img.style.opacity === "1"), `${phase}: bundled icons wait for a load callback before becoming visible`);
      await wait(() => visibleImages().length === ids.length, `${phase}: only ${visibleImages().length}/${ids.length} bundled icons loaded while API requests were pending`);
      check(images().every(img => img.src.startsWith("data:image/png;base64,")), "bundled icons still require separate requests");
      check(images().every(img => img.loading !== "lazy"), "bundled icons must not wait for viewport scheduling");
      check(document.querySelector("#custom [data-mcp-icon]")?.textContent === "GI", "custom names must not select a trusted brand");
      check(!document.querySelector("#custom img"), "unknown custom service keeps its text fallback");
      phases.push({ phase, icons: ids.length, loaded: visibleImages().length, ms: Math.round(performance.now() - started) });
      if (phase === "dark") await state.goOffline?.();
    }
    check(!performance.getEntriesByType("resource").some(entry => (entry as PerformanceResourceTiming).initiatorType === "img" && /^https?:/.test(entry.name)), "icons made network requests");
    state.showCatalog(false);
    // A corrupt trusted image must still leave a usable local fallback.
    const fallbackRoot = document.createElement("div");
    document.body.append(fallbackRoot);
    const root = createRoot(fallbackRoot);
    flushSync(() => root.render(<McpConnectorIcon name="GitHub" identity="github" />));
    fallbackRoot.querySelector("img")!.dispatchEvent(new Event("error"));
    await wait(() => !fallbackRoot.querySelector("img"), "broken icon did not fall back to initials");
    check(fallbackRoot.textContent === "GI", "failed icon fallback lost the name");
    root.unmount(); fallbackRoot.remove(); state.showCatalog(true);
    await wait(() => visibleImages().length === ids.length, "final catalog did not restore");
    return { passed: true, phases, imageRequests: 0, customIdentityAndFailureFallback: true };
  } finally {
    await state.releaseRequests?.();
    await Promise.allSettled(pending);
  }
};
