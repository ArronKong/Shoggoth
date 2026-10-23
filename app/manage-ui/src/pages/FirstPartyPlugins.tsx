import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getFirstPartyPlugins, installFirstPartyPlugin, type FirstPartyPlugin } from "../api/client";
import styles from "./FirstPartyPlugins.module.css";

// Plugins shipped with the App stay uninstalled across App updates once the
// user removes them; this lists them for an explicit reinstall.
export function FirstPartyPlugins({ revision, disabled, onChanged }: {
  revision: string | null; disabled: boolean; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<FirstPartyPlugin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "status" | "alert"; text: string } | null>(null);
  const load = useCallback(async () => {
    try { setItems((await getFirstPartyPlugins()).items); } catch { setItems([]); }
  }, []);
  useEffect(() => { void load(); }, [load, revision]);
  const removed = items.filter(item => item.installationState === "uninstalled");
  const install = async (item: FirstPartyPlugin) => {
    setBusy(item.packageId); setMessage(null);
    try {
      const { canceled } = await installFirstPartyPlugin(item.packageId);
      if (!canceled) {
        setMessage({ kind: "status", text: t("plugins.firstPartyInstalled", { name: item.name }) });
        onChanged();
      }
      await load();
    } catch (error) {
      setMessage({ kind: "alert", text: t("plugins.firstPartyFailed", {
        code: error instanceof ApiError && error.code ? error.code : "unavailable" }) });
    } finally { setBusy(null); }
  };
  if (!removed.length) return message ? <span role={message.kind}>{message.text}</span> : null;
  return <section className={styles.panel} aria-label={t("plugins.firstPartyTitle")}>
    <strong>{t("plugins.firstPartyTitle")}</strong>
    <span className={styles.hint}>{t("plugins.firstPartyHint")}</span>
    <ul className={styles.list}>
      {removed.map(item => <li key={item.packageId}>
        <span>{item.name}{item.version ? ` · ${item.version}` : ""}</span>
        <button className="btn-secondary" type="button" disabled={disabled || busy !== null}
          onClick={() => void install(item)}>
          {t(busy === item.packageId ? "plugins.firstPartyInstalling" : "plugins.firstPartyReinstall")}
        </button>
      </li>)}
    </ul>
    {message && <span role={message.kind}>{message.text}</span>}
  </section>;
}
