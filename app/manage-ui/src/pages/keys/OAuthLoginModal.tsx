import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthProvider, OAuthStartSession } from "../../types";
import {
  cancelOAuthSession,
  listOAuthProviders,
  pollOAuthSession,
  runProviderCommandInTerminal,
  startOAuthLogin,
  submitOAuthCode,
} from "../../api/client";
import { TextInput } from "../../components/Field";
import Modal from "../../components/Modal";
import { useConfirm, useToast } from "../../components/ui";
import styles from "./KeysPanel.module.css";

// OAuth 登录弹窗（对齐官方）：pkce = 开授权页 → 粘贴 code → 提交；
// device_code = 展示用户码 → 每 2s 轮询直到 approved。会话是 dashboard 进程内
// 的状态，所以 start/submit/poll/cancel 必须打同一台 dashboard。
//
// 一律不带 profile ⇒ 后端落到 default（全局根 ~/.hermes）。这不是偷懒：Hermes 的
// OAuth 授权写 `get_hermes_home()/auth.json`，而 profile 进程读不到本地授权时会
// **只读回落**到全局根那份（auth.py `_load_global_auth_store`）。所以登录到全局根
// = 每个 Profile 都能用；登录到某个 isolated profile 反而只有它自己能用。
//
// external = 第三支（官方 components/onboarding/flow.tsx 的 external_pending）：
// 凭证由别人的 CLI 保管，Hermes 的 /start 对它**直接 400**（web_server.py:
// start_oauth_login 显式拒绝 flow=external），所以这一支不发任何登录请求——
// 给出命令让用户去终端跑，回来点「我已登录」重读一次目录来确认。
type Phase =
  | "starting"
  | "awaiting"
  | "submitting"
  | "polling"
  | "approved"
  | "error"
  | "external"
  | "rechecking";

export default function OAuthLoginModal({
  provider,
  backend = "hermes",
  onClose,
}: {
  provider: OAuthProvider;
  backend?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const isExternal = provider.flow === "external";
  const [phase, setPhase] = useState<Phase>(isExternal ? "external" : "starting");
  const [session, setSession] = useState<OAuthStartSession | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 回查未检出用的**警告**（不是 error 相位）：面板不关，还能再点「我已登录」。
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const alive = useRef(true);

  const start = useCallback(async () => {
    // external 不走登录接口——服务端会 400。直接进命令面板。
    if (isExternal) {
      setPhase("external");
      setError(null);
      setNotice(null);
      return;
    }
    setPhase("starting");
    setError(null);
    setSession(null);
    setCode("");
    try {
      const s = await startOAuthLogin(backend, provider.id, undefined);
      if (!alive.current) return;
      setSession(s);
      setSecondsLeft(s.expiresIn || null);
      setPhase(s.flow === "device_code" ? "polling" : "awaiting");
      const url = s.flow === "pkce" ? s.authUrl : s.verificationUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      if (!alive.current) return;
      setPhase("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [provider.id, isExternal]);

  useEffect(() => {
    alive.current = true;
    start();
    return () => {
      alive.current = false;
    };
  }, [start]);

  // 倒计时：会话到期即失效，别让用户对着一个死会话粘贴 code。
  useEffect(() => {
    if (secondsLeft === null || phase === "approved" || phase === "error") return;
    const timer = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s !== null && s <= 1) {
          setPhase("error");
          setError(t("keys.oauthSessionExpired"));
          return 0;
        }
        return s !== null && s > 0 ? s - 1 : 0;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [secondsLeft, phase, t]);

  // device_code：每 2s 问一次后端，approved 后 1.5s 自动关闭。
  useEffect(() => {
    if (!session || session.flow !== "device_code" || phase !== "polling") return;
    const timer = window.setInterval(async () => {
      try {
        const r = await pollOAuthSession(backend, provider.id, session.sessionId, undefined);
        if (!alive.current) return;
        if (r.status === "approved") {
          window.clearInterval(timer);
          setPhase("approved");
          toast.success(t("keys.oauthConnectedToast", { name: provider.name }));
          window.setTimeout(() => alive.current && onClose(), 1500);
        } else if (r.status && r.status !== "pending") {
          window.clearInterval(timer);
          setPhase("error");
          setError(r.errorMessage || `${t("keys.oauthLoginFailed")}: ${r.status}`);
        }
      } catch (e) {
        if (!alive.current) return;
        window.clearInterval(timer);
        setPhase("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [session, phase, provider.id, provider.name, onClose, toast, t]);

  const submit = async () => {
    if (!session || session.flow !== "pkce" || !code.trim()) return;
    setPhase("submitting");
    setError(null);
    try {
      const r = await submitOAuthCode(backend, provider.id, session.sessionId, code.trim(), undefined);
      if (!alive.current) return;
      if (r.ok && r.status === "approved") {
        setPhase("approved");
        toast.success(t("keys.oauthConnectedToast", { name: provider.name }));
        window.setTimeout(() => alive.current && onClose(), 1500);
      } else {
        setPhase("error");
        setError(r.message || t("keys.oauthExchangeFailed"));
      }
    } catch (e) {
      if (!alive.current) return;
      setPhase("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // external 的「我已登录」：Hermes 没有 external 的确认接口，登录态是**实时**从
  // 凭证文件/钥匙串算出来的（web_server 的 status_fn 每次重读，无缓存）——所以
  // 重读一次目录就是真回查。查不到不判失败：copilot-acp 的 status_fn 恒返
  // logged_in:false（服务端注明"没有可编程探测"），硬报错会冤枉已经登录成功的人。
  const recheck = async () => {
    setPhase("rechecking");
    setNotice(null);
    try {
      const snap = await listOAuthProviders(backend);
      if (!alive.current) return;
      const row = snap.providers.find((p) => p.id === provider.id);
      if (row?.status.loggedIn) {
        setPhase("approved");
        toast.success(t("keys.oauthConnectedToast", { name: provider.name }));
        window.setTimeout(() => alive.current && onClose(), 1500);
        return;
      }
      if (row?.status.verification === "unverified") {
        toast.info(t("keys.oauthCredentialDetected", { name: provider.name }));
        onClose();
        return;
      }
      setPhase("external");
      setNotice(t("keys.oauthExternalNotDetected", { name: provider.name, command: provider.cliCommand }));
    } catch (e) {
      if (!alive.current) return;
      setPhase("external");
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const copyCommand = () => {
    navigator.clipboard?.writeText(provider.cliCommand).then(
      () => {
        setCopied(true);
        window.setTimeout(() => alive.current && setCopied(false), 1500);
      },
      () => toast.error(t("keys.copyFailed")),
    );
  };

  // 在系统终端里执行。命令串不经过前端——只发 {provider, kind}，服务端从 oauth
  // 目录解析真实命令；确认框里展示的原文来自目录本身，跟服务端要跑的是同一条。
  const runInTerminal = async () => {
    const ok = await confirm({
      title: t("keys.oauthRunInTerminalTitle"),
      message: t("keys.oauthRunInTerminalMessage", { command: provider.cliCommand }),
      confirmLabel: t("keys.oauthRunInTerminal"),
    });
    if (!ok) return;
    try {
      await runProviderCommandInTerminal(backend, provider.id, "cli");
      toast.info(t("keys.oauthTerminalLaunched"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const close = () => {
    if (session && phase !== "approved" && phase !== "error") {
      cancelOAuthSession(backend, session.sessionId, undefined).catch(() => {});
    }
    onClose();
  };

  const fmt = (s: number | null) => (s === null ? "" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const hasCliCommand = provider.cliCommand.trim().length > 0;
  const dismissible = phase !== "submitting" && phase !== "rechecking";

  return (
    <Modal
      open
      title={t("keys.oauthConnect", { name: provider.name })}
      onClose={close}
      width={440}
      dismissible={dismissible}
    >
      {secondsLeft !== null && phase !== "approved" && phase !== "error" && (
        <p className={styles.cardHint}>{t("keys.oauthSessionExpires", { time: fmt(secondsLeft) })}</p>
      )}

        {phase === "starting" && <p className="muted">{t("keys.oauthStarting")}</p>}
        {phase === "submitting" && <p className="muted">{t("keys.oauthExchanging")}</p>}

        {(phase === "external" || phase === "rechecking") && (
          <>
            <p className={styles.cardDesc}>
              {hasCliCommand
                ? t("keys.oauthExternalPending", { name: provider.name })
                : provider.status.error}
            </p>
            {hasCliCommand && (
              <div className={styles.cmdBlock}>
                <code>{provider.cliCommand}</code>
                <button className={styles.smallBtn} onClick={copyCommand}>
                  {copied ? t("keys.copied") : t("keys.copy")}
                </button>
                {provider.cliRunnable !== false && (
                  <button className={styles.smallBtn} onClick={runInTerminal}>
                    {t("keys.oauthRunInTerminal")}
                  </button>
                )}
              </div>
            )}
            {/* 远程网关：命令在本机跑写不到网关的 auth 存储，只给复制 + 去网关机器跑的提示 */}
            {hasCliCommand && provider.cliRunnable === false && (
              <p className={styles.cardHint}>{t("keys.oauthRemoteHint")}</p>
            )}
            {notice && <p className={styles.modalWarn}>{notice}</p>}
            <div className={styles.modalFoot}>
              {provider.docsUrl ? (
                <a className={styles.getKey} href={provider.docsUrl} target="_blank" rel="noreferrer">
                  {t("keys.oauthDocs", { name: provider.name })} ↗
                </a>
              ) : (
                <span />
              )}
              <span className={styles.oauthActions}>
                <button className={styles.smallBtn} onClick={close} disabled={!dismissible}>
                  {notice ? t("keys.oauthCloseAnyway") : t("common.cancel")}
                </button>
                {hasCliCommand && (
                  <button className={styles.smallBtn} disabled={phase === "rechecking"} onClick={recheck}>
                    {phase === "rechecking" ? "…" : t("keys.oauthSignedIn")}
                  </button>
                )}
              </span>
            </div>
          </>
        )}

        {session?.flow === "pkce" && phase === "awaiting" && (
          <>
            <ol className={styles.modalSteps}>
              <li>{t("keys.oauthPkceStep1")}</li>
              <li>{t("keys.oauthPkceStep2")}</li>
              <li>{t("keys.oauthPkceStep3")}</li>
            </ol>
            <TextInput
              autoFocus
              className="field-input field-mono"
              value={code}
              autoComplete="off"
              placeholder={t("keys.oauthPasteCode")}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <div className={styles.modalFoot}>
              {session.authUrl && (
                <a className={styles.getKey} href={session.authUrl} target="_blank" rel="noreferrer">
                  {t("keys.oauthReopen")} ↗
                </a>
              )}
              <button className={styles.smallBtn} disabled={!code.trim()} onClick={submit}>
                {t("keys.oauthSubmitCode")}
              </button>
            </div>
          </>
        )}

        {session?.flow === "device_code" && phase === "polling" && (
          <>
            <p className={styles.cardDesc}>{t("keys.oauthEnterCodePrompt")}</p>
            <div className={styles.userCode}>
              <code>{session.userCode}</code>
              <button
                className={styles.smallBtn}
                onClick={() => navigator.clipboard?.writeText(session.userCode || "")}
              >
                {t("keys.copy")}
              </button>
            </div>
            {session.verificationUrl && (
              <a className={styles.getKey} href={session.verificationUrl} target="_blank" rel="noreferrer">
                {t("keys.oauthReopenVerification")} ↗
              </a>
            )}
            <p className="muted">{t("keys.oauthWaiting")}</p>
          </>
        )}

        {phase === "approved" && <p className={styles.modalOk}>{t("keys.oauthApproved")}</p>}

        {phase === "error" && (
          <>
            <p className={styles.modalError}>{error || t("keys.oauthLoginFailed")}</p>
            <div className={styles.modalFoot}>
              <button className={styles.smallBtn} onClick={close}>
                {t("common.close")}
              </button>
              <button className={styles.smallBtn} onClick={start}>
                {t("keys.oauthRetry")}
              </button>
            </div>
          </>
        )}

        {/* external 那一支自带页脚（取消/我已登录），别再叠一行取消。 */}
        {phase !== "error" && phase !== "approved" && phase !== "external" && phase !== "rechecking" && (
          <div className={styles.modalFoot}>
            <span />
            <button className={styles.smallBtn} onClick={close} disabled={!dismissible}>
              {t("common.cancel")}
            </button>
          </div>
        )}
    </Modal>
  );
}
