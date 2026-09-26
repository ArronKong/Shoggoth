import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, connectPluginBearer } from "../api/client";
import styles from "./PluginBearerConnect.module.css";

export function PluginBearerConnect({ agentId, installationId, componentId, revision,
  disabled, connected, onReady }: {
  agentId: string; installationId: string; componentId: string; revision: number;
  disabled: boolean; connected: boolean; onReady: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled) return;
    const accessToken = input.current?.value.trim() || "";
    if (input.current) input.current.value = "";
    if (!accessToken) { setError("empty"); return; }
    setBusy(true); setError(null);
    try {
      const result = await connectPluginBearer({ agentId, installationId, componentId,
        expectedRevision: revision, operationId: crypto.randomUUID(), accessToken });
      if (!result.canceled) { setOpen(false); onReady(); }
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.code ?? "unavailable" : "unavailable");
    } finally { setBusy(false); }
  };
  return <div className={styles.control}>
    <button className="btn-secondary" type="button" disabled={disabled || busy}
      aria-expanded={open} onClick={() => { setOpen(value => !value); setError(null); }}>
      {t(connected ? "plugins.bearerReconnect" : "plugins.bearerConnect")}
    </button>
    {open && <form className={styles.form} onSubmit={event => void submit(event)}>
      <label htmlFor={`plugin-bearer-${componentId}`}>{t("plugins.bearerTokenLabel")}</label>
      <input ref={input} id={`plugin-bearer-${componentId}`} className="field-input"
        type="password" autoComplete="off" spellCheck={false} disabled={disabled || busy}
        placeholder="github_pat_…" aria-invalid={Boolean(error)} />
      <span className={styles.hint}>{t("plugins.bearerTokenHint")}</span>
      <div className={styles.actions}>
        <button className="btn-secondary" type="button" disabled={busy}
          onClick={() => { if (input.current) input.current.value = ""; setOpen(false); setError(null); }}>
          {t("common.cancel")}
        </button>
        <button className="btn-secondary" type="submit" disabled={disabled || busy}>
          {t(busy ? "plugins.bearerVerifying" : "plugins.bearerSubmit")}
        </button>
      </div>
      {error && <span role="alert">{t(error === "empty" ? "plugins.bearerEmpty"
        : error === "CONNECTION_AUTH_REQUIRED" ? "plugins.bearerInvalid"
          : "plugins.bearerFailed")}</span>}
    </form>}
  </div>;
}
