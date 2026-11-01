import React from "react";
import { createRoot } from "react-dom/client";
import ChatMarkdown from "../../app/manage-ui/src/components/ChatMarkdown";
import GroupChatMarkdown from "../../app/manage-ui/src/pages/GroupChatMarkdown";
import { toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import notionLogo from "../../app/manage-ui/src/assets/mcp-logos/notion.png?inline";
import immersive from "../../app/manage-ui/src/pages/immersive/ImmersiveChat.module.css";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

const state = window as any;
const notionLinks = [
  ["UI设计方法论", "https://app.notion.com/test-page?v=private#section"],
  ["Notion", "https://notion.com/page"],
  ["旧页面", "https://www.notion.so/page"],
  ["旧域名", "https://notion.so/page"],
  ["公开站点", "https://workspace.notion.site/page"],
  ["站点域名", "https://notion.site/page"],
  ["大写域名", "https://APP.NOTION.COM/page"],
  ["域名末尾的点", "https://app.notion.com./page"],
  ["HTTP旧链接", "http://www.notion.so/page"],
];
const otherLinks = [
  ["相似后缀", "https://app.notion.com.example.invalid/page"],
  ["相似前缀", "https://notnotion.so/page"],
  ["用户名", "https://notion.com@example.invalid/page"],
  ["路径与查询", "https://example.invalid/notion.so?target=https://app.notion.com"],
];
const notionSample = `### Notion 页面\n\n${notionLinks.map(([label, href]) => `[${label}](${href})`).join(" · ")}`;
const sample = `${notionSample}

### 怎么申请

1. 从[官方注册入口](https://signup.oraclecloud.com/?source=chat#register)进入，填写国家、姓名、邮箱，完成邮箱验证。
2. 设置账户，谨慎选择主区域；填写地址并完成验证。

来源：[官方额度](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) | [开发文档](https://github.com/ArronKong/Shoggoth) | [图标不可用](https://missing-icon.invalid/page)

长链接：[这是一段需要在窄窗口中自然换行的网页链接文字，用来检查图标与正文对齐以及链接是否会撑出聊天气泡](https://docs.oracle.com/long-label)

自动链接：https://github.com/ArronKong/Shoggoth

其他域名：${otherLinks.map(([label, href]) => `[${label}](${href})`).join(" · ")}
`;
const expectedLinkCount = 6 + notionLinks.length + otherLinks.length;
const notionHrefs = new Set(notionLinks.map(([, href]) => new URL(href).href));
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
    check(anchors.length === expectedLinkCount, "named and auto-linked websites are rendered");
    for (const anchor of anchors) {
      const icon = anchor.firstElementChild as HTMLImageElement;
      check(icon?.matches("img.markdown-link-icon"), "website icon is before the link label");
      check(icon.alt === "" && icon.getAttribute("aria-hidden") === "true", "decorative icon preserves the accessible link name");
      check(icon.referrerPolicy === "no-referrer" && icon.loading === "lazy", "icons load lazily without page referrers");
      check(anchor.target === "_blank" && anchor.rel.includes("noopener"), "external-link behavior is preserved");
      icon.scrollIntoView({ block: "center" });
      await wait(() => icon.complete && icon.naturalWidth > 0, "loaded icon or local fallback");
      const source = icon.getAttribute("src")!;
      if (notionHrefs.has(anchor.href)) {
        check(source === notionLogo && source.startsWith("data:image/png;base64,"), "Notion links use the bundled official logo without network access");
      } else {
        check(anchor.hostname === "missing-icon.invalid" ? source.startsWith("data:image/svg+xml,") : source === `${anchor.origin}/favicon.ico`, "other domains load their favicon or the local fallback");
      }
      const rect = icon.getBoundingClientRect(), size = parseFloat(getComputedStyle(anchor).fontSize);
      check(Math.abs(rect.width - size) < 1 && Math.abs(rect.height - size) < 1, "icon follows the text size in every surface");
    }
    const bounds = section.getBoundingClientRect();
    const longLink = section.querySelector<HTMLAnchorElement>('a[href="https://docs.oracle.com/long-label"]')!;
    for (const rect of longLink.getClientRects()) check(rect.right <= bounds.right + 1, "long link wraps inside the message");
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
  check(cached.match(/markdown-link-icon/g)?.length === expectedLinkCount, "cached HTML never duplicates icons");
  render(`${sample}\n\n[流式新增](http://stream-icon.test/next?private=value) [Notion新增](https://app.notion.com/streamed-page)`);
  await wait(() => document.querySelectorAll('a[href^="http://stream-icon.test/"]').length === 4, "streaming rerender");
  for (const icon of document.querySelectorAll<HTMLImageElement>('a[href^="http://stream-icon.test/"] img')) {
    check(icon.getAttribute("src") === "http://stream-icon.test/favicon.ico", "HTTP icon requests contain only the origin");
  }
  for (const section of document.querySelectorAll("section")) {
    const icon = section.querySelector<HTMLImageElement>('a[href="https://app.notion.com/streamed-page"] img')!;
    check(icon?.getAttribute("src") === notionLogo, "streamed Notion links use the bundled logo on every surface");
    icon.scrollIntoView({ block: "center" });
    await wait(() => icon.complete && icon.naturalWidth > 0, "streamed Notion logo loaded");
  }
  const notionOrigins = new Set(notionLinks.map(([, href]) => new URL(href).origin));
  check(!performance.getEntriesByType("resource").some(entry => notionOrigins.has(new URL(entry.name).origin)), "Notion icons never request a remote resource");
  const qrUrl = "https://qr.fixture/transfer/qrcode?token=fixture-only";
  const qrSample = `[微信支付二维码](${qrUrl}) · [再打开二维码](${qrUrl})\n\n[QR code](https://qr.fixture/no-image)\n\n`
    + '[普通支付网页](https://qr.fixture/checkout)\n\n`[二维码](https://qr.fixture/code-example)`\n\n'
    + '```md\n[二维码](https://qr.fixture/fenced-example)\n```\n\n'
    + '[二维码](javascript:alert(1)) [二维码](https://user:password@qr.fixture/private)';
  render(qrSample);
  await wait(() => document.querySelectorAll(".markdown-qr-preview").length === 8, "QR links have deduplicated image previews on every surface");
  for (const section of document.querySelectorAll("section")) {
    const previews = [...section.querySelectorAll<HTMLImageElement>(".markdown-qr-preview")];
    check(previews.length === 2, "two distinct QR links, no code examples or unsafe URLs");
    const image = previews[0]; image.scrollIntoView({ block: "center" });
    await wait(() => image.complete && image.naturalWidth > 0, "QR image decoded");
    check(image.src === qrUrl && image.referrerPolicy === "no-referrer", "the original QR source is preserved without a page referrer");
    check(image.matches(".markdown-inline-image"), "QR images use the existing chat lightbox interaction");
    check(section.querySelector(`a[href="${qrUrl}"]`) !== null, "the original QR link stays available");
    const rect = image.getBoundingClientRect(), bounds = section.getBoundingClientRect();
    check(rect.width > 100 && rect.width <= 260 && rect.right <= bounds.right + 1, "QR image is readable and fits narrow messages");
    check(getComputedStyle(image).backgroundColor === "rgb(255, 255, 255)", "QR preview has a white scanning background");
    previews[1].scrollIntoView({ block: "center" });
    await wait(() => previews[1].complete && previews[1].hidden, "non-image QR page falls back to its original link");
  }
  render(`![已有二维码](${qrUrl})\n\n[二维码](${qrUrl})`);
  await wait(() => document.querySelectorAll("img.markdown-inline-image").length === 4, "explicit image is retained once on every surface");
  check(!document.querySelector(".markdown-qr-preview"), "explicit image Markdown suppresses duplicate automatic previews");
  render();
  await new Promise(requestAnimationFrame);
  document.querySelector("main")!.scrollTop = 0;
  return { passed: true, surfaces: 4, width: innerWidth, notionLinks: notionLinks.length, lookalikeLinks: otherLinks.length, checks: "bundled Notion logo without network, exact domain boundaries, icon success, fallback, placement, accessibility, sizing, wrapping, light/dark themes, caching, streaming, local files, App routes, mail, image-only links, unsafe schemes" };
};
