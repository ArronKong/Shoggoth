import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EnvVar } from "../../types";
import { deleteEnvVar, listEnvVars, revealEnvVar, setEnvVar, validateProviderCredential } from "../../api/client";
import { useConfirm, useToast } from "../../components/ui";
import OAuthProvidersCard from "./OAuthProvidersCard";
import ProviderLogo from "./ProviderLogo";
import { ProviderCredentialFields } from "./ProviderCredentialFields";
import { SHOW_TOOL_KEYS, ToolKeysCard, type ToolKeyItem } from "./ToolKeysCard";
import { builtinEndpointFor } from "./hermes-endpoints";
import styles from "./KeysPanel.module.css";

// Hermes 密钥面板：OAuth 登录卡 + 模型 provider 分组 + 工具密钥。Hermes-only；
// 没有 env API 的后端读到空列表。值全部脱敏，明文只在点「查看」时按需拉。
//
// 官方 /env 页还有「网关 / 设置 / 自定义密钥」三类（消息平台白名单、sudo 密码、
// .env 里的散键）。本 App 只管跨 agent 的模型凭证，那三类不做——要调它们请去
// Hermes 后端自己的界面。

// 官方 EnvPage 的前缀分组表（desktop/src/app/settings/constants.ts，30 条 1:1 抄来）。
// 这是**首选**分组依据，不是兜底——见 providerGroupName 的注释。
const PROVIDER_GROUPS: { prefix: string; name: string; priority: number }[] = [
  { prefix: "NOUS_", name: "Nous Portal", priority: 0 },
  { prefix: "FIREWORKS_", name: "Fireworks AI", priority: 1 },
  { prefix: "OPENROUTER_", name: "OpenRouter", priority: 1 },
  { prefix: "ANTHROPIC_", name: "Anthropic", priority: 2 },
  { prefix: "XAI_", name: "xAI", priority: 3 },
  { prefix: "GOOGLE_", name: "Gemini", priority: 4 },
  { prefix: "GEMINI_", name: "Gemini", priority: 4 },
  { prefix: "DEEPSEEK_", name: "DeepSeek", priority: 5 },
  { prefix: "DASHSCOPE_", name: "DashScope (Qwen)", priority: 6 },
  { prefix: "HERMES_QWEN_", name: "DashScope (Qwen)", priority: 6 },
  { prefix: "GLM_", name: "GLM / Z.AI", priority: 7 },
  { prefix: "ZAI_", name: "GLM / Z.AI", priority: 7 },
  { prefix: "Z_AI_", name: "GLM / Z.AI", priority: 7 },
  { prefix: "KIMI_", name: "Kimi / Moonshot", priority: 8 },
  { prefix: "KIMI_CN_", name: "Kimi (China)", priority: 9 },
  { prefix: "MINIMAX_", name: "MiniMax", priority: 10 },
  { prefix: "MINIMAX_CN_", name: "MiniMax (China)", priority: 11 },
  { prefix: "HF_", name: "Hugging Face", priority: 12 },
  { prefix: "OPENCODE_ZEN_", name: "OpenCode Zen", priority: 13 },
  { prefix: "OPENCODE_GO_", name: "OpenCode Go", priority: 14 },
  { prefix: "NVIDIA_", name: "NVIDIA NIM", priority: 15 },
  { prefix: "OLLAMA_", name: "Ollama Cloud", priority: 16 },
  { prefix: "LM_", name: "LM Studio", priority: 17 },
  { prefix: "STEPFUN_", name: "StepFun", priority: 18 },
  { prefix: "XIAOMI_", name: "Xiaomi MiMo", priority: 19 },
  { prefix: "ARCEEAI_", name: "Arcee AI", priority: 20 },
  { prefix: "ARCEE_", name: "Arcee AI", priority: 20 },
  { prefix: "GMI_", name: "GMI Cloud", priority: 21 },
  { prefix: "AZURE_FOUNDRY_", name: "Azure Foundry", priority: 22 },
  { prefix: "AWS_", name: "AWS Bedrock", priority: 23 },
];
// 最长前缀胜出（同官方 helpers.ts 的 providerGroup）：`MINIMAX_CN_` 必须压过
// `MINIMAX_`、`KIMI_CN_` 压过 `KIMI_`。别退回「按数组顺序取首个 startsWith」——
// 那样表的排列顺序就成了承重结构，加一条就可能把子品牌吞进母品牌。
function prefixGroup(key: string): string | null {
  let best: (typeof PROVIDER_GROUPS)[number] | undefined;
  for (const g of PROVIDER_GROUPS) {
    if (!key.startsWith(g.prefix)) continue;
    if (!best || g.prefix.length > best.prefix.length) best = g;
  }
  return best?.name ?? null;
}
function groupPriority(name: string): number {
  return PROVIDER_GROUPS.find((g) => g.name === name)?.priority ?? 99;
}

// 端点覆盖变量。Hermes 给可改端点的 provider 统一声明 `<PROVIDER>_BASE_URL`
// （hermes_cli/config.py 的 env 目录，实测 25 家全是这个形态）；没有这一条的
// provider 端点写死在 ProviderProfile.base_url 里，界面上就不给编辑。
const BASE_URL_RE = /_BASE_URL$/;

type ProviderRowProps = {
  busy: string | null;
  onSave: (key: string, value?: string) => Promise<boolean>;
  onClear: (key: string) => void;
  /** Provider 字段按需取明文；不写入工具密钥行的受控 reveal 状态。 */
  onRevealPlain: (key: string) => Promise<string | null>;
  onValidate: (key: string, value?: string) => Promise<void>;
};

// provider 分组卡。布局照设计稿 6958-135：一行标题（logo + 组名 + 已配置点 +
// 右侧取密钥链接）＋一行两列输入框（左 Base URL、右 API Key）。
//
// 左列的可编辑性不是我们定的，是 Hermes 定的：内置 provider 的端点写死在
// providers/<slug> 的 ProviderProfile.base_url 里，只有额外声明了 `*_BASE_URL`
// 环境变量的那些（deepseek/xai/gemini…约 25 家）才留了覆盖钩子。没有那个变量
// 的（openrouter/zai/copilot…）端点就是不可改的，这里渲染成禁用输入框并说明
// 原因——比藏起来强：用户问的正是「为什么这家能改那家不能」。
function ProviderGroupCard({
  group,
  rowProps,
}: {
  group: ProviderKeyGroup;
  rowProps: ProviderRowProps;
}) {
  const { t } = useTranslation();
  const baseUrl = group.baseUrl;
  const secret = group.primary;
  // Hermes 不外发内置端点，本地带了一份（见 hermes-endpoints.ts）。
  const builtin = builtinEndpointFor(group.slug);
  const lockedLabel = builtin
    ? `${builtin} · ${t("keys.baseUrlLocked")}`
    : t("keys.baseUrlBuiltin");

  return (
    <div className={styles.group}>
      <div className={styles.groupHeadRow}>
        <div className={styles.groupName}>
          <ProviderLogo name={group.name} />
          <span className={styles.groupTitle}>{group.name}</span>
          {group.hasAnySet && <span className={styles.dotOn} aria-hidden="true" />}
        </div>
        {group.docsUrl && (
          <a className={styles.getKey} href={group.docsUrl} target="_blank" rel="noreferrer">
            {t("keys.getKey")} ↗
          </a>
        )}
      </div>

      <ProviderCredentialFields
        baseUrl={{
          value: baseUrl ? null : lockedLabel,
          fallback: builtin,
          configured: baseUrl?.isSet ?? false,
          preview: baseUrl?.redactedValue,
          placeholder: t("keys.baseUrlPlaceholder"),
          ariaLabel: baseUrl?.key ?? lockedLabel,
          title: baseUrl
            ? `${baseUrl.key}${baseUrl.description ? ` — ${baseUrl.description}` : ""}`
            : t("keys.baseUrlBuiltinHint", { name: group.name }),
        }}
        secret={{
          value: null,
          configured: secret.isSet,
          preview: secret.redactedValue,
          placeholder: t("keys.enterValue"),
          ariaLabel: secret.key,
          title: `${secret.key}${secret.description ? ` — ${secret.description}` : ""}`,
        }}
        busy={rowProps.busy === baseUrl?.key || rowProps.busy === secret.key}
        capabilities={{
          editBaseUrl: Boolean(baseUrl),
          clearBaseUrl: Boolean(baseUrl?.isSet),
          revealSecret: secret.isSet,
          validateSecret: true,
          clearSecret: secret.isSet,
        }}
        onSaveBaseUrl={(value) => baseUrl ? rowProps.onSave(baseUrl.key, value) : false}
        validateBaseUrl={(value) => value.trim() !== ""}
        onResolveBaseUrlForEdit={() => baseUrl
          ? rowProps.onRevealPlain(baseUrl.key)
          : Promise.resolve(null)}
        onClearBaseUrl={() => {
          if (baseUrl) return rowProps.onClear(baseUrl.key);
        }}
        onSaveSecret={(value) => rowProps.onSave(secret.key, value)}
        onRevealSecret={() => rowProps.onRevealPlain(secret.key)}
        onValidateSecret={(value) => rowProps.onValidate(secret.key, value)}
        onClearSecret={() => rowProps.onClear(secret.key)}
      />

    </div>
  );
}
// 官方 credential-key-ui.tsx 的同名判定（`is_password || /_API_KEY|_TOKEN|_KEY$/`）。
// 比原来的「_API_KEY 或 _TOKEN 结尾」多认 `_KEY` 后缀与一切 is_password 变量，
// 挑 primary 全靠它——认漏一个，那个 provider 就会被当成「没有 Key」整组藏掉。
function isKeyVar(v: EnvVar) {
  return v.isPassword || /(?:_API_KEY|_TOKEN|_KEY)$/.test(v.key);
}

// 一个 provider 组：primary（Key）与 baseUrl（端点覆盖）各占一列常显，
// 其余旋钮折进 advanced。baseUrl 缺席 = 该 provider 的端点由 Hermes 写死。
type ProviderKeyGroup = {
  name: string;
  /** provider slug（`/api/env` 的 provider 字段）——查内置端点用它，不用会变的显示名 */
  slug: string;
  primary: EnvVar;
  baseUrl?: EnvVar;
  hasAnySet: boolean;
  docsUrl?: string;
  priority: number;
};

export default function KeysPanel({
  id,
  /** 插在「模型 Provider」与「工具密钥」之间的卡片（自定义端点面板走这里） */
  endpointsSlot,
}: { id?: string; endpointsSlot?: ReactNode } = {}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllProviders, setShowAllProviders] = useState(false); // 未配置的 provider 默认折起

  const refresh = useCallback(async () => {
    try {
      setVars(await listEnvVars("hermes"));
      setLoadFailed(false);
    } catch {
      // 读失败 ≠「没配任何密钥」——Hermes dashboard 可能只是没起来。
      setVars([]);
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSave = async (key: string, explicitValue?: string): Promise<boolean> => {
    const value = explicitValue;
    if (!value) return false;
    setBusy(key);
    try {
      await setEnvVar("hermes", key, value);
      toast.success(`${t("keys.saved", { key })} · ${t("keys.changesNote")}`);
      await refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const onClear = async (key: string) => {
    const v = vars?.find((x) => x.key === key);
    const ok = await confirm({
      title: t("keys.confirmClearTitle"),
      message: `${key}${v?.description ? ` — ${v.description}` : ""}. ${t("keys.confirmClearMessage")}`,
      confirmLabel: t("keys.clear"),
      danger: true,
    });
    if (!ok) return false;
    setBusy(key);
    try {
      await deleteEnvVar("hermes", key);
      toast.success(`${t("keys.cleared", { key })} · ${t("keys.changesNote")}`);
      await refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revealPlain = async (key: string): Promise<string | null> => {
    setBusy(key);
    try {
      return await revealEnvVar("hermes", key);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const onValidate = async (key: string, explicitValue?: string) => {
    const value = explicitValue;
    if (!value) return;
    setBusy(key);
    try {
      const r = await validateProviderCredential("hermes", key, value);
      if (!r.supported) toast.info(t("keys.validateUnsupported"));
      else if (r.valid) toast.success(t("keys.validateOk"));
      else toast.error(t("keys.validateFail", { error: r.error || "" }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rowProps = {
    busy,
    onSave,
    onClear,
    onRevealPlain: revealPlain,
    onValidate,
  };

  const { providerGroups, toolCategory } = useMemo(() => {
    const list = vars ?? [];

    // 官方 providers-settings.tsx `buildProviderKeyGroups` 的同款三步。别按直觉
    // 改成「前缀表优先」——官方注释写明 provider_label/provider 才是权威归属
    // （来自 hermes_cli/provider_catalog.py，与 `hermes model` 同一套身份），
    // 前缀表只是给「早于后端打标」的老变量兜底：
    //   ① 归属 = providerLabel → provider → 前缀表；
    //   ② 落到「其它」桶的整条丢弃；
    //   ③ 组内挑 primary（首个非 advanced 的 Key 变量，退而求其次任一 Key 变量），
    //      **挑不出 primary 的组整组不渲染**。
    // 第 ③ 条正是官方让「有 URL 没 Key」的空壳组消失的机制：`Nous Portal` 只有
    // NOUS_BASE_URL、`DashScope (Qwen)` 只有 HERMES_QWEN_BASE_URL、外加
    // `Google Vertex AI`/`AWS Bedrock`——这四组官方一个都不显示。Nous 的入口在
    // OAuth 卡；DashScope 的 Key 在服务端叫 `Qwen Cloud` 的那组里，不是丢了。
    // provider 组**不受「显示高级」开关过滤**（官方连那个 localStorage flag 都主动
    // 删了）：这些变量几乎全是 advanced=true，跟着开关走会整片消失；`advanced`
    // 在这里的正确用途是组内区分 primary 与折叠项。
    const otherLabel = t("keys.other");
    const buckets = new Map<string, EnvVar[]>();
    for (const v of list) {
      if (v.category !== "provider") continue;
      const name = v.providerLabel?.trim() || v.provider?.trim() || prefixGroup(v.key) || otherLabel;
      if (name === otherLabel) continue;
      const arr = buckets.get(name);
      if (arr) arr.push(v);
      else buckets.set(name, [v]);
    }
    const groups: ProviderKeyGroup[] = [];
    for (const [name, entries] of buckets) {
      const primary = entries.find((v) => !v.advanced && isKeyVar(v)) ?? entries.find((v) => isKeyVar(v));
      if (!primary) continue;
      groups.push({
        name,
        slug: entries.find((v) => v.provider?.trim())?.provider?.trim() || "",
        primary,
        // 端点覆盖变量（有就开放编辑，没有就是 Hermes 写死的内置端点）
        baseUrl: entries.find((v) => !isKeyVar(v) && BASE_URL_RE.test(v.key)),
        hasAnySet: entries.some((v) => v.isSet),
        docsUrl: primary.url || undefined,
        priority: groupPriority(name),
      });
    }
    groups.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    // 只留工具密钥一类。网关 / 设置 / 自定义密钥三张卡已下线：那些是 Hermes
    // 自己的运行时旋钮（消息平台白名单、sudo 密码、.env 里的散键），这个 App
    // 只管跨 agent 的模型凭证，要调它们请去 Hermes 后端。
    // 平台凭证（channelManaged）归渠道配置，这里不重复暴露——同官方。
    const toolEntries = list.filter((v) => v.category === "tool" && !v.channelManaged);
    const asToolKeyItem = (v: EnvVar): ToolKeyItem => ({
      ...v,
      canReveal: v.isSet,
      canValidate: true,
      canClear: v.isSet,
    });

    return {
      providerGroups: groups,
      toolCategory: {
        setEntries: toolEntries.filter((v) => v.isSet).map(asToolKeyItem),
        unsetEntries: toolEntries.filter((v) => !v.isSet).map(asToolKeyItem),
      },
    };
  }, [vars, t]);


  if (vars === null) return <p className="muted">{t("common.loading")}</p>;
  if (loadFailed) return <p className="status-error">{t("keys.loadFailed")}</p>;

  // 默认只摆「已配置」的那几家，其余折起来——31 家全列开会把这一页拉成长条，
  // 而绝大多数人只配了一两家。一家都没配时给前 3 家当引子，否则页面会是空的。
  const configured = providerGroups.filter((g) => g.hasAnySet);
  const visibleGroups = showAllProviders
    ? providerGroups
    : configured.length > 0
      ? configured
      : providerGroups.slice(0, 3);
  const hiddenCount = providerGroups.length - visibleGroups.length;
  const toolCount = toolCategory.setEntries.length + toolCategory.unsetEntries.length;

  return (
    <div className={styles.panel} id={id}>
      <OAuthProvidersCard id="keys-oauth" />

      <section className={styles.card} id="keys-providers">
        <div className={styles.cardHead}>
          <div className={styles.cardHeadRow}>
            <h4 className={styles.cardTitle}>{t("keys.llmProviders")}</h4>
            {showAllProviders ? (
              <button className={styles.linkBtn} aria-expanded onClick={() => setShowAllProviders(false)}>
                {t("keys.showLess")}
              </button>
            ) : hiddenCount > 0 ? (
              <button className={styles.linkBtn} aria-expanded={false}
                onClick={() => setShowAllProviders(true)}>
                {t("keys.showAllProviders", { count: hiddenCount })}
              </button>
            ) : null}
          </div>
          <p className={styles.cardDesc}>
            {t("keys.providersConfigured", { configured: configured.length, total: providerGroups.length })}
          </p>
        </div>
        <div className={`${styles.cardBody} ${styles.cardBodyFlush}`}>
          {visibleGroups.map((g) => (
            <ProviderGroupCard key={g.name} group={g} rowProps={rowProps} />
          ))}
        </div>
      </section>

      {/* 自定义端点排在工具密钥前面：它跟上面的 provider 目录是一件事的两半
          （内置 provider 的密钥 / 自建 provider 的地址），工具密钥是另一码事。 */}
      {endpointsSlot}

      {SHOW_TOOL_KEYS && toolCount > 0 && (
        <ToolKeysCard
          id="keys-tool"
          title={t("keys.catTool")}
          description={t("keys.nOfMConfigured", {
            configured: toolCategory.setEntries.length,
            total: toolCount,
          })}
          setEntries={toolCategory.setEntries}
          unsetEntries={toolCategory.unsetEntries}
          showUnsetDirectory
          canAdd={false}
          loading={false}
          onSave={onSave}
          onReveal={revealPlain}
          onValidate={(key, value) => onValidate(key, value)}
          onClear={onClear}
        />
      )}
    </div>
  );
}
