import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { applyConfiguredLocale } from "../../../app/manage-ui/src/i18n";
import BackgroundTaskCard from "../../../app/manage-ui/src/pages/chat-background-task/BackgroundTaskCard";
import BackgroundTaskModal from "../../../app/manage-ui/src/pages/chat-background-task/BackgroundTaskModal";
import ChatMarkdown from "../../../app/manage-ui/src/components/ChatMarkdown";
import ScrollbarProvider from "../../../app/manage-ui/src/components/ScrollbarProvider";
import ChatPromptCard from "../../../app/manage-ui/src/pages/ChatPromptCard";
import { ChatMessageContextMenu, ChatTaskDetailsButton, IconCopy, IconQuote } from "../../../app/manage-ui/src/pages/ChatMessageActions";
import { BackgroundTaskConversation } from "../../../app/manage-ui/src/pages/ChatPage";
import { writeChatClipboard } from "../../../app/manage-ui/src/lib/chatClipboard";
import { formatChatTime } from "../../../app/manage-ui/src/lib/chatTime";
import type { BackgroundTaskStatus, BackgroundTaskReportState } from "../../../app/manage-ui/src/types";
import glass from "../../../app/manage-ui/src/pages/immersive/ImmersiveChat.module.css";
import "../../../app/manage-ui/src/styles.css";
import "../../../app/manage-ui/src/pages/ChatPage.css";
import "../../../app/manage-ui/src/manage-skin.css";
import "../../../app/manage-ui/src/debug-overrides.css";
import { conclusion, detailCases, fileName, fileUrl, interactions, makeDetail, reportCases, requestFor, stamp, statusTitles, type PromptId } from "./scenes";
import { connectPreviewChat, installPreviewTransport, resetSample } from "./transport";
import "./gallery.css";

const sections = [["conversation", "原对话"], ["states", "执行卡片"], ["reports", "报告投递"], ["detail", "任务详情"], ["requests", "审批与输入"]] as const;
type SectionId = typeof sections[number][0];
type Theme = "light" | "dark";
const statusGroups: { label: string; values: BackgroundTaskStatus[] }[] = [
  { label: "执行过程", values: ["starting", "queued", "running", "stopping"] },
  { label: "等待处理", values: ["waiting_approval", "waiting_input", "needs_verification"] },
  { label: "执行结束", values: ["completed", "failed", "canceled", "interrupted"] },
];
const sceneName = (id: string) => detailCases.flatMap(g => [...g.items]).find(item => item[0] === id)?.[1] || "任务详情";
const steps = ["派工回执", "同时派两项", "前台继续", "报告送达", "按文件追问"];
const reportExamples = [
  { label: "带文件", scene: "completed", body: `${conclusion}\n\n- [${fileName}](${fileUrl})` },
  { label: "纯文字", scene: "plain", body: conclusion },
  { label: "失败", scene: "failed", body: "暂时无法读取报价来源，本轮未生成对比表。" },
  { label: "中断", scene: "interrupted", body: "服务连接已中断。已收集的资料保存在任务目录中。" },
];
type Open = (id: string) => void;

function Segment({ label, options, selected, onChange }: {
  label: string; options: readonly string[]; selected: number; onChange: (index: number) => void;
}) {
  return <div className="gallery-segment" role="group" aria-label={label}>
    {options.map((name, i) => <button type="button" key={name} aria-pressed={selected === i} onClick={() => onChange(i)}>{name}</button>)}
  </div>;
}

function ChatRow({ role, immersive, text, children, onOpenTaskDetails }: {
  role: "user" | "assistant"; immersive: boolean; text: string; children?: ReactNode; onOpenTaskDetails?: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [quoted, setQuoted] = useState(false);
  const openMenu = onOpenTaskDetails ? (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  } : undefined;
  const copy = () => { void writeChatClipboard(text).catch(() => {}); };
  const quote = () => setQuoted(true);
  const actionClass = immersive ? glass.actBtn : "chat-copybtn";
  const actions = onOpenTaskDetails && <>
    <ChatTaskDetailsButton className={actionClass} onOpen={onOpenTaskDetails} />
    <button type="button" className={actionClass} data-chat-footer-icon="" title={t(immersive ? "chat.copy" : "chat.copyAsMarkdown")} onClick={copy}><IconCopy /></button>
    <button type="button" className={actionClass} data-chat-footer-icon="" aria-label={t("chat.quote")} title={t("chat.quote")} onClick={quote}><IconQuote /></button>
  </>;
  const time = formatChatTime(stamp + 3 * 60_000);
  const quotePreview = quoted && <div className={immersive ? glass.quoteBar : "chat-quote-bar"}>
    <IconQuote className="chat-quote-icon" />
    <span className={immersive ? glass.quoteText : "chat-quote-bar__text"} title={text}>{text.split("\n")[0]}</span>
    <button type="button" className={immersive ? glass.quoteX : "chat-quote-bar__x"} title={t("chat.removeQuote")} onClick={() => setQuoted(false)}>×</button>
  </div>;
  const contextMenu = menu && onOpenTaskDetails && <ChatMessageContextMenu {...menu} onClose={() => setMenu(null)}
    onCopy={copy} onQuote={quote} onOpenTaskDetails={onOpenTaskDetails} />;
  if (immersive) return <>
    <div className={role === "user" ? glass.userRow : glass.asstRow} onContextMenu={openMenu}>
      <div data-glass-panel="" className={role === "user" ? glass.userBubble : `${glass.asstCard} ${glass.contentCard}`}>
        <div className={glass.md}><ChatMarkdown className="chat-md" text={text} />{children}</div>
      </div>
      {actions && <><div className={glass.footer} data-immersive-message-footer><span>{time}</span></div><div className={glass.rowActions}>{actions}</div></>}
    </div>
    {quotePreview}{contextMenu}
  </>;
  return <>
    <div className={`chat-group is-${role}`} onContextMenu={openMenu}>
      <div className="chat-group__stack"><ChatMarkdown className="chat-bubble chat-md" text={text} />{children}</div>
      {actions && <div className="chat-group__footer"><span>{time}</span>{actions}</div>}
    </div>
    {quotePreview}{contextMenu}
  </>;
}

function Conversation({ open, compact }: { open: Open; compact: boolean }) {
  const [immersive, setImmersive] = useState(false);
  const [step, setStep] = useState(0);
  const [reportIndex, setReportIndex] = useState(0);
  const example = reportExamples[reportIndex];
  const scene = step < 3 ? "running" : step === 3 ? example.scene : "completed";
  const task = makeDetail(scene).task;
  const card = <BackgroundTaskCard task={task} onOpen={() => open(scene)} />;
  return <section id="conversation" className="gallery-section">
    <div className="section-top"><h2>原对话</h2><Segment label="对话布局" options={["普通", "沉浸"]} selected={Number(immersive)} onChange={i => setImmersive(Boolean(i))} /></div>
    <div className="gallery-viewport" data-compact={compact || undefined}>
      <div className="chat-specimen chat-shell" data-layout={immersive ? "immersive" : "normal"}>
        {immersive && <video className="sample-backdrop" src="./idle.mp4" muted autoPlay playsInline loop aria-hidden="true" />}
        <div className="sample-bar"><img src="./codex.jpg" alt="" /><strong>Codex</strong><span className="bar-divider"/><span>方案定价调研</span></div>
        <div className="sample-thread" aria-live="polite">
          {step === 0 && <><ChatRow role="user" immersive={immersive} text="后台帮我比较三款方案的定价，整理成表格发给我。" />
            <ChatRow role="assistant" immersive={immersive} text="已经交给后台处理，整理好会发到这里。">{card}</ChatRow></>}
          {step === 1 && <><ChatRow role="user" immersive={immersive} text="把定价和使用限制分成两项，在后台分别整理。" />
            <ChatRow role="assistant" immersive={immersive} text="两项任务已受理，完成后会分别在这里汇报。">{card}
              <BackgroundTaskCard task={makeDetail("queued").task} onOpen={() => open("queued")} /></ChatRow></>}
          {step === 2 && <><ChatRow role="assistant" immersive={immersive} text="定价对比正在后台进行。">{card}</ChatRow>
            <ChatRow role="user" immersive={immersive} text="那先帮我算一下，8 元一个月，一年是多少？" />
            <ChatRow role="assistant" immersive={immersive} text="一年是 96 元。" /></>}
          {step === 3 && <><ChatRow role="assistant" immersive={immersive} text="任务已交给后台。">{card}</ChatRow>
            <ChatRow role="assistant" immersive={immersive} text={example.body} onOpenTaskDetails={() => open(scene)} /></>}
          {step === 4 && <><ChatRow role="assistant" immersive={immersive} text={`已附上 [${fileName}](${fileUrl})。`} onOpenTaskDetails={() => open(scene)} />
            <ChatRow role="user" immersive={immersive} text="按表格里的数，方案 B 专业版一年要多少钱？" />
            <ChatRow role="assistant" immersive={immersive} text="每月 28 元，按 12 个月计算是 336 元。" /></>}
        </div>
      </div>
    </div>
    <div className="chat-steps" role="group" aria-label="对话阶段">{steps.map((name, i) =>
      <button type="button" key={name} aria-pressed={step === i} onClick={() => setStep(i)}><i aria-hidden="true" />{name}</button>)}</div>
    {step === 3 && <div className="report-switch"><span>报告内容</span><Segment label="报告内容" options={reportExamples.map(item => item.label)} selected={reportIndex} onChange={setReportIndex} /></div>}
  </section>;
}

function StateCards({ open }: { open: Open }) {
  const { t } = useTranslation();
  return <section id="states" className="gallery-section"><div className="section-top"><h2>执行卡片</h2><span className="section-count">{Object.keys(statusTitles).length} 种状态</span></div>
    {statusGroups.map(({ label, values }) => <div key={label} className="state-group"><h3>{label}</h3>
      <div className="state-grid chat-shell">{values.map(status => <div key={status} data-preview-status={status} title={t(`backgroundTask.status.${status}`)}>
        <BackgroundTaskCard task={makeDetail(status).task} onOpen={() => open(status)} /></div>)}</div></div>)}
  </section>;
}

function Reports({ open }: { open: Open }) {
  return <section id="reports" className="gallery-section"><div className="section-top"><h2>报告投递</h2><span className="section-count">5 种状态</span></div>
    <div className="reports-list">{(Object.keys(reportCases) as BackgroundTaskReportState[]).map(id => {
      const sample = reportCases[id];
      const scene = `report-${id}`;
      const task = makeDetail(scene).task;
      return <div className="report-row" key={id} data-preview-report={id}><div><h3>{sample.title}</h3><p>{sample.note}</p></div>
        <div className="report-slot chat-shell">{id === "delivered"
          ? <ChatRow role="assistant" immersive={false} text={reportExamples[0].body} onOpenTaskDetails={() => open(scene)} />
          : <BackgroundTaskCard task={task} onOpen={() => open(scene)} />}</div></div>;
    })}</div>
  </section>;
}

function DetailStage({ scene, compact, theme }: { scene: string; compact: boolean; theme: Theme }) {
  const [visible, setVisible] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const edited = useRef(false);
  useEffect(() => {
    if (!stage.current) return;
    // Retain edited samples when scrolling; other offscreen dialogs can release their polling timers.
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting || edited.current), { rootMargin: "80px" });
    const retain = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data === "gallery:interaction") edited.current = true;
    };
    window.addEventListener("message", retain);
    observer.observe(stage.current);
    return () => { window.removeEventListener("message", retain); observer.disconnect(); };
  }, []);
  const syncTheme = () => { frame.current?.contentWindow?.postMessage({ galleryTheme: theme }, "*"); };
  useEffect(syncTheme, [theme]);
  return <div className="gallery-viewport" ref={stage} data-compact={compact || undefined}>
    {visible && <iframe className="detail-frame" title={`任务详情 · ${sceneName(scene)}`} ref={frame} onLoad={syncTheme}
      src={`./index.html?detail=${encodeURIComponent(scene)}`} />}
  </div>;
}

function ScenarioHint({ scene }: { scene: string }) {
  const hints: Record<string, string> = {
    "wait-error": "输入一条补充要求并按回车，可查看等待用户回答时的提示。",
    "stop-error": "输入一条补充要求并按回车，可查看任务停止过程中的提示。",
    "approval-error": "回应一次审批可查看失败提示，再试一次可完成审批。",
    "slow-send": "输入补充要求并按回车，可观察 12 秒的发送中状态。",
    "slow-stop": "点输入框右下角的停止图标，可观察 12 秒的请求中状态。",
    "slow-answer": "选择或输入答案并提交，可观察 12 秒的提交中状态。",
  };
  return hints[scene] ? <p className="specimen-note">{hints[scene]}</p> : null;
}

function Workbench({ theme, compact, open }: { theme: Theme; compact: boolean; open: Open }) {
  const [scene, setScene] = useState("running");
  const [revision, setRevision] = useState(0);
  const [expand, setExpand] = useState(true);
  return <section id="detail" className="gallery-section"><div className="section-top"><h2>任务详情</h2>
    <Segment label="详情对照方式" options={["逐项查看", "展开全部"]} selected={Number(expand)} onChange={i => setExpand(Boolean(i))} /></div>
    {expand ? <div className="detail-groups">{detailCases.map(group => <div key={group.group}>
      <h3>{group.group}</h3><div className="detail-comparison">{group.items.map(([id, name]) =>
        <article key={id}><header><h4>{name}</h4><button type="button" className="text-action" onClick={() => open(id)}>打开弹窗 ↗</button></header>
          <DetailStage scene={id} compact={compact} theme={theme} /><ScenarioHint scene={id} /></article>)}</div></div>)}</div> :
    <><div className="work-controls"><label>详情样例 <select value={scene} onChange={e => setScene(e.target.value)}>
      {detailCases.map(group => <optgroup key={group.group} label={group.group}>{group.items.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</optgroup>)}
    </select></label><div className="work-actions"><button type="button" className="text-action" onClick={() => setRevision(r => r + 1)}>重置样例</button>
      <button className="text-action" onClick={() => open(scene)}>打开弹窗 ↗</button></div></div>
    <DetailStage key={scene + revision} scene={scene} compact={compact} theme={theme} />
    <ScenarioHint scene={scene} />
    </>}
  </section>;
}

function PromptSample({ id, open }: { id: PromptId; open: Open }) {
  const [handled, setHandled] = useState(false);
  const request = requestFor(id);
  return <article className="prompt-specimen"><header><h3>{interactions[id]}</h3><button type="button" className="text-action" onClick={() => open("prompt-" + id)}>在详情中看 ↗</button></header>
    {handled ? <div className="sample-handled" role="status">已回应此样例<button className="text-action" onClick={() => setHandled(false)}>重新演示</button></div>
      : <ChatPromptCard entry={{ ...request, id: request.requestId }} agentName="Codex" onRespond={async () => { setHandled(true); }} />}
  </article>;
}

function DetailFrame({ scene }: { scene: string }) {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return <><div className="frame-underlay"><img src="./codex.jpg" alt="" /><strong>方案定价调研</strong>
    <button className="text-action" onClick={() => { resetSample(scene); setOpen(true); }}>重新打开详情</button></div>
    {open && <BackgroundTaskModal sessionKey="gallery" taskId={scene} agentName="Codex" revision={revision} initialFocus={false}
      Conversation={BackgroundTaskConversation} connectChat={connectPreviewChat}
      onChanged={() => setRevision(n => n + 1)} onClose={() => setOpen(false)} />}</>;
}

function Gallery() {
  const [theme, setTheme] = useState<Theme>(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState<SectionId>("conversation");
  const [modal, setModal] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const open = (id: string) => { resetSample(id); setRevision(0); setModal(id); };
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    const update = () => {
      let current: SectionId = "conversation";
      for (const [id] of sections) if ((document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= 125) current = id;
      setActive(current);
    };
    update(); window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return <div className="gallery" data-width={compact ? "compact" : "desktop"}>
    <aside className="gallery-rail"><div className="gallery-brand"><img src="./logo.png" alt="" /><b>Shoggoth</b></div>
      <nav aria-label="预览目录"><h2>预览目录</h2>{sections.map(([id, name]) => <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined}>
        <span className={`nav-sign sign-${id}`} aria-hidden="true"/>{name}</a>)}</nav>
      <div className="rail-bottom"><i aria-hidden="true"/>本地样例</div>
    </aside>
    <main className="gallery-main"><header className="gallery-head"><div className="gallery-path">Shoggoth <span>/</span> 界面预览</div><h1>后台任务</h1>
      <p>对照原私聊、执行卡与详情弹窗。点开样例，可以尝试补充要求、审批和停止。</p></header>
      <div className="gallery-settings"><div><span>外观</span><Segment label="外观" options={["浅色", "深色"]} selected={theme === "light" ? 0 : 1} onChange={i => setTheme(i ? "dark" : "light")} /></div>
        <div><span>画幅</span><Segment label="预览画幅" options={["自适应", "390 px"]} selected={Number(compact)} onChange={i => setCompact(Boolean(i))} /></div></div>
      <Conversation compact={compact} open={open} /><StateCards open={open} /><Reports open={open} />
      <Workbench compact={compact} theme={theme} open={open} />
      <section id="requests" className="gallery-section"><div className="section-top"><h2>审批与输入</h2><span className="section-count">{Object.keys(interactions).length} 种请求</span></div>
        <div className="prompt-board">{(Object.keys(interactions) as PromptId[]).map(id => <PromptSample key={id} id={id} open={open} />)}</div></section>
    </main>
    {modal && <BackgroundTaskModal key={modal} sessionKey="gallery" taskId={modal} agentName="Codex" revision={revision}
      Conversation={BackgroundTaskConversation} connectChat={connectPreviewChat}
      onChanged={() => setRevision(n => n + 1)} onClose={() => setModal(null)} />}
  </div>;
}

const scene = new URLSearchParams(location.search).get("detail");
document.body.classList.add(scene ? "frame-page" : "gallery-page");
if (scene && window.parent !== window) {
  window.addEventListener("message", event => {
    const theme = event.data?.galleryTheme;
    if (event.source === window.parent && (theme === "light" || theme === "dark")) document.documentElement.dataset.theme = theme;
  });
  const retain = () => window.parent.postMessage("gallery:interaction", "*");
  document.addEventListener("pointerdown", retain, { once: true });
  document.addEventListener("keydown", retain, { once: true });
}
installPreviewTransport();
void applyConfiguredLocale("zh-CN").then(() => {
  document.title = scene ? `${sceneName(scene)} · 后台任务预览` : "后台任务 · Shoggoth 界面预览";
  createRoot(document.getElementById("root")!).render(<><ScrollbarProvider />{scene ? <DetailFrame scene={scene} /> : <Gallery />}</>);
});
