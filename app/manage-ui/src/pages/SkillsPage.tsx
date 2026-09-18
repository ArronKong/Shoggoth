import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import type { UnifiedSkill } from "../types";
import {
  getSkillUsage,
  installSkill,
  listAgents,
  listSkills,
  previewSkill,
  uninstallSkill,
  updateSkill,
} from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import BackendTabs from "../components/BackendTabs";
import FilterTabs from "../components/FilterTabs";
import SearchCapsule from "../components/SearchCapsule";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import { useStickyState } from "../lib/useStickyState";
import { Field, Option, Select, Switch, TextArea, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { toSanitizedMarkdownHtml } from "../lib/markdown";
import { skillIdentity } from "../lib/skillIdentity";

const EMPTY_USAGE = {
  usage: new Map<string, number>(),
  usageByAgent: new Map<string, Map<string, number>>(),
  usageSupported: false,
  scanLimit: undefined as number | undefined,
};

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export default function SkillsPage() {
  const [backend, setBackend] = useBackendState("skills", undefined, { surface: "skills" });
  const backendCatalog = useBackendCatalog("skills");
  const activeBackendDescriptor = backendCatalog.find((descriptor) => descriptor.id === backend);
  const isNativeSkills = activeBackendDescriptor?.surfaces.agentHarness === true;
  const backendName = activeBackendDescriptor?.name || backend;
  // 「只看启用」的原生 checkbox 换成三态筛选胶囊（全部/已启用/已停用）。
  const [status, setStatus] = useStickyState<"" | "on" | "off">("skills.status", "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // 保存完整安装身份，刷新后重新解析当前快照；同名版本与不同 Agent 不共享选中态。
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [envText, setEnvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [preview, setPreview] = useState<{ key: string; content: string } | null>(null);
  const previewRequestId = useRef(0);
  const [packageBusy, setPackageBusy] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();

  const { data: nativeAgentsData, refresh: refreshAgents } = usePageCache(
    `skills:agents:${backend}`,
    () => isNativeSkills ? listAgents(backend) : Promise.resolve([]),
  );
  const nativeAgents = nativeAgentsData ?? [];
  const activeAgent = isNativeSkills
    ? (nativeAgents.some((agent) => agent.id === selectedAgent) ? selectedAgent : nativeAgents[0]?.id)
    : undefined;
  useEffect(() => {
    if (isNativeSkills && activeAgent && activeAgent !== selectedAgent) setSelectedAgent(activeAgent);
  }, [activeAgent, isNativeSkills, selectedAgent]);

  const { data: skillsData, loading, error, refresh } = usePageCache(
    `skills:${backend}:${activeAgent || "default"}`,
    () => isNativeSkills && !activeAgent ? Promise.resolve([]) : listSkills(backend, activeAgent),
  );
  const skills = skillsData ?? [];

  // 「哪个 agent 加载过哪个 skill」叠加层。一次拉全后端（形状同 CLI 页的
  // cli:usage），切 tab 不必重拉；失败静默——叠加层可有可无，不该把页面拖进错误态。
  const { data: usageData, refresh: refreshUsage } = usePageCache("skills:usage", () => getSkillUsage());
  const usageLoaded = usageData != null;
  // 导航栏刷新要连「agent 使用次数」叠加层一起重拉——本页默认按使用次数排序，
  // 只刷 skills:${backend} 会让整页看起来毫无反应（R371）。
  useRegisterPageRefresh("/skills", () => Promise.all([refresh(), refreshUsage(), refreshAgents()]));
  useRegisterPageLoading("/skills", loading);
  const { usage, usageByAgent, usageSupported, scanLimit } = useMemo(() => {
    const row = (usageData ?? []).find((b) => b.backend === backend);
    if (!row || !row.supported) return EMPTY_USAGE;
    const total = new Map<string, number>();
    const byAgent = new Map<string, Map<string, number>>();
    for (const [name, agents] of Object.entries(row.skills || {})) {
      const agentMap = new Map<string, number>();
      let n = 0;
      for (const [agentId, count] of Object.entries(agents || {})) {
        agentMap.set(agentId, count);
        n += count;
      }
      total.set(name, n);
      byAgent.set(name, agentMap);
    }
    return { usage: total, usageByAgent: byAgent, usageSupported: true, scanLimit: row.scanLimit };
  }, [usageData, backend]);

  const enabledCount = useMemo(() => skills.filter((s) => s.enabled).length, [skills]);
  const usedCount = useMemo(
    () => skills.reduce((n, s) => ((usage.get(s.name) || 0) > 0 ? n + 1 : n), 0),
    [skills, usage],
  );

  // 扁平一张网格（不再按分类分组）：先按 agent 使用次数倒序，同次数再按名字。
  // usage 到位前全是 0，等价于字母序——叠加层到达后自动重排。
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const res = skills.filter((s) => {
      if (status === "on" && !s.enabled) return false;
      if (status === "off" && s.enabled) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.category || "").toLowerCase().includes(q)
      );
    });
    return res.sort((a, b) => {
      const d = (usage.get(b.name) || 0) - (usage.get(a.name) || 0);
      if (d) return d;
      return a.name.localeCompare(b.name);
    });
  }, [skills, status, query, usage]);

  const selected = useMemo(
    () => (selectedIdentity ? skills.find((s) => skillIdentity(s) === selectedIdentity) || null : null),
    [skills, selectedIdentity],
  );
  const previewKey = isNativeSkills && activeAgent && selected
    ? JSON.stringify([
        backend,
        activeAgent || "",
        selected.id || "",
        selected.name,
        selected.source || "user",
        selected.version || "",
      ])
    : null;

  useEffect(() => {
    const requestId = ++previewRequestId.current;
    setPreview(null);
    if (!previewKey || !selected) return;

    void previewSkill(backend, selected, activeAgent)
      .then((value) => {
        if (previewRequestId.current === requestId) {
          setPreview({ key: previewKey, content: value.content });
        }
      })
      .catch((error) => {
        if (previewRequestId.current === requestId) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      if (previewRequestId.current === requestId) previewRequestId.current += 1;
    };
  }, [activeAgent, backend, previewKey, selected, toast]);

  const toggle = async (s: UnifiedSkill, enabled: boolean) => {
    setBusy(skillIdentity(s));
    try {
      await updateSkill(backend, s.name, {
        enabled,
        id: s.id,
        source: s.source,
        version: s.version,
        expectedRevision: s.profileRevision,
      }, activeAgent);
      toast.success(
        enabled
          ? t("skills.enabledToast", { name: s.name })
          : t("skills.disabledToast", { name: s.name }),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDetail = (s: UnifiedSkill) => {
    setSelectedIdentity(skillIdentity(s));
    setApiKey("");
    setEnvText("");
  };

  const installNative = async () => {
    setPackageBusy(true);
    try {
      const result = await installSkill(backend, activeAgent);
      if (!result.canceled) {
        toast.success(t("skills.installedToast"));
        await refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setPackageBusy(false); }
  };

  const uninstallNative = async () => {
    if (!selected || selected.source !== "user") return;
    const accepted = await confirm({
      title: t("skills.uninstallTitle"),
      message: t("skills.uninstallMessage", { name: `${selected.name} v${selected.version}` }),
      confirmLabel: t("skills.uninstall"),
      danger: true,
    });
    if (!accepted) return;
    setPackageBusy(true);
    try {
      if (selected.enabled) {
        await updateSkill(backend, selected.name, {
          enabled: false,
          id: selected.id,
          source: selected.source,
          version: selected.version,
          expectedRevision: selected.profileRevision,
        }, activeAgent);
      }
      await uninstallSkill(backend, selected, activeAgent);
      setSelectedIdentity(null);
      toast.success(t("skills.uninstalledToast", { name: selected.name }));
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setPackageBusy(false); }
  };

  const subtitle =
    loading && skills.length === 0
      ? t("common.loading")
      : usageSupported
        ? t("skills.statLineUsage", { total: skills.length, enabled: enabledCount, used: usedCount })
        : t("skills.statLine", {
            total: skills.length,
            enabled: enabledCount,
            disabled: skills.length - enabledCount,
          });

  const saveConfig = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const patch: { apiKey?: string; env?: Record<string, string> } = {};
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      const env = parseEnv(envText);
      if (Object.keys(env).length) patch.env = env;
      if (!patch.apiKey && !patch.env) {
        toast.info(t("skills.nothingToSave"));
      } else {
        await updateSkill(backend, selected.name, patch);
        toast.success(t("skills.configSaved"));
        setApiKey("");
        setEnvText("");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page management-page skills-page">
      {/* 统计进副标题、搜索进页头右槽——与 CLI/Cron 页同一份页头结构（规范 §2）。 */}
      <PageHead
        title={t("skills.pageTitle")}
        subtitle={subtitle}
        actions={
          <SearchCapsule
            value={query}
            onChange={setQuery}
            placeholder={t("skills.searchPlaceholder")}
          />
        }
      />
      <div className="ui-toolbar">
        <BackendTabs value={backend} onChange={setBackend} surface="skills" />
        {isNativeSkills && nativeAgents.length > 0 && (
          <Select value={activeAgent || ""} onChange={setSelectedAgent}>
            {nativeAgents.map((agent) => <Option key={agent.id} value={agent.id}>{agent.name}</Option>)}
          </Select>
        )}
        {isNativeSkills && (
          <button className="btn-primary" onClick={installNative} disabled={packageBusy || !activeAgent}>
            {packageBusy ? t("common.loading") : t("skills.install")}
          </button>
        )}
        <FilterTabs
          value={status}
          onChange={(v) => setStatus(v as "" | "on" | "off")}
          ariaLabel={t("skills.filterAria")}
          items={[
            { value: "", label: t("skills.filterAll") },
            { value: "on", label: t("skills.filterOn") },
            { value: "off", label: t("skills.filterOff") },
          ]}
        />
      </div>

      {error && <div className="error">{t("skills.errorPrefix", { msg: error })}</div>}
      {!loading && !error && skills.length === 0 && (
        <p className="muted">{t("skills.empty")}</p>
      )}
      {!loading && !error && skills.length > 0 && shown.length === 0 && (
        <div className="ui-empty">{t("skills.noMatch")}</div>
      )}

      {/* 主区 + 右侧详情，结构同 CLI 页的 .cli-body 双栏；列数交给 auto-fill，
          详情展开吃掉 401px 后网格自己减列（与 CLI 同一套规则，别加 split 类）。 */}
      <div className="skill-body">
        <div className="skill-main-content">
          {!loading && shown.length > 0 && (
            <div className="skill-grid">
              {shown.map((s) => {
                const used = usage.get(s.name) || 0;
                const identity = skillIdentity(s);
                const isSel = selectedIdentity === identity;
                return (
                  <article
                    key={identity}
                    className={`skill-card${isSel ? " skill-card-selected" : ""}${s.enabled ? "" : " skill-off"}`}
                    title={s.name}
                  >
                    <button
                      type="button"
                      className="skill-card-open"
                      aria-label={s.version ? `${s.name} v${s.version} · ${s.source}` : s.name}
                      onClick={() => openDetail(s)}
                    />
                    <div className="skill-card-top">
                      <span className="skill-emoji" aria-hidden="true">
                        {s.emoji || "🧩"}
                      </span>
                      <span className="skill-name">{s.name}</span>
                      {s.version && <span className="skill-badge">v{s.version}</span>}
                      {usageSupported &&
                        (used > 0 ? (
                          <span className="skill-badge skill-badge-used">
                            {t("skills.usedTimes", { count: used })}
                          </span>
                        ) : (
                          <span className="skill-badge skill-badge-never">{t("skills.neverUsed")}</span>
                        ))}
                    </div>
                    {/* 开关放第二行右下角：跟徽章挤在标题行会把技能名压到 ~110px 全是省略号。 */}
                    <div className="skill-card-foot">
                      <div className="skill-desc">{s.description || ""}</div>
                      <span className="skill-card-switch">
                        <Switch
                          checked={s.enabled}
                          disabled={busy === identity}
                          ariaLabel={`${t("skills.enabledLabel")}: ${s.name}${s.version ? ` v${s.version}` : ""}`}
                          onChange={(v) => toggle(s, v)}
                        />
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {selected && (
          <aside className="skill-detail">
            <div className="skill-detail-head">
              <button
                className="skill-detail-x"
                onClick={() => setSelectedIdentity(null)}
                aria-label={t("common.close")}
              >
                ✕
              </button>
              <h3 className="skill-detail-name">
                <span className="skill-detail-emoji" aria-hidden="true">{selected.emoji || "🧩"}</span>
                {selected.name}
              </h3>
              <div className="skill-detail-meta">
                {backendName}
                {selected.version ? ` · v${selected.version}` : ""}
                {selected.source ? ` · ${selected.source}` : ""}
                {selected.category ? ` · ${selected.category}` : ""}
              </div>
            </div>

            <section className="skill-sec">
              <div className="skill-sec-head">
                <h4>{t("skills.statusSection")}</h4>
                <Switch
                  checked={selected.enabled}
                  disabled={busy === skillIdentity(selected)}
                  ariaLabel={`${t("skills.enabledLabel")}: ${selected.name}${selected.version ? ` v${selected.version}` : ""}`}
                  onChange={(v) => toggle(selected, v)}
                />
              </div>
              <p className="skill-sec-desc">
                {selected.enabled ? t("skills.filterOn") : t("skills.filterOff")}
              </p>
            </section>

            {!usageLoaded ? (
              <section className="skill-sec">
                <div className="skill-sec-head"><h4>{t("skills.usageHeading")}</h4></div>
                <p className="skill-sec-desc">{t("common.loading")}</p>
              </section>
            ) : usageSupported ? (() => {
              const agents = usageByAgent.get(selected.name);
              const rows = agents ? [...agents.entries()].sort((a, b) => b[1] - a[1]) : [];
              const total = rows.reduce((n, [, c]) => n + c, 0);
              const max = rows.length ? rows[0][1] : 0;
              return (
                <section className="skill-sec">
                  <div className="skill-sec-head">
                    <h4>{t("skills.usageHeading")}</h4>
                    {total > 0 && <span className="skill-sec-aside">{t("skills.usageTotal", { count: total })}</span>}
                  </div>
                  {rows.length === 0 ? (
                    <p className="skill-sec-desc">{t("skills.usageNever")}</p>
                  ) : (
                    <ul className="skill-usage-list">
                      {rows.map(([agentId, count]) => (
                        <li key={agentId} className="skill-u-row">
                          <AgentAvatarView agentId={agentId} className="skill-u-avatar" />
                          <span className="skill-u-label" title={agentId}>{agentId} · {count}x</span>
                          <span className="skill-u-bar"><span style={{ width: `${max ? Math.round((count / max) * 100) : 0}%` }} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {scanLimit ? <p className="skill-sec-desc">{t("skills.usageScanNote", { count: scanLimit })}</p> : null}
                </section>
              );
            })() : (
              <section className="skill-sec">
                <div className="skill-sec-head"><h4>{t("skills.usageHeading")}</h4></div>
                <p className="skill-sec-desc">{t("skills.usageUnsupported")}</p>
              </section>
            )}

            {selected.description && (
              <section className="skill-sec">
                <h4>{t("skills.descriptionSection")}</h4>
                <div
                  className="md-body"
                  dangerouslySetInnerHTML={{
                    __html: toSanitizedMarkdownHtml(selected.description),
                  }}
                />
              </section>
            )}

            {isNativeSkills && preview?.key === previewKey && preview.content && (
              <section className="skill-sec">
                <h4>{t("skills.instructionsSection")}</h4>
                <div className="md-body" dangerouslySetInnerHTML={{ __html: toSanitizedMarkdownHtml(preview.content) }} />
              </section>
            )}

            {isNativeSkills && (
              <section className="skill-sec">
                <h4>{t("skills.dependenciesSection")}</h4>
                <p className="skill-sec-desc">
                  {(selected.requiredTools || []).length
                    ? t("skills.requiredTools", { tools: selected.requiredTools?.join(", ") })
                    : t("skills.noRequiredTools")}
                </p>
                <p className="skill-sec-desc">
                  {(selected.requiredRuntimeCapabilities || []).length
                    ? t("skills.requiredRuntime", { capabilities: selected.requiredRuntimeCapabilities?.join(", ") })
                    : t("skills.noRequiredRuntime")}
                </p>
                {selected.source === "user" && (
                  <button className="btn-danger" onClick={uninstallNative} disabled={packageBusy}>
                    {t("skills.uninstall")}
                  </button>
                )}
              </section>
            )}

            {backend === "openclaw" && (
              <section className="skill-sec">
                <h4>{t("skills.configSection")}</h4>
                <Field label={t("skills.apiKey")} hint={t("skills.apiKeyHint")}>
                  <TextInput
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </Field>
                <Field label={t("skills.envLabel")} hint={t("skills.envHint")}>
                  <TextArea
                    className="field-textarea field-mono"
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    rows={4}
                    placeholder={"FOO=bar\nBAZ=qux"}
                  />
                </Field>
                <button className="btn-primary" onClick={saveConfig} disabled={saving}>
                  {saving ? t("common.saving") : t("skills.saveConfig")}
                </button>
              </section>
            )}
            {backend === "hermes" && <p className="muted">{t("skills.hermesNote")}</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
