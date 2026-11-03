import AgentAvatarView from "../components/AgentAvatar";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../components/PageHead";
import type { NativeSkillPage, UnifiedSkill } from "../types";
import {
  ApiError,
  getSkillUsage,
  listSkills,
  listSkillsPage,
  previewSkill,
  selfImprovement,
  uninstallSkill,
  updateSkill,
} from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import BackendTabs from "../components/BackendTabs";
import Modal from "../components/Modal";
import ChatMarkdown from "../components/ChatMarkdown";
import { useBackendCatalog, useBackendState } from "../lib/backends";
import { Field, Switch, TextArea, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { markdownCodeBlock, splitSkillDocument } from "../lib/skillDocument";
import { skillIdentity } from "../lib/skillIdentity";
import styles from "./SkillsPage.module.css";
const SelfImprovementPanel = lazy(() => import("./SelfImprovementPanel"));

const EMPTY_USAGE = {
  usage: new Map<string, number>(),
  usageByAgent: new Map<string, Map<string, number>>(),
  usageSupported: false,
  scanLimit: undefined as number | undefined,
};
const SKILLS_PER_BATCH = 100;

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
  const [page, setPage] = useState(0);
  const [nativeReload, setNativeReload] = useState(0);
  const [nativeRetry, setNativeRetry] = useState(0);
  const nativeRevision = useRef<string | null>(null);
  const [nativePageState, setNativePageState] = useState<{
    key: string; page: NativeSkillPage; skills: UnifiedSkill[];
  } | null>(null);
  const [nativeErrorState, setNativeErrorState] = useState<{ key: string; error: string } | null>(null);
  const skillMainRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const detailOpenerRef = useRef<HTMLButtonElement | null>(null);
  const detailSnapshot = useRef<UnifiedSkill | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 详情按完整安装身份定位，避免混淆同名版本或不同 Agent 的技能。
  const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);
  const [learnedBusy, setLearnedBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [envText, setEnvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ key: string; content: string; error?: string } | null>(null);
  const previewRequestId = useRef(0);
  const [packageBusy, setPackageBusy] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();

  useEffect(() => {
    if (!isNativeSkills || typeof window === "undefined") return;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ backendId?: string; agentId?: string }>).detail;
      if (detail?.backendId !== backend) return;
      setSelectedIdentity(null);
      nativeRevision.current = null;
      setPage(0);
      setNativeReload(value => value + 1);
    };
    window.addEventListener("shoggoth:skills-changed", changed);
    return () => window.removeEventListener("shoggoth:skills-changed", changed);
  }, [backend, isNativeSkills]);

  const { data: skillsData, loading: externalLoading, error: externalError,
    refresh: refreshExternal } = usePageCache(
    `skills:${backend}:default`,
    () => isNativeSkills ? Promise.resolve([]) : listSkills(backend),
  );
  const nativeKey = JSON.stringify([backend, nativeReload]);
  const nativeRequestKey = JSON.stringify([nativeKey, page, nativeRetry]);
  useEffect(() => {
    if (!isNativeSkills) return;
    let current = true;
    setNativeErrorState(null);
    void listSkillsPage(backend, undefined, { query: "", status: "", pageIndex: page,
      limit: SKILLS_PER_BATCH, expectedRevision: page === 0 ? null : nativeRevision.current })
      .then((value) => {
        if (!current) return;
        nativeRevision.current = value.queryRevision;
        setNativePageState(previous => {
          const accumulated = page > 0 && previous?.key === nativeKey ? previous.skills : [];
          const merged = new Map(accumulated.map(skill => [skillIdentity(skill), skill]));
          for (const skill of value.skills) merged.set(skillIdentity(skill), skill);
          return { key: nativeKey, page: value, skills: [...merged.values()] };
        });
      })
      .catch((error) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 409 && page > 0) {
          nativeRevision.current = null;
          setSelectedIdentity(null);
          setPage(0);
          setNativeReload(value => value + 1);
          return;
        }
        setNativeErrorState({ key: nativeRequestKey,
          error: error instanceof Error ? error.message : String(error) });
      });
    return () => { current = false; };
  }, [backend, isNativeSkills, nativeKey, nativeRequestKey, page]);
  const nativeSnapshot = nativePageState?.key === nativeKey ? nativePageState : null;
  const nativePage = nativeSnapshot?.page;
  const skills = isNativeSkills ? nativeSnapshot?.skills ?? [] : skillsData ?? [];
  const nativeError = nativeErrorState?.key === nativeRequestKey ? nativeErrorState.error : null;
  const loading = isNativeSkills ? nativePage?.pageIndex !== page && !nativeError : externalLoading;
  const error = isNativeSkills ? nativeError : externalError;
  const refresh = async () => {
    if (isNativeSkills) {
      nativeRevision.current = null;
      setPage(0);
      setNativeReload(value => value + 1);
    } else await refreshExternal();
  };

  // 「哪个 agent 加载过哪个 skill」叠加层。一次拉全后端（形状同 CLI 页的
  // cli:usage），切 tab 不必重拉；失败静默——叠加层可有可无，不该把页面拖进错误态。
  const { data: usageData, refresh: refreshUsage } = usePageCache(
    `skills:usage:${isNativeSkills ? "native" : "external"}`,
    () => isNativeSkills ? Promise.resolve([]) : getSkillUsage());
  const usageLoaded = isNativeSkills || usageData != null;
  // 导航栏刷新要连「agent 使用次数」叠加层一起重拉——本页默认按使用次数排序，
  // 只刷 skills:${backend} 会让整页看起来毫无反应（R371）。
  useRegisterPageRefresh("/skills", () => Promise.all([refresh(), refreshUsage()]));
  useRegisterPageLoading("/skills", loading);
  const { usage, usageByAgent, usageSupported, scanLimit } = useMemo(() => {
    if (isNativeSkills) {
      const counts = new Map<string, number>();
      const byAgent = new Map<string, Map<string, number>>();
      for (const skill of skills) {
        counts.set(skillIdentity(skill), skill.usageCount ?? 0);
        byAgent.set(skillIdentity(skill), new Map(Object.entries(skill.usageAgents ?? {})));
      }
      return { usage: counts, usageByAgent: byAgent,
        usageSupported: nativePage?.usageSupported ?? false, scanLimit: undefined };
    }
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
  }, [usageData, backend, isNativeSkills, nativePage, skills]);

  const totalCount = isNativeSkills ? nativePage?.total ?? 0 : skills.length;
  const enabledCount = isNativeSkills ? nativePage?.enabledCount ?? 0
    : skills.filter((s) => s.enabled).length;
  const usedCount = useMemo(
    () => isNativeSkills ? nativePage?.usedCount ?? 0
      : skills.reduce((n, s) => ((usage.get(s.name) || 0) > 0 ? n + 1 : n), 0),
    [isNativeSkills, nativePage, skills, usage],
  );

  // 扁平一张网格（不再按分类分组）：先按 agent 使用次数倒序，同次数再按名字。
  // usage 到位前全是 0，等价于字母序——叠加层到达后自动重排。
  const shown = useMemo(() => {
    if (isNativeSkills) return skills;
    return [...skills].sort((a, b) => {
      const d = (usage.get(b.name) || 0) - (usage.get(a.name) || 0);
      if (d) return d;
      return a.name.localeCompare(b.name);
    });
  }, [skills, usage, isNativeSkills]);
  const visibleSkills = isNativeSkills ? shown : shown.slice(0, (page + 1) * SKILLS_PER_BATCH);
  const hasMore = isNativeSkills
    ? Boolean(nativePage && nativePage.pageIndex + 1 < nativePage.pageCount)
    : visibleSkills.length < shown.length;
  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore || loading || error || typeof IntersectionObserver === "undefined") return;
    let requested = false;
    // The viewport observer also respects both scroll containers: the grid on
    // desktop and the whole page in narrow windows.
    const observer = new IntersectionObserver(entries => {
      if (requested || !entries.some(entry => entry.isIntersecting)) return;
      requested = true;
      observer.disconnect();
      setPage(value => value + 1);
    }, { rootMargin: "200px 0px" });
    observer.observe(target);
    return () => { requested = true; observer.disconnect(); };
  }, [hasMore, loading, error, visibleSkills.length, backend]);

  const selected = useMemo(() => {
    if (!selectedIdentity) return null;
    return skills.find((skill) => skillIdentity(skill) === selectedIdentity)
      // 刷新期间保留当前详情；收到新快照后，已移除的技能仍会关闭弹窗。
      || (loading && detailSnapshot.current && skillIdentity(detailSnapshot.current) === selectedIdentity
        ? detailSnapshot.current : null);
  }, [skills, selectedIdentity, loading]);
  useEffect(() => { detailSnapshot.current = selected; }, [selected]);
  const learnedSelection = useMemo(() => selected?.source === "learned" && selected.id && selected.contentHash
    ? { id: selected.id, versionHash: selected.contentHash } : null, [selected]);
  const previewKey = isNativeSkills && selected && selected.source !== "learned"
    ? skillIdentity(selected) : null;
  const skillDocument = useMemo(() => splitSkillDocument(preview?.key === previewKey ? preview.content : ""), [preview, previewKey]);

  useEffect(() => {
    const requestId = ++previewRequestId.current;
    setPreview(null);
    if (!previewKey || !selected) return;

    void previewSkill(backend, selected, selected.agentId)
      .then((value) => {
        if (previewRequestId.current === requestId) {
          setPreview({ key: previewKey, content: value.content });
        }
      })
      .catch((error) => {
        if (previewRequestId.current === requestId) {
          const message = error instanceof Error ? error.message : String(error);
          setPreview({ key: previewKey, content: "", error: message });
          toast.error(message);
        }
      });

    return () => {
      if (previewRequestId.current === requestId) previewRequestId.current += 1;
    };
  }, [backend, previewKey, selected, toast]);

  const toggle = async (s: UnifiedSkill, enabled: boolean) => {
    setBusy(skillIdentity(s));
    try {
      if (s.source === "learned") {
        if (!s.agentId) throw new Error(t("skills.errorPrefix", { msg: "Agent unavailable" }));
        await selfImprovement(backend, s.agentId, "change", { skillId: s.id,
          expectedRevision: s.learnedRevision, action: enabled ? "restore" : "archive" });
        window.dispatchEvent(new CustomEvent("shoggoth:skills-changed", {
          detail: { backendId: backend, agentId: s.agentId },
        }));
      } else await updateSkill(backend, s.name, {
        enabled,
        id: s.id,
        source: s.source,
        version: s.version,
        expectedRevision: isNativeSkills && s.source === "user"
          ? s.registryVersion : s.profileRevision,
      }, s.agentId);
      toast.success(
        enabled
          ? t("skills.enabledToast", { name: s.title || s.name })
          : t("skills.disabledToast", { name: s.title || s.name }),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDetail = (s: UnifiedSkill, opener?: HTMLButtonElement) => {
    detailOpenerRef.current = opener ?? null;
    setSelectedIdentity(skillIdentity(s));
    setApiKey("");
    setEnvText("");
  };
  const closeDetail = () => {
    setSelectedIdentity(null);
  };
  const finishDetailClose = (open: boolean) => {
    if (open) return;
    const opener = detailOpenerRef.current;
    detailOpenerRef.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
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
      let uninstallRevision = selected.registryVersion;
      if (selected.enabled) {
        const disabled = await updateSkill(backend, selected.name, {
          enabled: false,
          id: selected.id,
          source: selected.source,
          version: selected.version,
          expectedRevision: selected.registryVersion,
        }, selected.agentId);
        uninstallRevision = disabled.registryVersion;
      }
      await uninstallSkill(backend, { ...selected, registryVersion: uninstallRevision }, selected.agentId);
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
        ? t("skills.statLineUsage", { total: totalCount, enabled: enabledCount, used: usedCount })
        : t("skills.statLine", {
            total: totalCount,
            enabled: enabledCount,
            disabled: totalCount - enabledCount,
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
      <PageHead
        title={t("skills.pageTitle")}
        subtitle={subtitle}
      />
      <div className="ui-toolbar">
        <BackendTabs value={backend} onChange={(value) => {
          setBackend(value); setPage(0); setSelectedIdentity(null); }} surface="skills" />
      </div>

      {error && <div className="error">{t("skills.errorPrefix", { msg: error })}
        {isNativeSkills && <button className="btn-secondary" onClick={() => setNativeRetry(value => value + 1)}>
          {t("skills.retryLoad")}
        </button>}
      </div>}
      {!loading && !error && totalCount === 0 && (
        <p className="muted">{t("skills.empty")}</p>
      )}

      {/* 详情独立弹出，卡片网格保持原来的列数和滚动位置。 */}
      <div className="skill-body">
        <div className="skill-main-content" ref={skillMainRef}>
          {visibleSkills.length > 0 && (
            <div className="skill-grid">
              {visibleSkills.map((s) => {
                const identity = skillIdentity(s);
                return (
                  <article
                    key={identity}
                    className={`skill-card${s.enabled ? "" : " skill-off"}`}
                    title={s.title || s.name}
                  >
                    <button
                      type="button"
                      className="skill-card-open"
                      aria-label={s.version ? `${s.title || s.name} v${s.version} · ${s.source}` : s.name}
                      onClick={(event) => openDetail(s, event?.currentTarget)}
                    />
                    <div className="skill-card-top">
                      <span className="skill-name">{s.title || s.name}</span>
                    </div>
                    {/* 开关放介绍右下角，名称独占标题行。 */}
                    <div className="skill-card-foot">
                      <div className="skill-desc">{s.description || ""}</div>
                      <span className="skill-card-switch">
                        <Switch
                          checked={s.enabled}
                          disabled={busy === identity}
                          ariaLabel={`${t("skills.enabledLabel")}: ${s.title || s.name}${s.version ? ` v${s.version}` : ""}`}
                          onChange={(v) => toggle(s, v)}
                        />
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {(hasMore || loading) && (
            <div className="skill-load-more" ref={loadMoreRef} role="status" aria-live="polite">
              {loading ? t("common.loading") : t("skills.scrollToLoad")}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={Boolean(selected)}
        title={selected?.title || selected?.name}
        onClose={closeDetail}
        onOpenChangeComplete={finishDetailClose}
        dismissible={!saving && !packageBusy && !learnedBusy && busy !== selectedIdentity}
        className={styles.detailModal}
        width={880}
        subtitle={selected?.source === "learned" ? t("skills.learnedSource") : backendName}
      >
        {isNativeSkills && learnedSelection && selected?.agentId && <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
          <SelfImprovementPanel key={`${backend}:${selected.agentId}`} backend={backend} agentId={selected.agentId}
            detailOnly skillSelection={learnedSelection} onSelectionClosed={closeDetail}
            onBusyChange={setLearnedBusy} onSkillsChanged={() => void refresh()} />
        </Suspense>}

        {selected && selected.source !== "learned" && (
          <div className={`${styles.detail} skill-detail`}>
            <div className={styles.detailSummary}>
              <span className={styles.skillState} data-active={selected.enabled}>
                {selected.enabled ? t("skills.filterOn") : t("skills.filterOff")}
              </span>
              <Switch
                checked={selected.enabled}
                disabled={busy === skillIdentity(selected)}
                ariaLabel={`${t("skills.enabledLabel")}: ${selected.name}${selected.version ? ` v${selected.version}` : ""}`}
                onChange={(v) => toggle(selected, v)}
              />
            </div>

            <details className={styles.inspector}>
              <summary>{t("skills.detailsSection")}</summary>
              <div className={styles.inspectorBody}>
                <span className="skill-detail-meta">
                  {backendName}
                  {isNativeSkills && selected.source !== "user" && selected.agentName !== backendName ? ` · ${selected.agentName || selected.agentId}` : ""}
                  {selected.version ? ` · v${selected.version}` : ""}
                  {isNativeSkills && selected.globalEnabled ? ` · ${t("skills.globalScope")}` : ""}
                  {selected.category ? ` · ${selected.category}` : ""}
                </span>
                {isNativeSkills && selected.description && skillDocument.body && (
                  <section className="skill-sec">
                    <h4>{t("skills.descriptionSection")}</h4>
                    <ChatMarkdown className="chat-md markdown-document" text={selected.description} />
                  </section>
                )}
                {!usageLoaded ? (
                  <section className="skill-sec">
                    <div className="skill-sec-head"><h4>{t("skills.usageHeading")}</h4></div>
                    <p className="skill-sec-desc">{t("common.loading")}</p>
                  </section>
                ) : usageSupported ? (() => {
                  const agents = usageByAgent.get(isNativeSkills ? skillIdentity(selected) : selected.name);
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
                  </section>
                )}
                {skillDocument.frontmatter && <details>
                  <summary>{t("skills.documentMetadata")}</summary>
                  <ChatMarkdown className="chat-md markdown-document" text={markdownCodeBlock(skillDocument.frontmatter, "yaml")} />
                </details>}
                {skillDocument.installation && <details>
                  <summary>{t("skills.installationInfo")}</summary>
                  <ChatMarkdown className="chat-md markdown-document" text={skillDocument.installation} />
                </details>}
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
              </div>
            </details>

            <section aria-label={t("skills.instructionsSection")}>
              {isNativeSkills && preview?.key !== previewKey ? <p className="skill-sec-desc" role="status">{t("common.loading")}</p>
                : preview?.key === previewKey && preview.error ? <p className="skill-sec-desc" role="alert">{preview.error}</p>
                : <ChatMarkdown className="chat-md markdown-document" text={skillDocument.body || selected.description || ""} />}
            </section>

            {isNativeSkills && selected.source === "user" && (
              <footer className={styles.detailActions}>
                <button className="btn-danger" onClick={uninstallNative} disabled={packageBusy}>
                  {t("skills.uninstall")}
                </button>
              </footer>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
