import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { getNativeMemoryConfig, getNativeMemoryContext, updateNativeMemoryConfig } from "../../api/client";
import type { NativeMemoryConfigProjection, NativeMemoryContext, NativeMemorySettings } from "../../types";
import { Field, Option, Select, Switch, TextArea, TextInput } from "../../components/Field";
import { useNavigationGuard } from "../../lib/navigation-guard";
import { changeMemorySetting, memorySetting, sameMemorySettings, effectiveMemorySearch, memoryEmbeddingProviders, memoryProviderIdPattern,
  parseMemoryRemoteHeaders, formatMemoryRemoteHeaders, validMemorySearchDraft, activeMemoryAgentSelected, changeActiveMemoryAgent, enableAllActiveMemoryAgents } from "../../lib/nativeMemoryForm";
import MemoryProviderAccounts, { type MemoryAccountContext } from "./MemoryProviderAccounts";
import "./SettingsMemory.css";
import NativeMemorySharingSettings from "./NativeMemorySharingSettings";

// Leaving and reopening the page must not read an older revision while the
// previous instance's write is still awaiting its Service acknowledgement.
let pendingWrite: Promise<unknown> = Promise.resolve();
type Setting = { key: string; path?: string[]; kind?: "boolean" | "number" | "text" | "textarea" | "arguments" | "headers";
  options?: string[]; min?: number; max?: number; step?: number | "any"; maxLength?: number; hint?: string; required?: boolean; label?: string; pattern?: string; placeholder?: string };
const boolean = (key: string, path?: string[]): Setting => ({ key, path, kind: "boolean" });
const number = (key: string, min: number, max: number, step: number | "any" = 1): Setting => ({ key, kind: "number", min, max, step });
const text = (key: string, path?: string[], hint?: string): Setting => ({ key, path, kind: "text", hint });
const fraction = (key: string) => number(key, 0, 1, "any");
const count = (key: string) => number(key, 0, 1_000_000);
const searchFields: Setting[] = [boolean("enabled"), boolean("rememberAcrossConversations"),
  { key: "provider", options: memoryEmbeddingProviders },
  { ...text("embeddingModel", ["model"], "embeddingModelHint"), maxLength: 512 },
  { key: "fallback", options: memoryEmbeddingProviders.filter(value => value !== "shoggoth-e5"), hint: "embeddingFallbackHint" },
  { ...number("outputDimensionality", 1, Number.MAX_SAFE_INTEGER), hint: "embeddingDimensionsHint" },
  { key: "sources", options: ["memory", "memory,sessions", "sessions", "empty"], hint: "sourcesHint" },
  number("maxResults", 1, 200), fraction("minScore"),
  boolean("sessionMemory", ["experimental", "sessionMemory"]), boolean("cache", ["cache", "enabled"]),
  { key: "tokenizer", path: ["store", "fts", "tokenizer"], options: ["unicode61", "trigram"] }];
searchFields.find(field => field.key === "maxResults")!.path = ["query", "maxResults"];
searchFields.find(field => field.key === "minScore")!.path = ["query", "minScore"];
const dreamPath = ["plugins", "entries", "memory-core", "config", "dreaming"];
const activePath = ["plugins", "entries", "active-memory", "config"];
const localProviderPath = ["models", "providers", "llama-cpp"];
const phaseFields: Record<string, Setting[]> = {
  light: [boolean("enabled"), count("lookbackDays"), count("limit"), fraction("dedupeSimilarity")],
  deep: [boolean("enabled"), count("limit"), fraction("minScore"), count("minRecallCount"), count("minUniqueQueries"),
    count("recencyHalfLifeDays"), number("maxAgeDays", 1, 1_000_000), number("maxPromotedSnippetTokens", 1, 1_000_000), fraction("maxPriorEntryLossFraction")],
  rem: [boolean("enabled"), count("lookbackDays"), count("limit"), fraction("minPatternStrength")],
};

export default function SettingsMemory() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [accountContext, setAccountContext] = useState<MemoryAccountContext | null>(null);
  const [accountStatus, setAccountStatus] = useState({ dirty: false, busy: false });
  const [snapshot, setSnapshot] = useState<NativeMemoryConfigProjection | null>(null);
  const [context, setContext] = useState<NativeMemoryContext | null>(null);
  const [draft, setDraft] = useState<NativeMemorySettings>({});
  const [scope, setScope] = useState("");
  const [aliasScope, setAliasScope] = useState("");
  const [newAliasTarget, setNewAliasTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const generation = useRef(0), inFlight = useRef(false);
  const dirty = !!snapshot && (!sameMemorySettings(draft, snapshot.config) || newAliasTarget.length > 0);
  const validSearch = validMemorySearchDraft(draft);
  useEffect(() => () => { generation.current++; }, []);
  useNavigationGuard({ dirty, busy, onDiscard: () => { if (snapshot) setDraft(structuredClone(snapshot.config)); setNewAliasTarget(""); } });

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const current = ++generation.current;
    try {
      await pendingWrite.catch(() => {});
      if (generation.current !== current) return;
      const nextContext = await getNativeMemoryContext();
      if (generation.current !== current) return;
      setContext(nextContext);
      if (nextContext.owner !== "shoggoth-memory-core") {
        setSnapshot(null); setDraft({}); setNewAliasTarget(""); setNeedsReload(false); return;
      }
      const next = await getNativeMemoryConfig();
      if (generation.current !== current) return;
      setSnapshot(next); setDraft(structuredClone(next.config)); setNewAliasTarget(""); setNeedsReload(false);
    } catch {
      if (generation.current === current) { setError("loadFailed"); setNeedsReload(true); }
    } finally {
      if (generation.current === current) { inFlight.current = false; setBusy(false); }
    }
  }, []);
  useEffect(() => { if (open && !snapshot && !context && !inFlight.current) void load(); }, [open, snapshot, context, load]);

  const change = (path: string[], value: unknown) => {
    if (inFlight.current || needsReload) return;
    setSaved(false); setDraft(previous => changeMemorySetting(previous, path, value));
  };
  // A user editing service resources creates an explicit empty inventory; no
  // chat model, command, endpoint or service is silently selected for them.
  const changeLocalResource = (path: string[], value: unknown) => {
    if (inFlight.current || needsReload) return;
    setSaved(false); setDraft(previous => {
      const next = changeMemorySetting(previous, path, value);
      return memorySetting(next, localProviderPath) && memorySetting(next, [...localProviderPath, "models"]) === undefined
        ? changeMemorySetting(next, [...localProviderPath, "models"], []) : next;
    });
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || needsReload || !snapshot || !dirty || !validSearch || newAliasTarget.length > 0 || !event.currentTarget.reportValidity()) return;
    inFlight.current = true; setBusy(true); setError(""); setSaved(false);
    const current = generation.current;
    const writing = updateNativeMemoryConfig({ expectedRevision: snapshot.revision, config: draft });
    pendingWrite = writing.catch(() => {});
    try {
      const next = await writing;
      if (generation.current !== current) return;
      setSnapshot(next); setDraft(structuredClone(next.config)); setSaved(true);
    } catch (failure) {
      if (generation.current !== current) return;
      const code = (failure as { code?: string })?.code;
      setError(code === "NATIVE_MEMORY_CONFIG_STALE" || code === "NATIVE_MEMORY_CONFIG_CONFLICT" ? "conflict"
        : code === "NATIVE_MEMORY_CONFIG_INVALID" ? "invalid" : "saveFailed");
      // The server may already have committed or compensated a timed-out write.
      // Preserve the draft and require an explicit read before another write.
      setNeedsReload(code !== "NATIVE_MEMORY_CONFIG_INVALID");
    } finally {
      if (generation.current === current) { inFlight.current = false; setBusy(false); }
    }
  };
  const disabled = busy || needsReload || accountStatus.busy;
  const field = (base: string[], spec: Setting, setter = change) => {
    const path = [...base, ...(spec.path || [spec.key])];
    const value = memorySetting(draft, path);
    const label = spec.label || t(`nativeMemory.fields.${spec.key}`);
    const id = `memory-setting-${path.join("-")}`;
    let input;
    if (spec.kind === "boolean" || spec.options) {
      const selected = value === undefined ? "" : spec.kind === "boolean" ? String(value)
        : Array.isArray(value) ? value.join(",") || "empty" : String(value);
      input = <Select title={label} disabled={disabled} value={selected} onChange={next => setter(path,
        next === "" ? undefined : spec.kind === "boolean" || spec.key === "fastMode" && next !== "auto" ? next === "true"
          : ["sources", "modalities"].includes(spec.key) ? next === "empty" ? [] : next.split(",") : next)}>
        <Option value="">{t(spec.key === "mode" && base === activePath ? "nativeMemory.activeModeDefault"
          : scope && base === searchPath ? "nativeMemory.inherit" : "nativeMemory.default")}</Option>
        {(spec.kind === "boolean" ? ["true", "false"] : spec.key === "modalities" && selected && selected !== "empty" && !spec.options!.includes(selected)
          ? [...spec.options!, selected] : spec.options!).map(option =>
          <Option key={option} value={option}>{["provider", "fallback"].includes(spec.key) && !memoryEmbeddingProviders.includes(option)
            ? option : spec.key === "modalities" ? option.split(",").map(value => t(`nativeMemory.options.${value}`)).join(" + ") : t(`nativeMemory.options.${option}`)}</Option>)}
      </Select>;
    } else if (spec.kind === "headers") {
      input = <TextArea id={id} disabled={disabled} rows={4} maxLength={32768}
        value={formatMemoryRemoteHeaders(value)} placeholder={t(scope ? "nativeMemory.inherit" : "nativeMemory.default")}
        onChange={event => setter(path, parseMemoryRemoteHeaders(event.target.value))} />;
    } else if (spec.kind === "arguments") {
      input = <TextArea id={id} disabled={disabled} rows={4} maxLength={32768}
        value={Array.isArray(value) ? value.join("\n") : ""}
        onChange={event => setter(path, event.target.value === "" ? undefined : event.target.value.split(/\r?\n/u))} />;
    } else if (spec.kind === "textarea") {
      input = <TextArea id={id} disabled={disabled} rows={3} maxLength={spec.maxLength || 8192}
        value={String(value ?? "")} placeholder={t("nativeMemory.default")}
        onChange={event => setter(path, event.target.value || undefined)} />;
    } else {
      input = <TextInput id={id} disabled={disabled} type={spec.kind === "number" ? "number" : "text"}
        min={spec.min} max={spec.max} step={spec.step} maxLength={spec.maxLength || 256} required={spec.required} pattern={spec.pattern}
        value={String(value ?? "")} placeholder={spec.placeholder || t(scope && base === searchPath ? "nativeMemory.inherit" : "nativeMemory.default")}
        onChange={event => setter(path, event.target.value === "" ? undefined
          : spec.kind === "number" || spec.key === "forceFlushTranscriptBytes" && /^\d+$/u.test(event.target.value)
            ? Number(event.target.value) : event.target.value)} />;
    }
    return <Field key={id} label={label} hint={spec.hint ? t(`nativeMemory.${spec.hint}`) : undefined}>{input}</Field>;
  };
  const searchPath = scope ? ["agents", "entries", scope, "memory", "search"] : ["memory", "search"];
  const resolvedSearch = effectiveMemorySearch(draft, scope);
  const selectedProvider = resolvedSearch.provider;
  const providerOptions = [...new Set([...memoryEmbeddingProviders, ...Object.keys(resolvedSearch.providerRefs),
    ...(selectedProvider ? [selectedProvider] : [])])];
  const fallbackOptions = [...new Set([...memoryEmbeddingProviders.filter(value => value !== "shoggoth-e5"),
    ...Object.keys(resolvedSearch.providerRefs), ...(resolvedSearch.fallback ? [resolvedSearch.fallback] : [])])];
  const refIds = [...new Set([...Object.keys(resolvedSearch.providerRefs),
    ...[selectedProvider, resolvedSearch.fallback].filter((id): id is string => !!id && !["none", "shoggoth-e5", "local"].includes(id))])].sort();
  const showRemote = !!selectedProvider && !["none", "shoggoth-e5", "local"].includes(selectedProvider)
    || memorySetting(draft, [...searchPath, "remote"]) !== undefined || refIds.length > 0;
  const showLocal = selectedProvider === "local" || memorySetting(draft, [...searchPath, "local"]) !== undefined;
  const showLocalService = selectedProvider === "local" || memorySetting(draft, localProviderPath) !== undefined;
  const extraPaths = (memorySetting(draft, [...searchPath, "extraPaths"]) || []) as NonNullable<NonNullable<NativeMemorySettings["memory"]>["search"]>["extraPaths"];
  const agents = context?.agents || [];
  const configuredProfiles = Object.keys(draft.agents?.entries || {});
  const profileIds = [...new Set([...agents.map(agent => agent.profileId), ...configuredProfiles])];
  const aliasesPath = aliasScope ? ["agents", "entries", aliasScope, "models"] : ["agents", "defaults", "models"];
  const aliases = (memorySetting(draft, aliasesPath) || {}) as Record<string, { alias?: string }>;
  const aliasTarget = newAliasTarget.trim();
  const duplicateTarget = Object.hasOwn(aliases, aliasTarget);
  const canAddAlias = !!aliasTarget && !duplicateTarget && Object.keys(aliases).length < 256
    && !/[\u0000-\u001f\u007f]/u.test(aliasTarget) && !["__proto__", "prototype", "constructor"].includes(aliasTarget);
  const active = draft.plugins?.entries?.["active-memory"];
  const selectedAgents = active?.config?.agents;
  const activeAgentIds = [...new Set([...agents.map(agent => agent.profileId), ...(selectedAgents || []), ...(active?.config?.excludedAgents || [])])];
  const activeEnabled = active?.enabled === undefined && active?.config?.enabled === undefined ? ""
    : active?.enabled === false || active?.config?.enabled === false ? "false" : "true";
  const setActive = (value: string) => {
    if (inFlight.current || needsReload) return;
    setSaved(false); setDraft(previous => changeMemorySetting(changeMemorySetting(previous,
      ["plugins", "entries", "active-memory", "enabled"], value === "" ? undefined : value === "true"),
    [...activePath, "enabled"], value === "" ? undefined : value === "true"));
  };

  return <details className="settings-advanced settings-memory" id="settings-memory" onToggle={event => {
    if (!event.currentTarget.open && (accountStatus.dirty || accountStatus.busy)) { event.currentTarget.open = true; return; }
    setOpen(event.currentTarget.open);
  }}>
    <summary className="settings-advanced-summary"><div><h3 className="settings-h">{t("nativeMemory.title")}</h3>
      <p className="settings-sech">{t("nativeMemory.description")}</p></div>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
    </summary>
    {open && <div className="settings-memory-body">
      {busy && !snapshot && <p role="status">{t("common.loading")}</p>}
      {error && <p className="field-error" role="alert">{t(`nativeMemory.${error}`)}</p>}
      {context?.owner === "legacy" && <p role="status">{t("nativeMemory.inactive")}</p>}
      {!snapshot && !busy && <button type="button" className="ui-cbtn ui-cbtn--sm" onClick={() => void load()}>{t("common.refresh")}</button>}
      {snapshot && context?.owner === "shoggoth-memory-core" && <form onSubmit={event => void save(event)} aria-label={t("nativeMemory.title")}>
        <fieldset disabled={disabled} className="settings-memory-section">
          <legend>{t("nativeMemory.search")}</legend><p className="ui-hint">{t("nativeMemory.searchHint")}</p>
          <Field label={t("nativeMemory.scope")}><Select title={t("nativeMemory.scope")} disabled={busy || accountStatus.dirty || accountStatus.busy} value={scope} onChange={setScope}>
            <Option value="">{t("nativeMemory.allAgents")}</Option>
            {profileIds.map(id => <Option key={id} value={id}>{agents.find(agent => agent.profileId === id)?.name || t("nativeMemory.unavailableAgent", { id })}</Option>)}
          </Select></Field>
          <div className="settings-memory-grid">{searchFields.map(spec => field(searchPath, spec.key === "provider" ? { ...spec, options: providerOptions } : spec.key === "fallback" ? { ...spec, options: fallbackOptions } : spec))}</div>
          {showRemote && <details className="settings-memory-extra"><summary>{t("nativeMemory.remoteSearch")}</summary>
            <p className="ui-hint">{t("nativeMemory.remoteSearchHint")}</p>
            <div className="settings-memory-grid">{[
              { ...text("providerId", ["provider"], "customProviderHint"), maxLength: 128, pattern: memoryProviderIdPattern },
              { ...text("fallbackId", ["fallback"], "customProviderHint"), maxLength: 128, pattern: memoryProviderIdPattern },
              { ...text("remoteBaseUrl", ["remote", "baseUrl"], "remoteBaseUrlHint"), maxLength: 4096 },
              text("inputType", undefined, "inputTypeHint"), text("queryInputType", undefined, "inputTypeHint"), text("documentInputType", undefined, "inputTypeHint"),
              boolean("batchEnabled", ["remote", "batch", "enabled"]),
              { key: "remoteHeaders", path: ["remote", "headers"], kind: "headers" as const, hint: "remoteHeadersHint" },
            ].map(spec => field(searchPath, spec))}</div>
            <MemoryProviderAccounts profileId={scope} disabled={busy || needsReload} onContext={setAccountContext} onStatus={setAccountStatus} />
            <p className="ui-hint">{t("nativeMemory.providerRefsHint")}</p>
            <div className="settings-memory-grid">{refIds.map(provider => field(searchPath, {
              key: "providerRef", path: ["providerRefs", provider], maxLength: 128, pattern: memoryProviderIdPattern,
              label: `${t("nativeMemory.fields.providerRef")} · ${provider}`,
              placeholder: scope && draft.memory?.search?.providerRefs?.[provider]
                ? t("nativeMemory.inheritOwner", { id: draft.memory.search.providerRefs[provider] }) : undefined,
            }))}</div>
            {accountContext?.profileId === scope && <div className="settings-memory-grid">{refIds.map(provider => {
              const choices = accountContext.context.owners.filter(owner => owner.status === "active" && owner.providerId === provider);
              const current = String(memorySetting(draft, [...searchPath, "providerRefs", provider]) || "");
              return <Field key={provider} label={`${t("memoryAccounts.selectAccount")} · ${provider}`}>
                <Select title={`${t("memoryAccounts.selectAccount")} · ${provider}`} disabled={disabled} value={current}
                  onChange={value => change([...searchPath, "providerRefs", provider], value || undefined)}>
                  <Option value="">{t(scope ? "nativeMemory.inherit" : "nativeMemory.default")}</Option>
                  {!!current && !choices.some(owner => owner.ownerRef === current) && <Option value={current}>{t("memoryAccounts.unavailableSelection", { id: current })}</Option>}
                  {choices.map(owner => <Option key={owner.ownerRef} value={owner.ownerRef}>{owner.label} · {t(owner.scope.kind === "global" ? "memoryAccounts.global" : "memoryAccounts.profile")}</Option>)}
                </Select></Field>;
            })}</div>}
            <details className="settings-memory-extra"><summary>{t("nativeMemory.multimodal")}</summary>
              <p className="ui-hint">{t("nativeMemory.multimodalHint")}</p>
              <div className="settings-memory-grid">{[
                boolean("multimodalEnabled", ["multimodal", "enabled"]),
                { key: "modalities", path: ["multimodal", "modalities"], options: ["all", "image", "audio", "image,audio", "empty"] },
                { ...number("maxFileBytes", 1, Number.MAX_SAFE_INTEGER), path: ["multimodal", "maxFileBytes"] },
              ].map(spec => field(searchPath, spec))}</div>
            </details>
          </details>}
          {!validSearch && <p className="field-error" role="alert">{t("nativeMemory.remoteInvalid")}</p>}
          {showLocal && <div className="settings-memory-grid">
            {field(searchPath, { ...text("modelPath", ["local", "modelPath"], "localModelHint"), maxLength: 4096 })}
          </div>}
          {showLocalService && <details className="settings-memory-extra"><summary>{t("nativeMemory.localService")}</summary>
            <p className="ui-hint">{t("nativeMemory.localServiceHint")}</p>
            <div className="settings-memory-grid">{[
              { ...text("localBaseUrl", ["baseUrl"], "localEndpointHint"), maxLength: 4096, required: true },
              { ...text("localCommand", ["localService", "command"], "localCommandHint"), maxLength: 4096, required: true },
              { ...text("localModelCacheDir", ["params", "modelCacheDir"]), maxLength: 4096 },
              { ...text("localHealthUrl", ["localService", "healthUrl"], "localEndpointHint"), maxLength: 4096 },
              { ...text("localCwd", ["localService", "cwd"]), maxLength: 4096 },
              { ...number("localReadyTimeoutMs", 1, Number.MAX_SAFE_INTEGER), path: ["localService", "readyTimeoutMs"] },
              { ...number("localIdleStopMs", 0, Number.MAX_SAFE_INTEGER), path: ["localService", "idleStopMs"], hint: "localIdleHint" },
              { key: "localArgs", path: ["localService", "args"], kind: "arguments" as const, hint: "localArgsHint" },
            ].map(spec => field(localProviderPath, spec, changeLocalResource))}</div>
          </details>}
          <details className="settings-memory-extra"><summary>{t("nativeMemory.extraPaths")}</summary>
            <p className="ui-hint">{t("nativeMemory.extraPathsHint")}</p>
            {(extraPaths || []).map((entry, index) => <div className="settings-memory-path" key={`${scope}:${index}`}>
              <Field label={t("nativeMemory.path")}><TextInput required disabled={disabled} maxLength={4096}
                value={typeof entry === "string" ? entry : entry.path} onChange={event => change([...searchPath, "extraPaths"], extraPaths!.map((item, i) =>
                  i === index ? typeof item === "string" ? event.target.value : { ...item, path: event.target.value } : item))} /></Field>
              <Field label={t("nativeMemory.pattern")}><TextInput disabled={disabled} maxLength={512} placeholder="**/*.md"
                value={typeof entry === "string" ? "" : entry.pattern || ""} onChange={event => change([...searchPath, "extraPaths"], extraPaths!.map((item, i) =>
                  i === index ? { path: typeof item === "string" ? item : item.path, ...(event.target.value ? { pattern: event.target.value } : {}) } : item))} /></Field>
              <button type="button" className="ui-cbtn ui-cbtn--sm" onClick={() => change([...searchPath, "extraPaths"], extraPaths!.filter((_, i) => i !== index))}>{t("common.remove")}</button>
            </div>)}
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={disabled || (extraPaths?.length || 0) >= 64}
              onClick={() => change([...searchPath, "extraPaths"], [...(extraPaths || []), ""])}>{t("nativeMemory.addPath")}</button>
          </details>
        </fieldset>
        <fieldset disabled={disabled} className="settings-memory-section">
          <legend>{t("nativeMemory.aliases")}</legend><p className="ui-hint">{t("nativeMemory.aliasesHint")}</p>
          <Field label={t("nativeMemory.aliasScope")}><Select title={t("nativeMemory.aliasScope")} disabled={disabled} value={aliasScope} onChange={setAliasScope}>
            <Option value="">{t("nativeMemory.allAgents")}</Option>
            {profileIds.map(id => <Option key={id} value={id}>{agents.find(agent => agent.profileId === id)?.name || t("nativeMemory.unavailableAgent", { id })}</Option>)}
          </Select></Field>
          <p className="ui-hint">{t(aliasScope ? "nativeMemory.aliasOverrideHint" : "nativeMemory.aliasOrderHint")}</p>
          {Object.entries(aliases).map(([model, entry]) => <div className="settings-memory-alias" key={`${aliasScope}:${model}`}>
            <div className="settings-memory-alias-model"><span>{t("nativeMemory.aliasTarget")}</span><code>{model}</code></div>
            <Field label={t("nativeMemory.aliasName")} hint={entry.alias === undefined && aliasScope ? t("nativeMemory.inherit") : undefined}>
              <TextInput id={`memory-setting-alias-value-${encodeURIComponent(model)}`} disabled={disabled} maxLength={256}
                aria-label={`${t("nativeMemory.aliasName")} · ${model}`} placeholder={t("nativeMemory.aliasEmpty")}
                value={entry.alias ?? ""} onChange={event => change([...aliasesPath, model, "alias"], event.target.value)} />
            </Field>
            <button type="button" className="ui-cbtn ui-cbtn--sm" aria-label={t("nativeMemory.removeAlias", { model })}
              onClick={() => change([...aliasesPath, model], undefined)}>{t("common.remove")}</button>
          </div>)}
          <div className="settings-memory-alias-add">
            <Field label={t("nativeMemory.aliasTarget")} hint={duplicateTarget ? t("nativeMemory.aliasExists") : t("nativeMemory.aliasTargetHint")}>
              <TextInput id="memory-setting-alias-target" disabled={disabled} maxLength={512} value={newAliasTarget}
                aria-invalid={duplicateTarget || undefined} onChange={event => {
                  if (!inFlight.current && !needsReload) { setNewAliasTarget(event.target.value); setSaved(false); }
                }} />
            </Field>
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={disabled || !canAddAlias} onClick={() => {
              if (inFlight.current || needsReload || !canAddAlias) return;
              change([...aliasesPath, aliasTarget], { alias: "" }); setNewAliasTarget("");
            }}>{t("nativeMemory.addAlias")}</button>
          </div>
          {newAliasTarget && <p className="ui-hint">{t("nativeMemory.aliasPending")}</p>}
        </fieldset>
        <fieldset disabled={disabled} className="settings-memory-section">
          <legend>{t("nativeMemory.flush")}</legend><p className="ui-hint">{t("nativeMemory.flushHint")}</p>
          <div className="settings-memory-grid">{[boolean("enabled"), text("model", undefined, "modelHint"), count("softThresholdTokens"),
            text("forceFlushTranscriptBytes", undefined, "bytesHint")].map(spec => field(["agents", "defaults", "compaction", "memoryFlush"], spec))}
            {field(["agents", "defaults"], { ...text("userTimezone"), maxLength: 100, hint: "timezoneHint" })}</div>
        </fieldset>
        <fieldset disabled={disabled} className="settings-memory-section">
          <legend>{t("nativeMemory.dreaming")}</legend><p className="ui-hint">{t("nativeMemory.dreamingHint")}</p>
          <div className="settings-memory-grid">{[boolean("enabled"), { ...text("frequency"), maxLength: 100, hint: "frequencyHint" },
            { ...text("timezone"), maxLength: 100, hint: "timezoneHint" }, text("model", undefined, "modelHint")].map(spec => field(dreamPath, spec))}</div>
          <details className="settings-memory-extra"><summary>{t("nativeMemory.advanced")}</summary>
            <div className="settings-memory-grid">{[boolean("verboseLogging"),
              { key: "storage", path: ["storage", "mode"], options: ["inline", "separate", "both"] },
              boolean("separateReports", ["storage", "separateReports"]), text("executionModel", ["execution", "defaults", "model"], "modelHint")].map(spec => field(dreamPath, spec))}</div>
            {Object.entries(phaseFields).map(([phase, specs]) => <details className="settings-memory-extra" key={phase}>
              <summary>{t(`nativeMemory.${phase}`)}</summary><div className="settings-memory-grid">{[...specs, text("model", ["execution", "model"], "modelHint")]
                .map(spec => field([...dreamPath, "phases", phase], spec))}</div>
            </details>)}
          </details>
        </fieldset>
        <fieldset disabled={disabled} className="settings-memory-section">
          <legend>{t("nativeMemory.active")}</legend><p className="ui-hint">{t("nativeMemory.activeHint")}</p>
          <div className="settings-memory-grid"><Field label={t("nativeMemory.fields.enabled")}><Select title={t("nativeMemory.active")} disabled={disabled} value={activeEnabled} onChange={setActive}>
            <Option value="">{t("nativeMemory.activeDefaultEnabled")}</Option><Option value="true">{t("nativeMemory.options.true")}</Option><Option value="false">{t("nativeMemory.options.false")}</Option>
          </Select></Field>{[{ key: "mode", options: ["always", "escalate", "off"] }, text("model", undefined, "activeModelHint")].map(spec => field(activePath, spec))}</div>
          <div className="settings-memory-agents" role="group" aria-label={t("nativeMemory.activeAgents")}>
            <strong>{t("nativeMemory.activeAgents")}</strong><p className="ui-hint">{t("nativeMemory.activeAgentsHint")}</p>
            <p className="ui-hint">{t(selectedAgents === undefined ? "nativeMemory.activeAgentsAllHint" : "nativeMemory.activeAgentsLegacyHint")}</p>
            <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={disabled || selectedAgents === undefined && !active?.config?.excludedAgents?.length}
              onClick={() => {
                if (inFlight.current || needsReload) return;
                setSaved(false); setDraft(previous => enableAllActiveMemoryAgents(previous));
              }}>{t("nativeMemory.enableAllActiveAgents")}</button>
            {activeAgentIds.map(id => <Switch key={id} disabled={disabled}
              checked={activeMemoryAgentSelected(draft, id)} label={agents.find(agent => agent.profileId === id)?.name || t("nativeMemory.unavailableAgent", { id })}
              onChange={checked => {
                if (inFlight.current || needsReload) return;
                setSaved(false); setDraft(previous => changeActiveMemoryAgent(previous, id, checked));
              }} />)}
            {!activeAgentIds.length && <p className="ui-hint">{t("nativeMemory.noAgents")}</p>}
          </div>
          <details className="settings-memory-extra"><summary>{t("nativeMemory.advanced")}</summary>
            <div className="settings-memory-grid">{[
              text("modelFallback", undefined, "modelFallbackHint"),
              { key: "thinking", options: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"], hint: "thinkingHint" },
              { key: "fastMode", options: ["true", "false", "auto"], hint: "fastModeHint" },
              { key: "promptStyle", options: ["balanced", "strict", "contextual", "recall-heavy", "precision-heavy", "preference-only"] },
              number("timeoutMs", 1000, 600000), number("setupGraceTimeoutMs", 0, 120000), number("maxSummaryChars", 40, 1000),
              number("cacheTtlMs", 1000, 120000), number("circuitBreakerMaxTimeouts", 1, 20), number("circuitBreakerCooldownMs", 5000, 600000),
              { ...boolean("persistTranscripts"), hint: "persistTranscriptsHint" },
              { ...text("transcriptDir", undefined, "transcriptDirHint"), maxLength: 1024 },
              { key: "promptOverride", kind: "textarea" as const }, { key: "promptAppend", kind: "textarea" as const },
            ].map(spec => field(activePath, spec))}</div>
            {([{ key: "toolsAllow", values: ["memory_search", "memory_get"] }, { key: "allowedChatTypes", values: ["direct"] }] as const).map(spec => {
              const value = memorySetting(draft, [...activePath, spec.key]) as string[] | undefined;
              return <div className="settings-memory-agents" key={spec.key}><strong>{t(`nativeMemory.fields.${spec.key}`)}</strong>
                <Select title={t(`nativeMemory.fields.${spec.key}`)} disabled={disabled} value={value === undefined ? "default" : "custom"}
                  onChange={choice => change([...activePath, spec.key], choice === "default" ? undefined : [...spec.values])}>
                  <Option value="default">{t("nativeMemory.default")}</Option><Option value="custom">{t("nativeMemory.custom")}</Option>
                </Select>
                {value !== undefined && spec.values.map(option => <Switch key={option} label={t(`nativeMemory.options.${option}`)} disabled={disabled}
                  checked={value.includes(option)} onChange={checked => change([...activePath, spec.key], checked ? [...value, option] : value.filter(item => item !== option))} />)}
              </div>;
            })}
          </details>
        </fieldset>
        <div className="settings-memory-actions"><p role="status">{saved ? t("nativeMemory.saved") : dirty ? t("nativeMemory.unsaved") : t("nativeMemory.loaded")}</p>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => void load()}>{t(dirty ? "nativeMemory.discardReload" : "common.refresh")}</button>
          <button type="submit" className="ui-cbtn ui-cbtn--sm ui-cbtn--primary" disabled={disabled || !dirty || !validSearch || newAliasTarget.length > 0}>{t(busy ? "common.saving" : "common.save")}</button>
        </div>
      </form>}
      {context?.owner === "shoggoth-memory-core" && <NativeMemorySharingSettings />}
    </div>}
  </details>;
}
