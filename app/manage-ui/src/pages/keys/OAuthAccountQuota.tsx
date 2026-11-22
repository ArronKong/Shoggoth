import { useId, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import type { OAuthProvider } from "../../types";
import { canReadOAuthAccountQuota, readCachedOAuthQuota, refreshOAuthQuota, subscribeOAuthQuota } from "../../lib/oauthAccountQuota";
import styles from "./OAuthAccountQuota.module.css";

function quotaDuration(minutes: number, locale: string) {
  if (minutes % 1440 === 0) return new Intl.NumberFormat(locale, { style: "unit", unit: "day" }).format(minutes / 1440);
  if (minutes % 60 === 0) return new Intl.NumberFormat(locale, { style: "unit", unit: "hour" }).format(minutes / 60);
  return new Intl.NumberFormat(locale, { style: "unit", unit: "minute" }).format(minutes);
}

function formatBalance(amount: number, unit: "credits" | "USD" | "CNY", locale: string) {
  const precision = amount > 0 && amount < 0.01 ? { maximumSignificantDigits: 6 } : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat(locale, unit === "credits"
    ? precision
    : { style: "currency", currency: unit, ...precision }).format(amount);
}

export default function OAuthAccountQuota({ trigger, account, backend, title, onAccountChanged }: {
  trigger: ReactElement;
  account: OAuthProvider;
  backend: string;
  title: string;
  onAccountChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const triggerId = useId();
  const [open, setOpen] = useState(false);
  const snapshot = useSyncExternalStore(subscribeOAuthQuota, () => readCachedOAuthQuota(backend, account));
  const canRead = canReadOAuthAccountQuota(account);
  const result = canRead && snapshot?.status === "available" ? snapshot : undefined;
  const statusKey = !account.canReadQuota ? "keys.oauthQuotaNotIntegrated"
    : !canRead || snapshot?.status === "unsupported" ? "keys.oauthQuotaUnsupported"
    : snapshot?.status === "unavailable" ? "keys.oauthQuotaUnavailable" : "keys.oauthQuotaLoading";
  const locale = i18n.resolvedLanguage || i18n.language;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const credits = result?.credits;

  const changeOpen = (next: boolean) => {
    if (next === open) return;
    if (next && canRead) void refreshOAuthQuota(backend, account).then(changed => { if (changed) onAccountChanged(); });
    setOpen(next);
  };

  return <Popover.Root open={open} triggerId={triggerId} onOpenChange={(next, details) => {
    if (details.reason === "trigger-press") details.cancel();
    else changeOpen(next);
  }}>
    <Popover.Trigger id={triggerId} render={trigger} openOnHover delay={180} closeDelay={120}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) changeOpen(true); }} />
    <Popover.Portal>
      <Popover.Positioner className={styles.positioner} side="bottom" align="start" sideOffset={5} collisionPadding={10}>
        <Popover.Popup className={styles.quota} initialFocus={false} finalFocus={false}
          aria-label={`${title} · ${t("keys.oauthQuota")}`}>
          <div aria-live="polite">
            <div className={styles.heading}>
              <div className={styles.titleRow}>
                <div className={styles.title}>{title}</div>
                {result && <time className={styles.checkedAt} dateTime={new Date(result.checkedAt).toISOString()}>
                  {t("keys.oauthQuotaCheckedAt", { time: dateTime.format(result.checkedAt) })}
                </time>}
              </div>
              {result?.accountName && <div className={styles.identity} dir="auto">
                {result.accountName}
              </div>}
              {!result && <div className={styles.identity}>{t(statusKey)}</div>}
            </div>
            {result && result.windows.length > 0 && <ul className={styles.windows}>
              {result.windows.map(({ label, durationMinutes, usedPercent, resetsAt }, index) => {
                const duration = durationMinutes === null ? null : quotaDuration(durationMinutes, locale);
                const windowLabel = [label, duration].filter(Boolean).join(" · ") || t("keys.oauthQuotaWindow");
                const remaining = 100 - usedPercent;
                const remainder = t("keys.oauthQuotaRemaining", { percent: percent.format(remaining / 100) });
                return <li className={styles.window} key={index}>
                  <div className={styles.windowValues}>
                    <span>{windowLabel}</span>
                    <span className={styles.remaining}>{remainder}</span>
                  </div>
                  <progress className={styles.meter} data-low={remaining <= 10} value={remaining} max={100}
                    aria-label={`${windowLabel} · ${remainder}`} />
                  {resetsAt !== null && <time className={styles.reset} dateTime={new Date(resetsAt).toISOString()}>
                    {t("keys.oauthQuotaResetsAt", { time: dateTime.format(resetsAt) })}
                  </time>}
                </li>;
              })}
            </ul>}
            {(credits || result?.resetCredits) && <div className={styles.credits}>
              {credits?.kind === "wallets" ? credits.wallets.map(({ kind, amount, unit }) =>
                <div className={styles.credit} key={`${kind}:${unit}`}>
                  <span>{t(kind === "bonus" ? "keys.oauthQuotaBonus" : "keys.oauthQuotaBalance")}</span>
                  <strong>{formatBalance(amount, unit, locale)}</strong>
                </div>)
                : credits?.kind === "present" ? <div className={styles.credit}>{t("keys.oauthQuotaCreditsPresent")}</div>
                : credits && <div className={styles.credit}>
                  <span>{t(credits.kind === "balance" && credits.unit !== "credits" ? "keys.oauthQuotaBalance" : "keys.oauthQuotaCredits")}</span>
                  <strong>{credits.kind === "balance" ? formatBalance(credits.amount, credits.unit, locale)
                    : t("keys.oauthQuotaUnlimited")}</strong>
                </div>}
              {result?.resetCredits && <div className={styles.credit}>
                <span>{t("keys.oauthQuotaResetCredits")}</span>
                <strong>{new Intl.NumberFormat(locale).format(result.resetCredits)}</strong>
              </div>}
            </div>}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
