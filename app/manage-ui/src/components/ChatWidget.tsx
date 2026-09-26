import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatCanvasWidgetPart } from "../types";
import {
  buildChatWidgetUrl,
  chatWidgetPinSpec,
  clampChatWidgetHeight,
  consumeChatWidgetPromptRate,
  isOwnedChatWidgetWindowMessage,
  normalizeChatWidgetPrompt,
} from "../lib/chatWidget";
import styles from "./ChatWidget.module.css";

type LoadState = "loading" | "approved" | "ready" | "failed";

interface ChatWidgetProps {
  part: ChatCanvasWidgetPart | null;
  backendId: string;
  sessionKey: string;
  onSendPrompt: (sessionKey: string, text: string) => void;
  canPin?: boolean;
  pinned?: boolean;
  pinning?: boolean;
  onPinCanvas?: (spec: { name: string; docId: string }) => void;
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function themeTokens(): Record<string, string> {
  const root = document.querySelector<HTMLElement>(".chat-shell") ?? document.documentElement;
  const computed = getComputedStyle(root);
  const read = (name: string) => computed.getPropertyValue(name).trim();
  const pairs: Array<[string, string]> = [
    ["surface", "--skin-bg-assistant"], ["card", "--card"], ["elevated", "--bg-elevated"],
    ["text", "--muted-strong"], ["text-strong", "--chat-text"], ["muted", "--muted"],
    ["border", "--border"], ["border-strong", "--border-strong"], ["accent", "--accent"],
    ["accent-fill", "--accent"], ["accent-fg", "--accent-fg"], ["ok", "--ui-success"],
    ["warn", "--ui-warning"], ["danger", "--ui-error"], ["info", "--ui-info"],
    ["radius", "--radius-sm"], ["font-body", "--font-body"], ["font-mono", "--mono"],
  ];
  const tokens: Record<string, string> = { "radius-full": "9999px" };
  for (const [token, cssName] of pairs) {
    const value = read(cssName);
    if (value && value.length <= 256) tokens[token] = value;
  }
  return tokens;
}

export default function ChatWidget({
  part,
  backendId,
  sessionKey,
  onSendPrompt,
  canPin = false,
  pinned = false,
  pinning = false,
  onPinCanvas,
}: ChatWidgetProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const promptPortRef = useRef<MessagePort | null>(null);
  const promptTimestampsRef = useRef<number[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [height, setHeight] = useState(() => clampChatWidgetHeight(part?.preview.preferredHeight));
  const widgetUrl = useMemo(
    () => part ? buildChatWidgetUrl(backendId, part.preview.url) : null,
    [backendId, part?.preview.url],
  );

  useEffect(() => {
    setHeight(clampChatWidgetHeight(part?.preview.preferredHeight));
  }, [part?.preview.preferredHeight, part?.preview.url]);

  useEffect(() => {
    promptPortRef.current?.close();
    promptPortRef.current = null;
    promptTimestampsRef.current = [];
    if (!widgetUrl) {
      setLoadState("failed");
      return;
    }
    const controller = new AbortController();
    setLoadState("loading");
    void fetch(widgetUrl, {
      method: "HEAD",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) throw new Error(`widget document unavailable (${response.status})`);
      setLoadState("approved");
    }).catch(() => {
      if (!controller.signal.aborted) setLoadState("failed");
    });
    return () => controller.abort();
  }, [attempt, sessionKey, widgetUrl]);

  useEffect(() => {
    const postTheme = () => {
      const target = frameRef.current?.contentWindow;
      if (!target) return;
      target.postMessage({ type: "openclaw:widget-theme", mode: currentTheme(), tokens: themeTokens() }, "*");
      target.postMessage({ type: "openclaw:widget-chat-host" }, "*");
    };
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || !isOwnedChatWidgetWindowMessage(event.source, event.origin, frame.contentWindow)) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "openclaw:widget-size") {
        if (typeof data.height === "number" && Number.isFinite(data.height)) {
          setHeight(clampChatWidgetHeight(data.height));
        }
        return;
      }
      if (data.type !== "openclaw:widget-prompt-offer") return;
      if (event.ports.length !== 1) {
        event.ports.forEach((port) => port.close());
        return;
      }
      const offeredPort = event.ports[0];
      if (promptPortRef.current) {
        offeredPort.close();
        return;
      }
      promptPortRef.current = offeredPort;
      offeredPort.addEventListener("message", (portEvent) => {
        const message = portEvent.data as Record<string, unknown> | null;
        if (!message || message.type !== "openclaw:widget-prompt") return;
        const activeFrame = frameRef.current;
        const userActivation = navigator.userActivation;
        const text = normalizeChatWidgetPrompt(message.prompt, {
          documentVisible: document.visibilityState === "visible",
          documentFocused: document.hasFocus(),
          frameFocused: !!activeFrame && document.activeElement === activeFrame,
          userActivated: userActivation?.isActive === true,
        });
        if (text && consumeChatWidgetPromptRate(promptTimestampsRef.current, Date.now())) {
          onSendPrompt(sessionKey, text);
        }
      });
      offeredPort.start();
      offeredPort.postMessage({ type: "openclaw:widget-prompt-host-ready" });
      setLoadState("ready");
      postTheme();
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      promptPortRef.current?.close();
      promptPortRef.current = null;
    };
  }, [attempt, onSendPrompt, sessionKey, widgetUrl]);

  useEffect(() => {
    if (loadState !== "approved") return;
    const timer = window.setTimeout(() => setLoadState((state) => state === "approved" ? "failed" : state), 10_000);
    return () => window.clearTimeout(timer);
  }, [loadState]);

  const title = part?.preview.title?.trim() || t("chat.widgetTitle");
  const pinSpec = chatWidgetPinSpec(part);
  const header = (
    <div className={styles.header}>
      <span>{title}</span>
      {canPin && pinSpec && onPinCanvas ? (
        <button
          type="button"
          className={styles.pin}
          disabled={pinned || pinning}
          onClick={() => onPinCanvas(pinSpec)}
        >
          {pinned ? t("chat.widgetPinned") : pinning ? t("chat.widgetPinning") : t("chat.widgetPin")}
        </button>
      ) : null}
    </div>
  );
  if (!part || !widgetUrl) {
    return (
      <div className={styles.widget}>
        {header}
        <div className={styles.status} role="status">{t("chat.widgetInvalid")}</div>
      </div>
    );
  }
  if (loadState === "failed") {
    return (
      <div className={styles.widget}>
        {header}
        <div className={styles.status} role="status">
          <span>{t("chat.widgetLoadFailed")}</span>
          <button type="button" className={styles.retry} onClick={() => setAttempt((value) => value + 1)}>
            {t("chat.widgetRetry")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.widget} aria-busy={loadState !== "ready"}>
      {header}
      {loadState === "loading" ? <div className={styles.status}>{t("chat.widgetLoading")}</div> : null}
      {loadState === "approved" || loadState === "ready" ? (
        <iframe
          key={`${sessionKey}:${widgetUrl}:${attempt}`}
          ref={frameRef}
          className={styles.frame}
          src={widgetUrl}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ height }}
          onLoad={() => {
            const target = frameRef.current?.contentWindow;
            target?.postMessage({ type: "openclaw:widget-theme", mode: currentTheme(), tokens: themeTokens() }, "*");
            target?.postMessage({ type: "openclaw:widget-chat-host" }, "*");
          }}
          onError={() => setLoadState("failed")}
        />
      ) : null}
    </div>
  );
}
