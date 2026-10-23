import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, activatePlugin, getPluginSecrets, getPluginSetup, setPluginSecret,
  type PluginSecretDestination, type PluginSecrets, type PluginSetup } from "../api/client";
import styles from "./PluginQuickSetup.module.css";

// One confirmed "enable" plus write-only fields for the plugin's declared
// `${secret:NAME}` credentials. Values are sent once and never read back.
export function PluginQuickSetup({ agentId, installationId, revision, disabled, onChanged }: {
  agentId: string; installationId: string; revision: number; disabled: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<PluginSetup | null>(null);
  const [secrets, setSecrets] = useState<PluginSecrets | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [nextSetup, nextSecrets] = await Promise.all([getPluginSetup(agentId, installationId),
        getPluginSecrets(agentId, installationId)]);
      if (generation.current === current) { setSetup(nextSetup); setSecrets(nextSecrets); }
    } catch {
      if (generation.current === current) setMessage({ kind: "alert", text: t("plugins.quickSetupUnavailable") });
    }
  }, [agentId, installationId, t]);
  useEffect(() => { setSetup(null); setSecrets(null); setMessage(null); setBusy(null); }, [agentId, installationId]);
  // A new revision (for example the enable this panel just made) only rereads
  // state, so the result message stays visible.
  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load, revision]);
  if (!setup || (!setup.components.length && !secrets?.items.length)) {
    return message ? <span role={message.kind}>{message.text}</span> : null;
  }
  const failure = (error: unknown) => setMessage({ kind: "alert", text: t("plugins.quickSetupFailed", {
    code: error instanceof ApiError && error.code ? error.code : "unavailable" }) });
  const activate = async () => {
    setBusy("activate"); setMessage(null);
    try {
      const { canceled, result } = await activatePlugin({ agentId, installationId, expectedRevision: setup.revision });
      if (!canceled && result) {
        const rejected = result.components.filter(item => item.reason === "PLUGIN_SECRET_REJECTED").map(item => item.name);
        const pending = result.components.filter(item => item.state !== "ready").map(item => item.name);
        setMessage(rejected.length ? { kind: "alert", text: t("plugins.secretRejected", { names: rejected.join("、") }) }
          : { kind: "status", text: pending.length
            ? t("plugins.quickEnablePartial", { names: pending.join("、") }) : t("plugins.quickEnableDone") });
        onChanged();
      }
      await load();
    } catch (error) { failure(error); } finally { setBusy(null); }
  };
  const change = async (name: string, value: string | null) => {
    setBusy(name); setMessage(null);
    try {
      const { canceled, result } = await setPluginSecret({ agentId, installationId, name, value });
      if (!canceled && result) {
        const failed = value === null ? []
          : result.components.filter(item => item.state === "connection_failed");
        const rejected = failed.filter(item => item.reason === "PLUGIN_SECRET_REJECTED").map(item => item.name);
        setMessage({ kind: failed.length ? "alert" : "status", text: rejected.length
          ? t("plugins.secretRejected", { names: rejected.join("、") }) : failed.length
            ? t("plugins.secretSavedConnectFailed", { names: failed.map(item => item.name).join("、") })
            : t(value === null ? "plugins.secretCleared" : "plugins.secretSaved", { name }) });
        onChanged();
      }
      await load();
    } catch (error) { failure(error); } finally { setBusy(null); }
  };
  const submit = (event: FormEvent<HTMLFormElement>, name: string) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("value") as HTMLInputElement | null;
    const value = field?.value.trim() || "";
    if (field) field.value = "";
    if (value.length < 8) { setMessage({ kind: "alert", text: t("plugins.secretTooShort") }); return; }
    void change(name, value);
  };
  const where = (item: PluginSecretDestination) => item.kind === "env"
    ? t("plugins.secretEnvDestination", { component: item.component, key: item.key })
    : t("plugins.secretHeaderDestination", { origin: item.origin || item.component, key: item.key });
  const activatable = setup.nextSteps.includes("activate") || setup.desiredState === "disabled";
  return <section className={styles.panel} aria-label={t("plugins.quickSetupTitle")}>
    <div className={styles.header}>
      <strong>{t("plugins.quickSetupTitle")}</strong>
      {activatable && <button className="btn-secondary" type="button" disabled={disabled || busy !== null}
        onClick={() => void activate()}>{t(busy === "activate" ? "plugins.quickEnabling" : "plugins.quickEnable")}</button>}
    </div>
    {setup.components.length > 0 && <ul className={styles.components}>
      {setup.components.map(item => <li key={item.componentId}>
        <span>{item.name}</span>
        <span>{t(`plugins.quickState_${item.state}`)}</span>
        {item.state === "ready" && item.tools !== null
          && <span>{t("plugins.quickTools", { granted: item.granted, total: item.tools })}</span>}
        <code>{item.target}</code>
      </li>)}
    </ul>}
    {secrets && secrets.items.length > 0 && <div className={styles.secrets}>
      <span className={styles.hint}>{t("plugins.secretsHint")}</span>
      {secrets.items.map(item => <form key={item.name} className={styles.secret}
        onSubmit={event => submit(event, item.name)}>
        <label htmlFor={`plugin-secret-${installationId}-${item.name}`}>
          {item.name} · {t(item.configured ? "plugins.secretConfigured" : "plugins.secretMissing")}
        </label>
        <span className={styles.hint}>{item.destinations.map(where).join("；")}</span>
        <input id={`plugin-secret-${installationId}-${item.name}`} name="value" className="field-input"
          type="password" autoComplete="off" spellCheck={false} disabled={disabled || busy !== null}
          placeholder={item.configured ? t("plugins.secretReplacePlaceholder") : ""} />
        <div className={styles.actions}>
          <button className="btn-secondary" type="submit" disabled={disabled || busy !== null}>
            {t(busy === item.name ? "plugins.secretSaving" : item.configured ? "plugins.secretReplace" : "plugins.secretSave")}
          </button>
          {item.configured && <button className="btn-secondary" type="button" disabled={disabled || busy !== null}
            onClick={() => void change(item.name, null)}>{t("plugins.secretClear")}</button>}
        </div>
      </form>)}
    </div>}
    {message && <span role={message.kind}>{message.text}</span>}
  </section>;
}
