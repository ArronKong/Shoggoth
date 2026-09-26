import { useTranslation } from "react-i18next";
import { useState } from "react";
import type { RuntimeContextCapabilities, RuntimeContextUsage, ProductContextState } from "../types";
import styles from "./ChatContextUsage.module.css";

export default function ChatContextUsage({ usage, capabilities, product, busy, onCompact }: {
  usage: RuntimeContextUsage | null;
  capabilities: RuntimeContextCapabilities;
  product?: ProductContextState;
  busy: boolean;
  onCompact: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const known = usage && usage.quality !== "unknown" && usage.usedTokens !== null;
  const window = product?.budget.tokens ?? usage?.contextWindow ?? null;
  const confirmed = !product || ["runtime", "catalog", "last_observed"].includes(product.budget.source);
  const percent = known && confirmed && window !== null && product?.measurement !== "stale"
    ? Math.min(100, Math.round(usage.usedTokens! / window * 100)) : null;
  const quality = known ? usage.quality : "unknown";
  const compact = product?.automatic === "enabled" || capabilities["context.compact.native"];
  const warning = percent !== null && percent >= 93 && product?.automatic !== "enabled";
  const number = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return <div className={styles.row} data-quality={quality}>
    <span className={styles.value} title={t("chat.nativeContextHint")}>
      {t("chat.nativeContextLabel")}{" "}
      {known ? <>{percent === null ? "" : `${percent}% · `}{number(usage.usedTokens!)}
        {window === null || !confirmed ? "" : ` / ${number(window)}`}</> : t(`chat.contextMeasurement.${product?.measurement || "missing"}`)}
      {known && <span className={styles.quality}>{t(`chat.nativeContextQuality.${quality}`)}</span>}
      {known && product && ["restored", "stale"].includes(product.measurement) && <span className={styles.quality}
        title={new Date(usage.observedAt).toLocaleString()}>{t(`chat.contextMeasurement.${product.measurement}`)}</span>}
    </span>
    {product && <span className={styles.quality}
      title={t("chat.contextBudgetHint", { trigger: number(product.budget.triggerTokens), retained: number(product.budget.retainedTokens) })}>
      {t(`chat.contextBudgetSource.${product.budget.source}`, { tokens: number(product.budget.tokens) })}
    </span>}
    {product?.transfer && <span className={styles.quality} data-transfer={product.transfer.state}
      title={t(`chat.contextTransferMode.${product.transfer.mode}`) + (product.transfer.errorCode ? ` (${product.transfer.errorCode})` : "")}>
      {t(`chat.contextTransferState.${product.transfer.state}`)}
      {["ready", "accepted"].includes(product.transfer.state) && ` · ${t(`chat.contextTransferMode.${product.transfer.mode}`)}`}
    </span>}
    {product && <span className={styles.quality} title={t("chat.productContextHint", {
      runtime: product.summaryRuntime || "—", model: product.summaryModel || t("chat.contextDefaultModel"), seq: product.coveredThroughSeq })
      + " " + t("chat.contextBudgetHint", { trigger: number(product.budget.triggerTokens), retained: number(product.budget.retainedTokens) })}>
      {t(product.pendingRunId ? "chat.productContextPending" : product.lastError ? "chat.productContextFailed"
        : `chat.productContextAutomatic.${product.automatic}`)}</span>}
    {compact && <button type="button" className={styles.compact} disabled={busy || pending || !!product?.pendingRunId}
      onClick={() => { setPending(true); Promise.resolve().then(onCompact).catch(() => {}).finally(() => setPending(false)); }}
      title={t(product?.automatic === "enabled" ? "chat.productCompactHint" : "chat.nativeCompactHint")}>{t("chat.nativeCompact")}</button>}
    {warning && <span className={styles.warning}>{t(compact ? "chat.nativeContextFull" : "chat.nativeContextFullNoCompact")}</span>}
  </div>;
}
