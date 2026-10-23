import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthLoginMethod, OAuthLoginPrompt, OAuthLoginProviderOption, OAuthLoginTarget } from "../../types";
import { listOAuthLoginOptions } from "../../api/client";
import { Field, Option, Select, TextInput } from "../../components/Field";
import styles from "./KeysPanel.module.css";

const LIST_LIMIT = 40;

// A prompt shows only when its condition on another input holds.
const shown = (prompt: OAuthLoginPrompt, inputs: Record<string, string>) => !prompt.when
  || (prompt.when.op === "eq" ? inputs[prompt.when.key] === prompt.when.value
    : inputs[prompt.when.key] !== prompt.when.value);

// Selects start on their first option, as the runtime's own CLI does.
const defaults = (method: OAuthLoginMethod | undefined) => Object.fromEntries((method?.prompts ?? [])
  .filter((prompt) => prompt.type === "select" && prompt.options.length > 0)
  .map((prompt) => [prompt.key, prompt.options[0].value]));

// flow "providers": pick the model provider a runtime signs into (OpenCode),
// a sign-in method, and the inputs it asks for. OAuth continues in the modal's
// browser flow; an API key is saved directly.
export default function ProviderLoginPicker({ backend, providerId, busy, onOAuth, onApiKey }: {
  backend: string;
  providerId: string;
  busy: boolean;
  onOAuth: (target: OAuthLoginTarget) => void;
  onApiKey: (target: OAuthLoginTarget, key: string) => void;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<OAuthLoginProviderOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<OAuthLoginProviderOption | null>(null);
  const [methodIndex, setMethodIndex] = useState<number | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");

  useEffect(() => {
    let alive = true;
    setError(null);
    listOAuthLoginOptions(backend, providerId).then(
      (result) => { if (alive) setOptions(result.providers); },
      (e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, [backend, providerId, attempt]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (options ?? [])
      .filter((option) => !needle || option.name.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle))
      .sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name));
  }, [options, query]);

  const method = chosen?.methods.find((item) => item.index === methodIndex) ?? chosen?.methods[0];
  const prompts = (method?.prompts ?? []).filter((prompt) => shown(prompt, inputs));
  const target = (): OAuthLoginTarget => ({
    providerId: chosen!.id,
    method: method!.index,
    // Only the inputs the method still shows, and only those filled in.
    inputs: Object.fromEntries(prompts.map((prompt) => [prompt.key, (inputs[prompt.key] ?? "").trim()])
      .filter(([, value]) => value)),
  });
  const choose = (option: OAuthLoginProviderOption) => {
    setChosen(option);
    setMethodIndex(option.methods[0]?.index ?? null);
    setInputs(defaults(option.methods[0]));
    setKey("");
  };
  const chooseMethod = (item: OAuthLoginMethod) => {
    setMethodIndex(item.index);
    setInputs(defaults(item));
  };

  if (error) {
    return <div className={styles.providerPicker}>
      <p className={styles.modalError}>{error}</p>
      <div className={styles.modalFoot}>
        <span />
        <button className={styles.smallBtn} onClick={() => setAttempt((value) => value + 1)}>{t("keys.oauthRetry")}</button>
      </div>
    </div>;
  }
  if (options === null) return <p className="muted">{t("keys.providerLoading")}</p>;

  if (!chosen || !method) {
    return <div className={styles.providerPicker}>
      <TextInput autoFocus value={query} placeholder={t("keys.providerSearch")} aria-label={t("keys.providerSearch")}
        onChange={(e) => setQuery(e.target.value)} />
      <div className={styles.providerList} role="list">
        {matches.slice(0, LIST_LIMIT).map((option) => (
          <button key={option.id} type="button" role="listitem" className={styles.providerItem}
            disabled={busy || option.methods.length === 0} onClick={() => choose(option)}>
            <span>{option.name}</span>
            {option.connected && <span className={styles.providerBadge}>{t("keys.providerConnected")}</span>}
          </button>
        ))}
        {matches.length === 0 && <p className="muted">{t("keys.providerNoMatch")}</p>}
      </div>
      {matches.length > LIST_LIMIT && <p className={styles.cardHint}>{t("keys.providerMore", { count: matches.length - LIST_LIMIT })}</p>}
    </div>;
  }

  const ready = prompts.every((prompt) => prompt.type !== "select" || inputs[prompt.key])
    && (method.type !== "api" || key.trim().length > 0);
  return <div className={styles.providerPicker}>
    <div className={styles.providerHead}>
      <span>{chosen.name}</span>
      <button type="button" className={styles.smallBtn} disabled={busy} onClick={() => setChosen(null)}>
        {t("keys.providerChooseAnother")}
      </button>
    </div>
    {chosen.methods.length > 1 && (
      <div className={styles.providerMethods} role="group" aria-label={t("keys.providerMethod")}>
        {chosen.methods.map((item) => (
          <button key={item.index} type="button" className={styles.smallBtn} aria-pressed={item.index === method.index}
            disabled={busy} onClick={() => chooseMethod(item)}>{item.label}</button>
        ))}
      </div>
    )}
    {prompts.map((prompt) => (
      <Field key={prompt.key} label={prompt.message}>
        {prompt.type === "select" ? (
          <Select value={inputs[prompt.key] ?? ""} disabled={busy}
            onChange={(value) => setInputs((current) => ({ ...current, [prompt.key]: value }))}>
            {prompt.options.map((option) => (
              <Option key={option.value} value={option.value}>
                {option.hint ? `${option.label} · ${option.hint}` : option.label}
              </Option>
            ))}
          </Select>
        ) : (
          <TextInput value={inputs[prompt.key] ?? ""} placeholder={prompt.placeholder ?? undefined} disabled={busy}
            onChange={(e) => setInputs((current) => ({ ...current, [prompt.key]: e.target.value }))} />
        )}
      </Field>
    ))}
    {method.type === "api" && (
      <Field label={t("keys.providerApiKey")}>
        <TextInput type="password" autoComplete="off" value={key} placeholder={t("keys.providerApiKeyPlaceholder")}
          disabled={busy} onChange={(e) => setKey(e.target.value)} />
      </Field>
    )}
    <div className={styles.modalFoot}>
      <span />
      <button type="button" className={`${styles.smallBtn} ui-cbtn ui-cbtn--sm`} disabled={busy || !ready}
        onClick={() => (method.type === "api" ? onApiKey(target(), key.trim()) : onOAuth(target()))}>
        {t(method.type === "api" ? "keys.providerSave" : "keys.providerContinue")}
      </button>
    </div>
  </div>;
}
