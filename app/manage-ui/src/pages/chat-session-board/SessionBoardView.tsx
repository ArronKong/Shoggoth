import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionBoardResult, SessionBoardWidget } from "../../types";
import {
  canApproveSessionBoardGrant,
  canRejectSessionBoardGrant,
  orderedSessionBoardTabs,
  orderedSessionBoardWidgets,
  safeSessionBoardSpan,
  sessionBoardContentPresentation,
} from "./sessionBoardModel";
import SessionBoardHtmlWidget from "./SessionBoardHtmlWidget";
import { hostableSessionBoardWidget } from "./sessionBoardWidgetHost";
import styles from "./SessionBoardView.module.css";

export default function SessionBoardView({
  result,
  loading,
  mutating,
  onRefresh,
  onMove,
  onRemove,
  onGrant,
  stale = false,
  backendId,
  agentId,
  sessionKey,
  hostGeneration,
}: {
  result: SessionBoardResult | null;
  loading: boolean;
  mutating: boolean;
  onRefresh: () => void;
  onMove: (widget: SessionBoardWidget, position: number) => void;
  onRemove: (widget: SessionBoardWidget) => void;
  onGrant: (widget: SessionBoardWidget, decision: "granted" | "rejected") => void;
  stale?: boolean;
  backendId: string;
  agentId: string;
  sessionKey: string;
  hostGeneration: string;
}) {
  const { t } = useTranslation();
  const tabs = useMemo(
    () => orderedSessionBoardTabs(result?.snapshot?.tabs ?? []),
    [result?.snapshot?.tabs],
  );
  const [selectedTabId, setSelectedTabId] = useState("");

  useEffect(() => {
    setSelectedTabId((current) => tabs.some((tab) => tab.tabId === current) ? current : tabs[0]?.tabId ?? "");
  }, [tabs]);

  const widgets = useMemo(
    () => orderedSessionBoardWidgets(result?.snapshot?.widgets ?? [], selectedTabId),
    [result?.snapshot?.widgets, selectedTabId],
  );

  if (loading && !result) {
    return <div className={styles.state} role="status">{t("chat.board.loading")}</div>;
  }
  if (!result?.supported || result.methods["board.get"] !== true || !result.snapshot) {
    return (
      <div className={styles.state} role="status">
        <strong>{t("chat.board.unsupportedTitle")}</strong>
        <span>{t("chat.board.unsupported")}</span>
      </div>
    );
  }

  const canLayout = result.methods["board.update"] === true;
  return (
    <section className={styles.board} aria-label={t("chat.board.title")} aria-busy={loading || mutating}>
      <header className={styles.header}>
        <div>
          <h2>{t("chat.board.title")}</h2>
          <span>{t("chat.board.revision", { revision: result.snapshot.revision })}</span>
        </div>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={loading || mutating}>
          {t("chat.board.refresh")}
        </button>
      </header>
      {stale ? <div className={styles.stale} role="status">{t("chat.board.stale")}</div> : null}

      {tabs.length ? (
        <div className={styles.tabs} role="tablist" aria-label={t("chat.board.tabs")}>
          {tabs.map((tab) => (
            <button
              key={tab.tabId}
              type="button"
              role="tab"
              aria-selected={tab.tabId === selectedTabId}
              className={tab.tabId === selectedTabId ? styles.activeTab : styles.tab}
              onClick={() => setSelectedTabId(tab.tabId)}
            >
              {tab.title}
            </button>
          ))}
        </div>
      ) : null}

      {!tabs.length ? (
        <div className={styles.empty}>{t("chat.board.empty")}</div>
      ) : !widgets.length ? (
        <div className={styles.empty}>{t("chat.board.emptyTab")}</div>
      ) : (
        <div className={styles.grid}>
          {widgets.map((widget, index) => {
            const canReject = canRejectSessionBoardGrant(result, widget);
            const canApprove = canApproveSessionBoardGrant(result, widget);
            const access = widget.accessSummary;
            const contentPresentation = sessionBoardContentPresentation(widget);
            const hostable = hostableSessionBoardWidget(widget);
            return (
              <article
                key={widget.name}
                className={styles.card}
                style={{ gridColumn: `span ${safeSessionBoardSpan(widget.sizeW)}` }}
                data-content-kind={widget.content.kind}
              >
                <div className={styles.cardHead}>
                  <div className={styles.identity}>
                    <strong>{widget.title || widget.name}</strong>
                    <span>{t(`chat.board.contentKind.${widget.content.kind}`)}</span>
                  </div>
                  <span className={`${styles.grant} ${styles[`grant_${widget.grantState}`]}`}>
                    {t(`chat.board.grantState.${widget.grantState}`)}
                  </span>
                </div>

                {contentPresentation === "host" && !stale && hostable ? (
                  <SessionBoardHtmlWidget
                    backendId={backendId}
                    agentId={agentId}
                    sessionKey={sessionKey}
                    widget={widget}
                    hostGeneration={hostGeneration}
                  />
                ) : <div className={styles.placeholder}>
                  <span aria-hidden="true">◇</span>
                  <strong>{t("chat.board.safeHostPending")}</strong>
                  <small>{t("chat.board.safeHostNote")}</small>
                </div>}

                {access && (access.networkOrigins.length > 0 || access.tools.length > 0) ? (
                  <div className={styles.access}>
                    {access.networkOrigins.length > 0 ? (
                      <section>
                        <strong>{t("chat.board.networkAccess", { count: access.networkOrigins.length })}</strong>
                        <ul>{access.networkOrigins.map((origin) => <li key={origin}><code>{origin}</code></li>)}</ul>
                      </section>
                    ) : null}
                    {access.tools.length > 0 ? (
                      <section>
                        <strong>{t("chat.board.toolAccess", { count: access.tools.length })}</strong>
                        <ul>{access.tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {widget.grantState === "pending" && (!access || !widget.instanceId) ? (
                  <div className={styles.grantUnavailable}>{t("chat.board.grantUnavailable")}</div>
                ) : null}

                {canReject || canApprove ? (
                  <div className={styles.actions}>
                    {canReject ? (
                      <button type="button" onClick={() => onGrant(widget, "rejected")} disabled={mutating}>
                        {t("chat.board.reject")}
                      </button>
                    ) : null}
                    {canApprove ? (
                      <button type="button" className={styles.allow} onClick={() => onGrant(widget, "granted")} disabled={mutating}>
                        {t("chat.board.allow")}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {canLayout ? (
                  <div className={styles.layoutActions}>
                    <button
                      type="button"
                      aria-label={t("chat.board.moveEarlier")}
                      title={t("chat.board.moveEarlier")}
                      onClick={() => onMove(widget, index - 1)}
                      disabled={mutating || index === 0}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      aria-label={t("chat.board.moveLater")}
                      title={t("chat.board.moveLater")}
                      onClick={() => onMove(widget, index + 1)}
                      disabled={mutating || index === widgets.length - 1}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => onRemove(widget)}
                      disabled={mutating}
                    >
                      {t("chat.board.remove")}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
