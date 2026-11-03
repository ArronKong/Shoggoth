import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import MarkdownIt from "markdown-it";
import ChatMarkdown from "../../app/manage-ui/src/components/ChatMarkdown";
import GroupChatMarkdown from "../../app/manage-ui/src/pages/GroupChatMarkdown";
import { md, toSanitizedMarkdownHtml } from "../../app/manage-ui/src/lib/markdown";
import immersive from "../../app/manage-ui/src/pages/immersive/ImmersiveChat.module.css";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/ChatPage.css";

// Keep the screenshot's original Markdown, including punctuation inside strong
// delimiters and no added spaces. Render locally without a backend or provider.
const progress = [
  "这个年龄可以把重点放在日常玩耍、说话和生活习惯上。我会结合儿童发展指南，整理几项在家容易做的事。",
  "CDC页面暂时无法直接读取，我会换用官方检索内容和儿科学会资料核对。建议会按20个月能尝试的活动来整理，不把两岁的发展参考提前当作要求。",
  "我会再换一种读取方式核对CDC原文，重点确认适合这个阶段的亲子活动。",
];
const answer = `**1岁8个月，最值得带她学的是：表达需要、参与生活、在玩耍中探索。**这些都可以融进日常，不用把一天安排得很满。我建议先抓三块：

1. **说话、理解和交流**\x20\x20
   跟着她正在关注的东西说：她指车，你说“车开走了”；她说“水”，你接“你想喝水”。说完留一点时间，让她用声音、手势或词语回应。\x20\x20
   每天一起翻一会儿绘本，可以指图、模仿动物叫声，不必每次读完整本。日常对话和共读能支持语言发展。[美国儿科学会建议](https://www.healthychildren.org/English/ages-stages/toddler/Pages/Language-Development-2-Year-Olds.aspx)

2. **自己做一点，以及表达情绪、接受简单规则**\x20\x20
   给她机会拿勺吃饭、小杯喝水、穿衣时伸胳膊、把玩具放回篮子。一次只说一步，例如“把球给妈妈”，需要时帮她完成。\x20\x20
   也可以给两个选择：“穿红鞋还是蓝鞋？”她着急时，帮她说出感受并守住边界：“你还想玩，很失望。我陪你，但不能打人。”这个阶段可以开始练习，仍需要大人反复陪着做。

3. **通过游戏练动作和思考**\x20\x20
   可以轮换着玩：**滚球、走走蹲蹲、大块积木、粗蜡笔涂画、把物品装进盒子再拿出来、给娃娃喂饭**。跟着她的兴趣示范一点，让她自己试；滚球还可以练习简单的轮流互动。假装游戏、日常自理和探索，都是这个阶段适合发展的方向。[UNICEF一岁半养育建议](https://www.unicef.org/parenting/child-development/your-toddlers-developmental-milestones-18-months)

观察的是：**她有没有逐渐更主动地沟通、更愿意尝试、动作更熟练。**这些是陪玩的方向，不是必须一次全部学会的清单；同一种游戏反复玩，也是在学习。`;
const expectedStrong = [
  "1岁8个月，最值得带她学的是：表达需要、参与生活、在玩耍中探索。",
  "说话、理解和交流",
  "自己做一点，以及表达情绪、接受简单规则",
  "通过游戏练动作和思考",
  "滚球、走走蹲蹲、大块积木、粗蜡笔涂画、把物品装进盒子再拿出来、给娃娃喂饭",
  "她有没有逐渐更主动地沟通、更愿意尝试、动作更熟练。",
];
const sample = [...progress, answer].join("\n\n");
const state = window as any;
const root = createRoot(document.getElementById("root")!);
const native = new MarkdownIt({ html: true, breaks: true, linkify: true });
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
const parse = (text: string) => {
  const template = document.createElement("template");
  template.innerHTML = toSanitizedMarkdownHtml(text);
  return template.content;
};
const strongTexts = (element: ParentNode) => [...element.querySelectorAll("strong")].map(node => node.textContent);
const frame = () => new Promise(requestAnimationFrame);
const waitForWidth = async (width: number) => {
  const deadline = Date.now() + 5000;
  while (innerWidth !== width) {
    check(Date.now() < deadline, `viewport resized to ${width}, got ${innerWidth}`);
    await frame();
  }
};

function renderSurfaces() {
  flushSync(() => root.render(<main className="chat-shell fixture-main">
    <section data-surface="normal"><ChatMarkdown className="chat-bubble chat-md" text={sample} /></section>
    <section data-surface="group"><GroupChatMarkdown className="chat-bubble chat-md" text={sample} /></section>
    <section data-surface="decorated-group"><GroupChatMarkdown className="chat-bubble chat-md" text={sample} lead={<span>育儿专家 · </span>} /></section>
    <section data-surface="immersive"><div className={immersive.md} dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(sample, true) }} /></section>
    <section data-surface="streaming"><ChatMarkdown className="chat-bubble chat-md" text={sample} streamingCursor /></section>
  </main>));
}

state.runFixture = async (width: number) => {
  await waitForWidth(width);
  const cases: [string, string][] = [
    ["**动作更熟练。**这些是陪玩的方向。", "动作更熟练。"],
    ["观察的是：**动作更熟练。**这些是陪玩的方向。", "动作更熟练。"],
    ["这是**“重点”**内容", "“重点”"],
    ["这是**（重点）**内容", "（重点）"],
    ["这是**《书名》**内容", "《书名》"],
    ["这是**「重点」**内容", "「重点」"],
    ["这是**(重点)**内容", "(重点)"],
    ["**注意！**请继续。", "注意！"],
    ["**可以吗？**接着看。", "可以吗？"],
    ["**注意!**请继续。", "注意!"],
    ["**𠮷。**𠮷", "𠮷。"],
    ["**[参考](https://example.test/guide)。**这些是正文。", "参考。"],
    ["**要*慢慢*来。**这些是正文。", "要慢慢来。"],
  ];
  for (const [text, expected] of cases) {
    const content = parse(text);
    check(JSON.stringify(strongTexts(content)) === JSON.stringify([expected]), `CJK strong: ${text}`);
    check(!content.textContent!.includes("**"), `no visible delimiters: ${text}`);
  }
  check(JSON.stringify(strongTexts(parse("**第一句。**接着**第二句！**最后"))) === JSON.stringify(["第一句。", "第二句！"]), "adjacent spans pair independently");
  for (const text of [
    "**普通加粗**接着", "**English** text", "**English.** text", 'word**"quoted"**word',
    "*斜体。*接着", "***粗斜体。***接着", "__下划线。__接着", "a_b_c", "2**3",
    "**未完成。接着", "** 不能以空格开头**", "**不能以空格结尾 **", "****", "***nested *emphasis* text***",
    String.raw`\*\*动作更熟练。\*\*这些`, "`**动作更熟练。**这些`",
  ]) check(md.renderInline(text) === native.renderInline(text), `preserve native Markdown: ${text}`);
  const code = parse("```md\n**动作更熟练。**这些\n```");
  check(!code.querySelector("strong") && code.querySelector("code")?.textContent === "**动作更熟练。**这些\n", "fenced code remains literal");
  const link = parse("[正文](https://example.test/**路径。**后续)");
  check(decodeURI(link.querySelector("a")?.getAttribute("href") || "") === "https://example.test/**路径。**后续", "link destinations stay exact");
  check(!parse("**前[中。**文](https://example.test/guide)后").querySelector("strong"), "delimiters cannot cross link boundaries");
  check(!parse('[**链接。**后续](javascript:alert(1))').querySelector("a[href]"), "unsafe links remain blocked");

  renderSurfaces();
  await document.fonts.ready;
  await frame();
  for (const section of document.querySelectorAll<HTMLElement>("section[data-surface]")) {
    const name = section.dataset.surface;
    check(JSON.stringify(strongTexts(section)) === JSON.stringify(expectedStrong), `${name}: all six screenshot spans are bold`);
    check(!section.textContent!.includes("**"), `${name}: no raw bold markers`);
    check(section.querySelectorAll("ol > li").length === 3, `${name}: numbered list is intact`);
    check(section.querySelectorAll("a[href^='https://']").length === 2, `${name}: both source links remain clickable`);
    const strong = section.querySelector("strong")!;
    const normalWeight = parseFloat(getComputedStyle(strong.parentElement!).fontWeight);
    check(parseFloat(getComputedStyle(strong).fontWeight) > normalWeight, `${name}: computed font is visibly bold`);
    check(section.querySelectorAll(".chat-cursor").length === (name === "streaming" ? 1 : 0), `${name}: streaming cursor is intact`);
    check(section.scrollWidth <= section.clientWidth + 1, `${name}: message fits viewport`);
  }
  for (const theme of ["dark", "light"]) {
    document.documentElement.dataset.theme = theme;
    for (const strong of document.querySelectorAll("strong")) check(parseFloat(getComputedStyle(strong).fontWeight) >= 600, `${theme}: bold styling is preserved`);
  }
  const streaming = "**动作更熟练。**这些是陪玩的方向。";
  for (let end = 1; end <= streaming.length; end++) {
    flushSync(() => root.render(<ChatMarkdown className="chat-md" text={streaming.slice(0, end)} streamingCursor />));
    // A lone leading '*' is an empty list item, with no visible text to anchor.
    const hasText = !!document.querySelector(".chat-md")!.textContent?.trim();
    check(document.querySelectorAll(".chat-cursor").length === (hasText ? 1 : 0), `incremental streaming cursor at ${end}`);
  }
  check(JSON.stringify(strongTexts(document)) === JSON.stringify(["动作更熟练。"]), "completed stream resolves CJK bold");
  check(!document.querySelector(".chat-md")!.textContent!.includes("**"), "completed stream removes visible delimiters");
  const cached = toSanitizedMarkdownHtml(sample, true);
  check(cached === toSanitizedMarkdownHtml(sample, true), "cached HTML remains stable");
  return { passed: true, width: innerWidth, surfaces: 5, screenshotStrongSpans: 6, cjkCases: cases.length + 1,
    checks: "original screenshot text, CJK punctuation, nesting, astral Han, links, escaping, code, standard emphasis, streaming, cache, light/dark, wrapping" };
};

state.showScreenshotSample = async (width: number) => {
  await waitForWidth(width);
  document.documentElement.dataset.theme = "light";
  flushSync(() => root.render(<main className="chat-shell fixture-main" id="screenshot-content">
    <h1>中文 Markdown 加粗兼容验证</h1>
    <p className="fixture-caption">截图原文 · 六处加粗正常显示</p>
    <div className="chat-group is-assistant"><div className="chat-group__stack">
      {[...progress, answer].map((text, index) => <ChatMarkdown key={index} className="chat-bubble chat-md" text={text} />)}
    </div></div>
  </main>));
  await document.fonts.ready;
  await frame(); await frame();
  const bounds = document.getElementById("screenshot-content")!.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
};
