import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HermesModelSettings as SettingsSnapshot,
  ModelSettingsProvider,
  MoaConfig,
  MoaPreset,
  MoaSlot,
  OAuthProvider,
  StaleAuxSlot,
} from "../../types";
import {
  applyMainModel,
  getModelSettings,
  getRecommendedDefaultModel,
  listOAuthProviders,
  saveMoaConfig,
  setAuxiliaryModel,
  setEnvVar,
  setFallbackModels,
  setModelDefaults,
} from "../../api/client";
import { useToast } from "../../components/ui";
import { createKeyedMutationGuard } from "../../lib/lowUiLifecycle";

// 官方 VALID_REASONING_EFFORTS 同款（none = 关闭思考；空配置 = medium）。
export const EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

// agent.service_tier 的 fast 语义（官方 isFastTier 同款）。
const isFastTier = (tier: string) => ["fast", "priority", "on"].includes(tier.trim().toLowerCase());

// provider 行「就绪可选模型」判定（官方 isProviderReady 同款）：
// 未配置的 provider authenticated:false 且 models 为空 → 需要先设置。
const isProviderReady = (p?: ModelSettingsProvider) =>
  !!p && (p.authenticated !== false || (p.models?.length ?? 0) > 0);

// 选中值不在 curated 列表时插到最前，避免下拉空白（官方 withActive 同款）。
export const withActive = (models: readonly string[], active: string): string[] =>
  active && !models.includes(active) ? [active, ...models] : [...models];

// MoA 槽位完整（官方 moaSlotComplete 同款）。
const moaSlotComplete = (slot: MoaSlot) => !!(slot.provider.trim() && slot.model.trim());

// 全部预设全部槽位齐全才允许落盘（官方 moaConfigComplete；半填会被服务端 422）。
const moaConfigComplete = (config: MoaConfig) =>
  Object.values(config.presets).every(
    (preset) =>
      preset.referenceModels.length > 0 &&
      preset.referenceModels.every(moaSlotComplete) &&
      moaSlotComplete(preset.aggregator),
  );

export interface AuxDraft {
  provider: string;
  model: string;
}

/**
 * per-agent 模型设置面的全部状态与写动作。
 *
 * 一个 agent = 一个 Hermes profile = 一份独立 config，所以作用域由调用方给的
 * `profile` 决定（`UnifiedAgentDetail.profile`），面板自己不再持有 profile 选择器。
 * 后端不提供整合设置面时（OpenClaw）返回 `supported:false`，两个视图各自 `return null`
 * —— 隐身靠后端自报，不靠 UI 特判后端（铁律 1）。
 *
 * 返回值故意**平铺**且与原 HermesModelSettings 的局部变量同名：两个视图组件
 * （AgentMainModelField / AgentModelCards）由此能原样复用那份 JSX，不引入行为漂移。
 */
export function useAgentModelSettings({
  backend,
  profile: profileProp,
  reloadToken,
  onMainModelChanged,
  onNavigate,
}: {
  backend: string;
  /** 目标 profile（= 当前 agent）。空 = 该后端没有 profile 概念 → 不发请求。 */
  profile?: string;
  /** 页面「刷新」递增此值 → 跟着重拉快照。 */
  reloadToken: number;
  /** 主模型换了 → 通知页面重拉 agent detail（卡片上的模型/提供方跟着变）。 */
  onMainModelChanged: () => void;
  /** 未配置 provider 的设置引导：跳到模型页的凭证区（keys）或自定义端点区（endpoints）。 */
  onNavigate: (section: "keys" | "endpoints") => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();

  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 首次快照是否已落地（成功或失败都算）。加载中的 supported=false 只是「还不知道」，
  // 不是「该后端没有整合设置面」——把两者混为一谈会让页面先渲染一帧错形态（R293）。
  const [settled, setSettled] = useState(false);
  // profile 切换/组件卸载后丢弃过期响应（官方 profileEpoch 同款）。
  const epoch = useRef(0);
  // 只在换 profile（含强制重载）时自增。epoch 每次 load 都会跳——写完就地重载也会跳，
  // 拿它当「换了 agent」判据会把同 profile 的失败回报一并吞掉。
  const profileEpoch = useRef(0);
  const activationSeqRef = useRef(0);
  const defaultMutationGuardRef = useRef<ReturnType<typeof createKeyedMutationGuard> | null>(null);
  if (!defaultMutationGuardRef.current) defaultMutationGuardRef.current = createKeyedMutationGuard();
  const defaultMutationGuard = defaultMutationGuardRef.current;
  // 最近一次已落盘的后备链序列化（echo 判重，避免 load 回填触发重复写）。
  const fallbackSavedRef = useRef("[]");

  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [applying, setApplying] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [activating, setActivating] = useState(false);
  const [switchStaleAux, setSwitchStaleAux] = useState<StaleAuxSlot[]>([]);

  const [editingAuxTask, setEditingAuxTask] = useState<string | null>(null);
  const [auxDraft, setAuxDraft] = useState<AuxDraft>({ provider: "", model: "" });
  const [auxBusy, setAuxBusy] = useState(false);

  const [moa, setMoa] = useState<MoaConfig | null>(null);
  const [selectedMoaPreset, setSelectedMoaPreset] = useState("");
  const [newMoaPresetName, setNewMoaPresetName] = useState("");
  const [moaBusy, setMoaBusy] = useState(false);

  const [fallbackRows, setFallbackRows] = useState<AuxDraft[]>([]);

  const [oauthSetup, setOauthSetup] = useState<OAuthProvider | null>(null);

  const load = useCallback(
    async (profile?: string, { replaceSelection = false } = {}) => {
      const actionEpoch = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const next = await getModelSettings(backend, profile);
        if (actionEpoch !== epoch.current) return null;
        setSnapshot(next);
        if (next.supported) {
          const main = next.main || { provider: "", model: "" };
          if (replaceSelection) {
            setSelectedProvider(main.provider);
            setSelectedModel(main.model);
          } else {
            setSelectedProvider((prev) => prev || main.provider);
            setSelectedModel((prev) => prev || main.model);
          }
          setMoa(next.moa ?? null);
          if (next.moa) {
            setSelectedMoaPreset((prev) =>
              prev && next.moa!.presets[prev] ? prev : next.moa!.defaultPreset,
            );
          }
          setFallbackRows((next.fallbacks || []).map((f) => ({ provider: f.provider, model: f.model })));
          fallbackSavedRef.current = JSON.stringify(next.fallbacks || []);
        }
        return next;
      } catch (e) {
        if (actionEpoch === epoch.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return null;
      } finally {
        // settled 与 loading 一起翻：这一跳之后 supported 才是「后端的真实答复」。
        if (actionEpoch === epoch.current) {
          setLoading(false);
          setSettled(true);
        }
      }
    },
    [backend],
  );

  // 换 agent = 换 profile = 换数据源，草稿选择一并作废，重载后以新 profile 的真值为准。
  // profileProp 为空（后端无 profile 概念 / detail 还没到）时不发请求，保持未就绪态。
  useEffect(() => {
    setSelectedProvider("");
    setSelectedModel("");
    setApiKeyDraft("");
    setSwitchStaleAux([]);
    setEditingAuxTask(null);
    // 兜底归零：hook 不随 agent 重挂，任何原因残留的 busy 都会把新 agent 的按钮
    // 钉在禁用态（各写操作自身的清除见 doApplyMain 处 profileEpoch 的说明）。
    setApplying(false);
    setActivating(false);
    setAuxBusy(false);
    setMoaBusy(false);
    // 作废在途防抖存盘的回填（写本身仍落到原 profile，不撤销用户已做的编辑）。
    moaSaveGeneration.current += 1;
    activationSeqRef.current += 1;
    defaultMutationGuard.invalidateScope();
    profileEpoch.current += 1;
    if (!profileProp) {
      setSnapshot(null);
      setLoading(false);
      setSettled(false);
      return;
    }
    void load(profileProp, { replaceSelection: true });
    return () => {
      epoch.current += 1;
      defaultMutationGuard.invalidateScope();
    };
  }, [load, profileProp, reloadToken]);

  const supported = snapshot?.supported === true;
  const profile = snapshot?.profile;
  const profiles = useMemo(() => snapshot?.profiles || [], [snapshot]);
  const providers = useMemo(() => snapshot?.providers || [], [snapshot]);
  const main = snapshot?.main || { provider: "", model: "" };
  const aux = snapshot?.auxiliary || { slots: [], main: {} };

  // 已保存 provider 不在目录时保持可见可选（官方 mainProviderOptions 同款）。
  const mainProviderOptions = useMemo<ModelSettingsProvider[]>(
    () =>
      selectedProvider && !providers.some((p) => p.slug === selectedProvider)
        ? [{ name: selectedProvider, slug: selectedProvider, models: [] }, ...providers]
        : providers,
    [providers, selectedProvider],
  );

  const selectedProviderRow = useMemo(
    () => providers.find((p) => p.slug === selectedProvider),
    [providers, selectedProvider],
  );
  const needsSetup = !!selectedProvider && !isProviderReady(selectedProviderRow);
  const setupIsApiKey =
    needsSetup && selectedProviderRow?.authType === "api_key" && !!selectedProviderRow?.keyEnv;
  const setupIsCustom = (() => {
    const slug = (selectedProviderRow?.slug || selectedProvider || "").toLowerCase();
    return needsSetup && (slug === "custom" || slug === "local" || slug.startsWith("custom:"));
  })();

  // 切 provider 清掉半输入的 Key，不跨 provider 泄漏（官方同款）。
  useEffect(() => {
    setApiKeyDraft("");
  }, [selectedProvider]);

  const modelsForProvider = useCallback(
    (slug: string) => providers.find((p) => p.slug === slug)?.models ?? [],
    [providers],
  );

  const selectMainProvider = (slug: string) => {
    activationSeqRef.current += 1;
    setSelectedProvider(slug);
    const models = providers.find((p) => p.slug === slug)?.models ?? [];
    setSelectedModel((prev) => (models.includes(prev) ? prev : ""));
  };

  const mainSelectionValid =
    !!selectedProvider &&
    !!selectedModel &&
    selectedProviderRow?.models.includes(selectedModel) === true &&
    selectedProviderRow.unavailableModels?.includes(selectedModel) !== true;

  // ---- 主模型 ----

  const doApplyMain = async () => {
    if (!mainSelectionValid || applying) return;
    const actionEpoch = epoch.current;
    // epoch 判「这次响应还新鲜吗」，profileEpoch 判「还是同一个 agent 吗」。UI 反馈
    // （busy 标志/报错）必须用后者：本函数成功路径自己会 load()，那会顶掉 epoch，
    // 拿 epoch 守 finally 等于永远不清 busy，控件就此永久禁用。
    const actionProfileEpoch = profileEpoch.current;
    setApplying(true);
    try {
      const r = await applyMainModel(backend, profile, selectedProvider, selectedModel);
      if (actionEpoch !== epoch.current) return;
      setSwitchStaleAux(r.staleAux || []);
      toast.success(t("models.settings.appliedOk", { provider: r.provider, model: r.model }));
      onMainModelChanged();
      await load(profile, { replaceSelection: true });
    } catch (e) {
      if (actionProfileEpoch === profileEpoch.current) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (actionProfileEpoch === profileEpoch.current) setApplying(false);
    }
  };

  // api_key 类未配置 provider 的行内激活：写 env（服务端广播全部 profile）→
  // 拉推荐默认模型 → 重载目录并预选（官方 activateApiKeyProvider 同款）。
  const doActivateApiKey = async () => {
    const row = selectedProviderRow;
    if (!row?.keyEnv || !row.slug || !apiKeyDraft.trim() || activating) return;
    const activationSeq = ++activationSeqRef.current;
    const actionProfileEpoch = profileEpoch.current; // 同 doApplyMain：UI 反馈只随换 agent 作废
    const isActivationCurrent = () =>
      activationSeq === activationSeqRef.current && actionProfileEpoch === profileEpoch.current;
    setActivating(true);
    try {
      await setEnvVar(backend, row.keyEnv, apiKeyDraft.trim());
      if (!isActivationCurrent()) return;
      setApiKeyDraft("");
      let nextModel = "";
      try {
        const rec = await getRecommendedDefaultModel(backend, row.slug, profile);
        nextModel = rec.model || "";
      } catch {
        nextModel = "";
      }
      if (!isActivationCurrent()) return;
      toast.success(t("models.settings.activatedOk", { name: row.name || row.slug }));
      const next = await load(profile);
      if (!isActivationCurrent() || !next) return;
      const refreshedProvider = (next.providers || []).find((provider) => provider.slug === row.slug);
      const refreshedModels = refreshedProvider?.models || [];
      const unavailable = refreshedProvider?.unavailableModels || [];
      const recommended =
        nextModel && refreshedModels.includes(nextModel) && !unavailable.includes(nextModel)
          ? nextModel
          : "";
      const refreshedMain = next.main?.provider === row.slug ? next.main.model : "";
      setSelectedProvider(row.slug);
      setSelectedModel(
        recommended ||
          (refreshedMain && refreshedModels.includes(refreshedMain) && !unavailable.includes(refreshedMain)
            ? refreshedMain
            : ""),
      );
    } catch (e) {
      if (actionProfileEpoch === profileEpoch.current) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (actionProfileEpoch === profileEpoch.current) setActivating(false);
    }
  };

  // OAuth / external / custom 类的设置引导：custom → 模型页的自定义端点区；
  // 目录里有对应 OAuth provider → 直接弹官方同款登录流；其余回落到密钥区。
  const startProviderSetup = async () => {
    if (setupIsCustom) {
      onNavigate("endpoints");
      return;
    }
    const slug = selectedProviderRow?.slug || selectedProvider;
    try {
      const snap = await listOAuthProviders(backend);
      const match =
        snap.providers.find((p) => p.id === slug) ||
        snap.providers.find((p) => p.name.toLowerCase() === (selectedProviderRow?.name || "").toLowerCase());
      if (match && match.flow !== "external") {
        setOauthSetup(match);
        return;
      }
    } catch {
      /* 回落密钥区 */
    }
    onNavigate("keys");
  };

  // ---- 默认参数（reasoning_effort / service_tier）----

  const mainCaps = useMemo(() => {
    const row = providers.find((p) => p.slug === main.provider);
    return row?.capabilities?.[main.model];
  }, [providers, main.provider, main.model]);
  const reasoningSupported = mainCaps?.reasoning ?? true;
  const fastSupported = mainCaps?.fast ?? false;

  const rawEffort = (snapshot?.defaults?.reasoningEffort || "").trim().toLowerCase();
  const effortValue =
    rawEffort === "false" || rawEffort === "disabled" ? "none" : rawEffort || "medium";
  const fastOn = isFastTier(snapshot?.defaults?.serviceTier || "");

  // 乐观更新；逐 target+field 的确认值只由成功请求推进，最新失败回到确认值。
  const writeDefault = async (patch: { reasoningEffort?: string; serviceTier?: string }) => {
    if (!snapshot) return;
    type DefaultField = "reasoningEffort" | "serviceTier";
    const target = [backend, profile || profileProp || ""].join("\u0000");
    const fields = (Object.keys(patch) as DefaultField[]).filter((field) => patch[field] !== undefined);
    const previous = {
      reasoningEffort: snapshot.defaults?.reasoningEffort ?? "",
      serviceTier: snapshot.defaults?.serviceTier ?? "",
    };
    const tickets = fields.map((field) => ({
      field,
      ticket: defaultMutationGuard.begin(target, field, previous[field]),
    }));
    setSnapshot((current) =>
      current
        ? {
            ...current,
            defaults: {
              reasoningEffort: patch.reasoningEffort ?? current.defaults?.reasoningEffort ?? "",
              serviceTier: patch.serviceTier ?? current.defaults?.serviceTier ?? "",
            },
          }
        : current,
    );
    try {
      await setModelDefaults(backend, profile, patch);
      const reconciliations: Array<{ field: DefaultField; value: string }> = [];
      for (const { field, ticket } of tickets) {
        const value = patch[field];
        if (value === undefined || !defaultMutationGuard.confirm(ticket, target, field, value)) continue;
        const reconciled = defaultMutationGuard.reconcileValue(ticket, target, field);
        if (reconciled !== null) reconciliations.push({ field, value: reconciled });
      }
      if (reconciliations.length > 0) {
        setSnapshot((current) => {
          if (!current) return current;
          const defaults = {
            reasoningEffort: current.defaults?.reasoningEffort ?? "",
            serviceTier: current.defaults?.serviceTier ?? "",
          };
          for (const { field, value } of reconciliations) defaults[field] = value;
          return { ...current, defaults };
        });
      }
    } catch (e) {
      const rollbacks = tickets.flatMap(({ field, ticket }) => {
        const value = defaultMutationGuard.rollbackValue(ticket, target, field);
        return value === null ? [] : [{ field, value }];
      });
      if (rollbacks.length === 0) return;
      setSnapshot((current) => {
        if (!current) return current;
        const defaults = {
          reasoningEffort: current.defaults?.reasoningEffort ?? "",
          serviceTier: current.defaults?.serviceTier ?? "",
        };
        for (const { field, value } of rollbacks) defaults[field] = value;
        return { ...current, defaults };
      });
      toast.error(
        t("models.settings.defaultsFailed", { msg: e instanceof Error ? e.message : String(e) }),
      );
    }
  };

  // ---- 辅助模型 ----

  const taskLabel = useCallback(
    (task: string) => t(`models.settings.tasks.${task}.label`, { defaultValue: task }),
    [t],
  );
  const taskHint = useCallback(
    (task: string) => t(`models.settings.tasks.${task}.hint`, { defaultValue: "" }),
    [t],
  );

  // 持久陈旧检测（官方 persistentStaleAux 同款）：钉在非主 provider 上的槽。
  const persistentStaleAux = useMemo<StaleAuxSlot[]>(() => {
    const mainProvider = (main.provider || "").toLowerCase();
    if (!mainProvider) return [];
    return aux.slots
      .filter((s) => {
        const p = (s.provider || "").toLowerCase();
        return p && p !== "auto" && p !== mainProvider;
      })
      .map((s) => ({ task: s.task, provider: s.provider, model: s.model }));
  }, [aux.slots, main.provider]);

  const writeAux = async (task: string, provider: string, model: string, okMsg: string) => {
    if (auxBusy) return;
    const actionEpoch = epoch.current;
    // 尤为关键：writeAux 开头就 `if (auxBusy) return`，标志卡住等于整张辅助模型卡永久锁死。
    const actionProfileEpoch = profileEpoch.current;
    setAuxBusy(true);
    try {
      await setAuxiliaryModel(backend, task, provider, model, profile);
      if (actionEpoch !== epoch.current) return;
      toast.success(okMsg);
      setEditingAuxTask(null);
      if (task === "__reset__") setSwitchStaleAux([]);
      await load(profile);
    } catch (e) {
      if (actionProfileEpoch === profileEpoch.current) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (actionProfileEpoch === profileEpoch.current) setAuxBusy(false);
    }
  };

  const beginAuxEdit = (task: string) => {
    const current = aux.slots.find((s) => s.task === task);
    const initialProvider =
      current?.provider && current.provider !== "auto" ? current.provider : main.provider || "";
    setAuxDraft({ provider: initialProvider, model: current?.model || main.model || "" });
    setEditingAuxTask(task);
  };

  const staleSlots = switchStaleAux.length > 0 ? switchStaleAux : persistentStaleAux;
  const staleProvider =
    staleSlots.length > 0 && staleSlots.every((s) => s.provider === staleSlots[0].provider)
      ? staleSlots[0].provider
      : t("models.settings.staleAuxOthers");

  // ---- MoA ----

  const moaRef = useRef<MoaConfig | null>(null);
  useEffect(() => {
    moaRef.current = moa;
  }, [moa]);
  const moaSaveTimer = useRef<number | null>(null);
  const moaSaveGeneration = useRef(0);
  useEffect(
    () => () => {
      if (moaSaveTimer.current) window.clearTimeout(moaSaveTimer.current);
    },
    [],
  );

  const currentMoaPreset: MoaPreset | null = useMemo(() => {
    if (!moa) return null;
    return (
      moa.presets[selectedMoaPreset] || moa.presets[moa.defaultPreset] || Object.values(moa.presets)[0] || null
    );
  }, [moa, selectedMoaPreset]);

  // moa 虚拟 provider 不能进槽位选项（递归树，服务端拒绝；官方同款隐藏）。
  const moaSlotProviders = useMemo(
    () => providers.filter((p) => (p.slug || "").toLowerCase() !== "moa"),
    [providers],
  );

  // 防抖自动保存（官方 scheduleMoaSave 同款）：半填挂起不写；generation 防陈旧回写——
  // 换 profile 的 effect 会顶掉它，旧 profile 的存盘结果因此不会回填到新面板。
  const scheduleMoaSave = useCallback(
    (next: MoaConfig) => {
      if (moaSaveTimer.current) {
        window.clearTimeout(moaSaveTimer.current);
        moaSaveTimer.current = null;
      }
      const generation = ++moaSaveGeneration.current;
      if (!moaConfigComplete(next)) return;
      moaSaveTimer.current = window.setTimeout(() => {
        saveMoaConfig(backend, profile, next)
          .then((saved) => {
            if (moaSaveGeneration.current === generation) setMoa(saved);
          })
          .catch((e) => {
            if (moaSaveGeneration.current === generation) {
              toast.error(
                t("models.settings.moaSaveFailed", { msg: e instanceof Error ? e.message : String(e) }),
              );
            }
          });
      }, 600);
    },
    [backend, profile, t, toast],
  );

  // 显式预设操作（设默认/增删）立即保存并作废在途防抖（官方 saveMoa 同款）。
  const saveMoaNow = async (next: MoaConfig) => {
    if (moaSaveTimer.current) {
      window.clearTimeout(moaSaveTimer.current);
      moaSaveTimer.current = null;
    }
    moaSaveGeneration.current += 1;
    const actionEpoch = epoch.current;
    setMoaBusy(true);
    try {
      const saved = await saveMoaConfig(backend, profile, next);
      if (actionEpoch === epoch.current) setMoa(saved);
    } catch (e) {
      if (actionEpoch === epoch.current) {
        toast.error(
          t("models.settings.moaSaveFailed", { msg: e instanceof Error ? e.message : String(e) }),
        );
      }
    } finally {
      if (actionEpoch === epoch.current) setMoaBusy(false);
    }
  };

  const updateMoaPreset = (updater: (preset: MoaPreset) => MoaPreset) => {
    const prev = moaRef.current;
    if (!prev || !selectedMoaPreset || !prev.presets[selectedMoaPreset]) return;
    const next: MoaConfig = {
      ...prev,
      presets: { ...prev.presets, [selectedMoaPreset]: updater(prev.presets[selectedMoaPreset]) },
    };
    moaRef.current = next;
    setMoa(next);
    scheduleMoaSave(next);
  };

  // 换 provider 清空 model（模型按 provider 走；官方 updateMoaSlot 同款）。
  const patchMoaSlot = (slot: MoaSlot, patch: Partial<MoaSlot>): MoaSlot => {
    const next = { ...slot, ...patch };
    if (patch.provider && patch.provider !== slot.provider) next.model = "";
    return next;
  };

  const moaIncomplete = !!moa && !moaConfigComplete(moa);

  // ---- 后备模型链 ----

  const fallbackTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    },
    [],
  );

  const commitFallbacks = (rows: AuxDraft[]) => {
    setFallbackRows(rows);
    const complete = rows.filter((r) => r.provider && r.model);
    const serialized = JSON.stringify(complete);
    if (serialized === fallbackSavedRef.current) return;
    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    // echo 基准与报错都属于当前 profile：换 profile 后旧写的结果不得落到新面板。
    const actionProfileEpoch = profileEpoch.current;
    fallbackTimer.current = window.setTimeout(() => {
      setFallbackModels(backend, profile, complete)
        .then(() => {
          if (actionProfileEpoch === profileEpoch.current) fallbackSavedRef.current = serialized;
        })
        .catch((e) => {
          if (actionProfileEpoch !== profileEpoch.current) return;
          toast.error(
            t("models.settings.fallbackSaveFailed", { msg: e instanceof Error ? e.message : String(e) }),
          );
        });
    }, 600);
  };

  return {
    // 形态与生命周期
    supported,
    loading,
    error,
    settled,
    reload: () => void load(profile),
    // 快照派生
    snapshot,
    profile,
    profiles,
    providers,
    main,
    aux,
    modelsForProvider,
    // 主模型
    selectedProvider,
    setSelectedProvider: selectMainProvider,
    selectedModel,
    setSelectedModel,
    mainSelectionValid,
    mainProviderOptions,
    selectedProviderRow,
    needsSetup,
    setupIsApiKey,
    setupIsCustom,
    applying,
    doApplyMain,
    apiKeyDraft,
    setApiKeyDraft,
    activating,
    doActivateApiKey,
    startProviderSetup,
    oauthSetup,
    setOauthSetup,
    // 默认参数
    reasoningSupported,
    fastSupported,
    effortValue,
    fastOn,
    writeDefault,
    // 辅助模型
    taskLabel,
    taskHint,
    editingAuxTask,
    setEditingAuxTask,
    auxDraft,
    setAuxDraft,
    auxBusy,
    writeAux,
    beginAuxEdit,
    staleSlots,
    staleProvider,
    // MoA
    moa,
    selectedMoaPreset,
    setSelectedMoaPreset,
    newMoaPresetName,
    setNewMoaPresetName,
    moaBusy,
    currentMoaPreset,
    moaSlotProviders,
    moaIncomplete,
    saveMoaNow,
    updateMoaPreset,
    patchMoaSlot,
    // 后备链
    fallbackRows,
    commitFallbacks,
  };
}

export type AgentModelSettingsState = ReturnType<typeof useAgentModelSettings>;
