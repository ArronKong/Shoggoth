import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionBoardWidget } from "../../types";
import {
  mountSessionBoardWidgetLease,
  mintSessionBoardWidget,
  revokeSessionBoardWidget,
  type SessionBoardWidgetLease,
} from "./sessionBoardWidgetHost";
import styles from "./SessionBoardView.module.css";

type HostState = "loading" | "mounting" | "ready" | "failed";

function themePayload(): { mode: "light" | "dark"; tokens: Record<string, string> } {
  const root = document.querySelector<HTMLElement>(".chat-shell") ?? document.documentElement;
  const computed = getComputedStyle(root);
  const allowlist: Array<[string, string]> = [
    ["surface", "--skin-bg-assistant"], ["card", "--card"], ["text", "--chat-text"],
    ["muted", "--muted"], ["border", "--border"], ["accent", "--accent"],
    ["ok", "--ui-success"], ["warn", "--ui-warning"], ["danger", "--ui-error"],
    ["font-body", "--font-body"], ["font-mono", "--mono"], ["radius", "--radius-sm"],
  ];
  const tokens: Record<string, string> = {};
  for (const [name, cssName] of allowlist) {
    const value = computed.getPropertyValue(cssName).trim();
    if (value && value.length <= 256) tokens[name] = value;
  }
  return {
    mode: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
    tokens,
  };
}

export default function SessionBoardHtmlWidget({
  backendId,
  agentId,
  sessionKey,
  widget,
  hostGeneration,
}: {
  backendId: string;
  agentId: string;
  sessionKey: string;
  widget: SessionBoardWidget & { instanceId: string };
  hostGeneration: string;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const epochRef = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<HostState>("loading");
  const [lease, setLease] = useState<SessionBoardWidgetLease | null>(null);
  const [height, setHeight] = useState(320);
  const identity = useMemo(
    () => `${backendId}\0${agentId}\0${sessionKey}\0${widget.name}\0${widget.revision}\0${widget.instanceId}\0${hostGeneration}`,
    [agentId, backendId, hostGeneration, sessionKey, widget.instanceId, widget.name, widget.revision],
  );

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    let issued: SessionBoardWidgetLease | null = null;
    setState("loading");
    setLease(null);
    setHeight(320);
    void mintSessionBoardWidget(backendId, agentId, sessionKey, widget)
      .then(async (nextLease) => {
        issued = nextLease;
        if (epochRef.current !== epoch || controller.signal.aborted) return;
        const response = await fetch(nextLease.frameUrl, {
          method: "HEAD",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("BOARD_WIDGET_HEAD_FAILED");
        if (epochRef.current !== epoch || controller.signal.aborted) return;
        setLease(nextLease);
        setState("mounting");
      })
      .catch(() => {
        if (issued) void revokeSessionBoardWidget(issued.ticketId);
        if (epochRef.current === epoch && !controller.signal.aborted) setState("failed");
      })
      .finally(() => {
        if (issued && (epochRef.current !== epoch || controller.signal.aborted)) {
          void revokeSessionBoardWidget(issued.ticketId);
        }
      });
    return () => {
      controller.abort();
      epochRef.current += 1;
      if (issued) void revokeSessionBoardWidget(issued.ticketId);
    };
  }, [attempt, identity]);

  useLayoutEffect(() => {
    if (!lease) return;
    const epoch = epochRef.current;
    const frame = frameRef.current;
    if (!frame) return;
    return mountSessionBoardWidgetLease({
      frame,
      lease,
      getTheme: themePayload,
      onReady: () => {
        if (epochRef.current === epoch) setState("ready");
      },
      onHeight: (nextHeight) => {
        if (epochRef.current === epoch) setHeight(nextHeight);
      },
      onFailure: () => {
        if (epochRef.current !== epoch) return;
        setLease(null);
        setState("failed");
      },
    });
  }, [lease]);

  if (state === "failed") {
    return (
      <div className={styles.widgetHostState} role="status">
        <span>{t("chat.board.widgetLoadFailed")}</span>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t("chat.board.widgetRetry")}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.widgetHost} aria-busy={state !== "ready"}>
      {state === "loading" ? <div className={styles.widgetHostState}>{t("chat.board.widgetLoading")}</div> : null}
      {lease ? (
        <iframe
          ref={frameRef}
          className={styles.widgetFrame}
          title={widget.title || widget.name}
          sandbox="allow-scripts"
          allow=""
          referrerPolicy="origin"
          style={{ height }}
        />
      ) : null}
    </div>
  );
}
