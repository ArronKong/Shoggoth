import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  bindShoggothChatGpt,
  clearShoggothProvider,
  configureShoggothProvider,
  getShoggothChatGptModels,
  logoutRuntimeAccount,
  startShoggothChatGptLogin,
} from "../api/client";
import { ApiError } from "../api/client";
import type {
  ShoggothChatGptModel,
  ShoggothProviderConfiguration,
  ShoggothProviderSnapshot,
} from "../types";
import { Field, Option, Select, TextInput } from "./Field";
import { useConfirm } from "./ui";
import { profileProviderId, providerOperationId as operationId } from "../lib/shoggothProvider";
import styles from "./ShoggothProviderSetup.module.css";

type Kind = Exclude<ShoggothProviderConfiguration["provider"]["kind"], "custom-responses"> | "chatgpt";

const INTERNAL_CODEX_ACCOUNT_ID = "shoggoth-internal-codex-default-v1";

const NAMES: Record<Kind, string> = {
  chatgpt: "ChatGPT",
  "openai-api-key": "OpenAI API Key",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "amazon-bedrock": "Amazon Bedrock",
};

export function ShoggothProviderSetup({
  snapshot,
  profileId = snapshot?.profile?.id ?? null,
  onConfigured,
}: {
  snapshot: ShoggothProviderSnapshot | null;
  profileId?: string | null;
  onConfigured: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [kind, setKind] = useState<Kind>("chatgpt");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ShoggothChatGptModel[]>([]);
  const [catalogState, setCatalogState] = useState<"idle" | "loading" | "ready" | "empty" | "failed">("idle");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [secret, setSecret] = useState("");
  const [awsRegion, setAwsRegion] = useState("");
  const [awsProfile, setAwsProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [locallyLoggedOut, setLocallyLoggedOut] = useState(false);
  const chatgpt = snapshot?.providers.find((provider) => provider.kind === "chatgpt");
  const effectiveChatGptAuthState = locallyLoggedOut ? "missing" : chatgpt?.authState;
  const needsSecret = ["openai-api-key", "openrouter"].includes(kind);
  const customConfigured = snapshot?.providers.some((provider) =>
    provider.id === snapshot.profile?.configuredProviderId && provider.kind === "custom-responses");
  const selectedModel = useMemo(
    () => models.find((entry) => entry.id === model) || null,
    [model, models],
  );

  useEffect(() => {
    if (kind !== "chatgpt" || effectiveChatGptAuthState !== "authenticated") {
      setModels([]);
      setCatalogState("idle");
      if (kind === "chatgpt") setModel("");
      return;
    }
    let cancelled = false;
    setCatalogState("loading");
    void getShoggothChatGptModels(profileId).then(({ models: nextModels }) => {
      if (cancelled) return;
      setModels(nextModels);
      if (nextModels.length === 0) {
        setModel("");
        setCatalogState("empty");
        return;
      }
      const configured = snapshot?.profile?.defaultModel;
      const selected = nextModels.find((entry) => entry.id === configured)
        || nextModels.find((entry) => entry.isDefault)
        || nextModels[0];
      setModel(selected.id);
      setCatalogState("ready");
    }).catch(() => {
      if (cancelled) return;
      setModels([]);
      setModel("");
      setCatalogState("failed");
    });
    return () => { cancelled = true; };
  }, [catalogAttempt, effectiveChatGptAuthState, kind, profileId, snapshot?.profile?.defaultModel]);

  useEffect(() => {
    // A request that started before logout may still return a fresh object with
    // the old authenticated value. Keep the local downgrade until the server
    // explicitly reports a non-authenticated state from a later read.
    if (locallyLoggedOut && chatgpt?.authState !== "authenticated") {
      setLocallyLoggedOut(false);
    }
  }, [chatgpt?.authState, locallyLoggedOut]);

  const openIndependentChatGptLogin = async () => {
    const login = await startShoggothChatGptLogin(profileId);
    setAuthUrl(login.authUrl);
    window.open(login.authUrl, "_blank", "noopener,noreferrer");
  };

  const submit = async () => {
    const loginRequired = kind === "chatgpt" && effectiveChatGptAuthState !== "authenticated";
    if (!loginRequired && !model.trim()) return setMessage(t("shoggothProvider.modelRequired"));
    if (kind === "chatgpt" && !loginRequired && catalogState !== "ready") {
      return setMessage(t("shoggothProvider.modelCatalogUnavailable"));
    }
    setBusy(true);
    setMessage(null);
    try {
      if (kind === "chatgpt") {
        if (effectiveChatGptAuthState !== "authenticated") {
          await openIndependentChatGptLogin();
          setMessage(t("shoggothProvider.finishLogin"));
        } else {
          await bindShoggothChatGpt({
            profileId,
            operationId: operationId("chatgpt-bind"),
            defaultModel: model.trim(),
            createdAt: Date.now(),
          });
          setAuthUrl(null);
          setMessage(t("shoggothProvider.configured"));
        }
      } else {
        if (needsSecret && !secret) return setMessage(t("shoggothProvider.secretRequired"));
        await configureShoggothProvider({
          profileId,
          operationId: operationId("provider-configure"),
          createdAt: Date.now(),
          secret: needsSecret ? secret : null,
          provider: {
            id: profileProviderId(kind, snapshot),
            kind,
            name: NAMES[kind],
            model: model.trim(),
            baseUrl: null,
            awsRegion: kind === "amazon-bedrock" ? awsRegion.trim() || null : null,
            awsProfile: kind === "amazon-bedrock" ? awsProfile.trim() || null : null,
          },
        });
        setSecret("");
        setMessage(t("shoggothProvider.configured"));
      }
      await onConfigured();
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROFILE_MODEL_NOT_AVAILABLE") {
        setMessage(t("shoggothProvider.modelNotAvailable"));
        setCatalogAttempt((value) => value + 1);
      } else if (error instanceof ApiError && error.code === "PROFILE_AUTH_REQUIRED") {
        setMessage(t("shoggothProvider.authExpired"));
      } else if (error instanceof ApiError && error.code === "PROFILE_MODEL_CATALOG_UNAVAILABLE") {
        setMessage(t("shoggothProvider.modelCatalogUnavailable"));
        setCatalogAttempt((value) => value + 1);
      } else {
        setMessage(t("shoggothProvider.failed"));
      }
    } finally {
      setSecret("");
      setBusy(false);
    }
  };

  const changeChatGptAccount = async (action: "switch" | "logout") => {
    const accepted = await confirm({
      title: t(action === "switch"
        ? "shoggothProvider.switchAccountTitle" : "shoggothProvider.logoutTitle"),
      message: t(action === "switch"
        ? "shoggothProvider.switchAccountMessage" : "shoggothProvider.logoutMessage"),
      confirmLabel: t(action === "switch"
        ? "shoggothProvider.switchAccount" : "shoggothProvider.logout"),
      danger: action === "logout",
    });
    if (!accepted) return;
    setBusy(true);
    setMessage(null);
    try {
      await logoutRuntimeAccount(INTERNAL_CODEX_ACCOUNT_ID);
      setLocallyLoggedOut(true);
      setAuthUrl(null);
      setModels([]);
      setModel("");
      if (action === "switch") {
        await openIndependentChatGptLogin();
        setMessage(t("shoggothProvider.finishSwitchedLogin"));
      } else {
        setMessage(t("shoggothProvider.loggedOut"));
      }
      await onConfigured();
    } catch {
      setMessage(t("shoggothProvider.failed"));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await clearShoggothProvider({
        operationId: operationId("provider-clear"),
        profileId,
        createdAt: Date.now(),
      });
      setSecret("");
      setModel("");
      setMessage(t("shoggothProvider.cleared"));
      await onConfigured();
    } catch {
      setMessage(t("shoggothProvider.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root}>
      {customConfigured && <span className="ui-hint" role="status">
        {t("shoggothProvider.customCurrent", { model: snapshot?.profile?.defaultModel })}
      </span>}
      {!customConfigured && kind === "chatgpt" && effectiveChatGptAuthState === "authenticated"
        && chatgpt?.authSource === "native-codex" && (
        <span className="ui-hint" role="status">{t("shoggothProvider.nativeCodexConnected")}</span>
      )}
      <Field label={t("shoggothProvider.kind")}>
        <Select value={kind} onChange={(value) => setKind(value as Kind)} disabled={busy}>
          {(Object.keys(NAMES) as Kind[]).map((value) => (
            <Option key={value} value={value}>{NAMES[value]}</Option>
          ))}
        </Select>
      </Field>
      <Field label={t("shoggothProvider.model")}>
        {kind === "chatgpt" ? (
          effectiveChatGptAuthState === "authenticated" ? (
            <Select value={model} onChange={setModel}
              disabled={busy || catalogState !== "ready" || models.length === 0}>
              {models.map((entry) => (
                <Option key={entry.id} value={entry.id}>
                  {entry.displayName === entry.id ? entry.id : `${entry.displayName} · ${entry.id}`}
                </Option>
              ))}
            </Select>
          ) : (
            <span className="ui-hint" role="status">
              {snapshot === null
                ? t("shoggothProvider.nativeCodexChecking")
                : t("shoggothProvider.loginForModels")}
            </span>
          )
        ) : (
          <TextInput value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} />
        )}
        {kind === "chatgpt" && catalogState === "loading" && (
          <span className="ui-hint">{t("shoggothProvider.modelCatalogLoading")}</span>
        )}
        {kind === "chatgpt" && catalogState === "empty" && (
          <span className="ui-hint status-error">{t("shoggothProvider.modelCatalogEmpty")}</span>
        )}
        {kind === "chatgpt" && catalogState === "failed" && (
          <span className="ui-hint status-error">{t("shoggothProvider.modelCatalogUnavailable")}</span>
        )}
        {kind === "chatgpt" && selectedModel?.description && (
          <span className="ui-hint">{selectedModel.description}</span>
        )}
      </Field>
      {needsSecret && (
        <Field label={t("shoggothProvider.secret")} hint={t("shoggothProvider.secretHint")}>
          <TextInput type="password" autoComplete="off" value={secret} disabled={busy}
            onChange={(event) => setSecret(event.target.value)} />
        </Field>
      )}
      {kind === "amazon-bedrock" && (
        <div className={styles.row}>
          <Field label={t("shoggothProvider.awsRegion")}>
            <TextInput value={awsRegion} disabled={busy} onChange={(event) => setAwsRegion(event.target.value)} />
          </Field>
          <Field label={t("shoggothProvider.awsProfile")}>
            <TextInput value={awsProfile} disabled={busy} onChange={(event) => setAwsProfile(event.target.value)} />
          </Field>
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy}
          onClick={() => void submit()}>
          {busy ? t("common.saving") : kind === "chatgpt" && effectiveChatGptAuthState !== "authenticated"
            ? t("shoggothProvider.login")
            : t("shoggothProvider.configure")}
        </button>
        {kind === "chatgpt" && effectiveChatGptAuthState === "authenticated" && (
          <>
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy}
              onClick={() => void changeChatGptAccount("switch")}>
              {t("shoggothProvider.switchAccount")}
            </button>
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy}
              onClick={() => void changeChatGptAccount("logout")}>
              {t("shoggothProvider.logout")}
            </button>
          </>
        )}
        {!customConfigured && snapshot?.profile && (snapshot.profile.configuredProviderId !== null
          || snapshot.profile.defaultModel !== null) && (
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy}
            onClick={() => void clear()}>
            {t("common.clear")}
          </button>
        )}
        {kind === "chatgpt" && ["empty", "failed"].includes(catalogState) && (
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy}
            onClick={() => setCatalogAttempt((value) => value + 1)}>
            {t("shoggothProvider.reloadModels")}
          </button>
        )}
        {message && <span className="ui-hint" role="status">{message}</span>}
        {authUrl && (
          <a href={authUrl} target="_blank" rel="noopener noreferrer">
            {t("shoggothProvider.openLogin")}
          </a>
        )}
      </div>
    </div>
  );
}
