import React from "react";
import { createRoot } from "react-dom/client";
import ChatMarkdown from "../../app/manage-ui/src/components/ChatMarkdown";
import GroupChatMarkdown from "../../app/manage-ui/src/pages/GroupChatMarkdown";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import immersive from "../../app/manage-ui/src/pages/immersive/ImmersiveChat.module.css";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

const state = window as any;
const sample = `### 怎么申请

1. 从[官方注册入口](https://signup.oraclecloud.com/?source=chat#register)进入，填写国家、姓名、邮箱，完成邮箱验证。
2. 设置账户，谨慎选择主区域；填写地址并完成验证。

来源：[官方额度](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) | [开发文档](https://github.com/ArronKong/Shoggoth) | [图标不可用](https://missing-icon.invalid/page)

长链接：[这是一段需要在窄窗口中自然换行的网页链接文字，用来检查图标与正文对齐以及链接是否会撑出聊天气泡](https://docs.oracle.com/long-label)

自动链接：https://github.com/ArronKong/Shoggoth
`;
const root = createRoot(document.getElementById("root")!);
function render(text = sample) {
  root.render(<main className="chat-shell" style={{ display: "block", padding: 24, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
    <div style={{ maxWidth: 740, margin: "0 auto", display: "grid", gap: 24 }}>
      <button type="button" style={{ justifySelf: "start" }} onClick={() => {
        document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      }}>切换深浅色</button>
      <section><h2>普通聊天</h2><ChatMarkdown className="chat-bubble chat-md" text={text} /></section>
      <section><h2>群聊</h2><GroupChatMarkdown className="chat-bubble chat-md" text={text} /></section>
      <section><h2>群聊 · 带成员装饰</h2><GroupChatMarkdown className="chat-bubble chat-md" text={text} lead={<span>资料整理 · </span>} /></section>
      <section><h2>沉浸聊天</h2><div className={immersive.md} dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(text, true) }} /></section>
    </div>
  </main>);
}
render();
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const wait = async (predicate: () => unknown, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw Error(`Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 25)); }
};
state.runFixture = async () => {
  await wait(() => document.querySelectorAll("section").length === 4, "all Markdown surfaces");
  for (const section of document.querySelectorAll("section")) {
    const anchors = Array.from(section.querySelectorAll<HTMLAnchorElement>("a"));
    check(anchors.length === 6, "named and auto-linked websites are rendered");
    for (const anchor of anchors) {
      const icon = anchor.firstElementChild as HTMLImageElement;
      check(icon?.matches("img.markdown-link-icon"), "website icon is before the link label");
      check(icon.alt === "" && icon.getAttribute("aria-hidden") === "true", "decorative icon preserves the accessible link name");
      check(icon.referrerPolicy === "no-referrer" && icon.loading === "lazy", "icons load lazily without page referrers");
      check(anchor.target === "_blank" && anchor.rel.includes("noopener"), "external-link behavior is preserved");
      icon.scrollIntoView({ block: "center" });
      await wait(() => icon.complete && icon.naturalWidth > 0, "loaded icon or local fallback");
      const source = icon.getAttribute("src")!;
      check(anchor.hostname === "missing-icon.invalid" ? source.startsWith("data:image/svg+xml,") : source === `${anchor.origin}/favicon.ico`, "load the website favicon or the local fallback");
      const rect = icon.getBoundingClientRect(), size = parseFloat(getComputedStyle(anchor).fontSize);
      check(Math.abs(rect.width - size) < 1 && Math.abs(rect.height - size) < 1, "icon follows the text size in every surface");
    }
    const bounds = section.getBoundingClientRect();
    for (const rect of anchors[4].getClientRects()) check(rect.right <= bounds.right + 1, "long link wraps inside the message");
  }
  const themeButton = document.querySelector<HTMLButtonElement>("main button")!;
  themeButton.click();
  check(document.documentElement.dataset.theme === "dark", "dark theme is active");
  for (const icon of document.querySelectorAll<HTMLImageElement>(".markdown-link-icon")) {
    check(icon.getBoundingClientRect().height > 0 && icon.naturalWidth > 0, "website and fallback icons remain visible in dark mode");
    check(getComputedStyle(icon).backgroundColor === "rgb(255, 255, 255)", "transparent dark favicons have a contrasting backing");
  }
  themeButton.click();
  const template = document.createElement("template");
  template.innerHTML = toSanitizedMarkdownHtml(`[邮箱](mailto:hello@example.com) [文件](</tmp/report.pdf>) [应用](#/settings) [锚点](#part) [相对](/relative) [脚本](javascript:alert(1)) [数据](data:text/html,bad) [图片](https://example.com/image)\n\n[![图片](https://example.com/photo.png)](https://example.com/photo)`, true);
  check(template.content.querySelectorAll(".markdown-link-icon").length === 1, "files, mail, App routes, anchors, unsafe schemes and image-only links have no website icons");
  check(!template.content.querySelector('a[href^="javascript:"],a[href^="data:"]'), "unsafe links remain blocked");
  check(template.content.querySelector("a[data-local-path]")?.textContent === "report.pdf", "file labels remain intact");
  check(template.content.querySelector('a[href="#/settings"]')?.getAttribute("target") === null, "App navigation stays internal");
  const cached = toSanitizedMarkdownHtml(sample, true);
  check(cached === toSanitizedMarkdownHtml(sample, true), "cached HTML is stable");
  check(cached.match(/markdown-link-icon/g)?.length === 6, "cached HTML never duplicates icons");
  render(`${sample}\n\n[流式新增](http://stream-icon.test/next?private=value)`);
  await wait(() => document.querySelectorAll('a[href^="http://stream-icon.test/"]').length === 4, "streaming rerender");
  for (const icon of document.querySelectorAll<HTMLImageElement>('a[href^="http://stream-icon.test/"] img')) {
    check(icon.getAttribute("src") === "http://stream-icon.test/favicon.ico", "HTTP icon requests contain only the origin");
  }
  render();
  await new Promise(requestAnimationFrame);
  document.querySelector("main")!.scrollTop = 0;
  return { passed: true, surfaces: 4, width: innerWidth, checks: "icon success, fallback, placement, accessibility, sizing, wrapping, light/dark themes, caching, streaming, local files, App routes, mail, image-only links, unsafe schemes" };
};
