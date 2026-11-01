import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { prepareChatInput, listChatSecrets, revokeChatSecret, listChatSecretResults, readChatSecretResult,
  localSpeechStatus } from "../api/client";
import type { ChatSecretReference, ChatSecretResult, LocalSpeechStatus } from "../types";
import Modal from "./Modal";
import s from "./ChatCredentials.module.css";

// Values only live in this mounted local editor/result viewer. No localStorage,
// transcript, analytics, or model callbacks receive the original result.
export default function ChatCredentials({ sessionKey, input, replaceInput, getSelection }: {
  sessionKey: string; input: string; replaceInput: (text: string) => void;
  getSelection: () => { start: number; end: number } | null;
}) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith("zh");
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [items, setItems] = useState<ChatSecretReference[]>([]), [results, setResults] = useState<ChatSecretResult[]>([]);
  const [draft, setDraft] = useState(""), [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [speech, setSpeech] = useState<LocalSpeechStatus | null>(null);
  const [shown, setShown] = useState<{ text: string; expiresAt: number } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null), scope = useRef(sessionKey); scope.current = sessionKey;
  const viewerEpoch = useRef(0);
  const refresh = async () => {
    const target = sessionKey;
    const [secrets, receipts] = await Promise.all([listChatSecrets(target), listChatSecretResults(target)]);
    if (scope.current === target) { setItems(secrets.items); setResults(receipts.items); }
  };
  useEffect(() => { viewerEpoch.current++; setOpen(false); setBusy(false); setDraft(""); setShown(null); setError(""); setNotice(""); setItems([]); setResults([]); }, [sessionKey]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setShown(value => value && value.expiresAt <= Date.now() ? null : value), 1000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let retired = false; setSpeech(null);
    void localSpeechStatus().then(value => { if (!retired) setSpeech(value); }).catch(() => {});
    return () => { retired = true; };
  }, [open]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(""); const target = sessionKey;
    try { await fn(); } catch (e) { if (scope.current === target) setError(e instanceof Error ? e.message : (zh ? "暂时无法完成，请稍后重试。内容已为你保留" : "This could not be completed. Your content is still here; please try again later.")); }
    finally { if (scope.current === target) setBusy(false); }
  };
  const show = () => {
    viewerEpoch.current++;
    const selected = getSelection(); setDraft(input); setSelection(selected); setShown(null); setNotice(""); setOpen(true);
    void act(refresh);
  };
  const prepare = (selected: boolean, ordinary = false) => void act(async () => {
    const target = sessionKey, text = draft;
    const range = selection;
    const ranges = range && range.end > range.start ? [range] : [];
    const prepared = await prepareChatInput(target, crypto.randomUUID(), text, selected ? ranges : [], ordinary ? ranges : []);
    if (scope.current !== target) return;
    setNotice(prepared.references.length
      ? zh ? "消息中包含密码等私密信息，已为你隐藏，助理仍可代你使用。" : "Private details such as passwords have been hidden. Your assistant can still use them for you."
      : zh ? "未发现需要隐藏的密码或密钥。" : "No passwords or keys were detected.");
    setDraft(prepared.text); setSelection(null); replaceInput(prepared.text); await refresh();
  });
  const close = () => { viewerEpoch.current++; setShown(null); setDraft(""); setSelection(null); setOpen(false); };
  return <>
    <button type="button" className={s.trigger} onMouseDown={e => e.preventDefault()} onClick={show}
      title={zh ? "管理这次对话的密码与操作结果" : "Manage passwords and results for this conversation"}>
      {zh ? "密码与结果" : "Passwords & results"}
    </button>
    {open && <Modal open title={zh ? "这次对话的密码与结果" : "Passwords & results for this conversation"} onClose={close} width={640}>
      <div className={s.body}>
        <p>{zh ? "由 Shoggoth 保存的临时密码和密钥，仅供这次对话使用，今天结束后失效。连接器中单独保存的密码和密钥不受影响。" : "Temporary passwords and keys saved by Shoggoth are available only in this conversation and expire at the end of today. Passwords and keys saved separately in Connectors are unaffected."}</p>
        <p>{zh ? "可开启本机语音识别，在发送前处理音视频内容。" : "Enable on-device transcription to process audio and video before sending."}</p>
        {speech?.authorized && speech.onDevice
          ? <p role="status">{zh ? "本机语音识别已开启" : "On-device transcription is enabled"}</p>
          : <div className={s.actions}>
            <button disabled={busy} onClick={() => void act(async () => {
              const epoch = viewerEpoch.current, value = await localSpeechStatus(true);
              if (epoch === viewerEpoch.current) setSpeech(value);
            })}>{zh ? "开启本机语音识别" : "Enable on-device transcription"}</button>
            {speech?.status === "denied" && <p>{zh ? "请在系统设置 → 隐私与安全性 → 语音识别中允许 Shoggoth。" : "Allow Shoggoth in System Settings → Privacy & Security → Speech Recognition."}</p>}
            {speech?.authorized && !speech.onDevice && <p>{zh ? "这台设备尚未提供本机语音识别。" : "On-device transcription is unavailable on this device."}</p>}
          </div>}
        <label>{zh ? "检查消息（可选中需要隐藏的密码或密钥）" : "Review your message (select a password or key to hide)"}
          <textarea ref={editor} value={draft} spellCheck={false} autoComplete="off" onChange={e => { setDraft(e.target.value); setSelection(null); }}
            onSelect={e => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} />
        </label>
        <div className={s.actions}>
          <button disabled={busy || !draft} onClick={() => prepare(false)}>{zh ? "隐藏密码和密钥" : "Hide passwords and keys"}</button>
          <button disabled={busy || !selection || selection.end <= selection.start} onClick={() => prepare(true)}>{zh ? "隐藏选中的私密信息" : "Hide selected private details"}</button>
          <button disabled={busy || !selection || selection.end <= selection.start} onClick={() => prepare(false, true)}>{zh ? "选中内容是普通文本" : "Selected text is ordinary text"}</button>
        </div>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <h3>{zh ? "当天可用" : "Available today"}</h3>
        {!items.length && <p>{zh ? "还没有为这次对话保存密码或密钥" : "No passwords or keys saved for this conversation"}</p>}
        {items.map(item => <div key={item.reference} className={s.row}>
          <span>{zh ? ({ password: "密码", api_key: "API 密钥", token: "访问令牌", private_key: "私钥", secret: "私密信息" }[item.kind] || "私密信息") : item.kind}
            {item.expiresAt ? ` · ${zh ? "有效至 " : "Until "}${new Date(item.expiresAt).toLocaleTimeString()}` : ""}</span>
          <button disabled={busy} onClick={() => void act(async () => { await revokeChatSecret(sessionKey, item.reference); setShown(null); await refresh(); })}>{zh ? "停止使用" : "Stop using"}</button>
        </div>)}
        <h3>{zh ? "已记录的操作" : "Recorded operations"}</h3>
        <p>{zh ? "已完成的操作不会重复执行。你可以在这里查看保存的结果，查看不会把原文发给模型。" : "Completed actions will not be repeated. You can view saved results here without sending the originals to the model."}</p>
        {results.map(item => <div key={item.receiptId} className={s.row}><span>{item.tool} · {zh ? ({ completed: "已完成", unknown: "结果待核对", dispatching: "执行中" }[item.status] || "结果待核对") : item.status}</span>
          <button disabled={busy || item.status !== "completed"} onClick={() => void act(async () => {
            const target = sessionKey, epoch = viewerEpoch.current;
            const result = await readChatSecretResult(target, item.receiptId);
            if (scope.current === target && viewerEpoch.current === epoch) setShown({ text: JSON.stringify(result.result, null, 2), expiresAt: item.originalAvailable ? item.expiresAt : Date.now() + 300000 });
          })}>{zh ? "查看结果" : "View result"}</button>
        </div>)}
        {shown && <pre className={s.result}>{shown.text}</pre>}
      </div>
    </Modal>}
  </>;
}
