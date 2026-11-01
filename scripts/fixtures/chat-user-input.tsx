import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ChatPromptCard, { type ChatPromptEntry, type ChatPromptResponse } from "../../app/manage-ui/src/pages/ChatPromptCard";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "./chat-user-input.css";

const query = new URLSearchParams(location.search);
const en = query.get("lang") === "en";
function Preview() {
  const [entry, setEntry] = useState<ChatPromptEntry | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [failedOnce, setFailedOnce] = useState(false);
  useEffect(() => {
    let active = true;
    fetch(`/request?${query}`).then(response => response.json()).then(value => {
      if (!active) return;
      if (value.error) throw Error(value.error);
      setEntry(value);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [revision]);
  const respond = async (request: ChatPromptEntry, response: ChatPromptResponse) => {
    try {
      if (query.get("fail") === "1" && !failedOnce) {
        setFailedOnce(true); throw Error(en ? "Could not submit. Your answer is saved; please try again." : "这次提交未成功，已保留你的回答，请重试。");
      }
      const result = await fetch("/respond", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.requestId, response }) });
      const received = await result.json();
      if (!result.ok) throw Error(received.error);
      setError(""); setEntry(null);
      setAnswer(received.answers?.food?.answers?.[0] ?? "");
    } catch (error) { setError((error as Error).message); throw error; }
  };
  return <main className="input-preview">
    <header className="input-preview__header"><span className="input-preview__avatar" aria-hidden="true">S</span>
      <div><strong>Shoggoth</strong><p>{en ? "Input card preview" : "补充信息卡片预览"}</p></div>
      <span className="input-preview__preview">{en ? "Preview" : "交互预览"}</span>
    </header>
    <div className="input-preview__conversation">
      <p className="input-preview__user">{en ? "What can I get at McDonald’s?" : "帮我看看麦当劳有什么可以点的。"}</p>
      <p className="input-preview__assistant">{en ? "Here are two offers. You can choose one, or write a different order below."
        : "这里有两项餐品优惠。你可以直接选择，也可以在下面写下想吃的餐品，我会按你的回答继续查找。"}</p>
      {entry ? <ChatPromptCard key={entry.id} entry={entry} onRespond={respond} draftKey={`preview-${entry.id}`} /> : null}
      {answer !== null ? <section className="input-preview__receipt" aria-live="polite">
        <span>{answer ? (en ? "Answer received" : "已收到你的回答") : (en ? "Canceled" : "已取消")}</span>
        {answer ? <p data-received-answer>{answer}</p> : null}
        <button type="button" onClick={() => { setAnswer(null); setEntry(null); setRevision(value => value + 1); }}>
          {en ? "Try again" : "再试一次"}</button>
      </section> : null}
      {error ? <p className="input-preview__error" role="alert">{error}</p> : null}
      <p className="input-preview__note">{en ? "Preview only. Submitting displays your answer; no order is placed."
        : "仅演示问答交互，提交后显示你的回答，不会下单。"}</p>
    </div>
  </main>;
}
await applyConfiguredLocale(en ? "en" : "zh-CN");
createRoot(document.getElementById("root")!).render(<Preview />);
