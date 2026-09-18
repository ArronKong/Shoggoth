import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./KeysPanel.module.css";

export type EditableFieldValue = {
  value: string | null;
  fallback?: string | null;
  configured: boolean;
  preview?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
};

type ActionResult = boolean | void;
type MaybeAsyncAction = Promise<ActionResult> | ActionResult;

export function IconCheck() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

export function IconEye() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" />
      <circle cx={8} cy={8} r={1.8} />
    </svg>
  );
}

export function IconEyeOff() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.4 4.3A6.6 6.6 0 0 1 8 4.1c4.1 0 6.5 3.9 6.5 3.9a12 12 0 0 1-2.2 2.6" />
      <path d="M4 5.4A11.8 11.8 0 0 0 1.5 8s2.4 3.9 6.5 3.9c1 0 1.9-.2 2.7-.6" />
      <path d="m2.6 2.6 10.8 10.8" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.8 4.4h10.4M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2" />
      <path d="M4.4 4.4l.5 8a1 1 0 0 0 1 1h4.2a1 1 0 0 0 1-1l.5-8" />
    </svg>
  );
}

export function IconPulse() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8h3l1.6-4 2.8 8 1.6-4h3.5" />
    </svg>
  );
}

export function ProviderCredentialFields({
  baseUrl,
  secret,
  busy,
  capabilities,
  onSaveBaseUrl,
  validateBaseUrl,
  onResolveBaseUrlForEdit,
  onClearBaseUrl,
  onSaveSecret,
  onRevealSecret,
  onValidateSecret,
  onClearSecret,
}: {
  baseUrl: EditableFieldValue;
  secret: EditableFieldValue;
  busy: boolean;
  capabilities: {
    editBaseUrl: boolean;
    clearBaseUrl: boolean;
    revealSecret: boolean;
    validateSecret: boolean;
    clearSecret: boolean;
  };
  onSaveBaseUrl(value: string): MaybeAsyncAction;
  validateBaseUrl?(value: string): boolean;
  onResolveBaseUrlForEdit(): Promise<string | null>;
  onClearBaseUrl(): MaybeAsyncAction;
  onSaveSecret(value: string): MaybeAsyncAction;
  onRevealSecret(): Promise<string | null>;
  onValidateSecret(value: string): Promise<void> | void;
  onClearSecret(): MaybeAsyncAction;
}) {
  const { t } = useTranslation();
  const [baseEdit, setBaseEdit] = useState<string | null>(null);
  const [secretEdit, setSecretEdit] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [pending, setPending] = useState<"base" | "secret" | "validate" | null>(null);
  const baseRequest = useRef(0);
  const secretRequest = useRef(0);

  useEffect(() => {
    baseRequest.current += 1;
    secretRequest.current += 1;
    setBaseEdit(null);
    setSecretEdit(null);
    setRevealedSecret(null);
    setPending(null);
  }, [
    baseUrl.ariaLabel,
    baseUrl.configured,
    baseUrl.preview,
    baseUrl.value,
    secret.ariaLabel,
    secret.configured,
    secret.preview,
    secret.value,
  ]);

  useEffect(() => () => {
    baseRequest.current += 1;
    secretRequest.current += 1;
  }, []);

  const beginBaseEdit = async () => {
    if (!capabilities.editBaseUrl || busy) return;
    if (!baseUrl.configured) {
      setBaseEdit(baseUrl.value ?? baseUrl.fallback ?? "");
      return;
    }

    // 已配置值只能由 adapter 解析明文；preview/fallback 都不能成为保存初值。
    const request = ++baseRequest.current;
    setPending("base");
    try {
      const value = await onResolveBaseUrlForEdit();
      if (request === baseRequest.current) setBaseEdit(value ?? "");
    } finally {
      if (request === baseRequest.current) setPending(null);
    }
  };

  const cancelBaseEdit = () => {
    baseRequest.current += 1;
    setBaseEdit(null);
    setPending(null);
  };

  const saveBaseUrl = async () => {
    const value = baseEdit?.trim();
    if (!value || (validateBaseUrl && !validateBaseUrl(value)) || busy) return;
    setPending("base");
    try {
      const result = await onSaveBaseUrl(value);
      if (result !== false) setBaseEdit(null);
    } finally {
      setPending(null);
    }
  };

  const cancelSecretEdit = () => {
    secretRequest.current += 1;
    setSecretEdit(null);
    setPending(null);
  };

  const saveSecret = async () => {
    const value = secretEdit?.trim();
    if (!value || busy) return;
    setPending("secret");
    try {
      const result = await onSaveSecret(value);
      if (result !== false) {
        setSecretEdit(null);
        setRevealedSecret(null);
      }
    } finally {
      setPending(null);
    }
  };

  const validateSecret = async () => {
    const value = secretEdit?.trim();
    if (!value || busy) return;
    setPending("validate");
    try {
      await onValidateSecret(value);
    } finally {
      setPending(null);
    }
  };

  const toggleSecretReveal = async () => {
    if (revealedSecret !== null) {
      secretRequest.current += 1;
      setRevealedSecret(null);
      return;
    }
    const request = ++secretRequest.current;
    setPending("secret");
    try {
      const value = await onRevealSecret();
      if (request === secretRequest.current && value !== null) setRevealedSecret(value);
    } finally {
      if (request === secretRequest.current) setPending(null);
    }
  };

  const isBusy = busy || pending !== null;
  const normalizedBaseEdit = baseEdit?.trim() ?? "";
  const baseEditValid = normalizedBaseEdit !== ""
    && (!validateBaseUrl || validateBaseUrl(normalizedBaseEdit));
  const baseShown = baseUrl.configured
    ? (baseUrl.preview ?? baseUrl.value ?? "—")
    : (baseUrl.value ?? baseUrl.fallback ?? baseUrl.placeholder ?? "—");
  const secretShown = secret.configured
    ? (revealedSecret ?? secret.preview ?? secret.value ?? "—")
    : (secret.placeholder ?? "—");

  return (
    <div className={styles.groupFields} data-provider-fields>
      {capabilities.editBaseUrl ? (
        <div className={styles.fieldSlot}>
          {baseEdit !== null ? (
            <>
              <input
                autoFocus
                className={`field-input ${styles.fieldBox} field-mono`}
                value={baseEdit}
                autoComplete="off"
                spellCheck={false}
                placeholder={baseUrl.fallback ?? baseUrl.placeholder}
                aria-label={baseUrl.ariaLabel ?? "Base URL"}
                onChange={(event) => setBaseEdit(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveBaseUrl();
                  if (event.key === "Escape") cancelBaseEdit();
                }}
              />
              <div className={styles.fieldIcons}>
                <button className={styles.iconBtn} disabled={isBusy || !baseEditValid}
                  title={t("common.save")} aria-label={t("common.save")} onClick={() => void saveBaseUrl()}>
                  <IconCheck />
                </button>
                <button className={styles.iconBtn} disabled={isBusy}
                  title={t("common.cancel")} aria-label={t("common.cancel")} onClick={cancelBaseEdit}>
                  <IconClose />
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                className={`field-input ${styles.fieldBox} ${styles.fieldBoxBtn} ${baseUrl.configured ? "" : styles.fieldBoxEmpty}`}
                title={baseUrl.title}
                disabled={isBusy}
                onClick={() => void beginBaseEdit()}
              >
                <span className="mono">{baseShown}</span>
              </button>
              {capabilities.clearBaseUrl && (
                <div className={styles.fieldIcons}>
                  <button className={styles.iconBtn} disabled={isBusy}
                    title={t("keys.baseUrlReset")} aria-label={t("keys.baseUrlReset")}
                    onClick={() => void onClearBaseUrl()}>
                    <IconTrash />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className={styles.fieldSlot}>
          <input
            className={`field-input ${styles.fieldBox} ${styles.fieldBoxLocked} field-mono`}
            value={baseShown}
            disabled
            readOnly
            title={baseUrl.title}
            aria-label={baseUrl.ariaLabel ?? baseShown}
          />
        </div>
      )}

      <div className={styles.fieldSlot}>
        {secretEdit !== null ? (
          <>
            <input
              autoFocus
              type="text"
              className={`field-input ${styles.fieldBox} field-mono`}
              value={secretEdit}
              autoComplete="off"
              aria-label={secret.ariaLabel ?? "API Key"}
              placeholder={secret.configured
                ? t("keys.replaceCurrent", { preview: secret.preview ?? "—" })
                : secret.placeholder}
              onChange={(event) => setSecretEdit(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveSecret();
                if (event.key === "Escape") cancelSecretEdit();
              }}
            />
            <div className={styles.fieldIcons}>
              {capabilities.validateSecret && (
                <button className={styles.iconBtn} disabled={isBusy || !secretEdit.trim()}
                  title={t("keys.validate")} aria-label={t("keys.validate")} onClick={() => void validateSecret()}>
                  <IconPulse />
                </button>
              )}
              <button className={styles.iconBtn} disabled={isBusy || !secretEdit.trim()}
                title={t("common.save")} aria-label={t("common.save")} onClick={() => void saveSecret()}>
                <IconCheck />
              </button>
              <button className={styles.iconBtn} disabled={isBusy}
                title={t("common.cancel")} aria-label={t("common.cancel")} onClick={cancelSecretEdit}>
                <IconClose />
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              className={`field-input ${styles.fieldBox} ${styles.fieldBoxBtn} ${secret.configured ? "" : styles.fieldBoxEmpty}`}
              title={secret.title}
              disabled={isBusy}
              aria-label={secret.ariaLabel
                ? `${secret.ariaLabel} — ${secret.configured ? t("keys.replace") : t("keys.set")}`
                : (secret.configured ? t("keys.replace") : t("keys.set"))}
              onClick={() => setSecretEdit("")}
            >
              <span className={`mono ${revealedSecret !== null ? styles.valueShown : ""}`}>{secretShown}</span>
            </button>
            {secret.configured && (
              <div className={styles.fieldIcons}>
                {capabilities.revealSecret && (
                  <button className={styles.iconBtn} disabled={isBusy}
                    title={revealedSecret !== null ? t("keys.hide") : t("keys.reveal")}
                    aria-label={revealedSecret !== null ? t("keys.hide") : t("keys.reveal")}
                    onClick={() => void toggleSecretReveal()}>
                    {revealedSecret !== null ? <IconEyeOff /> : <IconEye />}
                  </button>
                )}
                {capabilities.clearSecret && (
                  <button className={styles.iconBtn} disabled={isBusy}
                    title={t("keys.clear")} aria-label={t("keys.clear")}
                    onClick={() => void onClearSecret()}>
                    <IconTrash />
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
