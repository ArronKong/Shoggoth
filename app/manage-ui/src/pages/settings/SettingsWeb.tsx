import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Field, Option, Select, TextInput } from "../../components/Field";
import { getWebSettings, setWebSettings, setWebProviderKey, clearWebProviderKey } from "../../api/web";
import type { WebSettingsSnapshot, WebProvider, WebProviderConfig } from "../../types";
import { useNavigationGuard } from "../../lib/navigation-guard";
import i18n from "../../i18n";
import { webSettingsResources } from "../../i18n/webSettingsResources";
import s from "./SettingsWeb.module.css";
for (const language of ["zh-CN", "en"] as const) i18n.addResourceBundle(language, "webSettings", webSettingsResources[language]);
const providers: WebProvider[] = ["exa", "brave", "tavily", "tinyfish"];
const names = { exa: "Exa", brave: "Brave", tavily: "Tavily", tinyfish: "TinyFish" };
const links = { exa: "https://dashboard.exa.ai/api-keys", brave: "https://api-dashboard.search.brave.com/app/keys",
  tavily: "https://app.tavily.com", tinyfish: "https://agent.tinyfish.ai/api-keys" };
const emptyKeys = () => ({ exa: "", brave: "", tavily: "", tinyfish: "" });
let pendingWrite: Promise<unknown> = Promise.resolve();
export default function SettingsWeb() {
  const { t } = useTranslation("webSettings");
  const [snapshot, setSnapshot] = useState<WebSettingsSnapshot | null>(null);
  const [config, setConfig] = useState<WebProviderConfig>({ searchProvider: "exa", fetchProvider: "direct" });
  const [keys, setKeys] = useState(emptyKeys), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [needsReload, setNeedsReload] = useState(false), [saved, setSaved] = useState(false);
  const generation = useRef(0), inFlight = useRef(false), errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: "nearest" }); }, [error]);
  const configDirty = !!snapshot && JSON.stringify(config) !== JSON.stringify(snapshot.config);
  const dirty = configDirty || providers.some(provider => !!keys[provider]);
  useEffect(() => () => { generation.current++; }, []);
  const discard = () => { if (snapshot) setConfig({ ...snapshot.config }); setKeys(emptyKeys()); };
  useNavigationGuard({ dirty, busy, onDiscard: discard });
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const ticket = ++generation.current;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    try {
      await pendingWrite.catch(() => {});
      if (ticket !== generation.current) return;
      const next = await getWebSettings();
      if (ticket !== generation.current) return;
      setSnapshot(next); setConfig({ ...next.config }); setKeys(emptyKeys()); setNeedsReload(false);
    } catch { if (ticket === generation.current) { setError("load"); setNeedsReload(true); } }
    finally { if (ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mutate = async (action: () => Promise<WebSettingsSnapshot>, provider?: WebProvider) => {
    if (!snapshot || inFlight.current || needsReload) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const ticket = generation.current;
    const writing = action(); pendingWrite = writing.catch(() => {});
    try {
      const next = await writing;
      if (ticket !== generation.current) return;
      // A credential response must not adopt a newer selector revision and
      // silently bless an older unsaved choice from this form.
      if (provider) {
        setSnapshot(previous => previous ? { ...previous, credentials: next.credentials } : previous);
        setKeys(previous => ({ ...previous, [provider]: "" }));
      } else { setSnapshot(next); setConfig({ ...next.config }); }
      setSaved(true);
    } catch (failure) {
      if (ticket !== generation.current) return;
      const code = (failure as { code?: string })?.code;
      setError(code === "WEB_SETTINGS_CONFLICT" ? "conflict" : code === "WEB_SETTINGS_INVALID" ? "invalid"
        : code === "WEB_CREDENTIALS_LOCKED" ? "locked" : code === "WEB_SETTINGS_UNCERTAIN" ? "uncertain" : "save");
      setNeedsReload(code !== "WEB_SETTINGS_INVALID" && code !== "WEB_CREDENTIALS_LOCKED");
    } finally { if (ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  };
  const disabled = busy || needsReload || !snapshot;
  const change = (patch: Partial<WebProviderConfig>) => { if (!disabled && !inFlight.current) { setConfig(previous => ({ ...previous, ...patch })); setSaved(false); } };
  const submit = (event: FormEvent) => { event.preventDefault(); if (snapshot && configDirty) void mutate(() => setWebSettings({ expectedRevision: snapshot.revision, config })); };
  const missing = snapshot && ((config.searchProvider !== "exa" && !snapshot.credentials[config.searchProvider].configured)
    || config.fetchProvider !== "direct" && !snapshot.credentials[config.fetchProvider].configured);
  return <section className={`settings-section ${s.section}`} id="settings-web" aria-labelledby="settings-web-title" aria-busy={busy}>
    <header className="settings-section-head"><h3 className="settings-h" id="settings-web-title">{t("title")}</h3><p className="settings-sech">{t("description")}</p></header>
    <div className="settings-card settings-list-card">
      <form onSubmit={submit} className={s.choices}>
        <Field label={t("search")}><Select value={config.searchProvider} disabled={disabled} onChange={value => change({ searchProvider: value as WebProvider })}>
          {providers.map(provider => <Option key={provider} value={provider}>{provider === "exa" ? t("exa") : names[provider]}</Option>)}
        </Select></Field>
        <Field label={t("fetch")}><Select value={config.fetchProvider} disabled={disabled} onChange={value => change({ fetchProvider: value as WebProviderConfig["fetchProvider"] })}>
          <Option value="direct">{t("direct")}</Option>{providers.filter(provider => provider !== "brave").map(provider => <Option key={provider} value={provider}>{names[provider]}</Option>)}
        </Select></Field>
        <div className={s.actions}><button className="ui-cbtn ui-cbtn--primary" type="submit" disabled={disabled || !configDirty}>{t("save")}</button></div>
      </form>
      <p className="ui-hint">{t("scope")}</p><p className="ui-hint">{t("fetchHint")}</p>
      {missing && <p className="ui-hint" role="status">{t("missing")}</p>}
      <div className={s.keys}><h4>{t("keys")}</h4><p className="ui-hint">{t("keyHint")}</p>
        {providers.map(provider => <form key={provider} className={s.keyRow} data-web-provider={provider} onSubmit={event => {
          event.preventDefault(); if (snapshot && keys[provider]) void mutate(() => setWebProviderKey({ provider, expectedRevision: snapshot.credentials[provider].revision, apiKey: keys[provider] }), provider);
        }}>
          <div className={s.keyHead}><strong>{names[provider]}</strong><span>{snapshot?.credentials[provider].configured ? t("stored") : t("empty")}</span>
            <a href={links[provider]} target="_blank" rel="noreferrer">{t("getKey")}</a></div>
          <Field label={`${names[provider]} ${t("key")}`}><TextInput type="password" autoComplete="new-password" spellCheck={false}
            value={keys[provider]} placeholder={t("placeholder")} maxLength={4096} disabled={disabled} onChange={event => {
              if (!disabled && !inFlight.current) { const value = event.target.value; setKeys(previous => ({ ...previous, [provider]: value })); setSaved(false); }
            }}/></Field>
          <div className={s.actions}><button type="submit" className="ui-cbtn ui-cbtn--sm" disabled={disabled || !keys[provider]}>{snapshot?.credentials[provider].configured ? t("replace") : t("saveKey")}</button>
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={disabled || !snapshot?.credentials[provider].configured} onClick={() => {
              if (snapshot) void mutate(() => clearWebProviderKey({ provider, expectedRevision: snapshot.credentials[provider].revision }), provider);
            }}>{t("clear")}</button></div>
        </form>)}<p className="ui-hint">{t("tinyfishHint")}</p>
      </div>
      <div className={s.feedback}>
        {error && <p role="alert" ref={errorRef}>{t(`errors.${error}`)}</p>}
        <p role="status">{busy ? t(snapshot ? "working" : "loading") : saved ? t("saved") : ""}</p>
        <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => void load()}>{t(dirty ? "reload" : "retry")}</button>
      </div>
    </div>
  </section>;
}
