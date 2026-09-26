import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthProvider } from "../../types";
import { disconnectOAuthProvider, listOAuthProviders, runProviderCommandInTerminal } from "../../api/client";
import { useConfirm, useToast } from "../../components/ui";
import OAuthLoginModal from "./OAuthLoginModal";
import ProviderLogo from "./ProviderLogo";
import styles from "./KeysPanel.module.css";

// OAuth 登录卡。布局照设计稿 7093-366：两列网格，一行 = logo + 名称 + 一句状态，
// 操作图标平时藏起来，指到那一行（或键盘聚焦到行内）才浮出来。
//
// 一行只留一句副标题是刻意的：登录态的完整细节（token 来源、过期时间）改走
// title tooltip，行内不再堆叠三四行小字——8 个 provider 两列排开时，行高必须
// 稳定，否则网格会参差。
//
// 没有「登录到哪个 Profile」的选择器，因为 **OAuth 授权本来就是全局的**：Hermes 把
// 授权写 `get_hermes_home()/auth.json`，profile 进程读不到本地授权时只读回落到全局
// 根那份（auth.py `_load_global_auth_store`）。实测 `~/.hermes/auth.json` 的
// providers 有 nous/qwen-oauth/xai-oauth，而 profiles/*/auth.json 的 providers 全空
// ——所以一次登录 5 个 Profile 都能用，断开则广播清干净。曾经那个选择器不只是多余，
// 它还会诱导用户把授权写进某个 isolated profile，反而只有那一个能用。
//
// 显示名与排序照抄官方 components/onboarding/providers.tsx 的 PROVIDER_DISPLAY：
// 服务端给的 name 是 slug 味的（`openai-codex`/`claude-code`），官方在展示层换成
// 人话，两个 Anthropic 条目还特意压到最后（API Key 那条在前、订阅 OAuth 在后）。
// claude-code 那条官方原文很长，两列布局里必然被截断，故按设计稿取短名，完整
// 原文进 title。
const PROVIDER_DISPLAY: Record<string, { order: number; title: string; fullTitle?: string }> = {
  nous: { order: 0, title: "Nous Portal" },
  "openai-codex": { order: 1, title: "OpenAI OAuth (ChatGPT)" },
  "minimax-oauth": { order: 2, title: "MiniMax" },
  "qwen-oauth": { order: 3, title: "Qwen Code" },
  "xai-oauth": { order: 4, title: "xAI Grok" },
  anthropic: { order: 5, title: "Anthropic API Key" },
  "claude-code": {
    order: 6,
    title: "Anthropic OAuth: Usage credits",
    fullTitle: "Anthropic OAuth: Required Extra Usage Credits to Use Subscription",
  },
};
// 覆盖表是 Hermes slug 的（官方展示层映射）；别的后端（OpenClaw 的 anthropic/openai
// 等 id 会撞同名键）一律用服务端给的 name（快照 label 已是人话），按名排序。
const providerTitle = (p: OAuthProvider, backend: string) =>
  backend === "hermes" ? (PROVIDER_DISPLAY[p.id]?.title ?? p.name) : p.name;
const orderOf = (p: OAuthProvider, backend: string) =>
  backend === "hermes" ? (PROVIDER_DISPLAY[p.id]?.order ?? 99) : 50;
const sortProviders = (providers: OAuthProvider[], backend: string) =>
  [...providers].sort((a, b) => orderOf(a, backend) - orderOf(b, backend) || a.name.localeCompare(b.name));

// 图标：项目内联 SVG 的通用形制（16px、currentColor 描边），同 SearchCapsule。
function IconChevron() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={1.6} y={2.6} width={12.8} height={10.8} rx={2.4} />
      <path d="M4.6 6.4 6.8 8.4l-2.2 2" />
      <path d="M8.6 11h2.8" />
    </svg>
  );
}
// 断链（lucide unlink-2 的形制）：两段链环、中间断开 = 解除授权。
function IconUnlink() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4.7h1.3a3.3 3.3 0 0 1 0 6.6H10" />
      <path d="M6 11.3H4.7a3.3 3.3 0 0 1 0-6.6H6" />
    </svg>
  );
}

// 单行。整行与右侧主图标点的是同一件事（登录 / 重新登录 / 去终端登录），
// 断开是唯一的第二动作。
function OAuthRow({
  p,
  backend,
  busy,
  showActionLabels,
  onDisconnect,
  onLogin,
}: {
  p: OAuthProvider;
  backend: string;
  busy: boolean;
  showActionLabels: boolean;
  onDisconnect: (p: OAuthProvider) => void;
  onLogin: (p: OAuthProvider) => void;
}) {
  const { t } = useTranslation();
  const exp = expiresLabel(p.status.expiresAt, (time) => t("keys.oauthExpiresIn", { time }));
  const expired = exp === "expired";
  const isExternal = p.flow === "external";
  const title = providerTitle(p, backend);

  // 一句话副标题：过期最要紧（红字 + 说清怎么救），其次是已连接的凭证出处，
  // 未连接则沿用官方那句 flow 说明（告诉用户点下去会发生什么）。
  const sub = expired
    ? t("keys.oauthRowExpired")
    : p.status.loggedIn
      ? [
          p.status.tokenPreview ? `token ${p.status.tokenPreview}` : t("keys.oauthConnectedBadge"),
          p.status.sourceLabel,
          exp,
        ]
          .filter(Boolean)
          .join(" · ")
      : p.status.verification === "unverified"
        ? t("keys.oauthCredentialUnverified")
      : t(`keys.oauthFlowSub.${p.flow}`);

  // 行内被压缩掉的细节进 tooltip。不再列 connectedProfiles——授权是全局的，那串
  // 恒等于「全部 Profile」，写出来只会让人以为它们各自授权过。
  const tip = [
    backend === "hermes" ? (PROVIDER_DISPLAY[p.id]?.fullTitle ?? title) : title,
    p.status.error,
  ]
    .filter(Boolean)
    .join("\n");

  // 断开：能走 API 就走 API；Hermes 清不掉但给了命令的（claude-code 这类）也照样
  // 给按钮，点下去是「在终端执行这条命令」的确认框。两条路都没有才不显示。
  const canDisconnect = p.status.loggedIn && (p.disconnectable || Boolean(p.disconnectCommand));
  const mainLabel = p.status.loggedIn
    ? t("keys.oauthRelogin")
    : isExternal
      ? t("keys.oauthLoginExternal")
      : t("keys.oauthLogin");

  return (
    <div className={`${styles.oauthRow} ${p.status.error ? styles.oauthRowErr : ""}`}>
      <button className={styles.oauthMain} title={tip} disabled={busy} onClick={() => onLogin(p)}>
        <ProviderLogo name={p.id} />
        <span className={styles.oauthText}>
          <span className={styles.oauthName}>
            {title}
            {p.status.loggedIn && !expired && <span className={styles.oauthDot} aria-hidden="true" />}
          </span>
          <span className={`${styles.oauthSub} ${expired || p.status.error ? styles.oauthSubErr : ""}`}>
            {p.status.error || sub}
          </span>
        </span>
      </button>

      <div className={showActionLabels ? styles.oauthActions : styles.oauthIcons}>
        <button className={showActionLabels ? "ui-cbtn ui-cbtn--sm" : styles.iconBtn} title={mainLabel} aria-label={`${title} — ${mainLabel}`}
          disabled={busy} onClick={() => onLogin(p)}>
          {showActionLabels ? mainLabel : isExternal && p.cliCommand ? <IconTerminal /> : <IconChevron />}
        </button>
        {canDisconnect && (
          <button
            className={`${styles.iconBtn} ${styles.iconDanger}`}
            disabled={busy}
            title={t("keys.oauthDisconnect")}
            aria-label={`${title} — ${t("keys.oauthDisconnect")}`}
            onClick={() => onDisconnect(p)}
          >
            <IconUnlink />
          </button>
        )}
      </div>
    </div>
  );
}
function expiresLabel(expiresAt: string | null, fmt: (time: string) => string): string | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return null;
  const diff = at - Date.now();
  if (diff < 0) return "expired";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return fmt(`${mins}m`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return fmt(`${hours}h`);
  return fmt(`${Math.floor(hours / 24)}d`);
}

export default function OAuthProvidersCard({ id, backend = "hermes", title, showActionLabels = false, refreshKey = 0, onChanged }: {
  id?: string;
  backend?: string;
  title?: string;
  showActionLabels?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<OAuthProvider | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await listOAuthProviders(backend);
      setProviders(snap.providers);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [backend]);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  // 在系统终端里跑该 provider 的断开命令。它会删钥匙串条目/凭证文件 → danger 确认
  // 展示命令原文。前端只发 {provider, kind}，命令串由服务端从 oauth 目录解析。
  const runDisconnectInTerminal = async (p: OAuthProvider) => {
    const ok = await confirm({
      title: t("keys.oauthRunInTerminalTitle"),
      message: t("keys.oauthRunInTerminalMessage", { command: p.disconnectCommand || "" }),
      confirmLabel: t("keys.oauthRunInTerminal"),
      danger: true,
    });
    if (!ok) return;
    try {
      await runProviderCommandInTerminal(backend, p.id, "disconnect");
      toast.info(t("keys.oauthTerminalLaunched"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = async (p: OAuthProvider) => {
    // 能不能 API 断开听 Hermes 的 disconnectable，不看 flow——官方桌面版同款判定
    // (providers-settings.tsx: provider.disconnectable ?? flow !== "external")。
    if (!p.disconnectable) {
      await runDisconnectInTerminal(p);
      return;
    }
    const ok = await confirm({
      title: t("keys.oauthDisconnectTitle", { name: p.name }),
      message: t("keys.oauthDisconnectMessage", { name: p.name }),
      confirmLabel: t("keys.oauthDisconnect"),
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      // 不传 profile = 广播全部（只清 default 会让别的 profile 仍然连着）
      const r = await disconnectOAuthProvider(backend, p.id);
      // 部分 profile 没清干净要说清楚是「哪些没清」，别把原始 401 串丢给用户
      if (r.warnings?.length) toast.info(t("keys.oauthDisconnectPartial", { detail: r.warnings.join("; ") }));
      // 每个 profile 都答「没连这个 provider」→ 什么都没清掉，别报成功
      else if (!r.ok) toast.info(t("keys.oauthNothingToDisconnect", { name: p.name }));
      else toast.success(t("keys.oauthDisconnected", { name: p.name }));
      await refresh();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const connected = providers?.filter((p) => p.status.loggedIn).length ?? 0;
  const ordered = sortProviders(providers ?? [], backend);

  return (
    <section className={styles.card} id={id}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadRow}>
          <h4 className={styles.cardTitle}>{title || t("keys.oauthTitle")}</h4>
          <div className={styles.oauthActions}>
          </div>
        </div>
        <p className={styles.cardDesc}>
          {providers !== null && t("keys.oauthConnected", { connected, total: providers.length })}
        </p>
      </div>

      <div className={styles.cardBody}>
        {loading && providers === null && <p className="muted">{t("common.loading")}</p>}
        {error && <div className="settings-actions" role="alert"><span>{t("settings.runtimeAuthUnavailable")}</span><button className="ui-cbtn ui-cbtn--sm" disabled={loading} onClick={() => void refresh()}>{t("settings.retry")}</button></div>}
        {!error && providers !== null && providers.length === 0 && <p className="muted">{t("keys.oauthNone")}</p>}
        {ordered.length > 0 && (
          <div className={showActionLabels ? styles.oauthList : styles.oauthGrid}>
            {ordered.map((p) => (
              <OAuthRow
                key={p.id}
                p={p}
                backend={backend}
                busy={error || busyId === p.id}
                showActionLabels={showActionLabels}
                onDisconnect={disconnect}
                onLogin={setLoginFor}
              />
            ))}
          </div>
        )}
      </div>

      {loginFor && (
        <OAuthLoginModal
          provider={loginFor}
          backend={backend}
          onClose={() => {
            setLoginFor(null);
            refresh();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}
