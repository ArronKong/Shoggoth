import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useTranslation } from "react-i18next";
import { getContextBreakdown } from "../api/contextBreakdown";
import { contextParts, meterPercentLabel, type ContextMeter } from "../lib/chatContextMeter";
import type { ChatResponseMetadata, ContextBreakdown, ProductContextState } from "../types";
import "../i18n/contextMeterResources";
import styles from "./ChatContextMeter.module.css";

interface Props {
  meter: ContextMeter;
  backend: string;
  agentId: string;
  sessionKey: string;
  native: boolean;
  reply: { runId: string; context?: ChatResponseMetadata["context"] } | null;
  product?: ProductContextState;
  busy: boolean;
  compacting: boolean;
  onCompact?: () => void;
}

export default function ChatContextMeter({ meter, backend, agentId, sessionKey, native, reply, product, busy, compacting, onCompact }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ContextBreakdown | null>(null);
  const [failedRun, setFailedRun] = useState<string | null>(null);
  const runId = reply?.runId;

  useEffect(() => {
    if (!open || !runId || snapshot?.runId === runId) return;
    const controller = new AbortController();
    setFailedRun(null);
    getContextBreakdown(backend, agentId, sessionKey, runId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.runId === runId) setSnapshot(data);
      else setFailedRun(runId);
    }).catch(() => { if (!controller.signal.aborted) setFailedRun(runId); });
    return () => controller.abort();
  }, [open, backend, agentId, sessionKey, runId, snapshot?.runId]);

  const { usedTokens: used, contextWindow: capacity, percent, estimated } = meter;
  const percentLabel = meterPercentLabel(meter);
  const locale = i18n.resolvedLanguage || i18n.language;
  const number = (n: number) => n.toLocaleString(locale, n < 10_000 ? {} : { notation: "compact", maximumFractionDigits: 1 });
  const share = (n: number) => n > 0 && n / capacity < 0.001 ? "<0.1%" :
    (n / capacity).toLocaleString(locale, { style: "percent", maximumFractionDigits: 1 });
  const composition = snapshot && snapshot.runId === runId ? snapshot.composition : null;
  const breakdown = composition ? contextParts(composition, meter, reply?.context) : null;
  const free = Math.max(0, capacity - used);
  const budget = product?.budget;
  const trigger = product?.automatic === "enabled" && budget?.tokens === capacity
    && ["runtime", "catalog", "last_observed"].includes(budget.source) ? budget.triggerTokens : null;
  const status = !native ? "totalsOnly" : !runId || snapshot?.runId === runId ? "unavailable"
    : failedRun === runId ? "failed" : "loading";

  const row = (key: string, label: string, tokens: number, portion: string | null, hint?: string) => (
    <li key={key} data-part={key} title={hint} className={styles.row}>
      <span className={styles.dot} aria-hidden="true" /><span>{label}</span>
      <span className={styles.value} title={tokens.toLocaleString(locale)}>{number(tokens)}</span>
      <span className={styles.share}>{portion ?? "—"}</span>
    </li>
  );

  return <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
    <Popover.Trigger type="button" className={styles.trigger} data-chat-context-trigger data-level={meter.level} openOnHover delay={120} closeDelay={150}
      aria-label={t("contextMeter.details") + " · " + percentLabel}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none" strokeWidth="2.5">
        <circle className={styles.track} cx="10" cy="10" r="8" />
        <circle className={styles.fill} cx="10" cy="10" r="8" pathLength="100" strokeDasharray={`${percent} 100`}
          transform="rotate(-90 10 10)" />
      </svg>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className={`chat-surface ${styles.positioner}`} side="top" align="center" sideOffset={7} collisionPadding={10}>
        <Popover.Popup className={styles.panel} data-chat-context-details data-level={meter.level} aria-label={t("contextMeter.details")}
          initialFocus={type => type === "keyboard"}>
          <header className={styles.header}>
            <Popover.Title className={styles.title}>{t("chat.nativeContextLabel")}</Popover.Title>
            <span className={styles.unit}>{product && ["restored", "stale"].includes(product.measurement)
              ? t(`chat.contextMeasurement.${product.measurement}`) + " · " : ""}{estimated ? t("chat.nativeContextQuality.estimated") + " · " : ""}Tokens</span>
          </header>
          <div className={styles.summary}>
            <strong>{t("contextMeter.used", { percent: percentLabel })}</strong>
            <span title={`${used.toLocaleString(locale)} / ${capacity.toLocaleString(locale)}`}>{number(used)} / {number(capacity)}</span>
          </div>
          <div className={styles.bar} aria-hidden="true">
            {(breakdown?.reconciled ? breakdown.parts : [{ key: "used", tokens: used }]).map(({ key, tokens }) =>
              <span key={key} data-part={key} style={{ width: `${tokens / Math.max(capacity, used) * 100}%` }} />)}
          </div>

          {breakdown ? <>
            <div className={styles.sectionTitle}>{t(breakdown.reconciled ? "contextMeter.estimate" : "contextMeter.previous")}</div>
            <ul className={styles.rows}>
              {breakdown.parts.map(({ key, tokens }) => row(key, t(`contextMeter.${key}`), tokens,
                breakdown.reconciled ? share(tokens) : null, key === "other" ? t("contextMeter.otherHint") : undefined))}
            </ul>
            {!breakdown.reconciled && <p className={styles.note}>{t("contextMeter.separate")}</p>}
          </> : <p className={styles.note} role="status">{t(`contextMeter.${status}`)}</p>}
          <ul className={`${styles.rows} ${styles.space}`}>
            {row("free", t("contextMeter.free"), free, share(free))}
            {breakdown?.catalog && row("catalog", t("contextMeter.catalog", { count: breakdown.catalog.count }),
              breakdown.catalog.tokens, null, t("contextMeter.catalogHint"))}
          </ul>
          {(trigger !== null || onCompact) && <footer className={styles.footer}>
            {trigger !== null && <span>{t(used >= trigger ? "contextMeter.thresholdReached" : "contextMeter.untilThreshold",
              { tokens: number(used >= trigger ? trigger : trigger - used) })}</span>}
            {onCompact && <button type="button" className={styles.compact} disabled={busy || compacting} onClick={onCompact}>
              {t(compacting ? "contextMeter.compacting" : "contextMeter.compact")}</button>}
          </footer>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
